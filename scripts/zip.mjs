// Packages dist/ into release/dusk-<version>.zip for upload to the Chrome Web Store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
mkdirSync('release', { recursive: true });
const file = `release/dusk-${version}.zip`;
rmSync(file, { force: true });
execFileSync('zip', ['-r', '-X', '-q', `../${file}`, '.', '-x', '.DS_Store', '*/.DS_Store'], { cwd: 'dist', stdio: 'inherit' });
console.log(`packaged ${file}`);
