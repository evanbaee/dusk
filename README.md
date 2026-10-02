# Dusk

A Chrome extension that turns every tab dark at night, choosing the most natural approach for each page:

1. **The site's own dark theme** — switches on `prefers-color-scheme: dark` CSS, JS themes driven by `matchMedia`, and dark `<picture>` sources.
2. **Already-dark sites** — samples the colors actually painted on screen and leaves dark pages untouched.
3. **Everything else is converted** — every color is recomputed in OKLCH according to its role (background, text, border, shadow). Hues are preserved, photos are left alone, and only black logos on transparent backgrounds are inverted.

See [PUBLISHING.md](PUBLISHING.md) (Korean) for how to publish to the Chrome Web Store.

## Features

- **Schedule** — pick when dark mode turns on and off (default 7 PM – 7 AM).
- **Instant override** — flip the switch to turn it on or off now; the schedule takes over again at the next change.
- **Per-site modes** — Auto, Always convert, or Keep original.
- **No white flash** — pages are painted dark from the first frame while dark mode is active.
- **Smooth transitions** — switching on or off cross-fades the page.
- **Private** — no data collection, analytics, or remote code. See [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm install
npm run build      # outputs dist/ — load it via chrome://extensions → "Load unpacked"
npm run watch      # rebuild on save
npm run typecheck
npm test           # unit tests for color conversion and scheduling
npm run e2e        # loads the extension into real Chromium and renders test pages (screenshots in test/e2e/out)
npm run zip        # release/dusk-<version>.zip
```

More test scripts:

| Command | What it checks |
| --- | --- |
| `node test/e2e/schedule.mjs` | Scheduled on/off, manual override, per-site modes, script registration |
| `node test/e2e/rcs.mjs` | The JS color curves and the CSS relative-color expressions produce the same results |
| `node test/e2e/run.mjs <url…>` | Before/after screenshots and verdicts for real sites |
| `node test/e2e/perf.mjs <url…>` | Time until a page has been handled |
| `node scripts/store-assets.mjs` | Generates the store screenshots and promo tile |
| `npm run icons` | Generates the icon PNGs |

## Structure

```text
src/
  background.ts         schedule alarms, dynamic script registration, cross-origin CSS/image analysis, icon state
  main-world.ts         runs in the page's JS world: answers matchMedia as dark, reports CSSOM changes
  preflight.css         paints pages dark from the first frame while active (no white flash)
  content/
    index.ts            per-page decision: own dark theme → already dark → convert; rechecks; toggle transitions
    scope.ts            per document/shadow root: override sheets, inline styles, logo inversion, change tracking
    sheets.ts           stylesheet → color overrides, extraction of a site's dark rules, cross-origin sheets
    transform.ts        CSS value scanning, role-based conversion, custom property classification
    color.ts            OKLCH conversion curves (in JS and as CSS relative-color expressions)
    detect.ts           decides whether a page looks dark by sampling the screen
  popup/                toolbar popup (dark mode switch, schedule, per-site mode)
  shared/               settings and schedule math, message types, image analysis
```

### How it works

- **Schedule** — settings live in `chrome.storage.local`. The service worker sets a `chrome.alarms` alarm for the next change, and each content script keeps its own timer for the same moment. A manual override lasts only until the next schedule boundary.
- **No flash** — only while dark mode is active, `preflight.css` (a user-origin stylesheet) and `main-world.js` are registered at `document_start`. Sites set to "Keep original" and sites already known to be dark are excluded.
- **Conversion** — each page stylesheet gets an override sheet with the same selectors carrying only color properties, so the original cascade order is mirrored. Literal colors are computed in JS; colors coming from `var()` are wrapped in an `oklch(from …)` relative-color expression that applies the same curve at render time.
