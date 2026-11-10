'use strict';

/* ---------- 日付・表示ヘルパー ---------- */
const TYPE_LABEL = { rent: 'レンタル', borrow: '借用' };
const STATUS_LABEL = { active: '貸出中', upcoming: '予約', overdue: '延滞', returned: '返却済' };
const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return toISO(d); };
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
const fmtDate = (iso) => { const [, m, d] = iso.split('-'); return `${+m}/${+d}`; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3200);
}
function setSync(msg, warn) { const s = $('#sync'); s.textContent = msg; s.classList.toggle('warn', !!warn); }

let confirmResolve = null;
function askConfirm(title, msg, okLabel = '削除する') {
  $('#confirm-title').textContent = title; $('#confirm-msg').textContent = msg; $('#confirm-ok').textContent = okLabel;
  $('#dlg-confirm').showModal();
  return new Promise((r) => (confirmResolve = r));
}
$('#dlg-confirm').addEventListener('close', () => { confirmResolve?.($('#dlg-confirm').returnValue === 'ok'); confirmResolve = null; });

/* ---------- 保存先：Googleスプレッドシート（未設定ならこのパソコン内） ---------- */
const state = { items: [], loans: [], staff: [] };
const LOCAL_STAFF = ['Xu', 'Kate', 'Sumi', 'Hikari', 'Jaeyong', 'Ume', 'Sylvia', 'Kinki', 'Keina', 'Teresa', '李哥', '小王'];
const LOCAL_KEY = 'camera-rental-ledger';
const LOCAL_SKUS = ['Luna Ultra', 'X6', 'X5', 'X4 Air', 'GO Ultra', 'Ace Pro 2'];
const CFG_KEY = LOCAL_KEY + ':config', CACHE_KEY = LOCAL_KEY + ':cache', ME_KEY = LOCAL_KEY + ':me';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

function loadConfig() {
  let c = {}; try { c = JSON.parse(lsGet(CFG_KEY) || '{}'); } catch (e) {}
  const base = window.APP_CONFIG || {};
  return { apiUrl: c.apiUrl || base.apiUrl || '', passcode: c.passcode || '' };
}
let cfg = loadConfig();
// 共有リンクの ?key=合言葉 を一度だけ取り込み、アドレスから消す
(() => {
  const u = new URL(location.href), key = u.searchParams.get('key');
  if (key) { cfg.passcode = key; lsSet(CFG_KEY, JSON.stringify(cfg)); u.searchParams.delete('key'); history.replaceState(null, '', u.pathname + u.search + u.hash); }
})();
const online = () => !!cfg.apiUrl;
let pending = 0;

async function api(payload, conf = cfg) {
  const res = await fetch(conf.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...payload, pass: conf.passcode }) });
  if (!res.ok) throw new Error('http_' + res.status);
  const j = await res.json();
  if (!j.ok) { const err = new Error(j.error || 'error'); err.code = j.error; throw err; }
  return j;
}
function apiError(e, what) {
  if (e.code === 'bad_pass') { toast('合言葉が違います。設定から入れ直してください。'); openSettings(); }
  else toast(`${what}できませんでした。ネット接続を確認して、もう一度お試しください。`);
}
function applyData(d) {
  state.items = (d.items || []).map((x) => ({ ...x, qty: Number(x.qty) || 0 }));
  state.loans = (d.loans || []).map((x) => ({ ...x, qty: Number(x.qty) || 1, returned: x.returned || null }));
  state.staff = (d.staff || []).map((x) => ({ ...x, order: x.order === '' || x.order == null ? 999 : Number(x.order) }));
}
function saveLocal() { lsSet(online() ? CACHE_KEY : LOCAL_KEY, JSON.stringify(state)); }

async function refresh(quiet) {
  if (!online() || pending > 0) return;
  try {
    const j = await api({ op: 'list' });
    if (pending > 0) return;
    applyData(j.data); saveLocal(); render();
    setSync(`共有データ（${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} 更新）`);
  } catch (e) {
    if (e.code === 'bad_pass') { setSync('合言葉が違います', true); if (!quiet) openSettings(); }
    else setSync('オフライン：前回のデータを表示中', true);
  }
}

async function writeDoc(col, obj) {
  const list = state[col], i = list.findIndex((x) => x.id === obj.id), prev = i >= 0 ? list[i] : null;
  if (i >= 0) list[i] = obj; else list.push(obj);
  saveLocal(); render();
  if (!online()) return true;
  pending++;
  try { await api({ op: 'put', col, obj }); return true; }
  catch (e) { if (prev) state[col][state[col].findIndex((x) => x.id === obj.id)] = prev; else state[col] = state[col].filter((x) => x.id !== obj.id); render(); apiError(e, '保存'); return false; }
  finally { pending--; }
}
async function deleteDoc(col, id) {
  const prev = state[col].find((x) => x.id === id);
  state[col] = state[col].filter((x) => x.id !== id); saveLocal(); render();
  if (!online()) return true;
  pending++;
  try { await api({ op: 'delete', col, id }); return true; }
  catch (e) { if (prev) state[col].push(prev); render(); apiError(e, '削除'); return false; }
  finally { pending--; }
}

/* ---------- 操作履歴：スプレッドシートの「history」シートに裏で記録 ---------- */
let me = lsGet(ME_KEY) || '';
let logQueue = Promise.resolve();
function log(kind, text) {
  if (!online()) return;
  logQueue = logQueue.then(() => api({ op: 'log', actor: me || '（未選択）', kind, text })).catch(() => {});
}

/* ---------- 操作者・設定 ---------- */
function showMe() { $('#who-name').textContent = me || '未選択'; }
function openWho() {
  $('#f-who').innerHTML = '<option value="" disabled selected>選んでください</option>' + staffNames().map((n) => `<option ${n === me ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('#dlg-who').showModal();
}
$('#btn-who').addEventListener('click', openWho);
$('#dlg-who').addEventListener('close', () => {
  if ($('#dlg-who').returnValue !== 'save' || !$('#f-who').value) return;
  me = $('#f-who').value; lsSet(ME_KEY, me); lsSet(LOCAL_KEY + ':staff', me); showMe(); toast(`操作者を ${me} にしました`);
});
function openSettings() {
  if ($('#dlg-settings').open) return;
  $('#f-api').value = cfg.apiUrl; $('#f-pass').value = cfg.passcode;
  $('#settings-hint').textContent = ''; $('#settings-hint').className = 'hint';
  $('#dlg-settings').showModal();
}
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-banner-settings').addEventListener('click', openSettings);
$('#btn-test').addEventListener('click', async () => {
  const h = $('#settings-hint'); h.className = 'hint'; h.textContent = '確認中…';
  const conf = { apiUrl: $('#f-api').value.trim(), passcode: $('#f-pass').value };
  if (!conf.apiUrl) { h.textContent = '接続先URLを入れてください。'; h.classList.add('ng'); return; }
  try { const j = await api({ op: 'list' }, conf); h.textContent = `つながりました（製品 ${j.data.items.length}件・貸出 ${j.data.loans.length}件）`; h.classList.add('ok'); }
  catch (e) { h.textContent = e.code === 'bad_pass' ? '合言葉が違います。' : 'つながりません。URLが正しいか、ウェブアプリが「全員」に公開されているか確認してください。'; h.classList.add('ng'); }
});
$('#dlg-settings').addEventListener('close', () => {
  if ($('#dlg-settings').returnValue !== 'save') return;
  const wasOnline = online();
  cfg = { apiUrl: $('#f-api').value.trim(), passcode: $('#f-pass').value };
  lsSet(CFG_KEY, JSON.stringify(cfg));
  toast('接続設定を保存しました');
  start(!wasOnline);
});

function useLocal() {
  try { const raw = lsGet(LOCAL_KEY); if (raw) Object.assign(state, JSON.parse(raw)); } catch (e) {}
  if (!state.items.length && !state.loans.length && !state.staff.length) {
    state.staff = LOCAL_STAFF.map((name, order) => ({ id: uid(), name, order }));
    state.items = LOCAL_SKUS.map((name) => ({ id: uid(), name, category: 'カメラ', location: '', qty: 1, note: '' }));
  }
  setSync('お試しモード（このパソコン内に保存）', true);
  $('#demo-banner').hidden = false;
  render();
}

let pollTimer = null;
async function start(askWho) {
  showMe();
  if (!online()) { useLocal(); return; }
  $('#demo-banner').hidden = true;
  try { const raw = lsGet(CACHE_KEY); if (raw) { applyData(JSON.parse(raw)); render(); } } catch (e) {}
  setSync('読み込み中…');
  await refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') refresh(true); }, 30000);
  if ((askWho || !me) && state.staff.length) openWho();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(true); });
window.addEventListener('online', () => refresh(true));

/* ---------- 在庫計算 ---------- */
const itemById = (id) => state.items.find((i) => i.id === id);
function loanStatus(l, today = todayISO()) {
  if (l.returned) return 'returned';
  if (l.start > today) return 'upcoming';
  if (l.end < today) return 'overdue';
  return 'active';
}
// 未返却の延滞は今日まで占有中とみなす
function effectiveEnd(l, today = todayISO()) {
  if (l.returned) return l.returned < l.end ? l.returned : l.end;
  return l.end < today ? today : l.end;
}
const coversDay = (l, day) => l.start <= day && day <= effectiveEnd(l);
const isOutgoing = (l) => l.type !== 'borrow';
function usedOn(itemId, day, excludeId) {
  return state.loans.filter((l) => l.itemId === itemId && l.id !== excludeId && isOutgoing(l) && !l.returned && coversDay(l, day))
    .reduce((s, l) => s + Number(l.qty), 0);
}
function availableInRange(itemId, start, end, excludeId) {
  const item = itemById(itemId); if (!item) return 0;
  let maxUsed = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) maxUsed = Math.max(maxUsed, usedOn(itemId, d, excludeId));
  return Number(item.qty) - maxUsed;
}
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'ja');
// 担当者：登録済みの順番 → 過去の貸出にだけ出てくる名前
const staffNames = () => {
  const listed = [...state.staff].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name), 'ja')).map((x) => x.name);
  const extra = [...new Set(state.loans.map((l) => l.staff).filter((n) => n && !listed.includes(n)))].sort((a, b) => a.localeCompare(b, 'ja'));
  return [...listed, ...extra];
};
const staffTag = (l) => l.staff ? `<span class="sub">担当 ${esc(l.staff)}</span>` : '';
const sortedItems = () => [...state.items].sort(byName);
const colorOf = (itemId) => { const i = sortedItems().findIndex((x) => x.id === itemId); return i < 0 ? 'var(--done)' : `var(--p${(i % 6) + 1})`; };

/* ---------- タブ ---------- */
let currentTab = 'inventory';
$$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  currentTab = name;
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  $$('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
  try { localStorage.setItem(LOCAL_KEY + ':tab', name); } catch (e) {}
  render();
}
const stat = (label, value, warn) => `<div class="stat ${warn ? 'warn' : ''}"><div class="label">${label}</div><div class="value">${value}</div></div>`;

/* ---------- 在庫タブ ---------- */
function renderInventory() {
  const today = todayISO();
  const q = $('#inv-search').value.trim().toLowerCase();
  let totalQty = 0, totalOut = 0, soldOut = 0;
  state.items.forEach((i) => { const out = usedOn(i.id, today); totalQty += Number(i.qty); totalOut += out; if (Number(i.qty) - out <= 0) soldOut++; });
  const overdue = state.loans.filter((l) => loanStatus(l) === 'overdue').length;
  $('#inv-summary').innerHTML = stat('総台数', totalQty) + stat('貸出中', totalOut) + stat('在庫切れの製品', soldOut, soldOut > 0) + stat('延滞', overdue, overdue > 0);

  const cards = sortedItems().filter((i) => !q || [i.name, i.category, i.location, i.note].join(' ').toLowerCase().includes(q));
  $('#inv-cards').innerHTML = cards.map((i) => {
    const qty = Number(i.qty), out = usedOn(i.id, today), avail = qty - out, color = colorOf(i.id);
    const pill = avail <= 0 ? `<span class="pill out">貸出中・在庫なし</span>` : out > 0 ? `<span class="pill part">残り ${avail} / ${qty}台</span>` : `<span class="pill ok">在庫あり ${avail} / ${qty}台</span>`;
    const mine = state.loans.filter((l) => l.itemId === i.id);
    const now = mine.filter((l) => isOutgoing(l) && ['active', 'overdue'].includes(loanStatus(l))).sort((a, b) => a.end.localeCompare(b.end));
    const nowHtml = now.length ? now.map((l) => {
      const left = dayDiff(today, l.end), late = left < 0;
      return `<div class="${late ? 'late' : ''}">${esc(l.person)}${l.qty > 1 ? ` ×${l.qty}` : ''}　〜${fmtDate(l.end)}（${late ? `${-left}日延滞` : left === 0 ? '本日返却' : `残り${left}日`}）${l.staff ? `<div class="sub">担当 ${esc(l.staff)}</div>` : ''}</div>`;
    }).join('') : '<span class="sub">なし</span>';
    const next = mine.filter((l) => isOutgoing(l) && loanStatus(l) === 'upcoming').sort((a, b) => a.start.localeCompare(b.start));
    const nextHtml = next.length ? `${esc(next[0].person)}　${fmtDate(next[0].start)}〜${fmtDate(next[0].end)}${next[0].staff ? `<div class="sub">担当 ${esc(next[0].staff)}</div>` : ''}${next.length > 1 ? ` <span class="sub">ほか${next.length - 1}件</span>` : ''}` : '<span class="sub">なし</span>';
    const borrowed = mine.filter((l) => l.type === 'borrow' && !l.returned);
    const cells = Array.from({ length: 14 }, (_, k) => {
      const d = addDays(today, k), used = usedOn(i.id, d);
      const cls = used <= 0 ? '' : used >= qty ? 'full' : 'part';
      return `<span class="${cls} ${k === 0 ? 'today' : ''}" style="${cls ? `background:${color}` : ''}" title="${fmtDate(d)}：空き ${Math.max(qty - used, 0)} / ${qty}台"></span>`;
    }).join('');
    return `<article class="pcard">
      <div class="pc-head"><i class="pdot" style="background:${color}"></i><h3>${esc(i.name)}</h3><button class="small ghost edit" data-act="edit-item" data-id="${i.id}" aria-label="${esc(i.name)}を編集">編集</button></div>
      <div>${pill}</div>
      <dl class="pc-rows">
        <dt>貸出中</dt><dd>${nowHtml}</dd>
        <dt>次の予約</dt><dd>${nextHtml}</dd>
        ${borrowed.length ? `<dt>借用中</dt><dd>${borrowed.map((l) => `${esc(l.person)}から ${l.qty}台 〜${fmtDate(l.end)}`).join('<br>')}</dd>` : ''}
        ${i.location ? `<dt>保管場所</dt><dd>${esc(i.location)}</dd>` : ''}
        ${i.note ? `<dt>メモ</dt><dd>${esc(i.note)}</dd>` : ''}
      </dl>
      <div><div class="strip" aria-label="今後14日の貸出状況">${cells}</div>
        <div class="strip-scale"><span>今日 ${fmtDate(today)}</span><span>今後14日の貸出状況</span><span>${fmtDate(addDays(today, 13))}</span></div></div>
      <div class="pc-actions">
        <button class="small primary" data-act="loan-item" data-id="${i.id}">＋ 貸出</button>
        <button class="small" data-act="cal-item" data-id="${i.id}">予定を見る</button>
        <button class="small btn-stock push" data-act="stock-item" data-id="${i.id}">在庫登録</button>
      </div></article>`;
  }).join('');
  $('#inv-empty').hidden = cards.length > 0;
}
$('#inv-search').addEventListener('input', renderInventory);
$('#btn-add-item').addEventListener('click', () => openItemDialog());
$('#inv-cards').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const item = itemById(b.dataset.id); if (!item) return;
  if (b.dataset.act === 'edit-item') openItemDialog(item);
  if (b.dataset.act === 'loan-item') openLoanDialog(null, { itemId: item.id });
  if (b.dataset.act === 'cal-item') { calItem = item.id; showTab('calendar'); }
  if (b.dataset.act === 'stock-item') openStockDialog(item);
  if (b.dataset.act === 'del-item') await deleteItem(item);
});
async function deleteItem(item) {
  {
    const related = state.loans.filter((l) => l.itemId === item.id);
    const ok = await askConfirm('製品を削除', `「${item.name}」を削除しますか？${related.length ? `\n関連する貸出記録 ${related.length} 件も削除されます。` : ''}`);
    if (!ok) return;
    for (const l of related) await deleteDoc('loans', l.id);
    if (await deleteDoc('items', item.id)) { toast(`${item.name} を削除しました`); log('製品削除', `${item.name} を削除${related.length ? `（貸出記録 ${related.length}件も削除）` : ''}`); }
  }
}

/* 在庫登録：保有台数を増減する */
let stockItemId = null;
function reservedMax(itemId) {
  // 今日以降で同時に貸出・予約されている最大台数
  const today = todayISO();
  const ls = state.loans.filter((l) => l.itemId === itemId && isOutgoing(l) && !l.returned && effectiveEnd(l) >= today);
  let max = 0;
  ls.forEach((l) => { for (let d = l.start < today ? today : l.start; d <= effectiveEnd(l); d = addDays(d, 1)) max = Math.max(max, usedOn(itemId, d)); });
  return max;
}
function openStockDialog(item) {
  stockItemId = item.id;
  const out = usedOn(item.id, todayISO());
  $('#stock-title').textContent = `在庫登録：${item.name}`;
  $('#stock-now').innerHTML = `<span>現在の保有 <b>${item.qty}</b>台</span><span>貸出中 <b>${out}</b>台</span><span>今日の在庫 <b>${Number(item.qty) - out}</b>台</span>`;
  $('#f-stock-qty').value = item.qty;
  $('#f-stock-location').value = item.location || '';
  updateStockHint();
  $('#dlg-stock').showModal();
}
function updateStockHint() {
  const item = itemById(stockItemId); if (!item) return;
  const v = Number($('#f-stock-qty').value), need = reservedMax(item.id), diff = v - Number(item.qty);
  const hint = $('#stock-hint'); hint.className = 'hint';
  $('#stock-save').disabled = false;
  if (!Number.isFinite(v) || v < 0 || $('#f-stock-qty').value === '') { hint.textContent = '0以上の台数を入れてください。'; hint.classList.add('ng'); $('#stock-save').disabled = true; return; }
  if (v < need) { hint.textContent = `貸出・予約で同時に ${need}台 使う日があります。${need}台未満にはできません。`; hint.classList.add('ng'); $('#stock-save').disabled = true; return; }
  hint.textContent = diff > 0 ? `${diff}台 追加します（合計 ${v}台）` : diff < 0 ? `${-diff}台 減らします（合計 ${v}台）` : '台数の変更はありません';
  if (diff !== 0) hint.classList.add('ok');
}
$('#stock-minus').addEventListener('click', () => { const f = $('#f-stock-qty'); f.value = Math.max(0, Number(f.value || 0) - 1); updateStockHint(); });
$('#stock-plus').addEventListener('click', () => { const f = $('#f-stock-qty'); f.value = Number(f.value || 0) + 1; updateStockHint(); });
$('#f-stock-qty').addEventListener('input', updateStockHint);
$('#dlg-stock').addEventListener('close', async () => {
  if ($('#dlg-stock').returnValue !== 'save') return;
  const item = itemById(stockItemId); if (!item) return;
  const qty = Number($('#f-stock-qty').value), location = $('#f-stock-location').value.trim();
  if (qty === Number(item.qty) && location === (item.location || '')) return;
  if (await writeDoc('items', { ...item, qty, location })) {
    toast(`${item.name}：保有 ${qty}台で登録しました`);
    const parts = [];
    if (qty !== Number(item.qty)) parts.push(`保有 ${item.qty}台 → ${qty}台`);
    if (location !== (item.location || '')) parts.push(`保管場所「${item.location || 'なし'}」→「${location || 'なし'}」`);
    log('在庫登録', `${item.name}：${parts.join('、')}`);
  }
});

let editingItemId = null;
function openItemDialog(item) {
  editingItemId = item ? item.id : null;
  const f = $('#form-item'); f.reset();
  $('#dlg-item-title').textContent = item ? '製品を編集' : '製品を追加';
  if (item) ['name', 'category', 'location', 'qty', 'note'].forEach((k) => (f.elements[k].value = item[k] ?? ''));
  $('#btn-item-delete').hidden = !item;
  $('#dlg-item').showModal();
}
$('#dlg-item').addEventListener('close', async () => {
  if ($('#dlg-item').returnValue === 'delete') { const it = itemById(editingItemId); if (it) await deleteItem(it); return; }
  if ($('#dlg-item').returnValue !== 'save') return;
  const data = Object.fromEntries(new FormData($('#form-item')));
  data.qty = Number(data.qty);
  const before = editingItemId ? itemById(editingItemId) : null;
  const obj = { ...(before || {}), ...data, id: editingItemId || uid() };
  if (await writeDoc('items', obj)) {
    toast(`${obj.name} を保存しました`);
    log(before ? '製品編集' : '製品追加', before ? `${before.name}${before.name !== obj.name ? ` → ${obj.name}` : ''}（${obj.qty}台）を編集` : `${obj.name}（${obj.qty}台）を追加`);
  }
});

/* ---------- 貸出タブ ---------- */
let loanFilter = 'active';
$('#loan-filters').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  loanFilter = c.dataset.filter;
  $$('#loan-filters .chip').forEach((x) => x.setAttribute('aria-pressed', x === c));
  renderLoans();
});
$('#btn-add-loan').addEventListener('click', () => openLoanDialog(null, $('#loan-item').value ? { itemId: $('#loan-item').value } : {}));
$('#loan-item').addEventListener('change', renderLoans);
$('#loan-staff').addEventListener('change', renderLoans);

function renderLoans() {
  const today = todayISO(), ym = today.slice(0, 7);
  const counts = { active: 0, upcoming: 0, overdue: 0, returned: 0 };
  let monthCount = 0;
  state.loans.forEach((l) => { counts[loanStatus(l)]++; if (l.type === 'rent' && l.start.slice(0, 7) === ym) monthCount++; });
  $('#loan-summary').innerHTML = stat('貸出中', counts.active) + stat('予約', counts.upcoming) + stat('延滞', counts.overdue, counts.overdue > 0) + stat('今月のレンタル件数', monthCount);

  const sel = $('#loan-item'), cur = sel.value;
  const ssel = $('#loan-staff'), curStaff = ssel.value;
  ssel.innerHTML = '<option value="">すべての担当者</option>' + staffNames().map((n) => `<option ${n === curStaff ? 'selected' : ''}>${esc(n)}</option>`).join('');
  sel.innerHTML = '<option value="">すべての製品</option>' + sortedItems().map((i) => `<option value="${i.id}" ${i.id === cur ? 'selected' : ''}>${esc(i.name)}</option>`).join('');
  const order = { overdue: 0, active: 1, upcoming: 2, returned: 3 };
  const rows = state.loans.filter((l) => { const st = loanStatus(l); if (cur && l.itemId !== cur) return false; if (curStaff && l.staff !== curStaff) return false; return loanFilter === 'all' || st === loanFilter || (loanFilter === 'active' && st === 'overdue'); })
    .sort((a, b) => order[loanStatus(a)] - order[loanStatus(b)] || a.end.localeCompare(b.end));
  $('#loan-body').innerHTML = rows.map((l) => {
    const st = loanStatus(l), left = dayDiff(today, l.end);
    const remain = st === 'overdue' ? `<span class="late">${-left}日延滞</span>` : st === 'active' ? (left === 0 ? '本日返却' : `残り${left}日`) : st === 'returned' ? `${fmtDate(l.returned)} 返却済み` : `${dayDiff(today, l.start)}日後に開始`;
    const meta = [`${fmtDate(l.start)}〜${fmtDate(l.end)}`, remain, l.contact ? `連絡先 ${esc(l.contact)}` : '', l.note ? esc(l.note) : ''].filter(Boolean).join('　·　');
    return `<div class="lrow ${st === 'overdue' ? 'is-overdue' : ''}">
      <span class="badge st-${st}">${STATUS_LABEL[st]}</span>
      <div><div class="lsent">${loanSentence(l, true)}</div><div class="lmeta">${meta}</div></div>
      <div class="lacts">${loanButtons(l)}<button class="small danger" data-act="del-loan" data-id="${l.id}">削除</button></div></div>`;
  }).join('');
  $('#loan-count').textContent = `${rows.length}件`;
  lastLoanRows = rows;
  $('#loan-empty').hidden = rows.length > 0;
}
let lastLoanRows = [];
// 「誰が・誰に・何を・何台・いつまで」を1文にする
function loanSentence(l, html) {
  const item = itemById(l.itemId), name = item ? item.name : '(削除済み)';
  const st = loanStatus(l);
  const h = (t, cls = '') => html ? `<b class="${cls}">${esc(t)}</b>` : t;
  const prod = html ? `<span class="prod"><i class="pdot" style="background:${colorOf(l.itemId)}"></i>${esc(name)}</span>` : name;
  const who = l.staff ? `${h(l.staff)} が ` : (html ? '<span class="sub">（担当未設定）</span> ' : '（担当未設定）');
  const until = st === 'upcoming' ? `${fmtDate(l.start)}〜${fmtDate(l.end)}` : `${fmtDate(l.end)}まで`;
  if (l.type === 'borrow') {
    const verb = st === 'returned' ? '借りていました（返却済み）' : st === 'upcoming' ? '借りる予定' : '借りています';
    return `${who}${h(l.person)} から ${prod} を ${h(l.qty + '台')}、${h(until, 'until')} ${verb}`;
  }
  const verb = st === 'returned' ? '貸していました（返却済み）' : st === 'upcoming' ? '貸す予定' : st === 'overdue' ? '貸出中（延滞）' : '貸出中';
  return `${who}${h(l.person)} に ${prod} を ${h(l.qty + '台')}、${h(until, 'until')} ${verb}`;
}
$('#btn-copy-loans').addEventListener('click', () => {
  const text = lastLoanRows.map((l) => `・${loanSentence(l, false)}`).join('\n') || '該当する貸出はありません。';
  const fb = $('#loan-copy-fallback');
  const showFallback = () => { fb.value = text; fb.hidden = false; fb.focus(); fb.select(); toast('自動でコピーできませんでした。表示されたテキストを選択してコピーしてください。'); };
  try { navigator.clipboard.writeText(text).then(() => { fb.hidden = true; toast(`${lastLoanRows.length}件をコピーしました`); }, showFallback); } catch (e) { showFallback(); }
});
const loanButtons = (l) => (!l.returned
  ? `<button class="small primary" data-act="return" data-id="${l.id}">${l.type === 'borrow' ? '返した' : '返却'}</button>`
  : `<button class="small" data-act="unreturn" data-id="${l.id}">返却を取消</button>`) + `<button class="small" data-act="edit-loan" data-id="${l.id}">編集</button>`;

async function handleLoanAction(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const l = state.loans.find((x) => x.id === b.dataset.id); if (!l) return;
  const act = b.dataset.act;
  if (act === 'edit-loan') return openLoanDialog(l);
  if (act === 'return') { if (await writeDoc('loans', { ...l, returned: todayISO() })) { toast('返却済みにしました'); log('返却', loanSentence({ ...l, returned: todayISO() }, false)); } }
  if (act === 'unreturn') { if (await writeDoc('loans', { ...l, returned: null })) { toast('返却を取り消しました'); log('返却取消', loanSentence({ ...l, returned: null }, false)); } }
  if (act === 'del-loan') {
    if (!(await askConfirm('貸出記録を削除', `${l.person} の記録（${fmtDate(l.start)}〜${fmtDate(l.end)}）を削除しますか？`))) return;
    if (await deleteDoc('loans', l.id)) { toast('削除しました'); log('貸出削除', loanSentence(l, false)); }
  }
}
$('#loan-body').addEventListener('click', handleLoanAction);
$('#day-detail').addEventListener('click', (e) => {
  if (e.target.id === 'btn-day-add') return openLoanDialog(null, { start: selectedDay, end: addDays(selectedDay, 2), ...(calItem ? { itemId: calItem } : {}) });
  handleLoanAction(e);
});

let editingLoanId = null;
function openLoanDialog(loan, preset = {}) {
  if (!state.items.length) { toast('先に在庫タブで製品を登録してください。'); return; }
  editingLoanId = loan ? loan.id : null;
  const f = $('#form-loan'); f.reset();
  $('#dlg-loan-title').textContent = loan ? '貸出を編集' : '貸出・予約を登録';
  f.elements.itemId.innerHTML = [...state.items].sort(byName).map((i) => `<option value="${i.id}">${esc(i.name)}（${i.qty}台）</option>`).join('');
  const v = { type: 'rent', qty: 1, start: todayISO(), end: addDays(todayISO(), 2), ...preset, ...(loan || {}) };
  const lastStaff = lsGet(LOCAL_KEY + ':staff') || me || '';
  if (!loan && lastStaff) v.staff = lastStaff;
  const names = staffNames();
  if (v.staff && !names.includes(v.staff)) names.push(v.staff);
  f.elements.staff.innerHTML = '<option value="" disabled selected>選んでください</option>' + names.map((n) => `<option>${esc(n)}</option>`).join('') + '<option value="__new">＋ 新しい担当者を追加</option>';
  $('#new-staff-wrap').hidden = true; $('#f-loan-staff-new').value = ''; $('#f-loan-staff-new').required = false;
  ['type', 'itemId', 'qty', 'staff', 'person', 'contact', 'start', 'end', 'note'].forEach((k) => { if (v[k] != null) f.elements[k].value = v[k]; });
  updateAvailability();
  $('#dlg-loan').showModal();
}
function updateAvailability() {
  const f = $('#form-loan');
  const { itemId, start, end, type } = Object.fromEntries(new FormData(f));
  const qty = Number(f.elements.qty.value);
  const hint = $('#loan-availability'), saveBtn = f.querySelector('button[value=save]');
  hint.className = 'hint'; saveBtn.disabled = false;
  if (!start || !end) { hint.textContent = ''; return; }
  if (end < start) { hint.textContent = '返却予定日は開始日以降にしてください。'; hint.classList.add('ng'); saveBtn.disabled = true; return; }
  const days = dayDiff(start, end) + 1;
  if (type === 'borrow') { hint.textContent = `借用は自分の在庫数に影響しません（${days}日間）。`; return; }
  const avail = availableInRange(itemId, start, end, editingLoanId);
  if (qty > avail) { hint.textContent = `この期間の空きは ${Math.max(avail, 0)} 台です（${days}日間）。数量か期間を見直してください。`; hint.classList.add('ng'); saveBtn.disabled = true; }
  else { hint.textContent = `この期間は ${avail} 台まで貸出できます（${days}日間）。`; hint.classList.add('ok'); }
}
$('#form-loan').addEventListener('input', updateAvailability);
$('#form-loan').addEventListener('change', updateAvailability);
$('#f-loan-staff').addEventListener('change', () => {
  const isNew = $('#f-loan-staff').value === '__new';
  $('#new-staff-wrap').hidden = !isNew; $('#f-loan-staff-new').required = isNew;
  if (isNew) $('#f-loan-staff-new').focus();
});
$('#dlg-loan').addEventListener('close', async () => {
  if ($('#dlg-loan').returnValue !== 'save') return;
  const data = Object.fromEntries(new FormData($('#form-loan')));
  data.qty = Number(data.qty);
  if (data.staff === '__new') {
    data.staff = $('#f-loan-staff-new').value.trim();
    if (data.staff && !state.staff.some((x) => x.name === data.staff)) {
      const order = Math.max(-1, ...state.staff.map((x) => x.order ?? 0)) + 1;
      if (await writeDoc('staff', { id: uid(), name: data.staff, order })) log('担当者追加', `${data.staff} を追加`);
    }
  }
  data.staff = (data.staff || '').trim();
  try { localStorage.setItem(LOCAL_KEY + ':staff', data.staff); } catch (e) {}
  const base = editingLoanId ? state.loans.find((l) => l.id === editingLoanId) : { returned: null };
  const obj = { ...base, ...data, id: editingLoanId || uid() };
  if (await writeDoc('loans', obj)) {
    toast(`${obj.person}：${TYPE_LABEL[obj.type]}を保存しました`);
    log(editingLoanId ? '貸出編集' : '貸出登録', loanSentence(obj, false));
  }
});

/* ---------- カレンダータブ ---------- */
let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let selectedDay = todayISO();
let calItem = '';
$('#cal-prev').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });
$('#cal-today').addEventListener('click', () => { const d = new Date(); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); selectedDay = todayISO(); renderCalendar(); });
$('#cal-weekdays').innerHTML = ['日', '月', '火', '水', '木', '金', '土'].map((w, i) => `<div class="wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('');

function renderCalendar() {
  const today = todayISO();
  $('#cal-title').textContent = `${calMonth.getFullYear()}年 ${calMonth.getMonth() + 1}月`;
  if (calItem && !itemById(calItem)) calItem = '';
  $('#cal-items').innerHTML = `<button class="chip" data-item="" aria-pressed="${!calItem}">すべて</button>` +
    sortedItems().map((i) => `<button class="chip" data-item="${i.id}" aria-pressed="${calItem === i.id}"><i class="pdot" style="background:${colorOf(i.id)}"></i>${esc(i.name)}</button>`).join('');
  const shownLoans = state.loans.filter((l) => !calItem || l.itemId === calItem);
  const first = new Date(calMonth); first.setDate(1 - first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(first); d.setDate(first.getDate() + i);
    const iso = toISO(d);
    const evs = shownLoans.filter((l) => coversDay(l, iso)).sort((a, b) => a.start.localeCompare(b.start));
    const shown = evs.slice(0, 3).map((l) => {
      const st = loanStatus(l), item = itemById(l.itemId), name = item ? item.name : '';
      const mark = l.start === iso ? '▶' : l.end === iso ? '■' : '';
      const bg = st === 'overdue' && iso > l.end ? 'var(--overdue)' : colorOf(l.itemId);
      const label = calItem ? l.person : name;
      return `<div class="ev ${st === 'returned' ? 'returned' : ''}" style="background:${bg}" title="${esc(TYPE_LABEL[l.type])}：${esc(name)} ×${l.qty}（${esc(l.person)}${l.staff ? ` / 担当 ${esc(l.staff)}` : ''}）">${mark}${l.type === 'borrow' ? '借 ' : ''}${esc(label)}</div>`;
    }).join('');
    cells.push(`<button class="day ${d.getMonth() !== calMonth.getMonth() ? 'other' : ''} ${iso === today ? 'today' : ''} ${iso === selectedDay ? 'selected' : ''}" data-day="${iso}" aria-label="${d.getMonth() + 1}月${d.getDate()}日 ${evs.length}件">
      <div class="dnum">${d.getDate()}</div>${shown}${evs.length > 3 ? `<div class="more">+${evs.length - 3}件</div>` : ''}</button>`);
  }
  $('#cal-days').innerHTML = cells.join('');
  renderDayDetail();
}
$('#cal-items').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (!c) return; calItem = c.dataset.item; renderCalendar(); });
$('#cal-days').addEventListener('click', (e) => { const c = e.target.closest('.day'); if (!c) return; selectedDay = c.dataset.day; renderCalendar(); });

function renderDayDetail() {
  const day = selectedDay, [y, m, d] = day.split('-');
  const evs = state.loans.filter((l) => (!calItem || l.itemId === calItem) && coversDay(l, day));
  const starts = evs.filter((l) => l.start === day).length;
  const ends = evs.filter((l) => l.end === day && !l.returned).length;
  const list = evs.map((l) => {
    const st = loanStatus(l), item = itemById(l.itemId);
    const tag = l.start === day ? '開始日' : l.end === day ? '返却期限' : '';
    return `<li><span class="badge ${l.type}">${TYPE_LABEL[l.type]}</span><span class="badge st-${st}">${STATUS_LABEL[st]}</span>
      <i class="pdot" style="background:${colorOf(l.itemId)}"></i><span class="sku">${esc(item ? item.name : '(削除済み)')}</span> ×${l.qty} <span>${esc(l.person)}</span>${staffTag(l)}
      <span class="sub">${fmtDate(l.start)}〜${fmtDate(l.end)} ${tag}</span>${loanButtons(l)}</li>`;
  }).join('');
  const stock = sortedItems().filter((i) => !calItem || i.id === calItem).map((i) => { const a = Number(i.qty) - usedOn(i.id, day); return `<span>${esc(i.name)} <b class="${a <= 0 ? 'zero' : ''}">${a}</b>/${i.qty}</span>`; }).join('');
  $('#day-detail').innerHTML = `
    <h3>${+y}年${+m}月${+d}日 <button class="small primary" id="btn-day-add">＋ この日から貸出</button></h3>
    <div class="sub">開始 ${starts}件 ・ 返却期限 ${ends}件</div>
    ${list ? `<ul>${list}</ul>` : '<p class="sub" style="margin:8px 0 0">この日の貸出はありません。</p>'}
    <div class="stock-line"><span class="sub">この日の在庫：</span>${stock || '<span class="sub">製品なし</span>'}</div>`;
}

/* ---------- 担当者タブ ---------- */
const staffSorted = () => [...state.staff].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.name).localeCompare(String(b.name), 'ja'));
let renamingStaffId = null;
function renderStaff() {
  const today = todayISO(), ym = today.slice(0, 7);
  const open = state.loans.filter((l) => !l.returned);
  const activeStaff = new Set(open.filter((l) => loanStatus(l) !== 'upcoming').map((l) => l.staff).filter(Boolean));
  const unassigned = open.filter((l) => !l.staff).length;
  $('#staff-summary').innerHTML = stat('担当者', state.staff.length) + stat('今貸し出している人', activeStaff.size) + stat('延滞を抱えている人', new Set(open.filter((l) => loanStatus(l) === 'overdue').map((l) => l.staff)).size, open.some((l) => loanStatus(l) === 'overdue')) + stat('担当未設定の貸出', unassigned, unassigned > 0);
  const list = staffSorted();
  $('#staff-cards').innerHTML = list.map((st, idx) => {
    const mine = state.loans.filter((l) => l.staff === st.name);
    const now = mine.filter((l) => ['active', 'overdue'].includes(loanStatus(l))).sort((a, b) => a.end.localeCompare(b.end));
    const up = mine.filter((l) => loanStatus(l) === 'upcoming').sort((a, b) => a.start.localeCompare(b.start));
    const late = now.filter((l) => loanStatus(l) === 'overdue').length;
    const month = mine.filter((l) => l.start.slice(0, 7) === ym).length;
    const units = now.filter(isOutgoing).reduce((s, l) => s + Number(l.qty), 0);
    const line = (l) => {
      const item = itemById(l.itemId), name = item ? item.name : '(削除済み)', left = dayDiff(today, l.end);
      const dir = l.type === 'borrow' ? 'から借用' : 'へ';
      const when = loanStatus(l) === 'upcoming' ? `${fmtDate(l.start)}〜${fmtDate(l.end)}` : loanStatus(l) === 'overdue' ? `${-left}日延滞` : `〜${fmtDate(l.end)}`;
      return `<li class="${loanStatus(l) === 'overdue' ? 'late' : ''}"><i class="pdot" style="background:${colorOf(l.itemId)}"></i><span class="sku">${esc(name)}</span>×${l.qty} <span>${esc(l.person)}${dir}</span> <span class="sub">${when}</span></li>`;
    };
    const head = renamingStaffId === st.id
      ? `<input id="staff-rename-${st.id}" value="${esc(st.name)}" aria-label="新しい名前"><button class="small primary" data-act="staff-rename-save" data-id="${st.id}">保存</button><button class="small ghost" data-act="staff-rename-cancel" data-id="${st.id}">取消</button>`
      : `<h3>${esc(st.name)}</h3><button class="small ghost" data-act="staff-rename" data-id="${st.id}">名前を変更</button>`;
    return `<article class="scard">
      <div class="scard-head">${head}</div>
      <div class="scount"><span>貸出中 <b>${now.length}</b>件（${units}台）</span><span>予約 <b>${up.length}</b>件</span><span class="${late ? 'late' : ''}">延滞 <b>${late}</b>件</span><span>今月 <b>${month}</b>件</span></div>
      ${now.length ? `<ul class="slist">${now.map(line).join('')}</ul>` : '<span class="sub">今貸し出しているものはありません</span>'}
      ${up.length ? `<div class="sub">予約</div><ul class="slist">${up.map(line).join('')}</ul>` : ''}
      <div class="sacts">
        <button class="small" data-act="staff-loans" data-id="${st.id}">貸出一覧を見る</button>
        <button class="small push" data-act="staff-up" data-id="${st.id}" ${idx === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
        <button class="small" data-act="staff-down" data-id="${st.id}" ${idx === list.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>
        <button class="small danger" data-act="staff-del" data-id="${st.id}">削除</button>
      </div></article>`;
  }).join('');
  $('#staff-empty').hidden = list.length > 0;
}
async function addStaff() {
  const name = $('#staff-new').value.trim();
  if (!name) { toast('名前を入力してください'); return; }
  if (state.staff.some((x) => x.name === name)) { toast(`${name} はすでに登録されています`); return; }
  const order = Math.max(-1, ...state.staff.map((x) => x.order ?? 0)) + 1;
  if (await writeDoc('staff', { id: uid(), name, order })) { $('#staff-new').value = ''; toast(`${name} を追加しました`); log('担当者追加', `${name} を追加`); }
}
$('#btn-add-staff').addEventListener('click', addStaff);
$('#staff-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addStaff(); } });
$('#staff-cards').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const st = state.staff.find((x) => x.id === b.dataset.id); if (!st) return;
  const act = b.dataset.act, list = staffSorted(), idx = list.findIndex((x) => x.id === st.id);
  if (act === 'staff-loans') { $('#loan-staff').innerHTML = `<option>${esc(st.name)}</option>`; $('#loan-staff').value = st.name; loanFilter = 'all'; $$('#loan-filters .chip').forEach((x) => x.setAttribute('aria-pressed', x.dataset.filter === 'all')); showTab('loans'); return; }
  if (act === 'staff-rename') { renamingStaffId = st.id; renderStaff(); $(`#staff-rename-${st.id}`)?.focus(); return; }
  if (act === 'staff-rename-cancel') { renamingStaffId = null; renderStaff(); return; }
  if (act === 'staff-rename-save') {
    const name = $(`#staff-rename-${st.id}`).value.trim();
    if (!name || name === st.name) { renamingStaffId = null; renderStaff(); return; }
    if (state.staff.some((x) => x.name === name)) { toast(`${name} はすでに登録されています`); return; }
    const related = state.loans.filter((l) => l.staff === st.name);
    renamingStaffId = null;
    if (await writeDoc('staff', { ...st, name })) {
      for (const l of related) await writeDoc('loans', { ...l, staff: name });
      toast(`${st.name} → ${name} に変更しました`); log('担当者変更', `${st.name} → ${name}（貸出記録 ${related.length}件も変更）`);
    }
    return;
  }
  if (act === 'staff-up' || act === 'staff-down') {
    const other = list[act === 'staff-up' ? idx - 1 : idx + 1]; if (!other) return;
    // 並び順を振り直してから入れ替える
    const ordered = list.map((x, i) => ({ ...x, order: i }));
    const a = ordered[idx], c = ordered[act === 'staff-up' ? idx - 1 : idx + 1];
    [a.order, c.order] = [c.order, a.order];
    for (const x of ordered) { const cur = state.staff.find((y) => y.id === x.id); if (cur.order !== x.order) await writeDoc('staff', x); }
    log('担当者並び替え', `${st.name} を${act === 'staff-up' ? '上' : '下'}へ移動`);
    return;
  }
  if (act === 'staff-del') {
    const openN = state.loans.filter((l) => l.staff === st.name && !l.returned).length;
    const ok = await askConfirm('担当者を削除', `${st.name} を担当者リストから削除しますか？${openN ? `\n返却されていない貸出が ${openN}件あります。記録の担当者名はそのまま残ります。` : '\n過去の貸出記録の担当者名はそのまま残ります。'}`);
    if (!ok) return;
    if (await deleteDoc('staff', st.id)) { toast(`${st.name} を削除しました`); log('担当者削除', `${st.name} を削除`); }
  }
});

/* ---------- 描画・起動 ---------- */
function render() {
  if (currentTab === 'inventory') renderInventory();
  if (currentTab === 'loans') renderLoans();
  if (currentTab === 'calendar') renderCalendar();
  if (currentTab === 'staff') renderStaff();
}
let savedTab = 'inventory';
try { savedTab = localStorage.getItem(LOCAL_KEY + ':tab') || 'inventory'; } catch (e) {}
showTab(['inventory', 'loans', 'calendar', 'staff'].includes(savedTab) ? savedTab : 'inventory');
start();

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
