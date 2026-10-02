import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const out = 'dist';

const common = { bundle: true, target: 'chrome123', logLevel: 'info', legalComments: 'none', charset: 'utf8' };
const entries = [
  { entryPoints: ['src/background.ts'], outfile: `${out}/background.js`, format: 'esm' },
  { entryPoints: ['src/content/index.ts'], outfile: `${out}/content.js`, format: 'iife' },
  { entryPoints: ['src/main-world.ts'], outfile: `${out}/main-world.js`, format: 'iife' },
  { entryPoints: ['src/popup/popup.ts'], outfile: `${out}/popup.js`, format: 'esm' },
];

async function copyStatic() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
  manifest.version = pkg.version;
  await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
  await cp('src/popup/popup.html', `${out}/popup.html`);
  await cp('src/popup/popup.css', `${out}/popup.css`);
  await cp('src/preflight.css', `${out}/preflight.css`);
  await cp('src/_locales', `${out}/_locales`, { recursive: true });
  if (!existsSync('assets/icons/icon128.png')) throw new Error('Icons missing — run `npm run icons` first');
  await cp('assets/icons', `${out}/icons`, { recursive: true, filter: (p) => !p.endsWith('.svg') });
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await copyStatic();

if (watch) {
  for (const e of entries) await (await esbuild.context({ ...common, ...e })).watch();
  console.log('watching…');
} else {
  await Promise.all(entries.map((e) => esbuild.build({ ...common, ...e })));
}
