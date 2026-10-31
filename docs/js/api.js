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

export function createEvent({ title, description, deadline, candidates }) {
  return callApi("createEvent", { title, description, deadline, candidates });
}

export function getEvent(eventId) {
  return callApi("getEvent", { eventId });
}

export function saveResponse({ eventId, responseId, name, comment, answers }) {
  return callApi("saveResponse", { eventId, responseId, name, comment, answers });
}

// --- 幹事だけが使える操作 ---

export function checkAdmin(eventId, adminToken) {
  return callApi("checkAdmin", { eventId, adminToken });
}

export function updateEvent({ eventId, adminToken, title, description, deadline, candidates }) {
  return callApi("updateEvent", { eventId, adminToken, title, description, deadline, candidates });
}

export function decideEvent(eventId, adminToken, candidateId) {
  return callApi("decideEvent", { eventId, adminToken, candidateId });
}

export function deleteResponse(eventId, adminToken, responseId) {
  return callApi("deleteResponse", { eventId, adminToken, responseId });
}

export function deleteEvent(eventId, adminToken) {
  return callApi("deleteEvent", { eventId, adminToken });
}
