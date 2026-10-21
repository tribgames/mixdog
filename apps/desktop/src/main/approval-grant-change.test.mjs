import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { registerSessionIpc } from './ipc-sessions.ts';
import { createRemoteMethods } from './remote-methods.ts';

const SESSION = `sess_desktop_${'a'.repeat(64)}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

function desktopAnswer(accepted = true) {
  const handlers = new Map();
  const ops = [];
  registerSessionIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    host: { resolveToolApprovalForSession: async () => accepted },
    invokeDesktopOperation: async (...args) => ops.push(args),
  });
  return {
    ops,
    answer: (decision) => handlers.get(DESKTOP_IPC.resolveToolApprovalForSession)({}, SESSION, 'a1', decision),
  };
}

function remoteAnswer(accepted = true) {
  const ops = [];
  const methods = createRemoteMethods(
    {
      host: {
        resolveToolApprovalForSession: async () => accepted,
        invokeDesktopOperation: async (...args) => ops.push(args),
      },
    },
    { deviceName: async () => 'Pixel 9' }
  );
  return { ops, answer: (decision) => methods.resolveToolApprovalForSession([SESSION, 'a1', decision]) };
}

for (const [label, make] of [
  ['this PC', desktopAnswer],
  ['a paired phone', remoteAnswer],
]) {
  test(`${label}: an approval that remembers a grant broadcasts the permissions change`, async () => {
    for (const remember of ['agent', 'always']) {
      const { ops, answer } = make();
      assert.equal(await answer({ approved: true, remember }), true);
      await tick();
      assert.deepEqual(ops, [['notifySettingsChanged', ['permissions']]]);
    }
  });

  test(`${label}: an approval without a remembered grant, or one not accepted, broadcasts nothing`, async () => {
    const plain = make();
    await plain.answer({ approved: true });
    await plain.answer({ approved: true, remember: 'once' });
    const refused = make(false);
    assert.equal(await refused.answer({ approved: true, remember: 'agent' }), false);
    await tick();
    assert.deepEqual(plain.ops, []);
    assert.deepEqual(refused.ops, []);
  });
}
