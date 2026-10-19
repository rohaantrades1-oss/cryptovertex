import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js');
const dstDir = join(root, 'public', 'vendor');
if (existsSync(src)) {
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(src, join(dstDir, 'lightweight-charts.js'));
  console.log('vendor: lightweight-charts copied');
} else {
  console.warn('vendor: lightweight-charts not installed; chart will be unavailable');
}
