import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  configureCheckoutRuntimeRoot,
  resolveCheckoutRuntimeRoot,
} from '../src/runtime/shared/runtime-root.mjs';

test('development checkouts share a checkout-specific daemon without claiming the installed root', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'mixdog-runtime-scope-'));
  const tempRoot = join(fixture, 'tmp');
  const first = join(fixture, 'first');
  const second = join(fixture, 'second');
  const installed = join(fixture, 'installed');
  for (const root of [first, second, installed, tempRoot]) mkdirSync(root, { recursive: true });
  mkdirSync(join(first, '.git'));
  mkdirSync(join(second, '.git'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));

  const firstRoot = resolveCheckoutRuntimeRoot(first, { env: {}, tempRoot });
  assert.match(firstRoot, /mixdog-dev-[a-f0-9]{12}$/);
  assert.equal(resolveCheckoutRuntimeRoot(first, { env: {}, tempRoot }), firstRoot);
  assert.notEqual(resolveCheckoutRuntimeRoot(second, { env: {}, tempRoot }), firstRoot);
  assert.equal(resolveCheckoutRuntimeRoot(installed, { env: {}, tempRoot }), join(tempRoot, 'mixdog'));

  const cliEnv = {};
  const desktopEnv = {};
  assert.equal(configureCheckoutRuntimeRoot(first, { env: cliEnv, tempRoot }), firstRoot);
  assert.equal(configureCheckoutRuntimeRoot(first, { env: desktopEnv, tempRoot }), firstRoot);
  assert.equal(cliEnv.MIXDOG_RUNTIME_ROOT, desktopEnv.MIXDOG_RUNTIME_ROOT);
  assert.equal(cliEnv.MIXDOG_DATA_DIR, join(first, '.mixdog', 'dev-data'));
  assert.equal(desktopEnv.MIXDOG_DATA_DIR, cliEnv.MIXDOG_DATA_DIR);

  const explicit = join(fixture, 'explicit');
  const explicitData = join(fixture, 'explicit-data');
  const explicitEnv = { MIXDOG_RUNTIME_ROOT: explicit, MIXDOG_DATA_DIR: explicitData };
  assert.equal(configureCheckoutRuntimeRoot(first, { env: explicitEnv, tempRoot }), explicit);
  assert.equal(explicitEnv.MIXDOG_RUNTIME_ROOT, explicit, 'an explicit isolation root always wins');
  assert.equal(explicitEnv.MIXDOG_DATA_DIR, explicitData, 'an explicit data root always wins');
});
