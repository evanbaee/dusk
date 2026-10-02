export type SiteMode = 'auto' | 'convert' | 'off';
export type Verdict = 'native' | 'dark' | 'light';

export interface Settings {
  schedule: { enabled: boolean; start: string; end: string };
  /** On/off state used while the schedule is disabled. */
  power: boolean;
  /** Manual on/off while the schedule is enabled; expires at the next schedule boundary. */
  override: { on: boolean; until: number } | null;
  /** Per-hostname mode. Hosts without an entry are 'auto'. */
  sites: Record<string, Exclude<SiteMode, 'auto'>>;
}

export const DEFAULT_SETTINGS: Settings = {
  schedule: { enabled: true, start: '19:00', end: '07:00' },
  power: true,
  override: null,
  sites: {},
};

export const SETTINGS_KEY = 'settings';
export const VERDICTS_KEY = 'verdicts';

export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const sched = (s.schedule ?? {}) as Partial<Settings['schedule']>;
  return {
    schedule: {
      enabled: typeof sched.enabled === 'boolean' ? sched.enabled : DEFAULT_SETTINGS.schedule.enabled,
      start: isTime(sched.start) ? sched.start : DEFAULT_SETTINGS.schedule.start,
      end: isTime(sched.end) ? sched.end : DEFAULT_SETTINGS.schedule.end,
    },
    power: typeof s.power === 'boolean' ? s.power : DEFAULT_SETTINGS.power,
    override:
      s.override && typeof s.override.on === 'boolean' && typeof s.override.until === 'number'
        ? { on: s.override.on, until: s.override.until }
        : null,
    sites: s.sites && typeof s.sites === 'object' ? { ...s.sites } : {},
  };
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(got[SETTINGS_KEY]);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

function isTime(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Whether `now` falls inside the night window. start === end means all day. */
export function isNight(now: number, start: string, end: string): boolean {
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a === b) return true;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Timestamp of the next start or end boundary strictly after `now`. */
export function nextBoundary(now: number, start: string, end: string): number {
  if (toMinutes(start) === toMinutes(end)) return Infinity;
  let best = Infinity;
  for (const t of [start, end]) {
    const [h, m] = t.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    best = Math.min(best, d.getTime());
  }
  return best;
}

export function scheduledOn(s: Settings, now: number): boolean {
  return isNight(now, s.schedule.start, s.schedule.end);
}

export function isActive(s: Settings, now: number): boolean {
  if (!s.schedule.enabled) return s.power;
  if (s.override && now < s.override.until) return s.override.on;
  return scheduledOn(s, now);
}

/** When the active state may next change on its own (schedule boundary or override expiry). */
export function nextChange(s: Settings, now: number): number {
  if (!s.schedule.enabled) return Infinity;
  const b = nextBoundary(now, s.schedule.start, s.schedule.end);
  if (s.override && now < s.override.until) return Math.min(b, s.override.until);
  return b;
}

/** Apply a manual on/off from the UI. */
export function withManualToggle(s: Settings, on: boolean, now: number): Settings {
  if (!s.schedule.enabled) return { ...s, power: on, override: null };
  if (scheduledOn(s, now) === on) return { ...s, override: null };
  return { ...s, override: { on, until: nextBoundary(now, s.schedule.start, s.schedule.end) } };
}

export function siteKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname;
    if (u.protocol === 'file:') return 'file';
    return null;
  } catch {
    return null;
  }
}

export function siteMode(s: Settings, host: string | null): SiteMode {
  return (host && s.sites[host]) || 'auto';
}

/** Match pattern for a host, or null if the host can't be expressed as one. */
export function hostPattern(host: string): string | null {
  if (host === 'file') return null;
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;
  return `*://${host}/*`;
}
