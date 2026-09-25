/* 亚马逊每日竞品记录工具 · GitHub Pages 静态版 */
'use strict';

/* ===== 需要你改的地方 ===== */
const ACCESS_CODE_SHA256 = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9'; // 默认口令 admin123，改口令见 README
/* ========================== */

/* 仓库信息自动识别：只要页面是通过 GitHub Pages 打开的，就不用手填 */
const GH = (() => {
  const host = location.hostname || '';
  const seg = location.pathname.split('/').filter(Boolean);
  const forced = new URLSearchParams(location.search).get('repo') || '';
  let owner = '', repo = '';
  if (/^[\w.-]+\/[\w.-]+$/.test(forced)) { const t = forced.split('/'); owner = t[0]; repo = t[1]; }
  else if (/\.github\.io$/i.test(host)) { owner = host.split('.')[0]; repo = seg[0] || ''; }
  return { owner, repo, branch: 'main', file: 'data/products.json', workflow: 'daily-collect.yml' };
})();
const REPO_URL = GH.owner && GH.repo ? `https://github.com/${GH.owner}/${GH.repo}` : 'https://github.com/';

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

/* 本机预览（localhost）时跳过口令，方便自己检查页面 */
const IS_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);

function checkGate() {
  if (IS_LOCAL) return true;
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
  renderTokenBox();
  renderAll();
  activateTab((location.hash || '').slice(1) || 'today');
}

/* ---------- 渲染工具 ---------- */
const todayData = () => historyData[todayKey] || {};
const fmtPrice = r => r.price != null
  ? `$${r.price.toFixed(2)}${r.priceOutOfRange ? ' <span class="badge badge-fail" title="' + esc(r.priceNote || '超出预期区间') + '">价格异常</span>' : ''}`
  : '<span class="stock-unknown">—</span>';
const fmtRating = r => r.rating != null ? `<span class="rating">★${r.rating}</span>` : '—';
const fmtReviews = r => r.reviews != null ? `<span class="reviews">${r.reviews}</span>` : '—';
const fmtBought = r => r.boughtPastMonth != null ? `<span class="reviews">${r.boughtPastMonth}+</span>` : '<span class="stock-unknown">—</span>';
const fmtBsrS = r => r.bsrSmall ? `<span class="bsr-small">#${r.bsrSmall.rank.toLocaleString()}</span> <span class="pmeta">${esc(r.bsrSmall.label)}</span>` : '<span class="stock-unknown">未获取</span>';
const fmtBsrL = r => r.bsrLarge ? `<span class="bsr-large">#${r.bsrLarge.rank.toLocaleString()} ${esc(r.bsrLarge.label)}</span>` : '—';

/* 库存状态的人类可读短标签，用于「当天数据」和「变化提醒」 */
function stockLabel(s) {
  const k = (s || {}).kind;
  if (k === 'stock') {
    /* 口径按来源分层，绝不把「加购上限」冒充成「库存」：
       amazon_page        → 亚马逊页面原话 Only N left
       cart_only_n_left   → 购物车里亚马逊原话 Only N left（同样是库存）
       probe_ge           → 加购 999 被接受，只能说 ≥999
       max_purchasable    → 被夹到 N，N 是「一次最多能买 N 件」，可能是库存也可能是单笔上限 */
    if (s.source === 'amazon_page' || s.basis === 'cart_only_n_left') return `仅剩 ${s.qty} 件`;
    if (s.ge || s.basis === 'probe_ge') return `≥ ${s.qty} 件`;
    if (s.basis === 'max_purchasable' || s.confidence === 'medium') return `最多 ${s.qty} 件`;
    return `库存 ${s.qty} 件`;
  }
  if (k === 'purchase_limit') return `限购 ${s.qty}`;
  if (k === 'in_stock_no_qty') return '有货';
  if (k === 'unavailable') return '缺货';
  if (k === 'no_offer') return '无主报价';
  return '未知';
}
function fmtStock(r) {
  const s = r.stock || { kind: 'unknown' };
  let inner;
  switch (s.kind) {
    case 'stock':
      if (s.source === 'amazon_page') {
        inner = `<span class="stock-qty">仅剩 ${s.qty} 件</span> <span class="pmeta">（亚马逊页面原话）</span>`;
      } else if (s.basis === 'cart_only_n_left') {
        inner = `<span class="stock-qty">仅剩 ${s.qty} 件</span> <span class="badge badge-probe" title="加购探针：购物车条目里亚马逊原话 Only N left in stock">加购实测</span>`;
      } else {
        const badge = s.source === 'cart_probe'
          ? ' <span class="badge badge-probe" title="加购探针：把数量设成 999 加入匿名购物车，读取亚马逊夹紧后的数量">加购实测</span>'
          : (s.source === 'manual' ? ' <span class="badge badge-manual">手工</span>' : '');
        /* 夹紧值只能说明「一次最多能买 N 件」，不敢写成「库存 N 件」——N 也可能是单笔上限 */
        const isClamp = s.basis === 'max_purchasable' || s.confidence === 'medium';
        const text = s.basis === 'probe_ge' || s.ge ? '≥ ' + s.qty + ' 件'
          : isClamp ? '最多 ' + s.qty + ' 件'
            : '库存 ' + s.qty + ' 件';
        const own = isClamp
          ? ` title="加购实测：把数量设成 999 加入匿名购物车，亚马逊把它夹到 ${s.qty}。即「一次最多能买 ${s.qty} 件」——可能是库存，也可能是单笔订单上限，亚马逊没明示"`
          : (s.basis === 'probe_ge' ? ` title="加购实测：请求 999 件被亚马逊接受，只能确定库存 ≥ ${s.qty}"` : '');
        inner = `<span class="stock-qty${s.source === 'cart_probe' ? ' stock-probe' : ''}"${own}>${text}</span>${badge}`;
      }
      break;
    case 'purchase_limit': inner = `<span class="stock-limit">限购 ${s.qty}</span>`; break;
    case 'in_stock_no_qty': inner = '<span class="stock-noqty">有货，数量未显示</span>'; break;
    case 'unavailable': inner = '<span class="stock-na">不可购买 / 缺货</span>'; break;
    case 'no_offer': inner = '<span class="stock-nooffer">无主报价</span> <span class="pmeta">（亚马逊未展示购买框）</span>'; break;
    default: inner = '<span class="stock-unknown">库存未获取</span>';
  }
  const tips = [];
  if (r.availabilityText) tips.push('亚马逊页面原话：' + r.availabilityText);
  if (s.note) tips.push(s.note);
  if (r.stockProbeError) tips.push('加购探针未取到：' + r.stockProbeError);
  if (r.stockProbeVariantAsin) tips.push('买箱实际指向变体子 ASIN ' + r.stockProbeVariantAsin);
  const tip = tips.length ? ` title="${esc(tips.join('\n'))}"` : '';
  return tip ? `<span${tip}>${inner}</span>` : inner;
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

function renderAll() { renderStockAlert(); renderStats(); renderShopTabs(); renderToday(); renderChanges(); renderHistory(); renderProducts(); renderFoot(); }

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
    <th style="min-width:270px">商品</th><th>采集售价</th><th>星级</th><th>评论数</th><th>近月销量</th><th>小类 BSR</th><th>大类 BSR</th><th>库存 / 限购</th><th>状态</th><th>采集时间</th>
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
      <td class="num-cell">${fmtBought(rec || {})}${rec && prev ? deltaHtml(rec.boughtPastMonth, prev.boughtPastMonth) : ''}</td>
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
    if (!r || !r.ok || !prev) continue;
    const items = [];
    if (r.price != null && prev.price != null && Math.abs(r.price - prev.price) > 0.001) items.push(`售价 $${prev.price} → $${r.price}`);
    if (r.reviews != null && prev.reviews != null && r.reviews !== prev.reviews) items.push(`评论 ${prev.reviews} → ${r.reviews}`);
    if (r.bsrSmall && prev.bsrSmall && r.bsrSmall.rank !== prev.bsrSmall.rank) items.push(`小类BSR #${prev.bsrSmall.rank} → #${r.bsrSmall.rank}`);
    // 库存/在售状态变化：竞品断货或补货，往往比价格更值得第一时间知道
    const sPrev = stockLabel(prev.stock), sNow = stockLabel(r.stock);
    if (sPrev !== sNow) items.push(`库存 ${sPrev} → ${sNow}`);
    if (items.length) changes.push(`<b>${esc(p.name || p.asin)}</b>：${items.join('；')}`);
  }
  $('changesBox').innerHTML = changes.length
    ? '<b>较上一次成功采集的变化：</b><br>' + changes.join('<br>')
    : (Object.keys(td).length ? '较上一次成功采集：本次没有检测到价格 / 评论数 / BSR / 库存 变化。' : '');
}

/* ==================== 库存预警 ==================== */
/* 亚马逊只在库存偏低时才肯露出数字，所以「仅剩 N 件」本身就是信号。
   分三档呈现：
     1 = 自有商品出问题（断货 / 无主报价 / 仅剩很少）→ 需要立刻处理
     2 = 竞品的库存信号（断货 / 仅剩很少）→ 抢排名的机会窗口
     3 = 其他拿到精确数字的（仅剩较多 / 限购）→ 仅供参考
   「有货，数量未显示」不列出来 —— 亚马逊本来就不给数字，占了绝大多数，列了会淹没重点。 */
const LOW_KEY = 'tracker_low_stock';
const LOW_OPTS = [3, 5, 10, 20, 30, 50];
let lowStockQty = Number(localStorage.getItem(LOW_KEY)) || 10;
if (LOW_OPTS.indexOf(lowStockQty) < 0) lowStockQty = 10;
const ALERT_CLS = { 1: 'chip-red', 2: 'chip-amber', 3: 'chip-gray' };

function stockAlerts() {
  const td = todayData();
  const g = { 1: [], 2: [], 3: [] };
  let fail = 0, pending = 0;

  for (const p of products) {
    const r = td[p.asin];
    if (!r) { pending++; continue; }
    if (!r.ok) { fail++; continue; }
    const isOwn = p.type === 'own';
    const s = r.stock || { kind: 'unknown' };
    const nowL = stockLabel(s);
    const prev = prevRecord(p.asin);
    const prevL = prev ? stockLabel(prev.stock) : '';
    const item = {
      nm: p.name || p.asin,
      asin: p.asin,
      chg: prevL && prevL !== nowL ? prevL : '',
      tip: r.availabilityText || ''
    };
    if (s.kind === 'unavailable') g[isOwn ? 1 : 2].push(Object.assign(item, { tag: '已断货 / 不可购买' }));
    else if (s.kind === 'no_offer') g[isOwn ? 1 : 2].push(Object.assign(item, { tag: '无主报价（无购买框）' }));
    else if (s.kind === 'stock' && s.qty != null && s.qty <= lowStockQty) g[isOwn ? 1 : 2].push(Object.assign(item, { tag: stockLabel(s) }));
    else if (s.kind === 'stock') g[3].push(Object.assign(item, { tag: stockLabel(s) }));
    else if (s.kind === 'purchase_limit') g[3].push(Object.assign(item, { tag: '限购 ' + s.qty + ' 件' }));
  }

  /* 组内排序：断货/无主报价（没有数字）排最前，其余按数量从小到大 */
  const num = it => { const m = String(it.tag).match(/\d+/); return m ? parseInt(m[0], 10) : -1; };
  const bySev = (a, b) => num(a) - num(b);
  g[1].sort(bySev); g[2].sort(bySev); g[3].sort(bySev);
  return { g, fail, pending };
}

function alertChip(it, lv) {
  const tip = it.tip ? ' title="亚马逊页面原话：' + esc(it.tip) + '"' : '';
  const chg = it.chg ? ' <span class="chg">（上次「' + esc(it.chg) + '」）</span>' : '';
  return '<span class="alert-chip ' + ALERT_CLS[lv] + '"' + tip + '>'
    + '<a href="https://www.amazon.com/dp/' + esc(it.asin) + '" target="_blank" rel="noopener">' + esc(it.nm) + '</a>'
    + ' · ' + esc(it.tag) + chg + '</span>';
}

function renderStockAlert() {
  const box = $('stockAlert');
  if (!box) return;
  if (!dates.length) { box.classList.add('hidden'); return; }
  const { g, fail, pending } = stockAlerts();
  const hot = g[1].length + g[2].length;
  box.className = 'alert-box ' + (g[1].length ? 'has-danger' : (hot ? 'has-warn' : 'all-clear'));

  const group = (label, cls, arr, lv) => arr.length
    ? '<div class="alert-group"><span class="ag-label ' + cls + '">' + label + ' ' + arr.length + '</span>'
      + '<span class="alert-chips">' + arr.map(x => alertChip(x, lv)).join('') + '</span></div>'
    : '';

  const opt = LOW_OPTS.map(v => '<option value="' + v + '"' + (v === lowStockQty ? ' selected' : '') + '>≤' + v + ' 件</option>').join('');
  const head = '<div class="alert-head"><span>⚠️ 库存预警</span>'
    + '<span class="alert-meta">数据日期 ' + esc(todayKey) + ' · 低库存阈值</span>'
    + '<select id="lowStockSel" title="「仅剩 N 件」的 N 不超过这个值，就当成低库存列出来">' + opt + '</select>'
    + '<span class="alert-meta">· 自有需处理 ' + g[1].length + ' · 竞品信号 ' + g[2].length + '</span></div>';

  let body = group('自有商品·需处理', 'ag-red', g[1], 1)
    + group('竞品·机会窗口', 'ag-amber', g[2], 2)
    + group('其他精确数量', 'ag-gray', g[3], 3);
  if (!body) body = '<div class="alert-clear">✅ 今天没有需要关注的库存异常：没有商品断货，也没有商品的「仅剩 N 件」低到阈值以下。</div>';

  let foot = '';
  if (fail || pending) {
    foot = '<div class="alert-foot">另有'
      + (fail ? ' <b>' + fail + '</b> 个商品采集异常' : '')
      + (fail && pending ? '、' : '')
      + (pending ? ' ' + pending + ' 个商品未采集' : '')
      + ' —— 到「📋 当天数据」页把「状态」筛成「异常/未采到」就能看到具体是哪些。</div>';
  }

  box.innerHTML = head + body + foot;
  $('lowStockSel').onchange = e => {
    lowStockQty = Number(e.target.value) || 10;
    localStorage.setItem(LOW_KEY, String(lowStockQty));
    renderStockAlert();
  };
}

/* 历史表格列很窄，这里用紧凑写法 + 悬浮提示，避免折行 */
function histStock(r) {
  const s = r.stock || { kind: 'unknown' };
  const raw = [];
  if (r.availabilityText) raw.push('亚马逊原话：' + r.availabilityText);
  if (s.note) raw.push(s.note);
  if (r.stockProbeError) raw.push('加购探针未取到：' + r.stockProbeError);
  if (r.stockProbeVariantAsin) raw.push('买箱实际指向变体子 ASIN ' + r.stockProbeVariantAsin);
  const tip = raw.length ? '｜' + raw.join('｜') : '';
  switch (s.kind) {
    case 'stock':
      if (s.source === 'amazon_page') return `<span class="stock-qty" title="亚马逊页面原话「Only ${s.qty} left in stock」">仅剩 ${s.qty} 件</span>`;
      if (s.basis === 'cart_only_n_left') return `<span class="stock-qty stock-probe" title="加购实测：购物车条目里亚马逊原话 Only ${s.qty} left in stock${tip}">仅剩 ${s.qty} 件</span>`;
      if (s.basis === 'probe_ge' || s.ge) return `<span class="stock-qty stock-probe" title="加购实测：请求 999 件被接受，只能确定 ≥${s.qty}${tip}">≥${s.qty} 件</span>`;
      if (s.basis === 'max_purchasable' || s.confidence === 'medium') return `<span class="stock-qty stock-probe" title="加购实测：亚马逊把数量夹到 ${s.qty}，即一次最多能买 ${s.qty} 件（可能是库存，也可能是单笔上限）${tip}">最多 ${s.qty} 件</span>`;
      return `<span class="stock-qty stock-probe" title="加购实测${tip}">${s.qty} 件</span>`;
    case 'purchase_limit': return `<span class="stock-limit" title="限购 ${s.qty} 件（亚马逊限购数，不是库存）${tip}">限购 ${s.qty}</span>`;
    case 'in_stock_no_qty': return `<span class="stock-noqty" title="有货，但亚马逊没给数量${tip}">有货</span>`;
    case 'unavailable': return `<span class="stock-na" title="不可购买 / 缺货${tip}">缺货</span>`;
    case 'no_offer': return `<span class="stock-nooffer" title="亚马逊没有展示购买框（可能只剩第三方卖家，或该 ASIN 已下架）${tip}">无主报价</span>`;
    default: return `<span class="stock-unknown" title="库存未获取${tip}">未知</span>`;
  }
}
const histPrice = r => {
  if (r.price != null) return `$${r.price.toFixed(2)}${r.priceOutOfRange ? ` <span class="hist-fail" title="${esc(r.priceNote || '超出预期价格区间')}">⚠</span>` : ''}`;
  if (r.priceVoided) return `<span class="stock-unknown" title="${esc(r.priceNote || '该日价格已作废')}">作废</span>`;
  return '<span class="stock-unknown">—</span>';
};

/* 历史对比：每个指标占一行，指标名固定在左侧，日期列只显示数值 */
const HIST_METRICS = [
  { key: 'price',   label: '售价',     cell: histPrice },
  { key: 'rating',  label: '星级',     cell: r => r.rating != null ? `<span class="rating">★${r.rating}</span>` : '<span class="stock-unknown">—</span>' },
  { key: 'reviews', label: '评论数',   cell: r => r.reviews != null ? `<span class="reviews">${r.reviews}</span>` : '<span class="stock-unknown">—</span>' },
  { key: 'bought',  label: '近月销量', cell: r => r.boughtPastMonth != null ? `<span class="reviews" title="亚马逊「过去一个月已购买 N+」">${r.boughtPastMonth}+</span>` : '<span class="stock-unknown">—</span>' },
  { key: 'bsr',     label: '小类BSR',  cell: r => r.bsrSmall
      ? `<span class="bsr-small" title="${esc(r.bsrSmall.label || '')}">#${r.bsrSmall.rank.toLocaleString()}</span>`
      : '<span class="stock-unknown">—</span>' },
  { key: 'stock',   label: '库存',     cell: histStock }
];
const HIST_COL_W = 252, HIST_MET_W = 76, HIST_DATE_MIN = 140;

function histCell(r, mt) {
  if (!r) return '<span class="hist-void">—</span>';
  if (r.ok === false) return `<span class="hist-fail" title="${esc(r.error || '采集失败')}">✕</span>`;
  return mt.cell(r);
}

/* 量一下历史表格可用宽度，好让日期列自动撑满容器 */
function histAvailableWidth() {
  const el = $('historyTable');
  let w = el ? el.clientWidth : 0;
  if (!w) { const c = document.querySelector('.container'); w = c ? c.clientWidth - 28 : 1200; }
  return Math.max(640, w);
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

  // 列宽：前两列固定，日期列均分剩余宽度（至少 HIST_DATE_MIN，不够就横向滚动）
  const wrapW = histAvailableWidth();
  const fixedW = HIST_COL_W + HIST_MET_W;
  const base = Math.max(HIST_DATE_MIN, Math.floor((wrapW - fixedW) / ds.length));
  const total = fixedW + base * ds.length;
  const width = Math.max(total, wrapW);
  const lastColW = base + (width - total);

  let html = `<table class="hist-table" style="width:${width}px"><colgroup>`
    + `<col style="width:${HIST_COL_W}px"><col style="width:${HIST_MET_W}px">`
    + ds.map((d, i) => `<col style="width:${i === ds.length - 1 ? lastColW : base}px">`).join('')
    + `</colgroup><thead><tr><th class="prod-col">商品信息</th><th class="metric-col">指标</th>`;
  for (const d of ds) html += `<th class="date-col">${d.slice(5).replace('-', '月')}日${d === tKey ? '（预）' : ''}</th>`;
  html += '</tr></thead><tbody>';

  for (const [p, isOwn] of rows) {
    const caret = isOwn ? `<span class="caret" data-htoggle="${p.id}">${histExpanded.has(p.id) ? '▾' : '▸'}</span>` : '<span class="caret"></span>';
    HIST_METRICS.forEach((mt, mi) => {
      const pos = mi === 0 ? 'pr-first' : (mi === HIST_METRICS.length - 1 ? 'pr-last' : 'pr-mid');
      html += `<tr class="${isOwn ? 'group-own' : 'row-compete'} ${pos}">`;
      if (mi === 0) html += `<td class="prod-col" rowspan="${HIST_METRICS.length}">${caret}${productCell(p)}</td>`;
      html += `<td class="metric-col">${mt.label}</td>`;
      for (const d of ds) html += `<td class="date-col num-cell">${histCell((historyData[d] || {})[p.asin], mt)}</td>`;
      html += '</tr>';
    });
  }
  html += '</tbody></table>';
  $('historyTable').innerHTML = html;
  $('historyTable').querySelectorAll('[data-htoggle]').forEach(el => el.onclick = () => {
    const id = el.dataset.htoggle; histExpanded.has(id) ? histExpanded.delete(id) : histExpanded.add(id); renderHistory();
  });
}

function renderProducts() {
  let html = `<table><thead><tr><th style="min-width:260px">商品</th><th>ASIN</th><th>店铺</th><th>类型</th><th>关联自有</th><th>预期价区间</th><th>操作</th></tr></thead><tbody>`;
  for (const p of products) {
    const parent = products.find(x => x.id === p.parentId);
    const rng = (p.priceMin != null || p.priceMax != null)
      ? `${p.priceMin != null ? '$' + p.priceMin : ''} ~ ${p.priceMax != null ? '$' + p.priceMax : ''}`
      : '—';
    html += `<tr><td>${productCell(p)}</td><td class="mono">${esc(p.asin)}</td><td>${esc(p.shop || '')}</td>
      <td>${p.type === 'own' ? '<span class="badge badge-ok">自有</span>' : '<span class="badge badge-none">竞品</span>'}</td>
      <td>${parent ? esc(parent.name) : '—'}</td>
      <td class="mono pmeta">${esc(rng)}</td>
      <td class="nowrap">
        <button class="btn-mini" data-pedit="${esc(p.id)}">编辑</button>
        <button class="btn-mini btn-danger" data-pdel="${esc(p.id)}">删除</button>
      </td></tr>`;
  }
  html += '</tbody></table>';
  $('productsTable').innerHTML = html;
  $('productsTable').querySelectorAll('[data-pedit]').forEach(b => b.onclick = () => openProductModal(b.dataset.pedit));
  $('productsTable').querySelectorAll('[data-pdel]').forEach(b => b.onclick = () => deleteProduct(b.dataset.pdel));
}

/* ==================== 商品管理（直连 GitHub 写入 products.json） ==================== */
const TOKEN_KEY = 'tracker_gh_token';
const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
const GH_READY = () => !!(GH.owner && GH.repo);

function ghMsg(text, kind) {
  const el = $('ghMsg');
  el.className = 'gh-msg ' + (kind || '');
  el.textContent = text || '';
}

async function ghFetch(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${GH.owner}/${GH.repo}/${path}`, Object.assign({}, opts, {
    headers: Object.assign({
      Authorization: 'Bearer ' + getToken(),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }, opts.headers || {})
  }));
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  if (!res.ok) {
    const err = new Error((data && data.message) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

const b64enc = str => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64dec = b64 => {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

async function ghLoadProducts() {
  const cur = await ghFetch(`contents/${GH.file}?ref=${GH.branch}&_=${Date.now()}`);
  return { list: JSON.parse(b64dec(cur.content)), sha: cur.sha };
}

/* 先拉最新文件，再在最新文件上做改动，避免覆盖别处的修改 */
async function commitProducts(mutate, message) {
  if (!GH_READY()) throw new Error('无法识别仓库地址，请通过 GitHub Pages 网址打开本页');
  if (!getToken()) throw new Error('还没填 GitHub 令牌，请先在上方「令牌」区填写并保存');
  const { list, sha } = await ghLoadProducts();
  if (!Array.isArray(list)) throw new Error('仓库里的 products.json 格式不对（不是数组）');
  mutate(list);
  await ghFetch(`contents/${GH.file}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message, branch: GH.branch, sha,
      content: b64enc(JSON.stringify(list, null, 2) + '\n')
    })
  });
  products = list;
}

async function ghDispatchCollect() {
  await ghFetch(`actions/workflows/${GH.workflow}/dispatches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: GH.branch })
  });
}

function renderTokenBox() {
  const box = $('ghTokenBox');
  if (!GH_READY()) {
    box.className = 'gh-box';
    box.innerHTML = '⚠️ 当前不是从 GitHub Pages 打开的页面，无法写入仓库。请访问你的线上网址（例如 <span class="mono">https://你的用户名.github.io/仓库名/</span>）后再编辑商品。';
    return;
  }
  const tk = getToken();
  if (tk) {
    box.className = 'gh-box gh-ok';
    box.innerHTML = `<b>✅ 已连接仓库</b> <span class="mono">${esc(GH.owner + '/' + GH.repo)}</span> · 令牌末尾 <span class="mono">…${esc(tk.slice(-4))}</span>
      <div class="gh-row">
        <button class="btn-mini" id="btnTestToken">测试连接</button>
        <button class="btn-mini" id="btnChangeToken">更换令牌</button>
        <button class="btn-mini btn-danger" id="btnClearToken">清除令牌</button>
      </div>`;
    $('btnTestToken').onclick = async () => {
      ghMsg('正在测试令牌…', 'busy');
      try {
        const cur = await ghFetch(`contents/${GH.file}?ref=${GH.branch}&_=${Date.now()}`);
        const n = (JSON.parse(b64dec(cur.content)) || []).length;
        ghMsg(`连接正常，仓库里现在有 ${n} 个商品。`, 'ok');
      } catch (e) {
        ghMsg('连接失败：' + e.message + (e.status === 401 ? '（令牌无效或已过期）' : e.status === 403 ? '（令牌权限不足，需 Contents: Read and write）' : e.status === 404 ? '（仓库/文件路径不对，或令牌没勾这个仓库）' : ''), 'bad');
      }
    };
    $('btnChangeToken').onclick = () => { localStorage.removeItem(TOKEN_KEY); renderTokenBox(); };
    $('btnClearToken').onclick = () => { localStorage.removeItem(TOKEN_KEY); ghMsg('已清除本机保存的令牌。', 'ok'); renderTokenBox(); };
  } else {
    box.className = 'gh-box';
    box.innerHTML = `<b>🔑 首次使用请填写 GitHub 令牌</b>（只保存在你自己这台设备的浏览器里，不会上传到任何服务器）
      <div class="gh-row">
        <input type="password" id="ghTokenInput" placeholder="粘贴 GitHub 令牌（github_pat_… 或 ghp_…）" autocomplete="off">
        <button class="btn-primary" id="btnSaveToken">保存令牌</button>
      </div>
      <p class="pmeta" style="margin:8px 0 0">
        建议用 <b>Fine-grained token</b>，只勾选本仓库，权限给 <span class="mono">Contents: Read and write</span> + <span class="mono">Actions: Read and write</span>，并设置一个到期日。
        生成入口：GitHub → Settings → Developer settings → Personal access tokens。
      </p>`;
    $('btnSaveToken').onclick = () => {
      const v = $('ghTokenInput').value.trim();
      if (!v) { ghMsg('请先粘贴令牌', 'bad'); return; }
      localStorage.setItem(TOKEN_KEY, v);
      ghMsg('令牌已保存在本机浏览器。', 'ok');
      renderTokenBox();
    };
  }
}

/* ---------- 商品新增 / 编辑弹窗 ---------- */
let editingId = null;

function openProductModal(id) {
  editingId = id || null;
  const p = id ? products.find(x => x.id === id) : null;
  $('prodModalTitle').textContent = p ? '编辑商品' : '新增商品';
  $('fAsin').value = p ? p.asin : '';
  $('fAsin').disabled = !!p;
  $('fName').value = p ? (p.name || '') : '';
  $('fShop').value = p ? (p.shop || '') : '';
  $('fType').value = p ? p.type : 'own';
  $('fMin').value = p && p.priceMin != null ? p.priceMin : '';
  $('fMax').value = p && p.priceMax != null ? p.priceMax : '';
  $('prodErr').textContent = '';
  fillParentSelect(p ? p.parentId : '');
  syncParentVisibility();
  $('prodMask').classList.remove('hidden');
  setTimeout(() => { if (!p) $('fAsin').focus(); else $('fName').focus(); }, 30);
}

function fillParentSelect(sel) {
  const owns_ = products.filter(x => x.type === 'own');
  $('fParent').innerHTML = owns_.map(o => `<option value="${esc(o.id)}" ${o.id === sel ? 'selected' : ''}>${esc(o.name || o.asin)}</option>`).join('');
}

function syncParentVisibility() {
  $('wrapParent').classList.toggle('hidden', $('fType').value !== 'compete');
}

function closeProductModal() { $('prodMask').classList.add('hidden'); editingId = null; }

async function saveProduct() {
  const asin = $('fAsin').value.trim().toUpperCase();
  const type = $('fType').value;
  const name = $('fName').value.trim();
  const shop = $('fShop').value.trim();
  const parentId = type === 'compete' ? $('fParent').value : '';
  const minV = $('fMin').value.trim(), maxV = $('fMax').value.trim();
  const id = editingId || (type === 'own' ? 'own_' : 'cmp_') + asin;

  if (!/^[A-Z0-9]{10}$/.test(asin)) { $('prodErr').textContent = 'ASIN 必须是 10 位字母数字'; return; }
  if (type === 'compete' && !parentId) { $('prodErr').textContent = '竞品必须选择一个「关联自有商品」'; return; }
  if (!editingId && products.some(x => x.id === id || x.asin === asin)) { $('prodErr').textContent = '这个 ASIN 已经在清单里了'; return; }

  const item = {
    id, asin, name, shop, type, parentId,
    ...(minV !== '' ? { priceMin: Number(minV) } : {}),
    ...(maxV !== '' ? { priceMax: Number(maxV) } : {})
  };

  const btn = $('btnProdSave');
  btn.disabled = true; btn.textContent = '正在写入仓库…';
  try {
    await commitProducts(list => {
      const i = list.findIndex(x => x.id === id);
      if (i >= 0) list[i] = Object.assign({}, list[i], item);
      else list.push(item);
    }, (editingId ? 'Update product ' : 'Add product ') + asin);
    closeProductModal();
    renderAll();
    ghMsg(`✅ 已保存 ${asin} 到仓库，页面用的是最新清单。`, 'ok');
    if ($('fDispatch').checked) {
      try { await ghDispatchCollect(); ghMsg(`✅ 已保存 ${asin}，并已触发云端采集（约 3–5 分钟后刷新可见数据）。`, 'ok'); }
      catch (e) { ghMsg(`已保存 ${asin}，但触发采集失败：${e.message}（可在 GitHub Actions 页面手动运行）`, 'bad'); }
    }
  } catch (e) {
    $('prodErr').textContent = '写入失败：' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '保存到仓库';
  }
}

async function deleteProduct(id) {
  const p = products.find(x => x.id === id);
  const asin = p ? p.asin : id.replace(/^(own_|cmp_)/, '');
  const label = p ? (p.name || p.asin) : asin;
  const children = p && p.type === 'own' ? products.filter(x => x.parentId === id) : [];
  const extra = children.length ? `\n\n它下面还有 ${children.length} 个竞品，会一起删除：\n· ` + children.map(c => c.name || c.asin).join('\n· ') : '';
  if (!confirm(`确定删除「${label}」（${asin}）？${extra}\n\n（只影响仓库里的商品清单，已采集的历史数据会保留）`)) return;
  ghMsg('正在写入仓库…', 'busy');
  try {
    await commitProducts(list => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].id === id || list[i].parentId === id) list.splice(i, 1);
      }
    }, 'Remove product ' + asin);
    renderAll();
    ghMsg(`✅ 已从仓库删除 ${asin}${children.length ? ' 及其 ' + children.length + ' 个竞品' : ''}。`, 'ok');
  } catch (e) {
    ghMsg('删除失败：' + e.message, 'bad');
  }
}

async function reloadProductsFromRepo() {
  ghMsg('正在从仓库读取…', 'busy');
  try {
    const { list } = await ghLoadProducts();
    products = list;
    renderAll();
    ghMsg(`✅ 已从仓库读取最新清单（${list.length} 个商品）。`, 'ok');
  } catch (e) {
    ghMsg('读取失败：' + e.message, 'bad');
  }
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
function activateTab(name) {
  const t = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!t) return;
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  $('tab-' + name).classList.remove('hidden');
  if (name === 'history') renderHistory();   // 显示后再量一次宽度，让日期列撑满
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  activateTab(t.dataset.tab);
  history.replaceState(null, '', '#' + t.dataset.tab);
});
window.addEventListener('hashchange', () => activateTab((location.hash || '#today').slice(1)));
$('statusFilter').onchange = e => { curStatus = e.target.value; renderToday(); };
$('histRange').onchange = e => { histRange = Number(e.target.value); renderHistory(); };
$('btnExpandAll').onclick = () => { owns().forEach(o => expanded.add(o.id)); renderToday(); };
$('btnCollapseAll').onclick = () => { expanded.clear(); renderToday(); };
$('btnExpandAll2').onclick = () => { owns().forEach(o => histExpanded.add(o.id)); renderHistory(); };
$('btnCollapseAll2').onclick = () => { histExpanded.clear(); renderHistory(); };

/* 商品管理 */
$('btnAddProduct').onclick = () => openProductModal(null);
$('btnReloadProducts').onclick = reloadProductsFromRepo;
$('fType').onchange = syncParentVisibility;
$('btnProdCancel').onclick = closeProductModal;
$('btnProdSave').onclick = saveProduct;
$('prodMask').addEventListener('click', e => { if (e.target === $('prodMask')) closeProductModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('prodMask').classList.contains('hidden')) closeProductModal(); });

let rsTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rsTimer);
  rsTimer = setTimeout(() => { if (!$('tab-history').classList.contains('hidden')) renderHistory(); }, 180);
});

if (checkGate()) boot();
