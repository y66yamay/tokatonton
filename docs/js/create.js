// トップ画面（index.html）: イベントの作成と編集。
//   作成:  index.html
//   編集:  index.html?edit=<イベントID>#admin=<幹事トークン>

import * as api from "./api.js";
import { createSlotEditor } from "./slot-editor.js";
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

let slotEditor;
let originalSlots = [];  // 編集前の候補のマス（編集モードのみ）

// 同じページで # 以降（幹事トークン）だけが変わった場合もページを読み込み直す
window.addEventListener("hashchange", () => location.reload());

main();

async function main() {
  if (!api.isConfigured()) {
    showMessage(messageArea, "サーバーの接続設定がまだです。README の手順で docs/js/config.js を設定してください。");
  }

  if (editEventId) {
    await setUpEditMode();
  } else {
    slotEditor = createSlotEditor(document.getElementById("slot-editor"));
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
    originalSlots = event.slots;
    slotEditor = createSlotEditor(document.getElementById("slot-editor"), event.slots);
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
    slots: slotEditor.getSlots(),
  };

  if (!values.title) {
    formError.textContent = "タイトルを入力してください";
    titleInput.focus();
    return;
  }
  if (values.slots.length === 0) {
    formError.textContent = "候補の時間をマス目で1マス以上塗ってください";
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
  const keptSlots = new Set(values.slots);
  const removedCount = originalSlots.filter((slot) => !keptSlots.has(slot)).length;
  if (removedCount > 0) {
    const ok = confirm(`候補から外したマスが${removedCount}個あります。そのマスへの回答は表示されなくなります。保存しますか？`);
    if (!ok) return;
  }

  await api.updateEvent({ eventId: editEventId, adminToken, ...values });
  saveToHistory({ id: editEventId, title: values.title, adminToken });
  location.href = adminUrl(editEventId, adminToken);
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
