/**
 * Color math for Dusk's conversion.
 *
 * Every color is remapped in OKLCH (perceptually uniform) according to the role it
 * plays: backgrounds go dark, text goes light, borders sit a step above surfaces and
 * shadows stay shadows. Hue is always preserved; saturated brand colors keep their
 * chroma and only have their lightness nudged into a readable range.
 *
 * The same curves exist twice: as JS (for literal colors, computed once and cached)
 * and as CSS relative-color expressions (for colors that come from var() and are
 * only known at computed-value time). Keep `transformOklch` and `relativeColor` in sync.
 */

export type Role = 'bg' | 'fg' | 'border' | 'shadow';

export interface RGBA {
  r: number; // 0..1 sRGB
  g: number;
  b: number;
  a: number; // 0..1
}

interface LCH {
  l: number;
  c: number;
  h: number;
}

const clamp = (lo: number, v: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Curves

/** 0 for neutral colors, 1 for clearly saturated ones. */
const vividness = (c: number) => clamp(0, (c - 0.04) / 0.06, 1);

/** Light surface → dark surface. White lands at 0.205, keeps small steps visible. */
const surfaceL = (l: number) => 0.205 + 0.22 * (1 - Math.exp((l - 1) / 0.22));

export function transformOklch(role: Role, l: number, c: number, h: number, alpha: number): LCH {
  const w = vividness(c);
  switch (role) {
    case 'bg': {
      const ln = Math.min(surfaceL(l), 0.16 + 0.484 * l);
      const lv = clamp(0.36, l, 0.58);
      const l1 = ln * (1 - w) + lv * w;
      // Faint neutral overlays (hover tints, scrims) flip direction instead.
      const k = clamp(0, (0.45 - alpha) / 0.1, 1) * (1 - w);
      return { l: l1 * (1 - k) + (1 - l) * k, c: Math.min(c * 0.7, 0.08) * (1 - w) + c * w, h };
    }
    case 'fg': {
      const lo = Math.max(clamp(0.62, 1.16 - 0.9 * l, 0.93), 0.62 + 0.775 * (l - 0.6), 0.62 + 0.1 * w);
      return { l: lo, c, h };
    }
    case 'border': {
      const ln = surfaceL(l) + 0.06;
      // Saturated mid-tones (focus rings, accents) keep their lightness; pale tints step down.
      const lv = Math.min(clamp(0.42, l, 0.65), 0.65 - (l - 0.7) * 1.25);
      return { l: ln * (1 - w) + lv * w, c: Math.min(c * 0.8, 0.1) * (1 - w) + c * w, h };
    }
    case 'shadow': {
      const ln = Math.min(l, 1 - l) * 0.4;
      const lv = clamp(0.35, l, 0.6);
      return { l: ln * (1 - w) + lv * w, c, h };
    }
  }
}

const W = 'clamp(0,(c - .04)/.06,1)';
const SURFACE = '(.205 + .22*(1 - exp((l - 1)/.22)))';

const RELATIVE: Record<Role, { l: string; c: string }> = {
  bg: {
    l: `calc((min(${SURFACE},.16 + .484*l)*(1 - ${W}) + clamp(.36,l,.58)*${W})*(1 - clamp(0,(.45 - alpha)/.1,1)*(1 - ${W})) + (1 - l)*clamp(0,(.45 - alpha)/.1,1)*(1 - ${W}))`,
    c: `calc(min(c*.7,.08)*(1 - ${W}) + c*${W})`,
  },
  fg: {
    l: `calc(max(clamp(.62,1.16 - .9*l,.93),.62 + .775*(l - .6),.62 + .1*${W}))`,
    c: 'c',
  },
  border: {
    l: `calc((${SURFACE} + .06)*(1 - ${W}) + min(clamp(.42,l,.65),.65 - (l - .7)*1.25)*${W})`,
    c: `calc(min(c*.8,.1)*(1 - ${W}) + c*${W})`,
  },
  shadow: {
    l: `calc(min(l,1 - l)*.4*(1 - ${W}) + clamp(.35,l,.6)*${W})`,
    c: 'c',
  },
};

/** CSS that applies the role's curve at computed-value time to any color expression. */
export function relativeColor(role: Role, origin: string): string {
  const e = RELATIVE[role];
  return `oklch(from ${origin} ${e.l} ${e.c} h / alpha)`;
}

// ---------------------------------------------------------------------------
// Conversions

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function rgbToOklch({ r, g, b }: RGBA): LCH {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(A, B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

function oklchToLinear({ l, c, h }: LCH): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr), B = c * Math.sin(hr);
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = l - 0.0894841775 * A - 1.291485548 * B;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
}

const inGamut = (v: [number, number, number]) => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4);

/** OKLCH → sRGB, reducing chroma (keeping lightness and hue) until it fits. */
export function oklchToRgb(lch: LCH): [number, number, number] {
  const l = clamp(0, lch.l, 1);
  let lin = oklchToLinear({ l, c: lch.c, h: lch.h });
  if (!inGamut(lin)) {
    let lo = 0, hi = lch.c;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h: lch.h }))) lo = mid;
      else hi = mid;
    }
    lin = oklchToLinear({ l, c: lo, h: lch.h });
  }
  return lin.map((v) => clamp(0, toGamma(clamp(0, v, 1)), 1)) as [number, number, number];
}

export function luminance({ r, g, b }: RGBA): number {
  return rgbToOklch({ r, g, b, a: 1 }).l;
}

// ---------------------------------------------------------------------------
// Parsing

const NAMED_SRC =
  'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:0ff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000,blanchedalmond:ffebcd,blue:00f,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:0ff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:f0f,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:789,lightslategrey:789,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:0f0,limegreen:32cd32,linen:faf0e6,magenta:f0f,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:639,red:f00,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:fff,whitesmoke:f5f5f5,yellow:ff0,yellowgreen:9acd32';

export const NAMED_COLORS = new Map<string, string>(
  NAMED_SRC.split(',').map((p) => {
    const [k, v] = p.split(':');
    return [k, '#' + v];
  }),
);

export function isNamedColor(ident: string): boolean {
  return NAMED_COLORS.has(ident.toLowerCase());
}

function parseHex(hex: string): RGBA | null {
  let h = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

/** Split function args on commas / whitespace / slash. Returns [components, alpha]. */
function splitArgs(inner: string): [string[], string | null] {
  const [main, alpha] = inner.split('/');
  const parts = main.split(/[\s,]+/).filter(Boolean);
  if (alpha !== undefined) return [parts, alpha.trim()];
  if (inner.includes(',') && parts.length === 4) return [parts.slice(0, 3), parts[3]];
  return [parts, null];
}

function num(s: string, percentScale: number): number | null {
  if (s === 'none') return 0;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg|grad|rad|turn)?$/i.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch (m[2]?.toLowerCase()) {
    case '%':
      return (v / 100) * percentScale;
    case 'grad':
      return v * 0.9;
    case 'rad':
      return (v * 180) / Math.PI;
    case 'turn':
      return v * 360;
    default:
      return v;
  }
}

function parseAlpha(s: string | null): number | null {
  if (s === null) return 1;
  const v = num(s, 1);
  return v === null ? null : clamp(0, v, 1);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function parseFunction(name: string, inner: string): RGBA | null {
  const [p, alphaStr] = splitArgs(inner);
  const a = parseAlpha(alphaStr);
  if (a === null || p.length !== 3) return null;
  switch (name) {
    case 'rgb':
    case 'rgba': {
      const v = p.map((x) => num(x, 255));
      if (v.some((x) => x === null)) return null;
      return { r: clamp(0, v[0]! / 255, 1), g: clamp(0, v[1]! / 255, 1), b: clamp(0, v[2]! / 255, 1), a };
    }
    case 'hsl':
    case 'hsla': {
      const h = num(p[0], 1), s = num(p[1], 1), l = num(p[2], 1);
      if (h === null || s === null || l === null) return null;
      // Modern syntax allows bare numbers (0..100) for s and l.
      const sv = p[1].endsWith('%') ? s : s / 100;
      const lv = p[2].endsWith('%') ? l : l / 100;
      const [r, g, b] = hslToRgb(h, clamp(0, sv, 1), clamp(0, lv, 1));
      return { r, g, b, a };
    }
    case 'hwb': {
      const h = num(p[0], 1), w0 = num(p[1], 1), b0 = num(p[2], 1);
      if (h === null || w0 === null || b0 === null) return null;
      let w = p[1].endsWith('%') ? w0 : w0 / 100;
      let bl = p[2].endsWith('%') ? b0 : b0 / 100;
      if (w + bl >= 1) {
        const g = w / (w + bl);
        return { r: g, g, b: g, a };
      }
      const [r, g, b] = hslToRgb(h, 1, 0.5).map((x) => x * (1 - w - bl) + w);
      return { r, g, b, a };
    }
    case 'oklch': {
      const l = num(p[0], 1), c = num(p[1], 0.4), h = num(p[2], 1);
      if (l === null || c === null || h === null) return null;
      const [r, g, b] = oklchToRgb({ l, c, h });
      return { r, g, b, a };
    }
    case 'oklab': {
      const l = num(p[0], 1), A = num(p[1], 0.4), B = num(p[2], 0.4);
      if (l === null || A === null || B === null) return null;
      const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
      const [r, g, b] = oklchToRgb({ l, c: Math.hypot(A, B), h });
      return { r, g, b, a };
    }
  }
  return null;
}

const parseCache = new Map<string, RGBA | null>();
let probe: OffscreenCanvasRenderingContext2D | null | undefined;

/** Let the browser resolve syntaxes we don't parse ourselves (lab, color(), color-mix…). */
function parseViaCanvas(text: string): RGBA | null {
  if (probe === undefined) {
    try {
      probe = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    } catch {
      probe = null;
    }
  }
  if (!probe) return null;
  probe.fillStyle = '#010203';
  probe.fillStyle = text;
  if (probe.fillStyle === '#010203' && text.toLowerCase() !== '#010203') return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

export function parseColor(input: string): RGBA | null {
  const text = input.trim();
  const cached = parseCache.get(text);
  if (cached !== undefined) return cached;
  let out: RGBA | null = null;
  const lower = text.toLowerCase();
  if (lower.startsWith('#')) out = parseHex(lower);
  else if (NAMED_COLORS.has(lower)) out = parseHex(NAMED_COLORS.get(lower)!);
  else if (lower === 'transparent') out = { r: 0, g: 0, b: 0, a: 0 };
  else {
    const m = /^([a-z-]+)\((.*)\)$/s.exec(lower);
    if (m) {
      out = parseFunction(m[1], m[2]);
      if (!out && !lower.includes('var(')) out = parseViaCanvas(text);
    }
  }
  if (parseCache.size > 20000) parseCache.clear();
  parseCache.set(text, out);
  return out;
}

// ---------------------------------------------------------------------------
// Output

const hex2 = (v: number) => Math.round(clamp(0, v, 1) * 255).toString(16).padStart(2, '0');

export function formatRgba(r: number, g: number, b: number, a: number): string {
  return '#' + hex2(r) + hex2(g) + hex2(b) + (a < 0.999 ? hex2(a) : '');
}

const transformCache = new Map<string, string>();

/** Transform a literal color for a role. Returns null if the text isn't a parsable color. */
export function transformColor(role: Role, text: string): string | null {
  const key = role + '|' + text;
  const hit = transformCache.get(key);
  if (hit !== undefined) return hit;
  const rgba = parseColor(text);
  if (!rgba) return null;
  let out: string;
  if (rgba.a === 0) {
    out = text;
  } else {
    const lch = rgbToOklch(rgba);
    const t = transformOklch(role, lch.l, lch.c, lch.h, rgba.a);
    const [r, g, b] = oklchToRgb(t);
    out = formatRgba(r, g, b, rgba.a);
  }
  if (transformCache.size > 20000) transformCache.clear();
  transformCache.set(key, out);
  return out;
}
