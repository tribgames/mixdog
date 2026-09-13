import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
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
  plugins: [{
    name: 'plain-node-desktop-service',
    setup(builder) {
      builder.onResolve({ filter: /^electron(?:\/|$)/ }, () => ({
        errors: [{ text: 'daemon service bundle must not import Electron' }],
      }));
    },
  }],
});

// A CJS bundle has no ES export table. Load its real entry under plain Node
// instead of inferring runtime compatibility from generated source text.
const service = createRequire(import.meta.url)(outfile);
if (typeof service.createDesktopService !== 'function') {
  throw new Error('daemon service bundle has no createDesktopService export');
}
console.log(`Built plain-Node desktop service: ${outfile}`);
