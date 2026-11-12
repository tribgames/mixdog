import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { launchCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import { coreBinaryPath, coreEnvironment, packagedMixdogRoot } from './local-core.ts';

test('a packaged app tells the core where its unpacked resources and its profile are; a development run leaves the environment alone', () => {
  const base = { PATH: 'p' };
  const resources = join('r', 'resources');
  const userData = join('r', 'profile');
  assert.deepEqual(coreEnvironment(true, resources, userData, base), {
    PATH: 'p',
    MIXDOG_ROOT: join(resources, 'runtime.asar.unpacked', 'node_modules', 'mixdog', 'src'),
    MIXDOG_DESKTOP_USER_DATA: userData,
  });
  assert.equal(packagedMixdogRoot(resources), coreEnvironment(true, resources, userData, {}).MIXDOG_ROOT);
  assert.equal(coreEnvironment(false, resources, userData, base), base);
});

test('the packaged core binary sits beside the resources', () => {
  assert.equal(coreBinaryPath(true, 'res', 'win32'), join('res', 'core', 'mixdogd.exe'));
  assert.equal(coreBinaryPath(true, 'res', 'linux'), join('res', 'core', 'mixdogd'));
});

test('launching the core spawns it detached with the given environment', async () => {
  const spawned = [];
  const spawnImpl = (bin, args, options) => {
    spawned.push({ bin, args, options });
    return {
      once(event, listener) {
        if (event === 'spawn') queueMicrotask(listener);
      },
      unref() {},
    };
  };
  const env = { MIXDOG_ROOT: 'x' };
  await launchCore({ bin: 'mixdogd', env, spawnImpl });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['serve']);
  assert.equal(spawned[0].options.env, env);
  assert.equal(spawned[0].options.detached, true);
});