// サーバー（Google Apps Script: gas/Code.gs）の操作を呼び出す。

import { GAS_URL } from "./config.js";

export function isConfigured() {
  return Boolean(GAS_URL);
}

async function callApi(action, args) {
  if (!isConfigured()) {
    throw new Error("サーバーの接続設定がありません（docs/js/config.js を設定してください）");
  }

  let body;
  try {
    // Content-Type を text/plain にすると、Apps Script が受け付けない事前確認（CORS プリフライト）が発生しない
    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, args }),
    });
    body = await response.json();
  } catch {
    throw new Error("サーバーに接続できませんでした。通信環境か docs/js/config.js の URL を確認してください");
  }

  if (!body.ok) {
    throw new Error(body.error || "エラーが発生しました");
  }
  return body.data;
}

// --- 誰でも使える操作 ---

// slots: 候補のマスの一覧（"2026-11-05T10:00" の形）
// passphrase: イベント作成用の合言葉
export function createEvent({ title, description, deadline, slots, passphrase }) {
  return callApi("createEvent", { title, description, deadline, slots, passphrase });
}

export function getEvent(eventId) {
  return callApi("getEvent", { eventId });
}

// answers: { "2026-11-05T10:00": "yes" | "maybe" | "no", ... }
export function saveResponse({ eventId, responseId, name, comment, answers }) {
  return callApi("saveResponse", { eventId, responseId, name, comment, answers });
}

// --- 幹事だけが使える操作 ---

export function checkAdmin(eventId, adminToken) {
  return callApi("checkAdmin", { eventId, adminToken });
}

export function updateEvent({ eventId, adminToken, title, description, deadline, slots }) {
  return callApi("updateEvent", { eventId, adminToken, title, description, deadline, slots });
}

// range: { date, start_time, end_time }。null なら確定を取り消す
export function decideEvent(eventId, adminToken, range) {
  return callApi("decideEvent", {
    eventId,
    adminToken,
    date: range ? range.date : null,
    startTime: range ? range.start_time : null,
    endTime: range ? range.end_time : null,
  });
}

export function deleteResponse(eventId, adminToken, responseId) {
  return callApi("deleteResponse", { eventId, adminToken, responseId });
}

export function deleteEvent(eventId, adminToken) {
  return callApi("deleteEvent", { eventId, adminToken });
}
