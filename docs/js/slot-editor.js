// 幹事が候補のマスを選ぶ部品（カレンダーで日付を選び、マス目をなぞって候補を塗る）。
//
//   const editor = createSlotEditor(container, initialSlots);
//   editor.getSlots()  // → ["2026-11-05T10:00", ...]

import { el, toIsoDate, parseDate, todayIso } from "./util.js";
import { createSlotGrid } from "./slot-grid.js";
import { parseSlotKey, toMinutes, timesBetween, datesOf, timeRangeOf, slotsToRanges, formatRange, slotKey } from "./slots.js";

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DEFAULT_RANGE = { startMinutes: 9 * 60, endMinutes: 18 * 60 };

export function createSlotEditor(container, initialSlots = []) {
  const slots = new Set(initialSlots);
  const selectedDates = new Set(datesOf(slots));
  const today = todayIso();

  // マス目に表示する時間帯。既存の候補があれば、それが収まる範囲に広げる
  let timeRange = { ...DEFAULT_RANGE };
  if (slots.size > 0) {
    const used = timeRangeOf(slots);
    timeRange = {
      startMinutes: Math.min(timeRange.startMinutes, used.startMinutes),
      endMinutes: Math.max(timeRange.endMinutes, used.endMinutes),
    };
  }

  // カレンダーに最初に表示する月: 既存の候補があればその最初の月、なければ今月
  const firstDate = selectedDates.size > 0 ? parseDate([...selectedDates].sort()[0]) : new Date();
  let shownYear = firstDate.getFullYear();
  let shownMonth = firstDate.getMonth();

  // --- 部品の骨組み ---
  const calendarArea = el("div", { class: "calendar" });
  const startSelect = el("select", { "aria-label": "表示する開始時刻", onchange: changeTimeRange });
  const endSelect = el("select", { "aria-label": "表示する終了時刻", onchange: changeTimeRange });
  const gridArea = el("div", { class: "slot-editor-grid" });
  const summaryArea = el("div", { class: "slot-summary" });

  for (let hour = 0; hour <= 24; hour++) {
    const label = `${hour}:00`;
    if (hour < 24) startSelect.append(el("option", { value: hour * 60 }, label));
    if (hour > 0) endSelect.append(el("option", { value: hour * 60 }, label));
  }
  startSelect.value = timeRange.startMinutes;
  endSelect.value = timeRange.endMinutes;

  container.replaceChildren(
    el(
      "div",
      { class: "slot-editor" },
      el("div", { class: "slot-editor-step" },
        el("p", { class: "hint" }, "① カレンダーで日付を選ぶ（複数可）"),
        calendarArea,
      ),
      el("div", { class: "slot-editor-step" },
        el("p", { class: "hint" }, "② 表示する時間帯"),
        el("div", { class: "time-range" }, startSelect, el("span", {}, "〜"), endSelect),
        el("p", { class: "hint" }, "③ 候補にする時間のマスをなぞって塗る（塗ったマスをなぞると消えます）"),
        el("div", { class: "actions actions-left" },
          el("button", { type: "button", class: "btn btn-small", onclick: fillAll }, "表示中のマスをすべて候補にする"),
          el("button", { type: "button", class: "btn btn-small", onclick: clearAll }, "すべて解除"),
        ),
        gridArea,
        summaryArea,
      ),
    ),
  );

  // --- マス目 ---
  let grid = null;
  let slotsBeforeDrag = null;   // なぞり始める前の状態
  let paintOn = true;           // true なら塗る、false なら消す

  function visibleTimes() {
    return timesBetween(timeRange.startMinutes, timeRange.endMinutes);
  }

  function sortedDates() {
    return [...selectedDates].sort();
  }

  function renderGrid() {
    if (selectedDates.size === 0) {
      grid = null;
      gridArea.replaceChildren(el("p", { class: "empty" }, "カレンダーで日付を選ぶと、ここにマス目が表示されます"));
      return;
    }

    if (grid) {
      grid.setLayout(sortedDates(), visibleTimes());
      return;
    }

    grid = createSlotGrid(gridArea, {
      dates: sortedDates(),
      times: visibleTimes(),
      paintable: true,
      cellState: (key) => ({ className: slots.has(key) ? "is-candidate" : "is-blank" }),
      canStart: () => true,
      onSelect: paint,
    });
  }

  function paint(keys, startKey, phase) {
    if (phase === "start") {
      slotsBeforeDrag = new Set(slots);
      paintOn = !slots.has(startKey);
    }

    // なぞり始める前の状態に、今の長方形の範囲を塗る（消す）
    slots.clear();
    slotsBeforeDrag.forEach((key) => slots.add(key));
    keys.forEach((key) => (paintOn ? slots.add(key) : slots.delete(key)));

    grid.update();
    if (phase === "end") renderSummary();
  }

  function fillAll() {
    for (const date of selectedDates) {
      for (const time of visibleTimes()) slots.add(slotKey(date, time));
    }
    refresh();
  }

  function clearAll() {
    if (slots.size > 0 && !confirm("塗った候補をすべて解除しますか？")) return;
    slots.clear();
    refresh();
  }

  // 表示する時間帯を変える。範囲の外に塗ったマスがあれば確認して消す
  function changeTimeRange() {
    const startMinutes = Number(startSelect.value);
    const endMinutes = Number(endSelect.value);
    if (endMinutes <= startMinutes) {
      alert("終了時刻は開始時刻より後にしてください");
      startSelect.value = timeRange.startMinutes;
      endSelect.value = timeRange.endMinutes;
      return;
    }

    const outside = [...slots].filter((key) => {
      const minutes = toMinutes(parseSlotKey(key).time);
      return minutes < startMinutes || minutes >= endMinutes;
    });
    if (outside.length > 0 && !confirm(`表示しない時間帯に塗ったマスが${outside.length}個あります。消してもよいですか？`)) {
      startSelect.value = timeRange.startMinutes;
      endSelect.value = timeRange.endMinutes;
      return;
    }

    outside.forEach((key) => slots.delete(key));
    timeRange = { startMinutes, endMinutes };
    refresh();
  }

  // --- カレンダー ---
  function renderCalendar() {
    const firstDay = new Date(shownYear, shownMonth, 1);
    const daysInMonth = new Date(shownYear, shownMonth + 1, 0).getDate();

    const header = el(
      "div",
      { class: "calendar-header" },
      el("button", { type: "button", class: "btn-icon", "aria-label": "前の月", onclick: () => moveMonth(-1) }, "‹"),
      el("span", { class: "calendar-title" }, `${shownYear}年${shownMonth + 1}月`),
      el("button", { type: "button", class: "btn-icon", "aria-label": "次の月", onclick: () => moveMonth(1) }, "›"),
    );

    const days = el("div", { class: "calendar-grid" });
    WEEKDAY_LABELS.forEach((label, index) => {
      days.append(el("div", { class: `calendar-weekday weekday-${index}` }, label));
    });

    // 1日の曜日の位置まで空白を入れる
    for (let i = 0; i < firstDay.getDay(); i++) {
      days.append(el("div"));
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(shownYear, shownMonth, day);
      const iso = toIsoDate(date);
      const classes = ["calendar-day", `weekday-${date.getDay()}`];
      if (selectedDates.has(iso)) classes.push("is-selected");
      if (iso === today) classes.push("is-today");

      days.append(
        el(
          "button",
          {
            type: "button",
            class: classes.join(" "),
            // 過去の日は新しく選べない（編集時にすでに選ばれている日は外せる）
            disabled: iso < today && !selectedDates.has(iso),
            "aria-pressed": selectedDates.has(iso) ? "true" : "false",
            onclick: () => toggleDate(iso),
          },
          day,
        ),
      );
    }

    calendarArea.replaceChildren(header, days);
  }

  function moveMonth(offset) {
    const moved = new Date(shownYear, shownMonth + offset, 1);
    shownYear = moved.getFullYear();
    shownMonth = moved.getMonth();
    renderCalendar();
  }

  function toggleDate(iso) {
    if (!selectedDates.has(iso)) {
      selectedDates.add(iso);
      refresh();
      return;
    }

    const painted = [...slots].filter((key) => parseSlotKey(key).date === iso);
    if (painted.length > 0 && !confirm("この日に塗った候補も消えます。よろしいですか？")) return;

    painted.forEach((key) => slots.delete(key));
    selectedDates.delete(iso);
    refresh();
  }

  // --- 塗った候補のまとめ ---
  function renderSummary() {
    const ranges = slotsToRanges(slots);
    const emptyDates = sortedDates().filter((date) => ![...slots].some((key) => key.startsWith(date)));

    summaryArea.replaceChildren(
      el(
        "div",
        {},
        el("p", { class: "hint" }, `候補: ${ranges.length}件（${slots.size}マス）`),
        ranges.length > 0 ? el("ul", { class: "range-list" }, ranges.map((range) => el("li", {}, formatRange(range)))) : null,
        emptyDates.length > 0 ? el("p", { class: "hint" }, "マスを塗っていない日は候補に含まれません。") : null,
      ),
    );
  }

  function refresh() {
    renderCalendar();
    renderGrid();
    renderSummary();
  }

  refresh();

  return {
    getSlots() {
      return [...slots].sort();
    },
  };
}
