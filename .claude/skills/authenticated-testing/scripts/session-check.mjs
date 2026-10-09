#!/usr/bin/env node
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * session-check.mjs — is the saved session still good for the whole run? Check BEFORE the run.
 *
 *   node session-check.mjs --env acc               # reads .auth/acc.json next to this script
 *   node session-check.mjs --file path/state.json --min 90
 *   APP_ENV=acc node session-check.mjs
 *
 * Reads a Playwright storageState file, finds JWTs in cookies and localStorage values (also inside
 * JSON values), decodes `exp` and prints the time left per token. Token values, subjects and e-mail
 * addresses are never printed; key names are masked where they contain a user id.
 *
 * Exit codes: 0 fine · 2 a token expires within --min minutes (default 60) or already has ·
 *             1 file missing/unreadable.
 *
 * Renewable tokens: an access/id token that sits next to a refresh token (Cognito, Firebase,
 * MSAL, Auth0 …) is renewed by the app, as long as the write guard lets the refresh through — so it
 * does not fail the check unless --strict. The refresh token's own lifetime is usually not readable;
 * if a "renewable" session still dies mid-run, save a fresh one.
 * Without any JWT, cookies that look like a session (sess/auth/token/sid/login) are checked on
 * their cookie expiry instead.
 *
 * Module:  import { checkState } from './session-check.mjs';  const r = checkState(file, { minutes: 60 });
 */
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const SESSION_COOKIE = /sess|auth|token|sid|login|jwt/i;

export const defaultStatePath = (env) => join(HERE, '.auth', `${env}.json`);

function decode(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

export function mask(s) {
  return String(s)
    .replace(/[^\s.:/@]+@[^\s.:/]+\.[a-z.]+/gi, '<email>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, (m) => `${m.slice(0, 4)}…`);
}

/** All (path, string) leaves of a value that may be JSON. */
function leaves(value, path = []) {
  if (typeof value === 'string') {
    const t = value.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 2_000_000) {
      try { return leaves(JSON.parse(t), path); } catch { /* plain string */ }
    }
    return [[path, value]];
  }
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [];
}

const fmtLeft = (min) => {
  if (min < 0) return `expired ${fmtLeft(-min).replace(' left', '')} ago`;
  if (min < 120) return `${Math.round(min)} min left`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h left`;
  return `${(min / 1440).toFixed(1)} d left`;
};

export function checkState(file, { minutes = 60, strict = false, now = Date.now() } = {}) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const tokens = [];
  const refresh = new Set(); // scopes (origin or cookie domain) that hold a refresh token

  const scan = (scope, where, raw) => {
    for (const [path, str] of leaves(raw)) {
      const keyPath = [where, ...path].join('.');
      if (/refresh/i.test(keyPath) && str.length > 20) refresh.add(scope);
      for (const jwt of str.match(JWT) || []) {
        const c = decode(jwt);
        if (!c || typeof c.exp !== 'number') continue;
        const kind = c.token_use || (/id[_-]?token/i.test(keyPath) ? 'id' : /access/i.test(keyPath) ? 'access' : /refresh/i.test(keyPath) ? 'refresh' : 'jwt');
        let iss = '';
        try { iss = new URL(c.iss).host; } catch { /* not a URL */ }
        tokens.push({ scope, where: mask(keyPath), kind, iss, exp: c.exp * 1000, minutesLeft: (c.exp * 1000 - now) / 60000 });
      }
    }
  };

  const siteOf = (domain) => domain.replace(/^\./, '').split('.').slice(-2).join('.');
  for (const c of state.cookies || []) scan(siteOf(c.domain), `cookie ${c.name} @${c.domain}`, c.value);
  for (const o of state.origins || []) {
    const site = siteOf(new URL(o.origin).hostname);
    for (const item of o.localStorage || []) scan(site, `localStorage ${o.origin} ${item.name}`, item.value);
  }

  const cookies = [];
  if (!tokens.length) {
    for (const c of state.cookies || []) {
      if (!SESSION_COOKIE.test(c.name)) continue;
      cookies.push({ where: `cookie ${mask(c.name)} @${c.domain}`, exp: c.expires > 0 ? c.expires * 1000 : null,
        minutesLeft: c.expires > 0 ? (c.expires * 1000 - now) / 60000 : null });
    }
  }

  for (const t of tokens) t.renewable = t.kind !== 'refresh' && refresh.has(t.scope);
  const failing = [
    ...tokens.filter((t) => t.kind !== 'refresh' && t.minutesLeft < minutes && (strict || !t.renewable)),
    ...cookies.filter((c) => c.minutesLeft !== null && c.minutesLeft < minutes),
  ];
  let savedAt = null;
  try { savedAt = statSync(file).mtimeMs; } catch { /* */ }
  return { file, savedAt, minutes, tokens, cookies, refreshPresent: refresh.size > 0, failing, ok: failing.length === 0 };
}

export function printCheck(r) {
  const ago = r.savedAt ? `, saved ${Math.round((Date.now() - r.savedAt) / 60000)} min ago` : '';
  console.log(`${r.file}${ago}`);
  if (!r.tokens.length && !r.cookies.length) {
    console.log('  WARNING: no JWT and no session-like cookie found — expiry unknown. Load a signed-in page to check.');
  }
  for (const t of r.tokens) {
    const flag = t.kind === 'refresh' ? '' : t.minutesLeft < r.minutes ? (t.renewable ? '  renewable (refresh token present)' : '  << EXPIRES WITHIN RUN') : '';
    console.log(`  ${t.kind.padEnd(7)} ${new Date(t.exp).toISOString().slice(0, 16).replace('T', ' ')}Z  ${fmtLeft(t.minutesLeft).padEnd(18)} ${t.where}${t.iss ? `  (${t.iss})` : ''}${flag}`);
  }
  for (const c of r.cookies) {
    const left = c.minutesLeft === null ? 'session cookie (ends with the browser)' : fmtLeft(c.minutesLeft);
    console.log(`  cookie  ${left.padEnd(18)} ${c.where}${c.minutesLeft !== null && c.minutesLeft < r.minutes ? '  << EXPIRES WITHIN RUN' : ''}`);
  }
  if (r.refreshPresent) console.log('  refresh token present — its own expiry is not readable from the file');
  console.log(r.ok ? `OK — good for at least ${r.minutes} min` : `FAIL — save a fresh session before the run (save-session.mjs)`);
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--strict') a.strict = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const env = a.env || process.env.APP_ENV;
  const file = a.file ? resolve(a.file) : env ? defaultStatePath(env) : null;
  if (!file) { console.log('usage: node session-check.mjs --env <env> | --file <storageState.json> [--min 60] [--strict]'); process.exit(1); }
  if (!existsSync(file)) { console.error(`no session file at ${file} — save one with save-session.mjs`); process.exit(1); }
  let r;
  try { r = checkState(file, { minutes: Number(a.min ?? 60), strict: !!a.strict }); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(1); }
  printCheck(r);
  process.exit(r.ok ? 0 : 2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) main();
