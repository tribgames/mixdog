// The desktop/remote setCwd is a Project switch through the runtime
// authority: never tolerated as the calling turn, awaited, failures surfaced.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionOps } from './session-ops.mjs';

test('setCwd routes through switchProject without the own-turn allowance and surfaces refusals', async () => {
  const calls = [];
  let refusal = null;
  const ops = createSessionOps({
    resolveCwdPath: (path) => `resolved:${path}`,
    switchProject: async (...args) => {
      calls.push(args);
      if (refusal) throw refusal;
      return args[0];
    },
  });
  assert.equal(await ops.setCwd('next'), 'resolved:next');
  assert.deepEqual(calls, [['resolved:next', { classifyByMembership: true }]]);
  refusal = new Error('The session is running a turn; wait for it to finish.');
  await assert.rejects(ops.setCwd('other'), /running a turn/);
});
