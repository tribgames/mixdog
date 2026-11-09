#!/usr/bin/env node
// What Node's `rewindToItem` (session-api/intake/rewind.mjs) and `prioritizeQueued` (session-flow/queue.mjs) answer where the Rust
// core refuses: the real functions over the state that raises each refusal. `rewindToItem` answers `null` for an item the session
// does not have and for a busy session; `prioritizeQueued` goes by queue membership alone, whether a turn runs or not: an entry that
// is not queued answers a count of none, a queued one is promoted to the front with priority `now` and answers a count of one.
//
//   node --experimental-transform-types benchmarks/rust-core/recorders/record-capability-refusals.mjs --tree <tree> --ref <commit>
// Output: native/core/fixtures/capability-refusals/golden.json
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const { createRewindAction } = await importFrom(tree, 'src/tui/session/session-api/intake/rewind.mjs');
const { createQueueOps } = await importFrom(tree, 'src/tui/session/session-flow/queue.mjs');

const items = [{ kind: 'user', id: 'u1', text: 'hello', messageId: 'msg_1' }];
const rewind = [];
for (const [name, state, itemId] of [
  ['an item the session does not have', { busy: false, commandBusy: false, items }, 'no-such-item'],
  ['a busy session', { busy: true, commandBusy: false, items }, 'u1'],
]) {
  const bag = { runtime: {}, getState: () => state, set() {}, flushEmitImmediate() {}, replaceItems() {}, syncContextStats() {} };
  rewind.push({ name, busy: state.busy, items, itemId, reply: await createRewindAction(bag).rewindToItem(itemId) });
}

const prioritize = [];
for (const busy of [false, true]) {
  for (const [name, queued, selectedId] of [
    ['nothing is queued', [], 'q1'],
    ['the entry is not among the queued ones', ['q1', 'q2'], 'q9'],
    ['a blank id', ['q1'], ''],
    ['the only queued entry', ['q1'], 'q1'],
    ['a later queued entry', ['q1', 'q2', 'q3'], 'q2'],
  ]) {
    let counter = 0;
    let state = { busy, queued: [] };
    let kicked = 0;
    const bag = {
      nextId: () => `auto_${(counter += 1)}`,
      pending: [],
      pendingNotificationKeys: new Set(),
      getState: () => state,
      set: (patch) => {
        state = { ...state, ...patch };
      },
      flushEmitImmediate() {},
      runtime: { id: 'recorder' },
    };
    const ops = createQueueOps(bag, { kickDrain: () => (kicked += 1) });
    for (const id of queued) {
      const entry = ops.makeQueueEntry(`text ${id}`, { id, submittedAt: 1 });
      bag.pending.push(entry);
      state = { ...state, queued: [...state.queued, { id, text: entry.text, priority: entry.priority }] };
    }
    const reply = ops.prioritizeQueued(selectedId);
    const pendingAfter = bag.pending.map((entry) => ({ id: entry.id, priority: entry.priority }));
    // What the kicked drain takes (`dequeueQueueBatch('later')`, the batch `drain` runs; a busy session defers it to the
    // turn's settling): the entries it takes out of `pending`, and what stays.
    const drained = kicked ? ops.dequeueQueueBatch('later').map((entry) => entry.id) : null;
    prioritize.push({
      name,
      busy,
      queued,
      selectedId,
      reply,
      pendingAfter,
      kicked,
      drained,
      pendingAfterDrain: kicked ? bag.pending.map((entry) => ({ id: entry.id, priority: entry.priority })) : null,
    });
  }
}

const finalDir = join(FIXTURES_ROOT, 'capability-refusals');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { rewind, prioritize });
writeSetManifest(stage, {
  set: 'capability-refusals',
  recorder: 'benchmarks/rust-core/recorders/record-capability-refusals.mjs',
  command: 'node --experimental-transform-types benchmarks/rust-core/recorders/record-capability-refusals.mjs --tree <tree> --ref <commit>',
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, finalDir);
console.log(`recorded ${rewind.length} rewind and ${prioritize.length} prioritize cases`);
