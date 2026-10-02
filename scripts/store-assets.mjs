// Renders Chrome Web Store screenshots (1280×800) and the small promo tile (440×280)
// from the demo pages in test/e2e/fixtures, with the real extension doing the conversion.
import { chromium } from 'playwright';
import http from 'node:http';
import { copyFile, mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixtures = path.resolve('test/e2e/fixtures');
const outDir = path.resolve('assets/store');
await mkdir(outDir, { recursive: true });
const serve = (port) =>
  new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      try {
        const p = new URL(req.url, 'http://x').pathname;
        const body = await readFile(path.join(fixtures, p));
        res.writeHead(200, { 'content-type': p.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    s.listen(port, () => resolve(s));
  });
const servers = [await serve(4701), await serve(4702)];

const dist = path.resolve('dist');
const context = await chromium.launchPersistentContext(await mkdtemp(path.join(tmpdir(), 'dusk-store-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
let [sw] = context.serviceWorkers();
sw ??= await context.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 1000));
const extId = new URL(sw.url()).host;
const setPower = (on) =>
  sw.evaluate((on) => chrome.storage.local.set({ settings: { schedule: { enabled: true, start: '19:00', end: '07:00' }, power: true, override: { on, until: Date.now() + 36e5 }, sites: {} } }), on);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Page captures, light and with Dusk.
const shots = {};
for (const name of ['light', 'native-demo', 'dark-demo']) {
  const page = await context.newPage();
  await setPower(false);
  await page.goto(`http://localhost:4701/${name}.html`);
  await wait(800);
  shots[`${name}-off`] = (await page.screenshot()).toString('base64');
  await setPower(true);
  await wait(1500);
  shots[`${name}-on`] = (await page.screenshot()).toString('base64');
  await page.close();
}

// 2. The popup, as it looks over a converted page at night.
const demoTab = await context.newPage();
await demoTab.goto('http://localhost:4701/light.html');
await wait(1500);
// Let the override expire for the popup's clock so it shows the plain schedule state.
const { until } = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings.override);
const night = new Date();
night.setHours(22, 40, 0, 0);
const popup = await context.newPage();
await popup.clock.setFixedTime(new Date(Math.max(night.getTime(), until + 10 * 60000)));
await popup.addInitScript(() => {
  const realQuery = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = async (q) => (q?.active ? (await realQuery({ url: 'http://localhost:4701/*' })).slice(0, 1) : realQuery(q));
});
await popup.setViewportSize({ width: 320, height: 440 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await wait(800);
const popupShot = (await popup.screenshot({ fullPage: true })).toString('base64');

// 3. Compose the store images.
const img = (b64) => `data:image/png;base64,${b64}`;
const font = `-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Segoe UI', sans-serif`;
const frame = (title, sub, body) => `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:${font};color:#ececf1;
    background:radial-gradient(1200px 600px at 85% -10%, #3a2f6e 0%, transparent 60%), radial-gradient(900px 500px at -10% 110%, #4a3418 0%, transparent 55%), #0e0e12}
  .head{padding:52px 64px 0}
  h1{margin:0;font-size:44px;font-weight:750;letter-spacing:-0.02em}
  p{margin:12px 0 0;font-size:21px;color:#a3a3b2}
  .stage{position:absolute;left:64px;right:64px;bottom:0;top:236px}
  .split{position:relative;height:100%;border-radius:16px 16px 0 0;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
  .split .clip{position:absolute;inset:0;overflow:hidden;border-radius:16px 16px 0 0}
  .split img{position:absolute;inset:0;width:100%;height:auto;display:block}
  .split .after{clip-path:polygon(50% 0,100% 0,100% 100%,50% 100%)}
  .split .line{position:absolute;top:0;bottom:0;left:50%;width:3px;margin-left:-1.5px;background:linear-gradient(#c2b8ff,#f6b34a)}
  .tag{position:absolute;top:-38px;padding:5px 12px;border-radius:999px;font-size:15px;font-weight:650}
  .tag.l{left:0;background:#f2f2f5;color:#222} .tag.r{right:0;background:#2a2442;color:#e8e3ff}
  .single{height:100%;border-radius:16px 16px 0 0;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}
  .single img{width:100%;display:block}
</style><div class="head"><h1>${title}</h1><p>${sub}</p></div><div class="stage">${body}</div>`;
const split = (off, on, l, r) =>
  `<div class="split"><div class="clip"><img src="${img(off)}"><img class="after" src="${img(on)}"><div class="line"></div></div><span class="tag l">${l}</span><span class="tag r">${r}</span></div>`;

const copy = {
  ko: {
    before: '원본',
    after: 'Dusk',
    same: '그대로',
    s1: ['밤이 되면, 모든 탭이 자연스럽게 어두워져요', '색을 뒤집지 않고 하나하나 다시 계산해요. 버튼과 브랜드 색, 사진은 그대로 살아 있어요.'],
    s2: ['사이트에 다크 모드가 있으면 그걸 먼저 켜요', '디자이너가 만든 진짜 다크 테마가 가장 자연스러우니까요.'],
    s3: ['이미 어두운 사이트는 손대지 않아요', '어두운 사이트를 한 번 더 뒤집어 망가뜨리는 일은 없어요.'],
    s4: ['켜는 시간은 내가 정하고, 끄는 건 클릭 한 번', '자동 스케줄, 지금 바로 켜고 끄기, 사이트별 설정까지.'],
  },
  en: {
    before: 'Original',
    after: 'Dusk',
    same: 'unchanged',
    s1: ['At night, every tab turns dark — naturally', 'Colors are recomputed one by one, not inverted. Buttons, brand colors and photos keep their character.'],
    s2: ["Uses the site's own dark theme first", 'A dark theme its designers made will always look best.'],
    s3: ['Already-dark sites are left alone', 'No more dark pages flipped back to bright.'],
    s4: ['Your schedule, one click to override', 'Automatic schedule, instant on/off, and per-site control.'],
  },
};

const render = async (html, file, w = 1280, h = 800) => {
  const p = await context.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(html);
  await p.waitForTimeout(150);
  await p.screenshot({ path: path.join(outDir, file) });
  await p.close();
};

for (const [lang, c] of Object.entries(copy)) {
  await render(frame(c.s1[0], c.s1[1], split(shots['light-off'], shots['light-on'], c.before, c.after)), `${lang}-1-convert.png`);
  await render(frame(c.s2[0], c.s2[1], split(shots['native-demo-off'], shots['native-demo-on'], c.before, c.after)), `${lang}-2-native.png`);
  await render(frame(c.s3[0], c.s3[1], `<div class="split"><div class="clip"><img src="${img(shots['dark-demo-off'])}"><img class="after" src="${img(shots['dark-demo-on'])}"><div class="line"></div></div><span class="tag l">${c.before}</span><span class="tag r">${c.after} · ${c.same}</span></div>`), `${lang}-3-dark.png`);
  await render(
    frame(
      c.s4[0],
      c.s4[1],
      `<div style="position:relative;height:100%"><div class="single" style="filter:brightness(.55)"><img src="${img(shots['light-on'])}"></div>
       <img src="${img(popupShot)}" style="position:absolute;right:56px;top:20px;width:352px;border-radius:18px;box-shadow:0 30px 90px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.1)"></div>`,
    ),
    `${lang}-4-popup.png`,
  );
}

// The small promo tile is shared by every store language, so it carries no copy beyond the name.
const icon = (await readFile('assets/icons/icon.svg', 'utf8')).replace('<svg ', '<svg style="width:84px;height:84px" ');
await render(
  `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;width:440px;height:280px;position:relative;overflow:hidden;font-family:${font};color:#fff;
      background:radial-gradient(420px 260px at 95% 0%, #4a3a8f, transparent 70%), radial-gradient(360px 220px at 0% 100%, #6b4614, transparent 70%), #121019}
    .brand{position:absolute;left:30px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:12px}
    .name{font-size:38px;font-weight:800;letter-spacing:-0.02em}
    .win{position:absolute;right:-18px;top:44px;width:236px;height:180px;border-radius:12px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.12);transform:rotate(-4deg)}
    .bar{height:22px;background:#e9e9ee;display:flex;gap:5px;align-items:center;padding-left:9px}
    .bar i{width:7px;height:7px;border-radius:50%;background:#c4c4cc}
    .page{position:relative;height:158px}
    .half{position:absolute;inset:0;padding:14px}
    .light{background:#fff}
    .dark{background:#16161b;clip-path:polygon(58% 0,100% 0,100% 100%,38% 100%)}
    .l{height:9px;border-radius:5px;margin-bottom:9px}
    .light .l{background:#d9dbe3} .light .h{background:#2b2f3a;width:60%;height:12px}
    .dark .l{background:#3a3a46} .dark .h{background:#ececf1;width:60%;height:12px}
    .light .btn{background:#6d5fd8} .dark .btn{background:#8b7cf6}
    .btn{width:58px;height:18px;border-radius:6px;margin-top:14px}
    .edge{position:absolute;top:0;bottom:0;left:0;right:0;background:linear-gradient(#c2b8ff,#f6b34a);clip-path:polygon(57.6% 0,58.4% 0,38.4% 100%,37.6% 100%)}
  </style>
  <div class="win"><div class="bar"><i></i><i></i><i></i></div><div class="page">
    <div class="half light"><div class="l h"></div><div class="l" style="width:88%"></div><div class="l" style="width:76%"></div><div class="l" style="width:82%"></div><div class="btn"></div></div>
    <div class="half dark"><div class="l h"></div><div class="l" style="width:88%"></div><div class="l" style="width:76%"></div><div class="l" style="width:82%"></div><div class="btn"></div></div>
    <div class="edge"></div></div></div>
  <div class="brand">${icon}<div class="name">Dusk</div></div>`,
  'promo-440x280.png',
  440,
  280,
);

// The store listing needs the 128px icon uploaded separately; keep it next to the other store images.
await copyFile('assets/icons/icon128.png', path.join(outDir, 'store-icon-128.png'));

await context.close();
servers.forEach((s) => s.close());
console.log('store assets written to assets/store');
