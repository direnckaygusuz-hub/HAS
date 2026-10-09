---
name: floating-ui-overlap
description: Check whether a floating or fixed element — chat button, cookie icon, go-to-top button, sticky banner — covers anything across pages, viewports and scroll positions, and whether its panel is a proper modal. Use for "does the chatbot button block anything", "check the FAB placement", "is the CMP icon in the way", or a ticket about moving a floating element.
---

# Floating UI overlap check

A floating element is fixed to the viewport, so what it covers changes with the page, the
screen size and the scroll position. Checking a few screenshots by eye misses most of it.

**Start by locating it yourself.** Read its position from the DOM (`getComputedStyle`,
`getBoundingClientRect`) before trusting the brief — "bottom-left" in a ticket has turned
out to be bottom-right. If the element is hidden on some pages by design, record that per
page as *hidden*, not as a zero-size element.

## The sweep

- **Pages:** the critical paths of the regression suite, plus pages with forms near the
  bottom of the screen.
- **Viewports:** at least 375×812, 768×1024 and 1440×900.
- **Scroll positions:** top, middle (`(docHeight − viewportHeight) / 2`) and bottom.

30 pages × 3 × 3 = 270 states is normal and runs in minutes with a few parallel workers.
Dismiss the cookie banner first, wait for the page to settle, and pause briefly after each
scroll. Run the whole sweep twice; results that differ are timing, not layout.

## The analysis — run it inside the page

1. **The element's box** is the union of the root and its visible children.
2. For every visible **interactive** element (links, buttons, inputs, ARIA roles) and every
   leaf **text** element, compute the overlap with that box, plus a near-miss margin (8px).
3. **Hit-test** with `document.elementFromPoint` on a small grid (5×5 plus the centre) over
   the target. If the hit lands inside the floating element, that point is covered.
   Classify:
   - `BLOCKED` — the centre is covered (a user can't tap it)
   - `PARTIAL` — some grid points covered
   - `OVERLAP_ONLY` — boxes overlap, but nothing is actually on top
   - `NEAR` — within the margin
4. For text, count covered line boxes via `Range.getClientRects()`.
5. List **other fixed or sticky elements** it collides with (go-to-top, cookie icon,
   sticky CTA) and which one is on top.

**Exclude the scrim.** An open panel often has a full-viewport backdrop child. If it isn't
painted (opacity 0) or has `pointer-events: none`, leave it out of the box — otherwise
every element on the page counts as covered and the numbers mean nothing.

## The open panel: is it really modal?

Open the panel, then for each link and button outside it check whether `elementFromPoint`
at its centre still returns that element. Record whether the page behind is `inert` or
`aria-hidden`, and whether body scroll is locked. Then **actually click** a navigation link
behind the panel: if the page navigates away under an open chat, the panel is not modal,
and that is a finding (compare z-indexes of the panel and the header).

## Scripts

In `scripts/`. The two `.js` files are single function expressions that must run **inside the
page** — ``page.evaluate(`(${src})(${JSON.stringify(opts)})`)`` or pasted into a browser-pane
eval. Measuring from outside with locators gets neither `elementFromPoint` nor the scrim right.
- `overlap-analyze.js` — `{ selector, margin = 8 }` → box, targets with severity, text blocks, collisions.
- `modal-check.js` — `{ selector, panelSelector? }`, panel already open → hittable elements outside, inert/aria-hidden, scroll lock.
- `sweep.mjs` — the whole sweep, twice: `node sweep.mjs --base https://www.example.com --paths paths.txt
  --selector '#chat-fab' [--cookie '#decline'] [--open '#chat-fab button']`. Writes `sweep.json`,
  `summary.md` and screenshots. Needs `playwright` resolvable from the directory you run it in.

## Report

Verdict first, in numbers: "interferes on 22 of 30 pages — 6 elements blocked, 39
partially covered, 44 text blocks covered". Then ranked findings, each with page,
viewport, scroll position and a screenshot: blocked form fields and submit buttons on
mobile first, then collisions with other floating elements, then covered content links.
Include what works, and any correction to the brief (actual position). Write it up with
`qa-test-report`.
