---
name: site-crawl-audit
description: Crawl a whole site or environment and check every page — status, console and network errors, error states and soft 404s, axe, mobile overflow, phone and production links — or list where something is mentioned or linked. Use for "full test of the site", "test the whole website", "find every page that mentions X", "list all links to Y", or when the suite may miss pages.
---

# Site-wide crawl and audit

The regression suite (`web-environment-matrix`) checks a **chosen** list of critical paths.
A crawl checks **everything**, less deeply. The two find different things: a crawl once
found a whole product section down on acceptance that the suite, loading only its index
page, passed. When the crawl finds something the suite missed, add it to the suite.

Crawl with Playwright — hundreds of pages need a script, not a browser pane; copy the kit
in `scripts/` (see Scripts) rather than writing one. For a quick look at one page the
in-app pane is fine if the site isn't blocked by policy; if it is refused once, use
`playwright-cli` rather than retrying.

## Quick looks: playwright-cli

For looking around rather than running a crawl — "what does this page do", "which request
fails when I click this", "what's in localStorage after login" — use Microsoft's
`playwright-cli` (`npm install -g @playwright/cli`) from the terminal instead of writing a
throwaway script:

```bash
playwright-cli open https://acc.example.com/ --headed   # or --mobile
playwright-cli snapshot                  # accessibility tree with element refs (e12…)
playwright-cli click e12
playwright-cli console error             # console messages
playwright-cli requests                  # network log; request/response-body <n> for detail
playwright-cli localstorage-list
playwright-cli route "**/api/products**" --status=500   # force an error state
playwright-cli state-save .auth/acc.json # after the user logged in by hand (headed)
playwright-cli close
```

Prefer `snapshot` / `find` over screenshots — text is cheaper and precise. Use named
sessions (`-s=acc`) to keep environments apart. Anything you'll need again belongs in the
suite, not in a CLI session: the CLI is for finding out, the suite is for checking.

## Getting the page list

- **Sitemap first** when it exists (`/sitemap.xml`; previews often don't have one). It
  is often a **sitemap index** — a list of `<sitemap><loc>` pointing at `sitemap-0.xml`
  and friends, not `<url>` entries. Follow those. Reading only the index once gave a
  "site" of one URL.
- Otherwise **follow links** from `/`: internal `href`s only, strip `#` and query strings,
  skip framework assets (`/_next`) and file extensions, cap the count (`MAX=200` is a
  sensible default) and log that you capped it.
- Record the number of pages per environment — different counts are a finding to explain,
  not an error.
- **Before a release, save the crawl as a baseline** (one JSON per environment) and diff
  the next crawl against it: new non-200s, new error states, pages that disappeared. The
  diff is what finds a regression on a big site — a new soft 404 (200, "Page not found"
  rendered) showed up only as a change against the baseline.

## Per page

Load with `domcontentloaded`, then wait for a real element (a heading, `main`) or the
page's main API response (`page.waitForResponse`) — **not `networkidle`**, which never
settles on sites with analytics beacons (see `web-environment-matrix`; cap it at a few
seconds if you use it at all). Record:

- status, final URL, `<title>`, first `<h1>`, load time
- console errors and uncaught page errors
- failed requests — ignoring `net::ERR_ABORTED`, which is the client cancelling — and
  responses ≥ 400, **with the URL**
- visible error states ("Unable to load", "Something went wrong", "Page not found") in
  the rendered text — a page can return 200 and render an error card or a soft 404

Then group: the same failing URL across many pages is one finding, not forty. Report
missing titles or h1s, and median / p90 / slowest load times.

## Accessibility

Inject `axe-core` (`page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') })`)
and run `axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })`
on a sample of page templates (home, a listing, a detail page, a form, the 404 page) —
not every page; templates repeat. Sort by impact. Decline the cookie banner first, or it
dominates the results.

## Mobile overflow

At 390×844 with `isMobile` and `hasTouch`: compare `documentElement.scrollWidth` with
`clientWidth`, and list the elements whose `getBoundingClientRect().right` exceeds the
viewport. Third-party iframes (translation widgets) are a common cause.

## Content checks that pay off

- **Phone links:** every `a[href^="tel:"]` should match `^tel:\+?[0-9][0-9\-\s().]*$`.
  Real finds: `https://tel:911`, `tel:++1-800…`, a `=` inside a number. These are usually
  CMS content — check whether they differ per environment.
- **Hard-coded production links** on non-production environments (`href` to the
  production domain), which silently send testers to production.
- **An error page with its message baked into an image** (no `h1`, no text).

## Inventory: "where is X mentioned / linked"

Keep **mentions** and **links** apart — they answer different questions and users almost
always want one of them:

- *Links*: `a[href]` whose target matches the domain or path in question, with the link
  text and the page.
- *Mentions*: text matches in the rendered `main` content (not nav, footer or a
  marketplace block unless asked), with a short snippet. Match on `innerText`, **never on
  the raw HTML**: Next.js and similar frameworks embed `__NEXT_DATA__`, translation
  dictionaries and JSON blobs in every page, so a raw-HTML search reports a "mention" on
  all 649 pages.

Ask which one is wanted if it's unclear, and state what you excluded (navigation, footer,
specific sections). Report as a table: page, type (link / mention), text, target.

## Scripts

A project-agnostic kit in `scripts/`. Copy it into the project repo (the plugin path changes
per version) and run it from there, with `npm i -D playwright axe-core`. Everything
site-specific is a flag; the CMP hosts, decline buttons and error texts are constants at the
top of each file.

- `crawl.mjs` — `node crawl.mjs <baseUrl> [--max 200] [--workers 4] [--out out/<label>.json] [--mobile]
  [--prod-host www.example.com] [--block-cmp | --decline '<css>'] [--storage .auth/acc.json]`.
  Everything under "Per page", "Mobile overflow" and "Content checks", plus an internal link
  check and a 404 probe, into one JSON. Run it once with `--mobile`.
- `report.mjs` — `node report.mjs out/<label>.json`: verdict first, findings grouped by cause,
  code separated from content, median / p90 / slowest.
- `diff.mjs` — `node diff.mjs baseline.json current.json`: only what is new; exit code 1 when
  something is.
- `axe.mjs` — `node axe.mjs <url...> | --from out/<label>.json [--compare https://www.example.com]`:
  violations by impact with node counts; `--compare` keeps only what the other host doesn't have.
- `inventory.mjs` — `node inventory.mjs <crawl.json|baseUrl> --links <domain|/path> | --mentions "<text>"`:
  the table described under Inventory.

Consent: by default the scripts click "decline"; `--block-cmp` blocks the CMP instead — faster,
but the page is then tested without it, and "<CMP> is not defined" errors are the crawl's own.

## Report

Verdict first — how many pages, how many with problems, the top findings grouped by
cause. Separate **content** issues (fix in the CMS, often identical on all environments)
from **code / infrastructure** issues. Name what the crawl did not do: authenticated pages,
forms submitted, interactive widgets. Use `qa-test-report` for the write-up.
