/*
 * 亚马逊每日竞品记录工具 · GitHub Actions 免费版 采集脚本
 * 运行环境: GitHub Actions (ubuntu-latest, Node 20)，也可本机直接运行
 * 用法: node scripts/collect.mjs [--limit N] [--asin XXXXXXXXXX]
 * 环境变量:
 *   SCRAPER_MODE = direct | jina | scrapingbee   (默认 direct)
 *   SCRAPER_KEY  = 对应服务的 API Key（GitHub Secrets 传入，可选）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTS_FILE = path.join(ROOT, 'data', 'products.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');
const SUMMARY_FILE = path.join(ROOT, 'data', 'summary.json');

const UA_POOL = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', brand: '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', brand: '"Not/A)Brand";v="8", "Chromium";v="125", "Google Chrome";v="125"' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', brand: null }
];
const SCRAPER_MODE = process.env.SCRAPER_MODE || 'direct';
const SCRAPER_KEY = process.env.SCRAPER_KEY || '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 8000);

function chromeHeaders(idx) {
  const p = UA_POOL[idx % UA_POOL.length];
  const h = {
    'User-Agent': p.ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'DNT': '1',
    'Connection': 'keep-alive'
  };
  if (p.brand) { h['sec-ch-ua'] = p.brand; h['sec-ch-ua-mobile'] = '?0'; h['sec-ch-ua-platform'] = '"Windows"'; }
  return h;
}

/* 会话级 Cookie：整轮采集复用同一个匿名会话，降低验证码、并支撑购物车探针 */
let COOKIE_JAR = { 'i18n-prefs': 'USD', 'lc-main': 'en_US' };
function cookieHeader() {
  return Object.entries(COOKIE_JAR).map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorbCookies(res) {
  if (!res || !res.headers) return;
  let setCookies = [];
  try { setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch (e) {}
  if (!setCookies.length) { const raw = res.headers.get('set-cookie'); if (raw) setCookies = [raw]; }
  for (const c of setCookies) {
    const kv = c.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) COOKIE_JAR[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}

/* 会话预热：先访问首页拿 Cookie，再带 Cookie 抓商品页，显著降低验证码概率 */
async function warmSession(idx) {
  try {
    const r = await http('https://www.amazon.com/', { headers: chromeHeaders(idx), redirect: 'follow' }, 25000);
    absorbCookies(r.res);
    COOKIE_JAR['i18n-prefs'] = 'USD';
    COOKIE_JAR['lc-main'] = 'en_US';
  } catch (e) {}
  return cookieHeader();
}

/* --------- 库存探针：复刻「模拟加购直到无法添加」 --------- */
/* 原理：加购时把数量写成 999，亚马逊会把它夹到「当前最大可购买量」，
   再读购物车里的 input[name=quantityBox]，那个数就是库存（或限购上限）。
   卖家精灵的库存监控用的正是这套机制。
   实测要点 —— 每条都是踩出来的坑：
     1. 真实加购接口是 POST /cart/add-to-cart/ref=dp_start-bbf_1_glance。
        老的 /gp/product/handle-buy-box/ 已废弃，一律返回 404 Page Not Found。
        字段必须从商品页 form#addToCart 原样解析，自己猜字段一定失败。
     2. POST 之后必须**再单独 GET 一次购物车页**才读得到 quantityBox ——
        POST 响应本身不含这个字段（最容易踩的坑，会让人误判为"加购失败"）。
     3. 必须给匿名会话设美国收货邮编，否则「不发中国」的商品亚马逊根本不展示
        买箱：form 里 asin / offerListingId / quantity 全缺失，加购按钮也不存在。
        实测设置后这类商品立刻恢复（失败率从 3/6 降到 0/6）。
     4. 删条目必须带 anti-csrftoken-a2z，漏了会静默失败、商品在购物车里累积，
        后面每个商品读到的 quantityBox 都会被污染。
   局限（如实说明）：数量框 maxlength=3，最多只能探到 999；有限购的商品读到的是
   限购数而不是真实库存，所以 kind 会标成 purchase_limit。 */
const PROBE_QTY = Number(process.env.PROBE_QTY || 999);
const PROBE_ON = process.env.STOCK_PROBE !== '0';   // 默认开启；STOCK_PROBE=0 关闭
let ZIP_DONE = false;

/* ---------------------------------------------------------------------------
 * 从「加购响应」里读亚马逊自己的原话 —— 这是区分库存和限购的**权威判据**。
 *
 * 2026-09-25 实测确立（此前一版靠「亚马逊没打印 low-stock 文案」反推，被用户实测证伪）：
 *
 *   库存不足 → "... than the N available from the seller you've selected.
 *                Click here to return to the product detail page and see if
 *                additional quantities are available from another seller."
 *              ↑ 讲的是「你选的这个卖家手里有多少可售」，所以 N 就是库存。
 *
 *   单笔限购 → "limit of N per customer"
 *
 *   同一个形态的商品（都想买 999 结果只让买很小的数），只有这句原话能区分：
 *     B0HHXD8SHF 夹到 2  → 原话是 "the 2 available from the seller"  → 库存 2
 *     B09PTH84M7 夹到 100 → 原话是 "limit of 100 per customer"      → 限购 100
 *   对照验证：B0C743SY46 原话 "the 17 available from the seller"，
 *             而它商品页也写着 "Only 17 left in stock" —— 两处数字一致，
 *             证明这句话说的确实是库存。
 *
 * 注意：这句话有时埋在 <script> 的 JSON 里，所以**不能只看去掉标签的正文**，
 *       要对原始响应文本搜（见下面 extractAtcEvidence 的用法）。
 * ------------------------------------------------------------------------- */
function extractAtcEvidence(text) {
  const out = { limit: null, available: null, raw: null };
  if (!text) return out;
  /* 把 HTML 实体还原，否则引号/加号会把正则切断 */
  const t = String(text).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
  const raws = [];
  let m = t.match(/limit\s+(?:of\s+)?([\d,]+)\s+(?:units\s+)?per\s+(?:customer|order)/i)
       || t.match(/limited\s+to\s+([\d,]+)\s+(?:units\s+)?per\s+(?:customer|order)/i);
  if (m) { out.limit = parseInt(m[1].replace(/,/g, ''), 10); raws.push(m[0]); }
  m = t.match(/than\s+the\s+([\d,]+)\s+available\s+from\s+the\s+seller/i)
   || t.match(/([\d,]+)\s+available\s+from\s+the\s+seller\s+you/i);
  if (m) { out.available = parseInt(m[1].replace(/,/g, ''), 10); raws.push(m[0]); }
  if (raws.length) out.raw = raws.join(' | ');
  return out;
}
/* 只在「数字与本次夹紧值一致」时才采信 —— 加购响应是整张页面（含推荐位），
   里面可能出现别的商品的 limit 文案，用数值一致性把它挡掉。 */
function pickEvidence(ev, clamp) {
  if (!ev) return null;
  if (ev.limit != null && ev.limit === clamp) return { kind: 'limit', qty: ev.limit };
  if (ev.available != null && ev.available === clamp) return { kind: 'available', qty: ev.available };
  return null;
}

/* 给匿名会话设美国收货邮编（不设会有商品读不到买箱） */
async function setUsZip(zip) {
  if (ZIP_DONE) return true;
  ZIP_DONE = true;
  try {
    const home = await http('https://www.amazon.com/', { headers: Object.assign(chromeHeaders(0), { Cookie: cookieHeader() }), redirect: 'follow' }, 25000);
    absorbCookies(home.res);
    const src = home.text || '';
    const csrf = (src.match(/name="anti-csrftoken-a2z"\s+value="([^"]+)"/) || [])[1]
      || (src.match(/"anti-csrftoken-a2z"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const h = chromeHeaders(0);
    h['Cookie'] = cookieHeader();
    h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    h['X-Requested-With'] = 'XMLHttpRequest';
    h['Accept'] = 'text/html,*/*;q=0.01';
    h['Sec-Fetch-Mode'] = 'cors';
    h['Sec-Fetch-Site'] = 'same-origin';
    h['Referer'] = 'https://www.amazon.com/';
    h['Origin'] = 'https://www.amazon.com';
    h['anti-csrftoken-a2z'] = csrf;
    const body = new URLSearchParams({
      locationType: 'LOCATION_INPUT', zipCode: zip, storeContext: 'generic',
      deviceType: 'web', pageType: 'Detail', actionSource: 'glow'
    });
    const r = await http('https://www.amazon.com/gp/delivery/ajax/address-change.html', { method: 'POST', headers: h, body: body.toString(), redirect: 'follow' }, 25000);
    absorbCookies(r.res);
    let j = null; try { j = JSON.parse(r.text || ''); } catch (e) {}
    const okZip = !!(j && j.successful && j.isAddressUpdated);
    console.log(`    [探针] 收货邮编 ${zip}: ${okZip ? '设置成功 ' + [j.address && j.address.city, j.address && j.address.state].filter(Boolean).join(' ') : '设置失败（部分商品可能读不到买箱）'}`);
    return okZip;
  } catch (e) { return false; }
}

/* 从商品页解析真实的 form#addToCart 字段（不能猜） */
function extractAtcForm(html) {
  const m = html.match(/<form[^>]*\bid="addToCart"[^>]*>/i);
  if (!m) return null;
  const start = m.index;
  const cands = [html.indexOf('<form', start + 1), html.indexOf('</form>', start)].filter(x => x > 0);
  const end = cands.length ? Math.min(...cands) : start + 200000;
  const body = html.slice(start, end);
  const fields = [];
  for (const t of body.matchAll(/<input\b[^>]*>/gi)) {
    const tag = t[0];
    const name = (tag.match(/\bname="([^"]*)"/) || [])[1];
    if (!name) continue;
    const type = ((tag.match(/\btype="([^"]*)"/) || [])[1] || 'text').toLowerCase();
    if (['submit', 'button', 'image'].indexOf(type) >= 0) continue;
    if (type === 'checkbox' && !/\bchecked\b/i.test(tag)) continue;
    fields.push([name, decodeEntities((tag.match(/\bvalue="([^"]*)"/) || [])[1] || '')]);
  }
  return { fields };
}

/* 按「条目区块」读购物车：每个 quantityBox 后面紧跟的就是本条目自己的信息，
   这样不会误抓推荐位里邻居商品的库存。
   注意（2026-09-25 修正）：亚马逊把「Only N left in stock」写在**标题下方**，
   也就是 quantityBox **之前**约 6-7 千字符处，不是之后。早期版本只在之后找，
   导致 leftInStock 永远为 null（实测 17 个商品命中 0 个），白白丢掉了最可信的那档数字。
   现在两侧都找，但仍用「上一个 data-asin 的位置」把搜索框在本条目内，不越界到邻居条目。 */
function readCartItems(cartHtml) {
  const items = [];
  for (const m of cartHtml.matchAll(/<input\b[^>]*name="quantityBox"[^>]*>/gi)) {
    const idx = m.index;
    const val = parseInt((m[0].match(/\bvalue="(\d+)"/) || [])[1] || '', 10);
    const aria = decodeEntities((m[0].match(/aria-label="([^"]*)"/) || [])[1] || '');
    const back = cartHtml.slice(Math.max(0, idx - 80000), idx);
    const as = [...back.matchAll(/data-asin="([A-Z0-9]{10})"/g)];
    /* 本条目区块的起点：最后一个 data-asin 的位置；找不到就退回到 20000 字符前 */
    const blockStart = as.length ? Math.max(0, (idx - 80000) + as[as.length - 1].index) : Math.max(0, idx - 20000);
    const own = cartHtml.slice(blockStart, idx + 8000).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const mOnly = own.match(/only\s+([\d,]+)\s+left in stock/i);
    const mOf = own.match(/only\s+([\d,]+)\s+of these available/i);
    const mLimit = own.match(/limit\s+of\s+([\d,]+)\s+per customer/i)
      || own.match(/limit\s+([\d,]+)\s+per customer/i);
    if (!isNaN(val)) items.push({
      val, aria,
      nearAsin: as.length ? as[as.length - 1][1] : '',
      leftInStock: mOnly ? parseInt(mOnly[1].replace(/,/g, ''), 10) : null,
      ofThese: mOf ? parseInt(mOf[1].replace(/,/g, ''), 10) : null,
      perCustomer: mLimit ? parseInt(mLimit[1].replace(/,/g, ''), 10) : null
    });
  }
  return items;
}

/* 清空探针加进去的条目。必须带 anti-csrftoken-a2z，否则静默失败。 */
async function clearProbedCart(cartHtml) {
  const ids = [...new Set([...cartHtml.matchAll(/name="submit\.delete-active\.([0-9a-f-]{8,})"/gi)].map(m => m[1]))];
  if (!ids.length) return 0;
  const csrf = (cartHtml.match(/name="anti-csrftoken-a2z"\s+value="([^"]+)"/i) || [])[1] || '';
  const h = chromeHeaders(0);
  h['Cookie'] = cookieHeader();
  h['Content-Type'] = 'application/x-www-form-urlencoded';
  h['Referer'] = 'https://www.amazon.com/gp/cart/view.html';
  h['Origin'] = 'https://www.amazon.com';
  h['Sec-Fetch-Site'] = 'same-origin';
  h['anti-csrftoken-a2z'] = csrf;
  const body = new URLSearchParams();
  body.append('anti-csrftoken-a2z', csrf);
  for (const id of ids) body.append('submit.delete-active.' + id, 'Delete');
  const r = await http('https://www.amazon.com/cart/ref=ord_cart_shr?app-nav-type=none&dc=df', { method: 'POST', headers: h, body: body.toString(), redirect: 'follow' }, 20000);
  absorbCookies(r.res);
  return ids.length;
}

async function probeStock(asin, productHtml, title, pageLimit) {
  const out = { probed: false };
  try {
    await setUsZip(process.env.ZIP || '10001');
    const form = extractAtcForm(productHtml || '');
    if (!form) { out.error = 'no_atc_form'; return out; }
    const csrf = (form.fields.find(f => f[0] === 'anti-csrftoken-a2z') || [])[1] || '';
    const formAsin = (form.fields.find(f => /\[asin\]$/.test(f[0])) || [])[1] || '';
    const offerId = (form.fields.find(f => /\[offerListingId\]$/.test(f[0])) || [])[1] || '';
    out.formAsin = formAsin;
    /* 没有 asin / offerListingId = 亚马逊没给这个会话展示买箱，探针做不了 */
    if (!formAsin || !offerId) { out.error = 'no_buybox'; return out; }

    const body = new URLSearchParams();
    for (const f of form.fields) body.append(f[0], /\[quantity\]$/.test(f[0]) ? String(PROBE_QTY) : f[1]);
    body.set('submit.add-to-cart', 'Add to cart');
    const h = chromeHeaders(0);
    h['Cookie'] = cookieHeader();
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    h['Referer'] = `https://www.amazon.com/dp/${asin}`;
    h['Origin'] = 'https://www.amazon.com';
    h['Sec-Fetch-Site'] = 'same-origin';
    h['anti-csrftoken-a2z'] = csrf;
    const post = await http('https://www.amazon.com/cart/add-to-cart/ref=dp_start-bbf_1_glance', { method: 'POST', headers: h, body: body.toString(), redirect: 'follow' }, 25000);
    absorbCookies(post.res);
    out.postStatus = post.status;
    /* 亚马逊会在加购响应里用原话说明为什么被夹紧 —— 这是最权威的判据，先收着 */
    out.atcEvidence = extractAtcEvidence(post.text);
    if (post.status !== 200) { out.error = 'post_' + post.status; return out; }

    /* 关键：POST 响应里没有 quantityBox，必须再单独 GET 一次购物车页。
       购物车页偶尔会被验证码拦（实测云端 20 次里约 3 次）。被拦时重建会话再试一次 ——
       重新预热会换一批 Cookie，通常就能过；还不行就如实记 blocked，不硬编数据。 */
    let cart = await http('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', { headers: Object.assign({}, chromeHeaders(0), { Cookie: cookieHeader(), 'Sec-Fetch-Site': 'same-origin' }), redirect: 'follow' }, 25000);
    absorbCookies(cart.res);
    if (/api-services-support@amazon\.com|Enter the characters you see below/i.test(cart.text || '')) {
      await warmSession(1);
      await new Promise(s => setTimeout(s, 2500));
      const ch2 = chromeHeaders(1);
      ch2['Cookie'] = cookieHeader();
      ch2['Sec-Fetch-Site'] = 'same-origin';
      cart = await http('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', { headers: ch2, redirect: 'follow' }, 25000);
      absorbCookies(cart.res);
      out.probeRetried = true;
      if (/api-services-support@amazon\.com|Enter the characters you see below/i.test(cart.text || '')) { out.error = 'blocked_after_retry'; return out; }
    }

    const items = readCartItems(cart.text || '');
    /* 认领自己那一条，按可靠度依次尝试：
       ① 条目里的 data-asin 命中本次加购的 ASIN（或买箱实际指向的变体子 ASIN）—— 最可靠
       ② 条目 aria-label 里含商品标题前 40 字 —— 标题带变体后缀时可能不匹配
       ③ 购物车里只有一条 —— 就是它
       三条都不中说明前一个商品的条目没删干净、购物车串了，如实报 no_match 而不是瞎取。 */
    const mine = items.find(x => x.nearAsin && (x.nearAsin === formAsin || x.nearAsin === asin))
      || items.find(x => x.aria && title && x.aria.toLowerCase().indexOf(String(title).slice(0, 40).toLowerCase()) >= 0)
      || (items.length === 1 ? items[0] : null);
    out.cartItems = items.map(x => ({ asin: x.nearAsin, box: x.val, only: x.leftInStock, limit: x.perCustomer }));

    /* 加购响应、购物车页两处都搜一遍亚马逊的原话，取得到就用它定性 */
    const atcHint = pickEvidence(out.atcEvidence, mine ? mine.val : null)
      || pickEvidence(extractAtcEvidence(cart.text || ''), mine ? mine.val : null);

    if (mine && mine.leftInStock != null) {
      /* 最高可信度：亚马逊自己在购物车条目里写了 only N left in stock —— 这就是库存 */
      out.probed = true; out.kind = 'stock'; out.qty = mine.leftInStock;
      out.basis = 'cart_only_n_left'; out.confidence = 'high';
      out.raw = '购物车条目里亚马逊原话 only N left in stock';
    } else if (mine) {
      out.probed = true;
      const N = mine.val;
      if (atcHint && atcHint.kind === 'available' && N === atcHint.qty) {
        /* ★ 最权威的一条：亚马逊在加购响应里**自己说**「你选的这个卖家只有 N 件可售」。
           对照验证：B0C743SY46 这里拿到 17，而它商品页也写着 Only 17 left in stock → 就是库存。 */
        out.kind = 'stock'; out.qty = N;
        out.basis = 'atc_seller_available'; out.confidence = 'high';
        out.raw = `亚马逊加购响应原话「than the ${N} available from the seller you've selected」→ 卖家可售数量就是库存`;
      } else if ((atcHint && atcHint.kind === 'limit' && N === atcHint.qty)
              || (mine.perCustomer != null && mine.perCustomer === N)
              || (pageLimit && pageLimit.qty === N)) {
        /* 亚马逊自己写了 limit N per customer —— 明示的限购，不是库存。
           basis 如实标出这句话出现在哪儿，前端提示里会写清楚。 */
        const fromAtc = !!(atcHint && atcHint.kind === 'limit' && N === atcHint.qty);
        out.kind = 'purchase_limit'; out.qty = N;
        out.basis = fromAtc ? 'atc_limit' : 'per_customer_limit'; out.confidence = 'high';
        out.raw = fromAtc
          ? `亚马逊加购响应原话「limit of ${N} per customer」（明示限购）`
          : (mine.perCustomer != null && mine.perCustomer === N
              ? '购物车里亚马逊原话「limit N per customer」'
              : `商品页亚马逊原话「limit ${N} per customer」`);
      } else if (N >= PROBE_QTY) {
        out.kind = 'stock'; out.qty = PROBE_QTY; out.ge = true;
        out.basis = 'probe_ge'; out.confidence = 'high';
        out.raw = `可接受 ${PROBE_QTY} 件，实际库存 ≥ ${PROBE_QTY}`;
      } else if (pageLimit && pageLimit.qty > N) {
        /* 页面明示限购 M 件，但这次只让买更少 —— 卡住它的是库存而不是限购 */
        out.kind = 'stock'; out.qty = N;
        out.basis = 'atc_seller_available'; out.confidence = 'medium';
        out.raw = `亚马逊写着限购 ${pageLimit.qty} 件，但本次只允许买 ${N} 件 → 卡住它的是库存（可售 ${N} 件）`;
      } else {
        /* 亚马逊把数量夹到了 N，但没有给出任何说明文字。
           此时 N 的准确含义是「一次最多能买 N 件」——
           可能是库存（库存不足所以夹住），也可能是单笔上限（亚马逊有时不打印任何文案）。
           两种情况 N 都是可信的硬事实，但**不能断言是库存**，所以 basis 单独标出来，
           前端显示成「最多 N 件」而不是「库存 N 件」。
           ★ 上一版在这里做了一条「N ≤ 20 且没打印 Only N left ⇒ 判为限购」的推断，
             2026-09-25 被用户实测证伪（B0HHXD8SHF 夹到 2，实际是库存 2，
             亚马逊原话 "the 2 available from the seller"）。所以推断整条删掉了：
             宁可能力弱一点，也不能把库存说成限购。 */
        out.kind = 'stock'; out.qty = N;
        out.basis = 'max_purchasable'; out.confidence = 'medium';
        out.raw = `加购 ${PROBE_QTY} 件被亚马逊夹紧到 ${N}（未写 only N left，无法区分「库存只剩 N」和「单笔上限 N」）`;
      }
    } else {
      out.error = items.length ? 'no_match_in_cart(' + items.length + ')' : 'cart_empty_after_add';
    }
    await clearProbedCart(cart.text || '');
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}

const args = process.argv.slice(2);
const argVal = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const LIMIT = argVal('--limit') ? Number(argVal('--limit')) : 0;
const ONLY_ASIN = argVal('--asin');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function todayStr(d) {
  // 按北京时间（UTC+8）记日期，避免夜晚运行时日期比实际早一天
  const dt = d ? new Date(d) : new Date();
  const bj = new Date(dt.getTime() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
}

/* ---------------- 抓取：三种模式 ---------------- */
async function http(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
    clearTimeout(timer);
    return { ok: r.ok, status: r.status, text: await r.text(), res: r };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String(e && e.message || e), res: null };
  }
}

/* 备援页面地址：验证码时轮换尝试不同入口 */
function urlVariants(asin) {
  return [
    `https://www.amazon.com/dp/${asin}?th=1&language=en_US`,
    `https://www.amazon.com/gp/product/${asin}?language=en_US&psc=1`,
    `https://www.amazon.com/dp/${asin}/ref=dp_prsubs_1?language=en_US`
  ];
}

async function fetchHtml(asin, idx) {
  const url = urlVariants(asin)[idx % 3];
  if (SCRAPER_MODE === 'jina') {           // 免费额度：r.jina.ai（可在 GitHub Actions 上直连）
    const r = await http(`https://r.jina.ai/${url}`, { headers: { 'X-Return-Format': 'html' } }, 40000);
    return Object.assign({ via: 'jina', url }, r);
  }
  if (SCRAPER_MODE === 'scrapingbee' && SCRAPER_KEY) {  // 免费 1000 次/月
    const api = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render_js=false&premium_proxy=true`;
    const r = await http(api, {}, 45000);
    return Object.assign({ via: 'scrapingbee', url }, r);
  }
  // direct：会话预热后的 Cookie + 完整浏览器指纹头
  await warmSession(idx);
  /* 必须在抓商品页之前就把收货邮编设成美国。否则「不发中国」的商品亚马逊不展示买箱，
     会被误判成 no_offer（实测 B08FB3FLF2 就是这样），连加购探针都跑不了。 */
  await setUsZip(process.env.ZIP || '10001');
  const h = chromeHeaders(idx);
  h['Cookie'] = cookieHeader();
  h['Referer'] = 'https://www.amazon.com/';
  h['Sec-Fetch-Site'] = 'same-origin';
  const r = await http(url, { headers: h, redirect: 'follow' }, 30000);
  absorbCookies(r.res);
  return Object.assign({ via: 'direct', url }, r);
}

/* ---------------- 解析 ---------------- */
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
}

function moneyOf(s) {
  const n = parseFloat(String(s == null ? '' : s).replace(/[^\d.]/g, ''));
  return isFinite(n) ? n : null;
}

/*
 * 售价提取：多级回退，并且**显式避开「单价 / 每件价」陷阱**。
 *
 * 背景（2026-09 实测 B09PTH84M7，4 件装真价 $37.99）：
 *   价格主区块 #corePriceDisplay_desktop_feature_div 里，priceToPay 的
 *   <span class="a-offscreen"></span> 是**空的**，紧随其后的第一个非空
 *   a-offscreen 其实是单价 apex-priceperunit-value（$9.50 = 37.99/4）。
 *   早期版本「取区块里第一个非空 a-offscreen」会把 $37.99 抓成 $9.50。
 *   因此这里只认「价签型」来源，绝不取裸 a-offscreen。
 */
function extractPrice(html) {
  const res = { price: null, src: null, unitPrice: null, unitLabel: null, savingsPct: null };

  // ① 买箱价格 JSON（Twister 数据块）—— 只含当前选中变体的成交价，最权威
  let m = html.match(/twister-plus-buying-options-price-data[^>]*>\s*(\{[\s\S]{0,8000}?\})\s*<\//);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      const key = Object.keys(j).find(k => /buybox_group/i.test(k)) || Object.keys(j)[0];
      const arr = j[key];
      const first = Array.isArray(arr) ? arr[0] : arr;
      if (first) {
        if (first.priceAmount != null && isFinite(Number(first.priceAmount))) { res.price = Number(first.priceAmount); res.src = 'buybox_json'; }
        else if (first.displayPrice) { res.price = moneyOf(first.displayPrice); res.src = 'buybox_json'; }
      }
    } catch (e) {}
  }

  // ② 加购表单里的「顾客实际支付价」
  if (res.price == null) {
    m = html.match(/customerVisiblePrice\]\[amount\]"\s+value="([\d.]+)"/);
    if (m) { res.price = parseFloat(m[1]); res.src = 'cart_form'; }
  }

  // ③ 价格主区块：只认价签（priceToPay / accessibility label）
  const idx = html.indexOf('corePriceDisplay_desktop_feature_div');
  const seg = idx >= 0 ? html.slice(idx, idx + 16000) : html;
  if (res.price == null) {
    m = seg.match(/apex-pricetopay-accessibility-label[^>]*>\s*(?:US)?\s*\$([\d,]+\.\d{2})/);
    if (m) { res.price = moneyOf(m[1]); res.src = 'apex_pricetopay_label'; }
  }
  if (res.price == null) {
    m = seg.match(/class="a-price[^"]*priceToPay[^"]*"[\s\S]{0,1200}?class="a-price-whole">\s*([\d,]+)[\s\S]{0,300}?class="a-price-fraction">\s*(\d{1,2})/);
    if (m) { res.price = moneyOf(m[1] + '.' + String(m[2]).padEnd(2, '0')); res.src = 'apex_pricetopay_value'; }
  }

  // ④ 全局 JSON 兜底
  if (res.price == null) {
    m = html.match(/"priceAmount"\s*:\s*([\d,]+\.\d{2})/);
    if (m) { res.price = moneyOf(m[1]); res.src = 'json_priceAmount'; }
  }
  if (res.price == null) {
    m = html.match(/"displayPrice"\s*:\s*"(?:US)?\s*\$([\d,]+\.\d{2})"/);
    if (m) { res.price = moneyOf(m[1]); res.src = 'json_displayPrice'; }
  }

  // 单价（每件 / 每盎司）：只作参考展示，绝不当作售价
  m = html.match(/apex-priceperunit-value[\s\S]{0,300}?a-offscreen">\s*(?:US)?\$([\d,]+\.\d{2})/);
  if (m) {
    res.unitPrice = moneyOf(m[1]);
    const l = html.match(/pricePerUnit">\s*\([\s\S]{0,300}?<\/span>\s*\/\s*([^)<]{1,24})\)/);
    res.unitLabel = l ? l[1].trim() : 'unit';
  }

  // 折扣百分比（如 -5%）
  m = html.match(/apex-savings-percentage">\s*-?\s*([\d.]+)\s*%/);
  if (m) res.savingsPct = Number(m[1]);

  return res;
}

/*
 * 库存 / 限购提取：**只看「买箱」和「availability」两块官方区域**。
 *
 * 为什么不能全文搜索「Only N left in stock」：
 *   页面下方有「Customers who viewed this item also viewed」等推荐轮播，
 *   里面每个邻居商品都可能带「Only 13 left in stock - order soon」，
 *   全文搜会把邻居的库存当成这个商品的库存。
 *
 * 为什么不能再用 indexOf('add-to-cart-button') 当锚点：
 *   页面里第一个 add-to-cart-button 出现在**导航栏的键盘快捷键面板**
 *   （"Add to cart  shift+alt+K"），真正的加购按钮在 16 万字符之后。
 *   老写法等于在菜单里找库存，实际从未命中过。
 */
const STOCK_STOP = ['p13n-sc-', 'a-carousel-card', 'id="similarities_feature_div"', 'id="sp_detail', 'id="HLCXComparisonWidget'];

/* 精确找 id="xxx" 元素：前一个字符必须是空白。
   直接 indexOf('id="availability"') 会命中标签属性里的 data-csa-c-content-id="availability"，
   切片会从属性中间开始，导致后续去标签全部失效。 */
function findByIdAttr(html, id) {
  const needle = 'id="' + id + '"';
  for (let i = html.indexOf(needle); i >= 0; i = html.indexOf(needle, i + 1)) {
    if (i === 0 || /\s/.test(html[i - 1])) return i;
  }
  return -1;
}
function sliceFrom(html, start, maxLen) {
  if (start == null || start < 0) return '';
  let end = Math.min(html.length, start + maxLen);
  for (const s of STOCK_STOP) {
    const j = html.indexOf(s, start);
    if (j >= 0 && j < end) end = j;
  }
  return html.slice(start, end);
}
function stripTags(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[a-z-]+="[^"]*"/gi, ' ')   // 兜底：清掉残留的属性文本
    .replace(/\s+/g, ' ').trim();
}

function extractStock(html, price) {
  const out = { stock: { kind: 'unknown' }, purchaseLimit: null, availabilityText: null };

  // 真实的 availability 元素（亚马逊官方放「仅剩 N 件」的地方）
  const avRaw = sliceFrom(html, findByIdAttr(html, 'availability'), 3000);
  const avMsgRaw = (avRaw.match(/primary-availability-message[^>]*>([^<]{1,80})</) || [])[1];
  const avText = (avMsgRaw || stripTags(avRaw)).replace(/\s+/g, ' ').trim().replace(/^[>》»·•\s-]+/, '');
  out.availabilityText = (/^[\w-]+=/.test(avText) || avText.length < 3) ? null : (avText.slice(0, 90) || null);

  // 真实的买箱容器（不能用 indexOf('add-to-cart-button')，页面第一个是导航栏快捷键面板）
  let bbStart = findByIdAttr(html, 'desktop_buybox');
  if (bbStart < 0) bbStart = findByIdAttr(html, 'qualifiedBuybox');
  const bbText = stripTags(sliceFrom(html, bbStart, 60000));

  const hay = (avText + ' ' + bbText).replace(/\s+/g, ' ');

  // ① 仅剩 N 件（亚马逊官方文案，最高优先）
  let m = hay.match(/Only\s+([\d,]+)\s+left in stock/i);
  if (m) {
    out.stock = { kind: 'stock', qty: parseInt(m[1].replace(/,/g, ''), 10), source: 'amazon_page', note: '亚马逊页面原话「Only N left in stock」' };
  } else if (/Currently unavailable|Temporarily out of stock/i.test(hay)) {
    out.stock = { kind: 'unavailable', source: 'amazon_page' };
  } else if (/In Stock|Usually ships within/i.test(hay)) {
    out.stock = { kind: 'in_stock_no_qty', source: 'amazon_page' };
  } else if (price == null && /all-offers-display/.test(avRaw)) {
    // availability 容器是空的，又没有主报价 → 亚马逊根本没展示购买框
    out.stock = { kind: 'no_offer', source: 'amazon_page' };
  } else if (price != null) {
    out.stock = { kind: 'in_stock_no_qty', source: 'amazon_page' };
  }

  // 限购（同样限定在官方两个区域内，避免误取推荐位）
  m = hay.match(/limit\s+([\d,]+)\s+(?:units\s+)?per\s+(?:customer|order)/i);
  if (m) out.purchaseLimit = { qty: parseInt(m[1].replace(/,/g, ''), 10), source: 'amazon_page' };

  return out;
}

function parseAmazon(html, asin) {
  const out = { ok: true, price: null, currency: null, rating: null, reviews: null, bsr: [], bsrSmall: null, bsrLarge: null, stock: { kind: 'unknown' }, purchaseLimit: null, title: null, image: null, realAsin: asin, captcha: false };
  if (/Enter the characters you see below|api-services-support@amazon\.com|Robot Check/i.test(html)) {
    out.captcha = true; out.ok = false; out.error = 'CAPTCHA'; return out;
  }
  let m = html.match(/id="productTitle"[^>]*>\s*([^<]+?)\s*</);
  if (m) out.title = decodeEntities(m[1]).trim();
  m = html.match(/"parentAsin"\s*:\s*"([A-Z0-9]{10})"/) || html.match(/[?&]asin=([A-Z0-9]{10})/);
  if (m) out.realAsin = m[1];
  m = html.match(/"hiRes"\s*:\s*"(https:[^"]+\.(?:jpg|png))"/i) || html.match(/id="landingImage"[^>]*data-old-hires="(https:[^"]+)"/);
  if (m) out.image = m[1];

  // 售价：多级回退 + 显式避开「单价 / 每件价」陷阱（详见 extractPrice 注释）
  const pr = extractPrice(html);
  out.price = pr.price;
  out.priceSource = pr.src;
  out.unitPrice = pr.unitPrice;
  out.unitLabel = pr.unitLabel;
  out.savingsPct = pr.savingsPct;
  if (out.price != null) out.currency = 'USD';

  // 划线价（List Price）用于对照当前售价是否处于促销
  let lp = html.match(/apex-basisprice-offscreen-label[^>]*>\s*List Price:\s*(?:US)?\$([\d,]+\.\d{2})/);
  if (!lp) lp = html.match(/"basisPrice"\s*:\s*"?(?:US)?\$([\d,]+\.\d{2})/);
  if (!lp) lp = html.match(/apex-basisprice-value[\s\S]{0,300}?a-offscreen">\s*(?:US)?\$([\d,]+\.\d{2})/);
  if (!lp) lp = html.match(/class="a-text-price"[\s\S]{0,300}?a-offscreen">\s*(?:US)?\$([\d,]+\.\d{2})/);
  if (lp) out.listPrice = moneyOf(lp[1]);

  /* 评分只认商品自己的 #acrPopover。
     ★ 绝对不要再退回「全页搜 `N out of 5 stars`」——
       零评分的商品页里，下方「看了又看 / 相关商品 / 广告位」有**大量别家商品的星级**，
       全页搜会让一个根本没评分的商品凭空多出 5 星（2026-09-25 用户实测踩到 B0HHXD8SHF）。
       实测：有评分的商品页里 id="acrPopover" 出现 2 次（桌面版 + 移动版，值相同）；
       没评分的商品页里是 0 次 —— 这个 id 就是最干净的判据。*/
  const acrTag = (html.match(/<[^>]*\bid="acrPopover"[^>]*>/) || [])[0] || '';
  const am = acrTag.match(/\btitle="\s*([\d.]+)\s+out of 5 stars/) || acrTag.match(/([\d.]+)\s+out of 5 stars/);
  if (am) out.rating = parseFloat(am[1]);
  out.hasRatingWidget = !!acrTag;

  m = html.match(/id="acrCustomerReviewText"[^>]*aria-label="\s*([\d,]+)\s*(?:Reviews?|ratings?)/i) ||
      html.match(/aria-label="\s*([\d,]+)\s*(?:Reviews?|ratings?)[^"]*"[^>]*id="acrCustomerReviewText"/i) ||
      html.match(/id="acrCustomerReviewText"[^>]*>\s*\(?\s*([\d,]+)\s*(?:ratings(?:\s*reviews)?|reviews)?\s*\)?\s*</i);
  if (m) out.reviews = parseInt(m[1].replace(/,/g, ''), 10);

  const bsrSec = (html.match(/Best Sellers Rank[\s\S]{0,3000}/) || [])[0] || '';
  const re = /#([\d,]+)\s+in\s+(?:<[^>]+>)?\s*([A-Za-z0-9 &,'’\-]+)/g;
  let bm; const list = [];
  while ((bm = re.exec(bsrSec)) && list.length < 10) {
    list.push({ rank: parseInt(bm[1].replace(/,/g, ''), 10), label: bm[2].trim().replace(/\s*\(.*/, '') });
  }
  if (list.length) {
    out.bsr = list;
    out.bsrLarge = list[0];
    out.bsrSmall = list.reduce((a, b) => (b.rank < a.rank ? b : a), list[0]);
  }

  // ---- 库存 / 限购：只看「买箱」和「availability」两块官方区域 ----
  const st = extractStock(html, out.price);
  out.stock = st.stock;
  out.purchaseLimit = st.purchaseLimit;
  out.availabilityText = st.availabilityText;

  // 近一月销量：亚马逊公开的动销信号，用来替代「靠库存推算竞品销量」
  m = html.match(/([\d,.]+)\s*(K)?\+?\s*bought in past month/i) || html.match(/"boughtInPastMonth"\s*:\s*"?(\d+)/i);
  if (m) {
    let v = parseFloat(String(m[1]).replace(/,/g, ''));
    if (m[2]) v = v * 1000;
    out.boughtPastMonth = Math.round(v);
  }

  return out;
}

/* ---------------- 主流程 ---------------- */
const products = readJSON(PRODUCTS_FILE, []);
let history = readJSON(HISTORY_FILE, {});
const date = todayStr();
if (!history[date]) history[date] = {};

let list = products;
let productsMetaDirty = false;   // 采集过程中若有自动补全的名称，需要回写 products.json
if (ONLY_ASIN) list = list.filter(p => p.asin.toUpperCase() === ONLY_ASIN.toUpperCase());
if (LIMIT) list = list.slice(0, LIMIT);

// 当天数据已全部成功且非强制运行时跳过（避免第二次定时任务把第一次的快照冲掉）
const FORCE = process.env.FORCE === '1';
if (!FORCE && !ONLY_ASIN && !LIMIT && list.length && list.every(p => history[date][p.asin] && history[date][p.asin].ok)) {
  console.log(`今天（${date}）的数据已全部采集成功，跳过本次运行。如需强制重采，手动 Run workflow 即可。`);
  process.exit(0);
}

console.log(`开始采集 ${list.length} 个商品 · 模式=${SCRAPER_MODE} · 日期=${date}${FORCE ? ' · 强制重采' : ''}`);
const t0 = Date.now();
let ok = 0, fail = 0;
const lines = [];

const BACKOFF = [3000, 9000, 18000];

/* 把探针结果落到记录上。basis 说明这个数字是怎么来的，前端据此决定措辞：
     cart_only_n_left     = 购物车里亚马逊原话「Only N left in stock」（最可信，就是库存）
     atc_seller_available = 加购响应里亚马逊原话「the N available from the seller」→ 卖家可售数量 = 库存
     per_customer_limit   = 亚马逊自己写了 limit N per customer（商品页 / 购物车）→ 限购
     atc_limit            = 同上，但那句话出现在加购响应里 → 限购
     probe_ge             = 加购 999 被完整接受，只能说 ≥999
     max_purchasable      = 被夹到 N 但亚马逊没给任何说明 → 只能说「一次最多能买 N 件」
   confidence：high = 亚马逊自己写明的；medium = 只有夹紧值，没有说明文字
   ★ 曾经有过一个 inferred_limit（靠「没打印 low-stock 文案」反推限购），2026-09-25 被用户实测证伪，已删。 */
function applyProbeResult(rec, pr, asin) {
  const conf = pr.confidence || 'high';
  rec.stock = {
    kind: pr.kind, qty: pr.qty, source: 'cart_probe',
    basis: pr.basis || 'max_purchasable', confidence: conf,
    note: pr.basis === 'cart_only_n_left' ? '购物车里亚马逊原话「Only N left in stock」'
      : pr.basis === 'atc_seller_available'
        ? `库存 ${pr.qty}：亚马逊加购响应里原话「than the ${pr.qty} available from the seller you've selected」—— 卖家可售数量`
        : pr.basis === 'probe_ge' ? `库存 ≥ ${pr.qty}（加购 ${PROBE_QTY} 件被亚马逊接受）`
          : (pr.basis === 'per_customer_limit' || pr.basis === 'atc_limit')
            ? `亚马逊自己写明的单笔限购上限 ${pr.qty} 件（不是库存）`
            : `加购 ${PROBE_QTY} 件被亚马逊夹紧到 ${pr.qty}；此数是「一次最多能买 N 件」，亚马逊没给出说明文字，无法确定是库存还是单笔上限`
  };
  rec.stockProbeRaw = pr.raw || null;
  if (pr.probeRetried) rec.stockProbeRetried = true;
  if (pr.formAsin && pr.formAsin !== asin) rec.stockProbeVariantAsin = pr.formAsin;
  delete rec.stockProbeError;
  return conf;
}
/* 探针没取到的商品攒起来，主循环跑完再换会话补一轮 */
const probeRetry = [];

for (const p of list) {
  let lastErr = null, rec = null, pageHtml = '';
  for (let attempt = 0; attempt < 3 && !rec; attempt++) {
    const ts = Date.now();
    const r = await fetchHtml(p.asin, attempt);
    const blocked = !r.ok || !r.text || /Enter the characters you see below|api-services-support@amazon\.com|Robot Check/i.test(r.text);
    if (!blocked) {
      pageHtml = r.text || '';
      const parsed = parseAmazon(r.text, p.asin);
      rec = {
        asin: p.asin, realAsin: parsed.realAsin, title: parsed.title,
        price: parsed.price, currency: parsed.currency,
        priceSource: parsed.priceSource || null, listPrice: parsed.listPrice ?? null,
        unitPrice: parsed.unitPrice ?? null, unitLabel: parsed.unitLabel || null,
        savingsPct: parsed.savingsPct ?? null,
        rating: parsed.rating, reviews: parsed.reviews,
        bsrSmall: parsed.bsrSmall, bsrLarge: parsed.bsrLarge,
        stock: parsed.stock, purchaseLimit: parsed.purchaseLimit, boughtPastMonth: parsed.boughtPastMonth ?? null,
        availabilityText: parsed.availabilityText ?? null,
        image: parsed.image, ok: parsed.ok, error: parsed.error || null,
        captcha: parsed.captcha, source: r.via, fetchedAt: new Date().toISOString(),
        timingMs: Date.now() - ts
      };
    } else {
      lastErr = /Robot Check|Enter the characters|api-services-support/i.test(r.text || '') ? 'CAPTCHA'
        : (r.error || ('HTTP ' + (r.status || '')));
    }
    if (!rec && attempt < 2) await new Promise(s => setTimeout(s, BACKOFF[attempt]));
  }
  if (!rec) rec = { asin: p.asin, ok: false, error: lastErr || 'UNKNOWN', captcha: lastErr === 'CAPTCHA', stock: { kind: 'unknown' }, source: SCRAPER_MODE, fetchedAt: new Date().toISOString() };

  // 保留手工补录库存（需在 data/manual-stock.json 维护，或直接编辑 history.json）
  const prev = history[date][p.asin];
  if (prev && prev.stock && prev.stock.source === 'manual' && rec.stock.kind === 'unknown') rec.stock = prev.stock;

  /* 库存探针：跑一遍「模拟加购直到无法添加」，拿页面不肯给的精确库存数。
     只在页面没给出确切数字时才跑（页面已写 Only N left 的商品不必重复付出请求成本）；
     no_offer / unavailable 没有买箱，探针做不了，直接跳过。 */
  const probeNeeded = ['in_stock_no_qty', 'unknown'].includes((rec.stock || {}).kind);
  if (rec.ok && PROBE_ON && probeNeeded && pageHtml) {
    const pr = await probeStock(p.asin, pageHtml, rec.title || '', rec.purchaseLimit || null);
    if (pr.probed) {
      const conf = applyProbeResult(rec, pr, p.asin);
      console.log(`    [库存探针] ${p.asin} → ${pr.kind} ${pr.qty} 件 [${pr.basis}/${conf}]${pr.probeRetried ? '(重试后取到)' : ''}（${pr.raw || ''}）${pr.formAsin && pr.formAsin !== p.asin ? ' · 买箱其实是变体 ' + pr.formAsin : ''}`);
    } else {
      rec.stockProbeError = pr.error || 'unknown';
      probeRetry.push({ asin: p.asin, title: rec.title || '' });
      console.log(`    [库存探针] ${p.asin} 未取到 · ${pr.error || '-'}（已排队收尾补采）`);
    }
    await new Promise(s => setTimeout(s, 1200));
  }

  // 价格合理性校验：products.json 里可给每个 ASIN 设 priceMin / priceMax
  if (rec.ok && rec.price != null) {
    const mn = Number(p.priceMin), mx = Number(p.priceMax);
    if ((p.priceMin != null && rec.price < mn) || (p.priceMax != null && rec.price > mx)) {
      rec.priceOutOfRange = true;
      rec.priceNote = `超出预期区间 ${p.priceMin ?? '-'} ~ ${p.priceMax ?? '-'}（可能买箱换到变体/其他卖家报价）`;
    }
  }

  if (rec.ok) {
    ok++;
    if (rec.title && !rec.title.includes('（')) p.latestTitle = rec.title;
    // 商品名称为空时，用抓到的亚马逊标题自动补全（方便在网页端直接新增商品，无需手填名称）
    if (!p.name && rec.title) { p.name = rec.title.slice(0, 80); productsMetaDirty = true; }
  } else fail++;
  history[date][p.asin] = rec;
  lines.push(`| ${rec.ok ? '成功' : '失败'} | ${p.asin} | ${rec.price != null ? '$' + rec.price : '—'} | ${rec.rating ?? '—'} | ${rec.reviews ?? '—'} | ${rec.bsrSmall ? '#' + rec.bsrSmall.rank : '—'} | ${rec.error || (rec.priceSource ? '价源:' + rec.priceSource : '—')} |`);
  console.log(`  ${rec.ok ? 'OK ' : 'ERR'} ${p.asin} price=${rec.price} (src=${rec.priceSource || '-'}${rec.unitPrice ? ', 单价$' + rec.unitPrice + '/' + (rec.unitLabel || 'unit') : ''}) rating=${rec.rating} reviews=${rec.reviews} bsr=${rec.bsrSmall ? rec.bsrSmall.rank : '-'} ${rec.error || ''}`);
  await new Promise(s => setTimeout(s, Math.max(2000, INTERVAL_MS)));
}

/* 收尾补采：购物车页的验证码是随机的，同一个商品换个会话往往就能过
   （实测被拦的商品每次不一样，不是商品本身的问题）。
   主循环跑完后，把探针没取到的商品重建会话再试一轮 —— 这些商品此前只有页面口径的
   状态值（"有货"），补上精确数字对库存监控的价值很大。 */
if (PROBE_ON && probeRetry.length) {
  console.log(`\n收尾补采：${probeRetry.length} 个商品的库存探针没取到，重建会话再试一轮…`);
  await new Promise(s => setTimeout(s, 20000));
  let saved = 0, stillFailed = 0;
  for (const item of probeRetry) {
    const rec = history[date][item.asin];
    if (!rec || !rec.ok) continue;
    const r = await fetchHtml(item.asin, 2);
    const blocked = !r.ok || !r.text || /Enter the characters you see below|api-services-support@amazon\.com|Robot Check/i.test(r.text);
    if (blocked) {
      console.log(`    [补采] ${item.asin} 商品页仍被拦，放弃（保留页面口径的状态值）`);
      stillFailed++; continue;
    }
    const pr = await probeStock(item.asin, r.text, item.title, rec.purchaseLimit || null);
    if (pr.probed) {
      const conf = applyProbeResult(rec, pr, item.asin);
      saved++;
      console.log(`    [补采] ${item.asin} → ${pr.kind} ${pr.qty} 件 [${pr.basis}/${conf}]（${pr.raw || ''}）`);
    } else {
      rec.stockProbeError = (pr.error || 'unknown') + '(补采)';
      stillFailed++;
      console.log(`    [补采] ${item.asin} 仍未取到 · ${pr.error || '-'}`);
    }
    await new Promise(s => setTimeout(s, 2500));
  }
  console.log(`收尾补采结束：补回 ${saved} 个，仍有 ${stillFailed} 个没取到\n`);
}

// 保留最近 3650 天
for (const d of Object.keys(history)) {
  if (Date.now() - new Date(d + 'T00:00:00Z').getTime() > 3650 * 86400000) delete history[d];
}
fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
if (productsMetaDirty) {
  fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2) + '\n');
  console.log('已回写 products.json（补全了缺失的商品名称）');
}
fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ lastRun: { date, finishedAt: new Date(Date.now()).toISOString(), total: list.length, ok, fail, ms: Date.now() - t0 }, historyDates: Object.keys(history).sort() }, null, 2));

// 输出到 Actions 摘要面板
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = `## 亚马逊每日采集结果（${date}）\n\n成功 **${ok}** / 共 **${list.length}**，失败 **${fail}**，耗时 ${Math.round((Date.now() - t0) / 1000)} 秒，模式 ${SCRAPER_MODE}\n\n| 状态 | ASIN | 售价 | 星级 | 评论数 | 小类BSR | 备注 |\n|---|---|---|---|---|---|---|\n${lines.join('\n')}\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
console.log(`完成：成功 ${ok}，失败 ${fail}，耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
