// Records page brightness frame by frame to catch dark → white → dark flicker.
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('test/e2e/fixtures');
const server = http.createServer(async (req, res) => {
  try {
    const body = await readFile(path.join(root, new URL(req.url, 'http://x').pathname));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(4701);

const dist = path.resolve('dist');
const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'dusk-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1000, height: 640 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 1000));
const setPower = (on) =>
  sw.evaluate((on) => chrome.storage.local.set({ settings: { schedule: { enabled: false, start: '19:00', end: '07:00' }, power: on, override: null, sites: {} } }), on);

// A helper page decodes screenshots and returns mean luma (0..255) of the main area.
const meter = await context.newPage();
await meter.setContent('<canvas id=c></canvas>');
const luma = (png) =>
  meter.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.getElementById('c');
    c.width = 100;
    c.height = 64;
    const g = c.getContext('2d');
    g.drawImage(img, 300, 0, 700, 640, 0, 0, 100, 64); // right part of the page (skip sidebars)
    const d = g.getImageData(0, 0, 100, 64).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return Math.round(s / (d.length / 4));
  }, png.toString('base64'));

async function record(page, ms, action) {
  const frames = [];
  const t0 = Date.now();
  let acted = false;
  while (Date.now() - t0 < ms) {
    if (action && !acted && Date.now() - t0 > 300) {
      acted = true;
      await action();
    }
    frames.push(await luma(await page.screenshot()));
  }
  return frames;
}
const flicker = (frames) => {
  // A white frame (luma > 150) after we've already shown dark (< 80).
  const firstDark = frames.findIndex((v) => v < 80);
  return firstDark >= 0 && frames.slice(firstDark).some((v) => v > 150);
};

const results = [];

// A: fresh load of an SPA with a dark splash.
await setPower(true);
await new Promise((r) => setTimeout(r, 500));
{
  const page = await context.newPage();
  page.goto('http://localhost:4701/spa-splash.html');
  const frames = await record(page, 4500);
  results.push({ case: 'splash then light app', frames: frames.join(' '), flicker: flicker(frames), end: frames.at(-1) });
  await page.close();
}

// B: tab opened while Dusk was off, Dusk switched on, then a CSS-in-JS route change.
await setPower(false);
{
  const page = await context.newPage();
  await page.goto('http://localhost:4701/spa-cssinjs.html');
  await page.waitForTimeout(500);
  await setPower(true);
  await page.waitForTimeout(1500);
  const frames = await record(page, 1500, () => page.evaluate(() => window.navigateLight()));
  results.push({ case: 'live on + CSS-in-JS route', frames: frames.join(' '), flicker: flicker(frames), end: frames.at(-1) });
  await page.close();
}

console.table(results);
await context.close();
server.close();
process.exit(results.some((r) => r.flicker) ? 1 : 0);
