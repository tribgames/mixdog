import assert from 'node:assert/strict';
import test from 'node:test';

import { processServerMessage } from './cursor-wire-stream-messages.mjs';

const enc = new TextEncoder();
const cat = (...parts) => Uint8Array.from(parts.flatMap((part) => [...part]));
const varint = (value) => {
  const out = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return Uint8Array.from(out);
};
const tag = (no, wireType) => varint(no * 8 + wireType);
const lenField = (no, bytes) => cat(tag(no, 2), varint(bytes.length), bytes);
const varintField = (no, value) => cat(tag(no, 0), varint(value));
const doubleField = (no) => cat(tag(no, 1), new Uint8Array(8));

const textUpdate = (...extra) => cat(lenField(1, lenField(1, enc.encode('hi'))), ...extra);

function run(frame) {
  const emitted = [];
  const traces = [];
  const state = { visibleOutput: false, outputTokens: 0, chunkSeq: 0 };
  const filter = { process: (text) => ({ content: text }) };
  const progress = processServerMessage(frame, {
    state,
    filter,
    emit: (delta) => emitted.push(delta),
    sessionId: 's1',
    trace: (record) => traces.push(record),
  });
  return { emitted, traces, progress };
}

test('unknown InteractionUpdate field is traced once; content is unchanged', () => {
  const base = run(lenField(1, textUpdate()));
  const result = run(lenField(1, textUpdate(varintField(30, 300))));
  assert.deepEqual(result.emitted, [{ content: 'hi' }]);
  assert.deepEqual(result.emitted, base.emitted);
  assert.equal(result.progress, base.progress);
  assert.equal(result.traces.length, 1);
  const [record] = result.traces;
  assert.equal(record.kind, 'cursor_unknown_field');
  assert.equal(record.sessionId, 's1');
  assert.equal(record.payload.scope, 'interaction_update');
  assert.equal(record.payload.fields[0].no, 30);
  assert.equal(record.payload.fields[0].preview_hex, Buffer.from(varint(300)).toString('hex'));
});

test('unknown top-level field next to interactionUpdate is traced once; content is unchanged', () => {
  const result = run(cat(lenField(1, textUpdate()), varintField(9, 7)));
  assert.deepEqual(result.emitted, [{ content: 'hi' }]);
  assert.equal(result.traces.length, 1);
  assert.equal(result.traces[0].payload.scope, 'agent_server_message');
  assert.equal(result.traces[0].payload.fields[0].no, 9);
});

test('known-noise fields (top-level 8, InteractionUpdate 25) are not traced', () => {
  const result = run(cat(lenField(1, textUpdate(varintField(25, 1700000000000))), doubleField(8)));
  assert.deepEqual(result.emitted, [{ content: 'hi' }]);
  assert.equal(result.traces.length, 0);
});

test('trace preview is bounded', () => {
  const result = run(lenField(1, textUpdate(lenField(31, new Uint8Array(500).fill(1)))));
  assert.equal(result.traces[0].payload.fields[0].bytes, 502); // value bytes: 2-byte length prefix + 500 payload
  assert.equal(result.traces[0].payload.fields[0].preview_hex.length, 96);
});
