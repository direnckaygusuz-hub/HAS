#!/usr/bin/env node
// diff.mjs — what is new in a crawl compared with a baseline crawl (both written by crawl.mjs).
// Pages are matched by path, so a baseline from another host (production) works too.
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
//   node diff.mjs baseline.json current.json [--examples 4]
//
// Reports, per kind and grouped by cause: new non-200s and navigation errors, new error states and
// soft 404s, pages that disappeared / appeared, new page errors, new console errors, new failed
// requests / responses >= 400, new and fixed overflow, new malformed tel: links, suspicious hrefs,
// production links and placeholders, lost titles and h1s, text that shrank by more than half, new
// broken internal links, and the load-time change. "New" is per page: an error that was already on
// that page in the baseline is not new; "(known on N baseline pages)" says it existed elsewhere.
// Exit code 1 when there are new problems, 0 when not, 2 on bad input. Third-party failures,
// appeared pages and fixes are listed but do not set the exit code. When either crawl was capped,
// disappeared/appeared pages are listed as unreliable and do not set the exit code either.
// No dependencies.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (files.length !== 2) { console.error('usage: node diff.mjs <baseline.json> <current.json>'); process.exit(2); }
const EX = Number(opt('examples', 4));
const [A, B] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const norm = (origin) => (s) => String(s).split(origin).join('')
  .replace(/_next\/static\/[^/\s]+\//g, '_next/static/*/').replace(/\?[^\s]*/g, '')
  .replace(/[0-9a-f]{12,}/gi, '#').replace(/\d{5,}/g, 'N');
const nA = norm(A.meta.origin), nB = norm(B.meta.origin);
const a = new Map(A.pages.map((r) => [r.path, r])); const b = new Map(B.pages.map((r) => [r.path, r]));
const both = [...b.keys()].filter((p) => a.has(p));
const capped = A.meta.capped || B.meta.capped;
let problems = 0;
const out = [];
const section = (title, rows, counts = true) => {
  if (!rows.length) return;
  if (counts) problems += rows.length;
  out.push(`\n${title} (${rows.length})`, ...rows.slice(0, 40).map((r) => '  ' + r));
  if (rows.length > 40) out.push(`  … ${rows.length - 40} more`);
};
const bad = (r) => !r || r.navError || r.status >= 400;
const ex = (ps) => ps.slice(0, EX).join(' ') + (ps.length > EX ? ' …' : '');

// Status and navigation
section('NEW NON-200 / NAVIGATION ERRORS', [
  ...both.filter((p) => !bad(a.get(p)) && bad(b.get(p))).map((p) => `${p}  ${a.get(p).status} -> ${b.get(p).navError || b.get(p).status}`),
  ...[...b.keys()].filter((p) => !a.has(p) && bad(b.get(p))).map((p) => `${p}  (new page) ${b.get(p).navError || b.get(p).status}`),
]);
section('NEW ERROR STATES / SOFT 404s', B.pages.filter((r) => r.errorState && a.get(r.path)?.errorState?.kind !== r.errorState.kind)
  .map((r) => `${r.path}${a.has(r.path) ? '' : ' (new page)'}  ${r.errorState.kind}: "${r.errorState.text}"`));
const gone = [...a.keys()].filter((p) => !b.has(p)); const added = [...b.keys()].filter((p) => !a.has(p));
section(`PAGES THAT DISAPPEARED${capped ? ' — unreliable, a crawl was capped' : ''}`, gone, !capped);

// Grouped message kinds
const own = (l) => / \//.test(l);
for (const [key, title, filter] of [
  ['pageErrors', 'NEW UNCAUGHT PAGE ERRORS'],
  ['console', 'NEW CONSOLE ERRORS'],
  [['badResponses', 'failedRequests'], 'NEW FAILED REQUESTS / >= 400 (this host)', own],
  [['badResponses', 'failedRequests'], 'NEW FAILED REQUESTS / >= 400 (third party — not counted)', (l) => !own(l)],
  ['badTel', 'NEW MALFORMED tel: LINKS'], ['badHrefs', 'NEW SUSPICIOUS HREFS'],
  ['prodLinks', 'NEW HARD-CODED PRODUCTION LINKS'], ['placeholders', 'NEW PLACEHOLDER TEXT'],
]) {
  const keys = [].concat(key);
  const vals = (r, n) => keys.flatMap((k) => (r[k] || []).map((x) => n(typeof x === 'object' ? x.href : x))).filter((x) => !filter || filter(x));
  const base = new Map(); for (const r of A.pages) for (const x of new Set(vals(r, nA))) base.set(x, (base.get(x) || 0) + 1);
  const m = new Map();
  for (const p of both) {
    const old = new Set(vals(a.get(p), nA));
    for (const x of new Set(vals(b.get(p), nB))) if (!old.has(x)) (m.get(x) || m.set(x, []).get(x)).push(p);
  }
  for (const p of added) for (const x of new Set(vals(b.get(p), nB))) if (!base.has(x)) (m.get(x) || m.set(x, []).get(x)).push(p);
  const rows = [...m].sort((x, y) => y[1].length - x[1].length)
    .map(([x, ps]) => `${String(ps.length).padStart(4)}  ${x.slice(0, 180)}${base.has(x) ? `  (known on ${base.get(x)} baseline pages)` : ''}\n        ${ex(ps)}`);
  section(title, rows, !/not counted/.test(title));
}

// Overflow
const ov = (r) => r?.overflow ? `+${r.overflow.px}px${r.overflow.scrollable === false ? ' (cannot pan)' : ''} ${r.overflow.elements.map((e) => e.el).join(', ')}` : '';
section('NEW HORIZONTAL OVERFLOW', both.filter((p) => b.get(p).overflow && !a.get(p).overflow).map((p) => `${p}  ${ov(b.get(p))}`));
section('OVERFLOW FIXED', both.filter((p) => a.get(p).overflow && !b.get(p).overflow && !bad(b.get(p))), false);

// Lost structure
section('TITLE LOST', both.filter((p) => a.get(p).title && !b.get(p).title && !bad(b.get(p))));
section('H1 LOST', both.filter((p) => a.get(p).h1 && !b.get(p).h1 && !bad(b.get(p))));
section('TEXT SHRANK BY MORE THAN HALF', both.filter((p) => a.get(p).textLen > 500 && (b.get(p).textLen ?? 0) < a.get(p).textLen * 0.5)
  .map((p) => `${p}  ${a.get(p).textLen} -> ${b.get(p).textLen ?? 0} chars`));

// Broken links
const oldLinks = new Set((A.brokenLinks || []).map((l) => new URL(l.url).pathname));
section('NEW BROKEN INTERNAL LINKS', (B.brokenLinks || []).filter((l) => !oldLinks.has(new URL(l.url).pathname))
  .map((l) => `${l.status ?? l.error} ${new URL(l.url).pathname}  linked from ${ex(l.from)}`));

// Informational
section('ERROR STATES GONE', A.pages.filter((r) => r.errorState && b.has(r.path) && !b.get(r.path).errorState).map((r) => r.path), false);
section(`PAGES THAT APPEARED${capped ? ' — unreliable, a crawl was capped' : ''}`, added, false);
const med = (R) => { const m = R.map((r) => r.ms).filter((x) => x != null).sort((x, y) => x - y); return m.length ? `median ${m[m.length >> 1]} ms, p90 ${m[Math.floor(m.length * 0.9)]} ms` : '-'; };

const head = (X) => `${X.meta.base}  ${X.meta.date.slice(0, 16).replace('T', ' ')}  ${X.meta.count} pages (${X.meta.source}${X.meta.capped ? ', capped' : ''}, ${X.meta.viewport})`;
console.log(`${problems ? 'NEW PROBLEMS' : 'NO NEW PROBLEMS'}: ${problems} new finding row(s) against the baseline`);
console.log(`  baseline ${head(A)}\n  current  ${head(B)}`);
if (A.meta.viewport !== B.meta.viewport) console.log('  WARNING: different viewports — overflow and layout rows are not comparable');
console.log(`  load: baseline ${med(A.pages)} | current ${med(B.pages)}`);
console.log(out.join('\n') || '\nnothing changed');
process.exit(problems ? 1 : 0);
