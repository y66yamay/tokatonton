// 候補日時の入力部品（カレンダーで日付を選び、時間帯を指定して追加する）。
//
//   const editor = createCandidateEditor(container, initialCandidates);
//   editor.getCandidates()  // → [{ id?, date, start_time, end_time }, ...]

import { el, toIsoDate, parseDate, todayIso, formatDate, formatTimeRange, compareCandidates } from "./util.js";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export function createCandidateEditor(container, initialCandidates = []) {
  // 候補の一覧。既存の候補は id を持つ（編集時に回答を引き継ぐため）。
  let candidates = initialCandidates.map((c) => ({
    id: c.id,
    date: c.date,
    start_time: c.start_time || "",
    end_time: c.end_time || "",
  }));

  const selectedDates = new Set();
  const today = todayIso();

  // 最初に表示する月: 既存候補があればその最初の月、なければ今月
  const firstDate = candidates.length > 0 ? parseDate([...candidates].sort(compareCandidates)[0].date) : new Date();
  let shownYear = firstDate.getFullYear();
  let shownMonth = firstDate.getMonth();

  // --- 部品の骨組み ---
  const calendarArea = el("div", { class: "calendar" });
  const startInput = el("input", { type: "time", step: "300", "aria-label": "開始時刻" });
  const endInput = el("input", { type: "time", step: "300", "aria-label": "終了時刻" });
  const errorArea = el("div", { class: "field-error", role: "alert" });
  const listArea = el("div", { class: "candidate-list" });

  const addButton = el("button", { type: "button", class: "btn", onclick: addSelectedDates }, "選択した日付に追加");

  container.replaceChildren(
    el(
      "div",
      { class: "candidate-editor" },
      el("div", { class: "candidate-editor-input" },
        el("p", { class: "hint" }, "① カレンダーで日付を選ぶ（複数可）"),
        calendarArea,
        el("p", { class: "hint" }, "② 時間帯を入れて追加する（空欄なら終日）"),
        el("div", { class: "time-range" }, startInput, el("span", {}, "〜"), endInput, addButton),
        errorArea,
      ),
      el("div", { class: "candidate-editor-list" },
        el("p", { class: "hint" }, "候補日時"),
        listArea,
      ),
    ),
  );

  renderCalendar();
  renderList();

  // --- カレンダー ---
  function renderCalendar() {
    const datesWithCandidates = new Set(candidates.map((c) => c.date));
    const firstDay = new Date(shownYear, shownMonth, 1);
    const daysInMonth = new Date(shownYear, shownMonth + 1, 0).getDate();

    const header = el(
      "div",
      { class: "calendar-header" },
      el("button", { type: "button", class: "btn-icon", "aria-label": "前の月", onclick: () => moveMonth(-1) }, "‹"),
      el("span", { class: "calendar-title" }, `${shownYear}年${shownMonth + 1}月`),
      el("button", { type: "button", class: "btn-icon", "aria-label": "次の月", onclick: () => moveMonth(1) }, "›"),
    );

    const grid = el("div", { class: "calendar-grid" });
    WEEKDAY_LABELS.forEach((label, index) => {
      grid.append(el("div", { class: `calendar-weekday weekday-${index}` }, label));
    });

    // 1日の曜日の位置まで空白を入れる
    for (let i = 0; i < firstDay.getDay(); i++) {
      grid.append(el("div"));
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(shownYear, shownMonth, day);
      const iso = toIsoDate(date);
      const classes = ["calendar-day", `weekday-${date.getDay()}`];
      if (selectedDates.has(iso)) classes.push("is-selected");
      if (datesWithCandidates.has(iso)) classes.push("has-candidate");
      if (iso === today) classes.push("is-today");

      grid.append(
        el(
          "button",
          {
            type: "button",
            class: classes.join(" "),
            disabled: iso < today,
            "aria-pressed": selectedDates.has(iso) ? "true" : "false",
            onclick: () => toggleDate(iso),
          },
          day,
        ),
      );
    }

    calendarArea.replaceChildren(header, grid);
  }

  function moveMonth(offset) {
    const moved = new Date(shownYear, shownMonth + offset, 1);
    shownYear = moved.getFullYear();
    shownMonth = moved.getMonth();
    renderCalendar();
  }

  function toggleDate(iso) {
    if (selectedDates.has(iso)) {
      selectedDates.delete(iso);
    } else {
      selectedDates.add(iso);
    }
    renderCalendar();
  }

  // --- 候補の追加・削除 ---
  function addSelectedDates() {
    errorArea.textContent = "";
    const startTime = startInput.value;
    const endTime = endInput.value;

    if (selectedDates.size === 0) {
      errorArea.textContent = "カレンダーで日付を選んでください";
      return;
    }
    if (endTime && !startTime) {
      errorArea.textContent = "終了時刻だけを指定することはできません";
      return;
    }
    if (startTime && endTime && endTime <= startTime) {
      errorArea.textContent = "終了時刻は開始時刻より後にしてください";
      return;
    }

    for (const date of selectedDates) {
      const isDuplicate = candidates.some(
        (c) => c.date === date && c.start_time === startTime && c.end_time === endTime,
      );
      if (!isDuplicate) {
        candidates.push({ date, start_time: startTime, end_time: endTime });
      }
    }

    selectedDates.clear();
    renderCalendar();
    renderList();
  }

  function removeCandidate(candidate) {
    candidates = candidates.filter((c) => c !== candidate);
    renderCalendar();
    renderList();
  }

  // --- 候補の一覧 ---
  function renderList() {
    candidates.sort(compareCandidates);

    if (candidates.length === 0) {
      listArea.replaceChildren(el("p", { class: "empty" }, "まだ候補がありません"));
      return;
    }

    listArea.replaceChildren(
      el(
        "ul",
        {},
        candidates.map((candidate) =>
          el(
            "li",
            {},
            el("span", { class: "candidate-date" }, formatDate(candidate.date)),
            el("span", { class: "candidate-time" }, formatTimeRange(candidate.start_time, candidate.end_time)),
            el(
              "button",
              {
                type: "button",
                class: "btn-icon btn-remove",
                "aria-label": "この候補を削除",
                onclick: () => removeCandidate(candidate),
              },
              "×",
            ),
          ),
        ),
      ),
      el("p", { class: "hint" }, `${candidates.length}件`),
    );
  }

  return {
    getCandidates() {
      return candidates.map((c) => ({
        ...(c.id ? { id: c.id } : {}),
        date: c.date,
        start_time: c.start_time || null,
        end_time: c.end_time || null,
      }));
    },
  };
}
