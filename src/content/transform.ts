import { isNamedColor, relativeColor, transformColor, type Role } from './color';

/** Longhand properties Dusk rewrites, and the role each plays. */
export const COLOR_PROPS: Record<string, Role> = {
  'background-color': 'bg',
  'background-image': 'bg',
  color: 'fg',
  '-webkit-text-fill-color': 'fg',
  'caret-color': 'fg',
  'text-decoration-color': 'fg',
  'text-emphasis-color': 'fg',
  '-webkit-text-stroke-color': 'fg',
  fill: 'fg',
  stroke: 'fg',
  'border-top-color': 'border',
  'border-right-color': 'border',
  'border-bottom-color': 'border',
  'border-left-color': 'border',
  'border-block-start-color': 'border',
  'border-block-end-color': 'border',
  'border-inline-start-color': 'border',
  'border-inline-end-color': 'border',
  'outline-color': 'border',
  'column-rule-color': 'border',
  'box-shadow': 'shadow',
  'text-shadow': 'shadow',
};

/** Properties whose whole value is a single color. */
const SINGLE = new Set(Object.keys(COLOR_PROPS).filter((p) => !['background-image', 'box-shadow', 'text-shadow'].includes(p)));

/** Where a longhand's value lives when it was set through a shorthand containing var(). */
const SHORTHANDS: Record<string, string[]> = {
  'background-color': ['background'],
  'border-top-color': ['border-top', 'border-color', 'border'],
  'border-right-color': ['border-right', 'border-color', 'border'],
  'border-bottom-color': ['border-bottom', 'border-color', 'border'],
  'border-left-color': ['border-left', 'border-color', 'border'],
  'border-block-start-color': ['border-block-start', 'border-block-color', 'border-block'],
  'border-block-end-color': ['border-block-end', 'border-block-color', 'border-block'],
  'border-inline-start-color': ['border-inline-start', 'border-inline-color', 'border-inline'],
  'border-inline-end-color': ['border-inline-end', 'border-inline-color', 'border-inline'],
  'outline-color': ['outline'],
  'text-decoration-color': ['text-decoration'],
  'column-rule-color': ['column-rule'],
  'text-emphasis-color': ['text-emphasis'],
  '-webkit-text-stroke-color': ['-webkit-text-stroke'],
};

const COLOR_FUNCS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark']);
const KEYWORDS = /^(inherit|initial|unset|revert|revert-layer|currentcolor|transparent|none|auto)$/i;

// ---------------------------------------------------------------------------
// Custom properties

export type VarKind = 'color' | 'triplet' | 'composite' | 'other';
const RANK: Record<VarKind, number> = { other: 0, triplet: 1, color: 2, composite: 3 };
const TRIPLET = /^\s*[\d.]+(?:deg)?[\s,]+[\d.]+%?[\s,]+[\d.]+%?\s*$/;

/**
 * What each custom property holds, learned from every definition seen so far.
 * Plain colors are converted where they're used (per role). Composite values
 * (shadows, gradient stops…) are converted where they're defined.
 */
export class VarRegistry {
  private kinds = new Map<string, VarKind>();
  private aliases = new Map<string, string>();
  version = 0;

  note(name: string, value: string): void {
    const v = value.trim();
    const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
    if (alias) {
      if (this.aliases.get(name) !== alias[1]) {
        this.aliases.set(name, alias[1]);
        this.version++;
      }
      return;
    }
    const kind = classify(v);
    const prev = this.kinds.get(name);
    if (!prev || RANK[kind] > RANK[prev]) {
      this.kinds.set(name, kind);
      if (prev !== kind) this.version++;
    }
  }

  kind(name: string): VarKind | undefined {
    for (let i = 0; i < 8; i++) {
      const k = this.kinds.get(name);
      const next = this.aliases.get(name);
      if (!next) return k;
      if (k && RANK[k] >= RANK.color) return k;
      name = next;
    }
    return undefined;
  }
}

function classify(v: string): VarKind {
  if (!v) return 'other';
  if (TRIPLET.test(v)) return 'triplet';
  const tokens = scan(v);
  let colors = 0;
  let others = 0;
  for (const t of tokens) {
    if (t.kind === 'color' || t.kind === 'colorfn') colors++;
    else if (t.kind === 'func' && t.inner && classify(t.inner) !== 'other') return 'composite'; // gradients etc.
    else if (t.kind !== 'space') others++;
  }
  if (colors === 0) return 'other';
  return colors === 1 && others === 0 ? 'color' : 'composite';
}

function roleFromName(name: string): Role {
  const n = name.toLowerCase();
  if (n.includes('shadow')) return 'shadow';
  if (/(^|[-_])(border|ring|outline|divider|stroke)/.test(n)) return 'border';
  if (/(^|[-_])(text|fg|foreground|font|ink|link|icon)([-_]|$)/.test(n)) return 'fg';
  return 'bg';
}

// ---------------------------------------------------------------------------
// Value scanning

interface Token {
  kind: 'space' | 'raw' | 'color' | 'colorfn' | 'var' | 'func' | 'url';
  text: string;
  name?: string; // function name
  inner?: string; // function arguments
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return s.length - 1;
      i = end;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return s.length - 1;
}

function scan(value: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    const ch = value[i];
    if (/\s|,|\//.test(ch)) {
      let j = i + 1;
      while (j < n && /\s|,|\//.test(value[j])) j++;
      out.push({ kind: 'space', text: value.slice(i, j) });
      i = j;
    } else if (ch === '"' || ch === "'") {
      const end = value.indexOf(ch, i + 1);
      const j = end < 0 ? n : end + 1;
      out.push({ kind: 'raw', text: value.slice(i, j) });
      i = j;
    } else if (ch === '#') {
      let j = i + 1;
      while (j < n && /[0-9a-f]/i.test(value[j])) j++;
      const text = value.slice(i, j);
      out.push({ kind: [4, 5, 7, 9].includes(text.length) ? 'color' : 'raw', text });
      i = j;
    } else if (/[a-z_-]/i.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w-]/.test(value[j])) j++;
      const ident = value.slice(i, j);
      if (value[j] === '(') {
        const close = matchParen(value, j);
        const text = value.slice(i, close + 1);
        const name = ident.toLowerCase();
        const inner = value.slice(j + 1, close);
        if (name === 'url') out.push({ kind: 'url', text, inner });
        else if (name === 'var') out.push({ kind: 'var', text, inner });
        else if (COLOR_FUNCS.has(name)) out.push({ kind: 'colorfn', text, name, inner });
        else out.push({ kind: 'func', text, name, inner });
        i = close + 1;
      } else {
        out.push({ kind: isNamedColor(ident) ? 'color' : 'raw', text: ident });
        i = j;
      }
    } else {
      let j = i + 1;
      while (j < n && !/[\s,/"'#a-z_(-]/i.test(value[j])) j++;
      out.push({ kind: 'raw', text: value.slice(i, j) });
      i = j;
    }
  }
  return out;
}

const varName = (inner: string) => /^\s*(--[\w-]+)/.exec(inner)?.[1] ?? '';

/**
 * Rewrite colors inside a multi-part value (shadows, gradients, shorthands, composite
 * custom properties). Bare var() references are only wrapped when we know they hold
 * a single color; anything else is left for its definition to be converted.
 */
function mapMulti(role: Role, value: string, vars: VarRegistry, base: string | null): string {
  let changed = false;
  const parts = scan(value).map((t) => {
    switch (t.kind) {
      case 'color': {
        const c = transformColor(role, t.text);
        if (c && c !== t.text) changed = true;
        return c ?? t.text;
      }
      case 'colorfn': {
        if (t.text.includes('var(')) {
          changed = true;
          return relativeColor(role, t.text);
        }
        const c = transformColor(role, t.text);
        if (c && c !== t.text) changed = true;
        return c ?? t.text;
      }
      case 'var': {
        if (vars.kind(varName(t.inner!)) === 'color') {
          changed = true;
          return relativeColor(role, t.text);
        }
        return t.text;
      }
      case 'func': {
        const inner = mapMulti(role, t.inner!, vars, base);
        if (inner !== t.inner) {
          changed = true;
          return `${t.text.slice(0, t.text.indexOf('('))}(${inner})`;
        }
        return t.text;
      }
      case 'url': {
        if (!base) return t.text;
        const raw = t.inner!.trim().replace(/^["']|["']$/g, '');
        if (/^(data:|[a-z][\w+.-]*:|#)/i.test(raw)) return t.text;
        try {
          changed = true;
          return `url("${new URL(raw, base).href.replace(/"/g, '%22')}")`;
        } catch {
          return t.text;
        }
      }
      default:
        return t.text;
    }
  });
  return changed ? parts.join('') : value;
}

/** Transform a single-color value. Returns the input unchanged when it isn't a color we touch. */
function mapSingle(role: Role, value: string): string {
  const v = value.trim();
  if (!v || KEYWORDS.test(v)) return value;
  if (v.includes('var(')) return relativeColor(role, v);
  return transformColor(role, v) ?? value;
}

/** Pick the color part out of a shorthand that contains var(). */
function colorFromShorthand(role: Role, shorthand: string, value: string, vars: VarRegistry): string | null {
  const tokens = scan(value).filter((t) => t.kind !== 'space');
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.kind === 'color' || (t.kind === 'colorfn' && !t.text.includes('var('))) return transformColor(role, t.text);
    if (t.kind === 'colorfn') return relativeColor(role, t.text);
  }
  const varTokens = tokens.filter((t) => t.kind === 'var');
  const colorVar = varTokens.find((t) => vars.kind(varName(t.inner!)) === 'color');
  if (colorVar) return relativeColor(role, colorVar.text);
  // `background: var(--x)` with an unknown var: if it turns out not to be a color the
  // declaration becomes invalid at computed time, which leaves background-color at its
  // initial transparent value — exactly what the original shorthand would have produced.
  if (shorthand === 'background' && varTokens.length === 1 && tokens.length === 1 && vars.kind(varName(varTokens[0].inner!)) === undefined) {
    return relativeColor(role, varTokens[0].text);
  }
  return null;
}

export interface DeclOptions {
  vars: VarRegistry;
  /** Base URL for resolving relative url() references. */
  base: string | null;
  /** Emit untouched color declarations too, so the override sheet mirrors the cascade. */
  keepUnchanged: boolean;
  /** Force !important on every emitted declaration (used for inline styles). */
  important?: boolean;
}

/** Record every custom property definition in a declaration block. */
export function noteVars(style: CSSStyleDeclaration, vars: VarRegistry): void {
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    if (prop.startsWith('--')) vars.note(prop, style.getPropertyValue(prop));
  }
}

/**
 * Build the override declarations for one declaration block.
 * Returns '' when nothing needs to be emitted.
 */
export function transformDeclarations(style: CSSStyleDeclaration, opts: DeclOptions): string {
  let out = '';
  let changedAny = false;
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    let value = style.getPropertyValue(prop);
    let next: string | null = null;

    if (prop.startsWith('--')) {
      if (opts.vars.kind(prop) !== 'composite') continue;
      next = mapMulti(roleFromName(prop), value, opts.vars, opts.base);
      if (next === value) continue;
    } else {
      const role = COLOR_PROPS[prop];
      if (!role) continue;
      if (!value) {
        // Set through a shorthand that contains var(); find the color in it.
        for (const sh of SHORTHANDS[prop] ?? []) {
          const shv = style.getPropertyValue(sh);
          if (shv) {
            next = colorFromShorthand(role, sh, shv, opts.vars);
            break;
          }
        }
        if (!next) continue;
        value = '';
      } else {
        next = SINGLE.has(prop) ? mapSingle(role, value) : mapMulti(role, value, opts.vars, opts.base);
      }
    }

    const changed = next !== value;
    if (!changed && !opts.keepUnchanged) continue;
    if (changed) changedAny = true;
    const important = opts.important || style.getPropertyPriority(prop) === 'important';
    out += `${prop}:${next}${important ? ' !important' : ''};`;
  }
  return changedAny || (opts.keepUnchanged && out) ? out : '';
}

/** Full copy of a declaration block with colors converted (for @keyframes, which can't be partially overridden). */
export function transformAllDeclarations(style: CSSStyleDeclaration, opts: DeclOptions): { text: string; changed: boolean } {
  let text = '';
  let changed = false;
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    const value = style.getPropertyValue(prop);
    const role = COLOR_PROPS[prop];
    let next = value;
    if (role && value) next = SINGLE.has(prop) ? mapSingle(role, value) : mapMulti(role, value, opts.vars, opts.base);
    if (next !== value) changed = true;
    if (next) text += `${prop}:${next};`;
  }
  return { text, changed };
}

/** Transform a presentational attribute color (bgcolor, <font color>, svg fill…). */
export function transformAttrColor(role: Role, value: string): string | null {
  const v = value.trim();
  if (!v || KEYWORDS.test(v) || v.startsWith('url(')) return null;
  // Legacy HTML accepts hex without '#'.
  const color = /^[0-9a-f]{6}$/i.test(v) ? '#' + v : v;
  const out = transformColor(role, color);
  return out && out !== color ? out : null;
}
