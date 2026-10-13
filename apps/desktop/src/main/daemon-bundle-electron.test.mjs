import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same entry, options and Electron-refusing plugin as scripts/build-daemon.mjs;
// nothing is written (write: false), so out/ is never touched.
test('the daemon service bundle graph imports no Electron', async () => {
  const result = await build({
    entryPoints: [join(desktopDir, 'src', 'main', 'desktop-service.ts')],
    outfile: join(desktopDir, 'out', 'main', 'daemon-check.cjs'),
    write: false,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    treeShaking: true,
    sourcemap: false,
    logLevel: 'silent',
    external: ['@homebridge/node-pty-prebuilt-multiarch', 'koffi'],
    alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
    plugins: [
      {
        name: 'plain-node-desktop-service',
        setup(builder) {
          builder.onResolve({ filter: /^electron(?:\/|$)/ }, (args) => ({
            errors: [{ text: `daemon service bundle must not import Electron (from ${args.importer})` }],
          }));
        },
      },
    ],
  });
  assert.deepEqual(result.errors, []);
});
