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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SCRAPER_MODE = process.env.SCRAPER_MODE || 'direct';
const SCRAPER_KEY = process.env.SCRAPER_KEY || '';
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 8000);

const args = process.argv.slice(2);
const argVal = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const LIMIT = argVal('--limit') ? Number(argVal('--limit')) : 0;
const ONLY_ASIN = argVal('--asin');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function todayStr(d) {
  const dt = d ? new Date(d) : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/* ---------------- 抓取：三种模式 ---------------- */
async function http(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
    clearTimeout(timer);
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function fetchHtml(asin) {
  const url = `https://www.amazon.com/dp/${asin}?th=1&language=en_US`;
  if (SCRAPER_MODE === 'jina') {           // 免费额度：r.jina.ai（可在 GitHub Actions 上直连）
    const r = await http(`https://r.jina.ai/${url}`, { headers: { 'X-Return-Format': 'html' } }, 35000);
    return Object.assign({ via: 'jina' }, r);
  }
  if (SCRAPER_MODE === 'scrapingbee' && SCRAPER_KEY) {  // 免费 1000 次/月
    const api = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPER_KEY}&url=${encodeURIComponent(url)}&render_js=false&premium_proxy=true`;
    const r = await http(api, {}, 40000);
    return Object.assign({ via: 'scrapingbee' }, r);
  }
  // direct：直连（数据中心 IP，可能被验证码拦截）
  const r = await http(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': 'i18n-prefs=USD',
      'Cache-Control': 'no-cache'
    }
  }, 25000);
  return Object.assign({ via: 'direct' }, r);
}

/* ---------------- 解析 ---------------- */
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
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

  let priceStr = null;
  const apexIdx = html.indexOf('corePriceDisplay_desktop_feature_div');
  if (apexIdx >= 0) {
    const seg = html.slice(apexIdx, apexIdx + 12000);
    const mm = seg.match(/class="a-offscreen">\s*(?:US)?\$([\d,]+\.\d{2})\s*</);
    if (mm) priceStr = mm[1];
  }
  if (priceStr == null) {
    const ctx = (html.match(/api_buybox_group_1[\s\S]{0,900}/) || [])[0] || '';
    const mm = ctx.match(/"displayPrice"\s*:\s*"(?:US)?\$([\d,]+\.\d{2})"/) || ctx.match(/"priceAmount"\s*:\s*([\d,]+\.\d{2})/);
    if (mm) priceStr = mm[1];
  }
  if (priceStr == null) {
    const mm = html.match(/"displayPrice"\s*:\s*"(?:US)?\$([\d,]+\.\d{2})"/);
    if (mm) priceStr = mm[1];
  }
  if (priceStr != null) { out.price = parseFloat(priceStr.replace(/,/g, '')); out.currency = 'USD'; }

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

  const avail = (html.match(/id="availability"[\s\S]{0,1200}/) || [])[0] || '';
  if (/Currently unavailable|out of stock/i.test(avail)) out.stock = { kind: 'unavailable' };
  else if (/In Stock/i.test(avail) || out.price != null) out.stock = { kind: 'in_stock_no_qty' };
  m = html.match(/Only (\d+) left in stock/i);
  if (m) out.stock = { kind: 'stock', qty: parseInt(m[1], 10), source: 'amazon_page' };
  m = html.match(/limit (\d+) (?:units )?per (?:customer|order)/i);
  if (m) out.purchaseLimit = { qty: parseInt(m[1], 10), source: 'amazon_page' };

  return out;
}

/* ---------------- 主流程 ---------------- */
const products = readJSON(PRODUCTS_FILE, []);
let history = readJSON(HISTORY_FILE, {});
const date = todayStr();
if (!history[date]) history[date] = {};

let list = products;
if (ONLY_ASIN) list = list.filter(p => p.asin.toUpperCase() === ONLY_ASIN.toUpperCase());
if (LIMIT) list = list.slice(0, LIMIT);

console.log(`开始采集 ${list.length} 个商品 · 模式=${SCRAPER_MODE} · 日期=${date}`);
const t0 = Date.now();
let ok = 0, fail = 0;
const lines = [];

for (const p of list) {
  let lastErr = null, rec = null;
  for (let attempt = 1; attempt <= 2 && !rec; attempt++) {
    const ts = Date.now();
    const r = await fetchHtml(p.asin);
    if (r.ok && r.text && !/Enter the characters you see below/i.test(r.text)) {
      const parsed = parseAmazon(r.text, p.asin);
      rec = {
        asin: p.asin, realAsin: parsed.realAsin, title: parsed.title,
        price: parsed.price, currency: parsed.currency,
        rating: parsed.rating, reviews: parsed.reviews,
        bsrSmall: parsed.bsrSmall, bsrLarge: parsed.bsrLarge,
        stock: parsed.stock, purchaseLimit: parsed.purchaseLimit,
        image: parsed.image, ok: parsed.ok, error: parsed.error || null,
        captcha: parsed.captcha, source: r.via, fetchedAt: new Date().toISOString(),
        timingMs: Date.now() - ts
      };
    } else {
      lastErr = /Robot Check|Enter the characters/i.test(r.text || '') ? 'CAPTCHA'
        : (r.error || ('HTTP ' + (r.status || '')));
    }
    if (!rec && attempt < 2) await new Promise(s => setTimeout(s, 4000));
  }
  if (!rec) rec = { asin: p.asin, ok: false, error: lastErr || 'UNKNOWN', captcha: lastErr === 'CAPTCHA', stock: { kind: 'unknown' }, source: SCRAPER_MODE, fetchedAt: new Date().toISOString() };

  // 保留手工补录库存（需在 data/manual-stock.json 维护，或直接编辑 history.json）
  const prev = history[date][p.asin];
  if (prev && prev.stock && prev.stock.source === 'manual' && rec.stock.kind === 'unknown') rec.stock = prev.stock;

  if (rec.ok) { ok++; if (p.name && rec.title && !rec.title.includes('（')) p.latestTitle = rec.title; }
  else fail++;
  history[date][p.asin] = rec;
  lines.push(`| ${rec.ok ? '成功' : '失败'} | ${p.asin} | ${rec.price != null ? '$' + rec.price : '—'} | ${rec.rating ?? '—'} | ${rec.reviews ?? '—'} | ${rec.bsrSmall ? '#' + rec.bsrSmall.rank : '—'} | ${rec.error || '—'} |`);
  console.log(`  ${rec.ok ? 'OK ' : 'ERR'} ${p.asin} price=${rec.price} rating=${rec.rating} reviews=${rec.reviews} bsr=${rec.bsrSmall ? rec.bsrSmall.rank : '-'} ${rec.error || ''}`);
  await new Promise(s => setTimeout(s, Math.max(2000, INTERVAL_MS)));
}

// 保留最近 3650 天
for (const d of Object.keys(history)) {
  if (Date.now() - new Date(d + 'T00:00:00Z').getTime() > 3650 * 86400000) delete history[d];
}
fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ lastRun: { date, finishedAt: new Date(Date.now()).toISOString(), total: list.length, ok, fail, ms: Date.now() - t0 }, historyDates: Object.keys(history).sort() }, null, 2));

// 输出到 Actions 摘要面板
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = `## 亚马逊每日采集结果（${date}）\n\n成功 **${ok}** / 共 **${list.length}**，失败 **${fail}**，耗时 ${Math.round((Date.now() - t0) / 1000)} 秒，模式 ${SCRAPER_MODE}\n\n| 状态 | ASIN | 售价 | 星级 | 评论数 | 小类BSR | 备注 |\n|---|---|---|---|---|---|---|\n${lines.join('\n')}\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
console.log(`完成：成功 ${ok}，失败 ${fail}，耗时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
