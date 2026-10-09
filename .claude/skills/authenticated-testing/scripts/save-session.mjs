#!/usr/bin/env node
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * save-session.mjs — a person logs in by hand once; the session is saved for every later run.
 *
 *   cd <absolute project path> && node save-session.mjs <loginUrl> --env acc --wait-storage-key "idToken$"
 *   node save-session.mjs <loginUrl> --env test --wait-cookie session_id
 *   node save-session.mjs <loginUrl> --env acc  --wait-text "My account"     # or "/^Hi, /i"
 *   APP_ENV=acc node save-session.mjs <loginUrl> --wait-storage-key "accessToken"
 *
 * Opens a HEADED browser on the login page. Nobody types a password into a script or a chat: the
 * person logs in in that window (2FA included), and the script polls for a real signal that login
 * finished, then writes the storageState to .auth/<env>.json next to THIS script (not the cwd), so
 * the command works from any directory.
 *
 * Signals (pick the one your app really produces — read the app's storage after one manual login):
 *   --wait-storage-key REGEX   a localStorage key matching REGEX has a value (Cognito/Amplify, MSAL, Auth0 SPA)
 *   --wait-cookie NAME         a cookie with this name exists (NAME or /regex/)
 *   --wait-text TEXT           an element with this text or accessible name is visible (account button
 *                              label that changes once signed in); TEXT or /regex/flags
 *   none given                 press Enter in this terminal once you are signed in
 * Don't wait for networkidle — analytics beacons keep it busy forever.
 *
 * Options: --out <file> (instead of .auth/<env>.json) · --timeout <minutes> (default 5)
 *          --reuse (exit without a browser if the saved session passes session-check)
 *          --headless (only for testing the wait logic with a fixture — nobody can log in headless)
 *
 * Keep .auth/ in .gitignore. One file per environment; never reuse one across environments.
 * Playwright's storageState holds cookies, localStorage and IndexedDB — not sessionStorage. An app
 * that keeps its tokens only in sessionStorage needs those seeded with addInitScript instead.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { checkState, printCheck } from './session-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const toMatcher = (s) => {
  if (s instanceof RegExp) return s;
  const m = /^\/(.+)\/([a-z]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : null;
};

/** One look at the context for the signal. */
export async function signalSeen(context, signal) {
  if (signal.cookie) {
    const re = toMatcher(signal.cookie);
    return (await context.cookies()).some((c) => c.value && (re ? re.test(c.name) : c.name === signal.cookie));
  }
  for (const page of context.pages()) {
    try {
      if (signal.storageKey) {
        const re = toMatcher(signal.storageKey) ?? new RegExp(signal.storageKey);
        const hit = await page.evaluate(([src, flags]) => {
          const r = new RegExp(src, flags);
          return Object.keys(localStorage).some((k) => r.test(k) && !!localStorage.getItem(k));
        }, [re.source, re.flags]);
        if (hit) return true;
      }
      if (signal.text) {
        const t = toMatcher(signal.text) ?? signal.text;
        const l = page.getByText(t).or(page.getByRole('button', { name: t })).or(page.getByRole('link', { name: t })).or(page.getByLabel(t));
        if (await l.first().isVisible()) return true;
      }
    } catch { /* page navigating — try again next tick */ }
  }
  return false;
}

export async function waitForSignal(context, signal, { timeout = 5 * 60_000, interval = 1000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await signalSeen(context, signal)) return true;
    if (!context.pages().length) throw new Error('the browser window was closed before the login finished');
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`no login signal within ${Math.round(timeout / 60000)} min (${JSON.stringify(signal)}) — check what the app really writes after a manual login`);
}

const pressEnter = (prompt) => new Promise((res) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(prompt, () => { rl.close(); res(); });
});

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) a._.push(k);
    else if (['reuse', 'headless'].includes(k.slice(2))) a[k.slice(2)] = true;
    else a[k.slice(2)] = argv[++i];
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const loginUrl = a._[0];
  const env = a.env || process.env.APP_ENV;
  if (!loginUrl || !env) {
    console.log('usage: node save-session.mjs <loginUrl> --env <env> [--wait-storage-key REGEX | --wait-cookie NAME | --wait-text TEXT] [--out f] [--timeout min] [--reuse]');
    process.exit(1);
  }
  const out = a.out ? resolve(a.out) : join(HERE, '.auth', `${env}.json`);
  const signal = a['wait-storage-key'] ? { storageKey: a['wait-storage-key'] }
    : a['wait-cookie'] ? { cookie: a['wait-cookie'] }
    : a['wait-text'] ? { text: a['wait-text'] } : null;

  if (a.reuse && existsSync(out)) {
    const r = checkState(out);
    if (r.ok) { printCheck(r); console.log('Reusing the saved session.'); return; }
    console.log('Saved session expires within the run — opening a browser for a fresh login.');
  }

  let chromium;
  try { ({ chromium } = await import('playwright')); } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    console.error('Cannot find "playwright". Copy this script into the project repo and run it there (npm i -D playwright).');
    process.exit(1);
  }
  const browser = await chromium.launch({ headless: !!a.headless });
  const context = await browser.newContext({ viewport: a.headless ? { width: 1280, height: 800 } : null });
  const page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  try {
    if (signal) {
      console.log(`Log in by hand in the browser window. Waiting for ${JSON.stringify(signal)} (up to ${a.timeout ?? 5} min)…`);
      await waitForSignal(context, signal, { timeout: Number(a.timeout ?? 5) * 60_000 });
    } else {
      await pressEnter('Log in by hand in the browser window, then press Enter here… ');
    }
    await page.waitForTimeout(1500); // let the app finish writing its storage
    mkdirSync(dirname(out), { recursive: true });
    await context.storageState({ path: out, indexedDB: true }).catch(() => context.storageState({ path: out }));
    console.log(`Session for "${env}" saved to ${out}`);
    printCheck(checkState(out));
    console.log('Keep .auth/ in .gitignore.');
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) await main().catch((e) => { console.error(e.message); process.exit(1); });
