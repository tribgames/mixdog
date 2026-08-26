import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDaemonSessionRuntimeHost,
  resolveSessionRuntimeMode,
} from './session-runtime-host-factory.mjs';

test('session runtime mode defaults to inline and accepts only explicit canonical names', () => {
  assert.equal(resolveSessionRuntimeMode(undefined), 'inline');
  assert.equal(resolveSessionRuntimeMode('process'), 'process');
  assert.throws(() => resolveSessionRuntimeMode('in-process'), /unsupported/);
  assert.throws(() => resolveSessionRuntimeMode('worker'), /unsupported/);
  assert.throws(() => resolveSessionRuntimeMode('unknown'), /unsupported/);
});

test('session runtime factory selects exactly one host implementation', () => {
  const calls = [];
  const createInline = (options) => { calls.push(['inline', options]); return { mode: 'inline' }; };
  const createProcess = (options) => { calls.push(['process', options]); return { mode: 'process' }; };
  assert.equal(createDaemonSessionRuntimeHost({ cwd: 'A' }, {
    mode: 'inline', createInline, createProcess,
  }).mode, 'inline');
  assert.equal(createDaemonSessionRuntimeHost({ cwd: 'B' }, {
    mode: 'process', createInline, createProcess,
  }).mode, 'process');
  assert.deepEqual(calls, [
    ['inline', { cwd: 'A' }],
    ['process', { cwd: 'B' }],
  ]);
});
