// イベント画面（event.html）: 回答状況の表示と回答の入力。
//   参加者: event.html?id=<イベントID>
//   幹事:   event.html?id=<イベントID>#admin=<幹事トークン>

import * as api from "./api.js";
import {
  el, showMessage, copyToClipboard, getAdminTokenFromHash,
  shareUrl, editUrl, formatDate, formatTimeRange, formatCandidate, parseDate, removeFromHistory,
} from "./util.js";

const ANSWER_CHOICES = [
  { value: "yes", symbol: "○", label: "参加できる" },
  { value: "maybe", symbol: "△", label: "未定" },
  { value: "no", symbol: "×", label: "参加できない" },
];
const SYMBOLS = Object.fromEntries(ANSWER_CHOICES.map((c) => [c.value, c.symbol]));

const eventId = new URLSearchParams(location.search).get("id");
const adminToken = getAdminTokenFromHash();

const messageArea = document.getElementById("message");
const responseSection = document.getElementById("response-section");
const responseForm = document.getElementById("response-form");
const nameInput = document.getElementById("response-name");
const commentInput = document.getElementById("response-comment");
const responseError = document.getElementById("response-error");

let currentEvent = null;
let isAdmin = false;
let editingResponse = null;   // 修正中の回答（新規なら null）
let draftAnswers = {};        // 入力中の回答 { 候補id: "yes" | "maybe" | "no" }

// 同じページで # 以降（幹事トークン）だけが変わった場合もページを読み込み直す
window.addEventListener("hashchange", () => location.reload());

main();

async function main() {
  if (!eventId) {
    showError("URL が正しくありません。");
    return;
  }
  if (!api.isConfigured()) {
    showError("Supabase の接続設定がまだです。README の手順で docs/js/config.js を設定してください。");
    return;
  }

  try {
    if (adminToken) {
      isAdmin = await api.checkAdmin(eventId, adminToken);
      if (!isAdmin) {
        showMessage(messageArea, "幹事用 URL が正しくないため、参加者として表示しています。");
      }
    }
    await reload();
  } catch (error) {
    showError(error.message);
    return;
  }

  setUpHandlers();
}

async function reload() {
  const event = await api.getEvent(eventId);
  if (!event) {
    throw new Error("イベントが見つかりません。削除された可能性があります。");
  }
  currentEvent = event;
  render();
}

function showError(text) {
  document.getElementById("loading").hidden = true;
  showMessage(messageArea, text);
}

// ---------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------

function render() {
  document.getElementById("loading").hidden = true;
  document.getElementById("event-view").hidden = false;
  document.title = `${currentEvent.title} - tokatonton`;

  renderHeader();
  renderAdminMenu();
  renderSummaryTable();
  renderComments();

  document.getElementById("new-response").hidden = currentEvent.is_closed;
}

function renderHeader() {
  document.getElementById("event-title").textContent = currentEvent.title;
  document.getElementById("event-description").textContent = currentEvent.description;

  const deadlineArea = document.getElementById("event-deadline");
  if (!currentEvent.deadline) {
    deadlineArea.textContent = "";
  } else if (currentEvent.is_closed) {
    deadlineArea.textContent = `回答は締め切りました（締切: ${formatDate(currentEvent.deadline)}）`;
    deadlineArea.className = "deadline is-closed";
  } else {
    deadlineArea.textContent = `回答締切: ${formatDate(currentEvent.deadline)} まで`;
    deadlineArea.className = "deadline";
  }

  const banner = document.getElementById("decided-banner");
  const decided = findCandidate(currentEvent.decided_candidate_id);
  banner.hidden = !decided;
  if (decided) {
    banner.replaceChildren(
      el("span", { class: "decided-label" }, "日程が決まりました"),
      el("strong", {}, formatCandidate(decided)),
    );
  }
}

function renderAdminMenu() {
  document.getElementById("admin-menu").hidden = !isAdmin;
  if (!isAdmin) return;

  document.getElementById("share-url").value = shareUrl(eventId);
  document.getElementById("edit-link").href = editUrl(eventId, adminToken);
}

// 候補ごとの ○△× の数
function countAnswers(candidateId) {
  const counts = { yes: 0, maybe: 0, no: 0 };
  for (const response of currentEvent.responses) {
    const value = response.answers[candidateId];
    if (value) counts[value] += 1;
  }
  return counts;
}

// ○ が最も多い候補（同数なら △ が多いもの）の id。回答がなければ空。
function findBestCandidateIds() {
  let bestScore = null;
  let bestIds = [];

  for (const candidate of currentEvent.candidates) {
    const counts = countAnswers(candidate.id);
    const score = [counts.yes, counts.maybe];
    if (counts.yes === 0 && counts.maybe === 0) continue;

    const comparison = bestScore === null ? 1 : score[0] - bestScore[0] || score[1] - bestScore[1];
    if (comparison > 0) {
      bestScore = score;
      bestIds = [candidate.id];
    } else if (comparison === 0) {
      bestIds.push(candidate.id);
    }
  }
  return new Set(bestIds);
}

function renderSummaryTable() {
  const table = document.getElementById("summary-table");
  const responses = currentEvent.responses;
  const bestIds = findBestCandidateIds();

  const headerRow = el(
    "tr",
    {},
    el("th", { class: "col-date" }, "日時"),
    el("th", { class: "col-count" }, "○"),
    el("th", { class: "col-count" }, "△"),
    el("th", { class: "col-count" }, "×"),
    responses.map((response) =>
      el(
        "th",
        { class: "col-person" },
        el(
          "button",
          {
            type: "button",
            class: "btn-link person-name",
            title: currentEvent.is_closed ? "締切後は修正できません" : "回答を修正する",
            disabled: currentEvent.is_closed,
            onclick: () => openResponseForm(response),
          },
          response.name,
        ),
      ),
    ),
    isAdmin ? el("th", { class: "col-admin" }, "") : null,
  );

  const bodyRows = currentEvent.candidates.map((candidate) => {
    const counts = countAnswers(candidate.id);
    const isDecided = candidate.id === currentEvent.decided_candidate_id;
    const rowClasses = [isDecided ? "is-decided" : "", bestIds.has(candidate.id) ? "is-best" : ""];

    return el(
      "tr",
      { class: rowClasses.join(" ").trim() },
      el(
        "th",
        { class: "col-date", scope: "row" },
        el("span", { class: `candidate-date weekday-${parseDate(candidate.date).getDay()}` }, formatDate(candidate.date)),
        " ",
        el("span", { class: "candidate-time" }, formatTimeRange(candidate.start_time, candidate.end_time)),
        isDecided ? el("span", { class: "badge" }, "確定") : null,
      ),
      el("td", { class: "col-count count-yes" }, counts.yes),
      el("td", { class: "col-count count-maybe" }, counts.maybe),
      el("td", { class: "col-count count-no" }, counts.no),
      responses.map((response) => {
        const value = response.answers[candidate.id];
        return el("td", { class: `answer answer-${value || "none"}` }, value ? SYMBOLS[value] : "−");
      }),
      isAdmin ? el("td", { class: "col-admin" }, renderDecideButton(candidate, isDecided)) : null,
    );
  });

  table.replaceChildren(el("thead", {}, headerRow), el("tbody", {}, bodyRows));
}

function renderDecideButton(candidate, isDecided) {
  if (isDecided) {
    return el("button", { type: "button", class: "btn btn-small", onclick: () => decide(null) }, "取り消し");
  }
  return el("button", { type: "button", class: "btn btn-small", onclick: () => decide(candidate) }, "確定");
}

function renderComments() {
  const withComments = currentEvent.responses.filter((response) => response.comment);
  document.getElementById("comment-section").hidden = withComments.length === 0;
  document.getElementById("comment-list").replaceChildren(
    ...withComments.map((response) =>
      el("li", {}, el("span", { class: "comment-name" }, response.name), el("p", { class: "comment-text" }, response.comment)),
    ),
  );
}

function findCandidate(candidateId) {
  return currentEvent.candidates.find((c) => c.id === candidateId) || null;
}

// ---------------------------------------------------------------------
// 回答フォーム
// ---------------------------------------------------------------------

function openResponseForm(response) {
  editingResponse = response;
  draftAnswers = response ? { ...response.answers } : {};

  document.getElementById("response-title").textContent = response ? `${response.name} さんの回答を修正` : "回答する";
  document.getElementById("delete-response").hidden = !(response && isAdmin);
  nameInput.value = response ? response.name : "";
  commentInput.value = response ? response.comment : "";
  responseError.textContent = "";

  renderAnswerList();
  responseSection.hidden = false;
  responseSection.scrollIntoView({ behavior: "smooth", block: "start" });
  nameInput.focus({ preventScroll: true });
}

function closeResponseForm() {
  responseSection.hidden = true;
  editingResponse = null;
}

function renderAnswerList() {
  const rows = currentEvent.candidates.map((candidate) =>
    el(
      "div",
      { class: "answer-row" },
      el("span", { class: "answer-candidate" }, formatCandidate(candidate)),
      el(
        "div",
        { class: "answer-choices", role: "group", "aria-label": formatCandidate(candidate) },
        ANSWER_CHOICES.map((choice) =>
          el(
            "button",
            {
              type: "button",
              class: `choice choice-${choice.value}`,
              title: choice.label,
              "aria-label": choice.label,
              "aria-pressed": draftAnswers[candidate.id] === choice.value ? "true" : "false",
              onclick: () => {
                draftAnswers[candidate.id] = choice.value;
                renderAnswerList();
              },
            },
            choice.symbol,
          ),
        ),
      ),
    ),
  );

  const setAll = (value) => {
    for (const candidate of currentEvent.candidates) draftAnswers[candidate.id] = value;
    renderAnswerList();
  };

  document.getElementById("answer-list").replaceChildren(
    el(
      "div",
      { class: "answer-bulk" },
      el("span", { class: "hint" }, "まとめて入力:"),
      ANSWER_CHOICES.map((choice) =>
        el("button", { type: "button", class: "btn btn-small", onclick: () => setAll(choice.value) }, `すべて${choice.symbol}`),
      ),
    ),
    ...rows,
  );
}

async function handleSaveResponse(submitEvent) {
  submitEvent.preventDefault();
  responseError.textContent = "";

  const name = nameInput.value.trim();
  if (!name) {
    responseError.textContent = "お名前を入力してください";
    nameInput.focus();
    return;
  }

  const unanswered = currentEvent.candidates.filter((c) => !draftAnswers[c.id]).length;
  if (unanswered > 0 && !confirm(`未回答の候補が${unanswered}件あります。このまま保存しますか？`)) {
    return;
  }

  const saveButton = document.getElementById("save-response");
  saveButton.disabled = true;
  try {
    await api.saveResponse({
      eventId,
      responseId: editingResponse?.id,
      name,
      comment: commentInput.value.trim(),
      answers: draftAnswers,
    });
    closeResponseForm();
    await reload();
    document.getElementById("summary-table").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    responseError.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
}

// ---------------------------------------------------------------------
// 幹事の操作
// ---------------------------------------------------------------------

async function decide(candidate) {
  const question = candidate
    ? `「${formatCandidate(candidate)}」で日程を確定しますか？`
    : "日程の確定を取り消しますか？";
  if (!confirm(question)) return;

  await runAction(() => api.decideEvent(eventId, adminToken, candidate ? candidate.id : null));
}

async function handleDeleteResponse() {
  if (!editingResponse) return;
  if (!confirm(`${editingResponse.name} さんの回答を削除しますか？元に戻せません。`)) return;

  await runAction(() => api.deleteResponse(eventId, adminToken, editingResponse.id));
  closeResponseForm();
}

async function handleDeleteEvent() {
  if (!confirm(`イベント「${currentEvent.title}」を削除しますか？すべての回答も消え、元に戻せません。`)) return;

  try {
    await api.deleteEvent(eventId, adminToken);
    removeFromHistory(eventId);
    alert("イベントを削除しました。");
    location.href = "index.html";
  } catch (error) {
    alert(error.message);
  }
}

// 操作を実行して画面を更新する。失敗したらメッセージを出す。
async function runAction(action) {
  try {
    await action();
    await reload();
  } catch (error) {
    alert(error.message);
  }
}

// ---------------------------------------------------------------------
// イベントハンドラー
// ---------------------------------------------------------------------

function setUpHandlers() {
  document.getElementById("new-response").addEventListener("click", () => openResponseForm(null));
  document.getElementById("cancel-response").addEventListener("click", closeResponseForm);
  document.getElementById("delete-response").addEventListener("click", handleDeleteResponse);
  responseForm.addEventListener("submit", handleSaveResponse);

  if (isAdmin) {
    const copyButton = document.getElementById("copy-share");
    copyButton.addEventListener("click", () => copyToClipboard(shareUrl(eventId), copyButton));
    document.getElementById("delete-event").addEventListener("click", handleDeleteEvent);
  }
}
