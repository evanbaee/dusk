import {
  SETTINGS_KEY,
  isActive,
  loadSettings,
  nextBoundary,
  normalizeSettings,
  saveSettings,
  siteKey,
  toMinutes,
  withManualToggle,
  type Settings,
  type SiteMode,
} from '../shared/settings';
import type { StatusReply } from '../shared/messages';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const t = (key: string, subs?: string | string[]) => chrome.i18n.getMessage(key, subs) || key;

const els = {
  chip: $('chip'),
  power: $<HTMLInputElement>('power'),
  powerSub: $('powerSub'),
  resume: $<HTMLButtonElement>('resume'),
  scheduleOn: $<HTMLInputElement>('scheduleOn'),
  scheduleBody: $('scheduleBody'),
  start: $<HTMLInputElement>('start'),
  end: $<HTMLInputElement>('end'),
  track: $('track'),
  now: $('now'),
  siteCard: $('siteCard'),
  host: $('host'),
  modes: $('modes'),
  status: $('status'),
};

let settings: Settings;
let tab: chrome.tabs.Tab | undefined;
let host: string | null = null;

const timeFmt = new Intl.DateTimeFormat(chrome.i18n.getUILanguage(), { hour: 'numeric', minute: '2-digit' });
const fmt = (ts: number) => timeFmt.format(new Date(ts));

async function save(next: Settings): Promise<void> {
  settings = next;
  render();
  await saveSettings(next);
  setTimeout(refreshStatus, 350);
  setTimeout(refreshStatus, 1200);
}

// ---------------------------------------------------------------------------
// Render

function render(): void {
  const now = Date.now();
  const active = isActive(settings, now);
  const { schedule, override } = settings;

  els.chip.textContent = active ? t('chipOn') : t('chipOff');
  els.chip.classList.toggle('on', active);
  els.power.checked = active;

  const overriding = schedule.enabled && override && now < override.until;
  els.resume.hidden = !overriding;
  if (!schedule.enabled) {
    els.powerSub.textContent = active ? t('subAlwaysOn') : t('subManualOffNoSchedule');
  } else if (overriding) {
    els.powerSub.textContent = t(override!.on ? 'subManualOn' : 'subManualOff', fmt(override!.until));
  } else {
    const next = nextBoundary(now, schedule.start, schedule.end);
    if (!Number.isFinite(next)) els.powerSub.textContent = t('subAllDay');
    else els.powerSub.textContent = t(active ? 'subScheduledOn' : 'subScheduledOff', fmt(next));
  }

  els.scheduleOn.checked = schedule.enabled;
  els.scheduleBody.classList.toggle('disabled', !schedule.enabled);
  if (document.activeElement !== els.start) els.start.value = schedule.start;
  if (document.activeElement !== els.end) els.end.value = schedule.end;
  renderTimeline();

  const mode: SiteMode = (host && settings.sites[host]) || 'auto';
  for (const b of els.modes.querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  }
}

function renderTimeline(): void {
  els.track.querySelectorAll('.seg').forEach((s) => s.remove());
  const a = toMinutes(settings.schedule.start);
  const b = toMinutes(settings.schedule.end);
  const ranges: [number, number][] = a === b ? [[0, 1440]] : a < b ? [[a, b]] : [[a, 1440], [0, b]];
  for (const [from, to] of ranges) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.style.left = `${(from / 1440) * 100}%`;
    seg.style.width = `${((to - from) / 1440) * 100}%`;
    els.track.appendChild(seg);
  }
  const d = new Date();
  els.now.style.left = `${((d.getHours() * 60 + d.getMinutes()) / 1440) * 100}%`;
}

function setStatus(state: string, text: string): void {
  els.status.dataset.state = state;
  els.status.querySelector('span')!.textContent = text;
}

async function refreshStatus(): Promise<void> {
  els.host.textContent = host === 'file' ? t('localFile') : (host ?? '');
  const blocked = !host || /^(chromewebstore\.google\.com|chrome\.google\.com)$/.test(host);
  els.siteCard.classList.toggle('unavailable', blocked);
  if (blocked) {
    setStatus('none', t('statusUnavailable'));
    return;
  }
  try {
    const reply: StatusReply | undefined = await chrome.tabs.sendMessage(tab!.id!, { type: 'status' });
    if (!reply) throw new Error('no reply');
    const key = {
      inactive: 'statusInactive',
      off: 'statusOff',
      pending: 'statusPending',
      native: 'statusNative',
      dark: 'statusDark',
      converted: 'statusConverted',
    }[reply.state];
    setStatus(reply.state, t(key));
  } catch {
    if (host === 'file' && !(await chrome.extension.isAllowedFileSchemeAccess())) {
      setStatus('none', t('statusFileAccess'));
    } else {
      setStatus('none', t('statusReload'));
    }
  }
}

// ---------------------------------------------------------------------------
// Events

function bind(): void {
  els.power.addEventListener('change', () => save(withManualToggle(settings, els.power.checked, Date.now())));

  els.resume.addEventListener('click', () => save({ ...settings, override: null }));

  els.scheduleOn.addEventListener('change', () => {
    const on = els.scheduleOn.checked;
    const now = Date.now();
    save(
      on
        ? { ...settings, schedule: { ...settings.schedule, enabled: true }, override: null }
        : { ...settings, schedule: { ...settings.schedule, enabled: false }, power: isActive(settings, now), override: null },
    );
  });

  for (const [input, key] of [
    [els.start, 'start'],
    [els.end, 'end'],
  ] as const) {
    input.addEventListener('change', () => {
      if (!/^\d{2}:\d{2}$/.test(input.value)) return;
      save({ ...settings, schedule: { ...settings.schedule, [key]: input.value }, override: null });
    });
  }

  els.modes.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
    if (!b || !host) return;
    const sites = { ...settings.sites };
    const mode = b.dataset.mode as SiteMode;
    if (mode === 'auto') delete sites[host];
    else sites[host] = mode;
    save({ ...settings, sites });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      render();
    }
  });
}

async function init(): Promise<void> {
  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  settings = await loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  host = siteKey(tab?.url);
  render();
  bind();
  refreshStatus();
  setInterval(render, 30_000);
}

init();
