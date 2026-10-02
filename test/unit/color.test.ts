import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseColor, rgbToOklch, transformColor } from '../../src/content/color.ts';
import { schedule } from './helpers.ts';

const L = (c: string) => rgbToOklch(parseColor(c)!).l;

test('parses common syntaxes', () => {
  assert.deepEqual(parseColor('#fff'), { r: 1, g: 1, b: 1, a: 1 });
  assert.equal(parseColor('rgb(255 0 0 / 50%)')!.a, 0.5);
  assert.equal(parseColor('rgba(0, 0, 255, .25)')!.b, 1);
  assert.ok(Math.abs(parseColor('hsl(120 100% 25%)')!.g - 0.5) < 0.01);
  assert.equal(parseColor('white')!.r, 1);
  assert.ok(Math.abs(parseColor('oklch(1 0 0)')!.r - 1) < 1e-6);
  assert.equal(parseColor('nonsense'), null);
});

test('light surfaces become dark, steps stay visible', () => {
  const white = L(transformColor('bg', '#ffffff')!);
  const card = L(transformColor('bg', '#f6f8fa')!);
  assert.ok(white < 0.23 && white > 0.18, `white→${white}`);
  assert.ok(card > white + 0.01, 'subtle gray stays distinguishable from white');
});

test('dark surfaces on light pages stay dark', () => {
  assert.ok(L(transformColor('bg', '#000')!) < 0.2);
  assert.ok(L(transformColor('bg', '#24292f')!) < 0.32);
});

test('text: dark → light, light stays light', () => {
  assert.ok(L(transformColor('fg', '#1f2328')!) > 0.9);
  assert.ok(L(transformColor('fg', '#ffffff')!) > 0.9);
  const muted = L(transformColor('fg', '#656d76')!);
  assert.ok(muted > 0.6 && muted < 0.75, `muted→${muted}`);
});

test('brand colors keep their hue', () => {
  const src = rgbToOklch(parseColor('#0969da')!);
  const out = rgbToOklch(parseColor(transformColor('fg', '#0969da')!)!);
  assert.ok(Math.abs(src.h - out.h) < 4, `hue ${src.h} → ${out.h}`);
  assert.ok(out.l >= 0.71, 'links are readable on dark');
  const btn = rgbToOklch(parseColor(transformColor('bg', '#1f883d')!)!);
  assert.ok(btn.c > 0.1, 'button stays saturated');
});

test('translucent overlays flip direction', () => {
  const out = parseColor(transformColor('bg', 'rgba(0,0,0,0.05)')!)!;
  assert.ok(out.r > 0.9 && Math.abs(out.a - 0.05) < 0.01);
});

test('text always has strong contrast against surfaces', () => {
  for (const text of ['#000', '#333', '#57606a', '#999', '#0969da', '#cf222e']) {
    for (const bg of ['#fff', '#f6f8fa', '#eaeef2', '#ddf4ff']) {
      const d = L(transformColor('fg', text)!) - L(transformColor('bg', bg)!);
      assert.ok(d > 0.35, `${text} on ${bg}: ΔL ${d.toFixed(2)}`);
    }
  }
});

test('schedule math', () => schedule());

test('already-dark detection', async () => {
  const { looksDark } = await import('../../src/content/verdict.ts');
  const m = (darkRatio: number, lightRatio: number, lightText = 0.5) => ({ darkRatio, lightRatio, lightText, samples: 36 });
  assert.equal(looksDark(m(1, 0)), true, 'fully dark page');
  assert.equal(looksDark(m(0.85, 0.1)), true, 'dark page with a small light card');
  assert.equal(looksDark(m(0.5, 0.5, 0.6)), false, 'half dark hero, half white login panel');
  assert.equal(looksDark(m(0.6, 0.35)), false, 'dark header and hero over light content');
  assert.equal(looksDark(m(0, 1)), false, 'light page');
});
