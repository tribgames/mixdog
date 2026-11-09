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

// Entries whose text or `skipSlashCommands` is not the default: `isSlashQueuedEntry` keeps a recognized slash command out of
// `prioritizeQueued` (`!isSlashQueuedEntry`), and reads `skipSlashCommands` by JS truthiness. The raw values are what Node ran
// on; the fixture holds them as JSON writes them (`-0` is `0`, `NaN` is `null`), the form the store hands the Rust core.
const slashCases = [
  ['a registered slash command', ['q1', 'q2'], 'q2', { q2: { content: '/compact now' } }],
  ['a registered alias in capitals after blanks', ['q1', 'q2'], 'q2', { q2: { content: '  \u00a0/NEW' } }],
  ['an unregistered /word', ['q1', 'q2'], 'q2', { q2: { content: '/Users/example/python-learn' } }],
  ['a bare slash', ['q1', 'q2'], 'q2', { q2: { content: '/' } }],
  ['a slash command in text parts', ['q1', 'q2'], 'q2', { q2: { content: [{ type: 'text', text: '/model' }] } }],
  ['a text part before the command', ['q1', 'q2'], 'q2', { q2: { content: [{ type: 'text', text: 'see' }, { type: 'text', text: '/model' }] } }],
  ['a command in the first of two text parts', ['q1', 'q2'], 'q2', { q2: { content: [{ type: 'text', text: '/model' }, { type: 'text', text: 'x' }] } }],
  ...[true, 1, 'x', false, 0, -0, Number.NaN, ''].map((skip) => [
    `a slash command with skipSlashCommands ${Object.is(skip, -0) ? '-0' : String(skip)}`,
    ['q1', 'q2'],
    'q2',
    { q2: { content: '/compact', skipSlashCommands: skip } },
  ]),
];

const prioritize = [];
for (const busy of [false, true]) {
  for (const [name, queued, selectedId, overrides = {}] of [
    ['nothing is queued', [], 'q1'],
    ['the entry is not among the queued ones', ['q1', 'q2'], 'q9'],
    ['a blank id', ['q1'], ''],
    ['the only queued entry', ['q1'], 'q1'],
    ['a later queued entry', ['q1', 'q2', 'q3'], 'q2'],
    ...slashCases,
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
      const { content = `text ${id}`, ...raw } = overrides[id] ?? {};
      const entry = Object.assign(ops.makeQueueEntry(content, { id, submittedAt: 1 }), raw);
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
      entries: JSON.parse(JSON.stringify(overrides)),
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
// The registry `isSlashQueuedEntry` consults (`recognisedSlashToken`): a static table, `SLASH_COMMANDS`; no plugin, skill or
// user command is added at runtime. Every name and alias is probed as typed, upper-cased and with arguments, and unregistered
// and odd tokens are probed too.
const { SLASH_COMMANDS, recognisedSlashToken } = await importFrom(tree, 'src/tui/app/slash-commands.mjs');
const slashCommands = SLASH_COMMANDS.map((command) => ({ name: command.name, aliases: command.aliases ?? [] }));
const tokens = slashCommands.flatMap((command) => [command.name, ...command.aliases]);
const probes = [
  ...tokens.flatMap((token) => [`/${token}`, `/${token.toUpperCase()} args`, `  /${token}\nmore`]),
  '/', '', '/ clear', '/nope', '/clear/x', '//clear', '/İnstall', '/ＣＬＥＡＲ', 'clear', ' \u00a0/clear', '\ufeff/clear',
].map((text) => ({ text, token: recognisedSlashToken(text) }));
writeJson(join(stage, 'golden.json'), { rewind, prioritize, slash: { commands: slashCommands, probes } });
writeSetManifest(stage, {
  set: 'capability-refusals',
  recorder: 'benchmarks/rust-core/recorders/record-capability-refusals.mjs',
  command: 'node --experimental-transform-types benchmarks/rust-core/recorders/record-capability-refusals.mjs --tree <tree> --ref <commit>',
  identityTree: tree,
  identityRef: args.get('ref') ?? 'HEAD',
});
commitStage(stage, finalDir);
console.log(`recorded ${rewind.length} rewind and ${prioritize.length} prioritize cases`);
