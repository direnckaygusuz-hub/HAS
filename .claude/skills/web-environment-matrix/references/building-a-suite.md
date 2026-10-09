# Building or extending an environment-matrix suite

Read from the `web-environment-matrix` skill when setting up a suite or adding checks.
Running and reading a suite is in the skill itself.

## A 200 is not health

A status check proves one thing: the server answered. It says nothing about whether the
page works. The failure that actually reaches visitors looks like this: the document
returns 200, renders its shell and its FAQ, and where the functionality should be there
is an error card, because the API behind it is down.

Three rules follow, and the first one is the expensive one to learn:

**1. The browser-based check covers every critical path, not a subset.** It is tempting
to browser-test six representative pages and status-check the rest — it is faster and it
feels proportionate. It is not: every page outside that subset is then completely
untested for the one failure class that matters most. A whole product section can be
broken for months while the matrix stays green. If a path is important enough to sit in
the critical list, it is important enough to load in a browser.

**2. Assert on the visible error state, not only on the console.** A well-built app
catches its own failures. It logs nothing, throws nothing, and calmly renders "Unable to
load". Console checks stay silent; the visitor sees a broken page. So assert that a short
list of error phrases is *absent* from the rendered page:

```ts
const ERROR_STATE_PATTERNS = [/unable to load/i, /system error/i, /something went wrong/i];
```

Keep that list short and specific. Every phrase added is a chance of a false positive on
a content page that happens to use the words.

**3. One page per section is not coverage.** If a section has an index page plus five
detail pages, and each detail page calls its own endpoint, then testing only the index
tests only the index. List the detail pages individually. The cost is a few lines of
config; the alternative is discovering the gap from a colleague instead of from the
suite.

## Feature flags are the quietest environment difference

Same code, same build, different behaviour — because a remote flag service says so. This
is the hardest difference to diagnose from the outside, and the easiest to record.

Put a flag comparison in the suite and treat its two failure modes differently:

- **Fail** when the flag service cannot be reached. Apps fall back to their compiled-in
  defaults, and those are almost always `false`. A site that silently switches half of
  itself off is an incident, not a difference.
- **Report, do not fail,** on flags that differ between environments. Different flags per
  environment is usually the whole point of having environments.

Attach the full flag table to the run. It turns "why does acc behave differently" from an
afternoon in a minified bundle into one glance at the report.

## Assert on structure, not on values

Environments diverge structurally in content — on one project, test had 571 paths,
acc 568 and production 644. It follows that:

- assert **"there are result rows carrying an order number"**, not "order 1234 is there"
- the sitemap comparison **reports** differences and does not fail on them; it fails only
  when a sitemap is broken or suspiciously small
- known, accepted differences belong in a `known-differences` allowlist, not in the test

## Environment properties belong in config, not in the test

Pin down per environment what you may expect there, so one test behaves correctly
everywhere:

- `expectNoindex` — test/acc **must** be `noindex`, production must **not** be. This is
  the check that keeps an entire site out of the index when it goes wrong.
- `expectCdnHeaders` — a preview runs on different infrastructure and does not set the
  CDN headers. That is not a regression; without this flag every preview run goes red.
- `expectSitemap` — generated as a postbuild step, which does not always run on previews.
- `allowedTags`, `isProduction`, `baseURL`, `label`.

The rule behind it: **a difference caused by infrastructure rather than by code belongs
in config, not in an exception inside the test.**

## Selector rules

Modern CSS-in-JS generates class names like `css-1g8bhgd` that **change on every build**.
A test selecting on those breaks at the next deploy without anything being wrong.

In order of preference:

1. `getByRole()` with the accessible name
2. `getByLabel()`
3. a stable id the app sets itself

Do not use: generated classes, and auto-numbered ids (`downshift-0-input`) — those
numbers shift as soon as a field is added.

**Keep all locators in one file.** When something breaks after a UI change you edit one
file instead of thirty tests.

### Watch out: unscoped option queries

Third-party widgets inject hidden form elements. A translation widget drops in a hidden
`<select>` of languages, so an unscoped `page.getByRole('option')` returns the
**language list** instead of the options of the component under test. Always scope
option queries to their own form or dialog.

## What you check by default

**Technical** (no domain knowledge needed, covers what breaks at a promotion):

- status codes and unexpected redirects across the critical paths
- `<title>`, meta description, og tags, a canonical pointing at its own environment
- robots meta and `robots.txt` per the environment rule
- security headers, and a cache `max-age` on HTML that is not too high
- **every critical path loaded in a real browser**, checking both JavaScript errors and
  failed requests *and* the absence of a visible error state
- broken internal links

**Functional**: the real flows — search, listings, forms up to the confirmation point,
sign-in validation, main navigation, and **the interactive widgets**. Widgets are easy to
forget because they are not pages: a chatbot, a live tracker, a seat picker. They are also
where third-party backends fail, so they deserve a test that actually uses them rather
than one that checks they render.

For a widget, split the test in two: does it *open*, and does it *work*. The front end
almost always opens — the SDK loads, the panel appears — while the backend is
unreachable. Two separate results tell you which half is broken; one combined result tells
you only that something is.

**Comparative**: which build sits where, which pages differ, whether tag manager container
and headers match, and which feature flags are set per environment.

## Adding a check

**Make every new check go red once before you trust it.** Break the condition on purpose
— mock the API to fail, point it at a path you know is broken, invert the assertion —
and confirm the test fails with a readable message. A test for a live-data page was once
added green while the page was visibly broken, because it waited for the skeleton, not the
data. A check that has never failed has not been shown to check anything.

The easiest way to break it is in the browser, with `page.route`:

```ts
await page.route('**/api/availability**', route => route.fulfill({ status: 404, body: '' }));
await goto('/availability/');
await expect(page.getByText(/unable to load/i)).toBeVisible();   // the error state must appear
```

The same technique tests the page's error handling itself — does it show an error card,
or stay a skeleton forever? This is the web counterpart of `mobile-network-injection`, and
needs no proxy.

**Use `expect.soft` for independent checks on one page** (title, canonical, robots, error
state, console errors), so a single run reports every problem instead of stopping at the
first. Keep hard `expect` for preconditions — if the page didn't load, the rest is noise.

**Wrap each phase in `test.step()`**, so a failed matrix cell names the step, not just the
test — for a widget, *opens* vs *works*:

```ts
await test.step('opens', async () => { /* panel visible */ });
await test.step('works', async () => { /* message sent, answer streamed */ });
```

The gain is that a new test **automatically runs on every environment**:

```ts
test('my check', { tag: '@read-only' }, async ({ goto, page, env }) => {
  await goto('/path/');
  await expect(page.getByRole('heading', { name: 'Heading' })).toBeVisible();
});
```

The fixture provides: `goto(path)` (navigates and dismisses the cookie banner), `env`
(baseURL, expectations, permissions) and a collector for console errors and failed
requests.
