import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  VERDICTS_KEY,
  hostPattern,
  isActive,
  loadSettings,
  nextChange,
  saveSettings,
  type Settings,
  type Verdict,
} from './shared/settings';
import type { FetchCssReply, Message } from './shared/messages';
import { pixelsLookDark, svgLooksDark } from './shared/image-analysis';

const ALARM = 'dusk-boundary';
const PREFLIGHT_ID = 'dusk-preflight';
const MAIN_ID = 'dusk-main';
const MAX_VERDICTS = 400;

type Verdicts = Record<string, { v: Verdict; t: number }>;

async function loadVerdicts(): Promise<Verdicts> {
  const got = await chrome.storage.local.get(VERDICTS_KEY);
  return (got[VERDICTS_KEY] as Verdicts) ?? {};
}

const patterns = (hosts: Iterable<string>) => [...hosts].map(hostPattern).filter((p): p is string => !!p);

/**
 * While Dusk is active, two scripts are registered for every page load:
 *  - preflight.css paints the page dark before its own CSS arrives (no white flash),
 *    skipped for sites already known to be dark;
 *  - main-world.js makes the page see prefers-color-scheme: dark from its first script.
 * Sites set to "keep original" are excluded from both.
 */
async function syncRegistrations(): Promise<void> {
  const settings = await loadSettings();
  const active = isActive(settings, Date.now());
  const existing = new Set((await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id));

  const ours = [PREFLIGHT_ID, MAIN_ID].filter((id) => existing.has(id));
  if (!active) {
    if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
    return;
  }

  const off = Object.entries(settings.sites).filter(([, m]) => m === 'off').map(([h]) => h);
  const verdicts = await loadVerdicts();
  const knownDark = Object.entries(verdicts)
    .filter(([h, e]) => e.v === 'dark' && settings.sites[h] !== 'convert')
    .map(([h]) => h);

  const scripts: chrome.scripting.RegisteredContentScript[] = [
    {
      id: PREFLIGHT_ID,
      css: ['preflight.css'],
      matches: ['<all_urls>'],
      excludeMatches: patterns([...off, ...knownDark]),
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: false,
    },
    {
      id: MAIN_ID,
      js: ['main-world.js'],
      matches: ['<all_urls>'],
      excludeMatches: patterns(off),
      runAt: 'document_start',
      allFrames: true,
      matchOriginAsFallback: true,
      world: 'MAIN',
      persistAcrossSessions: false,
    },
  ];

  // Re-register rather than update: an update can't clear excludeMatches back to none.
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });
  for (const s of scripts) {
    if (!s.excludeMatches?.length) delete s.excludeMatches;
    try {
      await chrome.scripting.registerContentScripts([s]);
    } catch (e) {
      console.warn('Dusk: registration failed', s.id, e);
    }
  }
}

async function scheduleAlarm(settings: Settings): Promise<void> {
  await chrome.alarms.clear(ALARM);
  const next = nextChange(settings, Date.now());
  if (Number.isFinite(next)) await chrome.alarms.create(ALARM, { when: next + 1000 });
}

async function updateIcon(settings: Settings): Promise<void> {
  const on = isActive(settings, Date.now());
  const suffix = on ? '' : '-off';
  await chrome.action.setIcon({
    path: {
      16: `icons/icon16${suffix}.png`,
      32: `icons/icon32${suffix}.png`,
      48: `icons/icon48${suffix}.png`,
    },
  });
}

let refreshing: Promise<void> | null = null;
let again = false;

/** Bring registrations, alarm, and icon in line with the current settings and time. */
function refresh(): Promise<void> {
  if (refreshing) {
    again = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      again = false;
      let settings = await loadSettings();
      if (settings.override && Date.now() >= settings.override.until) {
        settings = { ...settings, override: null };
        await saveSettings(settings);
      }
      await syncRegistrations();
      await scheduleAlarm(settings);
      await updateIcon(settings);
    } while (again);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Inject into tabs that were open before install so turning Dusk on works without a reload. */
async function injectExistingTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file:///*'] });
  for (const tab of tabs) {
    if (tab.id === undefined || tab.discarded) continue;
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  if (!got[SETTINGS_KEY]) await saveSettings(DEFAULT_SETTINGS);
  await refresh();
  if (details.reason === 'install' || details.reason === 'update') await injectExistingTabs();
});

chrome.runtime.onStartup.addListener(() => {
  refresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refresh();
});

let verdictTimer: ReturnType<typeof setTimeout> | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SETTINGS_KEY]) refresh();
  if (changes[VERDICTS_KEY]) {
    clearTimeout(verdictTimer);
    verdictTimer = setTimeout(() => syncRegistrations(), 2000);
  }
});

async function recordVerdict(host: string, verdict: Verdict): Promise<void> {
  const verdicts = await loadVerdicts();
  if (verdicts[host]?.v === verdict) {
    verdicts[host].t = Date.now();
    await chrome.storage.local.set({ [VERDICTS_KEY]: verdicts });
    return;
  }
  verdicts[host] = { v: verdict, t: Date.now() };
  const entries = Object.entries(verdicts);
  if (entries.length > MAX_VERDICTS) {
    entries.sort((a, b) => b[1].t - a[1].t);
    entries.length = MAX_VERDICTS;
  }
  await chrome.storage.local.set({ [VERDICTS_KEY]: Object.fromEntries(entries) });
}

const cssCache = new Map<string, Promise<FetchCssReply>>();

async function fetchCss(url: string): Promise<FetchCssReply> {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'unsupported' };
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') ?? '';
    if (type && !/css|text\/plain|octet-stream/i.test(type)) return { error: 'not css' };
    const text = await res.text();
    if (text.length > 8_000_000) return { error: 'too large' };
    return { text };
  } catch (e) {
    return { error: String(e) };
  }
}

// Images are analyzed here because the service worker can read cross-origin pixels.
type ImageReply = { dark?: boolean; svg?: string };
const imageCache = new Map<string, Promise<ImageReply>>();
let imageSlots = 6;
const imageQueue: (() => void)[] = [];

/** Rasters are measured here; SVG text goes back to the page, which can render it. */
async function analyzeImage(url: string): Promise<ImageReply> {
  if (imageSlots === 0) await new Promise<void>((r) => imageQueue.push(r));
  imageSlots--;
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) return {};
    const blob = await res.blob();
    if (blob.size > 2_000_000) return {};
    if (/svg/i.test(blob.type) || /\.svg(\?|#|$)/i.test(url)) {
      const text = await blob.text();
      return text.length < 400_000 ? { svg: text } : { dark: svgLooksDark(text) };
    }
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return { dark: pixelsLookDark(ctx.getImageData(0, 0, w, h).data) };
  } catch {
    return {};
  } finally {
    imageSlots++;
    imageQueue.shift()?.();
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, reply) => {
  if (msg?.type === 'analyze-image') {
    let p = imageCache.get(msg.url);
    if (!p) {
      p = analyzeImage(msg.url);
      imageCache.set(msg.url, p);
      if (imageCache.size > 2000) imageCache.delete(imageCache.keys().next().value!);
    }
    p.then(reply);
    return true;
  }
  if (msg?.type === 'fetch-css') {
    let p = cssCache.get(msg.url);
    if (!p) {
      p = fetchCss(msg.url);
      cssCache.set(msg.url, p);
      if (cssCache.size > 300) cssCache.delete(cssCache.keys().next().value!);
      p.then((r) => r.error && cssCache.delete(msg.url));
    }
    p.then(reply);
    return true;
  }
  if (msg?.type === 'verdict' && sender.tab && typeof msg.host === 'string') {
    recordVerdict(msg.host, msg.verdict);
  }
  return false;
});
