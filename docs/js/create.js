// トップ画面（index.html）: イベントの作成と編集。
//   作成:  index.html
//   編集:  index.html?edit=<イベントID>#admin=<幹事トークン>

import * as api from "./api.js";
import { createCandidateEditor } from "./candidate-editor.js";
import {
  el, showMessage, copyToClipboard, getAdminTokenFromHash,
  shareUrl, adminUrl, loadHistory, saveToHistory, removeFromHistory,
} from "./util.js";

const form = document.getElementById("event-form");
const titleInput = document.getElementById("title");
const descriptionInput = document.getElementById("description");
const deadlineInput = document.getElementById("deadline");
const formError = document.getElementById("form-error");
const submitButton = document.getElementById("submit-button");
const messageArea = document.getElementById("message");

const editEventId = new URLSearchParams(location.search).get("edit");
const adminToken = getAdminTokenFromHash();

let candidateEditor;
let originalCandidateIds = [];  // 編集前にあった候補の id（編集モードのみ）

// 同じページで # 以降（幹事トークン）だけが変わった場合もページを読み込み直す
window.addEventListener("hashchange", () => location.reload());

main();

async function main() {
  if (!api.isConfigured()) {
    showMessage(messageArea, "Supabase の接続設定がまだです。README の手順で docs/js/config.js を設定してください。");
  }

  if (editEventId) {
    await setUpEditMode();
  } else {
    candidateEditor = createCandidateEditor(document.getElementById("candidate-editor"));
    renderHistory();
  }

  form.addEventListener("submit", handleSubmit);
}

// --- 編集モード ---
async function setUpEditMode() {
  document.getElementById("form-title").textContent = "イベントを編集";
  submitButton.textContent = "変更を保存";
  document.title = "イベントを編集 - tokatonton";

  const cancelLink = document.getElementById("cancel-link");
  cancelLink.href = adminUrl(editEventId, adminToken || "");
  cancelLink.hidden = false;

  try {
    const [event, isAdmin] = await Promise.all([
      api.getEvent(editEventId),
      api.checkAdmin(editEventId, adminToken || ""),
    ]);

    if (!event) {
      throw new Error("イベントが見つかりません。削除された可能性があります。");
    }
    if (!isAdmin) {
      throw new Error("幹事用 URL が正しくないため編集できません。");
    }

    titleInput.value = event.title;
    descriptionInput.value = event.description;
    deadlineInput.value = event.deadline || "";
    originalCandidateIds = event.candidates.map((c) => c.id);
    candidateEditor = createCandidateEditor(document.getElementById("candidate-editor"), event.candidates);
  } catch (error) {
    showMessage(messageArea, error.message);
    document.getElementById("form-section").hidden = true;
  }
}

// --- 送信 ---
async function handleSubmit(submitEvent) {
  submitEvent.preventDefault();
  formError.textContent = "";

  const values = {
    title: titleInput.value.trim(),
    description: descriptionInput.value.trim(),
    deadline: deadlineInput.value,
    candidates: candidateEditor.getCandidates(),
  };

  if (!values.title) {
    formError.textContent = "タイトルを入力してください";
    titleInput.focus();
    return;
  }
  if (values.candidates.length === 0) {
    formError.textContent = "候補日時を1つ以上追加してください";
    return;
  }

  submitButton.disabled = true;
  try {
    if (editEventId) {
      await saveChanges(values);
    } else {
      await createNewEvent(values);
    }
  } catch (error) {
    formError.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
}

async function createNewEvent(values) {
  const created = await api.createEvent(values);
  saveToHistory({ id: created.id, title: values.title, adminToken: created.admin_token });
  showResult(created.id, created.admin_token);
}

async function saveChanges(values) {
  const removedCount = countRemovedCandidates(values.candidates);
  if (removedCount > 0) {
    const ok = confirm(`削除した候補日時が${removedCount}件あります。その候補への回答も消えます。保存しますか？`);
    if (!ok) return;
  }

  await api.updateEvent({ eventId: editEventId, adminToken, ...values });
  saveToHistory({ id: editEventId, title: values.title, adminToken });
  location.href = adminUrl(editEventId, adminToken);
}

// 編集前にあった候補のうち、一覧から消えたものの数
function countRemovedCandidates(candidates) {
  const keptIds = new Set(candidates.map((c) => c.id).filter(Boolean));
  return originalCandidateIds.filter((id) => !keptIds.has(id)).length;
}

// --- 作成完了の表示 ---
function showResult(eventId, token) {
  const share = shareUrl(eventId);
  const admin = adminUrl(eventId, token);

  document.getElementById("form-section").hidden = true;
  document.getElementById("history-section").hidden = true;
  document.getElementById("result-section").hidden = false;

  const shareInput = document.getElementById("share-url");
  const adminInput = document.getElementById("admin-url");
  shareInput.value = share;
  adminInput.value = admin;

  const copyShare = document.getElementById("copy-share");
  const copyAdmin = document.getElementById("copy-admin");
  copyShare.addEventListener("click", () => copyToClipboard(share, copyShare));
  copyAdmin.addEventListener("click", () => copyToClipboard(admin, copyAdmin));

  document.getElementById("open-event").href = admin;
  window.scrollTo(0, 0);
}

// --- 作成したイベントの履歴 ---
function renderHistory() {
  const history = loadHistory();
  const section = document.getElementById("history-section");
  const list = document.getElementById("history-list");

  section.hidden = history.length === 0;
  list.replaceChildren(
    ...history.map((item) =>
      el(
        "li",
        {},
        el("a", { href: adminUrl(item.id, item.adminToken) }, item.title),
        el(
          "button",
          {
            type: "button",
            class: "btn-link",
            onclick: () => {
              if (confirm(`「${item.title}」を一覧から外しますか？（イベント自体は削除されません）`)) {
                removeFromHistory(item.id);
                renderHistory();
              }
            },
          },
          "一覧から外す",
        ),
      ),
    ),
  );
}
