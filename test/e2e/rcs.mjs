// Verifies that the CSS relative-color curves (used for var() colors) match the JS curves
// (used for literal colors) in real Chromium, so both kinds of colors convert identically.
import { chromium } from 'playwright';
import * as esbuild from 'esbuild';

const { outputFiles } = await esbuild.build({
  entryPoints: ['src/content/color.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'DuskColor',
});
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<div id="t"></div>');
await page.addScriptTag({ content: outputFiles[0].text });
const report = await page.evaluate(() => {
  const { transformColor, relativeColor, parseColor, rgbToOklch } = DuskColor;
  const colors = ['#ffffff', '#f6f8fa', '#e5e7eb', '#9ca3af', '#4b5563', '#111827', '#000000', '#2563eb', '#16a34a', '#dc2626', '#fde68a', '#fef3c7', '#7c3aed', 'rgba(0,0,0,0.05)', 'rgba(255,255,255,0.8)', '#ddf4ff'];
  const el = document.getElementById('t');
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const toRgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  };
  let worst = 0;
  const rows = [];
  for (const role of ['bg', 'fg', 'border', 'shadow']) {
    for (const c of colors) {
      el.style.setProperty('--c', c);
      el.style.color = relativeColor(role, 'var(--c)');
      const viaCss = toRgba(getComputedStyle(el).color);
      const viaJs = toRgba(transformColor(role, c));
      // Out-of-gamut results are clipped by the browser but chroma-reduced in JS, so
      // compare perceptual lightness and hue rather than raw channels.
      const lch = (v) => rgbToOklch({ r: v[0] / 255, g: v[1] / 255, b: v[2] / 255, a: 1 });
      const a = lch(viaCss), b = lch(viaJs);
      const dh = a.c > 0.03 && b.c > 0.03 ? Math.abs(((a.h - b.h + 540) % 360) - 180) / 360 : 0;
      const diff = Math.max(Math.abs(a.l - b.l), dh, Math.abs(viaCss[3] - viaJs[3]) / 255);
      worst = Math.max(worst, diff);
      if (diff > 0.04) rows.push({ role, c, viaCss: viaCss.join(','), viaJs: viaJs.join(','), diff: diff.toFixed(3) });
    }
  }
  return { worst, rows };
});
console.log('max lightness/hue difference:', report.worst.toFixed(4));
if (report.rows.length) console.table(report.rows);
await browser.close();
// Colors outside sRGB differ by ~0.03 L because the browser clips them; a formula mismatch would be far larger.
process.exit(report.worst > 0.04 ? 1 : 0);
