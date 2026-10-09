# How to test each condition

The methods behind the conditions table in SKILL.md. Read the section for a condition before you test it; the rules in SKILL.md (who drives what, three layers, driver-only negatives are provisional) apply throughout.

### VoiceOver

- **A single tap only moves focus.** With VoiceOver on, typing or tapping through the
  driver goes nowhere — the user double-taps to activate.
- **Record what was spoken.** With the Caption Panel on, `caption_ocr.swift --changes`
  over a burst gives a transcript of the speech. That is the evidence for a label, a
  trait or an announcement.
- **Traits aren't in the driver tree.** For "this is a heading": the user turns the rotor
  to *Headings* and swipes down. First show the rotor finds a heading somewhere on the
  screen (positive control), then judge: "Heading not found", or a caption without
  ", Heading", is the FAIL.
- **Labels** can be read from the tree, but "it's in the tree, so VoiceOver reaches it"
  is not evidence. Confirm by ear.
- **Focus after a change** (a new step, a sheet, an error): ask for "swipe right once,
  then left twice" and read the captions — that places the focus. Escape a sheet with the
  two-finger Z; explore by touch across a control to find unreachable parts.
- **Secret input** (PIN, OTP, password): type one digit and listen — a spoken digit is a
  FAIL.
- **FAIL** is: focus on the wrong element after a change, an error that isn't announced,
  a secret spoken, a missing trait the criterion asks for. A stale value that clears as
  soon as the user types is minor — say so, don't fail on it.

### Dynamic Type and layout

- Test the **largest** size and a **middle** one (three steps below the maximum). Most
  breakage shows at one of the two, not both.
- **Scrolling doesn't make it a pass.** A screen that is usable by scrolling at the
  largest size can still fail a Dynamic Type criterion — mid-word hyphenation
  ("Chall-enge"), numbers split over two lines (phone numbers, IMEIs), a label that drops
  its device or account name.
- `scripts/layout_walk.py` reports the size class per screen, clipped and truncated
  text, elements outside the safe area and overlaps. Tree findings are provisional (frames
  go stale after a scroll); the findings that held up were the ones seen in screenshots
  and still there after the screen settled.
- **Display Zoom** may be missing on the phone's iOS. *Zoom* (the magnifier) is not a
  substitute: it doesn't change the layout. For a small-width check, use a small device.
- Landscape: rotate a few times in a row and check elements and input survive. If the
  driver drops during a rotation, check the app's PID before blaming the app.

### Colour, theme and contrast

- **The loud-colour method** for "the app takes colour X from the theme": put pure red,
  green, magenta in the keys under test, capture in light and dark mode, and count with
  `scripts/colorcount.swift`. Check the **average colour** of the hits too — a wide
  tolerance once matched a navy illustration. A key with no visible surface (no tab bar
  in the app) proves nothing; say so. Restore the original theme and pixel-compare.
- **Measure contrast, don't eyeball it.** `scripts/contrast.swift` along one pixel row:
  4.5:1 for text, 3:1 for large text and for non-text such as input borders (WCAG
  1.4.11). Take the row from the element's frame in the tree × the screen scale — the
  layout shifts between light and dark, and a fixed row misses.

### Offline, background and crashes

- **Time the error state.** Poll every half second from the moment the request starts;
  three offline runs plus one online baseline. "31 s, 31 s, 31 s vs 1.7 s online" points
  straight at a timeout setting; the fix is then measurable.
- **Recovery:** come back online without touching the app, then use its retry. Look for
  dead ends — an offline web view with no close button.
- **Background work can't be triggered on a TestFlight build** (no debugger attach for
  `BGTaskScheduler`). Observe instead: a "last updated" value in the app or a widget, the
  app's PID polled every minute with `devicectl` (a suspended app keeps its PID), and
  controls — force-quit, and Background App Refresh off. If the value keeps updating in
  the controls too, it isn't the app's own task doing it, and the test can't prove the
  task works.
- Before calling a gap in background updates a finding, ask whether the phone was online
  the whole time.
- **Forced crashes** (for a crash-reporting ticket): signal the process, then check the
  `.ips` on the phone, TestFlight's crash prompt, the relaunch, and whether the crash SDK
  wrote its files in the app container. Handled errors don't produce a system report.

### Touch targets

`touch_targets.py` flags controls by their frame — the first pass. A frame FAIL is
provisional: `hit_area.py` taps around the control, and a 114×18 pt phone number that
reacted 22 pt above and below passed. Never probe a control that calls, pays or submits
without the phone in Airplane Mode and the system prompt cancelled each time. On a screen
that changes by itself (a clock, a refresh time), take a no-tap control minute first.
