import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  stageNativePackages,
  verifyNativePackageDirectory,
} from './stage-native-packages.mjs';

test('native package staging includes and verifies all four required assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-native-package-'));
  try {
    const platformKey = 'linux-x64';
    const manifestPaths = {};
    for (const kind of ['graph', 'spawn', 'patch', 'token']) {
      const bytes = Buffer.from(`${kind}-fixture`);
      const source = join(root, `${kind}.bin`);
      const manifestPath = join(root, `${kind}.json`);
      writeFileSync(source, bytes);
      writeFileSync(manifestPath, JSON.stringify({
        version: '1.2.3',
        assets: {
          [platformKey]: {
            url: pathToFileURL(source).href,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        },
      }));
      manifestPaths[kind] = manifestPath;
    }
    const [directory] = await stageNativePackages({
      version: '9.8.7',
      outputDir: join(root, 'out'),
      cacheDir: join(root, 'cache'),
      platformKeys: [platformKey],
      manifestPaths,
    });
    const verified = await verifyNativePackageDirectory(directory, {
      expectedPlatformKey: platformKey,
    });
    assert.equal(verified.packageJson.name, 'mixdog-native-linux-x64');
    assert.deepEqual(Object.keys(verified.manifest.assets), ['graph', 'spawn', 'patch', 'token']);
    writeFileSync(join(directory, 'bin', 'mixdog-token.node'), 'tampered');
    await assert.rejects(
      verifyNativePackageDirectory(directory, { expectedPlatformKey: platformKey }),
      /token sha256 mismatch/,
    );
    assert.equal(JSON.parse(readFileSync(join(directory, 'package.json'))).version, '9.8.7');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
