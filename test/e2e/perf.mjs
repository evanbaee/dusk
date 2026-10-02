// How long until Dusk has decided on heavy real pages, and what it decided.
import { chromium } from 'playwright';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const urls = process.argv.slice(2);
const out = path.resolve('test/e2e/out');
await mkdir(out, { recursive: true });
const dist = path.resolve('dist');
const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'dusk-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 1000));
await sw.evaluate(() => chrome.storage.local.set({ settings: { schedule: { enabled: false, start: '19:00', end: '07:00' }, power: true, override: null, sites: {} } }));
await new Promise((r) => setTimeout(r, 500));

const rows = [];
for (const url of urls) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 80)));
  const t0 = Date.now();
  let dcl = 0;
  page.once('domcontentloaded', () => (dcl = Date.now() - t0));
  page.goto(url, { timeout: 45000 }).catch(() => {});
  let state = 'pending';
  let decided = 0;
  while (Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 50));
    state = await sw
      .evaluate(async (host) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => (t.url || t.pendingUrl || '').includes(host));
        try {
          return (await chrome.tabs.sendMessage(tab.id, { type: 'status' })).state;
        } catch {
          return 'pending';
        }
      }, new URL(url).hostname)
      .catch(() => 'pending');
    if (state !== 'pending') {
      decided = Date.now() - t0;
      break;
    }
  }
  await page.waitForTimeout(3000);
  const name = new URL(url).hostname.replace(/^www\./, '');
  await page.screenshot({ path: `${out}/perf-${name}.png` });
  const sheets = await page.evaluate(() => document.querySelectorAll('style[data-dusk]').length).catch(() => -1);
  rows.push({ name, state, dclMs: dcl, decidedMs: decided, duskSheets: sheets, errors: errors.join(' | ').slice(0, 100) });
  await page.close();
}
console.table(rows);
await context.close();
