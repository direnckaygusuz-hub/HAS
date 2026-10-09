---
name: authenticated-testing
description: Test signed-in flows, checkout and bookings without anyone typing or pasting a password or card number: saved sessions, seeded storage, saved payment methods, safe cleanup. Use for "log in and test", "test the payment flow", "here is my password", "can you test checkout", auth for a Playwright or Maestro suite, or a login script that keeps failing.
---

# Authenticated testing without handling credentials

Claude does not type passwords or card numbers, and should not receive them in the chat.
That is not an obstacle to testing signed-in flows — it just means the login happens
once, by a human, and the result is reused.

**Say this up front.** When a task needs a login, offer the saved-session route in the
first reply. If the user pastes a password anyway, don't use it, tell them it is now in
the transcript and they may want to rotate it, and continue with the saved session.

## Web: the saved session

1. Launch a **headed** Playwright browser on the login page.
2. The user logs in by hand in that window.
3. Poll for a real signal that login finished, then save the state:

   ```ts
   // Example for AWS Cognito — wait for whatever key *your* app writes on login
   await page.waitForFunction(() =>
     Object.keys(localStorage).some(k => k.includes('CognitoIdentityServiceProvider') && k.endsWith('.idToken')),
     null, { timeout: 180_000 });
   await context.storageState({ path: '.auth/<env>.json' });
   ```

4. Every later run loads `storageState: '.auth/<env>.json'` and is fully automated. In a
   Playwright suite, do this in a `setup` project that the other projects depend on
   (`dependencies: ['setup']`), and have it **reuse the saved file** when it is still
   valid — it should only open a headed window when the session has expired.

For a quick session without a script: `playwright-cli open <login url> --headed`, let the
user log in, then `playwright-cli state-save .auth/<env>.json`. Load it later with
`state-load`.

Traps that each cost a round of "run the login script again":

- **Don't wait for `networkidle`.** Analytics beacons keep the network busy forever; the
  login wait times out after a successful login (full rule in `web-environment-matrix`).
- **Look where the app keeps its session.** AWS Cognito / Amplify stores tokens in
  `localStorage` (`CognitoIdentityServiceProvider.<clientId>.<user>.idToken`), not in a
  cookie. Waiting for a session cookie never succeeds. Read the app's storage after a
  manual login once and wait for what is really there.
- **Don't fall back to a vague selector.** "The first button in the header" clicked a hero
  video's *Pause video* button. Use `getByRole` with the exact accessible name, and note
  that the account button's label usually changes once signed in — that change is a good
  login signal too.
- **One state file per environment.** Accounts and tokens differ between test, acc and
  production. Name the file after the environment and never reuse one across them.
- **Check the saved session before the run, not during it.** Decode the token's `exp`
  (or check the cookie's expiry) and ask for a fresh login up front if it expires within
  the run. A session that dies halfway turns the second half of the results into login
  redirects. `scripts/session-check.mjs --env acc` does this and exits 2 when it won't last.
- **Hand the user commands they can run from anywhere:** `cd <absolute project path> &&
  APP_ENV=acc node save-session.mjs <login url> --wait-storage-key …`, and resolve the
  output path relative to the script's own file. Run from `~`, a bare `node save-session.mjs` fails with "Cannot find
  module" and costs a round trip.
- Keep `.auth/` and `.env` in `.gitignore`.

Credentials for an automated login (a dedicated test account) belong in `.env`, loaded
explicitly by the suite. A missing variable must produce a **loud skip with a reason**,
never a silently skipped test.

## Seed the source, not the UI

When a value is read from `localStorage` (or a cookie) at the moment it is used, set it in
`addInitScript` and any value can be exercised without an account:

```ts
await context.addInitScript(() => localStorage.setItem('loyaltyTier', 'Gold'));
```

Read the code that writes the key first, so the test uses exactly the key and value shape
the app uses.

## Payment and bookings

- **Use a saved payment method.** If the test account has a stored card, checkout becomes
  "select and pay" and nobody types a number. Check for one before saying a flow can't be
  tested.
- **Confirm before anything irreversible** — a real purchase, booking, cancellation or
  refund — with the amount and the item, in the chat. One approval covers one action.
  That includes anything that **sends an SMS, email or one-time code**: a 2FA "Next" or
  "Resend code" reaches a real phone or inbox. A write guard that stubs non-GET requests
  must cover those calls too, and must let the auth refresh through — blocking it signs
  the user out mid-test.
- **Clean up what you created, and only that.** Verify the booking number or record ID is
  the one you created before cancelling; never cancel "the latest" booking on a shared
  account.
- **Multi-step confirms look like broken buttons.** If a confirm control's handler only
  sets state, it opens the next step. Re-read the dialog after clicking instead of
  concluding the click failed.

## Mobile apps

The same principle: the user signs in once on the device, and the flows start from that
state. With Maestro, don't `clearState` in flows that need the session, and match auth
state across builds when comparing two (see `android-build-regression`). Never put
credentials in a flow file; use `env` variables from a local, git-ignored file for a
dedicated test account.

## Scripts

Project-agnostic session helpers in `scripts/` (Node 20+, `playwright` only). Copy both
into the project repo next to each other; they write and read `.auth/<env>.json` relative
to their own file, so they work from any directory.

- `save-session.mjs` — `node save-session.mjs <login url> --env acc [--wait-storage-key REGEX | --wait-cookie NAME | --wait-text TEXT] [--reuse]`: headed browser, the user logs in by hand, the script waits for the signal and saves the storageState. No signal given: press Enter once signed in. `--reuse` skips the browser while the saved session is still good.
- `session-check.mjs` — `node session-check.mjs --env acc [--min 60] [--strict]`: decodes `exp` of every JWT in the saved cookies and localStorage and prints the time left; exit 2 if one expires within the run. Tokens next to a refresh token count as renewable unless `--strict`.

The write guard that lets the token refresh through while blocking writes and code senders is
`write-guard.mjs` in `web-feature-test`.
