#!/usr/bin/env node
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * live-regions.mjs — log what live regions would announce, over time.
 *
 * Watches [aria-live] (not "off"), role=status, alert, log and timer with a MutationObserver that
 * reports to Node through exposeBinding, so it keeps working across navigations. Each entry:
 *
 *   [live +2.31s] status/polite  changed   "12 results"
 *   [live +4.02s] alert/-        inserted  "Something went wrong"   ← region added together with its text
 *
 *   initial   text already in the region when watching started — not announced
 *   changed   text of an existing region changed — this is what screen readers announce
 *   inserted  region added to the DOM with its text already in it — role=alert is usually announced,
 *             a polite/status region usually is NOT (the region must exist before the text arrives)
 *   (hidden)  the region is display:none / visibility:hidden / aria-hidden — nothing is announced
 *
 * This shows what the DOM offers to assistive tech, not what a given screen reader says. For a
 * verdict on an announcement that matters, confirm once with VoiceOver or NVDA.
 *
 * Module:
 *   import { watchLiveRegions } from './live-regions.mjs';
 *   const live = await watchLiveRegions(context);   // or a page; before page.goto catches everything
 *   …  await page.getByRole('button', { name: 'Search' }).click();
 *   live.print();                                   // live.log is the raw array
 *
 * CLI:
 *   node live-regions.mjs <url> [--click <selector>] [--seconds 10] [--storage f] [--mobile] [--guard]
 *   <selector>: CSS, text=…, or role=button[name="Search"]. Clicks once after load, then watches.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Runs in the page. Self-contained. */
function observeLiveRegions() {
  if (window.__qaLiveInstalled) return;
  window.__qaLiveInstalled = true;
  const SEL = '[aria-live]:not([aria-live="off"]),[role=status],[role=alert],[role=log],[role=timer]';
  const known = new WeakSet();
  const last = new WeakMap();
  const pending = new Map();
  const RANK = { changed: 0, inserted: 1, initial: 2 };
  const textOf = (el) => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const hiddenOf = (el) => !!el.closest('[aria-hidden="true"]')
    || (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true }));
  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const tid = el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : '';
    return el.tagName.toLowerCase() + id + tid;
  };
  const send = (region, kind) => {
    const text = textOf(region);
    if (kind === 'changed' && last.get(region) === text) return;
    last.set(region, text);
    window.__qaLive({
      kind, text, hidden: hiddenOf(region), where: describe(region),
      role: region.getAttribute('role'), live: region.getAttribute('aria-live'), atomic: region.getAttribute('aria-atomic'),
    });
  };
  const schedule = (region, kind) => {
    const p = pending.get(region);
    if (p) { clearTimeout(p.timer); if (RANK[p.kind] > RANK[kind]) kind = p.kind; }
    pending.set(region, { kind, timer: setTimeout(() => { pending.delete(region); send(region, kind); }, 60) });
  };
  const scan = (root, kind) => {
    const list = root.matches?.(SEL) ? [root] : [];
    if (root.querySelectorAll) list.push(...root.querySelectorAll(SEL));
    for (const r of list) {
      if (known.has(r)) continue;
      known.add(r);
      if (textOf(r)) schedule(r, kind); else last.set(r, '');
    }
  };
  const start = () => {
    scan(document.body, 'initial');
    new MutationObserver((ms) => {
      for (const m of ms) {
        for (const n of m.addedNodes) if (n.nodeType === 1) scan(n, 'inserted');
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (!el) continue;
        if (m.type === 'attributes' && el.matches(SEL) && !known.has(el)) { known.add(el); last.set(el, textOf(el)); continue; }
        const region = el.closest?.(SEL);
        if (region && known.has(region)) schedule(region, 'changed');
      }
    }).observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-live', 'role'],
    });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
}

export async function watchLiveRegions(target, { quiet = false, onEntry } = {}) {
  const isPage = typeof target.mainFrame === 'function';
  const context = isPage ? target.context() : target;
  const t0 = Date.now();
  const log = [];
  const line = (e) => `[live +${(e.ms / 1000).toFixed(2)}s] ${`${e.role || '-'}/${e.live || '-'}`.padEnd(16)} ${e.kind.padEnd(9)} "${e.text.slice(0, 120)}"${e.hidden ? ' (hidden)' : ''}  ${e.where}${e.frame ? `  [frame ${e.frame}]` : ''}`;
  await context.exposeBinding('__qaLive', (source, e) => {
    const entry = { ...e, ms: Date.now() - t0, url: source.frame.url(), frame: source.frame.parentFrame() ? source.frame.url() : null };
    log.push(entry);
    onEntry?.(entry);
    if (!quiet) console.log(line(entry));
  });
  await context.addInitScript(observeLiveRegions);
  for (const p of context.pages()) await p.evaluate(observeLiveRegions).catch(() => {}); // already-loaded pages
  return {
    log,
    print() {
      console.log(`--- live regions (${log.length})`);
      for (const e of log) console.log('  ' + line(e));
    },
  };
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) a._.push(k);
    else if (['mobile', 'guard'].includes(k.slice(2))) a[k.slice(2)] = true;
    else a[k.slice(2)] = argv[++i];
  }
  return a;
}

async function main() {
  const { open } = await import('./steps.mjs');
  const a = parseArgs(process.argv.slice(2));
  const url = a._[0];
  if (!url) {
    console.log('usage: node live-regions.mjs <url> [--click <selector>] [--seconds 10] [--storage f] [--mobile] [--guard]');
    process.exit(1);
  }
  let live;
  const s = await open(url, {
    storage: a.storage, viewport: a.mobile ? 'mobile' : 'desktop', guard: !!a.guard, waitFor: a.wait,
    setup: async ({ context }) => { live = await watchLiveRegions(context); },
  });
  if (a.click) {
    console.log(`[live] clicking ${a.click}`);
    await s.click(a.click);
  }
  await s.page.waitForTimeout(Number(a.seconds ?? 10) * 1000);
  live.print();
  await s.close();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) await main();
