import assert from 'node:assert/strict';
import test from 'node:test';

import { processServerMessage } from './cursor-wire-stream-messages.mjs';
import { decodeMessage, encodeMessage } from './cursor-wire-protobuf.mjs';
import { sendToolResult } from './cursor-wire-exec.mjs';

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

// Independently encoded server completion: edit call 12, result 2.
const editCompletion = (outcome, callId = 'edit-id') =>
  lenField(
    1,
    lenField(
      3,
      cat(
        lenField(1, enc.encode(callId)),
        lenField(2, lenField(12, lenField(2, lenField(outcome, enc.encode('private file contents'))))),
        lenField(3, enc.encode('model-id'))
      )
    )
  );

test('native edit error decodes correlation and traces only the outcome', () => {
  const frame = editCompletion(7);
  const completed = decodeMessage('AgentServerMessage', frame).interactionUpdate.toolCallCompleted;
  assert.equal(completed.callId, 'edit-id');
  assert.equal(completed.modelCallId, 'model-id');
  assert.ok(completed.toolCall.editToolCall.result.error instanceof Uint8Array);
  const result = run(frame);
  assert.equal(result.progress, 'work');
  assert.deepEqual(result.emitted, []);
  assert.deepEqual(result.traces, [
    {
      sessionId: 's1',
      kind: 'cursor_native_edit_failure',
      provider: 'cursor',
      payload: { callId: 'edit-id', modelCallId: 'model-id', outcome: 'error' },
    },
  ]);
});

test('native edit failures never execute tools or send client results, even on repeated completion', () => {
  const state = { outputTokens: 0, pending: [{ toolCallId: 'edit-id', toolName: 'read' }] };
  const before = structuredClone(state);
  const traces = [];
  const ctx = {
    state,
    trace: (record) => traces.push(record),
    emit: () => assert.fail('completion must not emit executable calls or content'),
    bridge: { write: () => assert.fail('completion must not send client results') },
  };
  for (const [field, outcome] of [
    [2, 'fileNotFound'],
    [3, 'readPermissionDenied'],
    [4, 'writePermissionDenied'],
    [6, 'rejected'],
    [7, 'error'],
  ]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal(processServerMessage(editCompletion(field), ctx), 'work');
      assert.equal(traces.at(-1).payload.outcome, outcome);
      assert.deepEqual(state, before);
    }
  }
  assert.equal(traces.length, 10);
});

test('native edit success and unknown outcomes are not reported as failures', () => {
  for (const field of [1, 99]) {
    const result = run(editCompletion(field));
    assert.deepEqual(result.traces, []);
    assert.deepEqual(result.emitted, []);
    assert.equal(result.progress, 'work');
  }
});

test('native edit diagnostic IDs are bounded and trace failures do not affect progress', () => {
  const frame = editCompletion(7, 'a'.repeat(1000));
  assert.equal(run(frame).traces[0].payload.callId.length, 256);
  assert.equal(
    processServerMessage(frame, {
      state: { outputTokens: 0 },
      trace: () => {
        throw new Error('trace unavailable');
      },
      emit: () => assert.fail('unexpected output'),
    }),
    'work'
  );
});

test('distinct execs sharing a parent call ID retain separate results; repeated execs do not execute twice', () => {
  const state = { pending: [], outputTokens: 0 };
  const emitted = [];
  const frames = [];
  const bridge = { write: (frame) => frames.push(frame) };
  const ctx = { state, bridge, tools: [{ name: 'read' }], trace: () => {}, emit: (delta) => emitted.push(delta) };
  for (const id of [1, 2, 1, 2]) {
    processServerMessage(
      encodeMessage('AgentServerMessage', {
        execServerMessage: {
          id,
          execId: `exec-${id}`,
          readArgs: { path: `${id}.txt`, toolCallId: 'shared-parent' },
        },
      }),
      ctx
    );
  }
  assert.equal(state.pending.length, 2);
  assert.equal(emitted.length, 2);
  assert.notEqual(state.pending[0].toolCallId, state.pending[1].toolCallId);
  for (const pending of state.pending) {
    const text = pending.exec.id === 1 ? 'first' : 'second';
    sendToolResult(bridge, pending, { content: `[lines 1-1]\n${text}\n[lines 1-1 of 1]` }, true);
  }
  const results = frames.map((frame) => decodeMessage('AgentClientMessage', frame.subarray(5)).execClientMessage);
  assert.deepEqual(
    results.map((result) => [result.id, result.execId, result.readResult.success.content]),
    [
      [1, 'exec-1', 'first'],
      [2, 'exec-2', 'second'],
    ]
  );
});

test('execution identities and completed results survive a new stream batch', () => {
  const executions = new Map();
  const frames = [];
  const bridge = { write: (frame) => frames.push(frame) };
  const emitted = [];
  const batch = () => ({
    state: { pending: [], outputTokens: 0, executions },
    bridge,
    tools: [{ name: 'read' }],
    trace: () => {},
    emit: (delta) => emitted.push(delta),
  });
  const request = (id) =>
    encodeMessage('AgentServerMessage', {
      execServerMessage: { id, execId: `exec-${id}`, readArgs: { path: `${id}.txt`, toolCallId: 'parent' } },
    });
  const first = batch();
  processServerMessage(request(1), first);
  sendToolResult(bridge, first.state.pending[0], { content: '[lines 1-1]\noriginal\n[lines 1-1 of 1]' }, true);
  const next = batch();
  processServerMessage(request(2), next);
  processServerMessage(request(1), next);
  assert.equal(emitted.length, 2, 'completed replay must not execute again');
  assert.equal(next.state.pending.length, 1);
  assert.notEqual(first.state.pending[0].toolCallId, next.state.pending[0].toolCallId);
  assert.equal(frames.length, 2, 'completed replay receives the cached result');
  assert.deepEqual(frames[1], frames[0]);
});
