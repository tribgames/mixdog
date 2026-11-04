import assert from 'node:assert/strict';
import test from 'node:test';

import { setSessionRuntimeImporterForTest, warmLocalSessionRuntime } from './local-session-runtime.mjs';

test('warm-up loads the session-runtime module once and tolerates failure', async () => {
  let imports = 0;
  setSessionRuntimeImporterForTest(async () => {
    imports += 1;
    throw new Error('boom');
  });
  assert.equal(await warmLocalSessionRuntime(), false);
  assert.equal(imports, 1);

  setSessionRuntimeImporterForTest(async () => {
    imports += 1;
    return { createMixdogSessionRuntime() {}, async preloadSessionRuntimeModules() {} };
  });
  assert.equal(await warmLocalSessionRuntime(), true);
  assert.equal(await warmLocalSessionRuntime(), true);
  assert.equal(imports, 2, 'a loaded module is reused, not re-imported');
  setSessionRuntimeImporterForTest(null);
});

test('a host closing during the warm-up stops it before the next step', async (t) => {
  t.after(() => setSessionRuntimeImporterForTest(null));
  const steps = [];
  let closed = false;
  setSessionRuntimeImporterForTest(async () => {
    steps.push('runtime-graph');
    closed = true;
    return {
      createMixdogSessionRuntime() {},
      async preloadSessionRuntimeModules() {
        steps.push('preload');
      },
    };
  });
  assert.equal(await warmLocalSessionRuntime({ isClosed: () => closed }), false);
  assert.deepEqual(steps, ['runtime-graph']);
});
