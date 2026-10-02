// Loads dist/ into Chromium, visits fixture pages (and optional real sites) with Dusk on and off,
// and writes screenshots + detected states to test/e2e/out.
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('test/e2e/fixtures');
const out = path.resolve('test/e2e/out');
await mkdir(out, { recursive: true });

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css' };
const serve = (port) =>
  new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(port, () => resolve(server));
  });
const servers = [await serve(4701), await serve(4702)];

const args = process.argv.slice(2);
const real = args.filter((a) => a.startsWith('http'));
const only = args.filter((a) => !a.startsWith('http'));
const fixtures = ['light', 'native-css', 'native-js', 'dark', 'tailwind', 'csp', 'mm-light', 'native-demo', 'dark-demo'].filter((f) => !only.length || only.includes(f));
const targets = [...(real.length ? [] : fixtures.map((f) => ({ name: f, url: `http://localhost:4701/${f}.html` }))), ...real.map((u) => ({ name: new URL(u).hostname.replace(/^www\./, ''), url: u }))];

const dist = path.resolve('dist');
const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'dusk-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1180, height: 760 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent('serviceworker');

const setPower = (on) =>
  sw.evaluate(
    (on) => chrome.storage.local.set({ settings: { schedule: { enabled: false, start: '19:00', end: '07:00' }, power: on, override: null, sites: {} } }),
    on,
  );
const status = (url) =>
  sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === url || t.pendingUrl === url) ?? tabs.at(-1);
    try {
      return await chrome.tabs.sendMessage(tab.id, { type: 'status' });
    } catch (e) {
      return { error: String(e) };
    }
  }, url);

// Let onInstalled write its defaults first, then switch Dusk on.
await new Promise((r) => setTimeout(r, 1000));
await setPower(true);
await new Promise((r) => setTimeout(r, 500));

const results = [];
for (const t of targets) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && /dusk/i.test(m.text()) && errors.push(m.text()));
  const started = Date.now();
  await page.goto(t.url, { waitUntil: 'load', timeout: 45000 }).catch((e) => errors.push(String(e)));
  await page.waitForTimeout(real.length ? 4000 : 1500);
  const s = await status(page.url());
  await page.screenshot({ path: `${out}/${t.name}-on.png` });
  await setPower(false);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${t.name}-off.png` });
  const leftovers = await page.evaluate(() => ({
    styles: document.querySelectorAll('style[data-dusk]').length,
    attrs: document.querySelectorAll('[data-dusk-s],[data-dusk-a]').length,
  }));
  await setPower(true);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${t.name}-on-again.png` });
  results.push({ name: t.name, state: s?.state ?? s, ms: Date.now() - started, leftoversWhenOff: leftovers, errors });
  await page.close();
}

console.table(results.map((r) => ({ ...r, leftoversWhenOff: JSON.stringify(r.leftoversWhenOff), errors: r.errors.join(' | ').slice(0, 120) })));
await context.close();
servers.forEach((s) => s.close());
