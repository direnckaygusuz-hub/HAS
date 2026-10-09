#!/usr/bin/env node
// axe.mjs — run axe-core (WCAG 2 A + AA) on a sample of page templates, cookie banner declined
// (or blocked) first, and list the violations sorted by impact with node counts.
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
//   node axe.mjs <url...> [--storage .auth/acc.json] [--out out/axe-<host>.json]
//     [--compare https://www.example.com] [--block-cmp | --decline '<css>']
//     [--tags wcag2a,wcag2aa] [--mobile] [--settle 2500]
//   node axe.mjs --from out/<label>.json [--sample 12] ...   # pick templates from a crawl
//
// Templates repeat: test home, a listing, a detail page, a form and the 404 page, not every page.
// --from picks the home page, the crawl's 404 probe and one page per first path segment (the
// deepest-but-one of each), up to --sample.
// --compare <otherBaseUrl>: the same paths on another host (e.g. production); prints only the rules
// that fail on the first host and not on the other, per path, plus pages where a shared rule hits
// clearly more nodes. Exit code 1 when something is new, else 0.
// Consent: see crawl.mjs — default declines via known CMP buttons or a decline button in a consent
// container (before every page's scan, if visible); --block-cmp aborts CMP requests instead.
// axe-core is resolved from the project: require.resolve('axe-core/axe.min.js').
// Needs `npm i -D playwright axe-core` (and `npx playwright install chromium`).

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
const IMPACT = { critical: 0, serious: 1, moderate: 2, minor: 3 };

async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  try { return createRequire(join(process.cwd(), 'noop.js'))('playwright'); } catch {}
  console.error('cannot load the "playwright" package.\n  In the project you run from: npm i -D playwright axe-core && npx playwright install chromium');
  process.exit(2);
}
function axePath() {
  for (const from of [import.meta.url, join(process.cwd(), 'noop.js')]) {
    try { return createRequire(from).resolve('axe-core/axe.min.js'); } catch {}
  }
  console.error('cannot resolve axe-core/axe.min.js.\n  In the project you run from: npm i -D axe-core');
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
  if (await btn.isVisible().catch(() => false)) { const t = (await btn.innerText().catch(() => '')).trim(); await btn.click({ timeout: 3000 }).catch(() => {}); return `button "${t}"`; }
  return null;
}
function sampleFromCrawl(file, n) {
  const { meta, pages, notFoundProbe } = JSON.parse(readFileSync(file, 'utf8'));
  const ok = pages.filter((r) => r.status === 200 && !r.navError && !r.errorState);
  const pick = [new URL('/', meta.origin).href];
  const bySeg = new Map();
  for (const r of ok) {
    const seg = r.path.split('/').filter(Boolean)[0]; if (!seg) continue;
    (bySeg.get(seg) || bySeg.set(seg, []).get(seg)).push(r);
  }
  for (const rs of [...bySeg.values()].sort((x, y) => y.length - x.length)) {
    if (pick.length >= n - 1) break;
    const depth = (r) => r.path.split('/').filter(Boolean).length;
    rs.sort((x, y) => depth(y) - depth(x));
    pick.push((rs.length > 1 ? rs[1] : rs[0]).url); // a detail page, not the deepest oddity
  }
  if (notFoundProbe?.url) pick.push(notFoundProbe.url);
  return [...new Set(pick)];
}

const args = parseArgs(process.argv.slice(2), ['block-cmp', 'mobile']);
const urls = args.from ? sampleFromCrawl(args.from, Number(args.sample ?? 12)) : args._;
if (!urls.length) { console.error('usage: node axe.mjs <url...> | --from crawl.json  [--compare https://other.host] [--storage f] [--out f]'); process.exit(2); }
const TAGS = (args.tags || 'wcag2a,wcag2aa').split(',');
const SETTLE = Number(args.settle ?? 2500);
const AXE = axePath();
const { chromium, devices } = await loadPlaywright();
const browser = await chromium.launch();

async function scan(list, label) {
  const opts = args.mobile ? { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } };
  delete opts.defaultBrowserType;
  const ctx = await browser.newContext({ ...opts, ...(args.storage ? { storageState: args.storage } : {}) });
  if (args['block-cmp']) await ctx.route((u) => isCmpHost(u.href), (r) => r.abort());
  const page = await ctx.newPage();
  const res = {}; let consent = args['block-cmp'] ? 'blocked' : 'none-found';
  for (const url of list) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('main, h1').first().waitFor({ timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(SETTLE);
      if (!args['block-cmp']) { const d = await declineConsent(page, args.decline); if (d) { consent = `declined via ${d}`; await page.waitForTimeout(800); } }
      await page.addScriptTag({ path: AXE });
      const v = await page.evaluate(async (tags) => (await window.axe.run(document, { runOnly: { type: 'tag', values: tags } })).violations
        .map((x) => ({ id: x.id, impact: x.impact, help: x.help, nodes: x.nodes.length, sample: x.nodes.slice(0, 3).map((n) => n.target.join(' ')) })), TAGS);
      v.sort((x, y) => (IMPACT[x.impact] ?? 9) - (IMPACT[y.impact] ?? 9) || y.nodes - x.nodes);
      res[url] = { status: resp?.status() ?? null, violations: v };
    } catch (e) { res[url] = { error: String(e.message || e).split('\n')[0], violations: [] }; }
    console.error(`[axe] ${label} ${url} ${res[url].error || res[url].violations.length + ' rule(s)'}`);
  }
  await ctx.close();
  return { results: res, consent };
}

const first = await scan(urls, 'scan');
let other = null; let compareTo = null;
if (args.compare) {
  const cmp = new URL(args.compare);
  compareTo = (u) => { const x = new URL(u); return new URL(x.pathname + x.search, cmp.origin).href; };
  other = await scan(urls.map(compareTo), 'compare');
}
await browser.close();

const fmt = (v) => `${(v.impact || '?').padEnd(8)} ${v.id} — ${v.nodes} node(s)  ${v.help}\n             e.g. ${v.sample[0] || ''}`;
console.log(`axe ${TAGS.join('+')} on ${urls.length} page(s); consent: ${first.consent}${args.storage ? '; signed in via ' + args.storage : ''}`);
// Across the sample: one line per rule.
const rules = new Map();
for (const [url, r] of Object.entries(first.results)) for (const v of r.violations) {
  const g = rules.get(v.id) || { ...v, nodes: 0, pages: [] }; g.nodes += v.nodes; g.pages.push(new URL(url).pathname); rules.set(v.id, g);
}
console.log('\nBY RULE (all sampled pages)');
for (const g of [...rules.values()].sort((x, y) => (IMPACT[x.impact] ?? 9) - (IMPACT[y.impact] ?? 9) || y.nodes - x.nodes))
  console.log(`  ${(g.impact || '?').padEnd(8)} ${g.id} — ${g.nodes} node(s) on ${g.pages.length} page(s): ${g.pages.slice(0, 4).join(' ')}${g.pages.length > 4 ? ' …' : ''}`);
if (!rules.size) console.log('  none');
console.log('\nPER PAGE');
for (const [url, r] of Object.entries(first.results)) {
  console.log(`  ${url}${r.status && r.status !== 200 ? ` (${r.status})` : ''}${r.error ? '  ERROR ' + r.error : ''}`);
  for (const v of r.violations) console.log('    ' + fmt(v));
}

let newCount = 0; const compare = {};
if (other) {
  console.log(`\nNEW COMPARED WITH ${new URL(args.compare).origin} (consent there: ${other.consent})`);
  for (const url of urls) {
    const t = first.results[url].violations; const o = other.results[compareTo(url)];
    const oIds = new Map(o.violations.map((v) => [v.id, v]));
    const added = t.filter((v) => !oIds.has(v.id));
    const more = t.filter((v) => oIds.has(v.id) && v.nodes > oIds.get(v.id).nodes * 1.5 + 2);
    const fixed = o.violations.filter((v) => !t.some((x) => x.id === v.id)).map((v) => v.id);
    compare[url] = { added, more: more.map((v) => ({ id: v.id, nodes: v.nodes, before: oIds.get(v.id).nodes })), fixed, otherError: o.error };
    newCount += added.length;
    const path = new URL(url).pathname;
    if (o.error) { console.log(`  ${path}  not comparable: ${o.error}`); continue; }
    if (!added.length && !more.length) { console.log(`  ${path}  nothing new${fixed.length ? ` (fixed vs other: ${fixed.join(', ')})` : ''}`); continue; }
    console.log(`  ${path}`);
    for (const v of added) console.log('    NEW  ' + fmt(v));
    for (const v of more) console.log(`    MORE ${v.id}: ${v.nodes} node(s) vs ${oIds.get(v.id).nodes}`);
    if (fixed.length) console.log(`    fixed vs other: ${fixed.join(', ')}`);
  }
}
const host = new URL(urls[0]).hostname;
const OUT = resolve(args.out || `out/axe-${host}.json`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ meta: { tool: `qa-toolkit axe.mjs ${VERSION}`, date: new Date().toISOString(), tags: TAGS, consent: first.consent,
  compareWith: args.compare || null, storage: args.storage || null }, results: first.results, other: other?.results ?? null, compare: other ? compare : null }, null, 1));
console.error(`[axe] -> ${OUT}`);
process.exit(other && newCount ? 1 : 0);
