/**
 * カメラ貸出台帳 — 共有データ用 Google Apps Script
 *
 * 使い方（くわしくは SETUP.md）:
 *   1. 新しい Google スプレッドシートを作り「拡張機能 → Apps Script」を開く
 *   2. このファイルの中身をすべて貼り付けて保存
 *   3. 下の PASSCODE に合言葉を入れる（空のままだとURLを知っている人は誰でも操作できます）
 *   4. 関数「setup」を一度だけ実行（シートと初期データを作ります）
 *   5. 「デプロイ → 新しいデプロイ → ウェブアプリ」
 *        次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *
 * 操作履歴は「history」シートに記録されます。スプレッドシートを他の人と共有しなければ、
 * 履歴を見られるのはあなただけです（アプリの利用者はスプレッドシートを直接開けません）。
 */

const PASSCODE = '';   // ← 合言葉。例: 'camera2026'

const SHEETS = {
  items:   ['id', 'name', 'category', 'location', 'qty', 'note', 'updatedAt'],
  loans:   ['id', 'type', 'itemId', 'qty', 'staff', 'person', 'contact', 'start', 'end', 'returned', 'note', 'updatedAt'],
  staff:   ['id', 'name', 'order', 'updatedAt'],
  history: ['日時', '操作した人', '操作', '内容'],
};
const WRITABLE = ['items', 'loans', 'staff'];
const INITIAL_SKUS = ['Luna Ultra', 'X6', 'X5', 'X4 Air', 'GO Ultra', 'Ace Pro 2'];
const INITIAL_STAFF = ['Xu', 'Kate', 'Sumi', 'Hikari', 'Jaeyong', 'Ume', 'Sylvia', 'Kinki', 'Keina', 'Teresa', '李哥', '小王'];

/** 初回だけ手動で実行：シートを作り、SKUと担当者を登録する */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach((name) => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = SHEETS[name];
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // 日付などが自動変換されないよう、すべて書式なしテキストにする
    sh.getRange(1, 1, sh.getMaxRows(), head.length).setNumberFormat('@');
  });
  const now = new Date().toISOString();
  if (ss.getSheetByName('items').getLastRow() < 2) {
    INITIAL_SKUS.forEach((n, i) => putRow_('items', { id: 'sku' + (i + 1), name: n, category: 'カメラ', location: '', qty: 1, note: '', updatedAt: now }));
  }
  if (ss.getSheetByName('staff').getLastRow() < 2) {
    INITIAL_STAFF.forEach((n, i) => putRow_('staff', { id: 'st' + (i + 1), name: n, order: i, updatedAt: now }));
  }
  const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
}

function doGet() {
  return json_({ ok: true, app: 'camera-rental-ledger', message: 'このURLをアプリの接続先に設定してください。' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  if (PASSCODE && req.pass !== PASSCODE) return json_({ ok: false, error: 'bad_pass' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'busy' });
  try {
    switch (req.op) {
      case 'list':
        return json_({ ok: true, data: { items: readAll_('items'), loans: readAll_('loans'), staff: readAll_('staff') } });
      case 'put':
        if (WRITABLE.indexOf(req.col) < 0 || !req.obj || !req.obj.id) return json_({ ok: false, error: 'bad_request' });
        putRow_(req.col, Object.assign({}, req.obj, { updatedAt: new Date().toISOString() }));
        return json_({ ok: true });
      case 'delete':
        if (WRITABLE.indexOf(req.col) < 0 || !req.id) return json_({ ok: false, error: 'bad_request' });
        deleteRow_(req.col, String(req.id));
        return json_({ ok: true });
      case 'log':
        sheet_('history').appendRow([
          Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm:ss'),
          safe_(req.actor), safe_(req.kind), safe_(req.text),
        ]);
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: 'bad_request' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'server_error', message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- helpers ---------- */
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。setup を実行してください。');
  return sh;
}
function readAll_(name) {
  const sh = sheet_(name), head = SHEETS[name], last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, head.length).getDisplayValues()
    .filter((r) => r[0])
    .map((r) => { const o = {}; head.forEach((h, i) => { if (h !== 'updatedAt') o[h] = r[i]; }); return o; });
}
function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}
function putRow_(name, obj) {
  const sh = sheet_(name), head = SHEETS[name];
  const row = head.map((h) => safe_(obj[h]));
  const at = findRow_(sh, String(obj.id));
  const r = at > 0 ? at : sh.getLastRow() + 1;
  sh.getRange(r, 1, 1, head.length).setNumberFormat('@').setValues([row]);
}
function deleteRow_(name, id) {
  const sh = sheet_(name), at = findRow_(sh, id);
  if (at > 0) sh.deleteRow(at);
}
// 数式として解釈されないようにする（= + - @ で始まる入力）
function safe_(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
