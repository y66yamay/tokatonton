/**
 * tokatonton: 予定調整アプリのサーバー側（Google Apps Script）
 *
 * スプレッドシートの「拡張機能 → Apps Script」にこのファイルの内容を貼り付け、
 * ウェブアプリとしてデプロイして使う（手順は README.md を参照）。
 *
 * 方針:
 *   - データはこのスプレッドシートの 3 つのシート（events / candidates / responses）に保存する。
 *     シートがなければ自動で作る。
 *   - 画面からは doPost に { action, args } を送り、決められた操作だけを実行する。
 *   - 幹事の操作には幹事トークンが必要。シートにはハッシュだけを保存する。
 *   - 日付・時刻は「日本時間の壁時計の値」として文字列で保存する。
 *
 * 下の @OnlyCurrentDoc により、このスクリプトは
 * このスプレッドシート以外のファイルにはアクセスできない。
 *
 * @OnlyCurrentDoc
 */

const TIME_ZONE = 'Asia/Tokyo';

// シート名と列の並び
const COLUMNS = {
  events: ['id', 'title', 'description', 'deadline', 'decided_candidate_id', 'admin_token_hash', 'created_at', 'updated_at'],
  candidates: ['id', 'event_id', 'date', 'start_time', 'end_time'],
  responses: ['id', 'event_id', 'name', 'comment', 'answers', 'created_at', 'updated_at'],
};

const MAX_LENGTH = {
  title: 200,
  description: 5000,
  name: 100,
  comment: 1000,
};

const MAX_CANDIDATES = 100;

const ANSWER_VALUES = ['yes', 'maybe', 'no'];


// =====================================================================
// 入口
// =====================================================================

// 画面から呼ばれる操作の一覧
const ACTIONS = {
  createEvent: createEvent,
  getEvent: getEvent,
  saveResponse: saveResponse,
  checkAdmin: checkAdmin,
  updateEvent: updateEvent,
  decideEvent: decideEvent,
  deleteResponse: deleteResponse,
  deleteEvent: deleteEvent,
};

function doPost(e) {
  let result;
  try {
    const request = JSON.parse(e.postData.contents);
    const action = ACTIONS[request.action];
    if (!action) {
      throw new AppError('不明な操作です');
    }
    result = { ok: true, data: action(request.args || {}) };
  } catch (error) {
    if (error instanceof AppError) {
      result = { ok: false, error: error.message };
    } else {
      console.error(error);
      result = { ok: false, error: 'サーバーでエラーが発生しました' };
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ブラウザで URL を開いたときの動作確認用
function doGet() {
  return ContentService.createTextOutput('tokatonton のサーバーは動作しています');
}

// 利用者に見せてよいエラー
class AppError extends Error {}


// =====================================================================
// 誰でも使える操作
// =====================================================================

// イベントを作成する。戻り値: { id, admin_token }
function createEvent(args) {
  const title = validateText(args.title, 'タイトル', MAX_LENGTH.title, true);
  const description = validateText(args.description, '説明', MAX_LENGTH.description, false);
  const deadline = validateDeadline(args.deadline);
  const candidates = validateCandidates(args.candidates);

  const adminToken = createToken();
  const now = new Date().toISOString();
  const eventId = Utilities.getUuid();

  return withLock(function () {
    new Table('events').insert([{
      id: eventId,
      title: title,
      description: description,
      deadline: deadline,
      decided_candidate_id: '',
      admin_token_hash: hashToken(adminToken),
      created_at: now,
      updated_at: now,
    }]);
    saveCandidates(eventId, candidates);

    return { id: eventId, admin_token: adminToken };
  });
}

// イベントの内容（候補日時・回答を含む）を返す。見つからなければ null。
function getEvent(args) {
  const event = findEvent(args.eventId);
  if (!event) {
    return null;
  }

  const candidates = new Table('candidates').readAll()
    .filter(function (c) { return c.event_id === event.id; })
    .sort(compareCandidates)
    .map(function (c) {
      return {
        id: c.id,
        date: c.date,
        start_time: c.start_time || null,
        end_time: c.end_time || null,
      };
    });

  const candidateIds = candidates.map(function (c) { return c.id; });

  const responses = new Table('responses').readAll()
    .filter(function (r) { return r.event_id === event.id; })
    .sort(function (a, b) { return a.created_at.localeCompare(b.created_at); })
    .map(function (r) {
      return {
        id: r.id,
        name: r.name,
        comment: r.comment,
        updated_at: r.updated_at,
        answers: pickAnswers(JSON.parse(r.answers || '{}'), candidateIds),
      };
    });

  return {
    id: event.id,
    title: event.title,
    description: event.description,
    deadline: event.deadline || null,
    is_closed: isClosed(event.deadline),
    decided_candidate_id: event.decided_candidate_id || null,
    created_at: event.created_at,
    candidates: candidates,
    responses: responses,
  };
}

// 回答を保存する。responseId がなければ新規、あれば上書き。戻り値: 回答の id
//   answers: { 候補id: "yes" | "maybe" | "no", ... }
function saveResponse(args) {
  const name = validateText(args.name, 'お名前', MAX_LENGTH.name, true);
  const comment = validateText(args.comment, 'コメント', MAX_LENGTH.comment, false);
  if (!args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers)) {
    throw new AppError('回答の形式が正しくありません');
  }

  return withLock(function () {
    const event = findEvent(args.eventId);
    if (!event) {
      throw new AppError('イベントが見つかりません');
    }
    if (isClosed(event.deadline)) {
      throw new AppError('回答の締切を過ぎています');
    }

    // このイベントの候補に対する回答だけを保存する
    const candidateIds = new Table('candidates').readAll()
      .filter(function (c) { return c.event_id === event.id; })
      .map(function (c) { return c.id; });
    const answers = JSON.stringify(pickAnswers(args.answers, candidateIds));
    const now = new Date().toISOString();
    const responses = new Table('responses');

    if (!args.responseId) {
      const responseId = Utilities.getUuid();
      responses.insert([{
        id: responseId,
        event_id: event.id,
        name: name,
        comment: comment,
        answers: answers,
        created_at: now,
        updated_at: now,
      }]);
      return responseId;
    }

    const response = responses.readAll().find(function (r) {
      return r.id === args.responseId && r.event_id === event.id;
    });
    if (!response) {
      throw new AppError('回答が見つかりません');
    }
    response.name = name;
    response.comment = comment;
    response.answers = answers;
    response.updated_at = now;
    responses.update(response);
    return response.id;
  });
}

// 幹事トークンが正しいかを返す（画面で幹事モードにするかの判定用）
function checkAdmin(args) {
  const event = findEvent(args.eventId);
  return Boolean(event) && event.admin_token_hash === hashToken(String(args.adminToken || ''));
}


// =====================================================================
// 幹事だけが使える操作
// =====================================================================

// イベントの内容と候補日時を更新する
function updateEvent(args) {
  const title = validateText(args.title, 'タイトル', MAX_LENGTH.title, true);
  const description = validateText(args.description, '説明', MAX_LENGTH.description, false);
  const deadline = validateDeadline(args.deadline);
  const candidates = validateCandidates(args.candidates);

  withLock(function () {
    const event = requireAdmin(args.eventId, args.adminToken);
    const keptIds = saveCandidates(event.id, candidates);

    event.title = title;
    event.description = description;
    event.deadline = deadline;
    if (keptIds.indexOf(event.decided_candidate_id) === -1) {
      event.decided_candidate_id = '';   // 確定していた候補が削除された
    }
    event.updated_at = new Date().toISOString();
    new Table('events').update(event);
  });
  return null;
}

// 日程を確定する。candidateId を null にすると確定を取り消す。
function decideEvent(args) {
  withLock(function () {
    const event = requireAdmin(args.eventId, args.adminToken);

    if (args.candidateId) {
      const exists = new Table('candidates').readAll().some(function (c) {
        return c.id === args.candidateId && c.event_id === event.id;
      });
      if (!exists) {
        throw new AppError('候補日時が見つかりません');
      }
    }

    event.decided_candidate_id = args.candidateId || '';
    event.updated_at = new Date().toISOString();
    new Table('events').update(event);
  });
  return null;
}

// 回答を削除する
function deleteResponse(args) {
  withLock(function () {
    const event = requireAdmin(args.eventId, args.adminToken);
    const responses = new Table('responses');
    responses.deleteRecords(responses.readAll().filter(function (r) {
      return r.id === args.responseId && r.event_id === event.id;
    }));
  });
  return null;
}

// イベントを削除する（候補日時・回答もすべて消える）
function deleteEvent(args) {
  withLock(function () {
    const event = requireAdmin(args.eventId, args.adminToken);

    ['responses', 'candidates'].forEach(function (name) {
      const table = new Table(name);
      table.deleteRecords(table.readAll().filter(function (r) { return r.event_id === event.id; }));
    });
    new Table('events').deleteRecords([event]);
  });
  return null;
}


// =====================================================================
// 操作の部品
// =====================================================================

function findEvent(eventId) {
  if (!eventId) {
    return null;
  }
  return new Table('events').readAll().find(function (e) { return e.id === eventId; }) || null;
}

// 幹事トークンを確認してイベントを返す。違っていればエラー。
function requireAdmin(eventId, adminToken) {
  const event = findEvent(eventId);
  if (!event || event.admin_token_hash !== hashToken(String(adminToken || ''))) {
    throw new AppError('幹事用URLが正しくありません');
  }
  return event;
}

// 候補日時のリストを保存する。戻り値: 保存後の候補の id 一覧
//   id のある候補は上書き、id のない候補は追加、リストにない既存候補は削除する。
function saveCandidates(eventId, candidates) {
  const table = new Table('candidates');
  const existing = table.readAll().filter(function (c) { return c.event_id === eventId; });
  const keptIds = [];
  const newRecords = [];

  candidates.forEach(function (candidate) {
    if (candidate.id) {
      const record = existing.find(function (c) { return c.id === candidate.id; });
      if (!record) {
        throw new AppError('存在しない候補日時が指定されました');
      }
      record.date = candidate.date;
      record.start_time = candidate.start_time;
      record.end_time = candidate.end_time;
      table.update(record);
      keptIds.push(record.id);
    } else {
      const id = Utilities.getUuid();
      newRecords.push({
        id: id,
        event_id: eventId,
        date: candidate.date,
        start_time: candidate.start_time,
        end_time: candidate.end_time,
      });
      keptIds.push(id);
    }
  });

  // 行の削除は行番号を変えるので、上書きのあとに行う
  table.deleteRecords(existing.filter(function (c) { return keptIds.indexOf(c.id) === -1; }));
  table.insert(newRecords);
  return keptIds;
}

// 回答のうち、指定した候補への正しい値だけを取り出す
function pickAnswers(answers, candidateIds) {
  const picked = {};
  candidateIds.forEach(function (id) {
    if (ANSWER_VALUES.indexOf(answers[id]) !== -1) {
      picked[id] = answers[id];
    }
  });
  return picked;
}

// 候補の並び順（日付 → 開始時刻 → 終了時刻。終日は先頭）
function compareCandidates(a, b) {
  return a.date.localeCompare(b.date)
    || (a.start_time || '').localeCompare(b.start_time || '')
    || (a.end_time || '').localeCompare(b.end_time || '');
}

function isClosed(deadline) {
  return Boolean(deadline) && deadline < todayInJapan();
}

function todayInJapan() {
  return Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd');
}

// 複数の人が同時に書き込んでも壊れないように、ロックを取ってから実行する
function withLock(callback) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new AppError('混み合っています。少し待ってからもう一度お試しください');
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}


// =====================================================================
// 幹事トークン
// =====================================================================

function createToken() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

function hashToken(token) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}


// =====================================================================
// 入力チェック
// =====================================================================

function validateText(value, label, maxLength, required) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (required && !text) {
    throw new AppError(label + 'を入力してください');
  }
  if (text.length > maxLength) {
    throw new AppError(label + 'は' + maxLength + '文字以内にしてください');
  }
  return text;
}

function validateDeadline(value) {
  if (!value) {
    return '';
  }
  if (!isValidDate(value)) {
    throw new AppError('回答締切日の形式が正しくありません');
  }
  return value;
}

// 候補日時のリストをチェックして、{ id, date, start_time, end_time } の配列にする
function validateCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new AppError('候補日時を1つ以上指定してください');
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw new AppError('候補日時は' + MAX_CANDIDATES + '件までです');
  }

  return candidates.map(function (candidate) {
    const date = String(candidate.date || '');
    const startTime = String(candidate.start_time || '');
    const endTime = String(candidate.end_time || '');

    if (!isValidDate(date)) {
      throw new AppError('候補日時の日付が正しくありません');
    }
    if ((startTime && !isValidTime(startTime)) || (endTime && !isValidTime(endTime))) {
      throw new AppError('候補日時の時刻が正しくありません');
    }
    if (endTime && !startTime) {
      throw new AppError('終了時刻だけを指定することはできません');
    }
    if (startTime && endTime && endTime <= startTime) {
      throw new AppError('終了時刻は開始時刻より後にしてください');
    }

    return {
      id: candidate.id ? String(candidate.id) : '',
      date: date,
      start_time: startTime,
      end_time: endTime,
    };
  });
}

// "2026-11-05" の形で、実在する日付か
function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// "10:00" の形か
function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}


// =====================================================================
// シートの読み書き
// =====================================================================

// 1 つのシートを「1 行 = 1 レコード」の表として扱う。
// 読み込んだレコードには行番号（_row）が付き、update / deleteRecords で使う。
class Table {
  constructor(name) {
    this.columns = COLUMNS[name];
    this.sheet = getOrCreateSheet(name, this.columns);
  }

  readAll() {
    const lastRow = this.sheet.getLastRow();
    if (lastRow < 2) {
      return [];
    }

    // getDisplayValues で、すべての値を文字列として読む
    const rows = this.sheet.getRange(2, 1, lastRow - 1, this.columns.length).getDisplayValues();
    const columns = this.columns;
    return rows.map(function (row, index) {
      const record = { _row: index + 2 };
      columns.forEach(function (column, i) { record[column] = row[i]; });
      return record;
    });
  }

  insert(records) {
    if (records.length === 0) {
      return;
    }
    const firstRow = this.sheet.getLastRow() + 1;
    this.sheet
      .getRange(firstRow, 1, records.length, this.columns.length)
      .setValues(records.map(this.toRow, this));
  }

  update(record) {
    this.sheet
      .getRange(record._row, 1, 1, this.columns.length)
      .setValues([this.toRow(record)]);
  }

  deleteRecords(records) {
    // 下の行から消さないと、行番号がずれる
    records
      .map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (row) { this.sheet.deleteRow(row); }, this);
  }

  toRow(record) {
    return this.columns.map(function (column) { return toCellValue(record[column]); });
  }
}

// 値を必ず文字列としてセルに入れる。
// 先頭に ' を付けると、日付・数値への自動変換や数式としての解釈が起きない（' 自体は表示されない）。
function toCellValue(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  return "'" + String(value);
}

function getOrCreateSheet(name, columns) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}
