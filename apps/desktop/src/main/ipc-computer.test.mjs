import assert from 'node:assert/strict';
import test from 'node:test';
import { DESKTOP_IPC } from '../shared/contract.ts';
import { pcAccessApprovalOf, pcAccessRowOf, registerComputerIpc } from './ipc-computer.ts';

const ready = {
  installed: true,
  outdated: false,
  enrolledKeys: 1,
  missingKeys: [],
  owed: { keys: [], unknown: 0 },
  supported: true,
  otherUser: false,
  needsEnroll: false,
};

test('the core readiness maps onto the row states', () => {
  assert.deepEqual(pcAccessRowOf(ready), { state: 'ready' });
  assert.deepEqual(pcAccessRowOf({ ...ready, supported: false }), { state: 'unavailable' });
  assert.deepEqual(pcAccessRowOf({ ...ready, otherUser: true }), { state: 'other-user' });
  assert.deepEqual(pcAccessRowOf({ ...ready, installed: false }), { state: 'not-installed' });
  assert.deepEqual(pcAccessRowOf({ ...ready, outdated: true }), { state: 'not-installed' });
  assert.deepEqual(pcAccessRowOf({ ...ready, owed: { keys: ['k'], unknown: 0 } }), { state: 'ready' });
  assert.deepEqual(pcAccessRowOf({ ...ready, owed: { keys: [], unknown: 2 } }), { state: 'revocations-unknown' });
  assert.deepEqual(pcAccessRowOf({ ...ready, needsEnroll: true }), { state: 'needs-enroll' });
  assert.deepEqual(pcAccessRowOf({ ...ready, owed: { keys: [], unknown: 1 }, needsEnroll: true }), {
    state: 'revocations-unknown',
  });
});

test('the core approval maps onto the row outcomes', () => {
  for (const outcome of ['installed', 'updated', 'enrolled'])
    assert.deepEqual(pcAccessApprovalOf({ outcome }), { outcome: 'done' });
  assert.deepEqual(pcAccessApprovalOf({ outcome: 'nothing' }), { outcome: 'nothing-to-do' });
  assert.deepEqual(pcAccessApprovalOf({ outcome: 'failed', detail: 'x', exitCode: 7 }), {
    outcome: 'failed',
    detail: 'x',
    exitCode: 7,
  });
  for (const outcome of ['declined', 'in-progress', 'other-user', 'unavailable'])
    assert.deepEqual(pcAccessApprovalOf({ outcome }), { outcome });
});

function ipc(operation) {
  const handlers = new Map();
  const calls = [];
  registerComputerIpc({
    handle: (channel, fn) => handlers.set(channel, fn),
    shell: { openExternal: async () => {} },
    computer: { readPermissions: async () => ({ screen: 'granted' }), requestPermissions() {} },
    invokeDesktopOperation: async (name, args) => {
      calls.push([name, args]);
      return operation(name);
    },
  });
  return { handlers, calls };
}

test('readiness and approve go through the core and reach the renderer in the old shape', async () => {
  const { handlers, calls } = ipc((name) => (name === 'pcAccessReadiness' ? { ...ready, needsEnroll: true } : { outcome: 'installed' }));
  const row = await handlers.get(DESKTOP_IPC.computerReadiness)({});
  const approval = await handlers.get(DESKTOP_IPC.approvePcAccess)({});
  if (process.platform === 'win32') {
    assert.deepEqual(row.pcAccess, { state: 'needs-enroll' });
    assert.deepEqual(approval, { outcome: 'done' });
    assert.deepEqual(calls, [['pcAccessReadiness', []], ['pcAccessApprove', []]]);
  } else {
    assert.equal(row.pcAccess, undefined);
    assert.equal(calls.length, 0);
  }
});

test('a failed core read leaves the row out', async () => {
  const { handlers } = ipc(() => {
    throw new Error('core down');
  });
  const row = await handlers.get(DESKTOP_IPC.computerReadiness)({});
  assert.equal(row.pcAccess, undefined);
});
