#!/usr/bin/env node
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * chunks.mjs — grep a page's shipped JavaScript for a string or regex.
 *
 * THE BUNDLE LOCATES CODE; THE UI DECIDES THE VERDICT. Use this to find which chunk, component or
 * endpoint is involved, or whether a build contains a change at all. The same string often lives in
 * several forms (a verdict read from the bundle was once wrong because the hit was the checkout card
 * form, not the form under test). Operate the real screen before deciding pass or fail.
 *
 * Collects every script the page loads (script src, preload/modulepreload links, scripts requested
 * while loading), inline scripts, and — for Next.js pages-router builds — every route chunk listed in
 * /_next/static/<buildId>/_buildManifest.js, including routes not visited. Downloads go through the
 * browser context, so a --storage session or preview-protection cookie applies.
 *
 * CLI:
 *   node chunks.mjs <url> <pattern> [--regex] [--ignore-case] [--context 80] [--max 5] [--storage f] [--no-manifest]
 *   node chunks.mjs https://acc.example.com/ "newsletter_optin"
 *   node chunks.mjs https://acc.example.com/ "/api\/v\d+\/bookings/" --regex
 *   Prints each chunk URL with a hit, then "@offset …snippet…" lines; exit 1 when nothing matched.
 *
 * Module:
 *   import { collectChunks, grepChunks } from './chunks.mjs';
 *   const hits = await grepChunks(page, /submitBooking/);   // [{ url, offset, snippet }]
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function collectChunks(page, { manifest = true, seen = [] } = {}) {
  const found = await page.evaluate(() => ({
    src: [
      ...[...document.scripts].map((s) => s.src).filter(Boolean),
      ...[...document.querySelectorAll('link[rel=preload][as=script],link[rel=modulepreload]')].map((l) => l.href),
    ],
    inline: [...document.scripts].filter((s) => !s.src && s.textContent.trim()).map((s) => s.textContent),
    buildId: window.__NEXT_DATA__?.buildId ?? null,
    assetPrefix: window.__NEXT_DATA__?.assetPrefix ?? '',
  }));
  const urls = new Set([...found.src, ...seen]);
  if (manifest) {
    const origin = new URL(page.url()).origin;
    let mf = [...urls].find((u) => /\/_next\/static\/[^/]+\/_buildManifest\.js/.test(u));
    if (!mf && found.buildId) mf = new URL(`${found.assetPrefix || ''}/_next/static/${found.buildId}/_buildManifest.js`, origin).href;
    if (mf) {
      try {
        const r = await page.context().request.get(mf);
        if (r.ok()) {
          const base = mf.replace(/\/_next\/static\/.*$/, '/_next/');
          for (const m of (await r.text()).matchAll(/static\/chunks\/[^"'\\]+?\.js/g)) urls.add(base + m[0]);
        }
      } catch { /* no manifest */ }
    }
  }
  return { urls: [...urls], inline: found.inline };
}

function toRegExp(pattern, { regex = false, ignoreCase = false } = {}) {
  if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  const lit = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (lit) return new RegExp(lit[1], lit[2].includes('g') ? lit[2] : lit[2] + 'g');
  const flags = 'g' + (ignoreCase ? 'i' : '');
  return regex ? new RegExp(pattern, flags) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

function hitsIn(text, re, { context = 80, max = 5 } = {}) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) && out.length < max) {
    const a = Math.max(0, m.index - context), b = Math.min(text.length, m.index + m[0].length + context);
    out.push({
      offset: m.index,
      snippet: (a ? '…' : '') + text.slice(a, m.index) + '«' + m[0] + '»' + text.slice(m.index + m[0].length, b) + (b < text.length ? '…' : ''),
    });
    if (!m[0].length) re.lastIndex++;
  }
  return out.map((h) => ({ ...h, snippet: h.snippet.replace(/\s+/g, ' ') }));
}

export async function grepChunks(page, pattern, opts = {}) {
  const re = toRegExp(pattern, opts);
  const { urls, inline } = await collectChunks(page, opts);
  const hits = [];
  const queue = [...urls];
  const failed = [];
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const r = await page.context().request.get(url);
        if (!r.ok()) { failed.push(`${r.status()} ${url}`); continue; }
        for (const h of hitsIn(await r.text(), re, opts)) hits.push({ url, ...h });
      } catch (e) { failed.push(`${e.message.split('\n')[0]} ${url}`); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  inline.forEach((t, i) => { for (const h of hitsIn(t, re, opts)) hits.push({ url: `(inline script #${i + 1})`, ...h }); });
  return { hits, scanned: urls.length + inline.length, failed };
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) a._.push(k);
    else if (['regex', 'ignore-case', 'no-manifest', 'mobile'].includes(k.slice(2))) a[k.slice(2)] = true;
    else a[k.slice(2)] = argv[++i];
  }
  return a;
}

async function main() {
  const { open } = await import('./steps.mjs');
  const a = parseArgs(process.argv.slice(2));
  const [url, pattern] = a._;
  if (!url || !pattern) {
    console.log('usage: node chunks.mjs <url> <pattern> [--regex] [--ignore-case] [--context 80] [--max 5] [--storage f] [--no-manifest]');
    process.exit(1);
  }
  const seen = [];
  const s = await open(url, {
    storage: a.storage, viewport: a.mobile ? 'mobile' : 'desktop', waitFor: a.wait, quiet: true,
    setup: ({ page }) => page.on('response', (r) => { if (r.request().resourceType() === 'script') seen.push(r.url()); }),
  });
  await s.page.waitForTimeout(2000); // late chunks
  const { hits, scanned, failed } = await grepChunks(s.page, pattern, {
    regex: a.regex, ignoreCase: a['ignore-case'], manifest: !a['no-manifest'], seen,
    context: Number(a.context ?? 80), max: Number(a.max ?? 5),
  });
  let current = null;
  for (const h of hits) {
    if (h.url !== current) { console.log(`\n${h.url}`); current = h.url; }
    console.log(`  @${h.offset}  ${h.snippet}`);
  }
  const files = new Set(hits.map((h) => h.url)).size;
  console.log(`\n${hits.length} hit(s) in ${files} of ${scanned} scripts${failed.length ? `; ${failed.length} could not be fetched` : ''}`);
  for (const f of failed.slice(0, 10)) console.log(`  not fetched: ${f}`);
  console.log('The bundle locates code; the UI decides the verdict.');
  await s.close({ print: false });
  process.exit(hits.length ? 0 : 1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) await main();
