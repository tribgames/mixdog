import assert from 'node:assert/strict';
import test from 'node:test';
import { installProcessSignalCleanup } from './process-shutdown.mjs';

test('every failing cleanup phase is logged and the run still completes', async () => {
  const logs = [];
  const phases = [];
  const handle = installProcessSignalCleanup({
    name: 'probe',
    signals: [],
    fatal: false,
    exit: false,
    log: (line) => logs.push(line),
    beforeCleanup: (reason) => {
      phases.push(`before:${reason}`);
      throw new Error('before broke');
    },
    cleanup: async (reason) => {
      phases.push(`cleanup:${reason}`);
      throw new Error('cleanup broke');
    },
    afterCleanup: (reason) => {
      phases.push(`after:${reason}`);
      throw new Error('after broke');
    },
  });
  try {
    assert.equal(await handle.run('manual'), true);
    assert.deepEqual(phases, ['before:manual', 'cleanup:manual', 'after:manual']);
    assert.equal(logs.length, 3);
    for (const [index, message] of ['before broke', 'cleanup broke', 'after broke'].entries()) {
      assert.match(logs[index], new RegExp(`^\\[probe\\] cleanup failed: Error: ${message}`));
    }
  } finally {
    handle.uninstall();
  }
});
