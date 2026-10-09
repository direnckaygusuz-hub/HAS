#!/usr/bin/env node
// sweep.mjs — Playwright runner for the floating-UI overlap sweep.
// Pages (paths file) x viewports 375x812 / 768x1024 / 1440x900 x scroll top / middle / bottom,
// analysed in the page with overlap-analyze.js. The whole sweep runs twice; states whose
// result differs between runs are flagged as timing. Optionally opens the panel and runs
// modal-check.js plus a real click on a link behind it.
//
//   node sweep.mjs --base https://www.example.com --paths paths.txt --selector '#chat-fab' \
//     [--cookie '#cookie-decline'] [--open '#chat-fab button'] [--out overlap-results] \
//     [--workers 4] [--settle 2500] [--margin 8] [--runs 2]
//   Env equivalents: BASE_URL, PATHS_FILE, FLOAT_SELECTOR, COOKIE_SELECTOR, OPEN_SELECTOR,
//   OUT_DIR, WORKERS, SETTLE_MS, MARGIN, RUNS.
// paths.txt: one path per line ("/", "/contact/"); blank lines and "#" comments ignored.
// Needs Playwright where it can be resolved from this script or the current directory
// (npm i playwright; npx playwright install chromium).
// Writes <out>/sweep.json, <out>/summary.md and <out>/shots/*.png.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try { ({ chromium } = createRequire(join(process.cwd(), 'noop.js'))('playwright')); } catch {}
}
if (!chromium) {
  console.error('sweep.mjs: cannot load the "playwright" package.\n' +
    '  Install it in the directory you run from: npm i playwright && npx playwright install chromium');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, env, def) => {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  return process.env[env] ?? def;
};
const BASE = (arg('base', 'BASE_URL', '') || '').replace(/\/$/, '');
const PATHS_FILE = arg('paths', 'PATHS_FILE', '');
const SELECTOR = arg('selector', 'FLOAT_SELECTOR', '');
const COOKIE = arg('cookie', 'COOKIE_SELECTOR', '');
const OPEN = arg('open', 'OPEN_SELECTOR', '');
const OUT = resolve(arg('out', 'OUT_DIR', 'overlap-results'));
const WORKERS = Number(arg('workers', 'WORKERS', 4));
const SETTLE = Number(arg('settle', 'SETTLE_MS', 2500));
const MARGIN = Number(arg('margin', 'MARGIN', 8));
const RUNS = Math.max(1, Number(arg('runs', 'RUNS', 2)));
if (!BASE || !PATHS_FILE || !SELECTOR) {
  console.error('usage: node sweep.mjs --base <url> --paths <file> --selector <css> [--cookie <css>] [--open <css>] [--out <dir>]');
  process.exit(2);
}
const PATHS = readFileSync(PATHS_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];
const ANALYZE = readFileSync(join(HERE, 'overlap-analyze.js'), 'utf8');
const MODAL = readFileSync(join(HERE, 'modal-check.js'), 'utf8');
const call = (src, opts) => `(${src})(${JSON.stringify(opts)})`;
const slug = (p) => (p.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home');
mkdirSync(join(OUT, 'shots'), { recursive: true });

async function dismissCookies(page, state) {
  if (!COOKIE) return;
  const b = page.locator(COOKIE).first();
  try { await b.waitFor({ state: 'visible', timeout: state.dismissed ? 800 : 4000 }); } catch { return; }
  await b.click({ timeout: 3000 }).catch(() => {});
  await b.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  state.dismissed = true;
}

async function openPage(page, path, vp, state) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  const resp = await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await dismissCookies(page, state);
  await page.waitForTimeout(SETTLE);
  return resp ? resp.status() : null;
}

async function sweepOnce(browser, run) {
  const queue = [];
  for (const path of PATHS) for (const vp of VIEWPORTS) queue.push({ path, vp });
  const total = queue.length, records = [];
  async function worker() {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const state = { dismissed: false };
    while (queue.length) {
      const { path, vp } = queue.shift();
      const rec = { path, viewport: vp.name, size: `${vp.width}x${vp.height}`, states: [], error: null };
      try {
        rec.status = await openPage(page, path, vp, state);
        const docH = await page.evaluate(() => document.documentElement.scrollHeight);
        const max = Math.max(0, docH - vp.height);
        for (const [pos, y] of [['top', 0], ['middle', Math.round(max / 2)], ['bottom', max]]) {
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          await page.waitForTimeout(600);
          const res = await page.evaluate(call(ANALYZE, { selector: SELECTOR, margin: MARGIN }));
          res.scrollPos = pos;
          const s = res.summary || {};
          if (run === 1 && (s.blocked || s.partial || s.collisions)) {
            res.screenshot = `shots/${slug(path)}-${vp.name}-${pos}.png`;
            await page.screenshot({ path: join(OUT, res.screenshot) }).catch(() => { res.screenshot = null; });
          }
          rec.states.push(res);
        }
      } catch (e) {
        rec.error = String(e).split('\n')[0].slice(0, 200);
      }
      records.push(rec);
      const worst = rec.states.some((s) => s.summary?.blocked) ? '  BLOCKED' : rec.states.some((s) => s.summary?.partial) ? '  partial' : '';
      process.stderr.write(`run ${run} [${records.length}/${total}] ${vp.name.padEnd(7)} ${path}${rec.error ? '  ERR ' + rec.error : worst}\n`);
    }
    await ctx.close();
  }
  await Promise.all(Array.from({ length: Math.max(1, WORKERS) }, worker));
  return records.sort((a, b) => a.path.localeCompare(b.path) || a.viewport.localeCompare(b.viewport));
}

// Compact fingerprint of a state, to compare runs.
const sig = (s) => !s ? 'missing' : !s.found ? 'not-found' : s.hidden ? 'hidden' : JSON.stringify([
  s.targets.filter((t) => t.severity !== 'NEAR').map((t) => t.severity + ':' + t.sel + ':' + t.text).sort(),
  s.textBlocks.length, s.collisions.filter((c) => c.overlaps).map((c) => c.sel + ':' + c.onTop).sort()]);

async function modalChecks(browser) {
  const out = [];
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const r = { viewport: vp.name, path: PATHS[0] };
    try {
      await openPage(page, PATHS[0], vp, {});
      await page.locator(OPEN).first().click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      r.check = await page.evaluate(call(MODAL, { selector: SELECTOR }));
      r.screenshot = `shots/panel-open-${vp.name}.png`;
      await page.screenshot({ path: join(OUT, r.screenshot) });
      const link = (r.check.reachable || []).find((x) => x.tag === 'a' && x.href && !/^(#|javascript:|mailto:|tel:)/i.test(x.href));
      if (link) {
        const before = page.url();
        await page.mouse.click(link.x, link.y);
        await page.waitForTimeout(2000);
        r.clickBehind = { link: link.text || link.href, href: link.href, navigated: page.url() !== before, url: page.url() };
      }
    } catch (e) { r.error = String(e).split('\n')[0].slice(0, 200); }
    out.push(r);
    await ctx.close();
  }
  return out;
}

const browser = await chromium.launch();
const runs = [];
for (let i = 1; i <= RUNS; i++) runs.push(await sweepOnce(browser, i));
const modal = OPEN ? await modalChecks(browser) : null;
await browser.close();

// ---- compare runs ----
const results = runs[0];
const timing = [];
for (const rec of results) for (const [i, s] of rec.states.entries()) {
  for (const other of runs.slice(1)) {
    const o = other.find((x) => x.path === rec.path && x.viewport === rec.viewport);
    if (sig(s) !== sig(o?.states[i])) { s.timing = true; timing.push(`${rec.path} ${rec.viewport} ${s.scrollPos}`); break; }
  }
}

// ---- aggregate (run 1) ----
const RANK = { BLOCKED: 0, PARTIAL: 1, OVERLAP_ONLY: 2, NEAR: 3 };
const pages = new Map();
const findings = [];
// One entry per element per page; `occ` lists every state where it had its worst severity.
const note = (map, key, sev, item, where) => {
  const prev = map.get(key);
  if (!prev || RANK[sev] < RANK[prev.severity]) map.set(key, { severity: sev, t: item, occ: [where] });
  else if (sev === prev.severity) prev.occ.push(where);
};
for (const rec of results) {
  const pg = pages.get(rec.path) || { path: rec.path, elements: new Map(), text: new Set(), collisions: new Map(), hidden: [], errors: [] };
  pages.set(rec.path, pg);
  if (rec.error) pg.errors.push(`${rec.viewport}: ${rec.error}`);
  for (const s of rec.states) {
    const where = { path: rec.path, viewport: rec.viewport, scroll: s.scrollPos, screenshot: s.screenshot || null, timing: !!s.timing };
    if (!s.found || s.hidden) { pg.hidden.push(`${rec.viewport}/${s.scrollPos}${s.found ? '' : ' (not in DOM)'}`); continue; }
    for (const t of s.targets) note(pg.elements, `${t.sel}|${t.text}|${t.href}`, t.severity, t, where);
    for (const b of s.textBlocks) if (b.linesUnderElement > 0) pg.text.add(`${b.sel}|${b.text}`);
    for (const c of s.collisions) if (c.overlaps) note(pg.collisions, `${c.sel}|${c.text}`, 'BLOCKED', c, where);
  }
}
const VP_ORDER = { mobile: 0, tablet: 1, desktop: 2 };
for (const pg of pages.values()) {
  for (const e of [...pg.elements.values(), ...pg.collisions.values()]) e.occ.sort((a, b) => VP_ORDER[a.viewport] - VP_ORDER[b.viewport]);
  for (const e of pg.elements.values()) {
    if (e.severity !== 'BLOCKED' && e.severity !== 'PARTIAL') continue;
    const form = e.t.isFormControl, mobile = e.occ.some((w) => w.viewport === 'mobile');
    findings.push({ rank: e.severity === 'BLOCKED' ? (form && mobile ? 0 : form ? 1 : 2) : 4, kind: 'target', e });
  }
  for (const e of pg.collisions.values()) findings.push({ rank: 3, kind: 'collision', e });
}
const pageList = [...pages.values()];
const all = pageList.flatMap((p) => [...p.elements.values()]);
const n = { blocked: all.filter((e) => e.severity === 'BLOCKED').length, partial: all.filter((e) => e.severity === 'PARTIAL').length,
  text: pageList.reduce((a, p) => a + p.text.size, 0), collisions: pageList.reduce((a, p) => a + p.collisions.size, 0) };
const interfering = pageList.filter((p) => [...p.elements.values()].some((e) => RANK[e.severity] <= 1) || p.text.size || p.collisions.size);
findings.sort((a, b) => a.rank - b.rank);

// ---- markdown ----
const L = [];
const states = results.reduce((a, r) => a + r.states.length, 0);
L.push(`# Floating UI overlap — ${SELECTOR}`, '');
L.push(`**Interferes on ${interfering.length} of ${pageList.length} pages — ${n.blocked} elements blocked, ${n.partial} partially covered, ` +
  `${n.text} text blocks covered, ${n.collisions} collisions with other fixed/sticky elements.**`, '');
L.push(`${BASE} · ${states} states (${pageList.length} pages × ${VIEWPORTS.length} viewports × 3 scroll positions) · ${RUNS} runs · ` +
  `${timing.length} state(s) differ between runs (timing)`, '');
L.push('## Where the element actually sits', '');
for (const vp of VIEWPORTS) {
  const s = results.filter((r) => r.viewport === vp.name).flatMap((r) => r.states).find((x) => x.found && !x.hidden);
  L.push(s ? `- ${vp.name} ${vp.width}×${vp.height}: ${s.box.w}×${s.box.h}px, ${s.box.fromRight}px from right, ${s.box.fromBottom}px from bottom, left ${s.box.left}, top ${s.box.top} (${s.box.position}, z-index ${s.box.zIndex})`
    : `- ${vp.name}: not visible on any page`);
}
L.push('', '## Findings (ranked)', '');
if (!findings.length) L.push('None.');
const where = (occ) => {
  const by = {};
  for (const w of occ) (by[w.viewport] ||= []).push(w.scroll + (w.timing ? '*' : ''));
  const shot = occ.find((w) => w.screenshot)?.screenshot;
  return `${occ[0].path} · ${Object.entries(by).map(([v, p]) => `${v} ${p.join('/')}`).join(', ')}${shot ? ` · ${shot}` : ''}`;
};
for (const f of findings.slice(0, 40)) {
  const t = f.e.t;
  if (f.kind === 'collision') L.push(`- COLLISION ${t.sel} "${t.text || ''}" (${t.position}, z ${t.zIndex}, ${t.pctAreaOverlapped}% overlapped, on top: ${t.onTop}) — ${where(f.e.occ)}`);
  else L.push(`- ${f.e.severity}${t.isFormControl ? ' (form)' : ''} ${t.sel} "${t.text || ''}"${t.href ? ` → ${t.href}` : ''} (${t.probe?.covered ?? 0}/26 points) — ${where(f.e.occ)}`);
}
if (timing.length) L.push('', '`*` = result differs between runs (timing, not layout).');
if (findings.length > 40) L.push(`- … ${findings.length - 40} more in sweep.json`);
L.push('', '## Per page', '', '| page | blocked | partial | text | collisions | hidden | errors |', '|---|---|---|---|---|---|---|');
for (const p of pageList) {
  const els = [...p.elements.values()];
  L.push(`| ${p.path} | ${els.filter((e) => e.severity === 'BLOCKED').length} | ${els.filter((e) => e.severity === 'PARTIAL').length} | ${p.text.size} | ${p.collisions.size} | ${p.hidden.length === VIEWPORTS.length * 3 ? 'everywhere' : p.hidden.join(', ')} | ${p.errors.join('; ')} |`);
}
if (modal) {
  L.push('', '## Open panel — modal?', '');
  for (const m of modal) {
    if (m.error) { L.push(`- ${m.viewport}: ERROR ${m.error}`); continue; }
    const c = m.check;
    L.push(`- ${m.viewport}: ${c.verdict} — ${c.reachableOutside} links/buttons outside still hittable; page behind inert ${c.behind.inert}/${c.behind.elements}, aria-hidden ${c.behind.ariaHidden}/${c.behind.elements}; ` +
      `scroll ${c.scroll.locked ? 'locked' : 'NOT locked'}; intercepts ${c.pctViewportIntercepted}% of viewport` +
      (m.clickBehind ? `; clicked "${m.clickBehind.link}" behind it → ${m.clickBehind.navigated ? 'NAVIGATED to ' + m.clickBehind.url : 'no navigation'}` : ''));
  }
}
if (timing.length) L.push('', '## Timing (differs between runs)', '', ...timing.map((t) => `- ${t}`));

writeFileSync(join(OUT, 'sweep.json'), JSON.stringify({ base: BASE, selector: SELECTOR, margin: MARGIN, generated: new Date().toISOString(),
  runs: RUNS, timing, modal, results, otherRuns: runs.slice(1) }, null, 2));
writeFileSync(join(OUT, 'summary.md'), L.join('\n') + '\n');
console.error(`\n${L[2]}\n-> ${join(OUT, 'summary.md')}`);
