// Renders the extension icons (and their "off" variants) from SVG with headless Chromium.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const icon = ({ off = false, store = false } = {}) => {
  // Store icon: 96px artwork inside 16px transparent padding (Chrome Web Store guideline).
  const [x, size, r] = store ? [16, 96, 22] : [4, 120, 28];
  const bg = off ? ['#2c2c33', '#1b1b20'] : ['#2e2758', '#14121f'];
  const moon = off ? ['#b4b4bf', '#7d7d88'] : ['#c2b8ff', '#f6b34a'];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient>
    <linearGradient id="moon" x1="0.15" y1="0.1" x2="0.85" y2="0.95"><stop offset="0" stop-color="${moon[0]}"/><stop offset="1" stop-color="${moon[1]}"/></linearGradient>
    <mask id="cut"><rect width="128" height="128" fill="#fff"/><circle cx="${64 + size * 0.17}" cy="${64 - size * 0.15}" r="${size * 0.255}" fill="#000"/></mask>
  </defs>
  <rect x="${x}" y="${x}" width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>
  <circle cx="64" cy="64" r="${size * 0.3}" fill="url(#moon)" mask="url(#cut)"/>
</svg>`;
};

await mkdir('assets/icons', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
async function render(svg, px, file) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${px}px;height:${px}px;display:block}</style>${svg}`);
  await page.screenshot({ path: file, omitBackground: true });
}
for (const px of [16, 32, 48]) {
  await render(icon(), px, `assets/icons/icon${px}.png`);
  await render(icon({ off: true }), px, `assets/icons/icon${px}-off.png`);
}
await render(icon({ store: true }), 128, 'assets/icons/icon128.png');
await writeFile('assets/icons/icon.svg', icon());
await browser.close();
console.log('icons written to assets/icons');
