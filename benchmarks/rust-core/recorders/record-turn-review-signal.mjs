#!/usr/bin/env node
// When Node tells a client to read the review again, and what the client then reads (`noteTurnReviewChanged`,
// turn-worktree-snapshot.mjs lines 175, 197, 1416, turn-boundary-signal.mjs).
//
//   node benchmarks/rust-core/recorders/record-turn-review-signal.mjs --tree <tree of b6f10295a with node_modules> --patch-bin <mixdog-patch binary>
// Output: native/core/fixtures/turn-review-signal/scenarios.json
//
// Every trigger runs through the entry point the product uses: the edit and apply_patch tools (their cache invalidation reaches
// `runtime-review-api.mjs`'s listener), the git command tool through `executeTool` (its `finally` notes the settle), the turn
// begin/complete of the turn snapshot, and Undo/Reapply. The desktop's one consumer is modelled as it is wired
// (`desktop-service.ts:1058` forwards each delivery as the data-less `turn-review-changed` event; `use-turn-review-reads.ts:292-306`
// rereads the review of the session its window shows): every scenario session has such a client, and for each delivery the recording
// holds the notification and each client's whole reread answer. Rereads that raise further deliveries are followed in order. After an
// action the microtask queue is drained with `await null`, the signal's own dispatch being a microtask.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, sha256, stageSet, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const patchBin = resolve(args.get('patch-bin') ?? '');
if (!args.get('patch-bin')) throw new Error('pass --patch-bin <a mixdog-patch binary built from this checkout>');
process.env.MIXDOG_PATCH_NATIVE_BIN = patchBin;
const work = realpathSync.native(mkdtempSync(join(resolve(args.get('work') ?? tmpdir()), 'turn-review-signal-')));
process.env.GIT_CEILING_DIRECTORIES = work;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const snapshot = await importFrom(tree, 'src/runtime/shared/turn-snapshot.mjs');
const store = await importFrom(tree, 'src/runtime/shared/turn-snapshot-store.mjs');
const worktrees = await importFrom(tree, 'src/runtime/shared/turn-worktree-snapshot.mjs');
const boundary = await importFrom(tree, 'src/runtime/shared/turn-boundary-signal.mjs');
const replyMod = await importFrom(tree, 'src/runtime/shared/turn-review-reply.mjs');
const { executeBuiltinTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/builtin.mjs');
const { executePatchTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/patch.mjs');
const { executeTool } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/loop/tool-exec.mjs');
// Importing it registers the two wirings under test (a command settling, a cache invalidation) exactly as the runtime does.
await importFrom(tree, 'src/session-runtime/runtime-review-api.mjs');

// The desktop service's listener: one global event per delivery.
let deliveries = 0;
boundary.onTurnReviewChanged(() => {
  deliveries += 1;
});

const T = (text) => ({ text });
const lines = (...rows) => `${rows.join('\n')}\n`;

async function runScenario(scenario) {
  const dir = mkdtempSync(join(work, 'sc-'));
  const roots = { base: dir, w1: join(dir, 'w1'), w2: join(dir, 'w2'), ng: join(dir, 'plain') };
  for (const root of [roots.w1, roots.w2, roots.ng]) mkdirSync(root, { recursive: true });
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_DATA_DIR = data;
  store._setTurnSnapshotStoreRootForTest(join(data, 'turn-snapshots'));
  snapshot._resetTurnSnapshotForTest();
  worktrees._resetTurnWorktreeSnapshotsForTest();
  const tokens = new Map();
  const revisions = new Map();
  const clients = new Map();
  const results = [];
  const where = (spec) => (spec.path ? join(roots[spec.ws], spec.path) : roots[spec.ws]);
  // The scenario's directories as tokens, in every spelling Node may hand back.
  const tokenize = (value) => {
    if (typeof value === 'string') {
      for (const [name, root] of Object.entries(roots)) {
        for (const form of [root, root.replace(/\\/g, '/'), root.toLowerCase(), root.toLowerCase().replace(/\\/g, '/')]) value = value.split(form).join(`<${name}>`);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(tokenize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, tokenize(item)]));
    return value;
  };
  let toolCalls = 0;
  const options = (spec) => ({ sessionId: spec.session, toolCallId: `call-${(toolCalls += 1)}` });
  const reread = (client) =>
    replyMod.turnReviewReply((reviewOptions) => snapshot.getTurnReviewDiff(roots[client.ws], client.session, reviewOptions), {});
  const run = async (op) => {
    switch (op.op) {
      case 'git':
        execFileSync('git', ['init', '-q'], { cwd: roots[op.ws] });
        return {};
      case 'file':
      case 'external':
        // `external`: a write no boundary reported.
        mkdirSync(dirname(where(op)), { recursive: true });
        writeFileSync(where(op), op.content.text);
        return {};
      case 'client':
        clients.set(op.session, { session: op.session, ws: op.ws });
        return {};
      case 'begin': {
        tokens.set(op.session, await snapshot.beginTurnSnapshot(roots[op.ws], op.session, { checkpointId: op.checkpoint }));
        return {};
      }
      case 'complete':
        return { completed: await snapshot.completeTurnSnapshot(op.session, tokens.get(op.session) ?? null) };
      case 'edit':
        return { text: tokenize(String(await executeBuiltinTool('edit', { path: op.path, old_string: op.old, new_string: op.new }, roots[op.ws], options(op)))) };
      case 'patch':
        return { text: tokenize(String(await executePatchTool('apply_patch', { base_path: roots[op.ws], patch: op.patch }, roots[op.ws], options(op)))) };
      case 'gitTool': {
        const reply = await executeTool('git', { command: op.command }, roots[op.ws], op.session, {}, options(op));
        return { text: tokenize(String(typeof reply === 'string' ? reply : JSON.stringify(reply))) };
      }
      case 'sessionReview': {
        const reply = await snapshot.getSessionReviewDiff(roots[op.ws], op.session);
        return { answer: tokenize(JSON.parse(JSON.stringify(reply))) };
      }
      case 'revert': {
        const outcome = await (op.file ? snapshot.revertTurnReviewFile(roots[op.ws], op.session, op.file, op.checkpoint) : snapshot.revertTurnReview(roots[op.ws], op.session, op.checkpoint)).then(
          () => true,
          () => false
        );
        return { ok: outcome };
      }
      case 'changes': {
        const reply = await snapshot.getTurnChanges(op.session, { checkpointId: op.checkpoint });
        revisions.set(op.checkpoint, reply.revision);
        return {};
      }
      case 'undo':
      case 'redo': {
        const step = op.op === 'undo' ? snapshot.revertTurnChanges : snapshot.reapplyTurnChanges;
        const outcome = await step(op.session, op.checkpoint, op.file ?? null, revisions.get(op.checkpoint)).then(
          (reply) => {
            revisions.set(op.checkpoint, reply.revision);
            return true;
          },
          () => false
        );
        return { ok: outcome };
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  };
  for (const [index, op] of scenario.ops.entries()) {
    deliveries = 0;
    const result = await run(op);
    await null;
    // Each delivery is one notification; every client rereads after it, and a reread may raise the next delivery.
    const seen = [];
    let handled = 0;
    while (handled < deliveries) {
      handled += 1;
      const rereads = [];
      for (const client of [...clients.values()].sort((a, b) => a.session.localeCompare(b.session))) {
        rereads.push({ session: client.session, answer: tokenize(JSON.parse(JSON.stringify(await reread(client)))) });
        await null;
      }
      seen.push({ notification: { event: 'turn-review-changed', payload: null }, rereads });
    }
    results.push({ op: index, ...result, deliveries: seen });
  }
  worktrees._resetTurnWorktreeSnapshotsForTest();
  return { name: scenario.name, platform: process.platform, ops: scenario.ops, results };
}

const gitTwo = [
  { op: 'git', ws: 'w1' },
  { op: 'file', ws: 'w1', path: 'a.txt', content: T(lines('one', 'two', 'three')) },
  { op: 'file', ws: 'w1', path: 'sub/inner.txt', content: T('inner\n') },
  { op: 'git', ws: 'w2' },
  { op: 'file', ws: 'w2', path: 'b.txt', content: T(lines('bee', 'hive')) },
  { op: 'file', ws: 'ng', path: 'p.txt', content: T(lines('plain')) },
];
const sessions = [
  { op: 'client', session: 's1', ws: 'w1' },
  { op: 'client', session: 's2', ws: 'w1' },
  { op: 'client', session: 's3', ws: 'w2' },
  { op: 'client', session: 's4', ws: 'ng' },
  { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp1' },
  { op: 'begin', ws: 'w1', session: 's2', checkpoint: 'cp2' },
  { op: 'begin', ws: 'w2', session: 's3', checkpoint: 'cp3' },
  { op: 'begin', ws: 'ng', session: 's4', checkpoint: 'cp4' },
];
const patchOf = (...sections) => `*** Begin Patch\n${sections.join('')}*** End Patch\n`;
const scenarios = [
  {
    name: 'command tool, edit and apply_patch calls with two sessions on one worktree, one on another and one in a folder without Git',
    ops: [
      // A client with no turn is told too.
      { op: 'client', session: 's0', ws: 'w1' },
      { op: 'gitTool', ws: 'w1', session: 's0', command: 'status' },
      ...gitTwo,
      ...sessions,
      { op: 'gitTool', ws: 'w1', session: 's1', command: 'status' },
      { op: 'gitTool', ws: 'w2', session: 's3', command: 'status' },
      { op: 'gitTool', ws: 'ng', session: 's4', command: 'status' },
      { op: 'edit', ws: 'w1', session: 's1', path: 'a.txt', old: 'two', new: '2' },
      { op: 'patch', ws: 'w1', session: 's2', patch: patchOf('*** Update File: a.txt\n@@\n-one\n+ONE\n') },
      { op: 'patch', ws: 'w1', session: 's1', patch: patchOf('*** Update File: a.txt\n@@\n-ONE\n+one\n', '*** Update File: sub/inner.txt\n@@\n-inner\n+INNER\n', '*** Add File: n.txt\n+new\n') },
      { op: 'patch', ws: 'w2', session: 's3', patch: patchOf('*** Delete File: b.txt\n') },
      { op: 'patch', ws: 'w1', session: 's1', patch: patchOf('*** Update File: n.txt\n*** Move to: moved.txt\n@@\n-new\n+newer\n') },
      { op: 'patch', ws: 'w1', session: 's1', patch: patchOf('*** Update File: a.txt\n@@\n-absent\n+x\n') },
      { op: 'external', ws: 'w1', path: 'a.txt', content: T(lines('one', '2', 'four')) },
      { op: 'gitTool', ws: 'w1', session: 's1', command: 'status' },
      { op: 'sessionReview', ws: 'w1', session: 's1' },
      { op: 'external', ws: 'w2', path: 'c.txt', content: T('c\n') },
      { op: 'complete', session: 's3' },
      { op: 'complete', session: 's1' },
      { op: 'external', ws: 'w1', path: 'a.txt', content: T(lines('one', '2', 'five')) },
      { op: 'complete', session: 's2' },
      { op: 'complete', session: 's4' },
      { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp5' },
      { op: 'complete', session: 's1' },
    ],
  },
  {
    name: 'Undo of a running turn and of a sealed one',
    ops: [
      { op: 'git', ws: 'w1' },
      { op: 'file', ws: 'w1', path: 'a.txt', content: T(lines('x', 'y')) },
      { op: 'client', session: 's1', ws: 'w1' },
      { op: 'client', session: 's2', ws: 'w1' },
      { op: 'begin', ws: 'w1', session: 's1', checkpoint: 'cp1' },
      { op: 'begin', ws: 'w1', session: 's2', checkpoint: 'cp2' },
      { op: 'edit', ws: 'w1', session: 's1', path: 'a.txt', old: 'y', new: 'Y' },
      { op: 'patch', ws: 'w1', session: 's1', patch: patchOf('*** Add File: n.txt\n+new\n') },
      { op: 'revert', ws: 'w1', session: 's1', file: 'a.txt', checkpoint: 'cp1' },
      { op: 'revert', ws: 'w1', session: 's1', checkpoint: 'cp1' },
      { op: 'edit', ws: 'w1', session: 's1', path: 'a.txt', old: 'x', new: 'Z' },
      { op: 'complete', session: 's1' },
      { op: 'changes', session: 's1', checkpoint: 'cp1' },
      { op: 'undo', session: 's1', checkpoint: 'cp1' },
      { op: 'changes', session: 's1', checkpoint: 'cp1' },
      { op: 'redo', session: 's1', checkpoint: 'cp1' },
    ],
  },
];

const recorded = [];
for (const scenario of scenarios) recorded.push(await runScenario(scenario));

const finalOut = join(FIXTURES_ROOT, 'turn-review-signal');
const out = stageSet(finalOut);
writeText(join(out, 'scenarios.json'), `${JSON.stringify(recorded, null, 1)}\n`);
writeSetManifest(out, {
  set: 'turn-review-signal',
  recorder: 'benchmarks/rust-core/recorders/record-turn-review-signal.mjs',
  command: 'node benchmarks/rust-core/recorders/record-turn-review-signal.mjs --tree <tree> --patch-bin <mixdog-patch built from this checkout>',
  extra: { scenarios: recorded.length, patchBinarySha256: sha256(readFileSync(patchBin)) },
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
commitStage(out, finalOut);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${finalOut}`);
