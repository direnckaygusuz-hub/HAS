#!/usr/bin/env node
// crawl.mjs — crawl one environment of a site with Playwright and record every page's health
// in one JSON file (the baseline for diff.mjs, the input for report.mjs and inventory.mjs).
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
//   node crawl.mjs <baseUrl> [--max 200] [--workers 4] [--out out/<label>.json]
//     [--mobile] [--prod-host www.example.com] [--block-cmp | --decline '<css>']
//     [--storage .auth/acc.json] [--settle 2000] [--timeout 45000]
//     [--error-text '<regex>'] [--soft404-text '<regex>'] [--no-link-check] [--link-check-max 500]
//
// Page list: <base>/sitemap.xml (and Sitemap: lines in robots.txt), following sitemap INDEXES
//   down to their child sitemaps. No sitemap: follow internal links from the base URL. Either
//   way: same origin only, # and query stripped, /_next and file extensions skipped, capped at
//   --max (logged, and recorded as meta.capped).
// Per page: domcontentloaded, then wait for main/h1 (never networkidle), then --settle ms for late
//   errors. Records status, final URL, title, first h1, load time (to main/h1), console errors,
//   page errors, failed requests (net::ERR_ABORTED ignored), responses >= 400 with URL, visible
//   error states and soft 404s, horizontal overflow with the offending elements, malformed tel:
//   links, hard-coded links to --prod-host, suspicious hrefs (undefined/null, e-mail without
//   mailto:), placeholder text. After the pages: every internal link target that was not crawled
//   (files such as PDFs included) is checked with a request (--no-link-check to skip), and a made-up URL is loaded to see whether
//   the site answers 404 or a soft 404.
// --mobile: 390x844, isMobile, hasTouch, iPhone user agent. Run once without and once with it.
// Consent banner — pick one:
//   default      click "decline" on the first page of each worker (known CMP buttons, or a
//                decline/reject button inside a cookie/consent container; --decline <css> to name
//                it). Realistic: the CMP loads and its own errors and layout effects are seen.
//   --block-cmp  abort requests to the CMP_HOSTS below. Faster and deterministic, but the page is
//                tested without the CMP, and sites that wait for the CMP before rendering can break
//                (or log "<CMP> is not defined") — that is a crawl artefact, not a finding.
//                Blocked requests are left out of failedRequests.
// Error-state patterns are regex sources (case-insensitive); --error-text / --soft404-text REPLACE
//   the defaults in ERROR_TEXT / SOFT_404_TEXT below. Soft 404 = a soft-404 pattern on a page that
//   answered < 400. Text is matched on the innerText of <main> (or <body>), never on raw HTML.
// Needs `npm i -D playwright` (and `npx playwright install chromium`) in the project you run from.
// Then: node report.mjs <out.json> for the verdict-first summary; node diff.mjs <old> <new>.

import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const VERSION = '0.8.0';

// ---- configuration constants -------------------------------------------------------------
// Consent-manager hosts blocked by --block-cmp (hostname suffix match).
const CMP_HOSTS = [
  'cookiebot.com', 'cookiebot.eu',              // Cookiebot
  'cookielaw.org', 'onetrust.com', 'onetrust.io', // OneTrust
  'usercentrics.eu', 'usercentrics.com',        // Usercentrics
  'privacy-center.org', 'didomi.io',            // Didomi
  'consensu.org', 'privacy-mgmt.com',           // IAB TCF CMPs (Quantcast, Sourcepoint)
  'trustarc.com', 'cookieyes.com', 'iubenda.com', 'termly.io', 'cookiefirst.com',
];
// Decline buttons of common CMPs, tried before the generic text match.
const DECLINE_SELECTORS = [
  '#CybotCookiebotDialogBodyButtonDecline',                 // Cookiebot
  '#onetrust-reject-all-handler',                           // OneTrust
  '[data-testid="uc-deny-all-button"]',                     // Usercentrics
  '#didomi-notice-disagree-button',                         // Didomi
  '.cky-btn-reject', '.iubenda-cs-reject-btn', '[data-cookiefirst-action="reject"]',
];
const DECLINE_TEXT = /^\s*(decline|reject|deny|refuse|only (necessary|essential)|necessary only|use necessary|weigeren|alles weigeren|ablehnen|alle ablehnen|refuser|tout refuser|rechazar)/i;
const CONSENT_CONTAINER = '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [aria-label*="consent" i], [role="dialog"], [aria-modal="true"]';
// Visible error states. Both lists are regex sources, joined with |.
const ERROR_TEXT = [
  'something went wrong', 'unable to load', 'failed to load', 'an error (has )?occurred',
  'try again later', 'internal server error', 'service unavailable', 'bad gateway',
];
const SOFT_404_TEXT = [
  'page not found', "we can['’]?t find (that|this|the) page", "this page (does not|doesn['’]?t) exist",
  '404 (error|not found|page)', 'error 404',
];
const TEL_OK = /^tel:\+?[0-9][0-9\-\s().]*$/i;
const SKIP_PATH = /^\/(_next|_nuxt|static|assets|wp-content|wp-json|cdn-cgi)\//i;
const FILE_EXT = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|rar|7z|dmg|exe|apk|mp4|mp3|webm|mov|avi|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|css|js|mjs|map|json|xml|txt|rss|atom|ics)$/i;

// ---- helpers -----------------------------------------------------------------------------
async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  try { return createRequire(join(process.cwd(), 'noop.js'))('playwright'); } catch {}
  console.error('cannot load the "playwright" package.\n  In the project you run from: npm i -D playwright axe-core && npx playwright install chromium');
  process.exit(2);
}
function parseArgs(argv, booleans) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (booleans.includes(k)) out[k] = true;
    else { out[k] = argv[i + 1]; i++; }
  }
  return out;
}
const isCmpHost = (url) => { try { const h = new URL(url).hostname; return CMP_HOSTS.some((d) => h === d || h.endsWith('.' + d)); } catch { return false; } };
async function declineConsent(page, custom) {
  for (const sel of custom ? [custom] : DECLINE_SELECTORS) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) { await loc.click({ timeout: 3000 }).catch(() => {}); return sel; }
  }
  if (custom) return null;
  const btn = page.locator(CONSENT_CONTAINER).getByRole('button', { name: DECLINE_TEXT }).first();
  if (await btn.isVisible().catch(() => false)) { const t = (await btn.innerText().catch(() => '')).trim(); await btn.click({ timeout: 3000 }).catch(() => {}); return `button "${t}"`; }
  return null;
}
// Normalise a link to a crawlable page URL on the same origin (and under the base path), or null.
function pageUrl(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.origin !== base.origin) return null;
  if (!u.pathname.startsWith(base.pathname.replace(/[^/]*$/, ''))) return null;
  if (SKIP_PATH.test(u.pathname) || FILE_EXT.test(u.pathname)) return null;
  u.hash = ''; u.search = '';
  return u.href;
}
// Link-check target: same origin, # stripped; files (PDFs) included, framework assets not.
function linkTarget(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.origin !== base.origin || SKIP_PATH.test(u.pathname)) return null;
  u.hash = '';
  return FILE_EXT.test(u.pathname) ? u.href : (u.search = '', u.href);
}
async function readSitemaps(request, base, log) {
  const queue = [new URL('/sitemap.xml', base.origin).href];
  try {
    const r = await request.get(new URL('/robots.txt', base.origin).href, { timeout: 15000 });
    if (r.ok()) for (const m of (await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  } catch {}
  const seen = new Set(); const pages = new Set(); const read = []; const foreign = new Set();
  while (queue.length && seen.size < 200) {
    const sm = queue.shift(); if (seen.has(sm)) continue; seen.add(sm);
    let text = '';
    try { const r = await request.get(sm, { timeout: 20000 }); if (!r.ok()) continue; text = await r.text(); } catch { continue; }
    if (!/<(urlset|sitemapindex)[\s>]/i.test(text)) continue;
    read.push(sm);
    const locs = [...text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    const isIndex = /<sitemapindex[\s>]/i.test(text);
    for (const loc of locs) {
      if (isIndex) { queue.push(new URL(loc, sm).href); continue; }
      let u; try { u = new URL(loc, base); } catch { continue; }
      // Sitemaps on test environments often list production URLs: crawl the path on this host.
      if (u.origin !== base.origin) { foreign.add(u.host); u = new URL(u.pathname, base.origin); }
      const p = pageUrl(u.href, base); if (p) pages.add(p);
    }
  }
  if (read.length) log(`sitemap: ${read.length} file(s) read, ${pages.size} pages${foreign.size ? `; locs on other hosts mapped to this one: ${[...foreign].join(', ')}` : ''}`);
  return { pages: [...pages].sort(), read, foreign: [...foreign] };
}

// Runs inside the page.
function auditPage({ errorRe, soft404Re, prodHost, telOk }) {
  const root = document.querySelector('main') || document.body;
  const text = (root?.innerText || '').trim();
  const clip = (s, n = 160) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
  const near = (m) => clip(text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60));
  const soft = text.match(new RegExp(soft404Re, 'i'));
  const err = text.match(new RegExp(errorRe, 'i'));
  const anchors = [...document.querySelectorAll('a[href]')];
  const tel = new RegExp(telOk, 'i');
  const badTel = anchors.filter((a) => /tel:/i.test(a.getAttribute('href')) && !tel.test(a.getAttribute('href').trim()))
    .map((a) => ({ href: a.getAttribute('href'), text: clip(a.innerText, 60) }));
  const prodLinks = prodHost && location.hostname !== prodHost
    ? anchors.filter((a) => a.hostname === prodHost).map((a) => a.href) : [];
  const badHrefs = anchors.map((a) => a.getAttribute('href').trim()).filter((h) =>
    /(^|[/=?&#])(undefined|null|NaN)([/?&#.]|$)|\[object/.test(h) ||
    /^[^:/?#\s]+@[^/\s]+\.[a-z]{2,}$/i.test(h) ||          // e-mail address without mailto:
    /^https?:\/\/(tel|mailto|sms):/i.test(h));               // https://tel:911
  const placeholders = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\{\{\s*[\w.$]+\s*\}\}/, /lorem ipsum/i]
    .map((re) => text.match(re)).filter(Boolean).map((m) => near(m));
  const de = document.documentElement; const vw = de.clientWidth; const px = de.scrollWidth - vw;
  let overflow = null;
  if (px > 1) {
    const off = [...document.querySelectorAll('body *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.right > vw + 1 && getComputedStyle(e).position !== 'fixed';
    });
    const set = new Set(off);
    const desc = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : ''}`;
    // innerWidth > clientWidth: a mobile browser widened the layout viewport (page loads zoomed out).
    overflow = { px, layoutWidth: window.innerWidth, scrollable: null, elements: off.filter((e) => !set.has(e.parentElement)).slice(0, 8)
      .map((e) => ({ el: desc(e), right: Math.round(e.getBoundingClientRect().right) })) };
  }
  return {
    title: document.title.trim(),
    h1: clip(document.querySelector('h1')?.innerText || '', 120) || null,
    textLen: text.length,
    softMatch: soft ? near(soft) : null,
    errorMatch: err ? near(err) : null,
    badTel, prodCount: prodLinks.length, prodLinks: [...new Set(prodLinks)].slice(0, 10),
    badHrefs: [...new Set(badHrefs)].slice(0, 10), placeholders, overflow,
    links: [...new Set(anchors.map((a) => a.href))],
  };
}

// ---- main ---------------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2), ['mobile', 'block-cmp', 'no-link-check']);
if (!args._[0]) {
  console.error('usage: node crawl.mjs <baseUrl> [--max 200] [--workers 4] [--out out/<label>.json] [--mobile] [--prod-host host] [--block-cmp | --decline css] [--storage state.json]');
  process.exit(2);
}
const base = new URL(args._[0]);
const MAX = Number(args.max ?? 200);
const WORKERS = Math.max(1, Number(args.workers ?? 4));
const SETTLE = Number(args.settle ?? 2000);
const TIMEOUT = Number(args.timeout ?? 45000);
const errorRe = args['error-text'] || ERROR_TEXT.join('|');
const soft404Re = args['soft404-text'] || SOFT_404_TEXT.join('|');
const prodHost = args['prod-host'] || null;
const label = `${base.hostname}${args.mobile ? '-mobile' : ''}`;
const OUT = resolve(args.out || `out/${label}.json`);
const log = (...m) => console.error('[crawl]', ...m);

const { chromium, devices } = await loadPlaywright();
const browser = await chromium.launch();
const ctxOptions = {
  ...(args.mobile
    ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, defaultBrowserType: undefined }
    : { viewport: { width: 1440, height: 900 } }),
  ...(args.storage ? { storageState: args.storage } : {}),
};
delete ctxOptions.defaultBrowserType;
async function newContext() {
  const ctx = await browser.newContext(ctxOptions);
  if (args['block-cmp']) await ctx.route((u) => isCmpHost(u.href), (r) => r.abort());
  return ctx;
}

const started = new Date();
const probeCtx = await newContext();
const sm = await readSitemaps(probeCtx.request, base, log);
const source = sm.pages.length ? 'sitemap' : 'links';
const known = new Set(sm.pages.length ? sm.pages : [pageUrl(base.href, base) || base.href]);
const queue = [...known];
if (source === 'links') log('no sitemap with pages; following internal links from', base.href);
let capped = false; let active = 0; let done = 0; let consent = args['block-cmp'] ? 'blocked' : 'none-found';
const results = [];
const linkedFrom = new Map(); // link target -> Set of page paths linking to it

async function visit(ctx, url, first) {
  const page = await ctx.newPage();
  const u = new URL(url);
  const r = { url, path: u.pathname, status: null, finalUrl: null, title: null, h1: null, ms: null,
    console: [], pageErrors: [], failedRequests: [], badResponses: [] };
  page.on('console', (m) => { if (m.type() === 'error') r.console.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => r.pageErrors.push(String(e.message || e).slice(0, 300)));
  page.on('requestfailed', (q) => {
    const f = q.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(f) || (args['block-cmp'] && isCmpHost(q.url()))) return;
    r.failedRequests.push(`${f} ${q.url().slice(0, 200)}`);
  });
  page.on('response', (s) => { if (s.status() >= 400) r.badResponses.push(`${s.status()} ${s.url().slice(0, 200)}`); });
  const t0 = Date.now();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    r.status = res?.status() ?? null;
    const ok = await page.locator('main, h1').first().waitFor({ timeout: 15000 }).then(() => true, () => false);
    r.ms = Date.now() - t0;
    if (!ok) r.readyTimeout = true;
    await page.waitForTimeout(SETTLE);
    if (first && !args['block-cmp']) {
      const d = await declineConsent(page, args.decline);
      if (d) { consent = `declined via ${d}`; await page.waitForTimeout(500); }
    }
    r.finalUrl = page.url();
    const type = res?.headers()['content-type'] || '';
    if (type && !/html/i.test(type)) { r.contentType = type; }
    else {
      const a = await page.evaluate(auditPage, { errorRe, soft404Re, prodHost, telOk: TEL_OK.source });
      const links = a.links; delete a.links;
      Object.assign(r, a);
      if (a.overflow) {
        // Can a user actually pan sideways? A wheel/touch pan is the honest test: under isMobile
        // the layout viewport widens and window.scrollTo() says nothing.
        await page.mouse.move(10, 300); await page.mouse.wheel(300, 0); await page.waitForTimeout(250);
        r.overflow.scrollable = await page.evaluate(() => Math.max(window.scrollX, visualViewport.pageLeft) > 0);
        await page.mouse.wheel(-300, 0);
      }
      r.errorState = r.status < 400 && a.softMatch ? { kind: 'soft404', text: a.softMatch }
        : r.status < 400 && a.errorMatch ? { kind: 'error', text: a.errorMatch } : null;
      delete r.softMatch; delete r.errorMatch;
      for (const l of links) {
        const t = linkTarget(l, base); if (!t) continue;
        if (!linkedFrom.has(t)) linkedFrom.set(t, new Set());
        linkedFrom.get(t).add(r.path);
        const p = pageUrl(l, base); if (!p) continue;
        if (source === 'links' && !known.has(p)) {
          if (known.size >= MAX) { capped = true; continue; }
          known.add(p); queue.push(p);
        }
      }
    }
  } catch (e) { r.navError = String(e.message || e).split('\n')[0].slice(0, 300); r.ms ??= Date.now() - t0; }
  await page.close().catch(() => {});
  return r;
}

async function worker() {
  const ctx = await newContext(); let first = true;
  for (;;) {
    if (!queue.length) { if (active === 0) break; await new Promise((s) => setTimeout(s, 100)); continue; }
    const url = queue.shift(); active++;
    try { results.push(await visit(ctx, url, first)); } finally { active--; }
    first = false;
    if (++done % 25 === 0) log(`${done}/${known.size}`);
  }
  await ctx.close();
}
if (source === 'sitemap' && queue.length > MAX) { log(`capped at --max ${MAX} of ${queue.length} sitemap pages`); capped = true; queue.length = MAX; }
await Promise.all(Array.from({ length: WORKERS }, worker));
if (source === 'links' && capped) log(`capped at --max ${MAX}; more internal links were found`);

// Internal link targets that were not crawled: check them with a request.
const brokenLinks = [];
const crawled = new Map(results.map((r) => [r.url, r]));
for (const [target, from] of linkedFrom) {
  const r = crawled.get(target);
  if (r && (r.status >= 400 || r.navError)) brokenLinks.push({ url: target, status: r.status, error: r.navError, from: [...from] });
}
if (!args['no-link-check']) {
  const todo = [...linkedFrom.keys()].filter((t) => !crawled.has(t)).slice(0, Number(args['link-check-max'] ?? 500));
  if (todo.length) log(`checking ${todo.length} internal link targets that were not crawled`);
  let i = 0;
  await Promise.all(Array.from({ length: WORKERS * 2 }, async () => {
    while (i < todo.length) {
      const t = todo[i++]; let status = null; let error;
      try {
        let res = await probeCtx.request.fetch(t, { method: 'HEAD', timeout: 20000, maxRedirects: 10 });
        if (res.status() >= 400) res = await probeCtx.request.get(t, { timeout: 20000, maxRedirects: 10 });
        status = res.status();
      } catch (e) { error = String(e.message || e).split('\n')[0].slice(0, 200); }
      if (error || status >= 400) brokenLinks.push({ url: t, status, error, from: [...linkedFrom.get(t)] });
    }
  }));
}

// A URL that cannot exist: does the site answer 404, or a soft 404 (200 + error page)?
let notFoundProbe = null;
{
  const ctx = await newContext();
  const url = new URL(`qa-crawl-404-probe-${Date.now().toString(36)}/`, base.origin + base.pathname.replace(/[^/]*$/, '')).href;
  const r = await visit(ctx, url, false);
  notFoundProbe = { url, status: r.status, title: r.title, h1: r.h1, errorState: r.errorState ?? null, textLen: r.textLen ?? 0, navError: r.navError };
  await ctx.close();
}
await probeCtx.close();
await browser.close();

results.sort((a, b) => a.path.localeCompare(b.path));
const meta = {
  tool: `qa-toolkit crawl.mjs ${VERSION}`, base: base.href, origin: base.origin, date: started.toISOString(),
  durationS: Math.round((Date.now() - started) / 1000), count: results.length, source, sitemaps: sm.read,
  sitemapForeignHosts: sm.foreign, max: MAX, capped, viewport: args.mobile ? 'mobile 390x844' : 'desktop 1440x900',
  mobile: !!args.mobile, storage: args.storage || null, consent, prodHost, settleMs: SETTLE,
  errorText: errorRe, soft404Text: soft404Re, linkCheck: !args['no-link-check'],
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ meta, notFoundProbe, brokenLinks, pages: results }, null, 1));
log(`done: ${results.length} pages${capped ? ` (capped at ${MAX})` : ''}, consent: ${consent}, ${brokenLinks.length} broken internal link target(s) -> ${OUT}`);
log(`next: node report.mjs ${OUT}`);
