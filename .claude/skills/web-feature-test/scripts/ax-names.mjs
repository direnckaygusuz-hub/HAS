#!/usr/bin/env node
// qa-toolkit 0.8.1 — copy into the project repo; compare with the plugin copy before trusting an old one.
/**
 * ax-names.mjs — accessible-name check from Chrome's own accessibility tree.
 *
 * Reads Accessibility.getFullAXTree over CDP and lists interactive nodes (button, link, combobox,
 * textbox, searchbox, checkbox, radio, switch, menuitem, tab) whose computed name is empty, and
 * names used by more than one control of the same role. This is the name a screen reader gets —
 * axe missed empty button names in a real session that this caught.
 *
 * CLI:
 *   node ax-names.mjs <url> [--compare <otherUrlOrOrigin>] [--storage .auth/<env>.json] [--mobile]
 *                     [--wait <selector>] [--roles button,link]
 *   --compare runs the same path on another host (give just the origin, e.g. https://www.example.com,
 *   to reuse the first URL's path) and reports the nodes that are unnamed only on the first —
 *   "new in this build" versus "already on production". --storage applies to the first URL only;
 *   pass --compare-storage for the other host (a session file belongs to one environment).
 *   Exit code 1 when unnamed nodes are found (with --compare: only those not on the other host).
 *
 * Module:
 *   import { axIssues, printAxIssues } from './ax-names.mjs';
 *   printAxIssues(await axIssues(page));          // or s.axNames() from steps.mjs
 *
 * Duplicate names are a prompt to look, not a finding: five "Read more" links are only a problem
 * when nothing around them tells them apart. Only the main frame is read.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ROLES = ['button', 'link', 'combobox', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'menuitem', 'tab'];

const KEEP_ATTRS = ['type', 'name', 'data-testid', 'data-test', 'data-qa', 'aria-haspopup', 'aria-controls', 'aria-expanded', 'href', 'role'];

function clean(html) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>')
    .replace(/\sclass="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

/** Host-independent identity of a node, for comparing two environments. */
function signature(role, html) {
  const open = (html.match(/^<([a-z0-9-]+)([^>]*)>/i) || []);
  const tag = (open[1] || '?').toLowerCase();
  const attrs = [];
  for (const m of (open[2] || '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
    if (!KEEP_ATTRS.includes(m[1])) continue;
    let v = m[2] ?? '';
    if (m[1] === 'href') { try { v = new URL(v, 'http://x').pathname; } catch { /* keep */ } }
    if (m[1] === 'aria-controls' && /\d{2,}|:r/.test(v)) v = '*'; // generated ids differ per build
    attrs.push(`${m[1]}=${v}`);
  }
  return `${role}|${tag}|${attrs.sort().join(',')}`;
}

export async function axIssues(page, { roles = DEFAULT_ROLES, duplicates = true } = {}) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.getDocument', { depth: 0 });
    await cdp.send('Accessibility.enable').catch(() => {});
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const interactive = nodes.filter((n) => !n.ignored && roles.includes(n.role?.value));
    const empty = [];
    const names = new Map();
    for (const n of interactive) {
      const role = n.role.value;
      const name = String(n.name?.value ?? '').replace(/\s+/g, ' ').trim();
      if (!name) {
        let html = '';
        if (n.backendDOMNodeId) {
          try { html = clean((await cdp.send('DOM.getOuterHTML', { backendNodeId: n.backendDOMNodeId })).outerHTML); } catch { /* detached */ }
        }
        empty.push({ role, html, signature: signature(role, html) });
      } else if (duplicates) {
        const k = `${role}\u0000${name.toLowerCase()}`;
        const e = names.get(k) || { role, name, count: 0 };
        e.count++;
        names.set(k, e);
      }
    }
    return {
      url: page.url(),
      checked: interactive.length,
      empty,
      duplicates: [...names.values()].filter((e) => e.count > 1).sort((a, b) => b.count - a.count),
    };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

export function printAxIssues(r, label = '') {
  console.log(`${r.url}${label ? ` (${label})` : ''} — ${r.checked} interactive nodes`);
  console.log(`EMPTY NAME (${r.empty.length})`);
  for (const e of r.empty) console.log(`  ${e.role.padEnd(9)} ${e.html || '(no DOM node)'}`);
  if (r.duplicates.length) {
    console.log(`DUPLICATE NAMES (${r.duplicates.length}) — check the context tells them apart`);
    for (const d of r.duplicates.slice(0, 20)) console.log(`  ${d.role.padEnd(9)} "${d.name.slice(0, 60)}" ×${d.count}`);
  }
}

/** Unnamed nodes on A that have no counterpart (by signature and count) among B's unnamed nodes. */
export function onlyOnFirst(a, b) {
  const left = new Map();
  for (const e of b.empty) left.set(e.signature, (left.get(e.signature) || 0) + 1);
  return a.empty.filter((e) => {
    const n = left.get(e.signature) || 0;
    if (n > 0) { left.set(e.signature, n - 1); return false; }
    return true;
  });
}

function compareUrl(first, other) {
  // just an origin ("https://www.example.com" or ".../") → same path, query and hash as the first URL
  if (/^https?:\/\/[^/?#]+\/?$/i.test(other)) {
    const f = new URL(first);
    return new URL(other).origin + f.pathname + f.search + f.hash;
  }
  return new URL(other).href;
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) a._.push(k);
    else if (k === '--mobile') a.mobile = true;
    else a[k.slice(2)] = argv[++i];
  }
  return a;
}

async function main() {
  const { open } = await import('./steps.mjs');
  const a = parseArgs(process.argv.slice(2));
  const url = a._[0];
  if (!url) {
    console.log('usage: node ax-names.mjs <url> [--compare <otherUrlOrOrigin>] [--storage f] [--mobile] [--wait <selector>] [--roles button,link]');
    process.exit(1);
  }
  const viewport = a.mobile ? 'mobile' : 'desktop';
  const roles = a.roles ? a.roles.split(',') : DEFAULT_ROLES;
  const run = async (u, storage) => {
    const s = await open(u, { storage, viewport, waitFor: a.wait, quiet: true });
    const r = await axIssues(s.page, { roles });
    await s.close({ print: false });
    return r;
  };
  const first = await run(url, a.storage);
  printAxIssues(first, viewport);
  if (!a.compare) process.exit(first.empty.length ? 1 : 0);

  const otherUrl = compareUrl(url, a.compare);
  // a storage file belongs to one environment — never reuse it on the other host
  const second = await run(otherUrl, a['compare-storage']);
  console.log('');
  printAxIssues(second, viewport);
  const only = onlyOnFirst(first, second);
  console.log(`\nUNNAMED ONLY ON ${new URL(url).origin} (not on ${new URL(otherUrl).origin}) (${only.length})`);
  for (const e of only) console.log(`  ${e.role.padEnd(9)} ${e.html}`);
  process.exit(only.length ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isMain) await main();
