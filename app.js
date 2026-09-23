/* 亚马逊每日竞品记录工具 · GitHub Pages 静态版 */
'use strict';

/* ===== 需要你改的两个地方 ===== */
const ACCESS_CODE_SHA256 = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'; // 默认口令 admin123，改口令见 README
const REPO_URL = 'https://github.com/你的用户名/你的仓库名';   // 改成你的仓库地址
/* ============================== */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let products = [], historyData = {}, summary = {};
let curShop = 'all', curStatus = 'all', histRange = 30;
let expanded = new Set(), prodExpanded = new Set(), histExpanded = new Set();
let todayKey = null, dates = [];

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function checkGate() {
  if (sessionStorage.getItem('tracker_ok') === '1') return true;
  $('loginMask').classList.remove('hidden');
  return false;
}
$('btnLogin').onclick = async () => {
  const h = await sha256($('loginPwd').value);
  if (h === ACCESS_CODE_SHA256) { sessionStorage.setItem('tracker_ok', '1'); $('loginMask').classList.add('hidden'); boot(); }
  else $('loginErr').textContent = '口令错误';
};
$('loginPwd').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnLogin').click(); });

async function boot() {
  $('btnActions').href = REPO_URL + '/actions';
  try {
    const [p, h, s] = await Promise.all([
      fetch('./data/products.json?_=' + Date.now()).then(r => r.json()),
      fetch('./data/history.json?_=' + Date.now()).then(r => r.json()),
      fetch('./data/summary.json?_=' + Date.now()).then(r => r.json()).catch(() => ({}))
    ]);
    products = Array.isArray(p) ? p : (p.products || []);
    historyData = h && typeof h === 'object' && !Array.isArray(h) ? h : {};
    summary = s || {};
  } catch (e) {
    $('todayTable').innerHTML = '<div style="padding:40px;text-align:center">数据加载失败：请确认已通过 GitHub Pages 打开，且 data/ 目录已上传。</div>';
    return;
  }
  dates = Object.keys(historyData).sort();
  todayKey = dates.length ? dates[dates.length - 1] : new Date().toISOString().slice(0, 10);
  $('emptyTip').classList.toggle('hidden', dates.length > 0);
  renderAll();
}

/* ---------- 渲染工具 ---------- */
const todayData = () => historyData[todayKey] || {};
const fmtPrice = r => r.price != null
  ? `$${r.price.toFixed(2)}${r.priceOutOfRange ? ' <span class="badge badge-fail" title="' + esc(r.priceNote || '超出预期区间') + '">价格异常</span>' : ''}`
  : '<span class="stock-unknown">—</span>';
const fmtRating = r => r.rating != null ? `<span class="rating">★${r.rating}</span>` : '—';
const fmtReviews = r => r.reviews != null ? `<span class="reviews">${r.reviews}</span>` : '—';
const fmtBsrS = r => r.bsrSmall ? `<span class="bsr-small">#${r.bsrSmall.rank.toLocaleString()}</span> <span class="pmeta">${esc(r.bsrSmall.label)}</span>` : '<span class="stock-unknown">未获取</span>';
const fmtBsrL = r => r.bsrLarge ? `<span class="bsr-large">#${r.bsrLarge.rank.toLocaleString()} ${esc(r.bsrLarge.label)}</span>` : '—';
function fmtStock(r) {
  const s = r.stock || { kind: 'unknown' };
  const manual = s.source === 'manual' ? ' <span class="badge badge-manual">手工</span>' : '';
  switch (s.kind) {
    case 'stock': return s.source === 'amazon_page'
      ? `<span class="stock-qty">仅剩 ${s.qty} 件</span> <span class="pmeta">（页面提示）</span>`
      : `<span class="stock-qty">库存 ${s.qty}</span>${manual}`;
    case 'purchase_limit': return `<span class="stock-limit">限购 ${s.qty}</span>${manual}`;
    case 'in_stock_no_qty': return `<span class="stock-noqty">有货，数量未显示</span>${manual}`;
    case 'unavailable': return '<span class="stock-na">不可购买 / 缺货</span>';
    default: return '<span class="stock-unknown">库存未获取</span>';
  }
}
const fmtStatus = r => !r ? '<span class="badge badge-none">未采集</span>'
  : r.captcha ? '<span class="badge badge-fail">验证码</span>'
  : r.ok ? '<span class="badge badge-ok">正常</span>'
  : `<span class="badge badge-fail">${esc(r.error || '异常')}</span>`;

function productCell(p) {
  const rec = todayData()[p.asin] || {};
  const img = rec.image || p.image;
  const imgHtml = img ? `<img class="pimg" src="${esc(img)}" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=\\'pimg-ph\\'>无图</div>'">` : '<div class="pimg-ph">无图</div>';
  return `<div class="pcell">${imgHtml}<div><div class="pname">${esc(p.name || p.asin)}</div><div class="pmeta"><a class="asin-link mono" href="https://www.amazon.com/dp/${esc(p.asin)}" target="_blank" rel="noopener">${esc(p.asin)}</a> · <span class="shop-chip">${esc(p.shop || '未分店铺')}</span></div></div></div>`;
}

const owns = () => products.filter(p => p.type === 'own');
const kids = id => products.filter(p => p.type === 'compete' && p.parentId === id);

function visibleRows() {
  const rows = [], seen = new Set();
  for (const o of owns()) {
    if (curShop !== 'all' && (o.shop || '默认店铺') !== curShop && !kids(o.id).some(c => (c.shop || '默认店铺') === curShop)) continue;
    rows.push([o, true]); seen.add(o.id);
    if (expanded.has(o.id)) for (const c of kids(o.id)) { rows.push([c, false]); seen.add(c.id); }
  }
  for (const p of products) if (p.type === 'compete' && !seen.has(p.id) && !owns().some(o => o.id === p.parentId)) {
    if (curShop === 'all' || (p.shop || '默认店铺') === curShop) rows.push([p, false]);
  }
  return rows;
}
const statusMatch = r => curStatus === 'all' || (curStatus === 'ok' && r && r.ok) || (curStatus === 'fail' && r && !r.ok) || (curStatus === 'none' && !r);

function renderAll() { renderStats(); renderShopTabs(); renderToday(); renderChanges(); renderHistory(); renderProducts(); renderFoot(); }

function renderStats() {
  const td = todayData();
  const collected = products.filter(p => td[p.asin]).length;
  const ok = products.filter(p => td[p.asin] && td[p.asin].ok).length;
  $('stTotal').textContent = products.length;
  $('stCollected').textContent = `${collected}/${products.length}`;
  $('stOk').textContent = ok;
  $('stFail').textContent = collected - ok;
  $('stFail').classList.toggle('warn', collected - ok > 0);
  $('runInfo').textContent = '数据日期：' + todayKey;
}

function renderShopTabs() {
  const shops = [...new Set(products.map(p => p.shop || '默认店铺'))];
  $('shopTabs').innerHTML = `<span class="shop-tab ${curShop === 'all' ? 'active' : ''}" data-shop="all">全部</span>` +
    shops.map(s => `<span class="shop-tab ${curShop === s ? 'active' : ''}" data-shop="${esc(s)}">${esc(s)}</span>`).join('');
  $('shopTabs').querySelectorAll('.shop-tab').forEach(t => t.onclick = () => { curShop = t.dataset.shop; renderShopTabs(); renderToday(); });
}

function prevRecord(asin) {
  const idx = dates.indexOf(todayKey);
  for (let i = idx - 1; i >= 0; i--) if (historyData[dates[i]] && historyData[dates[i]][asin] && historyData[dates[i]][asin].ok) return historyData[dates[i]][asin];
  return null;
}
function deltaHtml(cur, prev, fmt, invert) {
  if (cur == null) return '';
  if (!prev || prev == null) return '';
  const d = cur - prev;
  if (d === 0) return '';
  const good = invert ? d < 0 : d > 0;
  const color = good ? 'var(--red)' : 'var(--green-ok)';
  return ` <span style="font-size:11px;color:${color}">${d > 0 ? '↑' : '↓'}${Math.abs(d).toLocaleString()}</span>`;
}

function renderToday() {
  const td = todayData();
  const rows = visibleRows().filter(([p]) => statusMatch(td[p.asin]));
  let html = `<table><thead><tr>
    <th style="min-width:270px">商品</th><th>采集售价</th><th>星级</th><th>评论数</th><th>小类 BSR</th><th>大类 BSR</th><th>库存 / 限购</th><th>状态</th><th>采集时间</th>
  </tr></thead><tbody>`;
  for (const [p, isOwn] of rows) {
    const rec = td[p.asin];
    const prev = rec ? prevRecord(p.asin) : null;
    const hasKids = isOwn && kids(p.id).length > 0;
    const caret = hasKids ? `<span class="caret" data-toggle="${p.id}">${expanded.has(p.id) ? '▾' : '▸'}</span>` : '<span class="caret"></span>';
    const time = rec && rec.fetchedAt ? new Date(rec.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
    html += `<tr class="${isOwn ? 'group-own' : 'row-compete'}">
      <td>${caret}${productCell(p)}</td>
      <td class="num-cell">${fmtPrice(rec || {})}${rec && prev ? deltaHtml(rec.price, prev.price) : ''}</td>
      <td class="num-cell">${fmtRating(rec || {})}</td>
      <td class="num-cell">${fmtReviews(rec || {})}${rec && prev ? deltaHtml(rec.reviews, prev.reviews) : ''}</td>
      <td class="num-cell">${fmtBsrS(rec || {})}${rec && prev && rec.bsrSmall && prev.bsrSmall ? deltaHtml(rec.bsrSmall.rank, prev.bsrSmall.rank, null, true) : ''}</td>
      <td class="num-cell">${fmtBsrL(rec || {})}</td>
      <td class="num-cell">${fmtStock(rec || {})}</td>
      <td>${fmtStatus(rec)}</td>
      <td class="pmeta">${time}</td>
    </tr>`;
  }
  if (!rows.length) html += '<tr><td colspan="9" style="text-align:center;color:#98a8a4;padding:30px">暂无数据，请先在 GitHub 仓库手动触发一次采集</td></tr>';
  html += '</tbody></table>';
  $('todayTable').innerHTML = html;
  $('todayTable').querySelectorAll('[data-toggle]').forEach(el => el.onclick = () => {
    const id = el.dataset.toggle; expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderToday();
  });
}

function renderChanges() {
  const td = todayData();
  const changes = [];
  for (const p of products) {
    const r = td[p.asin], prev = prevRecord(p.asin);
    if (!r || !prev) continue;
    const items = [];
    if (r.price != null && prev.price != null && Math.abs(r.price - prev.price) > 0.001) items.push(`售价 $${prev.price} → $${r.price}`);
    if (r.reviews != null && prev.reviews != null && r.reviews !== prev.reviews) items.push(`评论 ${prev.reviews} → ${r.reviews}`);
    if (r.bsrSmall && prev.bsrSmall && r.bsrSmall.rank !== prev.bsrSmall.rank) items.push(`小类BSR #${prev.bsrSmall.rank} → #${r.bsrSmall.rank}`);
    if (items.length) changes.push(`<b>${esc(p.name || p.asin)}</b>：${items.join('；')}`);
  }
  $('changesBox').innerHTML = changes.length
    ? '<b>较上一次成功采集的变化：</b><br>' + changes.join('<br>')
    : (Object.keys(td).length ? '较上一次成功采集：本次没有检测到价格 / 评论数 / BSR 变化。' : '');
}

function metricBlock(r) {
  if (!r) return '<div class="hist-empty">— 无记录 —</div>';
  return `<div class="hist-block">
    <div class="metric-name">售价</div><div class="num-cell">${fmtPrice(r)}</div>
    <div class="metric-name">星级</div><div class="num-cell">${fmtRating(r)} <span class="reviews">(${r.reviews ?? '—'})</span></div>
    <div class="metric-name">小类BSR</div><div class="num-cell">${r.bsrSmall ? '#' + r.bsrSmall.rank.toLocaleString() : '<span class="stock-unknown">—</span>'}</div>
    <div class="metric-name">库存</div><div class="num-cell">${fmtStock(r)}</div>
  </div>`;
}

function renderHistory() {
  let ds = dates.slice(-histRange);
  const tomorrow = new Date((ds.length ? ds[ds.length - 1] : todayKey) + 'T00:00:00Z');
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tKey = tomorrow.toISOString().slice(0, 10);
  ds = ds.concat([tKey]);
  const rows = [];
  const seen = new Set();
  for (const o of owns()) {
    rows.push([o, true]); seen.add(o.id);
    if (histExpanded.has(o.id)) for (const c of kids(o.id)) { rows.push([c, false]); seen.add(c.id); }
  }
  for (const p of products) if (p.type === 'compete' && !seen.has(p.id) && !owns().some(o => o.id === p.parentId)) rows.push([p, false]);
  let html = '<table class="hist-table"><thead><tr><th class="fixed-col">商品信息 / 指标</th>';
  for (const d of ds) html += `<th class="date-col">${d.slice(5).replace('-', '月')}日${d === tKey ? '（预）' : ''}</th>`;
  html += '</tr></thead><tbody>';
  for (const [p, isOwn] of rows) {
    const caret = isOwn ? `<span class="caret" data-htoggle="${p.id}">${histExpanded.has(p.id) ? '▾' : '▸'}</span>` : '<span class="caret"></span>';
    html += `<tr class="${isOwn ? 'group-own' : 'row-compete'}"><td class="fixed-col">${caret}${productCell(p)}</td>`;
    for (const d of ds) html += `<td class="date-col">${metricBlock((historyData[d] || {})[p.asin])}</td>`;
    html += '</tr>';
  }
  html += '</tbody></table>';
  $('historyTable').innerHTML = html;
  $('historyTable').querySelectorAll('[data-htoggle]').forEach(el => el.onclick = () => {
    const id = el.dataset.htoggle; histExpanded.has(id) ? histExpanded.delete(id) : histExpanded.add(id); renderHistory();
  });
}

function renderProducts() {
  let html = `<table><thead><tr><th style="min-width:260px">商品</th><th>ASIN</th><th>店铺</th><th>类型</th><th>关联自有</th></tr></thead><tbody>`;
  for (const p of products) {
    const parent = products.find(x => x.id === p.parentId);
    html += `<tr><td>${productCell(p)}</td><td class="mono">${esc(p.asin)}</td><td>${esc(p.shop || '')}</td>
      <td>${p.type === 'own' ? '<span class="badge badge-ok">自有</span>' : '<span class="badge badge-none">竞品</span>'}</td>
      <td>${parent ? esc(parent.name) : '—'}</td></tr>`;
  }
  html += '</tbody></table>';
  $('productsTable').innerHTML = html;
}

function renderFoot() {
  const lr = summary.lastRun;
  $('lastRunInfo').textContent = lr ? `上次采集：${new Date(lr.finishedAt).toLocaleString('zh-CN')}（成功 ${lr.ok}/共 ${lr.total}）` : '尚无采集记录';
}

/* ---------- 导出 CSV ---------- */
$('btnExportCsv').onclick = () => {
  const td = todayData();
  const rows = [['ASIN', '名称', '店铺', '类型', '售价USD', '星级', '评论数', '小类BSR', '小类名', '大类BSR', '库存状态', '库存数量', '状态', '采集时间']];
  for (const p of products) {
    const r = td[p.asin] || {};
    const st = r.stock || {};
    rows.push([p.asin, p.name || '', p.shop || '', p.type === 'own' ? '自有' : '竞品',
      r.price ?? '', r.rating ?? '', r.reviews ?? '',
      r.bsrSmall ? r.bsrSmall.rank : '', r.bsrSmall ? r.bsrSmall.label : '', r.bsrLarge ? r.bsrLarge.rank : '',
      st.kind || '', st.qty ?? '', r.ok ? '正常' : (r.captcha ? '验证码' : (r.error || '未采集')), r.fetchedAt || '']);
  }
  const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `amazon-${todayKey}.csv`;
  a.click();
};

/* ---------- 交互 ---------- */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  $('tab-' + t.dataset.tab).classList.remove('hidden');
});
$('statusFilter').onchange = e => { curStatus = e.target.value; renderToday(); };
$('histRange').onchange = e => { histRange = Number(e.target.value); renderHistory(); };
$('btnExpandAll').onclick = () => { owns().forEach(o => expanded.add(o.id)); renderToday(); };
$('btnCollapseAll').onclick = () => { expanded.clear(); renderToday(); };
$('btnExpandAll2').onclick = () => { owns().forEach(o => histExpanded.add(o.id)); renderHistory(); };
$('btnCollapseAll2').onclick = () => { histExpanded.clear(); renderHistory(); };

if (checkGate()) boot();
