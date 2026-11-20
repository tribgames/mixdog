import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { readRuntimePackages, verifyRuntimeVersions } from './verify-runtime-versions.mjs';

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

function fixture(shipped) {
  const dir = makeTempDirSync('runtime-versions');
  const modules = join(dir, 'native-modules');
  for (const [path, version] of Object.entries(shipped))
    put(join(modules, path, 'package.json'), JSON.stringify({ name: path, version }));
  // Not a lock entry: the package files of mixdog itself carry their own manifests.
  put(join(modules, 'mixdog/src/nested/package.json'), '{"type":"module"}');
  const lockfile = join(dir, 'package-lock.json');
  put(
    lockfile,
    JSON.stringify({
      name: 'mixdog',
      version: '1.3.2',
      packages: {
        '': { name: 'mixdog', version: '1.3.2' },
        'node_modules/yaml': { version: '2.0.0' },
        'node_modules/a/node_modules/b': { version: '3.0.0' },
      },
    })
  );
  return { modules, lockfile };
}

test('every shipped package.json that is a lock entry is read, with its lock key', async () => {
  const { modules } = fixture({ mixdog: '1.3.2', yaml: '2.0.0', 'a/node_modules/b': '3.0.0' });
  const shipped = await readRuntimePackages(modules);
  assert.deepEqual(shipped.map(({ key }) => key).sort(), [
    'node_modules/a/node_modules/b',
    'node_modules/mixdog',
    'node_modules/yaml',
  ]);
});

test('a runtime that matches the lockfile passes; a stale version is named', async () => {
  const good = fixture({ mixdog: '1.3.2', yaml: '2.0.0', 'a/node_modules/b': '3.0.0' });
  assert.deepEqual(await verifyRuntimeVersions({ lockfile: good.lockfile, modulesDir: good.modules }), []);
  const stale = fixture({ mixdog: '1.3.2', yaml: '1.9.0', 'a/node_modules/b': '3.0.0' });
  assert.deepEqual(await verifyRuntimeVersions({ lockfile: stale.lockfile, modulesDir: stale.modules }), [
    'node_modules/yaml: shipped 1.9.0, lockfile 2.0.0 (native-modules)',
  ]);
  const extra = fixture({ mixdog: '1.3.2', yaml: '2.0.0', left: '1.0.0' });
  const [mismatch] = await verifyRuntimeVersions({ lockfile: extra.lockfile, modulesDir: extra.modules });
  assert.match(mismatch, /node_modules\/left: shipped 1\.0\.0 but absent from the lockfile/);
});

test('an empty runtime never passes', async () => {
  const dir = makeTempDirSync('runtime-versions-empty');
  mkdirSync(join(dir, 'native-modules'));
  put(join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': {} } }));
  await assert.rejects(
    verifyRuntimeVersions({ lockfile: join(dir, 'package-lock.json'), modulesDir: join(dir, 'native-modules') }),
    /lists no package\.json files/
  );
});
