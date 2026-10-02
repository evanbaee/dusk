import { luminance, parseColor, type RGBA } from './color';

const MEDIA = new Set(['IMG', 'VIDEO', 'CANVAS', 'IFRAME', 'PICTURE', 'EMBED', 'OBJECT', 'svg']);
const DARK_L = 0.45; // OKLab lightness below which a surface counts as dark

export interface Measurement {
  /** Share of sampled points sitting on a dark surface (0..1), or null if too few samples. */
  darkRatio: number | null;
  /** Share of sampled text that is light (0..1), or null if no text was sampled. */
  lightText: number | null;
  samples: number;
}

function shadowOf(el: Element): ShadowRoot | null {
  try {
    return chrome.dom?.openOrClosedShadowRoot(el as HTMLElement) ?? null;
  } catch {
    return el.shadowRoot;
  }
}

/** Elements under a point, descending into shadow roots. */
function stackAt(x: number, y: number): Element[] {
  let stack = document.elementsFromPoint(x, y);
  for (let depth = 0; depth < 4; depth++) {
    const host = stack[0];
    const root = host && shadowOf(host);
    if (!root) break;
    const inner = root.elementsFromPoint(x, y).filter((e) => e !== host && root.contains(e));
    if (!inner.length) break;
    stack = [...inner, ...stack];
  }
  return stack;
}

function firstGradientColor(image: string): RGBA | null {
  const m = /(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\))/i.exec(image);
  return m ? parseColor(m[1]) : null;
}

function canvasColor(): RGBA | null {
  const html = document.documentElement;
  const body = document.body;
  for (const el of [html, body]) {
    if (!el) continue;
    const c = parseColor(getComputedStyle(el).backgroundColor);
    if (c && c.a > 0.5) return c;
  }
  if (window !== window.top) return null; // iframes are transparent by default
  const scheme = getComputedStyle(html).colorScheme;
  const dark = /\bdark\b/.test(scheme) && !/\blight\b/.test(scheme);
  return dark ? { r: 0.07, g: 0.07, b: 0.07, a: 1 } : { r: 1, g: 1, b: 1, a: 1 };
}

function surfaceAt(stack: Element[]): RGBA | null | 'skip' {
  for (const el of stack) {
    if (MEDIA.has(el.tagName)) return 'skip';
    const cs = getComputedStyle(el);
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg.a >= 0.5) return bg;
    const img = cs.backgroundImage;
    if (img && img !== 'none') {
      if (img.includes('gradient')) return firstGradientColor(img) ?? 'skip';
      return 'skip';
    }
    if (el === document.documentElement || el === document.body) break;
  }
  return canvasColor();
}

export function measure(): Measurement {
  const w = window.innerWidth;
  const h = window.innerHeight;
  let dark = 0;
  let known = 0;
  let lightText = 0;
  let texts = 0;

  if (w > 0 && h > 0 && document.body) {
    const cols = 6;
    const rows = 6;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = ((i + 0.5) / cols) * w;
        const y = ((j + 0.5) / rows) * h;
        const stack = stackAt(x, y);
        const surface = surfaceAt(stack);
        if (surface && surface !== 'skip') {
          known++;
          if (luminance(surface) < DARK_L) dark++;
        }
        const top = stack[0];
        if (top && !MEDIA.has(top.tagName) && top.textContent?.trim()) {
          const c = parseColor(getComputedStyle(top).color);
          if (c && c.a > 0.3) {
            texts++;
            if (luminance(c) > 0.65) lightText++;
          }
        }
      }
    }
  }

  if (known < 4) {
    // Tiny frames or media-only pages: fall back to the page surface itself.
    const c = canvasColor();
    if (c) {
      known++;
      if (luminance(c) < DARK_L) dark++;
    }
    const body = document.body;
    if (body) {
      const t = parseColor(getComputedStyle(body).color);
      if (t) {
        texts++;
        if (luminance(t) > 0.65) lightText++;
      }
    }
  }

  return {
    darkRatio: known ? dark / known : null,
    lightText: texts ? lightText / texts : null,
    samples: known,
  };
}

/**
 * Decide whether a measurement looks like a dark page. `previous` provides hysteresis
 * so pages hovering around the threshold don't flip back and forth.
 */
export function looksDark(m: Measurement, previous?: boolean): boolean {
  if (m.darkRatio !== null && m.samples >= 4) {
    if (m.darkRatio >= 0.55) return true;
    if (m.darkRatio <= 0.4) return false;
    if (previous !== undefined) return previous;
    return (m.lightText ?? 0) >= 0.5;
  }
  if (m.darkRatio !== null) return m.darkRatio >= 0.5 || (m.lightText ?? 0) >= 0.6;
  return (m.lightText ?? 0) >= 0.6;
}
