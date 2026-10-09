#!/usr/bin/env node
// report.mjs — verdict-first summary of one crawl.mjs output: pages, pages with problems, the
// findings grouped by cause (the same failing URL on forty pages is one finding), code /
// infrastructure separated from content, load times (median / p90 / slowest).
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
//
//   node report.mjs out/<label>.json [--top 15] [--examples 3]
//
// Plain text on stdout, meant to be read and then written up with qa-test-report — not pasted
// as is. No dependencies.

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const file = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
if (!file) { console.error('usage: node report.mjs <crawl.json> [--top 15] [--examples 3]'); process.exit(2); }
const TOP = Number(opt('top', 15)); const EX = Number(opt('examples', 3));
const { meta, pages: P, brokenLinks = [], notFoundProbe } = JSON.parse(readFileSync(file, 'utf8'));
const origin = meta.origin;

// Group key: strip this host, query strings, build ids and long hashes / numbers.
const norm = (s) => String(s).split(origin).join('')
  .replace(/_next\/static\/[^/\s]+\//g, '_next/static/*/').replace(/\?[^\s]*/g, '')
  .replace(/[0-9a-f]{12,}/gi, '#').replace(/\d{5,}/g, 'N');
const sameOrigin = (line) => line.includes(origin) || / \//.test(line);

// Each finding: { area: 'code'|'content'|'noise', what, key, pages:Set }
const groups = new Map();
const add = (area, what, key, path) => {
  const id = `${area}|${what}|${key}`;
  if (!groups.has(id)) groups.set(id, { area, what, key, pages: new Set() });
  groups.get(id).pages.add(path);
};
for (const r of P) {
  const p = r.path;
  if (r.navError) add('code', 'navigation error', norm(r.navError).slice(0, 120), p);
  else if (r.status >= 400) add('code', `page answers ${r.status}`, p, p);
  if (r.readyTimeout && !r.navError) add('code', 'no main/h1 within 15 s', '', p);
  if (r.errorState?.kind === 'soft404') add('code', 'soft 404 (200 + "not found" rendered)', '', p);
  if (r.errorState?.kind === 'error') add('code', 'visible error state', r.errorState.text.slice(0, 100), p);
  for (const e of new Set(r.pageErrors.map(norm))) add('code', 'uncaught page error', e.slice(0, 160), p);
  for (const l of new Set([...r.badResponses, ...r.failedRequests].map(norm))) {
    add(sameOrigin(l) ? 'code' : 'noise', sameOrigin(l) ? 'failed request / >= 400 (this host)' : 'failed request / >= 400 (third party)', l.slice(0, 180), p);
  }
  for (const c of new Set(r.console.map(norm))) add('noise', 'console error', c.slice(0, 160), p);
  if (r.overflow) for (const el of new Set(r.overflow.elements.map((e) => e.el)))
    add('code', `horizontal overflow${r.overflow.scrollable === false ? ' (page cannot be panned sideways)' : ''}`, el, p);
  if (r.overflow && !r.overflow.elements.length) add('code', 'horizontal overflow', '(no single element found)', p);
  for (const t of r.badTel || []) add('content', 'malformed tel: link', t.href, p);
  for (const h of r.badHrefs || []) add('content', 'suspicious href', norm(h), p);
  for (const h of r.prodLinks || []) add('content', `hard-coded link to ${meta.prodHost}`, norm(h).replace(/^https?:\/\/[^/]+/, ''), p);
  for (const t of r.placeholders || []) add('content', 'placeholder text', t.slice(0, 80), p);
  if (r.status === 200 && !r.navError && !r.contentType) {
    if (!r.title) add('content', 'missing <title>', '', p);
    if (!r.h1) add('content', 'no <h1>', '', p);
  }
}
for (const b of brokenLinks) for (const f of b.from) add('code', 'broken internal link', `${b.status ?? b.error} ${norm(b.url)}`, f);

const problemPages = new Set();
for (const g of groups.values()) if (g.area !== 'noise') for (const p of g.pages) problemPages.add(p);
const sorted = [...groups.values()].sort((a, b) => b.pages.size - a.pages.size);
const line = (g) => {
  const ex = [...g.pages].slice(0, EX).join(' ');
  return `  ${String(g.pages.size).padStart(4)}  ${g.what}${g.key ? ': ' + g.key : ''}\n        e.g. ${ex}${g.pages.size > EX ? ' …' : ''}`;
};
const status = {}; for (const r of P) { const k = r.navError ? 'nav-error' : r.status ?? 'none'; status[k] = (status[k] || 0) + 1; }
const ms = P.map((r) => r.ms).filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
const q = (f) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * f))] : '-';

// ---- verdict first ----
const causes = sorted.filter((g) => g.area !== 'noise');
console.log(`VERDICT  ${meta.base} — ${P.length} pages (${meta.source}${meta.capped ? `, CAPPED at ${meta.max}` : ''}, ${meta.viewport}), ` +
  `${problemPages.size} with problems from ${causes.length} distinct cause(s).`);
console.log(`         crawled ${meta.date.slice(0, 16).replace('T', ' ')} UTC, consent: ${meta.consent}${meta.storage ? ', signed in via ' + meta.storage : ', signed out'}`);
console.log(`         status ${JSON.stringify(status)}; load to main/h1 median ${q(0.5)} ms, p90 ${q(0.9)} ms`);
if (notFoundProbe) {
  const nf = notFoundProbe;
  console.log(`         404 handling: a made-up URL answers ${nf.status ?? nf.navError}${nf.status === 200 ? ' — SOFT 404 site-wide' : ''}${nf.h1 ? `, h1 "${nf.h1}"` : ', no h1'}${nf.textLen < 20 ? ', almost no text (message in an image?)' : ''}`);
}
if (meta.sitemapForeignHosts?.length) console.log(`         sitemap lists URLs on other hosts (${meta.sitemapForeignHosts.join(', ')}); crawled their paths on this host`);

console.log(`\nTOP FINDINGS BY CAUSE (pages affected)`);
for (const g of causes.slice(0, TOP)) console.log(line(g).replace(/^ {2}/, `  [${g.area}]`.padEnd(11)));
if (!causes.length) console.log('  none');

for (const [area, title] of [['code', 'CODE / INFRASTRUCTURE'], ['content', 'CONTENT (usually CMS — check whether it differs per environment)'], ['noise', 'TRIAGE — console errors and third-party failures (often not the site\'s own)']]) {
  const gs = sorted.filter((g) => g.area === area);
  if (!gs.length) continue;
  console.log(`\n${title}`);
  for (const g of gs.slice(0, area === 'noise' ? TOP : 1000)) console.log(line(g));
  if (area === 'noise' && gs.length > TOP) console.log(`  … ${gs.length - TOP} more groups`);
}

const redirected = P.filter((r) => r.finalUrl && new URL(r.finalUrl).pathname !== r.path);
if (redirected.length) {
  console.log(`\nREDIRECTED (${redirected.length})`);
  for (const r of redirected.slice(0, 15)) console.log(`  ${r.path} -> ${r.finalUrl.split(origin).join('')}`);
}
const titles = new Map(); for (const r of P) if (r.title) titles.set(r.title, (titles.get(r.title) || 0) + 1);
const dup = [...titles].filter(([, n]) => n > 3).sort((a, b) => b[1] - a[1]);
if (dup.length) { console.log('\nTITLE USED ON > 3 PAGES'); for (const [t, n] of dup.slice(0, 10)) console.log(`  ${String(n).padStart(4)}  "${t}"`); }
console.log('\nSLOWEST (to main/h1)');
for (const r of [...P].filter((r) => r.ms != null).sort((a, b) => b.ms - a.ms).slice(0, 5)) console.log(`  ${String(r.ms).padStart(6)} ms  ${r.path}`);
console.log(`\nNOT DONE  ${meta.storage ? '' : 'signed-in pages, '}forms submitted, interactive widgets beyond page load, visual comparison` +
  `${meta.capped ? `, pages beyond --max ${meta.max}` : ''}${meta.linkCheck ? '' : ', link check'}; accessibility: run axe.mjs on a sample of templates.`);
