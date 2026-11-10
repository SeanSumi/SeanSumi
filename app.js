'use strict';

/* ========== データ層 ========== */
const STORE_KEY = 'inventory-rental-app-v1';
const TYPE_LABEL = { rent: 'レンタル', lend: '貸出', borrow: '借用' };
const STATUS_LABEL = { active: '貸出中', upcoming: '予約', overdue: '延滞', returned: '返却済' };

const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => toISO(new Date());
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return toISO(d); };
const fmtDate = (iso) => { const [, m, d] = iso.split('-'); return `${+m}/${+d}`; };
const yen = (n) => (n || n === 0) && n !== '' ? '¥' + Number(n).toLocaleString('ja-JP') : '';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* 読み込めない場合はサンプルで開始 */ }
  return sampleData();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 保存不可の環境 */ }
}

function sampleData() {
  const t = todayISO();
  const items = [
    { id: uid(), name: 'ミラーレスカメラ', category: 'カメラ', location: '棚A-1', qty: 3, rate: 3000, note: '' },
    { id: uid(), name: '三脚', category: 'カメラ', location: '棚A-2', qty: 5, rate: 500, note: '' },
    { id: uid(), name: 'プロジェクター', category: '映像機器', location: '棚B-1', qty: 2, rate: 4000, note: 'HDMIケーブル付属' },
    { id: uid(), name: 'テント（4人用）', category: 'アウトドア', location: '倉庫', qty: 4, rate: 2500, note: '' },
    { id: uid(), name: '電動ドリル', category: '工具', location: '工具箱', qty: 2, rate: 800, note: '' },
  ];
  const [cam, tri, proj, tent, drill] = items.map((i) => i.id);
  const loans = [
    { id: uid(), type: 'rent', itemId: cam, qty: 1, person: '佐藤さん', contact: '', start: addDays(t, -3), end: addDays(t, 2), price: 15000, note: '', returned: null },
    { id: uid(), type: 'rent', itemId: proj, qty: 1, person: '株式会社ABC', contact: '', start: addDays(t, -6), end: addDays(t, -1), price: 20000, note: '', returned: null },
    { id: uid(), type: 'lend', itemId: tri, qty: 2, person: '田中さん', contact: '', start: addDays(t, 0), end: addDays(t, 4), price: '', note: '', returned: null },
    { id: uid(), type: 'rent', itemId: tent, qty: 3, person: 'キャンプサークル', contact: '', start: addDays(t, 5), end: addDays(t, 8), price: 22500, note: '週末利用', returned: null },
    { id: uid(), type: 'borrow', itemId: drill, qty: 1, person: '鈴木さん', contact: '', start: addDays(t, -2), end: addDays(t, 6), price: '', note: '借りている物', returned: null },
    { id: uid(), type: 'rent', itemId: cam, qty: 2, person: '山本さん', contact: '', start: addDays(t, -12), end: addDays(t, -9), price: 18000, note: '', returned: addDays(t, -9) },
  ];
  return { items, loans };
}

/* ========== 計算 ========== */
const itemById = (id) => state.items.find((i) => i.id === id);

function loanStatus(l, today = todayISO()) {
  if (l.returned) return 'returned';
  if (l.start > today) return 'upcoming';
  if (l.end < today) return 'overdue';
  return 'active';
}
// 未返却の延滞は今日まで占有しているとみなす
function effectiveEnd(l, today = todayISO()) {
  if (l.returned) return l.returned < l.end ? l.returned : l.end;
  return l.end < today ? today : l.end;
}
const coversDay = (l, day) => l.start <= day && day <= effectiveEnd(l);
// 借用（他から借りた物）は自分の在庫を減らさない
const isOutgoing = (l) => l.type !== 'borrow';

function usedOn(itemId, day, excludeId) {
  return state.loans
    .filter((l) => l.itemId === itemId && l.id !== excludeId && isOutgoing(l) && !l.returned && coversDay(l, day))
    .reduce((s, l) => s + Number(l.qty), 0);
}
function availableInRange(itemId, start, end, excludeId) {
  const item = itemById(itemId);
  if (!item) return 0;
  let maxUsed = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    maxUsed = Math.max(maxUsed, usedOn(itemId, d, excludeId));
  }
  return Number(item.qty) - maxUsed;
}

/* ========== タブ ========== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

$$('.tab').forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));
function showTab(name) {
  $$('.tab').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  try { localStorage.setItem(STORE_KEY + ':tab', name); } catch (e) {}
  render();
}

/* ========== 在庫タブ ========== */
function renderInventory() {
  const today = todayISO();
  const q = $('#inv-search').value.trim().toLowerCase();
  const cat = $('#inv-category').value;

  const cats = [...new Set(state.items.map((i) => i.category).filter(Boolean))].sort();
  const catSel = $('#inv-category');
  catSel.innerHTML = '<option value="">すべてのカテゴリ</option>' + cats.map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('#category-list').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');

  const rows = state.items.filter((i) =>
    (!cat || i.category === cat) &&
    (!q || [i.name, i.category, i.location, i.note].join(' ').toLowerCase().includes(q)));

  let totalQty = 0, totalOut = 0, soldOut = 0;
  state.items.forEach((i) => {
    const out = usedOn(i.id, today);
    totalQty += Number(i.qty); totalOut += out;
    if (Number(i.qty) - out <= 0) soldOut++;
  });
  $('#inv-summary').innerHTML = stat('品目数', state.items.length) + stat('総在庫数', totalQty) +
    stat('貸出中', totalOut) + stat('在庫切れ品目', soldOut, soldOut > 0);

  $('#inv-body').innerHTML = rows.map((i) => {
    const out = usedOn(i.id, today);
    const avail = Number(i.qty) - out;
    const next = state.loans
      .filter((l) => l.itemId === i.id && isOutgoing(l) && loanStatus(l) === 'upcoming')
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    return `<tr>
      <td><strong>${esc(i.name)}</strong>${i.note ? `<div class="sub">${esc(i.note)}</div>` : ''}
        ${next ? `<div class="sub">次の予約：${fmtDate(next.start)}〜 ${next.qty}点</div>` : ''}</td>
      <td>${esc(i.category)}</td>
      <td>${esc(i.location)}</td>
      <td class="num">${i.qty}</td>
      <td class="num">${out}</td>
      <td class="num ${avail <= 0 ? 'zero' : ''}">${avail}</td>
      <td class="actions-cell">
        <button class="small" data-act="loan-item" data-id="${i.id}">貸出</button>
        <button class="small" data-act="edit-item" data-id="${i.id}">編集</button>
        <button class="small danger" data-act="del-item" data-id="${i.id}">削除</button>
      </td></tr>`;
  }).join('');
  $('#inv-empty').hidden = rows.length > 0;
}
const stat = (label, value, warn) => `<div class="stat ${warn ? 'warn' : ''}"><div class="label">${label}</div><div class="value">${value}</div></div>`;

$('#inv-search').addEventListener('input', renderInventory);
$('#inv-category').addEventListener('change', renderInventory);
$('#btn-add-item').addEventListener('click', () => openItemDialog());

$('#inv-body').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.act === 'edit-item') openItemDialog(itemById(id));
  if (b.dataset.act === 'loan-item') openLoanDialog(null, { itemId: id });
  if (b.dataset.act === 'del-item') {
    const n = state.loans.filter((l) => l.itemId === id).length;
    if (confirm(`「${itemById(id).name}」を削除しますか？${n ? `\n関連する貸出記録 ${n} 件も削除されます。` : ''}`)) {
      state.items = state.items.filter((i) => i.id !== id);
      state.loans = state.loans.filter((l) => l.itemId !== id);
      save(); render();
    }
  }
});

let editingItemId = null;
function openItemDialog(item) {
  editingItemId = item ? item.id : null;
  const f = $('#form-item');
  f.reset();
  $('#dlg-item-title').textContent = item ? '品目を編集' : '品目を追加';
  if (item) ['name', 'category', 'location', 'qty', 'rate', 'note'].forEach((k) => (f.elements[k].value = item[k] ?? ''));
  $('#dlg-item').showModal();
}
$('#dlg-item').addEventListener('close', () => {
  if ($('#dlg-item').returnValue !== 'save') return;
  const f = $('#form-item');
  const data = Object.fromEntries(new FormData(f));
  data.qty = Number(data.qty);
  data.rate = data.rate === '' ? '' : Number(data.rate);
  if (editingItemId) Object.assign(itemById(editingItemId), data);
  else state.items.push({ id: uid(), ...data });
  save(); render();
});

/* ========== 貸出タブ ========== */
let loanFilter = 'active';
$('#loan-filters').addEventListener('click', (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  loanFilter = c.dataset.filter;
  $$('#loan-filters .chip').forEach((x) => x.classList.toggle('active', x === c));
  renderLoans();
});
$('#btn-add-loan').addEventListener('click', () => openLoanDialog());

function renderLoans() {
  const counts = { active: 0, upcoming: 0, overdue: 0, returned: 0 };
  let monthSales = 0;
  const ym = todayISO().slice(0, 7);
  state.loans.forEach((l) => {
    counts[loanStatus(l)]++;
    if (l.type === 'rent' && l.price && l.start.slice(0, 7) === ym) monthSales += Number(l.price);
  });
  $('#loan-summary').innerHTML = stat('貸出中', counts.active) + stat('予約', counts.upcoming) +
    stat('延滞', counts.overdue, counts.overdue > 0) + stat('今月のレンタル売上', yen(monthSales) || '¥0');

  const order = { overdue: 0, active: 1, upcoming: 2, returned: 3 };
  const rows = state.loans
    .filter((l) => loanFilter === 'all' || loanStatus(l) === loanFilter ||
      (loanFilter === 'active' && loanStatus(l) === 'overdue'))
    .sort((a, b) => order[loanStatus(a)] - order[loanStatus(b)] || a.end.localeCompare(b.end));

  const today = todayISO();
  $('#loan-body').innerHTML = rows.map((l) => {
    const st = loanStatus(l);
    const item = itemById(l.itemId);
    const daysLeft = Math.round((new Date(l.end) - new Date(today)) / 86400000);
    const remain = st === 'overdue' ? `${-daysLeft}日超過` : st === 'active' ? (daysLeft === 0 ? '本日返却' : `残り${daysLeft}日`) : st === 'returned' ? `${fmtDate(l.returned)} 返却` : '';
    return `<tr>
      <td><span class="badge st-${st}">${STATUS_LABEL[st]}</span></td>
      <td><span class="badge ${l.type}">${TYPE_LABEL[l.type]}</span></td>
      <td>${esc(item ? item.name : '(削除済み)')}</td>
      <td class="num">${l.qty}</td>
      <td>${esc(l.person)}${l.contact ? `<div class="sub">${esc(l.contact)}</div>` : ''}</td>
      <td>${fmtDate(l.start)} 〜 ${fmtDate(l.end)}<div class="sub">${remain}</div></td>
      <td class="num">${yen(l.price)}</td>
      <td class="actions-cell">
        ${!l.returned ? `<button class="small primary" data-act="return" data-id="${l.id}">${l.type === 'borrow' ? '返した' : '返却'}</button>` :
          `<button class="small" data-act="unreturn" data-id="${l.id}">取消</button>`}
        <button class="small" data-act="edit-loan" data-id="${l.id}">編集</button>
        <button class="small danger" data-act="del-loan" data-id="${l.id}">削除</button>
      </td></tr>`;
  }).join('');
  $('#loan-empty').hidden = rows.length > 0;
}

function handleLoanAction(e) {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const l = state.loans.find((x) => x.id === b.dataset.id); if (!l) return;
  if (b.dataset.act === 'return') l.returned = todayISO();
  if (b.dataset.act === 'unreturn') l.returned = null;
  if (b.dataset.act === 'edit-loan') return openLoanDialog(l);
  if (b.dataset.act === 'del-loan') {
    if (!confirm('この貸出記録を削除しますか？')) return;
    state.loans = state.loans.filter((x) => x.id !== l.id);
  }
  save(); render();
}
$('#loan-body').addEventListener('click', handleLoanAction);
$('#day-detail').addEventListener('click', handleLoanAction);

let editingLoanId = null;
function openLoanDialog(loan, preset = {}) {
  if (!state.items.length) { alert('先に在庫タブで品目を登録してください。'); return; }
  editingLoanId = loan ? loan.id : null;
  const f = $('#form-loan');
  f.reset();
  $('#dlg-loan-title').textContent = loan ? '貸出を編集' : '貸出・予約を登録';
  f.elements.itemId.innerHTML = state.items.map((i) => `<option value="${i.id}">${esc(i.name)}（総数${i.qty}）</option>`).join('');
  const v = { type: 'rent', qty: 1, start: todayISO(), end: addDays(todayISO(), 2), ...preset, ...(loan || {}) };
  ['type', 'itemId', 'qty', 'person', 'contact', 'start', 'end', 'price', 'note'].forEach((k) => { if (v[k] !== undefined && v[k] !== null) f.elements[k].value = v[k]; });
  updateAvailability(!loan);
  $('#dlg-loan').showModal();
}

let priceTouched = false;
function updateAvailability(autoPrice) {
  const f = $('#form-loan');
  const { itemId, start, end, type } = Object.fromEntries(new FormData(f));
  const qty = Number(f.elements.qty.value);
  const hint = $('#loan-availability');
  const saveBtn = f.querySelector('button[value=save]');
  hint.className = 'hint'; saveBtn.disabled = false;
  if (!start || !end) { hint.textContent = ''; return; }
  if (end < start) { hint.textContent = '返却予定日は開始日以降にしてください。'; hint.classList.add('ng'); saveBtn.disabled = true; return; }
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  if (type === 'borrow') { hint.textContent = `借用は自分の在庫数に影響しません（${days}日間）。`; return; }
  const avail = availableInRange(itemId, start, end, editingLoanId);
  if (qty > avail) {
    hint.textContent = `⚠ この期間の空きは ${Math.max(avail, 0)} 点です（${days}日間）。数量か期間を見直してください。`;
    hint.classList.add('ng'); saveBtn.disabled = true;
  } else {
    hint.textContent = `✓ この期間は ${avail} 点まで貸出できます（${days}日間）。`;
    hint.classList.add('ok');
  }
  const item = itemById(itemId);
  if (autoPrice && !priceTouched && type === 'rent' && item && item.rate) f.elements.price.value = item.rate * qty * days;
  if (type !== 'rent' && !priceTouched) f.elements.price.value = '';
}
$('#form-loan').addEventListener('input', (e) => {
  if (e.target.name === 'price') { priceTouched = true; return; }
  updateAvailability(true);
});
$('#form-loan').addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') updateAvailability(true); });
$('#dlg-loan').addEventListener('close', () => {
  priceTouched = false;
  if ($('#dlg-loan').returnValue !== 'save') return;
  const data = Object.fromEntries(new FormData($('#form-loan')));
  data.qty = Number(data.qty);
  data.price = data.price === '' ? '' : Number(data.price);
  if (editingLoanId) Object.assign(state.loans.find((l) => l.id === editingLoanId), data);
  else state.loans.push({ id: uid(), returned: null, ...data });
  save(); render();
});

/* ========== カレンダータブ ========== */
let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
let selectedDay = todayISO();
$('#cal-prev').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });
$('#cal-today').addEventListener('click', () => { const d = new Date(); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); selectedDay = todayISO(); renderCalendar(); });
$('#cal-weekdays').innerHTML = ['日', '月', '火', '水', '木', '金', '土'].map((w) => `<div>${w}</div>`).join('');

function renderCalendar() {
  const today = todayISO();
  $('#cal-title').textContent = `${calMonth.getFullYear()}年 ${calMonth.getMonth() + 1}月`;
  const first = new Date(calMonth);
  first.setDate(1 - first.getDay());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(first); d.setDate(first.getDate() + i);
    const iso = toISO(d);
    const evs = state.loans.filter((l) => coversDay(l, iso))
      .sort((a, b) => a.start.localeCompare(b.start));
    const shown = evs.slice(0, 3).map((l) => {
      const st = loanStatus(l);
      const item = itemById(l.itemId);
      const mark = l.start === iso ? '▶' : (l.end === iso ? '■' : '');
      const cls = st === 'overdue' && iso > l.end ? 'overdue' : l.type;
      return `<div class="ev ${cls} ${st === 'returned' ? 'returned' : ''}" title="${esc(TYPE_LABEL[l.type])}：${esc(item ? item.name : '')} ×${l.qty}（${esc(l.person)}）">${mark}${esc(item ? item.name : '')}</div>`;
    }).join('');
    cells.push(`<div class="day ${d.getMonth() !== calMonth.getMonth() ? 'other' : ''} ${iso === today ? 'today' : ''} ${iso === selectedDay ? 'selected' : ''}" data-day="${iso}">
      <div class="dnum">${d.getDate()}</div>${shown}${evs.length > 3 ? `<div class="more">+${evs.length - 3}件</div>` : ''}</div>`);
  }
  $('#cal-days').innerHTML = cells.join('');
  renderDayDetail();
}
$('#cal-days').addEventListener('click', (e) => {
  const c = e.target.closest('.day'); if (!c) return;
  selectedDay = c.dataset.day;
  renderCalendar();
});

function renderDayDetail() {
  const day = selectedDay;
  const [y, m, d] = day.split('-');
  const evs = state.loans.filter((l) => coversDay(l, day));
  const starts = evs.filter((l) => l.start === day);
  const ends = state.loans.filter((l) => l.end === day && !l.returned);
  const list = evs.map((l) => {
    const st = loanStatus(l);
    const item = itemById(l.itemId);
    const tag = l.start === day ? '開始' : l.end === day ? '返却期限' : '';
    return `<li><span class="badge ${l.type}">${TYPE_LABEL[l.type]}</span>
      <span class="badge st-${st}">${STATUS_LABEL[st]}</span>
      <strong>${esc(item ? item.name : '(削除済み)')}</strong> ×${l.qty}
      <span>${esc(l.person)}</span>
      <span class="sub">${fmtDate(l.start)}〜${fmtDate(l.end)} ${tag}</span>
      ${!l.returned ? `<button class="small primary" data-act="return" data-id="${l.id}">${l.type === 'borrow' ? '返した' : '返却'}</button>` : ''}
      <button class="small" data-act="edit-loan" data-id="${l.id}">編集</button></li>`;
  }).join('');
  const availList = state.items.map((i) => `${esc(i.name)} <strong>${Number(i.qty) - usedOn(i.id, day)}</strong>/${i.qty}`).join('　');
  $('#day-detail').innerHTML = `
    <h3>${+y}年${+m}月${+d}日　<button class="small primary" id="btn-day-add">＋ この日から貸出</button></h3>
    <p class="sub">開始 ${starts.length}件 ・ 返却期限 ${ends.length}件</p>
    ${list ? `<ul>${list}</ul>` : '<p class="sub">この日の貸出はありません。</p>'}
    <p class="sub" style="margin-top:10px">この日の在庫：${availList || 'なし'}</p>`;
  $('#btn-day-add').addEventListener('click', () => openLoanDialog(null, { start: day, end: addDays(day, 2) }));
}

/* ========== 描画 ========== */
function render() {
  const tab = $('.tab.active').dataset.tab;
  if (tab === 'inventory') renderInventory();
  if (tab === 'loans') renderLoans();
  if (tab === 'calendar') renderCalendar();
}

let savedTab = 'inventory';
try { savedTab = localStorage.getItem(STORE_KEY + ':tab') || 'inventory'; } catch (e) {}
save();
showTab(['inventory', 'loans', 'calendar'].includes(savedTab) ? savedTab : 'inventory');
