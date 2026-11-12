import assert from 'node:assert/strict';
import test from 'node:test';

import { SECTIONS_IPC } from '../../shared/contract-sections.ts';
import { ipcErrorEnvelope, ipcErrorFromEnvelope } from '../../shared/coded-error.ts';
import { worktreeFailure } from '../../renderer/worktree-branch-model.ts';
import { worktreeErrorWithCode } from '../worktree-validation.ts';
import { coreErrorForWindow } from './core-error.ts';
import { registerProtocolWindowIpc } from './window-ipc.ts';

// The client library's failure shape: `message` is `<code> <reason> <jsonrpc message>`, `detail.data` the ErrorData.
const rpcFailure = (data) =>
  Object.assign(new Error(`-32600 ${data.reason} ${data.reason}`), {
    name: 'ClientError',
    detail: { kind: 'rpc', code: -32600, reason: data.reason, message: data.reason, data },
  });

test('a plain-Error text from the core reaches the window as that message', () => {
  const failure = rpcFailure({
    reason: 'domainError',
    domain: 'config',
    message: 'compaction threshold must be between 10 and 95',
  });
  const shown = coreErrorForWindow(failure);
  assert.equal(shown instanceof Error, true);
  assert.equal(shown.message, 'compaction threshold must be between 10 and 95');
});

test('a coded refusal keeps the wire message, and a typed detail does not replace it', () => {
  const shown = coreErrorForWindow(
    rpcFailure({
      reason: 'domainError',
      domain: 'config',
      code: 'ROOM_MEMBER_SWITCHED_OFF',
      message: 'Member is switched off.',
      detail: { type: 'roomMember', name: 'Bench', count: 1 },
    })
  );
  assert.equal(shown.message, 'Member is switched off.');
  // Only the params the code declares public, as Node's client keeps them (codedErrorParams).
  assert.deepEqual(shown.details, { name: 'Bench' });
});

test('a coded worktree refusal keeps no details beside its message, as Node\'s reached the app', () => {
  const shown = coreErrorForWindow(
    rpcFailure({
      reason: 'domainError',
      domain: 'worktree',
      code: 'WORKTREE_REVISION_CONFLICT',
      message: 'This transaction belongs to another session.',
      detail: { type: 'worktreeRevisionConflict', txId: 't-1' },
    })
  );
  assert.equal(shown.message, 'WORKTREE_REVISION_CONFLICT: This transaction belongs to another session.\n[worktree-details] {"txId":"t-1"}');
  assert.equal(Object.hasOwn(shown, 'details'), false);
});

test('an uncoded domain error without a text and other failures are left as they are', () => {
  const noDetail = rpcFailure({ reason: 'domainError', domain: 'config' });
  const other = rpcFailure({ reason: 'methodNotFound', method: 'm' });
  const closed = Object.assign(new Error('connectionLost'), { detail: { kind: 'connectionLost' } });
  for (const error of [noDetail, other, closed, new Error('plain'), 'text', null]) {
    assert.equal(coreErrorForWindow(error), error);
  }
});

test('a refused argument reaches the window as the sentence Node\'s handler threw', () => {
  const failure = rpcFailure({ reason: 'invalidParams', path: 'desktop.zoom', expected: 'Desktop zoom is fixed at 100%.' });
  const shown = coreErrorForWindow(failure);
  assert.equal(shown instanceof TypeError, true);
  assert.equal(shown.message, 'Desktop zoom is fixed at 100%.');
  assert.equal(shown.cause, failure);
});

test('a coded worktree refusal reaches the page in the shape worktreeFailure reads', () => {
  const shown = coreErrorForWindow(
    rpcFailure({
      reason: 'domainError',
      domain: 'worktree',
      code: 'WORKTREE_DIRTY',
      detail: { type: 'worktreeDirty', reason: 'project-dirty', count: 2, paths: ['a.ts', 'b.ts'] },
    })
  );
  // The same framing worktreeErrorWithCode gives Node's error: the code leads, the details trail as JSON.
  const node = worktreeErrorWithCode(
    Object.assign(new Error('WORKTREE_DIRTY'), {
      code: 'WORKTREE_DIRTY',
      details: { reason: 'project-dirty', count: 2, paths: ['a.ts', 'b.ts'] },
    })
  );
  assert.equal(shown.message, node.message);
  assert.equal(shown.code, 'WORKTREE_DIRTY');
  // Across IPC only the message survives; the page reads the code and details back out of it.
  const failure = worktreeFailure(new Error(shown.message));
  assert.equal(failure.code, 'WORKTREE_DIRTY');
  assert.deepEqual(failure.details, { reason: 'project-dirty', count: 2, paths: ['a.ts', 'b.ts'] });
});

test('an unregistered Project reads on the Rust path as the Node desktop shows it', () => {
  // Node's daemon sends `code` and `details` (project-branches.mjs throws worktreeError('WORKTREE_PROJECT_UNKNOWN',
  // undefined, { projectPath })); the desktop session host frames it with worktreeErrorWithCode (session-host-lifecycle.ts).
  const projectPath = 'C:\\work\\app';
  const node = worktreeErrorWithCode(
    Object.assign(new Error('Project is not available.'), { code: 'WORKTREE_PROJECT_UNKNOWN', details: { projectPath } })
  );
  const shown = coreErrorForWindow(
    rpcFailure({
      reason: 'domainError',
      domain: 'worktree',
      code: 'WORKTREE_PROJECT_UNKNOWN',
      message: 'Project is not available.',
      detail: { type: 'worktreeProjectUnknown', projectPath },
    })
  );
  assert.equal(shown.message, node.message);
  assert.equal(shown.code, node.code);
});

test('a coded refusal of another family goes through the IPC envelope with its code', () => {
  const shown = coreErrorForWindow(
    rpcFailure({
      reason: 'domainError',
      domain: 'project',
      code: 'PROJECT_UNAVAILABLE',
      message: 'Project is not registered.',
    })
  );
  const rebuilt = ipcErrorFromEnvelope(ipcErrorEnvelope(shown));
  assert.equal(rebuilt.code, 'PROJECT_UNAVAILABLE');
  assert.equal(rebuilt.message, 'Project is not registered.');
});

test('a window call that the core refuses with a plain-Error text rejects with that text', async () => {
  const handlers = new Map();
  const failure = rpcFailure({
    reason: 'domainError',
    domain: 'update',
    message: 'update check failed: offline',
  });
  const dispose = registerProtocolWindowIpc({
    connection: {
      snapshot: async () => ({ status: 'ready', entries: [] }),
      attach: () => () => {},
      call: async () => {
        throw failure;
      },
    },
    handle: (channel, listener) => handlers.set(channel, listener),
    send: () => true,
    removeHandler: () => {},
  });
  await assert.rejects(handlers.get(SECTIONS_IPC.call)({}, 'usage/getUsageStats', {}), {
    message: 'update check failed: offline',
  });
  dispose();
});
