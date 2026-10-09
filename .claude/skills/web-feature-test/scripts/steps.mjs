#!/usr/bin/env node
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * steps.mjs — step runner for testing one ticket in a real browser.
 *
 * Module:
 *   import { open } from './steps.mjs';
 *   const s = await open('https://acc.example.com/page', { storage: '.auth/acc.json', viewport: 'mobile', guard: true });
 *   await s.go('/other-page');                         // relative to the first URL
 *   console.log(await s.text('main'));                 // CSS, text=…, role=button[name="…"], or { role, name }
 *   await s.click({ role: 'button', name: 'Search' }); // strict: fails if the target is ambiguous
 *   await s.shot('after-search');                      // ./shots/after-search-mobile.png
 *   console.log(await s.axNames());                    // unnamed / duplicate-named controls (ax-names.mjs)
 *   await s.close();                                   // prints responses >= 400, console and page errors
 *
 *   open() options: storage (storageState file, one per environment), viewport 'mobile' | 'desktop',
 *   guard (true or write-guard options), waitFor (selector that proves the page rendered),
 *   setup ({ context, page }) => … (runs before the first navigation), headless, shots (dir).
 *   s.page / s.context / s.browser are the raw Playwright objects.
 *
 * CLI:
 *   node steps.mjs <url> [--storage .auth/acc.json] [--mobile | --both] [--guard] [--wait <selector>]
 *                        [--shot <name>] [--ax] [--settle <ms, default 2000>] [--headed]
 *   Prints title, h1, failed requests, console and page errors (--ax: also the ax-names check).
 *
 * Loads with domcontentloaded and waits for a real element — never networkidle, which does not
 * settle on sites with analytics beacons. net::ERR_ABORTED (the client cancelling) is ignored.
 * Playwright is resolved from the project's node_modules, so run this from the project repo.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installWriteGuard } from './write-guard.mjs';

export const VIEWPORTS = {
  mobile: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1440, height: 900 } },
};

const DEFAULT_WAIT = 'main, [role=main], h1';

export async function chromiumFromProject() {
  try {
    return (await import('playwright')).chromium;
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND') {
      console.error('Cannot find "playwright". Copy this script into the project repo and run it there '
        + '(npm i -D playwright; npx playwright install chromium).');
      process.exit(1);
    }
    throw e;
  }
}

/** A Locator from a CSS / Playwright selector string, a { role, name, exact } object, or a Locator. */
export function locate(page, target) {
  if (typeof target === 'string') return page.locator(target);
  if (target && typeof target === 'object' && 'role' in target && typeof target.click !== 'function') {
    const { role, name, exact } = target;
    return page.getByRole(role, name === undefined ? {} : { name, exact });
  }
  return target;
}

export async function open(url, opts = {}) {
  const {
    storage, viewport = 'desktop', guard = false, headless = true, shots = 'shots',
    waitFor, timeout = 45_000, contextOptions = {}, setup, quiet = false,
  } = opts;
  if (!VIEWPORTS[viewport]) throw new Error(`viewport must be "mobile" or "desktop", got "${viewport}"`);
  if (storage && !existsSync(storage)) throw new Error(`storage file not found: ${storage} (save one with save-session.mjs)`);

  const chromium = await chromiumFromProject();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    ...VIEWPORTS[viewport],
    storageState: storage,
    serviceWorkers: guard ? 'block' : 'allow',
    ...contextOptions,
  });
  const guardHandle = guard ? await installWriteGuard(context, guard === true ? {} : guard) : null;
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  const failed = [], requestFailures = [], consoleErrors = [], pageErrors = [];
  page.on('response', (r) => { if (r.status() >= 400) failed.push({ status: r.status(), method: r.request().method(), url: r.url() }); });
  page.on('requestfailed', (r) => {
    const error = r.failure()?.errorText || '';
    if (!/ERR_ABORTED/.test(error)) requestFailures.push({ error, url: r.url() });
  });
  page.on('console', (m) => {
    // "Failed to load resource" duplicates the >= 400 list
    if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  if (setup) await setup({ context, page });

  const base = new URL(url);

  async function go(target = url, o = {}) {
    const href = new URL(target, base).href;
    const res = await page.goto(href, { waitUntil: 'domcontentloaded', timeout });
    const sel = o.waitFor ?? waitFor ?? DEFAULT_WAIT;
    try {
      await page.locator(sel).first().waitFor({ state: 'visible', timeout: o.waitTimeout ?? 15_000 });
    } catch {
      if (!quiet) console.log(`[steps] "${sel}" did not appear on ${href} — pass waitFor with an element the feature renders`);
    }
    return { status: res?.status() ?? null, url: page.url() };
  }

  async function text(target) {
    if (!target) {
      const main = page.locator('main, [role=main]');
      return (await main.count()) ? (await main.allInnerTexts()).join('\n---\n') : page.locator('body').innerText();
    }
    return (await locate(page, target).allInnerTexts()).join('\n---\n');
  }

  async function click(target, o = {}) {
    await locate(page, target).click(o);
    await page.waitForLoadState('domcontentloaded').catch(() => {});
  }

  async function shot(name, o = {}) {
    mkdirSync(shots, { recursive: true });
    const path = join(shots, `${name}-${viewport}.png`);
    await page.screenshot({ path, fullPage: o.fullPage ?? false });
    return path;
  }

  // imported lazily: ax-names.mjs imports this file for its own CLI
  const axNames = async (o) => (await import('./ax-names.mjs')).axIssues(page, o);

  function summary() {
    return { failed, requestFailures, consoleErrors, pageErrors, guard: guardHandle?.log ?? [] };
  }

  async function close({ print = !quiet } = {}) {
    const s = summary();
    if (print) printSummary(s, viewport);
    await browser.close();
    return s;
  }

  const s = { page, context, browser, viewport, go, text, click, shot, axNames, summary, close };
  await go(url);
  return s;
}

export function printSummary({ failed, requestFailures, consoleErrors, pageErrors, guard }, label = '') {
  const tag = label ? ` [${label}]` : '';
  const block = (title, items, fmt) => {
    console.log(`--- ${title}${tag} (${items.length})`);
    for (const x of items.slice(0, 30)) console.log('  ' + fmt(x));
    if (items.length > 30) console.log(`  … ${items.length - 30} more`);
  };
  block('responses >= 400', failed, (x) => `${x.status} ${x.method} ${x.url}`);
  if (requestFailures.length) block('request failures (net::ERR_ABORTED ignored)', requestFailures, (x) => `${x.error} ${x.url}`);
  block('console errors', consoleErrors, (x) => x.slice(0, 300));
  block('page errors', pageErrors, (x) => x.slice(0, 300));
  const stopped = guard.filter((g) => g.action !== 'allowed');
  if (guard.length) block('write guard stubbed/blocked', stopped, (x) => `${x.action} ${x.method} ${x.url} (${x.reason})`);
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { a._.push(k); continue; }
    const name = k.slice(2);
    if (['mobile', 'both', 'guard', 'headed', 'ax'].includes(name)) a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const url = a._[0];
  if (!url) {
    console.log('usage: node steps.mjs <url> [--storage .auth/<env>.json] [--mobile | --both] [--guard] [--wait <selector>] [--shot <name>] [--ax] [--settle ms]');
    process.exit(1);
  }
  const viewports = a.both ? ['mobile', 'desktop'] : [a.mobile ? 'mobile' : 'desktop'];
  for (const viewport of viewports) {
    const s = await open(url, { storage: a.storage, viewport, guard: !!a.guard, waitFor: a.wait, headless: !a.headed });
    await s.page.waitForTimeout(Number(a.settle ?? 2000)); // late errors and requests after first render
    console.log(`=== ${viewport}  ${s.page.url()}`);
    console.log('title:', await s.page.title());
    console.log('h1:', JSON.stringify(await s.page.locator('h1').allInnerTexts()));
    if (a.shot) console.log('screenshot:', await s.shot(a.shot));
    if (a.ax) (await import('./ax-names.mjs')).printAxIssues(await s.axNames());
    await s.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) await main();
