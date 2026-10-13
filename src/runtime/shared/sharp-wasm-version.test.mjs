import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

// sharp exports no package.json subpath: walk up from its entry to its manifest.
function installedVersion(entry, name) {
  for (let dir = dirname(require.resolve(entry)); dir !== dirname(dir); dir = dirname(dir)) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (manifest.name === name) return manifest.version;
    } catch {
      // No manifest at this level; keep walking up.
    }
  }
  throw new Error(`${name} is not installed`);
}

// On Electron + Linux the daemon runs sharp's JavaScript against the wasm
// build's addon (sharp-electron-linux.mjs), so both must come from one release.
test('the sharp wasm build matches the installed sharp version', () => {
  assert.equal(require('@img/sharp-wasm32/package').version, installedVersion('sharp', 'sharp'));
});
