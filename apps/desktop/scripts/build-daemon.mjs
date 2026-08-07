import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(desktopDir, 'out', 'main', 'daemon.cjs');

await build({
  entryPoints: [join(desktopDir, 'src', 'main', 'desktop-service.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  treeShaking: true,
  sourcemap: false,
  external: ['@homebridge/node-pty-prebuilt-multiarch'],
});

const source = await readFile(outfile, 'utf8');
if (/(?:from\s+|import\s*\()\s*["']electron["']/.test(source)) {
  throw new Error('daemon service bundle must not import Electron');
}
if (!source.includes('createDesktopService')) {
  throw new Error('daemon service bundle has no createDesktopService export');
}
console.log(`Built plain-Node desktop service: ${outfile}`);
