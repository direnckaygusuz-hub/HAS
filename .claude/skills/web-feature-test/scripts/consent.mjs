#!/usr/bin/env node
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * consent.mjs — get a consent-manager (CMP) choice out of the way without the real banner.
 *
 * !! A PASS THAT NEEDED THIS IS NOT A PASS FOR THE CONSENT FLOW ITSELF. !!
 * This is for testing OTHER things behind the banner (a filter, a form, a page layout). Whether the
 * banner shows, can be operated by keyboard, really stores the choice and really gates the tags is
 * only tested by a person-like run against the real CMP. If you used this, say so in the report —
 * see "The verdict bar" in qa-test-report.
 *
 * Three ways, from most to least isolated:
 *   mode 'stub'  — abort the CMP's script hosts and install a fake CMP API on window with the chosen
 *                  answer (and fire the CMP's ready/accept/decline events). Nothing from the CMP vendor
 *                  loads. Most reliable for getting past the banner; site code that needs CMP internals
 *                  the stub doesn't have will break — compare with a real run before reporting that.
 *   mode 'seed'  — let the real CMP load, pre-seed the cookie/localStorage it reads so it believes a
 *                  choice was made. Formats in CMPS below are best-effort starting points; the
 *                  reliable seed is a storageState saved after clicking the banner once by hand.
 *   clickConsent — the real banner, clicked by accessible name (falls back to the CMP's known ids).
 *                  Closest to a visitor; still not a test of the banner.
 *
 *   import { simulateConsent, clickConsent, detectCmp } from './consent.mjs';
 *   await simulateConsent(context, { cmp: 'cookiebot', choice: 'accept', mode: 'stub' });  // before page.goto
 *   await clickConsent(page, { choice: 'decline' });                                        // after page.goto
 *
 *   steps.mjs:  open(url, { setup: ({ context }) => simulateConsent(context, { cmp: 'onetrust', choice: 'decline' }) })
 *
 * CLI (which CMP does this page use?):
 *   node consent.mjs <url>
 *
 * Optional { consentMode: true } also pushes a Google Consent Mode update that matches the choice,
 * for sites whose tags wait on gtag('consent', 'update', …) from the CMP.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCEPT_NAME = /^(accept|allow|agree|ok|i agree|accept all|allow all|accept all cookies|allow all cookies|alle akzeptieren|alles accepteren|accepteren|akkoord|tout accepter|accepter)$/i;
const DECLINE_NAME = /^(decline|deny|reject|reject all|deny all|decline all|use necessary cookies only|necessary only|only necessary|alle ablehnen|weigeren|alles weigeren|tout refuser|refuser)$/i;

export const CMPS = {
  cookiebot: {
    hosts: /consent(?:cdn)?\.cookiebot\.(?:com|eu)/i,
    ids: { accept: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll, #CybotCookiebotDialogBodyButtonAccept', decline: '#CybotCookiebotDialogBodyButtonDecline' },
    seed: (accept, now) => ({
      cookies: [{ name: 'CookieConsent', value: encodeURIComponent(`{stamp:'-1',necessary:true,preferences:${accept},statistics:${accept},marketing:${accept},method:'explicit',ver:1,utc:${now}}`) }],
    }),
  },
  onetrust: {
    hosts: /cdn\.cookielaw\.org|optanon\.blob\.core\.windows\.net|cookie-cdn\.cookiepro\.com|geolocation\.onetrust\.com/i,
    ids: { accept: '#onetrust-accept-btn-handler', decline: '#onetrust-reject-all-handler' },
    seed: (accept, now) => {
      const groups = accept ? 'C0001:1,C0002:1,C0003:1,C0004:1,C0005:1' : 'C0001:1,C0002:0,C0003:0,C0004:0,C0005:0';
      const iso = new Date(now).toISOString();
      return {
        cookies: [
          { name: 'OptanonAlertBoxClosed', value: iso },
          { name: 'OptanonConsent', value: `isGpcEnabled=0&datestamp=${encodeURIComponent(new Date(now).toString())}&version=202401.1.0&interactionCount=1&isIABGlobal=false&landingPath=NotLandingPage&groups=${encodeURIComponent(groups)}` },
        ],
      };
    },
  },
  usercentrics: {
    hosts: /(?:app|web\.cmp|privacy-proxy|api|graphql|aggregator)\.usercentrics\.(?:eu|com)|uct\.service\.usercentrics\.eu/i,
    ids: { accept: '[data-testid="uc-accept-all-button"]', decline: '[data-testid="uc-deny-all-button"]' },
    // v2 reads uc_user_interaction to decide whether to show the banner; per-service choices live in uc_settings
    seed: () => ({ localStorage: { uc_user_interaction: 'true' } }),
  },
  didomi: {
    hosts: /sdk\.privacy-center\.org|api\.privacy-center\.org/i,
    ids: { accept: '#didomi-notice-agree-button', decline: '#didomi-notice-disagree-button, .didomi-continue-without-agreeing' },
    seed: (accept, now) => {
      const iso = new Date(now).toISOString();
      const token = Buffer.from(JSON.stringify({
        user_id: '00000000-0000-4000-8000-000000000000', created: iso, updated: iso, version: 2,
        ...(accept ? { purposes: { enabled: ['*'] }, vendors: { enabled: ['*'] } } : { purposes: { disabled: ['*'] }, vendors: { disabled: ['*'] } }),
      })).toString('base64');
      return { cookies: [{ name: 'didomi_token', value: token }], localStorage: { didomi_token: token } };
    },
  },
};

/** Page-side fake CMP APIs. Runs in the browser; must stay self-contained. */
function stubCmp({ cmp, accept, consentMode }) {
  const fire = (names) => names.forEach((n) => window.dispatchEvent(new Event(n)));
  const onReady = (fn) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', () => setTimeout(fn, 200)) : setTimeout(fn, 200));
  const define = (name, value) => Object.defineProperty(window, name, { get: () => value, set: () => {}, configurable: true });

  if (cmp === 'cookiebot') {
    const cb = {
      consent: { necessary: true, preferences: accept, statistics: accept, marketing: accept, method: 'explicit' },
      consented: accept, declined: !accept, hasResponse: true, changed: false, currentScriptAccepted: accept,
      renew() {}, show() {}, hide() {}, getScript() {}, runScripts() {}, submitCustomConsent() {}, withdraw() {},
    };
    define('Cookiebot', cb);
    define('CookieConsent', cb);
    onReady(() => fire(['CookiebotOnLoad', 'CookiebotOnConsentReady', accept ? 'CookiebotOnAccept' : 'CookiebotOnDecline']));
  }
  if (cmp === 'onetrust') {
    const groups = accept ? ',C0001,C0002,C0003,C0004,C0005,' : ',C0001,';
    window.OnetrustActiveGroups = groups;
    window.OptanonActiveGroups = groups;
    const ot = {
      IsAlertBoxClosed: () => true, OnConsentChanged() {}, ToggleInfoDisplay() {}, Close() {},
      AllowAll() {}, RejectAll() {}, GetDomainData: () => ({ Groups: [] }), changeLanguage() {},
    };
    define('OneTrust', ot);
    define('Optanon', ot);
    onReady(() => {
      (window.dataLayer = window.dataLayer || []).push({ event: 'OneTrustGroupsUpdated', OnetrustActiveGroups: groups });
      if (typeof window.OptanonWrapper === 'function') window.OptanonWrapper();
    });
  }
  if (cmp === 'usercentrics') {
    const uc = {
      isInitialized: () => true, getServicesBaseInfo: () => [], getServicesFullInfo: async () => [],
      acceptAllConsents: async () => {}, denyAllConsents: async () => {}, rejectAllConsents: async () => {},
      showFirstLayer() {}, showSecondLayer() {}, closeCMP: async () => {}, areAllConsentsAccepted: () => accept,
    };
    define('UC_UI', uc);
    onReady(() => {
      fire(['UC_UI_INITIALIZED', 'UC_CONSENT']);
      window.dispatchEvent(new CustomEvent('ucEvent', { detail: { event: 'consent_status', type: 'explicit', action: accept ? 'onAcceptAllServices' : 'onDenyAllServices' } }));
    });
  }
  if (cmp === 'didomi') {
    const status = () => accept;
    const d = {
      getUserConsentStatusForPurpose: status, getUserConsentStatusForVendor: status, getUserConsentStatusForAll: () => ({}),
      isConsentRequired: () => true, shouldConsentBeCollected: () => false, isUserConsentStatusPartial: () => false,
      notice: { isVisible: () => false, show() {}, hide() {} }, preferences: { show() {}, hide() {} },
      setUserAgreeToAll() {}, setUserDisagreeToAll() {}, on() {}, getUserStatus: () => ({}),
    };
    define('Didomi', d);
    const run = (fn) => { try { fn(d); } catch { /* site callback */ } };
    const queue = window.didomiOnReady || [];
    window.didomiOnReady = { push: run };
    onReady(() => { queue.forEach(run); fire(['didomi-ready']); });
  }
  if (consentMode) {
    window.dataLayer = window.dataLayer || [];
    const v = accept ? 'granted' : 'denied';
    // gtag() pushes an Arguments object, not an array
    (function gtag() { window.dataLayer.push(arguments); })('consent', 'update', {
      analytics_storage: v, ad_storage: v, ad_user_data: v, ad_personalization: v, functionality_storage: 'granted', security_storage: 'granted',
    });
  }
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ cmp: keyof CMPS, choice?: 'accept'|'decline', mode?: 'stub'|'seed', url?: string, consentMode?: boolean }} o
 *   url: required for mode 'seed' — the site the cookies/localStorage belong to.
 */
export async function simulateConsent(context, { cmp, choice = 'accept', mode = 'stub', url, consentMode = false } = {}) {
  const def = CMPS[cmp];
  if (!def) throw new Error(`unknown cmp "${cmp}" — one of ${Object.keys(CMPS).join(', ')}`);
  const accept = choice === 'accept';
  if (mode === 'stub') {
    await context.route(def.hosts, (r) => r.abort());
    await context.addInitScript(stubCmp, { cmp, accept, consentMode });
    return;
  }
  if (mode !== 'seed') throw new Error(`mode must be "stub" or "seed", got "${mode}"`);
  if (!url) throw new Error('mode "seed" needs { url } — the site the consent cookie belongs to');
  const { cookies = [], localStorage = {} } = def.seed(accept, Date.now());
  const { hostname, origin } = new URL(url);
  const domain = '.' + hostname.replace(/^www\./, '');
  const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  if (cookies.length) await context.addCookies(cookies.map((c) => ({ domain, path: '/', expires, sameSite: 'Lax', ...c })));
  if (Object.keys(localStorage).length) {
    await context.addInitScript(({ origin, entries }) => {
      if (location.origin !== origin) return;
      for (const [k, v] of Object.entries(entries)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
    }, { origin, entries: localStorage });
  }
  if (consentMode) await context.addInitScript(stubCmp, { cmp: null, accept, consentMode });
}

/** Click the real banner's accept/decline button. Returns true if something was clicked. */
export async function clickConsent(page, { choice = 'accept', cmp, timeout = 8000 } = {}) {
  const name = choice === 'accept' ? ACCEPT_NAME : DECLINE_NAME;
  const ids = cmp ? CMPS[cmp]?.ids?.[choice] : Object.values(CMPS).map((c) => c.ids[choice]).join(', ');
  const target = page.getByRole('button', { name }).or(page.locator(ids)).first();
  try {
    await target.waitFor({ state: 'visible', timeout });
    await target.click();
    return true;
  } catch {
    return false;
  }
}

/** Which CMP(s) the page loads, from the script hosts it requests. */
export async function detectCmp(page, url) {
  const seen = new Set();
  const onReq = (req) => { for (const [k, c] of Object.entries(CMPS)) if (c.hosts.test(req.url())) seen.add(k); };
  page.on('request', onReq);
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000); // CMP loaders are often injected by a tag manager after DOMContentLoaded
  page.off('request', onReq);
  return [...seen];
}

async function main() {
  const url = process.argv[2];
  if (!url) { console.log('usage: node consent.mjs <url>   # prints which CMP the page loads'); process.exit(1); }
  const { chromiumFromProject } = await import('./steps.mjs');
  const chromium = await chromiumFromProject();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const found = await detectCmp(page, url);
  console.log(found.length ? `CMP: ${found.join(', ')}` : `no known CMP (${Object.keys(CMPS).join(', ')}) requested within 4 s`);
  await browser.close();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) await main();
