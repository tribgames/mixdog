import assert from 'node:assert/strict';
import test from 'node:test';
import { fileErrorCode, ipcErrorEnvelope, ipcErrorFromEnvelope } from './file-error-codes.ts';

test('a structured refusal crosses the IPC boundary with its code and its unchanged message', () => {
  for (const code of ['SELECTED_FILE_GRANT_UNAVAILABLE', 'PROJECT_UNAVAILABLE', 'ENOENT', 'EACCES']) {
    const original = Object.assign(new Error('Shown to the user: C:/a b.txt'), { code });
    // Electron keeps only structured-cloneable data: the envelope survives, the Error's code does not.
    const arrived = ipcErrorFromEnvelope(structuredClone(ipcErrorEnvelope(original)));
    assert.equal(arrived.code, code);
    assert.equal(arrived.message, original.message);
    assert.ok(arrived instanceof Error);
  }
});

test('other errors and ordinary results are not mistaken for envelopes', () => {
  for (const error of [new Error('plain'), Object.assign(new Error('x'), { code: 'WORKTREE_DIRTY' }), null, 'text']) {
    assert.equal(ipcErrorEnvelope(error), null);
    assert.equal(fileErrorCode(error), undefined);
  }
  for (const result of [
    null,
    undefined,
    3,
    'text',
    {},
    { code: 'ENOENT', message: 'x' },
    [{ __mixdogIpcError: 1 }],
    { __mixdogIpcError: null },
    { __mixdogIpcError: undefined },
  ]) {
    assert.equal(ipcErrorFromEnvelope(result), null);
  }
});
