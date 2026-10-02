import {
  SETTINGS_KEY,
  isActive,
  loadSettings,
  nextChange,
  normalizeSettings,
  siteKey,
  siteMode,
  type Settings,
  type SiteMode,
  type Verdict,
} from '../shared/settings';
import type { Message, PageState, StatusReply } from '../shared/messages';
import { measure } from './detect';
import { looksDark } from './verdict';
import { Scope } from './scope';
import { RemoteSheets, readRules } from './sheets';
import { VarRegistry } from './transform';

const html = document.documentElement;
const READY = 'data-dusk-ready'; // lifts the preflight (fallback) stylesheet
const MEASURE = 'data-dusk-measure'; // lifts it temporarily while measuring
const INSTANCE = 'data-dusk-instance';
const MM_USED = 'data-dusk-mm'; // set by the main-world script when the page asks for prefers-color-scheme

const isTop = window === window.top;
const instanceId = Math.random().toString(36).slice(2);
const alive = () => html.getAttribute(INSTANCE) === instanceId;

const vars = new VarRegistry();
const remote = new RemoteSheets();
const ctx = { vars, remote, alive };

let settings: Settings;
let scope: Scope | null = null;
let engaged: 'auto' | 'convert' | null = null;
let state: PageState = 'pending';
let lastDark: boolean | undefined;
let nativeTried = false;
let generation = 0;
let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
let recheckTimer: ReturnType<typeof setTimeout> | undefined;
let reportedVerdict: Verdict | null = null;
let lastError: string | null = null;
let supportInfo = '';

function noteError(e: unknown): void {
  lastError = e instanceof Error ? `${e.message} @ ${e.stack?.split('\n')[1]?.trim() ?? ''}` : String(e);
}

function topHost(): string | null {
  if (isTop) return siteKey(location.href);
  const origins = location.ancestorOrigins;
  return origins?.length ? siteKey(origins[origins.length - 1]) : null;
}

const ownHost = siteKey(location.href);

function currentMode(): SiteMode {
  const top = siteMode(settings, topHost());
  if (top === 'off') return 'off';
  if (!isTop) return siteMode(settings, ownHost);
  return top;
}

// ---------------------------------------------------------------------------
// Main world bridge

const toMain = (name: 'dusk:force' | 'dusk:release') => window.dispatchEvent(new CustomEvent(name));

function markReady(): void {
  if (!html.hasAttribute(READY)) html.setAttribute(READY, '');
}

// ---------------------------------------------------------------------------
// Decision

function measureDark(): boolean {
  html.setAttribute(MEASURE, '');
  try {
    const dark = looksDark(measure(), lastDark);
    lastDark = dark;
    return dark;
  } finally {
    html.removeAttribute(MEASURE);
  }
}

function measureOriginal(): boolean {
  scope?.suspend(true);
  try {
    return measureDark();
  } finally {
    scope?.suspend(false);
  }
}

function canvasIsBare(): boolean {
  if (!isTop) return false;
  const t = (el: Element | null) => !el || getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)';
  return t(html) && t(document.body);
}

interface NativeSupport {
  /** Any hint that the site has a dark theme of its own. */
  any: boolean;
  /** The page itself declares it can render with a dark color-scheme. */
  scheme: boolean;
}

function nativeSupport(): NativeSupport {
  const mm = html.hasAttribute(MM_USED);
  const meta = document.querySelector('meta[name="color-scheme" i]')?.getAttribute('content') ?? '';
  // Read the page's own color-scheme: neither the preflight nor Dusk's sheets may count.
  scope?.suspend(true);
  html.setAttribute(MEASURE, '');
  const rootScheme = getComputedStyle(html).colorScheme;
  html.removeAttribute(MEASURE);
  scope?.suspend(false);
  const scheme = /\bdark\b/i.test(meta) || /\bdark\b/.test(rootScheme);
  const css = !!scope?.hasNativeDark();
  supportInfo = `mm=${mm} meta=${meta} root=${rootScheme} css=${css}`;
  return { any: mm || scheme || css, scheme };
}

function setState(next: PageState): void {
  state = next;
  if (!isTop || !ownHost) return;
  const verdict: Verdict | null = next === 'native' ? 'native' : next === 'dark' ? 'dark' : next === 'converted' ? 'light' : null;
  if (verdict && verdict !== reportedVerdict && engaged === 'auto') {
    reportedVerdict = verdict;
    chrome.runtime.sendMessage({ type: 'verdict', host: ownHost, verdict } satisfies Message).catch(() => {});
  }
}

async function settle(): Promise<void> {
  prefetchRemote();
  await remote.settled(1500);
}

function convert(): void {
  toMain('dusk:release');
  scope!.setMode('convert', { paintCanvas: canvasIsBare() });
  setState('converted');
}

async function decide(kind: 'auto' | 'convert', gen: number): Promise<void> {
  scope ??= new Scope(document, ctx);
  await settle();
  if (gen !== generation) return;

  if (kind === 'convert') {
    convert();
    return;
  }

  // 1. The site's own dark theme, if it has one.
  const support = nativeSupport();
  if (support.any) {
    nativeTried = true;
    toMain('dusk:force');
    // Only flip the default canvas/UA colors when the page opts into dark color-schemes;
    // otherwise a light page with a transparent body would look "dark" to the measurement.
    scope.setMode('native', { forceScheme: support.scheme });
    await settle();
    if (gen !== generation) return;
    scope.sync();
    if (measureDark()) {
      setState('native');
      return;
    }
    scope.setMode('none');
  }

  // 2. Already dark? Leave it exactly as it is.
  if (measureDark()) {
    setState('dark');
    return;
  }

  // 3. Convert.
  convert();
}

/** Re-evaluate after the page changed (late CSS, SPA navigation, theme toggles). */
function recheck(): void {
  if (engaged !== 'auto' || !scope || !alive()) return;
  if (state === 'converted') {
    if (measureOriginal()) {
      scope.setMode('none');
      setState('dark');
    } else if (!nativeTried && nativeSupport().any) {
      nativeTried = true;
      scope.setMode('native', { forceScheme: nativeSupport().scheme });
      if (measureDark()) setState('native');
      else convert();
    }
  } else if (state === 'native') {
    if (!measureDark()) {
      scope.setMode('none');
      if (!measureDark()) convert();
      else setState('dark');
    }
  } else if (state === 'dark') {
    if (!measureDark()) {
      if (!nativeTried && nativeSupport().any) {
        nativeTried = true;
        scope.setMode('native', { forceScheme: nativeSupport().scheme });
        if (measureDark()) return setState('native');
        scope.setMode('none');
      }
      convert();
    }
  }
}

function scheduleRecheck(delay = 400): void {
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(recheck, delay);
}

// ---------------------------------------------------------------------------
// Engage / disengage

function domReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    document.addEventListener('DOMContentLoaded', finish, { once: true });
    // Don't keep the fallback up forever on pages that take ages to finish parsing.
    const poll = () => (document.body ? finish() : setTimeout(poll, 100));
    setTimeout(poll, 2500);
  });
}

function prefetchRemote(): void {
  const list = document.styleSheets;
  for (let i = 0; i < list.length; i++) {
    const sheet = list[i] as CSSStyleSheet;
    if (sheet.href && !readRules(sheet)) remote.get(sheet.href);
  }
}

let transitioning = false;

/** Cross-fade the whole page between light and dark when Dusk switches while you're looking. */
async function withTransition(live: boolean, fn: () => Promise<void> | void): Promise<void> {
  const smooth =
    live &&
    !transitioning &&
    document.visibilityState === 'visible' &&
    typeof document.startViewTransition === 'function' &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!smooth) return fn();
  transitioning = true;
  try {
    const t = document.startViewTransition(fn);
    t.ready.catch(() => {});
    await t.updateCallbackDone.catch(() => {});
    await t.finished.catch(() => {});
  } finally {
    transitioning = false;
  }
}

async function engage(kind: 'auto' | 'convert', live: boolean): Promise<void> {
  const gen = ++generation;
  engaged = kind;
  state = 'pending';
  lastDark = undefined;
  nativeTried = false;
  const loading = setInterval(prefetchRemote, 100);
  await domReady();
  clearInterval(loading);
  if (gen !== generation) return;
  try {
    await withTransition(live, async () => {
      // Reset any previous mode first so the decision sees the page as the site ships it.
      scope?.setMode('none');
      await decide(kind, gen);
    });
  } catch (e) {
    noteError(e);
  } finally {
    markReady();
  }
  if (gen !== generation) return;
  // Late-loading content often changes the picture; look again a few times.
  for (const delay of [1200, 3500]) setTimeout(() => gen === generation && recheck(), delay);
  if (document.readyState !== 'complete') {
    window.addEventListener('load', () => gen === generation && scheduleRecheck(300), { once: true });
  }
}

async function disengage(live: boolean, next: PageState): Promise<void> {
  ++generation;
  engaged = null;
  markReady();
  toMain('dusk:release');
  if (scope && scope.mode !== 'none') await withTransition(live, () => scope!.setMode('none'));
  state = next;
}

function apply(live: boolean): void {
  if (!alive()) return;
  const active = isActive(settings, Date.now());
  const mode = currentMode();

  if (!active || mode === 'off') {
    const next = !active ? 'inactive' : 'off';
    if (engaged || state === 'pending') disengage(live, next);
    else state = next;
  } else if (engaged !== mode) {
    engage(mode, live);
  }

  clearTimeout(boundaryTimer);
  const next = nextChange(settings, Date.now());
  if (Number.isFinite(next)) {
    boundaryTimer = setTimeout(() => apply(true), Math.min(next - Date.now() + 500, 2 ** 31 - 1));
  }
}

// ---------------------------------------------------------------------------
// Watchers

function watchPage(): void {
  // Theme toggles on <html>/<body> (class, data-theme, style…), and our own attribute being stripped.
  const attrObserver = new MutationObserver((records) => {
    if (!alive()) return attrObserver.disconnect();
    let relevant = false;
    for (const r of records) {
      const name = r.attributeName ?? '';
      if (name === READY && !html.hasAttribute(READY) && state !== 'pending') markReady();
      if (!name.startsWith('data-dusk')) relevant = true;
    }
    if (relevant) scheduleRecheck();
  });
  attrObserver.observe(html, { attributes: true });
  const watchBody = () => document.body && attrObserver.observe(document.body, { attributes: true });
  if (document.body) watchBody();
  else document.addEventListener('DOMContentLoaded', watchBody, { once: true });

  // CSSOM changes (insertRule, replaceSync, adoptedStyleSheets) reported by the main-world script.
  window.addEventListener('dusk:cssom', () => scope?.requestSync());
  let shadowTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('dusk:shadow', () => {
    clearTimeout(shadowTimer);
    shadowTimer = setTimeout(() => scope?.rescanShadows(), 50);
  });
  remote.onLoad = () => scope?.requestSync();

  // Fallback polling for CSSOM changes when the main-world script isn't present.
  const tick = setInterval(() => {
    if (!alive()) return clearInterval(tick);
    scope?.sync();
  }, 1000);

  // SPA navigations.
  let href = location.href;
  const onNav = () => {
    if (location.href === href) return;
    href = location.href;
    scheduleRecheck(600);
  };
  const nav = (window as Window & { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigatesuccess', onNav);
  window.addEventListener('popstate', onNav);
  setInterval(onNav, 1500);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !alive()) return;
    apply(false);
    scheduleRecheck(200);
  });
}

function cleanupPreviousInstance(): void {
  // After an extension update the old content script is orphaned; remove what it left behind.
  document.querySelectorAll('[data-dusk]').forEach((el) => el.remove());
  document.querySelectorAll('[data-dusk-s],[data-dusk-a],[data-dusk-img]').forEach((el) => {
    el.removeAttribute('data-dusk-s');
    el.removeAttribute('data-dusk-a');
    el.removeAttribute('data-dusk-img');
  });
  document.querySelectorAll('[data-dusk-media]').forEach((el) => {
    el.setAttribute('media', el.getAttribute('data-dusk-media')!);
    el.removeAttribute('data-dusk-media');
  });
}

// ---------------------------------------------------------------------------
// Boot

async function main(): Promise<void> {
  if (!(document instanceof HTMLDocument) && !document.contentType.includes('html')) return;
  if (html.hasAttribute(INSTANCE)) cleanupPreviousInstance();
  html.setAttribute(INSTANCE, instanceId);

  settings = await loadSettings();
  if (!alive()) return;

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY] || !alive()) return;
    settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    apply(true);
  });

  chrome.runtime.onMessage.addListener((msg: Message, _sender, reply) => {
    if (msg?.type === 'status' && isTop) {
      reply({
        state,
        mode: currentMode(),
        host: ownHost,
        debug: { scope: scope?.mode ?? 'none', error: lastError, support: supportInfo },
      } satisfies StatusReply);
    }
  });

  watchPage();
  apply(false);
}

main().catch(() => markReady());
