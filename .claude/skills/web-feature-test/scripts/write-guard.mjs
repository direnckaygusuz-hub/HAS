// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * write-guard.mjs — stop a test from submitting anything real.
 *
 *   import { installWriteGuard } from './write-guard.mjs';
 *   const context = await browser.newContext({ serviceWorkers: 'block', storageState: '.auth/acc.json' });
 *   const guard = await installWriteGuard(context);            // before the first page.goto
 *   …                                                           // use the page
 *   guard.print();                                              // what was stubbed, blocked, allowed
 *
 *   steps.mjs does this for you: open(url, { guard: true }) or open(url, { guard: { allow: [/\/session\/renew/] } }).
 *
 * What it does (context.route on every request):
 *   - Code senders are BLOCKED, even on GET: fetch/XHR/beacon calls whose URL looks like it sends an
 *     SMS, e-mail or one-time code (/otp, /sms, /mfa, /2fa, /resend, /verify/send, send-code …).
 *     A 2FA "Next" or "Resend code" reaches a real phone or inbox. Pages and assets are not affected.
 *   - Non-GET requests (POST, PUT, PATCH, DELETE — fetch, XHR and form posts) get a stub response
 *     (200 "{}" for fetch/XHR, 204 otherwise) and are logged. Nothing reaches the server.
 *   - The ALLOWLIST lets auth/token refresh through. Blocking the refresh signs the user out
 *     mid-test. Defaults: …/token, /oauth2/token, /connect/token, /refresh…, securetoken.googleapis.com,
 *     and for AWS Cognito only GetUser / token-refresh calls (InitiateAuth with a REFRESH_TOKEN flow) —
 *     SignUp, ForgotPassword, ResendConfirmationCode and the rest stay stubbed. Add the project's own
 *     refresh endpoint with { allow: [/regex/ | (request) => boolean] }.
 *   - Analytics/telemetry beacons pass by default so tracking still works ({ telemetry: false } stubs them).
 *   - The init script disables service-worker registration (a worker's requests can bypass routing)
 *     and marks window.__qaWriteGuard so you can see the guard is active.
 *
 * Limits: WebSocket messages are not intercepted; a request your own page.route() continues with
 * route.continue() skips the guard — use route.fallback() in your routes. A stubbed "{}" may send
 * the UI down an error path; that is the price of not writing — say so in the report.
 */

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const API_TYPES = new Set(['fetch', 'xhr', 'ping', 'beacon', 'eventsource', 'other']);

export const DEFAULT_SENSITIVE = [
  /\/(?:otp|sms|mfa|2fa|resend)(?:[/?#._-]|$)/i,
  /\/verify\/send/i,
  /\/send[-_]?(?:code|otp|sms|verification|magic[-_]?link)/i,
  /accounts:send(?:VerificationCode|OobCode)/i, // Firebase Auth
  cognitoTarget(['ResendConfirmationCode', 'ForgotPassword', 'GetUserAttributeVerificationCode', 'SignUp', 'UpdateUserAttributes']),
];

export const DEFAULT_ALLOW = [
  /\/(?:oauth2?\/|connect\/|openid-connect\/)?token(?:[/?#]|$)/i,
  /\/refresh(?:[-_]?token)?(?:[/?#]|$)/i,
  /securetoken\.googleapis\.com\//i,
  cognitoTokenCall,
];

export const DEFAULT_TELEMETRY = [
  /google-analytics\.com|analytics\.google\.com|googletagmanager\.com|\/g\/collect|doubleclick\.net/i,
  /applicationinsights\.azure\.com|dc\.services\.visualstudio\.com|sentry\.io|ingest\.sentry|clarity\.ms/i,
  /hotjar\.(?:com|io)|segment\.(?:io|com)|datadoghq|nr-data\.net|newrelic\.com/i,
];

function amzTarget(req) {
  return (req.headers()['x-amz-target'] || '').split('.').pop();
}

function cognitoTarget(names) {
  const fn = (req) => /cognito-idp\.[a-z0-9-]+\.amazonaws\.com/i.test(req.url()) && names.includes(amzTarget(req));
  fn.label = `cognito ${names.join('/')}`;
  return fn;
}

/** Cognito: only reading the user and refreshing tokens; everything else on cognito-idp is a write. */
export function cognitoTokenCall(req) {
  const url = req.url();
  if (/cognito-identity\.[a-z0-9-]+\.amazonaws\.com/i.test(url)) return ['GetId', 'GetCredentialsForIdentity'].includes(amzTarget(req));
  if (!/cognito-idp\.[a-z0-9-]+\.amazonaws\.com/i.test(url)) return false;
  const target = amzTarget(req);
  if (['GetUser', 'GetTokensFromRefreshToken'].includes(target)) return true;
  if (target === 'InitiateAuth') return /"AuthFlow"\s*:\s*"REFRESH_TOKEN(?:_AUTH)?"/.test(req.postData() || '');
  return false;
}

const matches = (rules, req) => rules.some((r) => (typeof r === 'function' ? r(req) : r.test(req.url())));

function stub(req) {
  const origin = req.headers()['origin'];
  const headers = { 'x-qa-write-guard': 'stubbed' };
  if (origin) Object.assign(headers, { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' });
  if (req.method() === 'DELETE' || !['fetch', 'xhr'].includes(req.resourceType())) return { status: 204, headers, body: '' };
  return { status: 200, headers: { ...headers, 'content-type': 'application/json' }, body: '{}' };
}

const short = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ allow?: Array<RegExp|Function>, sensitive?: Array<RegExp|Function>, replaceDefaults?: boolean,
 *           telemetry?: boolean, quiet?: boolean, onEntry?: Function }} opts
 */
export async function installWriteGuard(context, opts = {}) {
  const { replaceDefaults = false, telemetry = true, quiet = false, onEntry } = opts;
  const allow = [...(replaceDefaults ? [] : DEFAULT_ALLOW), ...(opts.allow || [])];
  const sensitive = [...(replaceDefaults ? [] : DEFAULT_SENSITIVE), ...(opts.sensitive || [])];
  const log = [];

  const record = (req, action, reason) => {
    const e = { t: new Date().toISOString(), action, reason, method: req.method(), type: req.resourceType(), url: short(req.url()) };
    log.push(e);
    onEntry?.(e);
    if (!quiet) console.log(`[write-guard] ${action.padEnd(7)} ${e.method} ${e.url} (${reason})`);
  };

  await context.addInitScript(() => {
    window.__qaWriteGuard = { active: true };
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.reject(new Error('service workers disabled by write-guard'));
      }
    } catch { /* not available */ }
  });

  await context.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method();
    const apiCall = API_TYPES.has(req.resourceType()) || !SAFE.has(method);
    if (apiCall && matches(sensitive, req)) {
      record(req, 'BLOCKED', 'sends a code, SMS or e-mail');
      return route.fulfill(stub(req));
    }
    if (SAFE.has(method)) return route.fallback();
    if (matches(allow, req)) {
      record(req, 'allowed', 'auth/token refresh');
      return route.fallback();
    }
    if (telemetry && matches(DEFAULT_TELEMETRY, req)) return route.fallback();
    record(req, 'stubbed', `non-GET ${req.resourceType()}`);
    return route.fulfill(stub(req));
  });

  return {
    log,
    stopped: () => log.filter((e) => e.action !== 'allowed'),
    print() {
      console.log(`--- write guard (${log.length})`);
      for (const e of log) console.log(`  ${e.action.padEnd(7)} ${e.method} ${e.url} (${e.reason})`);
    },
  };
}
