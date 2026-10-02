# Dusk

A Chrome extension that turns every tab dark at night, choosing the most natural approach for each page:

1. **The site's own dark theme** — if a site ships a dark theme, Dusk switches it on, logos included.
2. **Already-dark sites** — pages that are already dark are left exactly as they are.
3. **Everything else is converted** — every color is recomputed by its role: backgrounds go dark, text goes light, and buttons and brand colors keep their hue at a readable brightness. Photos are left alone, and black logos on transparent backgrounds are made visible.

## Features

- **Schedule** — pick when dark mode turns on and off (default 7 PM – 7 AM).
- **Instant override** — flip the switch to turn it on or off now; the schedule takes over again at the next change.
- **Per-site modes** — Auto, Always convert, or Keep original.
- **No white flash** — pages are painted dark from the first frame while dark mode is active.
- **Smooth transitions** — switching on or off cross-fades the page.
- **Private** — no data collection, analytics, or remote code. See [PRIVACY.md](PRIVACY.md).
