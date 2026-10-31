// マス目（縦: 30 分ごとの時刻、横: 日付）の表示と、なぞって範囲を選ぶ操作。
//
//   const grid = createSlotGrid(container, {
//     dates: ["2026-11-05", ...],          // 列
//     times: ["09:00", "09:30", ...],      // 行（マスの開始時刻）
//     cellState: (key) => ({ className, text, title, level }),  // 各マスの見た目
//     canStart: (key) => true,             // そのマスからなぞり始められるか
//     singleColumn: false,                 // true なら、なぞり始めた日の列だけを選ぶ
//     paintable: true,                     // 最初からなぞる操作を受け付けるか
//     onSelect: (keys, startKey, phase) => {},  // なぞった範囲。phase は "start" | "move" | "end"
//     onFocus: (key) => {},                // マスにカーソルを乗せた／タップした
//   });
//   grid.update();                         // 各マスの見た目を cellState で更新する
//   grid.setLayout(dates, times);          // 列と行を作り直す
//   grid.setPaintable(true);               // なぞる操作を受け付けるか（スマホのスクロールとの切り替え）

import { el, formatDate, parseDate } from "./util.js";
import { slotKey } from "./slots.js";

export function createSlotGrid(container, options) {
  let dates = options.dates;
  let times = options.times;
  const cells = new Map();   // マスの key → td 要素
  let drag = null;           // なぞっている途中の情報

  const table = el("table", { class: options.paintable ? "slot-grid is-paintable" : "slot-grid" });
  container.replaceChildren(el("div", { class: "slot-grid-scroll" }, table));

  // --- 表示 ---
  function build() {
    cells.clear();

    const headerRow = el(
      "tr",
      {},
      el("th", { class: "slot-corner" }),
      dates.map((date) => el("th", { class: `slot-date weekday-${parseDate(date).getDay()}` }, formatDate(date))),
    );

    const bodyRows = times.map((time, row) =>
      el(
        "tr",
        { class: time.endsWith(":00") ? "is-hour" : "is-half" },
        // 時刻のラベルは正時の行だけに付ける
        el("th", { class: "slot-time" }, time.endsWith(":00") ? time : ""),
        dates.map((date, column) => {
          const key = slotKey(date, time);
          const cell = el("td", { "data-key": key, "data-row": row, "data-column": column });
          cells.set(key, cell);
          return cell;
        }),
      ),
    );

    table.replaceChildren(el("thead", {}, headerRow), el("tbody", {}, bodyRows));
    update();
  }

  function update() {
    for (const [key, cell] of cells) {
      const state = options.cellState(key);
      cell.className = state.className || "";
      cell.textContent = state.text || "";
      cell.title = state.title || "";
      if (state.level === undefined) {
        cell.style.removeProperty("--level");
      } else {
        cell.style.setProperty("--level", state.level);
      }
    }
  }

  // --- なぞる操作 ---

  // 画面上の位置にあるマス（このマス目の外なら null）
  function cellAt(x, y) {
    const cell = document.elementFromPoint(x, y)?.closest?.("td[data-key]");
    return cell && cells.get(cell.dataset.key) === cell ? cell : null;
  }

  // なぞり始めたマスと cell を角とする長方形に含まれるマスの key 一覧
  function keysInRectangle(cell) {
    const endColumn = options.singleColumn ? drag.column : Number(cell.dataset.column);
    const endRow = Number(cell.dataset.row);
    const keys = [];

    for (let c = Math.min(drag.column, endColumn); c <= Math.max(drag.column, endColumn); c++) {
      for (let r = Math.min(drag.row, endRow); r <= Math.max(drag.row, endRow); r++) {
        keys.push(slotKey(dates[c], times[r]));
      }
    }
    return keys;
  }

  table.addEventListener("pointerdown", (event) => {
    const cell = event.target.closest("td[data-key]");
    if (!cell || event.button !== 0) return;

    const key = cell.dataset.key;
    options.onFocus?.(key);
    if (!options.canStart?.(key)) return;

    event.preventDefault();
    drag = { column: Number(cell.dataset.column), row: Number(cell.dataset.row), startKey: key, lastCell: cell };
    drag.keys = [key];
    options.onSelect(drag.keys, key, "start");
  });

  document.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const cell = cellAt(event.clientX, event.clientY);
    if (!cell || cell === drag.lastCell) return;

    drag.lastCell = cell;
    drag.keys = keysInRectangle(cell);
    options.onSelect(drag.keys, drag.startKey, "move");
  });

  const finishDrag = () => {
    if (!drag) return;
    const { keys, startKey } = drag;
    drag = null;
    options.onSelect(keys, startKey, "end");
  };
  document.addEventListener("pointerup", finishDrag);
  document.addEventListener("pointercancel", finishDrag);

  // マウスを乗せたマスの情報を出す（なぞっている途中は出さない）
  table.addEventListener("pointerover", (event) => {
    if (drag || event.pointerType !== "mouse") return;
    const cell = event.target.closest("td[data-key]");
    if (cell) options.onFocus?.(cell.dataset.key);
  });

  build();

  return {
    update,
    setLayout(newDates, newTimes) {
      dates = newDates;
      times = newTimes;
      build();
    },
    setPaintable(paintable) {
      table.classList.toggle("is-paintable", paintable);
    },
    setSingleColumn(singleColumn) {
      options.singleColumn = singleColumn;
    },
  };
}
