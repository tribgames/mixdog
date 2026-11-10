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

test('clear with rebuildPrompt (대화 초기화): refused mid-turn, then rebuilds the emptied prompt', async () => {
  let session = { id: 's1' };
  let turns = 1;
  const calls = [];
  const ops = createSessionOps({
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
    getActiveTurnCount: () => turns,
    invalidateContextStatusCache: () => {},
    mgr: {
      clearSessionMessages: async (id, options) => {
        calls.push(['clear', id, options]);
        return { id, messages: [] };
      },
    },
    refreshEmptySessionToolPolicy: async () => {
      calls.push(['rebuild', session.id]);
      return { appliedToCurrentSession: true };
    },
  });
  await assert.rejects(ops.clear({ rebuildPrompt: true }), /running a turn/);
  assert.deepEqual(calls, [], 'nothing cleared while the turn runs');
  turns = 0;
  assert.deepEqual(await ops.clear({ rebuildPrompt: true, archiveAs: 'sess_x' }), { promptRebuilt: true });
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['clear', 'rebuild'],
    'the prompt is rebuilt after the clear'
  );
  calls.length = 0;
  assert.equal(await ops.clear({}), true, 'a plain /clear is unchanged');
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['clear']
  );
});
