// overlap-analyze.js — runs INSIDE the page. Measures what a floating/fixed element
// (chat button, FAB, cookie icon, sticky banner) covers at the current viewport and scroll.
//
// The file is one function expression. Call it with { selector, margin = 8 }:
//   Playwright:  const src = fs.readFileSync('overlap-analyze.js', 'utf8');
//                const res = await page.evaluate(`(${src})(${JSON.stringify({ selector: '#chat-fab' })})`);
//   Browser pane / playwright-cli eval / DevTools: paste the file, then call it:
//                const analyze = <file contents>; analyze({ selector: '#chat-fab' })
//
// Returns { found, hidden, box, scrim, targets[], textBlocks[], collisions[], summary, ... }.
// targets[].severity: BLOCKED (centre covered) | PARTIAL (some of 5x5 grid covered) |
// OVERLAP_ONLY (boxes overlap, nothing on top) | NEAR (within margin px).
(function floatingOverlapAnalyze(opts) {
  const o = opts || {};
  const MARGIN = o.margin == null ? 8 : o.margin;
  const root = document.querySelector(o.selector);
  const vw = innerWidth, vh = innerHeight;
  const base = { selector: o.selector, viewport: { w: vw, h: vh }, scrollY: Math.round(scrollY),
    docHeight: document.documentElement.scrollHeight };
  if (!root) return { ...base, found: false };

  const inRoot = (el) => !!el && (el === root || root.contains(el));
  const round = (r) => ({ left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });

  // Opacity multiplies down the tree; an opacity-0 wrapper hides its children.
  function effectiveOpacity(el) {
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      op *= parseFloat(getComputedStyle(n).opacity);
      if (n === root) break;
    }
    return op;
  }
  function painted(el) {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && effectiveOpacity(el) > 0.01;
  }

  // 1. Box = union of root and its visible children, minus an unpainted / click-through scrim.
  const rootRect = root.getBoundingClientRect();
  const vpArea = vw * vh;
  const rects = [];
  if (rootRect.width > 0 && rootRect.height > 0) rects.push(rootRect);
  let scrim = null;
  for (const d of root.querySelectorAll('*')) {
    const r = d.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const s = getComputedStyle(d);
    const isPainted = painted(d);
    if (r.width * r.height > vpArea * 0.5) {
      // Large backdrop child. Only counts if it is painted AND catches clicks.
      const excluded = !isPainted || s.pointerEvents === 'none';
      scrim = { rect: round(r), opacity: s.opacity, effectiveOpacity: +effectiveOpacity(d).toFixed(2),
        pointerEvents: s.pointerEvents, excluded };
      if (excluded) continue;
    }
    if (!isPainted) continue;
    rects.push(r);
  }

  const rs = getComputedStyle(root);
  const hidden = rs.display === 'none' || rs.visibility === 'hidden' || effectiveOpacity(root) <= 0.01 || rects.length === 0;
  if (hidden) {
    return { ...base, found: true, hidden: true,
      hiddenBy: { display: rs.display, visibility: rs.visibility, opacity: rs.opacity },
      targets: [], textBlocks: [], collisions: [], summary: { blocked: 0, partial: 0, overlapOnly: 0, near: 0, textBlocks: 0, collisions: 0 } };
  }
  const W = {
    left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)),
    right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)),
  };
  W.width = W.right - W.left; W.height = W.bottom - W.top;
  const box = { ...round(W), right: Math.round(W.right), bottom: Math.round(W.bottom),
    fromRight: Math.round(vw - W.right), fromBottom: Math.round(vh - W.bottom),
    position: rs.position, zIndex: rs.zIndex,
    overflowsViewport: W.left < -1 || W.top < -1 || W.right > vw + 1 || W.bottom > vh + 1 };

  const overlap = (r) => Math.max(0, Math.min(r.right, W.right) - Math.max(r.left, W.left)) *
                         Math.max(0, Math.min(r.bottom, W.bottom) - Math.max(r.top, W.top));
  const near = (r) => Math.min(r.right, W.right + MARGIN) > Math.max(r.left, W.left - MARGIN) &&
                      Math.min(r.bottom, W.bottom + MARGIN) > Math.max(r.top, W.top - MARGIN);
  function visible(el, r) {
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0.01;
  }
  function describe(el) {
    const id = el.id ? '#' + el.id : '';
    const tid = el.getAttribute('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]` : '';
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '').trim();
    const text = ((el.innerText || el.value || '') + '').replace(/\s+/g, ' ').trim().slice(0, 70) || label || null;
    const href = el.getAttribute('href');
    return { sel: el.tagName.toLowerCase() + id + tid, role: el.getAttribute('role'), text, href: href ? href.slice(0, 100) : null };
  }

  // 3. Hit-test a 5x5 grid plus the centre over the part of the target inside the viewport.
  function hitProbe(r) {
    const c = { left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, vw - 1), bottom: Math.min(r.bottom, vh - 1) };
    if (c.right <= c.left || c.bottom <= c.top) return null;
    let covered = 0, blocker = null;
    for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) {
      const hit = document.elementFromPoint(c.left + (c.right - c.left) * i / 6, c.top + (c.bottom - c.top) * j / 6);
      if (inRoot(hit)) { covered++; blocker = blocker || describe(hit).sel; }
    }
    const centerCovered = inRoot(document.elementFromPoint((c.left + c.right) / 2, (c.top + c.bottom) / 2));
    return { covered: covered + (centerCovered ? 1 : 0), total: 26, centerCovered, blocker };
  }

  const INTERACTIVE = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,label,[role="button"],[role="link"],' +
    '[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="option"],[role="switch"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

  // 2. Interactive targets.
  const targets = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (inRoot(el) || el.contains(root)) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const ov = overlap(r);
    if (ov <= 0 && !near(r)) continue;
    const d = describe(el);
    const key = d.sel + '|' + d.text + '|' + Math.round(r.top) + '|' + Math.round(r.left);
    if (seen.has(key)) continue;
    seen.add(key);
    const probe = ov > 0 ? hitProbe(r) : null;
    const severity = probe && probe.centerCovered ? 'BLOCKED'
      : probe && probe.covered > 0 ? 'PARTIAL' : ov > 0 ? 'OVERLAP_ONLY' : 'NEAR';
    targets.push({ severity, ...d, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'),
      isFormControl: /^(input|select|textarea)$/.test(el.tagName.toLowerCase()) || el.getAttribute('type') === 'submit' || !!el.closest('form'),
      rect: round(r), pctAreaOverlapped: Math.round(ov / (r.width * r.height) * 100), probe });
  }

  // 4. Leaf text (own text nodes), counted per line box. Text inside an interactive target is already covered above.
  const textBlocks = [];
  const range = document.createRange();
  for (const el of document.querySelectorAll('body *')) {
    if (inRoot(el) || el.closest(INTERACTIVE)) continue;
    if (/^(script|style|noscript|template|svg)$/i.test(el.tagName)) continue;
    const nodes = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    const own = nodes.map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
    if (own.length < 2) continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r) || overlap(r) <= 0) continue;
    let covered = 0, total = 0, onTop = 0;
    for (const n of nodes) {
      range.selectNodeContents(n);
      for (const lr of range.getClientRects()) {
        total++;
        if (overlap(lr) > 0) {
          covered++;
          const cx = (Math.max(lr.left, W.left) + Math.min(lr.right, W.right)) / 2;
          const cy = (Math.max(lr.top, W.top) + Math.min(lr.bottom, W.bottom)) / 2;
          if (inRoot(document.elementFromPoint(cx, cy))) onTop++;
        }
      }
    }
    if (!covered) continue;
    textBlocks.push({ ...describe(el), text: own.slice(0, 90), rect: round(r),
      coveredLineBoxes: covered, totalLineBoxes: total, linesUnderElement: onTop });
  }

  // 5. Other fixed/sticky elements it collides with, and which one is on top.
  const collisions = [];
  for (const el of document.querySelectorAll('body *')) {
    if (inRoot(el) || el.contains(root)) continue;
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (!visible(el, r)) continue;
    const ov = overlap(r);
    if (ov <= 0 && !near(r)) continue;
    let onTop = null;
    if (ov > 0) {
      const cx = Math.min(Math.max((Math.max(r.left, W.left) + Math.min(r.right, W.right)) / 2, 0), vw - 1);
      const cy = Math.min(Math.max((Math.max(r.top, W.top) + Math.min(r.bottom, W.bottom)) / 2, 0), vh - 1);
      const hit = document.elementFromPoint(cx, cy);
      onTop = inRoot(hit) ? 'floating' : hit && (hit === el || el.contains(hit)) ? 'other' : 'neither';
    }
    collisions.push({ ...describe(el), position: s.position, zIndex: s.zIndex, rect: round(r),
      overlaps: ov > 0, pctAreaOverlapped: Math.round(ov / (r.width * r.height) * 100), onTop });
  }

  const count = (sev) => targets.filter((t) => t.severity === sev).length;
  return { ...base, found: true, hidden: false, margin: MARGIN, box, scrim, targets, textBlocks, collisions,
    summary: { blocked: count('BLOCKED'), partial: count('PARTIAL'), overlapOnly: count('OVERLAP_ONLY'), near: count('NEAR'),
      textBlocks: textBlocks.length, collisions: collisions.filter((c) => c.overlaps).length } };
})
