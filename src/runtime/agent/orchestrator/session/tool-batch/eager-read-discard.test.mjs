import assert from 'node:assert/strict';
import test from 'node:test';
import { createEagerDispatcher } from '../eager-dispatch.mjs';
import { processToolBatch } from '../tool-batch.mjs';

const tools = [{ name: 'read', annotations: { readOnlyHint: true } }];
const cwd = process.cwd();

// Fake executor mirroring the read tool: a repeat read of a path answers the
// unchanged stub unless the caller suppresses it.
function makeHarness() {
  const state = { bodies: { 'a.txt': 'A-old', 'b.txt': 'B-body' }, seen: new Set(), reads: [] };
  const executeToolFn = async (name, args, _cwd, _sid, _ref, options = {}) => {
    if (name === 'edit') {
      state.bodies[args.file_path] = 'A-new';
      return { result: 'edited', explicitSuccess: true };
    }
    const path = Array.isArray(args.file_path) ? args.file_path[0].file_path : args.file_path;
    state.reads.push({ path, suppress: options.suppressReadUnchangedStub === true });
    const first = !state.seen.has(path);
    state.seen.add(path);
    if (!first && options.suppressReadUnchangedStub !== true) return `[file unchanged: ${path}]`;
    return state.bodies[path];
  };
  const dispatcher = createEagerDispatcher({
    tools,
    cwd,
    sessionId: null,
    sessionRef: {},
    signal: null,
    opts: {},
    crossTurnCalls: new Map(),
    getIterations: () => 1,
    getNextIteration: () => 1,
    repeatFailLimit: 3,
    executeToolFn,
  });
  return { state, executeToolFn, dispatcher };
}

async function runBatch({ executeToolFn, dispatcher }, calls) {
  const results = [];
  await processToolBatch({
    calls,
    messages: [],
    tools,
    cwd,
    sessionId: null,
    sessionRef: {},
    signal: null,
    opts: {},
    iterations: 1,
    assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
    pending: dispatcher.pending,
    epoch: dispatcher.epoch,
    startEagerRun: dispatcher.startEagerRun,
    crossTurnCalls: new Map(),
    crossTurnCap: 100,
    sessionAgent: null,
    pushToolResultMessage: (message) => results.push(message),
    throwIfAborted: () => {},
    repeatFailLimit: 3,
    dedupStubTotal: 0,
    editCount: 0,
    executeToolFn,
  });
  return results;
}

const editA = { id: 'e', name: 'edit', arguments: { file_path: 'a.txt', old_string: 'A-old', new_string: 'A-new' } };

test('eager read of a different file survives an earlier edit and is consumed', async () => {
  const h = makeHarness();
  const read = { id: 'r', name: 'read', arguments: { file_path: 'b.txt' } };
  h.dispatcher.startEagerTool(read);
  await new Promise((resolve) => setImmediate(resolve));
  const results = await runBatch(h, [editA, read]);
  assert.equal(results[1].content, 'B-body');
  assert.equal(h.state.reads.length, 1);
});

test('eager windowed read of a different file survives an earlier edit and is consumed', async () => {
  const h = makeHarness();
  const read = { id: 'r', name: 'read', arguments: { file_path: [{ file_path: 'b.txt', offset: 1, limit: 50 }] } };
  h.dispatcher.startEagerTool(read);
  await new Promise((resolve) => setImmediate(resolve));
  const results = await runBatch(h, [editA, read]);
  assert.equal(results[1].content, 'B-body');
  assert.equal(h.state.reads.length, 1);
});

test('eager read of the edited file re-executes and returns the post-edit body', async () => {
  const h = makeHarness();
  const read = { id: 'r', name: 'read', arguments: { file_path: 'a.txt' } };
  h.dispatcher.startEagerTool(read);
  await new Promise((resolve) => setImmediate(resolve));
  const results = await runBatch(h, [editA, read]);
  assert.equal(results[1].content, 'A-new');
  assert.equal(h.state.reads.length, 2);
  assert.equal(h.state.reads[1].suppress, true);
});

test('discarded eager read of an unedited file never yields the unchanged stub', async () => {
  const h = makeHarness();
  const read = { id: 'r', name: 'read', arguments: { file_path: 'b.txt' } };
  h.dispatcher.startEagerTool(read);
  await new Promise((resolve) => setImmediate(resolve));
  // A pathless edit makes the mutation paths unknown, forcing the discard.
  const pathless = { id: 'e', name: 'edit', arguments: { old_string: 'x', new_string: 'y' } };
  const results = await runBatch(h, [pathless, read]);
  assert.equal(results[1].content, 'B-body');
  assert.equal(h.state.reads[1].suppress, true);
});
