// A paired remote client switches or creates branches only through the
// runtime's guarded, project-authorized selectProjectBranch capability.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteMethods, executeRemoteFrame } from './remote-methods.ts';

test('the remote relay has no raw branch checkout/create; selectProjectBranch reaches the host guard', async () => {
  const calls = [];
  const methods = createRemoteMethods({
    host: {
      async invokeCapability(capability, args, sessionId) {
        calls.push([capability, args, sessionId]);
        return { value: { branch: args[0].branch, changed: true }, snapshot: null };
      },
    },
  });
  for (const raw of [
    'gitCheckoutBranch',
    'gitCreateBranch',
    'gitCreateBranchAtCommit',
    'gitCheckoutCommit',
    'gitMergeBranch',
  ]) {
    assert.equal(Object.hasOwn(methods, raw), false, raw);
    const reply = await executeRemoteFrame(methods, JSON.stringify({ id: 1, method: raw, params: ['/p', 'dev'] }));
    assert.deepEqual(reply, { id: 1, ok: false, error: `unknown method: ${raw}` });
  }
  const input = { projectPath: '/p', branch: 'from-history', create: true, startPoint: 'a'.repeat(40) };
  const result = await methods.invokeCapability([{ capability: 'selectProjectBranch', args: [input] }]);
  assert.deepEqual(result.value, { branch: 'from-history', changed: true });
  // Shape-checked like the local path; the host resolves the registered Project.
  assert.deepEqual(calls, [['selectProjectBranch', [input], undefined]]);
  assert.throws(() =>
    methods.invokeCapability([{ capability: 'selectProjectBranch', args: [{ ...input, startPoint: '--force' }] }])
  );
  // The history menu's detached checkout takes the same guarded path.
  const detach = { projectPath: '/p', detach: 'b'.repeat(40) };
  await methods.invokeCapability([{ capability: 'selectProjectBranch', args: [detach] }]);
  assert.deepEqual(calls.at(-1), ['selectProjectBranch', [detach], undefined]);
  assert.throws(() =>
    methods.invokeCapability([{ capability: 'selectProjectBranch', args: [{ ...detach, detach: '--detach' }] }])
  );
});
