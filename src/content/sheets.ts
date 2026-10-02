import { noteVars, transformAllDeclarations, transformDeclarations, type VarRegistry } from './transform';
import type { FetchCssReply } from '../shared/messages';

const DARK_FEATURE = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi;
const LIGHT_FEATURE = /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi;

export const mentionsDark = (media: string) => /prefers-color-scheme\s*:\s*dark/i.test(media);

/** Rewrite a media query as if the user preferred a dark color scheme. */
export const forceDarkMedia = (media: string) =>
  media.replace(DARK_FEATURE, '(width >= 0px)').replace(LIGHT_FEATURE, '(width < 0px)');

export function readRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try {
    return sheet.cssRules;
  } catch {
    return null;
  }
}

export function absolutizeUrls(css: string, base: string | null): string {
  if (!base) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, _q, raw: string) => {
    if (/^(data:|[a-z][\w+.-]*:|#)/i.test(raw)) return m;
    try {
      return `url("${new URL(raw, base).href}")`;
    } catch {
      return m;
    }
  });
}

// ---------------------------------------------------------------------------
// Cross-origin stylesheets: fetched by the service worker, parsed locally.

interface Remote {
  sheet: CSSStyleSheet;
  imports: { href: string; media: string }[];
}

export class RemoteSheets {
  private entries = new Map<string, Remote | null | 'pending'>();
  private waiters = new Set<() => void>();
  onLoad: (() => void) | null = null;

  get(href: string): Remote | null | 'pending' {
    const e = this.entries.get(href);
    if (e !== undefined) return e;
    this.entries.set(href, 'pending');
    this.load(href);
    return 'pending';
  }

  /** Resolves once no fetch is in flight, or after `timeout` ms. */
  settled(timeout: number): Promise<void> {
    if (![...this.entries.values()].includes('pending')) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      setTimeout(done, timeout);
    });
  }

  private async load(href: string) {
    let result: Remote | null = null;
    try {
      const reply: FetchCssReply = await chrome.runtime.sendMessage({ type: 'fetch-css', url: href });
      if (reply?.text != null) {
        const imports: Remote['imports'] = [];
        const body = reply.text.replace(
          /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*([^;]*);/gi,
          (_m, url: string, media: string) => {
            try {
              imports.push({ href: new URL(url, href).href, media: media.trim() });
            } catch {
              /* ignore malformed import */
            }
            return '';
          },
        );
        const sheet = new CSSStyleSheet({ baseURL: href } as CSSStyleSheetInit);
        sheet.replaceSync(body);
        result = { sheet, imports };
      }
    } catch {
      result = null;
    }
    this.entries.set(href, result);
    this.onLoad?.();
    if (![...this.entries.values()].includes('pending')) for (const w of [...this.waiters]) w();
  }
}

// ---------------------------------------------------------------------------
// Rule walking

export interface GenContext {
  vars: VarRegistry;
  remote: RemoteSheets;
  /** False once a newer content-script instance took over this page. */
  alive: () => boolean;
}

type Rules = ArrayLike<CSSRule>;

const has = (name: string) => typeof (globalThis as Record<string, unknown>)[name] === 'function';
const HAS_LAYER = has('CSSLayerBlockRule');
const HAS_GROUPING = has('CSSGroupingRule');

function isStyleRule(r: CSSRule): r is CSSStyleRule {
  return r instanceof CSSStyleRule;
}

/** Declarations nested after child rules (CSSNestedDeclarations). */
function isNestedDecls(r: CSSRule): r is CSSRule & { style: CSSStyleDeclaration } {
  return 'style' in r && !('selectorText' in r) && !(r instanceof CSSKeyframeRule);
}

function prelude(r: CSSRule): string | null {
  if (r instanceof CSSMediaRule) return `@media ${r.media.mediaText}`;
  if (r instanceof CSSSupportsRule) return `@supports ${r.conditionText}`;
  if (HAS_LAYER && r instanceof CSSLayerBlockRule) return r.name ? `@layer ${r.name}` : '@layer';
  if (HAS_GROUPING && r instanceof CSSGroupingRule) {
    const t = r.cssText;
    const i = t.indexOf('{');
    return i > 0 ? t.slice(0, i).trim() : null;
  }
  return null;
}

interface ImportInfo {
  rules: Rules | null;
  base: string | null;
  media: string;
  layer: string | null;
  supports: string | null;
}

function importInfo(r: CSSImportRule, ctx: GenContext): ImportInfo | 'pending' {
  const sheet = r.styleSheet;
  let rules: Rules | null = sheet ? readRules(sheet) : null;
  const base = sheet?.href ?? r.href;
  if (!rules && sheet?.href) {
    const remote = ctx.remote.get(sheet.href);
    if (remote === 'pending') return 'pending';
    rules = remote?.sheet.cssRules ?? null;
  }
  return {
    rules,
    base,
    media: r.media?.mediaText ?? '',
    layer: (r as CSSImportRule & { layerName?: string | null }).layerName ?? null,
    supports: (r as CSSImportRule & { supportsText?: string | null }).supportsText ?? null,
  };
}

function wrapImport(info: ImportInfo, inner: string): string {
  if (!inner) return '';
  let out = inner;
  if (info.layer !== null) out = info.layer ? `@layer ${info.layer}{${out}}` : `@layer{${out}}`;
  if (info.supports) out = `@supports ${info.supports}{${out}}`;
  if (info.media && info.media !== 'all') out = `@media ${info.media}{${out}}`;
  return out;
}

export function collectVars(rules: Rules, ctx: GenContext, depth = 0): void {
  if (depth > 8) return;
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (isStyleRule(r)) {
      noteVars(r.style, ctx.vars);
      if (r.cssRules?.length) collectVars(r.cssRules, ctx, depth + 1);
    } else if (r instanceof CSSImportRule) {
      const info = importInfo(r, ctx);
      if (info !== 'pending' && info.rules) collectVars(info.rules, ctx, depth + 1);
    } else if (isNestedDecls(r)) {
      noteVars(r.style, ctx.vars);
    } else if ('cssRules' in r && !(r instanceof CSSKeyframesRule)) {
      collectVars((r as CSSGroupingRule).cssRules, ctx, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Convert mode: a projection of the sheet onto color properties, with converted values.

const ruleCache = new WeakMap<CSSRule, { v: number; t: string }>();

export function convertRules(rules: Rules, ctx: GenContext, base: string | null, depth = 0): string {
  if (depth > 8) return '';
  let out = '';
  for (let i = 0; i < rules.length; i++) out += convertRule(rules[i], ctx, base, depth);
  return out;
}

function convertRule(r: CSSRule, ctx: GenContext, base: string | null, depth: number): string {
  if (isStyleRule(r)) {
    const hit = ruleCache.get(r);
    if (hit && hit.v === ctx.vars.version) return hit.t;
    const decls = transformDeclarations(r.style, { vars: ctx.vars, base, keepUnchanged: true });
    const nested = r.cssRules?.length ? convertRules(r.cssRules, ctx, base, depth + 1) : '';
    const t = decls || nested ? `${r.selectorText}{${decls}${nested}}` : '';
    ruleCache.set(r, { v: ctx.vars.version, t });
    return t;
  }
  if (isNestedDecls(r)) {
    return transformDeclarations(r.style, { vars: ctx.vars, base, keepUnchanged: true });
  }
  if (r instanceof CSSImportRule) {
    const info = importInfo(r, ctx);
    if (info === 'pending' || !info.rules) return '';
    return wrapImport(info, convertRules(info.rules, ctx, info.base, depth + 1));
  }
  if (r instanceof CSSKeyframesRule) {
    let body = '';
    let changed = false;
    for (let i = 0; i < r.cssRules.length; i++) {
      const kf = r.cssRules[i] as CSSKeyframeRule;
      const res = transformAllDeclarations(kf.style, { vars: ctx.vars, base, keepUnchanged: false });
      if (res.changed) changed = true;
      body += `${kf.keyText}{${res.text}}`;
    }
    return changed ? `@keyframes ${CSS.escape(r.name)}{${body}}` : '';
  }
  if (r instanceof CSSNamespaceRule) return '';
  const p = prelude(r);
  if (p && 'cssRules' in r) {
    const inner = convertRules((r as CSSGroupingRule).cssRules, ctx, base, depth + 1);
    return inner ? `${p}{${inner}}` : '';
  }
  return '';
}

export function namespaces(rules: Rules): string {
  let out = '';
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r instanceof CSSNamespaceRule) out += r.cssText;
    else if (!(r instanceof CSSImportRule) && !(HAS_LAYER && r instanceof CSSLayerStatementRule)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Native mode: copy the site's own dark-scheme rules with the media condition forced on.

function allText(rules: Rules, base: string | null): string {
  let out = '';
  for (let i = 0; i < rules.length; i++) out += rules[i].cssText;
  return absolutizeUrls(out, base);
}

export function nativeRules(rules: Rules, ctx: GenContext, base: string | null, depth = 0): string {
  if (depth > 8) return '';
  let out = '';
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r instanceof CSSMediaRule) {
      const media = r.media.mediaText;
      if (mentionsDark(media)) out += `@media ${forceDarkMedia(media)}{${allText(r.cssRules, base)}}`;
      else {
        const inner = nativeRules(r.cssRules, ctx, base, depth + 1);
        if (inner) out += `@media ${media}{${inner}}`;
      }
    } else if (r instanceof CSSImportRule) {
      const info = importInfo(r, ctx);
      if (info === 'pending' || !info.rules) continue;
      if (mentionsDark(info.media)) {
        out += wrapImport({ ...info, media: forceDarkMedia(info.media) }, allText(info.rules, info.base));
      } else {
        out += wrapImport(info, nativeRules(info.rules, ctx, info.base, depth + 1));
      }
    } else if (isStyleRule(r)) {
      if (r.cssRules?.length) {
        const inner = nativeRules(r.cssRules, ctx, base, depth + 1);
        if (inner) out += `${r.selectorText}{${inner}}`;
      }
    } else if (!(r instanceof CSSKeyframesRule)) {
      const p = prelude(r);
      if (p && 'cssRules' in r) {
        const inner = nativeRules((r as CSSGroupingRule).cssRules, ctx, base, depth + 1);
        if (inner) out += `${p}{${inner}}`;
      }
    }
  }
  return out;
}

/** Native dark rules for a whole sheet, honoring a dark-only `media` on the sheet itself. */
export function nativeSheet(rules: Rules, sheetMedia: string, ctx: GenContext, base: string | null): string {
  if (mentionsDark(sheetMedia)) return `@media ${forceDarkMedia(sheetMedia)}{${allText(rules, base)}}`;
  return nativeRules(rules, ctx, base);
}
