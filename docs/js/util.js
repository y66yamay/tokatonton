// 画面の共通処理。

// ---------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------

// 要素を作る。文字列の子要素は textContent として入るので HTML としては解釈されない。
//   el("button", { class: "btn", onclick: handler }, "保存")
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key.startsWith("on")) {
      element.addEventListener(key.slice(2), value);
    } else if (key === "class") {
      element.className = value;
    } else if (value === true) {
      element.setAttribute(key, "");
    } else {
      element.setAttribute(key, value);
    }
  }

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

export function showMessage(container, text, type = "error") {
  container.replaceChildren(el("div", { class: `message message-${type}` }, text));
}

export async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = "コピーしました";
    setTimeout(() => (button.textContent = original), 1500);
  } catch {
    window.prompt("コピーしてください", text);
  }
}

// ---------------------------------------------------------------------
// 日付・時刻
// ---------------------------------------------------------------------

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// "2026-11-05" → Date（ローカル時刻の 0 時）
export function parseDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day);
}

// Date → "2026-11-05"
export function toIsoDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function todayIso() {
  return toIsoDate(new Date());
}

// "2026-11-05" → "11/5(木)"（年が今年でなければ "2027/1/5(火)"）
export function formatDate(isoDate) {
  const date = parseDate(isoDate);
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  const weekday = `(${WEEKDAYS[date.getDay()]})`;

  if (date.getFullYear() !== new Date().getFullYear()) {
    return `${date.getFullYear()}/${monthDay}${weekday}`;
  }
  return monthDay + weekday;
}

// 候補の時間帯の表示。"10:00〜11:00" / "10:00〜" / "終日"
export function formatTimeRange(startTime, endTime) {
  if (!startTime) return "終日";
  if (!endTime) return `${startTime}〜`;
  return `${startTime}〜${endTime}`;
}

export function formatCandidate(candidate) {
  return `${formatDate(candidate.date)} ${formatTimeRange(candidate.start_time, candidate.end_time)}`;
}

// 候補の並び順（日付 → 開始時刻 → 終了時刻。終日は先頭）
export function compareCandidates(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    (a.start_time || "").localeCompare(b.start_time || "") ||
    (a.end_time || "").localeCompare(b.end_time || "")
  );
}

// ---------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------

// 幹事トークンは URL の # 以降に置く（サーバーのアクセスログに残らないようにするため）
export function getAdminTokenFromHash() {
  return new URLSearchParams(location.hash.slice(1)).get("admin");
}

function pageUrl(fileName) {
  return new URL(fileName, location.href);
}

export function shareUrl(eventId) {
  const url = pageUrl("event.html");
  url.searchParams.set("id", eventId);
  return url.toString();
}

export function adminUrl(eventId, adminToken) {
  return `${shareUrl(eventId)}#admin=${encodeURIComponent(adminToken)}`;
}

export function editUrl(eventId, adminToken) {
  const url = pageUrl("index.html");
  url.searchParams.set("edit", eventId);
  return `${url}#admin=${encodeURIComponent(adminToken)}`;
}

// ---------------------------------------------------------------------
// 作成したイベントの履歴（このブラウザの localStorage に保存）
// ---------------------------------------------------------------------

const HISTORY_KEY = "tokatonton.createdEvents";

export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

export function saveToHistory({ id, title, adminToken }) {
  const others = loadHistory().filter((item) => item.id !== id);
  const history = [{ id, title, adminToken, savedAt: new Date().toISOString() }, ...others];
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
}

export function removeFromHistory(id) {
  const history = loadHistory().filter((item) => item.id !== id);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}
