// 30 分ごとの「マス」の計算。
// マスは "2026-11-05T10:00"（2026/11/5 の 10:00〜10:30）のような文字列で表す。

import { formatDate, formatTimeRange } from "./util.js";

export const SLOT_MINUTES = 30;

export function slotKey(date, time) {
  return `${date}T${time}`;
}

// "2026-11-05T10:00" → { date: "2026-11-05", time: "10:00" }
export function parseSlotKey(key) {
  const [date, time] = key.split("T");
  return { date, time };
}

// "10:30" → 630（0 時からの分）
export function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

// 630 → "10:30"（1440 → "24:00"）
export function fromMinutes(minutes) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

// startMinutes〜endMinutes のマスの開始時刻の一覧
//   timesBetween(540, 660) → ["09:00", "09:30", "10:00", "10:30"]
export function timesBetween(startMinutes, endMinutes) {
  const times = [];
  for (let m = startMinutes; m < endMinutes; m += SLOT_MINUTES) {
    times.push(fromMinutes(m));
  }
  return times;
}

// マスの一覧に含まれる日付（重複なし・昇順）
export function datesOf(slotKeys) {
  return [...new Set([...slotKeys].map((key) => parseSlotKey(key).date))].sort();
}

// マスの一覧を、マス目に表示する時間帯（1 時間単位に切りのよい範囲）にする
//   戻り値: { startMinutes, endMinutes }
export function timeRangeOf(slotKeys) {
  const minutes = [...slotKeys].map((key) => toMinutes(parseSlotKey(key).time));
  const start = Math.min(...minutes);
  const end = Math.max(...minutes) + SLOT_MINUTES;
  return {
    startMinutes: Math.floor(start / 60) * 60,
    endMinutes: Math.ceil(end / 60) * 60,
  };
}

// 同じ日の連続したマスを 1 つの範囲にまとめる
//   ["2026-11-05T10:00", "2026-11-05T10:30", "2026-11-05T14:00"]
//   → [{ date: "2026-11-05", start_time: "10:00", end_time: "11:00" },
//      { date: "2026-11-05", start_time: "14:00", end_time: "14:30" }]
export function slotsToRanges(slotKeys) {
  const ranges = [];
  for (const key of [...slotKeys].sort()) {
    const { date, time } = parseSlotKey(key);
    const last = ranges[ranges.length - 1];

    if (last && last.date === date && last.end_time === time) {
      last.end_time = fromMinutes(toMinutes(time) + SLOT_MINUTES);
    } else {
      ranges.push({ date, start_time: time, end_time: fromMinutes(toMinutes(time) + SLOT_MINUTES) });
    }
  }
  return ranges;
}

// 範囲に含まれるマスの一覧
export function rangeToSlots({ date, start_time, end_time }) {
  return timesBetween(toMinutes(start_time), toMinutes(end_time)).map((time) => slotKey(date, time));
}

// { date, start_time, end_time } → "11/5(木) 10:00〜11:30"
export function formatRange({ date, start_time, end_time }) {
  return `${formatDate(date)} ${formatTimeRange(start_time, end_time)}`;
}

// 1 マスの表示 → "11/5(木) 10:00〜10:30"
export function formatSlot(key) {
  const { date, time } = parseSlotKey(key);
  return formatRange({ date, start_time: time, end_time: fromMinutes(toMinutes(time) + SLOT_MINUTES) });
}
