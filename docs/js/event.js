// イベント画面（event.html）: 回答状況のマス目・回答の入力・幹事の操作。
//   参加者: event.html?id=<イベントID>
//   幹事:   event.html?id=<イベントID>#admin=<幹事トークン>

import * as api from "./api.js";
import { createSlotGrid } from "./slot-grid.js";
import {
  datesOf, timeRangeOf, timesBetween, slotsToRanges, rangeToSlots, formatRange, formatSlot,
  parseSlotKey, toMinutes, fromMinutes, SLOT_MINUTES,
} from "./slots.js";
import {
  el, showMessage, copyToClipboard, getAdminTokenFromHash,
  shareUrl, editUrl, formatDate, removeFromHistory,
} from "./util.js";

const ANSWER_CHOICES = [
  { value: "yes", symbol: "○", label: "参加できる" },
  { value: "maybe", symbol: "△", label: "調整すれば参加できる" },
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
let slotSet = new Set();      // 候補のマス
let isAdmin = false;

let summaryGrid = null;       // 回答状況のマス目
let summaryCellState = null;  // 回答状況のマス目の見た目（表示のたびに最新の状態で作り直す）
let answerGrid = null;        // 回答フォームのマス目

let editingResponse = null;   // 修正中の回答（新規なら null）
let draftAnswers = {};        // 入力中の回答 { マス: "yes" | "maybe" | "no" }
let brush = "yes";            // 塗る記号

let viewMode = "grid";        // 回答状況の表示: "grid"（マス目） | "table"（一覧表）
const focusedIds = new Set(); // 重視する人（回答の id）。この画面だけの表示用で、保存はしない

let isDeciding = false;       // 幹事が確定する範囲を選んでいる途中か
let decideSelection = null;   // 選んだ範囲 { date, start_time, end_time }

// 同じページで # 以降（幹事トークン）だけが変わった場合もページを読み込み直す
window.addEventListener("hashchange", () => location.reload());

main();

async function main() {
  if (!eventId) {
    showError("URL が正しくありません。");
    return;
  }
  if (!api.isConfigured()) {
    showError("サーバーの接続設定がまだです。README の手順で docs/js/config.js を設定してください。");
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
  slotSet = new Set(event.slots);

  // 削除された人の「重視する」チェックは外す
  const ids = new Set(event.responses.map((r) => r.id));
  [...focusedIds].filter((id) => !ids.has(id)).forEach((id) => focusedIds.delete(id));

  render();
}

function showError(text) {
  document.getElementById("loading").hidden = true;
  showMessage(messageArea, text);
}

// マス目に並べる日付と時刻
function gridLayout() {
  const { startMinutes, endMinutes } = timeRangeOf(currentEvent.slots);
  return { dates: datesOf(currentEvent.slots), times: timesBetween(startMinutes, endMinutes) };
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
  renderParticipants();
  renderSummaryGrid();
  renderAnswerTable();
  renderView();
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
  banner.hidden = !currentEvent.decided;
  if (currentEvent.decided) {
    banner.replaceChildren(
      el("span", { class: "decided-label" }, "日程が決まりました"),
      el("strong", {}, formatRange(currentEvent.decided)),
    );
  }
}

function renderAdminMenu() {
  document.getElementById("admin-menu").hidden = !isAdmin;
  if (!isAdmin) return;

  document.getElementById("share-url").value = shareUrl(eventId);
  document.getElementById("edit-link").href = editUrl(eventId, adminToken);
  document.getElementById("decide-cancel").hidden = !currentEvent.decided;
}

// 回答した人の一覧（名前を押すと回答を修正できる）
function renderParticipants() {
  const area = document.getElementById("participants");
  const responses = currentEvent.responses;

  if (responses.length === 0) {
    area.replaceChildren(el("p", { class: "empty" }, "まだ回答がありません"));
    return;
  }

  area.replaceChildren(
    el("span", { class: "hint" }, `回答 ${responses.length}人:`),
    ...responses.map((response) =>
      el(
        "span",
        { class: "participant" },
        el("input", {
          type: "checkbox",
          title: "重視する人にする",
          "aria-label": `${response.name} さんを重視する`,
          checked: focusedIds.has(response.id),
          onchange: (event) => toggleFocus(response.id, event.target.checked),
        }),
        el(
          "button",
          {
            type: "button",
            class: "participant-name",
            title: currentEvent.is_closed ? "締切後は修正できません" : "回答を修正する",
            disabled: currentEvent.is_closed,
            onclick: () => openResponseForm(response),
          },
          response.name,
        ),
      ),
    ),
    el("p", { class: "hint participants-hint" },
      "チェックを付けた人（重視する人）全員が ○ の時間に ★ が付きます。名前を押すと回答を修正できます。"),
  );
}

function toggleFocus(responseId, checked) {
  if (checked) {
    focusedIds.add(responseId);
  } else {
    focusedIds.delete(responseId);
  }
  summaryGrid.update();
  renderAnswerTable();
}

// 重視する人が選ばれていて、その全員が ○ のマスか
function isFocusOk(key) {
  if (focusedIds.size === 0) return false;
  return currentEvent.responses
    .filter((response) => focusedIds.has(response.id))
    .every((response) => response.answers[key] === "yes");
}

// 回答状況の表示（マス目／一覧表）を切り替える
function renderView() {
  document.getElementById("view-grid").hidden = viewMode !== "grid";
  document.getElementById("view-table").hidden = viewMode !== "table";
  document.getElementById("show-grid").setAttribute("aria-pressed", viewMode === "grid");
  document.getElementById("show-table").setAttribute("aria-pressed", viewMode === "table");
}

function switchView(mode) {
  if (mode === "table") exitDecideMode();
  viewMode = mode;
  renderView();
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

// ---------------------------------------------------------------------
// 回答状況のマス目
// ---------------------------------------------------------------------

// マスごとの ○△× の人
function peopleAt(key) {
  const people = { yes: [], maybe: [], no: [], none: [] };
  for (const response of currentEvent.responses) {
    people[response.answers[key] || "none"].push(response.name);
  }
  return people;
}

// ○ が最も多いマス（同数なら △ が多いもの）
function findBestSlots() {
  let best = [];
  let bestScore = [1, 0];   // ○ が 1 人もいなければ強調しない

  for (const key of currentEvent.slots) {
    const people = peopleAt(key);
    const score = [people.yes.length, people.maybe.length];
    const comparison = score[0] - bestScore[0] || score[1] - bestScore[1];

    if (comparison > 0) {
      best = [key];
      bestScore = score;
    } else if (comparison === 0) {
      best.push(key);
    }
  }
  return new Set(best);
}

function renderSummaryGrid() {
  const bestSlots = findBestSlots();
  const decidedSlots = new Set(currentEvent.decided ? rangeToSlots(currentEvent.decided) : []);
  const total = currentEvent.responses.length;

  const cellState = (key) => {
    if (!slotSet.has(key)) return { className: "is-off" };

    const people = peopleAt(key);
    const classes = ["is-slot", "heat"];
    if (bestSlots.has(key)) classes.push("is-best");
    if (decidedSlots.has(key)) classes.push("is-decided");
    if (isDeciding && decideSelection && rangeToSlots(decideSelection).includes(key)) classes.push("is-picking");
    const focusOk = isFocusOk(key);
    if (focusOk) classes.push("is-focus-ok");

    return {
      className: classes.join(" "),
      text: (focusOk ? "★" : "") + (people.yes.length > 0 ? people.yes.length : ""),
      title: `${formatSlot(key)}  ○${people.yes.length} △${people.maybe.length} ×${people.no.length}`,
      // ○ を 1、△ を 0.5 として、回答者に対する割合で色の濃さを決める
      level: total > 0 ? (people.yes.length + people.maybe.length * 0.5) / total : 0,
    };
  };

  summaryCellState = cellState;
  const { dates, times } = gridLayout();

  if (summaryGrid) {
    summaryGrid.setLayout(dates, times);
    return;
  }

  summaryGrid = createSlotGrid(document.getElementById("summary-grid"), {
    dates,
    times,
    paintable: false,
    singleColumn: true,
    cellState: (key) => summaryCellState(key),
    canStart: (key) => isDeciding && slotSet.has(key),
    onSelect: selectDecideRange,
    onFocus: showSlotDetail,
  });
}

// ---------------------------------------------------------------------
// 回答状況の一覧表（行: 候補の時間、列: 参加者）
// ---------------------------------------------------------------------

function renderAnswerTable() {
  const responses = currentEvent.responses;
  const bestSlots = findBestSlots();
  const decidedSlots = new Set(currentEvent.decided ? rangeToSlots(currentEvent.decided) : []);

  const headerRow = el(
    "tr",
    {},
    el("th", { class: "col-date" }, "日時"),
    ANSWER_CHOICES.map((choice) => el("th", { class: `col-count answer-${choice.value}` }, choice.symbol)),
    responses.map((response) =>
      el(
        "th",
        { class: "col-person" },
        el(
          "button",
          {
            type: "button",
            class: "btn-link",
            title: currentEvent.is_closed ? "締切後は修正できません" : "回答を修正する",
            disabled: currentEvent.is_closed,
            onclick: () => openResponseForm(response),
          },
          (focusedIds.has(response.id) ? "★" : "") + response.name,
        ),
      ),
    ),
  );

  let previousDate = null;
  const bodyRows = currentEvent.slots.map((key) => {
    const { date, time } = parseSlotKey(key);
    const isNewDate = date !== previousDate;
    previousDate = date;

    const people = peopleAt(key);
    const focusOk = isFocusOk(key);
    const classes = [
      isNewDate ? "is-new-date" : "",
      bestSlots.has(key) ? "is-best" : "",
      decidedSlots.has(key) ? "is-decided" : "",
      focusOk ? "is-focus-ok" : "",
    ];

    return el(
      "tr",
      { class: classes.filter(Boolean).join(" ") },
      el(
        "th",
        { class: "col-date", scope: "row" },
        el("span", { class: "table-date" }, isNewDate ? formatDate(date) : ""),
        el("span", { class: "table-time" }, `${time}〜${fromMinutes(toMinutes(time) + SLOT_MINUTES)}`),
        focusOk ? el("span", { class: "focus-mark", title: "重視する人全員が ○" }, "★") : null,
      ),
      ANSWER_CHOICES.map((choice) => el("td", { class: `col-count answer-${choice.value}` }, people[choice.value].length)),
      responses.map((response) => {
        const value = response.answers[key];
        return el("td", { class: `answer answer-${value || "none"}` }, value ? SYMBOLS[value] : "−");
      }),
    );
  });

  document.getElementById("answer-table").replaceChildren(el("thead", {}, headerRow), el("tbody", {}, bodyRows));
}

// マスの詳細（その時間に ○△× の人）
function showSlotDetail(key) {
  const area = document.getElementById("slot-detail");
  if (!slotSet.has(key)) {
    area.replaceChildren(el("p", { class: "hint" }, `${formatSlot(key)} は候補ではありません`));
    return;
  }

  const people = peopleAt(key);
  const rows = [
    ...ANSWER_CHOICES.map((choice) => ({ label: choice.symbol, className: `answer-${choice.value}`, names: people[choice.value] })),
    { label: "未回答", className: "answer-none", names: people.none },
  ];

  area.replaceChildren(
    el("p", { class: "slot-detail-title" }, formatSlot(key)),
    el(
      "dl",
      {},
      rows.map((row) => [
        el("dt", { class: row.className }, `${row.label} ${row.names.length}人`),
        el("dd", {}, row.names.length > 0 ? row.names.join("、") : "−"),
      ]),
    ),
  );
}

// ---------------------------------------------------------------------
// 回答フォーム
// ---------------------------------------------------------------------

function openResponseForm(response) {
  exitDecideMode();
  editingResponse = response;
  draftAnswers = response ? { ...response.answers } : {};

  document.getElementById("response-title").textContent = response ? `${response.name} さんの回答を修正` : "回答する";
  document.getElementById("delete-response").hidden = !(response && isAdmin);
  nameInput.value = response ? response.name : "";
  commentInput.value = response ? response.comment : "";
  responseError.textContent = "";

  renderBrushes();
  renderAnswerGrid();
  responseSection.hidden = false;
  responseSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeResponseForm() {
  responseSection.hidden = true;
  editingResponse = null;
}

function renderBrushes() {
  document.getElementById("brushes").replaceChildren(
    ...ANSWER_CHOICES.map((choice) =>
      el(
        "button",
        {
          type: "button",
          class: `choice choice-${choice.value}`,
          role: "radio",
          title: choice.label,
          "aria-label": choice.label,
          "aria-checked": brush === choice.value ? "true" : "false",
          onclick: () => {
            brush = choice.value;
            renderBrushes();
          },
        },
        choice.symbol,
      ),
    ),
  );
}

let answersBeforeDrag = null;   // なぞり始める前の回答
let paintValue = null;          // なぞって塗る値（null なら消す）

function renderAnswerGrid() {
  const cellState = (key) => {
    if (!slotSet.has(key)) return { className: "is-off" };
    const value = draftAnswers[key];
    return {
      className: `is-slot answer-cell answer-${value || "none"}`,
      text: value ? SYMBOLS[value] : "",
      title: formatSlot(key),
    };
  };

  if (answerGrid) {
    answerGrid.update();
    return;
  }

  const { dates, times } = gridLayout();
  answerGrid = createSlotGrid(document.getElementById("answer-grid"), {
    dates,
    times,
    paintable: true,
    cellState,
    canStart: (key) => slotSet.has(key),
    onSelect: (keys, startKey, phase) => {
      if (phase === "start") {
        answersBeforeDrag = { ...draftAnswers };
        paintValue = draftAnswers[startKey] === brush ? null : brush;
      }

      draftAnswers = { ...answersBeforeDrag };
      for (const key of keys) {
        if (!slotSet.has(key)) continue;
        if (paintValue) {
          draftAnswers[key] = paintValue;
        } else {
          delete draftAnswers[key];
        }
      }
      answerGrid.update();
    },
  });
}

function fillRestWithNo() {
  for (const key of currentEvent.slots) {
    if (!draftAnswers[key]) draftAnswers[key] = "no";
  }
  answerGrid.update();
}

function clearAnswers() {
  if (!confirm("塗った回答をすべて消しますか？")) return;
  draftAnswers = {};
  answerGrid.update();
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

  const answeredCount = Object.keys(draftAnswers).length;
  if (answeredCount === 0) {
    responseError.textContent = "マス目を塗って、都合のよい時間を入力してください";
    return;
  }
  const unanswered = currentEvent.slots.length - answeredCount;
  if (unanswered > 0 && !confirm(`未入力のマスが${unanswered}個あります（未回答として扱われます）。このまま保存しますか？`)) {
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
    document.getElementById("summary-grid").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    responseError.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
}

// ---------------------------------------------------------------------
// 幹事の操作
// ---------------------------------------------------------------------

function enterDecideMode() {
  closeResponseForm();
  viewMode = "grid";
  renderView();
  isDeciding = true;
  decideSelection = null;
  summaryGrid.setPaintable(true);
  updateDecideBar();
  document.getElementById("decide-bar").scrollIntoView({ behavior: "smooth", block: "center" });
}

function exitDecideMode() {
  if (!isDeciding) return;
  isDeciding = false;
  decideSelection = null;
  summaryGrid.setPaintable(false);
  summaryGrid.update();
  updateDecideBar();
}

// 集計のマス目でなぞった範囲（同じ日の列だけ）
function selectDecideRange(keys, startKey, phase) {
  const ranges = slotsToRanges(keys);
  const allCandidates = keys.every((key) => slotSet.has(key));
  decideSelection = allCandidates && ranges.length === 1 ? ranges[0] : null;

  summaryGrid.update();
  if (phase === "end") {
    updateDecideBar(allCandidates ? "" : "候補になっていない時間が含まれています。候補のマスの中で選んでください。");
  }
}

function updateDecideBar(errorText = "") {
  const bar = document.getElementById("decide-bar");
  const confirmButton = document.getElementById("decide-confirm");
  bar.hidden = !isDeciding;
  if (!isDeciding) return;

  const text = document.getElementById("decide-text");
  if (errorText) {
    text.textContent = errorText;
  } else if (decideSelection) {
    text.textContent = `選んだ日時: ${formatRange(decideSelection)}`;
  } else {
    text.textContent = "下のマス目で、確定する時間を同じ日の中でなぞって選んでください。";
  }
  confirmButton.hidden = !decideSelection || Boolean(errorText);
}

async function confirmDecision() {
  if (!decideSelection) return;
  if (!confirm(`「${formatRange(decideSelection)}」で日程を確定しますか？`)) return;

  await runAction(() => api.decideEvent(eventId, adminToken, decideSelection));
  exitDecideMode();
}

async function cancelDecision() {
  if (!confirm("日程の確定を取り消しますか？")) return;
  await runAction(() => api.decideEvent(eventId, adminToken, null));
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
  document.getElementById("show-grid").addEventListener("click", () => switchView("grid"));
  document.getElementById("show-table").addEventListener("click", () => switchView("table"));
  document.getElementById("cancel-response").addEventListener("click", closeResponseForm);
  document.getElementById("delete-response").addEventListener("click", handleDeleteResponse);
  document.getElementById("fill-rest").addEventListener("click", fillRestWithNo);
  document.getElementById("clear-answers").addEventListener("click", clearAnswers);
  responseForm.addEventListener("submit", handleSaveResponse);

  if (isAdmin) {
    const copyButton = document.getElementById("copy-share");
    copyButton.addEventListener("click", () => copyToClipboard(shareUrl(eventId), copyButton));
    document.getElementById("decide-start").addEventListener("click", enterDecideMode);
    document.getElementById("decide-exit").addEventListener("click", exitDecideMode);
    document.getElementById("decide-confirm").addEventListener("click", confirmDecision);
    document.getElementById("decide-cancel").addEventListener("click", cancelDecision);
    document.getElementById("delete-event").addEventListener("click", handleDeleteEvent);
  }
}
