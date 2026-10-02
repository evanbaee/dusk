/**
 * Decides whether an image is a dark, mostly-monochrome graphic on a transparent
 * background — a black wordmark or icon that would vanish on a dark page. Those get
 * inverted; photos and anything with its own background are left alone.
 */

const DARK_Y = 0.064; // relative luminance ≈ OKLab L 0.4

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

export function pixelsLookDark(data: Uint8ClampedArray): boolean {
  let transparent = 0;
  let opaque = 0;
  let dark = 0;
  const total = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 30) {
      transparent++;
      continue;
    }
    if (a < 128) continue;
    opaque++;
    if (luminance(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255) < DARK_Y) dark++;
  }
  if (!total || !opaque) return false;
  return transparent / total >= 0.2 && dark / opaque >= 0.55;
}

const COLOR = /(?:fill|stroke|stop-color|color)\s*[:=]\s*["']?\s*(#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|[a-z]+)/gi;
const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  blue: [0, 0, 255],
  navy: [0, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  green: [0, 128, 0],
};

function rgb(text: string): [number, number, number] | null {
  const t = text.toLowerCase();
  if (t.startsWith('#')) {
    let h = t.slice(1);
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4)];
  }
  if (t.startsWith('rgb')) {
    const p = t.match(/[\d.]+/g)?.map(Number);
    return p && p.length >= 3 ? [p[0], p[1], p[2]] : null;
  }
  return NAMED[t] ?? null;
}

export function svgLooksDark(text: string): boolean {
  if (/<(image|foreignObject)\b/i.test(text)) return false;
  if (!/<(path|text|rect|circle|ellipse|polygon|polyline|line|use)\b/i.test(text)) return false;
  let dark = 0;
  let total = 0;
  for (const m of text.matchAll(COLOR)) {
    const v = m[1].toLowerCase();
    if (v === 'none' || v === 'transparent' || v === 'inherit') continue;
    if (v === 'currentcolor') {
      total++;
      dark++;
      continue;
    }
    const c = rgb(v);
    if (!c) continue;
    total++;
    if (luminance(c[0] / 255, c[1] / 255, c[2] / 255) < DARK_Y) dark++;
  }
  // No colors at all means everything is painted with the default black fill.
  if (!total) return true;
  return dark / total >= 0.7;
}
