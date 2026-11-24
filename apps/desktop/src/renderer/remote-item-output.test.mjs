// "Show full output" of a tool row the core sent cut to what the phone shows: the rest is read from the core, and only for such a row.
import assert from 'node:assert/strict';
import test from 'node:test';

import { outputCutByCore, readWholeToolOutput } from './remote-item-output.ts';

const whole = 'a line of output\n'.repeat(300);
const wireItem = {
  type: 'toolCall',
  id: 'i1',
  name: 'read',
  input: { path: 'a' },
  output: whole,
  run: { result: whole, rawResult: `${whole}[exit code: 0]`, callId: 'c1' },
  meta: { status: 'completed', at: 1 },
};

test('only a row the core cut says so: the phone\'s own cut of a whole fold is not one', () => {
  const cutRow = { kind: 'tool', id: 'i1', result: 'a line', remoteOutputTruncated: whole.length };
  const wholeRow = { kind: 'tool', id: 'i2', result: whole };
  const state = { items: [cutRow, wholeRow] };
  assert.equal(outputCutByCore(state, 'i1'), true);
  assert.equal(outputCutByCore(state, 'i2'), false);
});

test('the whole output is fetched from the core by item id, and a stored large field is read as its blob', async () => {
  const calls = [];
  const reader = {
    call: async (method, params) => {
      calls.push([method, params]);
      return { items: [{ ...wireItem, run: { ...wireItem.run, rawResult: { blob: { digest: 'd1', bytes: 8, mediaType: 'text/plain' } } } }] };
    },
    readBlob: async (ref) => {
      assert.equal(ref.blob.digest, 'd1', 'the client reads a BlobRef: the stub with its descriptor');
      return new TextEncoder().encode('raw body');
    },
  };
  const output = await readWholeToolOutput(reader, 't1', 'i1');
  assert.deepEqual(calls, [['thread/items/read', { threadId: 't1', itemIds: ['i1'] }]]);
  assert.equal(output.id, 'i1');
  assert.equal(output.result, whole);
  assert.equal(output.rawResult, 'raw body');
});

test('a row the core no longer has reads as nothing', async () => {
  assert.equal(await readWholeToolOutput({ call: async () => ({ items: [] }) }, 't1', 'i1'), null);
});
