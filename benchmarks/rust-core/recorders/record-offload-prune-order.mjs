#!/usr/bin/env node
// Records which tool-result sidecars a manual compaction leaves on disk when the session moves around its prune,
// through Node's own `compactSessionMessages` with the prune-after-save fix (the prune runs once the compacted
// transcript is saved, idle only: `pruneCompactedOffloads`, `pruneOffloadSession`). A stored session holds three
// sidecars an hour old: `kept` (the summary names it), `queued` (only a queued message may name it) and `stray` (only
// the request the compaction drops names it). Cases:
//   queued-at-listing   a message naming `queued` is queued while the prune lists the session's sidecars;
//   turn-before-save    a turn starts once the compaction is adopted, before its save; the turn then ends and a second
//                       compaction of the idle session prunes (`afterNext`);
//   queued-before-save  the message is queued once the compaction is adopted, before its save.
// "Adopted, before its save" is the commit's timing line (`recordCompactionTiming`); "while it lists" is the prune's
// `readdir` of the session's tool-result directory.
//
//   node benchmarks/rust-core/recorders/record-offload-prune-order.mjs --tree <b6f10295a with the patch applied> \
//     --patch benchmarks/rust-core/recorders/patches/node-fix-prune-after-save.patch
//
// Output: native/core/fixtures/offload-prune-order/golden.json (+ MANIFEST.json).
import fsp from 'node:fs/promises';
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-offload-prune-order.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
if (!identity.patch) throw new Error('record from the tree with the prune-after-save patch (--patch)');

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-offload-prune-order-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const S = 'src/runtime/agent/orchestrator/session';
const manager = await importFrom(tree, `${S}/manager.mjs`);
const { drainSessionStore, saveSessionAsync } = await importFrom(tree, `${S}/store.mjs`);
const { persistToolResultArtifactSync } = await importFrom(tree, `${S}/tool-result-offload.mjs`);
const { settlePendingMessageWrites } = await importFrom(tree, `${S}/manager/pending-messages.mjs`);
const { _withRegisteredProviderForTestAsync } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');

// The prune's listing: `pruneOffloadSession` reads the directory with `readdir` of node:fs/promises.
let onListing = null;
const readdir = fsp.readdir;
fsp.readdir = function (path, ...rest) {
  onListing?.(String(path));
  return readdir.call(this, path, ...rest);
};
syncBuiltinESMExports();

const HOUR_AGO = new Date(Date.now() - 3_600_000);
const ROLES = ['kept', 'queued', 'stray'];

const summaryNaming = (path) =>
  ['## Goal', '- keep the work', '## Constraints & Preferences', '- (none)', '## Progress', '### Done', '- older turns summarized', '### In Progress', '- (none)', '### Blocked', '- (none)', '## Key Decisions', '- (none)', '## Next Steps', '- continue', '## Critical Context', `- the kept result is at ${path}`, '## Relevant Files', '- (none)'].join('\n');

async function storedSession(tag) {
  const sessionId = `sess_prune_order_${tag.replaceAll('-', '_')}`;
  const files = {};
  for (const role of ROLES) {
    const { path } = persistToolResultArtifactSync({ sessionId, toolCallId: `call_${role}`, content: `${role} output of ${tag}` });
    utimesSync(path, HOUR_AGO, HOUR_AGO);
    files[role] = path;
  }
  const messages = [
    { role: 'system', content: 'system rules stay exact' },
    { role: 'user', content: `the first result is at ${files.stray}` },
    { role: 'assistant', content: 'noted' },
  ];
  for (let turn = 0; turn < 30; turn += 1) {
    messages.push({ role: 'user', content: `request ${turn} ${'context '.repeat(400)}` }, { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` });
  }
  await saveSessionAsync({ id: sessionId, provider: 'anthropic', model: 'fake-model', owner: 'agent', contextWindow: 100_000, compactBoundaryTokens: 100_000, messages, tools: [], generation: 0, closed: false, compaction: { conversationThresholdTokens: 1 } });
  return { sessionId, files, dir: join(dataDir, 'tool-results', sessionId) };
}

async function compact({ sessionId, files }, { adopted = () => {}, listing = () => {} } = {}) {
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    if (String(chunk).startsWith(`compaction session=${sessionId} `)) adopted();
    return write.call(this, chunk, ...rest);
  };
  onListing = (path) => {
    if (path.endsWith(sessionId)) listing();
  };
  const provider = { name: 'anthropic', send: async () => ({ content: summaryNaming(files.kept) }) };
  try {
    return await _withRegisteredProviderForTestAsync('anthropic', provider, () => manager.compactSessionMessages(sessionId));
  } finally {
    process.stderr.write = write;
    onListing = null;
  }
}

// The session's tool-result directory, each file by its role.
function left({ files, dir }) {
  const role = Object.fromEntries(Object.entries(files).map(([name, path]) => [path.split(/[\\/]/).pop(), name]));
  return readdirSync(dir).map((name) => role[name] ?? name).sort();
}

const queue = (seeded) => manager.enqueuePendingMessage(seeded.sessionId, { content: `look at ${seeded.files.queued}` });
const cases = [];
{
  const seeded = await storedSession('queued-at-listing');
  const result = await compact(seeded, { listing: () => queue(seeded) });
  cases.push({ name: 'queued-at-listing', changed: result.changed, left: left(seeded) });
}
{
  const seeded = await storedSession('turn-before-save');
  const result = await compact(seeded, { adopted: () => manager.markSessionAskStart(seeded.sessionId) });
  const after = left(seeded);
  manager.markSessionDone(seeded.sessionId);
  const next = await compact(seeded);
  cases.push({ name: 'turn-before-save', changed: result.changed, left: after, nextError: next.error ?? null, afterNext: left(seeded) });
}
{
  const seeded = await storedSession('queued-before-save');
  const result = await compact(seeded, { adopted: () => queue(seeded) });
  cases.push({ name: 'queued-before-save', changed: result.changed, left: left(seeded) });
}

await settlePendingMessageWrites({ throwOnTimeout: true });
drainSessionStore();
rmSync(dataDir, { recursive: true, force: true });
const finalDir = join(FIXTURES_ROOT, 'offload-prune-order');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's compaction offload prune around a queued message and a turn, at ${NODE_COMMIT} with the prune-after-save fix`, cases });
writeSetManifest(stage, {
  set: 'offload-prune-order',
  recorder,
  command: `node ${recorder} --tree <export of ${NODE_COMMIT} with the patch> --patch benchmarks/rust-core/recorders/patches/node-fix-prune-after-save.patch`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    tests: ['src/runtime/agent/orchestrator/session/manager/compaction-prune-after-save.test.mjs (added by the patch)', 'src/runtime/agent/orchestrator/session/manager/compaction-runner.mjs (pruneCompactedOffloads)', 'src/runtime/agent/orchestrator/session/tool-result-offload.mjs (pruneOffloadSession)'],
    exclusions: {
      paths: 'a sidecar is recorded by its role (kept, queued, stray), not by its path: the names are content hashes of the recorder\'s texts and the data dir is a temporary one',
      summary: 'the summary is a scripted provider answer naming the kept sidecar; the compaction itself is recorded elsewhere',
    },
  },
});
commitStage(stage, finalDir);
console.log(JSON.stringify(cases));
