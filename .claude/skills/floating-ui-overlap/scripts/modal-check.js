// modal-check.js — runs INSIDE the page, with the floating element's panel OPEN.
// Answers "is the open panel really modal?": which links/buttons outside it are still
// hittable (elementFromPoint at their centre returns them), whether the page behind is
// inert / aria-hidden, and whether body scroll is locked.
//
// One function expression. Call it with { selector, panelSelector? }:
//   Playwright:  const src = fs.readFileSync('modal-check.js', 'utf8');
//                const res = await page.evaluate(`(${src})(${JSON.stringify({ selector: '#chat-widget' })})`);
//   Browser pane / DevTools: const check = <file contents>; check({ selector: '#chat-widget' })
// panelSelector defaults to the first [role=dialog], <dialog> or [aria-modal] inside selector
// (or anywhere, if none inside), else the selector itself.
// This only measures. Still CLICK one reachable nav link afterwards: if the page navigates
// under the open panel, it is not modal (sweep.mjs --open does that click for you).
(function floatingModalCheck(opts) {
  const o = opts || {};
  const root = document.querySelector(o.selector);
  if (!root) return { found: false, selector: o.selector };
  const DIALOG = '[role="dialog"],[role="alertdialog"],dialog,[aria-modal="true"]';
  const panel = (o.panelSelector && document.querySelector(o.panelSelector)) ||
    root.querySelector(DIALOG) || (root.matches(DIALOG) ? root : null) || document.querySelector(DIALOG) || root;
  const inside = (el) => !!el && (root.contains(el) || panel.contains(el));
  const vw = innerWidth, vh = innerHeight;

  const reachable = [], blocked = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"]')) {
    if (inside(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const cx = Math.min(Math.max((r.left + r.right) / 2, 1), vw - 1);
    const cy = Math.min(Math.max((r.top + r.bottom) / 2, 1), vh - 1);
    const hit = document.elementFromPoint(cx, cy);
    const text = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().slice(0, 60);
    const item = { tag: el.tagName.toLowerCase(), id: el.id || null, text: text || null,
      href: el.getAttribute('href'), x: Math.round(cx), y: Math.round(cy), inNav: !!el.closest('nav,header,[role="navigation"],[role="banner"]') };
    const key = item.tag + '|' + item.text + '|' + item.href;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hit && !inside(hit) && (hit === el || el.contains(hit) || hit.contains(el))) reachable.push(item);
    else blocked.push(item);
  }

  // Is the rest of the page taken out of the a11y tree / interaction?
  const behind = [...document.body.children].filter((c) => !c.contains(root) && !c.contains(panel) &&
    !/^(script|style|noscript|template)$/i.test(c.tagName));
  const main = document.querySelector('main');
  const flagged = (attr) => behind.filter((c) => (attr === 'inert' ? c.hasAttribute('inert') || !!c.closest('[inert]') : c.getAttribute('aria-hidden') === 'true')).length;

  // Share of the viewport the open widget intercepts (20x20 grid).
  let intercepted = 0;
  for (let i = 1; i <= 20; i++) for (let j = 1; j <= 20; j++) if (inside(document.elementFromPoint(vw * i / 21, vh * j / 21))) intercepted++;

  const bs = getComputedStyle(document.body), hs = getComputedStyle(document.documentElement);
  const locked = [bs.overflow, bs.overflowY, hs.overflow, hs.overflowY].some((v) => v === 'hidden' || v === 'clip') || bs.position === 'fixed';
  const active = document.activeElement;
  return {
    found: true, viewport: { w: vw, h: vh },
    panel: { tag: panel.tagName.toLowerCase(), role: panel.getAttribute('role'), ariaModal: panel.getAttribute('aria-modal'),
      isNativeModal: panel.tagName === 'DIALOG' && panel.matches(':modal'), rect: (() => { const r = panel.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
      zIndex: getComputedStyle(root).zIndex },
    reachableOutside: reachable.length, blockedOutside: blocked.length,
    reachable: reachable.slice(0, 40), reachableNav: reachable.filter((x) => x.inNav).slice(0, 10),
    behind: { elements: behind.length, inert: flagged('inert'), ariaHidden: flagged('aria-hidden'),
      mainInert: main ? main.hasAttribute('inert') || !!main.closest('[inert]') : null,
      mainAriaHidden: main ? main.getAttribute('aria-hidden') : null },
    scroll: { locked, body: bs.overflow, html: hs.overflow, bodyPosition: bs.position },
    focusInsidePanel: inside(active), focus: active ? active.tagName.toLowerCase() + (active.id ? '#' + active.id : '') : null,
    pctViewportIntercepted: Math.round(intercepted / 400 * 100),
    verdict: reachable.length === 0 ? 'modal' : 'not-modal',
  };
})
