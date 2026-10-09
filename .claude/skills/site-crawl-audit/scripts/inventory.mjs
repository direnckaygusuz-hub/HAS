#!/usr/bin/env node
// inventory.mjs — "where is X linked" or "where is X mentioned" across a site. Links and mentions
// are kept apart: they answer different questions; ask which one is wanted when it is unclear.
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
//   node inventory.mjs <crawl.json | baseUrl> --links <domain | /path | https://url-prefix>
//   node inventory.mjs <crawl.json | baseUrl> --mentions "<text>" [--include-nav] [--case]
//     common: [--base https://other.env] [--max 200] [--workers 4] [--out out/inventory.json]
//             [--storage .auth/acc.json] [--block-cmp | --decline '<css>'] [--settle 1500]
//
// Pages: from a crawl.mjs JSON (pages that answered < 400; --base to run its paths on another
// host), or discovered from a base URL like crawl.mjs (sitemap and sitemap indexes, else internal
// links; same rules and --max cap).
// --links: every a[href] whose target matches — a domain (host or subdomain), a path prefix on
//   this host ("/contact"), or a URL prefix. Searched in the whole document; each hit says where
//   it sits (header / nav / main / footer / aside / other), so filtering is up to the report.
// --mentions: case-insensitive (--case for exact) matches in the RENDERED, visible text of <main>
//   (or <body> without a main), excluding header, nav, footer and aside; --include-nav searches
//   the whole <body>.
//   Never raw HTML: scripts, styles, templates and JSON blobs such as __NEXT_DATA__ are not text a
//   visitor sees, and a raw-HTML search reports a "mention" on every page.
// Prints a table: page, type, text, target — and states what was excluded. Exit code 0.
// Needs `npm i -D playwright` (and `npx playwright install chromium`) in the project you run from.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const VERSION = '0.8.0';
const CMP_HOSTS = [
  'cookiebot.com', 'cookiebot.eu', 'cookielaw.org', 'onetrust.com', 'onetrust.io', 'usercentrics.eu',
  'usercentrics.com', 'privacy-center.org', 'didomi.io', 'consensu.org', 'privacy-mgmt.com',
  'trustarc.com', 'cookieyes.com', 'iubenda.com', 'termly.io', 'cookiefirst.com',
];
const DECLINE_SELECTORS = [
  '#CybotCookiebotDialogBodyButtonDecline', '#onetrust-reject-all-handler', '[data-testid="uc-deny-all-button"]',
  '#didomi-notice-disagree-button', '.cky-btn-reject', '.iubenda-cs-reject-btn', '[data-cookiefirst-action="reject"]',
];
const DECLINE_TEXT = /^\s*(decline|reject|deny|refuse|only (necessary|essential)|necessary only|use necessary|weigeren|alles weigeren|ablehnen|alle ablehnen|refuser|tout refuser|rechazar)/i;
const CONSENT_CONTAINER = '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [aria-label*="cookie" i], [aria-label*="consent" i], [role="dialog"], [aria-modal="true"]';
const SKIP_PATH = /^\/(_next|_nuxt|static|assets|wp-content|wp-json|cdn-cgi)\//i;
const FILE_EXT = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|rar|7z|dmg|exe|apk|mp4|mp3|webm|mov|avi|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|eot|css|js|mjs|map|json|xml|txt|rss|atom|ics)$/i;
const EXCLUDED = 'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';

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
    if (booleans.includes(k)) out[k] = true; else { out[k] = argv[i + 1]; i++; }
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
  if (await btn.isVisible().catch(() => false)) { await btn.click({ timeout: 3000 }).catch(() => {}); return 'button'; }
  return null;
}
function pageUrl(href, base) {
  let u; try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.origin !== base.origin) return null;
  if (!u.pathname.startsWith(base.pathname.replace(/[^/]*$/, ''))) return null;
  if (SKIP_PATH.test(u.pathname) || FILE_EXT.test(u.pathname)) return null;
  u.hash = ''; u.search = '';
  return u.href;
}
async function readSitemaps(request, base) {
  const queue = [new URL('/sitemap.xml', base.origin).href];
  try {
    const r = await request.get(new URL('/robots.txt', base.origin).href, { timeout: 15000 });
    if (r.ok()) for (const m of (await r.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  } catch {}
  const seen = new Set(); const pages = new Set();
  while (queue.length && seen.size < 200) {
    const sm = queue.shift(); if (seen.has(sm)) continue; seen.add(sm);
    let text = '';
    try { const r = await request.get(sm, { timeout: 20000 }); if (!r.ok()) continue; text = await r.text(); } catch { continue; }
    const isIndex = /<sitemapindex[\s>]/i.test(text);
    for (const m of text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
      const loc = m[1].replace(/&amp;/g, '&');
      if (isIndex) { queue.push(new URL(loc, sm).href); continue; }
      let u; try { u = new URL(loc, base); } catch { continue; }
      const p = pageUrl(new URL(u.pathname, base.origin).href, base); if (p) pages.add(p);
    }
  }
  return [...pages].sort();
}

// Runs inside the page.
function collect({ mode, target, needle, includeNav, caseSensitive, excluded }) {
  const clip = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);
  const where = (el) => {
    const c = el.closest('header, nav, main, footer, aside, [role="navigation"], [role="banner"], [role="main"], [role="contentinfo"]');
    if (!c) return 'other';
    const r = c.getAttribute('role');
    return { navigation: 'nav', banner: 'header', main: 'main', contentinfo: 'footer' }[r] || c.tagName.toLowerCase();
  };
  if (mode === 'links') {
    const hits = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const raw = a.getAttribute('href'); let u; try { u = new URL(raw, location.href); } catch { continue; }
      let ok = false;
      if (/^https?:\/\//i.test(target)) ok = u.href.startsWith(target);
      else if (target.startsWith('/')) ok = u.origin === location.origin && u.pathname.startsWith(target);
      else ok = u.hostname === target || u.hostname.endsWith('.' + target);
      if (ok) hits.push({ type: 'link', text: clip(a.innerText || a.getAttribute('aria-label') || a.title || '', 80), target: u.href, where: where(a) });
    }
    return hits;
  }
  // Mentions: visible text nodes under main (or body), outside excluded regions and non-text elements.
  const root = (!includeNav && document.querySelector('main, [role="main"]')) || document.body;
  const skip = 'script, style, noscript, template, svg' + (includeNav ? '' : ', ' + excluded);
  // Join text nodes like innerText would: no space inside inline markup (Ac<b>me</b>), a space
  // between blocks.
  const blockOf = (el) => { for (let e = el; e && e !== root; e = e.parentElement) if (!/^inline/.test(getComputedStyle(e).display)) return e; return root; };
  let text = ''; let lastBlock = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement; if (!el || !n.nodeValue.trim()) continue;
    if (el.closest(skip)) continue;
    if (el.checkVisibility ? !el.checkVisibility({ visibilityProperty: true }) : !el.getClientRects().length) continue;
    const blk = blockOf(el);
    text += (lastBlock && blk !== lastBlock ? ' ' : '') + n.nodeValue; lastBlock = blk;
  }
  text = text.replace(/\s+/g, ' ');
  const hay = caseSensitive ? text : text.toLowerCase(); const nd = caseSensitive ? needle : needle.toLowerCase();
  const hits = [];
  for (let i = hay.indexOf(nd); i >= 0 && hits.length < 50; i = hay.indexOf(nd, i + nd.length)) {
    hits.push({ type: 'mention', text: '…' + text.slice(Math.max(0, i - 50), i + nd.length + 50).trim() + '…', target: '', where: root === document.body ? 'body' : 'main' });
  }
  return hits;
}

const args = parseArgs(process.argv.slice(2), ['include-nav', 'case', 'block-cmp']);
const src = args._[0];
const mode = args.links ? 'links' : args.mentions ? 'mentions' : null;
if (!src || !mode || (args.links && args.mentions)) {
  console.error('usage: node inventory.mjs <crawl.json|baseUrl> --links <domain|/path|url-prefix>  |  --mentions "<text>" [--include-nav]');
  process.exit(2);
}
const MAX = Number(args.max ?? 200); const WORKERS = Math.max(1, Number(args.workers ?? 4)); const SETTLE = Number(args.settle ?? 1500);
const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const newContext = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(args.storage ? { storageState: args.storage } : {}) });
  if (args['block-cmp']) await ctx.route((u) => isCmpHost(u.href), (r) => r.abort());
  return ctx;
};

let base; let queue; let discover = false; let capped = false;
if (/^https?:\/\//i.test(src)) {
  base = new URL(src);
  const c = await newContext(); queue = await readSitemaps(c.request, base); await c.close();
  if (!queue.length) { discover = true; queue = [pageUrl(base.href, base) || base.href]; console.error('[inventory] no sitemap; following internal links'); }
} else {
  const crawl = JSON.parse(readFileSync(src, 'utf8'));
  base = new URL(args.base || crawl.meta.base);
  queue = crawl.pages.filter((r) => !r.navError && r.status < 400 && !r.contentType).map((r) => new URL(r.path, base.origin).href);
}
if (queue.length > MAX) { console.error(`[inventory] capped at --max ${MAX} of ${queue.length} pages`); capped = true; queue.length = MAX; }
const known = new Set(queue);
const opts = { mode, target: args.links, needle: args.mentions, includeNav: !!args['include-nav'], caseSensitive: !!args.case, excluded: EXCLUDED };
const rows = []; let scanned = 0; let active = 0;

async function worker() {
  const ctx = await newContext(); let first = true;
  for (;;) {
    if (!queue.length) { if (!active) break; await new Promise((s) => setTimeout(s, 100)); continue; }
    const url = queue.shift(); active++;
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('main, h1').first().waitFor({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(SETTLE);
      if (first && !args['block-cmp']) await declineConsent(page, args.decline);
      first = false;
      for (const h of await page.evaluate(collect, opts)) rows.push({ page: new URL(url).pathname, ...h });
      if (discover) for (const l of await page.$$eval('a[href]', (as) => as.map((a) => a.href))) {
        const p = pageUrl(l, base); if (!p || known.has(p)) continue;
        if (known.size >= MAX) { capped = true; continue; }
        known.add(p); queue.push(p);
      }
      scanned++;
    } catch (e) { console.error(`[inventory] ${url}: ${String(e.message || e).split('\n')[0]}`); }
    await page.close().catch(() => {}); active--;
  }
  await ctx.close();
}
await Promise.all(Array.from({ length: WORKERS }, worker));
await browser.close();

rows.sort((x, y) => x.page.localeCompare(y.page));
const pagesHit = new Set(rows.map((r) => r.page));
const scope = mode === 'links'
  ? `links whose target matches "${args.links}", whole document (column "where" says header/nav/main/footer)`
  : `mentions of "${args.mentions}" (${args.case ? 'case-sensitive' : 'case-insensitive'}) in the visible text of ${args['include-nav'] ? '<body>, nav/header/footer included' : '<main>, excluding header, nav, footer and aside'}; scripts and JSON blobs (e.g. __NEXT_DATA__) never searched`;
console.log(`${rows.length} ${mode === 'links' ? 'link(s)' : 'mention(s)'} on ${pagesHit.size} of ${scanned} page(s) scanned on ${base.origin}${capped ? ` (CAPPED at ${MAX})` : ''}`);
console.log(`scope: ${scope}\n`);
console.log(['page', 'type', 'where', 'text', 'target'].join('\t'));
for (const r of rows) console.log([r.page, r.type, r.where, r.text, r.target].join('\t'));
if (args.out) {
  const OUT = resolve(args.out); mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ meta: { tool: `qa-toolkit inventory.mjs ${VERSION}`, date: new Date().toISOString(), base: base.href, mode,
    query: args.links || args.mentions, scope, scanned, capped }, rows }, null, 1));
  console.error(`[inventory] -> ${OUT}`);
}
