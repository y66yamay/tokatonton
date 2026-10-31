/**
 * tokatonton: 予定調整アプリのサーバー側（Google Apps Script）
 *
 * スプレッドシートの「拡張機能 → Apps Script」にこのファイルの内容を貼り付け、
 * ウェブアプリとしてデプロイして使う（手順は README.md を参照）。
 *
 * 方針:
 *   - データはこのスプレッドシートの 2 つのシート（events / responses）に保存する。
 *     シートがなければ自動で作る。
 *   - 候補は 30 分ごとの「マス」の一覧。マスは "2026-11-05T10:00"（その日の 10:00〜10:30）のように表す。
 *   - 画面からは doPost に { action, args } を送り、決められた操作だけを実行する。
 *   - 幹事の操作には幹事トークンが必要。シートにはハッシュだけを保存する。
 *   - イベントの作成には合言葉が必要（スクリプト プロパティ CREATE_PASSPHRASE。未設定なら不要）。
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
  events: [
    'id', 'title', 'description', 'deadline', 'slots',
    'decided_date', 'decided_start', 'decided_end',
    'admin_token_hash', 'created_at', 'updated_at',
  ],
  responses: ['id', 'event_id', 'name', 'comment', 'answers', 'created_at', 'updated_at'],
};

const MAX_LENGTH = {
  title: 200,
  description: 5000,
  name: 100,
  comment: 1000,
};

const SLOT_MINUTES = 30;
const MAX_SLOTS = 1000;

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
  requireCreatePassphrase(args.passphrase);

  const title = validateText(args.title, 'タイトル', MAX_LENGTH.title, true);
  const description = validateText(args.description, '説明', MAX_LENGTH.description, false);
  const deadline = validateDeadline(args.deadline);
  const slots = validateSlots(args.slots);

  const adminToken = createToken();
  const now = new Date().toISOString();
  const eventId = Utilities.getUuid();

  withLock(function () {
    new Table('events').insert([{
      id: eventId,
      title: title,
      description: description,
      deadline: deadline,
      slots: JSON.stringify(slots),
      decided_date: '',
      decided_start: '',
      decided_end: '',
      admin_token_hash: hashToken(adminToken),
      created_at: now,
      updated_at: now,
    }]);
  });

  return { id: eventId, admin_token: adminToken };
}

// イベントの内容（候補のマス・回答を含む）を返す。見つからなければ null。
function getEvent(args) {
  const event = findEvent(args.eventId);
  if (!event) {
    return null;
  }

  const slots = JSON.parse(event.slots);

  const responses = new Table('responses').readAll()
    .filter(function (r) { return r.event_id === event.id; })
    .sort(function (a, b) { return a.created_at.localeCompare(b.created_at); })
    .map(function (r) {
      return {
        id: r.id,
        name: r.name,
        comment: r.comment,
        updated_at: r.updated_at,
        answers: pickAnswers(JSON.parse(r.answers || '{}'), slots),
      };
    });

  return {
    id: event.id,
    title: event.title,
    description: event.description,
    deadline: event.deadline || null,
    is_closed: isClosed(event.deadline),
    slots: slots,
    decided: event.decided_date
      ? { date: event.decided_date, start_time: event.decided_start, end_time: event.decided_end }
      : null,
    created_at: event.created_at,
    responses: responses,
  };
}

// 回答を保存する。responseId がなければ新規、あれば上書き。戻り値: 回答の id
//   answers: { "2026-11-05T10:00": "yes" | "maybe" | "no", ... }
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

    // このイベントの候補のマスに対する回答だけを保存する
    const answers = JSON.stringify(pickAnswers(args.answers, JSON.parse(event.slots)));
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

// イベントの内容と候補のマスを更新する
// （削除したマスへの回答はシートに残るが、読み込むときに除外される）
function updateEvent(args) {
  const title = validateText(args.title, 'タイトル', MAX_LENGTH.title, true);
  const description = validateText(args.description, '説明', MAX_LENGTH.description, false);
  const deadline = validateDeadline(args.deadline);
  const slots = validateSlots(args.slots);

  withLock(function () {
    const event = requireAdmin(args.eventId, args.adminToken);

    event.title = title;
    event.description = description;
    event.deadline = deadline;
    event.slots = JSON.stringify(slots);

    // 確定していた範囲のマスが候補から外れたら、確定を取り消す
    if (event.decided_date) {
      const decidedSlots = slotsInRange(event.decided_date, event.decided_start, event.decided_end);
      const stillValid = decidedSlots.every(function (slot) { return slots.indexOf(slot) !== -1; });
      if (!stillValid) {
        clearDecision(event);
      }
    }

    event.updated_at = new Date().toISOString();
    new Table('events').update(event);
  });
  return null;
}

// 日程を確定する。date を省略（null）すると確定を取り消す。
//   args: { date: "2026-11-05", startTime: "10:00", endTime: "11:30" }
function decideEvent(args) {
  withLock(function () {
    const event = requireAdmin(args.eventId, args.adminToken);

    if (!args.date) {
      clearDecision(event);
    } else {
      const date = String(args.date);
      const startTime = String(args.startTime || '');
      const endTime = String(args.endTime || '');
      if (!isValidDate(date) || !isValidSlotTime(startTime) || !isValidEndTime(endTime) || endTime <= startTime) {
        throw new AppError('確定する日時の形式が正しくありません');
      }

      const eventSlots = JSON.parse(event.slots);
      const allCandidates = slotsInRange(date, startTime, endTime).every(function (slot) {
        return eventSlots.indexOf(slot) !== -1;
      });
      if (!allCandidates) {
        throw new AppError('候補になっていない時間が含まれています');
      }

      event.decided_date = date;
      event.decided_start = startTime;
      event.decided_end = endTime;
    }

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

// イベントを削除する（回答もすべて消える）
function deleteEvent(args) {
  withLock(function () {
    const event = requireAdmin(args.eventId, args.adminToken);
    const responses = new Table('responses');
    responses.deleteRecords(responses.readAll().filter(function (r) { return r.event_id === event.id; }));
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

// イベント作成用の合言葉を確認する。違っていればエラー。
// 合言葉は「プロジェクトの設定 → スクリプト プロパティ」の CREATE_PASSPHRASE に設定する。
// （コードに書かないので GitHub には載らない。未設定なら確認しない）
function requireCreatePassphrase(passphrase) {
  const expected = PropertiesService.getScriptProperties().getProperty('CREATE_PASSPHRASE');
  if (!expected) {
    return;
  }
  if (String(passphrase || '').trim() !== expected.trim()) {
    Utilities.sleep(1000);   // 片っ端から試されにくくするため、少し待たせる
    throw new AppError('合言葉が違います');
  }
}

function clearDecision(event) {
  event.decided_date = '';
  event.decided_start = '';
  event.decided_end = '';
}

// 回答のうち、候補のマスへの正しい値だけを取り出す
function pickAnswers(answers, slots) {
  const picked = {};
  slots.forEach(function (slot) {
    if (ANSWER_VALUES.indexOf(answers[slot]) !== -1) {
      picked[slot] = answers[slot];
    }
  });
  return picked;
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
// マスと時刻
// =====================================================================

// "10:30" → 630（0 時からの分）
function toMinutes(time) {
  const parts = time.split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

// 630 → "10:30"
function fromMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  return String(hours).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
}

// その日の startTime〜endTime に含まれるマスの一覧
function slotsInRange(date, startTime, endTime) {
  const slots = [];
  for (let m = toMinutes(startTime); m < toMinutes(endTime); m += SLOT_MINUTES) {
    slots.push(date + 'T' + fromMinutes(m));
  }
  return slots;
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

// 候補のマスの一覧をチェックして、重複を除いて並べ替えたものを返す
function validateSlots(slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new AppError('候補の時間を1マス以上選んでください');
  }

  const unique = [];
  slots.forEach(function (slot) {
    const parts = String(slot).split('T');
    if (parts.length !== 2 || !isValidDate(parts[0]) || !isValidSlotTime(parts[1])) {
      throw new AppError('候補の時間の形式が正しくありません');
    }
    if (unique.indexOf(slot) === -1) {
      unique.push(slot);
    }
  });

  if (unique.length > MAX_SLOTS) {
    throw new AppError('候補の時間は' + MAX_SLOTS + 'マスまでです');
  }
  return unique.sort();
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

// マスの開始時刻（"10:00" や "10:30"）か
function isValidSlotTime(value) {
  return /^([01]\d|2[0-3]):(00|30)$/.test(value);
}

// 範囲の終了時刻か（マスの開始時刻に加えて "24:00" も可）
function isValidEndTime(value) {
  return isValidSlotTime(value) || value === '24:00';
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
    return sheet;
  }

  // 古い形式のシートが残っていたら、データを壊さないように止める
  const header = sheet.getRange(1, 1, 1, columns.length).getDisplayValues()[0];
  if (header.join(',') !== columns.join(',')) {
    throw new AppError(
      'スプレッドシートのシート「' + name + '」の列が古い形式です。' +
      'README の手順に従って、古いシートを削除してください'
    );
  }
  return sheet;
}
