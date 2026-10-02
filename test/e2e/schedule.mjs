// Checks schedule-driven on/off, per-site modes, script registration, and renders the popup.
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('test/e2e/fixtures');
const out = path.resolve('test/e2e/out');
await mkdir(out, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const body = await readFile(path.join(root, new URL(req.url, 'http://x').pathname));
    res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4701);
const remote = http.createServer(async (req, res) => {
  try {
    res.writeHead(200, { 'content-type': 'text/css' }).end(await readFile(path.join(root, new URL(req.url, 'http://x').pathname)));
  } catch {
    res.writeHead(404).end();
  }
}).listen(4702);

const dist = path.resolve('dist');
const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'dusk-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 1000));
const extId = new URL(sw.url()).host;

const hhmm = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const set = (settings) => sw.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
const base = { schedule: { enabled: true, start: hhmm(-60), end: hhmm(60) }, power: true, override: null, sites: {} };
const status = () =>
  sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://localhost:4701/*' });
    return (await chrome.tabs.sendMessage(tab.id, { type: 'status' })).state;
  });
const registered = () => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id).sort().join(','));

const checks = [];
const check = (name, actual, expected) => checks.push({ name, actual, expected, ok: actual === expected });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await set(base);
await wait(500);
const page = await context.newPage();
await page.goto('http://localhost:4701/light.html');
await wait(1500);
check('inside night window → converted', await status(), 'converted');
check('scripts registered while active', await registered(), 'dusk-main,dusk-preflight');

await set({ ...base, schedule: { enabled: true, start: hhmm(60), end: hhmm(120) } });
await wait(1200);
check('outside night window → inactive', await status(), 'inactive');
check('scripts unregistered while inactive', await registered(), '');
check('no Dusk styles left on page', await page.evaluate(() => document.querySelectorAll('style[data-dusk]').length), 0);

// Manual on during the day, until the next boundary.
await set({ ...base, schedule: { enabled: true, start: hhmm(60), end: hhmm(120) }, override: { on: true, until: Date.now() + 3600000 } });
await wait(1200);
check('manual override on → converted', await status(), 'converted');

await set({ ...base, sites: { localhost: 'off' } });
await wait(1200);
check('site set to keep original → off', await status(), 'off');

await set({ ...base, sites: { localhost: 'convert' } });
await wait(1500);
check('site set to always convert → converted', await status(), 'converted');

await page.goto('http://localhost:4701/dark.html');
await wait(1500);
check('always convert overrides dark detection', await status(), 'converted');

await set(base);
await page.reload();
await wait(1500);
check('auto mode leaves dark page alone', await status(), 'dark');

// Popup rendering (night window active, current tab = fixture).
await page.goto('http://localhost:4701/light.html');
await wait(1200);
const popup = await context.newPage();
await popup.setViewportSize({ width: 320, height: 520 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await wait(600);
await popup.screenshot({ path: `${out}/popup.png`, fullPage: true });
await popup.emulateMedia({ locale: 'ko-KR' });

console.table(checks);
await context.close();
server.close();
remote.close();
process.exit(checks.every((c) => c.ok) ? 0 : 1);
