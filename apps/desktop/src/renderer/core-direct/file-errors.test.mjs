import assert from 'node:assert/strict';
import test from 'node:test';

import { asNodeErrors, FILE_CHANGED, staleSave } from './renderer-connection.ts';

const rpc = (reason) =>
  Object.assign(new Error(`-32600 ${reason} ${reason}`), {
    name: 'ClientError',
    detail: { kind: 'rpc', data: { reason } },
  });

test('a file call of the window asks for the plain errors Node showed; other calls are untouched', () => {
  assert.deepEqual(asNodeErrors('projectFs/readText', { root: 'r', rel: 'a' }), {
    root: 'r',
    rel: 'a',
    nodeErrors: true,
  });
  assert.deepEqual(asNodeErrors('project/list', {}), {});
  assert.equal(asNodeErrors('projectFs/stat', undefined), undefined);
});

test("a stale save is Node's sentence; any other refusal stays as the core sent it", () => {
  const stale = rpc('preconditionFailed');
  const shown = staleSave('projectFs/writeText', stale);
  assert.equal(shown.message, FILE_CHANGED);
  assert.equal(shown.cause, stale);
  assert.equal(staleSave('thread/delete', stale), stale);
  const other = rpc('permissionDenied');
  assert.equal(staleSave('projectFs/writeText', other), other);
});
