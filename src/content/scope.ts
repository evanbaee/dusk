import { transformColor } from './color';
import {
  collectVars,
  convertRules,
  forceDarkMedia,
  mentionsDark,
  namespaces,
  nativeSheet,
  readRules,
  type GenContext,
} from './sheets';
import { noteVars, transformAttrColor, transformDeclarations } from './transform';
import { pixelsLookDark, svgLooksDark } from '../shared/image-analysis';

export type ScopeMode = 'none' | 'native' | 'convert';

const OURS = 'data-dusk';
const SVG_NS = 'http://www.w3.org/2000/svg';
const INLINE_ATTR = 'data-dusk-s';
const PRES_ATTR = 'data-dusk-a';
const SOURCE_ATTR = 'data-dusk-media';
const IMG_ATTR = 'data-dusk-img';

const imageVerdicts = new Map<string, Promise<boolean>>();
function darkImage(url: string): Promise<boolean> {
  let p = imageVerdicts.get(url);
  if (!p) {
    p = chrome.runtime
      .sendMessage({ type: 'analyze-image', url })
      .then((r: { dark?: boolean; svg?: string } | undefined) => (r?.svg != null ? svgDark(r.svg) : !!r?.dark))
      .catch(() => false);
    imageVerdicts.set(url, p);
  }
  return p;
}

/** Render SVG text and measure its pixels; color counting alone misjudges small accents. */
async function svgDark(text: string): Promise<boolean> {
  try {
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    await img.decode();
    const w = 128;
    const h = Math.max(1, Math.round(img.naturalWidth && img.naturalHeight ? (w * img.naturalHeight) / img.naturalWidth : 64));
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    return pixelsLookDark(ctx.getImageData(0, 0, w, h).data);
  } catch {
    return svgLooksDark(text);
  }
}
const PRES_SELECTOR = '[style],[bgcolor],font[color],body[text],body[link],body[vlink],body[alink],[fill],[stroke]';
const OBSERVED_ATTRS = ['style', 'bgcolor', 'color', 'fill', 'stroke', 'text', 'link', 'vlink', 'alink', 'media', 'disabled', 'href', 'rel'];

/** Canvas color for pages that never paint a background of their own (white → this). */
export const BASE_BG = transformColor('bg', '#fff') ?? '#171717';

interface SheetRec {
  sheet: CSSStyleSheet;
  owner: Element | null;
  sig: string;
  el?: HTMLStyleElement | SVGStyleElement;
  adopted?: CSSStyleSheet;
}

function shadowOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  if (!el.localName.includes('-')) return null;
  try {
    return chrome.dom?.openOrClosedShadowRoot(el as HTMLElement) ?? null;
  } catch {
    return null;
  }
}

function isOurs(node: Node | null): boolean {
  return !!node && node.nodeType === 1 && (node as Element).hasAttribute(OURS);
}

export class Scope {
  mode: ScopeMode = 'none';
  private recs = new Map<CSSStyleSheet, SheetRec>();
  private ourAdopted = new WeakSet<CSSStyleSheet>();
  private children = new Map<ShadowRoot, Scope>();
  private observer: MutationObserver | null = null;
  private baseEl: HTMLStyleElement | null = null;
  private attrEl: HTMLStyleElement | null = null;
  private inlineEl: HTMLStyleElement | null = null;
  private inlineIds = new Map<string, string>();
  private presIds = new Map<string, string>();
  private inlineCache = new Map<string, string>();
  private importantInline = new WeakMap<Element, Map<string, { orig: string; ours: string }>>();
  private touched = new Set<Element>();
  private inlineDirty = false;
  private syncQueued = false;
  private paintCanvas = false;
  private forceScheme = false;
  private onLinkLoad = (e: Event) => {
    const t = e.target as Element | null;
    if (t && (t.localName === 'link' || t.localName === 'style')) this.requestSync();
    if (t && t.localName === 'img' && this.mode === 'convert') this.checkImage(t as HTMLImageElement);
  };

  constructor(
    readonly root: Document | ShadowRoot,
    private ctx: GenContext,
  ) {}

  private get doc(): Document {
    return this.root instanceof Document ? this.root : this.root.ownerDocument;
  }

  private get container(): ParentNode {
    if (this.root instanceof Document) return this.root.head ?? this.root.documentElement;
    return this.root;
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  setMode(mode: ScopeMode, opts: { paintCanvas?: boolean; forceScheme?: boolean } = {}): void {
    if (mode !== 'none' && !this.ctx.alive()) return this.abandon();
    const forceScheme = mode === 'convert' || !!opts.forceScheme;
    if (mode === this.mode && !!opts.paintCanvas === this.paintCanvas && forceScheme === this.forceScheme) return;
    this.teardown();
    this.mode = mode;
    this.paintCanvas = !!opts.paintCanvas;
    this.forceScheme = forceScheme;
    if (mode === 'none') return;

    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(this.root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
    this.root.addEventListener('load', this.onLinkLoad, true);

    this.writeBase();
    if (mode === 'native') this.rewriteSources(this.root);
    if (mode === 'convert') {
      this.processInline(this.root);
      this.root.querySelectorAll('img').forEach((img) => this.checkImage(img));
    }
    this.sync();
    this.discoverShadows(this.root);
  }

  /** Temporarily disable everything Dusk added (used while measuring the original page). */
  suspend(on: boolean): void {
    for (const rec of this.recs.values()) {
      if (rec.el?.sheet) rec.el.sheet.disabled = on;
      if (rec.adopted) rec.adopted.disabled = on;
    }
    for (const el of [this.baseEl, this.attrEl, this.inlineEl]) if (el?.sheet) el.sheet.disabled = on;
    for (const child of this.children.values()) child.suspend(on);
  }

  destroy(): void {
    this.teardown();
    this.mode = 'none';
  }

  /** Stop without touching the DOM (a newer instance owns it now). */
  private abandon(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.mode = 'none';
    for (const child of this.children.values()) child.abandon();
  }

  private teardown(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.root.removeEventListener('load', this.onLinkLoad, true);
    for (const child of this.children.values()) child.destroy();
    this.children.clear();
    for (const rec of this.recs.values()) this.dropRec(rec);
    this.recs.clear();
    for (const el of [this.baseEl, this.attrEl, this.inlineEl]) el?.remove();
    this.baseEl = this.attrEl = this.inlineEl = null;
    this.clearInline();
    this.restoreSources();
  }

  // -------------------------------------------------------------------------
  // Stylesheets

  requestSync(): void {
    if (this.syncQueued || this.mode === 'none') return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      this.sync();
    });
  }

  private listSheets(): { sheet: CSSStyleSheet; owner: Element | null }[] {
    const out: { sheet: CSSStyleSheet; owner: Element | null }[] = [];
    const list = this.root.styleSheets;
    for (let i = 0; i < list.length; i++) {
      const sheet = list[i] as CSSStyleSheet;
      const owner = sheet.ownerNode as Element | null;
      if (isOurs(owner)) continue;
      out.push({ sheet, owner });
    }
    for (const sheet of this.root.adoptedStyleSheets ?? []) {
      if (!this.ourAdopted.has(sheet)) out.push({ sheet, owner: null });
    }
    return out;
  }

  private rulesOf(sheet: CSSStyleSheet): { rules: CSSRuleList | null; base: string | null; state: string } {
    const rules = readRules(sheet);
    if (rules) return { rules, base: sheet.href ?? this.doc.baseURI, state: 'ok' };
    if (!sheet.href) return { rules: null, base: null, state: 'none' };
    const remote = this.ctx.remote.get(sheet.href);
    if (remote === 'pending') return { rules: null, base: null, state: 'pending' };
    if (!remote) return { rules: null, base: null, state: 'failed' };
    return { rules: remote.sheet.cssRules, base: sheet.href, state: 'remote' };
  }

  /** Bring every override sheet up to date with the page's sheets. Cheap when nothing changed. */
  sync(): void {
    if (this.mode === 'none') return;
    if (!this.ctx.alive()) return this.abandon();
    const items = this.listSheets();
    const infos = items.map((it) => ({ ...it, ...this.rulesOf(it.sheet) }));

    if (this.mode === 'convert') {
      for (const info of infos) {
        const rec = this.recs.get(info.sheet);
        const quick = `${info.state}|${info.rules?.length ?? 0}`;
        if (info.rules && (!rec || !rec.sig.startsWith(quick + '|'))) collectVars(info.rules, this.ctx);
      }
    }

    const seen = new Set<CSSStyleSheet>();
    for (const info of infos) {
      seen.add(info.sheet);
      const { sheet, owner, rules, base, state } = info;
      const media = sheet.media?.mediaText ?? '';
      const sig = `${state}|${rules?.length ?? 0}|${this.ctx.vars.version}|${sheet.disabled}|${media}`;
      let rec = this.recs.get(sheet);
      if (!rec) {
        rec = { sheet, owner, sig: '' };
        this.recs.set(sheet, rec);
      }
      if (rec.sig !== sig) {
        rec.sig = sig;
        let text = '';
        if (rules && !sheet.disabled) {
          text =
            this.mode === 'convert'
              ? namespaces(rules) + convertRules(rules, this.ctx, base)
              : nativeSheet(rules, media, this.ctx, base);
        }
        this.writeRec(rec, text, this.mode === 'convert' ? media : '');
      }
      this.placeRec(rec);
    }

    for (const [sheet, rec] of this.recs) {
      if (!seen.has(sheet)) {
        this.dropRec(rec);
        this.recs.delete(sheet);
      }
    }
    this.placeAdopted();
    this.ensureOwnSheets();
    for (const child of this.children.values()) child.sync();
  }

  private writeRec(rec: SheetRec, text: string, media: string): void {
    if (rec.owner) {
      if (!text) {
        rec.el?.remove();
        rec.el = undefined;
        return;
      }
      if (!rec.el) {
        rec.el =
          rec.owner.namespaceURI === SVG_NS
            ? (this.doc.createElementNS(SVG_NS, 'style') as SVGStyleElement)
            : this.doc.createElement('style');
        rec.el.setAttribute(OURS, 'sheet');
      }
      if (rec.el.textContent !== text) rec.el.textContent = text;
      if (media && media !== 'all') rec.el.setAttribute('media', media);
      else rec.el.removeAttribute('media');
    } else {
      if (!rec.adopted) {
        rec.adopted = new CSSStyleSheet();
        this.ourAdopted.add(rec.adopted);
      }
      try {
        rec.adopted.replaceSync(text);
      } catch {
        /* constructed sheets reject @import; nothing to do */
      }
      rec.adopted.media.mediaText = media && media !== 'all' ? media : '';
    }
  }

  /** Keep each override directly after its source so the cascade order is mirrored. */
  private placeRec(rec: SheetRec): void {
    if (!rec.owner || !rec.el || !rec.owner.isConnected) return;
    if (rec.el.previousElementSibling !== rec.owner) rec.owner.after(rec.el);
  }

  private placeAdopted(): void {
    const current = this.root.adoptedStyleSheets;
    if (!current) return;
    const desired: CSSStyleSheet[] = [];
    for (const sheet of current) {
      if (this.ourAdopted.has(sheet)) continue;
      desired.push(sheet);
      const rec = this.recs.get(sheet);
      if (rec?.adopted) desired.push(rec.adopted);
    }
    if (desired.length !== current.length || desired.some((s, i) => s !== current[i])) {
      this.root.adoptedStyleSheets = desired;
    }
  }

  private dropRec(rec: SheetRec): void {
    rec.el?.remove();
    if (rec.adopted && this.root.adoptedStyleSheets?.includes(rec.adopted)) {
      this.root.adoptedStyleSheets = this.root.adoptedStyleSheets.filter((s) => s !== rec.adopted);
    }
  }

  // -------------------------------------------------------------------------
  // Dusk's own sheets: base (color-scheme), presentational attrs, inline styles.

  private makeStyle(kind: string): HTMLStyleElement {
    const el = this.doc.createElement('style');
    el.setAttribute(OURS, kind);
    return el;
  }

  private writeBase(): void {
    if (!(this.root instanceof Document) || !this.forceScheme) return;
    this.baseEl ??= this.makeStyle('base');
    this.baseEl.textContent = ':root{color-scheme:dark !important}';
  }

  private ensureOwnSheets(): void {
    const c = this.container;
    if (this.baseEl && this.baseEl.parentNode !== c) c.appendChild(this.baseEl);
    if (this.mode !== 'convert') return;
    if (!this.inlineEl) this.inlineDirty = true;
    this.attrEl ??= this.makeStyle('attr');
    this.inlineEl ??= this.makeStyle('inline');
    if (this.attrEl.parentNode !== c) c.insertBefore(this.attrEl, c.firstChild);
    if (this.inlineEl.parentNode !== c || this.inlineEl.nextSibling) c.appendChild(this.inlineEl);
    if (this.inlineDirty) this.flushInline();
  }

  // -------------------------------------------------------------------------
  // Inline styles & presentational attributes (convert mode)

  private processInline(node: ParentNode | Element): void {
    if (node instanceof Element && node.matches(PRES_SELECTOR)) this.processElement(node);
    const all = node.querySelectorAll(PRES_SELECTOR);
    for (let i = 0; i < all.length; i++) this.processElement(all[i]);
  }

  private processElement(el: Element): void {
    if (isOurs(el)) return;
    const styled = el as HTMLElement;
    let inlineId: string | null = null;
    const css = el.getAttribute('style');
    if (css && styled.style) {
      let decls = this.inlineCache.get(css);
      if (decls === undefined) {
        noteVars(styled.style, this.ctx.vars);
        decls = transformDeclarations(styled.style, {
          vars: this.ctx.vars,
          base: this.doc.baseURI,
          keepUnchanged: false,
          important: true,
        });
        if (this.inlineCache.size > 5000) this.inlineCache.clear();
        this.inlineCache.set(css, decls);
      }
      if (decls) inlineId = this.idFor(this.inlineIds, decls, 's');
      this.convertImportantInline(styled);
    }

    const pres = this.presentational(el);
    const presId = pres ? this.idFor(this.presIds, pres, 'a') : null;

    if (inlineId) el.getAttribute(INLINE_ATTR) !== inlineId && el.setAttribute(INLINE_ATTR, inlineId);
    else if (el.hasAttribute(INLINE_ATTR)) el.removeAttribute(INLINE_ATTR);
    if (presId) el.getAttribute(PRES_ATTR) !== presId && el.setAttribute(PRES_ATTR, presId);
    else if (el.hasAttribute(PRES_ATTR)) el.removeAttribute(PRES_ATTR);
    if (inlineId || presId) this.touched.add(el);
  }

  /** Inline `!important` colors beat any stylesheet, so they're rewritten in place (and restored later). */
  private convertImportantInline(el: HTMLElement): void {
    const style = el.style;
    let map = this.importantInline.get(el);
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      if (style.getPropertyPriority(prop) !== 'important') continue;
      const value = style.getPropertyValue(prop);
      const prev = map?.get(prop);
      if (prev && prev.ours === value) continue;
      const single = new CSSStyleDeclaration_shim(prop, value);
      const out = transformDeclarations(single as unknown as CSSStyleDeclaration, {
        vars: this.ctx.vars,
        base: this.doc.baseURI,
        keepUnchanged: false,
      });
      const m = /^[^:]+:(.*?)(?: !important)?;$/.exec(out);
      if (!m) continue;
      map ??= new Map();
      this.importantInline.set(el, map);
      map.set(prop, { orig: value, ours: m[1] });
      style.setProperty(prop, m[1], 'important');
      this.touched.add(el);
    }
  }

  private presentational(el: Element): string {
    const parts: string[] = [];
    const add = (suffix: string, prop: string, role: 'bg' | 'fg', attr: string) => {
      const v = el.getAttribute(attr);
      if (!v) return;
      const out = transformAttrColor(role, v);
      if (out) parts.push(`${suffix}\u0000${prop}:${out}`);
    };
    const tag = el.localName;
    add('', 'background-color', 'bg', 'bgcolor');
    if (tag === 'font') add('', 'color', 'fg', 'color');
    if (tag === 'body') {
      add('', 'color', 'fg', 'text');
      add(' a:link', 'color', 'fg', 'link');
      add(' a:visited', 'color', 'fg', 'vlink');
      add(' a:active', 'color', 'fg', 'alink');
    }
    if (el.namespaceURI === SVG_NS) {
      add('', 'fill', 'fg', 'fill');
      add('', 'stroke', 'fg', 'stroke');
    }
    return parts.join('\u0001');
  }

  private idFor(map: Map<string, string>, key: string, prefix: string): string {
    let id = map.get(key);
    if (!id) {
      id = prefix + map.size.toString(36);
      map.set(key, id);
      this.inlineDirty = true;
      this.requestSync();
    }
    return id;
  }

  private flushInline(): void {
    this.inlineDirty = false;
    if (!this.inlineEl || !this.attrEl) return;
    let inline = `img[${IMG_ATTR}]{filter:invert(1) hue-rotate(180deg) !important}`;
    for (const [decls, id] of this.inlineIds) inline += `[${INLINE_ATTR}="${id}"]{${decls}}`;
    let attr = this.paintCanvas ? `:where(html){background-color:${BASE_BG}}` : '';
    for (const [key, id] of this.presIds) {
      for (const part of key.split('\u0001')) {
        const [suffix, decl] = part.split('\u0000');
        attr += `:where([${PRES_ATTR}="${id}"]${suffix}){${decl}}`;
      }
    }
    if (this.inlineEl.textContent !== inline) this.inlineEl.textContent = inline;
    if (this.attrEl.textContent !== attr) this.attrEl.textContent = attr;
  }

  private clearInline(): void {
    for (const el of this.touched) {
      el.removeAttribute(INLINE_ATTR);
      el.removeAttribute(PRES_ATTR);
      el.removeAttribute(IMG_ATTR);
      const map = this.importantInline.get(el);
      if (map) {
        for (const [prop, { orig, ours }] of map) {
          const style = (el as HTMLElement).style;
          if (style.getPropertyValue(prop) === ours) style.setProperty(prop, orig, 'important');
        }
        this.importantInline.delete(el);
      }
    }
    this.touched.clear();
    this.inlineIds.clear();
    this.presIds.clear();
    this.inlineCache.clear();
  }

  // -------------------------------------------------------------------------
  // Dark logos and icons on transparent backgrounds (convert mode)

  private checkImage(img: HTMLImageElement): void {
    if (!img.complete) return; // its load event will bring it back here
    const url = img.currentSrc || img.src;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const svg = /\.svg(\?|#|$)|^data:image\/svg/i.test(url);
    const small = (w <= 1200 && h <= 320) || w * h <= 160_000 || (w <= 320 && h <= 1200);
    if (!url || (!svg && (!w || !small))) {
      if (img.hasAttribute(IMG_ATTR)) img.removeAttribute(IMG_ATTR);
      return;
    }
    darkImage(url).then((dark) => {
      if (this.mode !== 'convert' || (img.currentSrc || img.src) !== url) return;
      if (dark) {
        if (!img.hasAttribute(IMG_ATTR)) img.setAttribute(IMG_ATTR, '');
        this.touched.add(img);
      } else if (img.hasAttribute(IMG_ATTR)) img.removeAttribute(IMG_ATTR);
    });
  }

  // -------------------------------------------------------------------------
  // <picture><source media="(prefers-color-scheme: dark)"> (native mode)

  private rewriteSources(node: ParentNode | Element): void {
    const list: Element[] = [];
    if (node instanceof Element && node.localName === 'source') list.push(node);
    list.push(...Array.from(node.querySelectorAll('source[media]')));
    for (const el of list) {
      const media = el.getAttribute('media');
      if (!media || !/prefers-color-scheme/i.test(media) || el.hasAttribute(SOURCE_ATTR)) continue;
      el.setAttribute(SOURCE_ATTR, media);
      el.setAttribute('media', forceDarkMedia(media));
      this.touched.add(el);
    }
  }

  private restoreSources(): void {
    const list = this.root.querySelectorAll(`[${SOURCE_ATTR}]`);
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      el.setAttribute('media', el.getAttribute(SOURCE_ATTR)!);
      el.removeAttribute(SOURCE_ATTR);
    }
  }

  /** Whether this scope (or a child) has dark-scheme rules or sources the site ships itself. */
  hasNativeDark(): boolean {
    for (const { sheet } of this.listSheets()) {
      const { rules, state } = this.rulesOf(sheet);
      if (mentionsDark(sheet.media?.mediaText ?? '')) return true;
      if (rules && state !== 'none' && nativeSheet(rules, '', this.ctx, null)) return true;
    }
    if (this.root.querySelector('source[media*="prefers-color-scheme"]')) return true;
    for (const child of this.children.values()) if (child.hasNativeDark()) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Shadow roots

  /** Look for shadow roots attached after their host was already in the DOM. */
  rescanShadows(): void {
    if (this.mode === 'none' || !this.ctx.alive()) return;
    this.discoverShadows(this.root);
    for (const child of this.children.values()) child.rescanShadows();
  }

  private discoverShadows(node: Node): void {
    if (this.mode === 'none') return;
    const walker = this.doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let el = (node.nodeType === 1 ? node : walker.nextNode()) as Element | null;
    while (el) {
      const sr = shadowOf(el);
      if (sr && !this.children.has(sr)) {
        const child = new Scope(sr, this.ctx);
        this.children.set(sr, child);
        child.setMode(this.mode);
      }
      el = walker.nextNode() as Element | null;
    }
  }

  // -------------------------------------------------------------------------
  // Mutations

  private onMutations(records: MutationRecord[]): void {
    if (!this.ctx.alive()) return this.abandon();
    let sheetsChanged = false;
    for (const r of records) {
      if (r.type === 'attributes') {
        const el = r.target as Element;
        if (isOurs(el)) continue;
        const name = r.attributeName!;
        if (el.localName === 'link' || el.localName === 'style') sheetsChanged = true;
        if (this.mode === 'convert' && name !== 'media') this.processElement(el);
        if (this.mode === 'native' && name === 'media' && el.localName === 'source') {
          if (el.getAttribute('media') !== forceDarkMedia(el.getAttribute(SOURCE_ATTR) ?? '')) {
            el.removeAttribute(SOURCE_ATTR);
            this.rewriteSources(el);
          }
        }
        continue;
      }
      for (const n of r.removedNodes) {
        if (n.nodeType !== 1) continue;
        const name = (n as Element).localName;
        if (isOurs(n) || name === 'style' || name === 'link') sheetsChanged = true;
      }
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || isOurs(n)) continue;
        const el = n as Element;
        if (el.localName === 'style' || el.localName === 'link' || el.querySelector('style,link')) sheetsChanged = true;
        if (this.mode === 'convert') {
          this.processInline(el);
          if (el.localName === 'img') this.checkImage(el as HTMLImageElement);
          el.querySelectorAll('img').forEach((img) => this.checkImage(img));
        }
        if (this.mode === 'native') this.rewriteSources(el);
        this.discoverShadows(el);
      }
      if (r.type === 'characterData' || (r.target as Element).localName === 'style') sheetsChanged = true;
    }
    if (sheetsChanged || this.inlineDirty) this.requestSync();
  }
}

/** Minimal stand-in so a single inline declaration can go through transformDeclarations. */
class CSSStyleDeclaration_shim {
  readonly length = 1;
  [index: number]: string;
  constructor(
    private prop: string,
    private value: string,
  ) {
    this[0] = prop;
  }
  getPropertyValue(p: string): string {
    return p === this.prop ? this.value : '';
  }
  getPropertyPriority(): string {
    return '';
  }
}
