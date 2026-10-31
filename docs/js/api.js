// Supabase の RPC（supabase/schema.sql の関数）を呼び出す。

import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function buildHeaders() {
  const headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_KEY,
  };
  // 従来の anon キー（JWT）は Authorization ヘッダーにも付ける
  if (SUPABASE_KEY.startsWith("eyJ")) {
    headers.Authorization = `Bearer ${SUPABASE_KEY}`;
  }
  return headers;
}

async function callRpc(functionName, args) {
  if (!isConfigured()) {
    throw new Error("Supabase の接続設定がありません（docs/js/config.js を設定してください）");
  }

  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error("サーバーに接続できませんでした。通信環境を確認してください");
  }

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(body?.message || `エラーが発生しました（${response.status}）`);
  }
  return body;
}

// --- 誰でも使える操作 ---

export function createEvent({ title, description, deadline, candidates }) {
  return callRpc("create_event", {
    p_title: title,
    p_description: description,
    p_deadline: deadline || null,
    p_candidates: candidates,
  });
}

export function getEvent(eventId) {
  return callRpc("get_event", { p_event_id: eventId });
}

export function saveResponse({ eventId, responseId, name, comment, answers }) {
  return callRpc("save_response", {
    p_event_id: eventId,
    p_response_id: responseId || null,
    p_name: name,
    p_comment: comment,
    p_answers: answers,
  });
}

// --- 幹事だけが使える操作 ---

export function checkAdmin(eventId, adminToken) {
  return callRpc("check_admin", { p_event_id: eventId, p_admin_token: adminToken });
}

export function updateEvent({ eventId, adminToken, title, description, deadline, candidates }) {
  return callRpc("update_event", {
    p_event_id: eventId,
    p_admin_token: adminToken,
    p_title: title,
    p_description: description,
    p_deadline: deadline || null,
    p_candidates: candidates,
  });
}

export function decideEvent(eventId, adminToken, candidateId) {
  return callRpc("decide_event", {
    p_event_id: eventId,
    p_admin_token: adminToken,
    p_candidate_id: candidateId,
  });
}

export function deleteResponse(eventId, adminToken, responseId) {
  return callRpc("delete_response", {
    p_event_id: eventId,
    p_admin_token: adminToken,
    p_response_id: responseId,
  });
}

export function deleteEvent(eventId, adminToken) {
  return callRpc("delete_event", { p_event_id: eventId, p_admin_token: adminToken });
}
