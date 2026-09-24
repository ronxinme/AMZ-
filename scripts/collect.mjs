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

/* --------- 库存探针：匿名会话加购 999，读取亚马逊给的最大可购买量 --------- */
/* 说明：全程使用一次性匿名购物车，不会触碰你登录账号的购物车；探针后尽力清空 */
const PROBE_QTY = Number(process.env.PROBE_QTY || 999);
async function probeStock(asin, idx, productHtml) {
  const out = { probed: false };
  try {
    const h = chromeHeaders(idx);
    h['Cookie'] = cookieHeader();
    h['Referer'] = `https://www.amazon.com/dp/${asin}`;

    // 从商品页取加购所需的表单字段
    const html = productHtml || '';
    let offerListingID = (html.match(/name="offerListingID"[^>]*value="([^"]+)"/) || html.match(/"offerListingID"\s*:\s*"([^"]+)"/) || [])[1] || '';
    let offeringID = (html.match(/"offeringID"\s*:\s*"([^"]+)"/) || [])[1] || '';
    const sid = COOKIE_JAR['session-id'] || COOKIE_JAR['session-id-time'] ? COOKIE_JAR['session-id'] : '';
    out.fields = { offerListingID: !!offerListingID, offeringID: !!offeringID, sid: !!sid };

    // 1) 加购 999：优先 POST 真实表单，失败再退回 GET 入口
    const addEndpoint = 'https://www.amazon.com/gp/cart/desktop/add-to-cart.html';
    const form = new URLSearchParams({
      ASIN: asin, Quantity: String(PROBE_QTY), submit_addToCart: 'Add to Cart',
      'submit.addToCart': 'Add to Cart', offerListingID, offeringID: offeringID, 'session-id': sid
    });
    const postH = Object.assign({}, h, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' });
    let addText = '';
    const p1 = await http(addEndpoint, { method: 'POST', headers: postH, body: form.toString(), redirect: 'follow' }, 25000);
    absorbCookies(p1.res);
    addText += p1.text || '';
    if (!p1.ok || !addText) {
      for (const u of [
        `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=${PROBE_QTY}`,
        `https://www.amazon.com/gp/cart/desktop/add-to-cart.html?ASIN=${asin}&Quantity=${PROBE_QTY}&submit.addToCart=1`
      ]) {
        const r = await http(u, { headers: h, redirect: 'follow' }, 25000);
        absorbCookies(r.res);
        if (r.text) { addText += r.text; if (r.ok) break; }
      }
    }
    out.addStatus = p1.status;
    // 2) 读购物车页面确认实际数量
    const cart = await http('https://www.amazon.com/gp/cart/view.html?ref_=nav_cart', { headers: h, redirect: 'follow' }, 25000);
    absorbCookies(cart.res);
    const t = addText + '\n' + (cart.text || '');

    // 3) 解析数量信号
    let m = t.match(/only\s+([\d,]+)\s+of\s+these\s+available/i) || t.match(/only\s+([\d,]+)\s+left\s+in\s+stock/i);
    if (m) { out.probed = true; out.kind = 'stock'; out.qty = parseInt(m[1].replace(/,/g, ''), 10); out.raw = m[0]; }
    if (!out.probed) {
      m = t.match(/limit\s+(?:of\s+)?([\d,]+)\s+(?:units\s+)?per\s+customer/i) || t.match(/maximum\s+(?:order\s+)?quantity\s+of\s+([\d,]+)/i);
      if (m) { out.probed = true; out.kind = 'purchase_limit'; out.qty = parseInt(m[1].replace(/,/g, ''), 10); out.raw = m[0]; }
    }
    if (!out.probed) {
      // 购物车里的数量输入框：若被压到 N（< 999），说明可购买上限就是 N
      const qty = [...t.matchAll(/name="quantity[^"]*"[^>]*value="([\d,]+)"/g)].map(x => parseInt(x[1].replace(/,/g, ''), 10));
      const capped = qty.filter(v => v > 0 && v < PROBE_QTY);
      if (capped.length) { out.probed = true; out.kind = 'stock'; out.qty = Math.max(...capped); out.raw = 'cart quantity input'; }
      else if (qty.some(v => v >= PROBE_QTY)) { out.probed = true; out.kind = 'stock'; out.qty = PROBE_QTY; out.ge = true; out.raw = `可接受 ${PROBE_QTY} 件，实际库存 ≥ ${PROBE_QTY}`; }
    }
    if (!out.probed && /not enough inventory|out of stock|currently unavailable/i.test(t)) {
      out.probed = true; out.kind = 'unavailable';
    }
    // 调试信息（写入 Actions 日志，便于定位探针命中情况）
    const ct = (cart.text || '').replace(/\s+/g, ' ');
    const hits = [];
    for (const re of [/only [\d,]+ of these available/i, /only [\d,]+ left in stock/i, /limit [\d,]+ per customer/i, /There is not enough inventory/i, /Your Amazon Cart is empty/i, /your cart is empty/i, /quantity/i]) {
      const mm = ct.match(re);
      if (mm) hits.push(mm[0] + ' @' + ct.indexOf(mm[0]));
    }
    const qm = [...ct.matchAll(/quantity[^>]{0,120}/gi)].slice(0, 3).map(x => x[0].slice(0, 110));
    out.debug = {
      addLen: addText.length,
      cartLen: (cart.text || '').length,
      cartStatus: cart.status,
      hits: hits.slice(0, 8),
      qtySnippets: qm,
      addStatus: p1.status,
      fields: out.fields,
      snippet: ct.slice(0, 200)
    };
    // 4) 尽力清空匿名购物车
    await http('https://www.amazon.com/gp/cart/view.html?action=clear-all', { headers: h, redirect: 'follow' }, 15000).catch(() => {});
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
  const cookies = await warmSession(idx);
  const h = chromeHeaders(idx);
  h['Cookie'] = cookies;
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

  m = html.match(/id="acrPopover"[^>]*title="([\d.]+) out of 5 stars"/) || html.match(/([\d.]+) out of 5 stars/);
  if (m) out.rating = parseFloat(m[1]);

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

  // 库存探针（匿名购物车加购 999）：**已确认失效，默认关闭**，仅在 STOCK_PROBE=1 时尝试
  // 2026-09 实测：本机住宅 IP 与云端数据中心 IP 均返回「Your Amazon Cart is empty」，
  // 亚马逊已封掉匿名会话的加购通道。代码保留备查，等哪天通道恢复可直接打开。
  if (rec.ok && process.env.STOCK_PROBE === '1' && ['in_stock_no_qty', 'unknown'].includes((rec.stock || {}).kind)) {
    const pr = await probeStock(p.asin, 0, pageHtml);
    console.log(`    [库存探针] ${p.asin} probed=${pr.probed} kind=${pr.kind || '-'} qty=${pr.qty ?? '-'} err=${pr.error || '-'}`);
    if (pr.debug) console.log(`      addLen=${pr.debug.addLen} cartLen=${pr.debug.cartLen} status=${pr.debug.cartStatus} hits=${JSON.stringify(pr.debug.hits)} qty=${JSON.stringify(pr.debug.qtySnippets)}`);
    if (pr.probed) {
      if (pr.kind === 'unavailable') rec.stock = { kind: 'unavailable', source: 'cart_probe' };
      else rec.stock = { kind: pr.kind, qty: pr.qty, source: 'cart_probe', note: pr.ge ? `库存 ≥ ${pr.qty}（探针加购 ${PROBE_QTY} 件被接受）` : '最大可购买量（匿名购物车探针）' };
      rec.stockProbeRaw = pr.raw || null;
    }
    await new Promise(s => setTimeout(s, 2000));
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
