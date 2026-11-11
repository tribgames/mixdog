#!/usr/bin/env node
// Records what a compaction leaves on disk when the session moves around its prune, through Node's own
// `compactSessionMessages` with the prune-after-save fix (the prune runs once the compacted transcript is stored, idle
// only, reading the references the session holds when it deletes; a prune a running turn stopped is pending on disk,
// `.prune-pending` in the session's tool-result directory, and runs once the turn ends or when the session is next
// resumed: `pruneCompactedOffloads`, `pruneOffloadSession`, `resumePendingOffloadPrune`). A stored session holds three
// sidecars an hour old on the recorder's clock: `kept` (the summary names it), `queued` (only a queued message may name
// it) and `stray` (only the request the compaction drops names it). "A turn" is Node's own ask markers
// (`markSessionAskStart`, and `markSessionDone` / `markSessionCancelled` / `markSessionError` for its end): the turn's
// state and its end, no turn rows. Cases:
//   queued-at-listing   a message naming `queued` is queued while the prune lists the session's sidecars;
//   turn-before-save    a turn starts once the compaction is adopted, before its save; the turn then ends, and the
//                       prune it stopped runs with no second compaction (`after-turn-end`);
//   queued-before-save  the message is queued once the compaction is adopted, before its save;
//   dropped             a delete's fence lands before the save: the save resolves dropped;
//   superseded          another writer records after this copy before the save: the save is refused;
//   thrown              the save's fsync fails;
//   auto-clear          the automatic compaction (`requireReduction`, the idle auto-clear's): pruned once saved;
//   cancelled-turn      as turn-before-save, the turn cancelled;
//   failed-turn         as turn-before-save, the turn failed;
//   closed-before-turn-end  the session is closed (no tombstone, as a resume-away or an exit closes it) before the
//                       turn ends, then resumed;
//   process-stopped     the process stops before the turn ends (a child recorder process, which exits), then the
//                       session is resumed;
//   re-referenced       before the turn ends, the stored transcript names `stray` again: the prune keeps it.
// "Adopted, before its save" is the commit's timing line (`recordCompactionTiming`); "while it lists" is the prune's
// `readdir` of the session's tool-result directory. At each observed point the recording holds the session's
// tool-result directory whole (every file in `readdir` order, its text) and the stored transcript whole (the session's
// record read from disk, `resolveSessionRecordSync`).
//
//   node benchmarks/rust-core/recorders/record-offload-prune-order.mjs --tree <b6f10295a with the patch applied> \
//     --patch benchmarks/rust-core/recorders/patches/node-fix-prune-after-save.patch [--only <case>]
//
// Output: native/core/fixtures/offload-prune-order/golden.json (+ MANIFEST.json).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeClock } from './lib/mc-record.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-offload-prune-order.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
if (!identity.patch) throw new Error('record from the tree with the prune-after-save patch (--patch)');

// The recorder's clock: `Date.now()` stands still here for the whole run; every sidecar is an hour older.
const CLOCK_MS = 1_800_000_000_000;
const SIDECAR_MTIME_MS = CLOCK_MS - 3_600_000;
freezeClock(CLOCK_MS);

// `--child process-stopped --data <dir>`: the process the case stops, on the parent's data dir.
const child = args.get('child');
const dataDir = child ? args.get('data') : mkdtempSync(join(tmpdir(), 'mixdog-offload-prune-order-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const S = 'src/runtime/agent/orchestrator/session';
const manager = await importFrom(tree, `${S}/manager.mjs`);
const { drainSessionStore, evictLiveSession, fenceSessionWrites, loadSession, saveSessionAsync } = await importFrom(tree, `${S}/store.mjs`);
const { settleRecorder } = await importFrom(tree, `${S}/store/session-writers.mjs`);
const { settleSessionSummaryIndex } = await importFrom(tree, `${S}/store/listing.mjs`);
const { closeSessionCatalogDb } = await importFrom(tree, `${S}/catalog-db/index.mjs`);
const { persistToolResultArtifactSync } = await importFrom(tree, `${S}/tool-result-offload.mjs`);
const { settlePendingMessageWrites } = await importFrom(tree, `${S}/manager/pending-messages.mjs`);
const { _settleDeferredPrunesForTest } = await importFrom(tree, `${S}/manager/compaction-runner.mjs`);
const { _sessionLogIoForTest } = await importFrom(tree, `${S}/store/session-log-writer.mjs`);
const { parseSessionLog, resolveSessionRecordSync } = await importFrom(tree, `${S}/store/session-log-reader.mjs`);
const { encodePatch } = await importFrom(tree, `${S}/store/session-log-format.mjs`);
const { loadLegacySession } = await importFrom(tree, `${S}/store/legacy-session.mjs`);
const { _withRegisteredProviderForTestAsync } = await importFrom(tree, 'src/runtime/agent/orchestrator/providers/registry.mjs');

// The prune's listing: `pruneOffloadSession` reads the directory with `readdir` of node:fs/promises.
let onListing = null;
const readdir = fsp.readdir;
fsp.readdir = function (path, ...rest) {
  onListing?.(String(path));
  return readdir.call(this, path, ...rest);
};
syncBuiltinESMExports();

const ROLES = ['kept', 'queued', 'stray'];

const summaryNaming = (path) =>
  ['## Goal', '- keep the work', '## Constraints & Preferences', '- (none)', '## Progress', '### Done', '- older turns summarized', '### In Progress', '- (none)', '### Blocked', '- (none)', '## Key Decisions', '- (none)', '## Next Steps', '- continue', '## Critical Context', `- the kept result is at ${path}`, '## Relevant Files', '- (none)'].join('\n');

async function storedSession(tag) {
  const sessionId = `sess_prune_order_${tag.replaceAll('-', '_')}`;
  const files = {};
  const sidecars = [];
  for (const role of ROLES) {
    const content = `${role} output of ${tag}`;
    const { path } = persistToolResultArtifactSync({ sessionId, toolCallId: `call_${role}`, content });
    utimesSync(path, SIDECAR_MTIME_MS / 1000, SIDECAR_MTIME_MS / 1000);
    files[role] = path;
    sidecars.push({ role, content });
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
  const seeded = { sessionId, files, dir: join(dataDir, 'tool-results', sessionId) };
  return { ...seeded, seed: { sessionId, sidecars, transcript: storedTranscript(seeded) } };
}

/** `storedSession(tag)`'s names, for the session another process stores. */
function seededElsewhere(tag) {
  const sessionId = `sess_prune_order_${tag.replaceAll('-', '_')}`;
  const dir = join(dataDir, 'tool-results', sessionId);
  const files = Object.fromEntries(ROLES.map((role) => [role, join(dir, `${createHash('sha256').update(`${role} output of ${tag}`).digest('hex')}.txt`)]));
  return { sessionId, files, dir };
}

// `compactSessionMessages` with a summary naming `kept`; `adopted` runs once the compaction is adopted (the live session
// then holds the compacted transcript, kept as `compacted`), before it is saved.
async function compact(seeded, { adopted = () => {}, listing = () => {}, options = {} } = {}) {
  const { sessionId, files } = seeded;
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    if (String(chunk).startsWith(`compaction session=${sessionId} `)) {
      seeded.compacted = structuredClone(loadSession(sessionId).messages);
      adopted();
    }
    return write.call(this, chunk, ...rest);
  };
  onListing = (path) => {
    if (path.endsWith(sessionId)) listing();
  };
  const provider = { name: 'anthropic', send: async () => ({ content: summaryNaming(files.kept) }) };
  try {
    return await _withRegisteredProviderForTestAsync('anthropic', provider, () => manager.compactSessionMessages(sessionId, options));
  } finally {
    process.stderr.write = write;
    onListing = null;
  }
}

// The data dir is a temporary one: every string naming it names `<DATA>` instead, and the summary header's hash of the
// dropped messages (which name it) is `<SHA>`.
const masked = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(JSON.stringify(dataDir).slice(1, -1), '<DATA>')
      .replace(/(messages=\d+ sha256=)[0-9a-f]{16}/g, '$1<SHA>')
  );

/** The stored transcript: the session's record as it is on disk. */
function storedTranscript({ sessionId }) {
  const sessions = join(dataDir, 'sessions');
  const outcome = resolveSessionRecordSync({ jsonPath: join(sessions, `${sessionId}.json`), logPath: join(sessions, `${sessionId}.log.jsonl`), loadLegacy: loadLegacySession });
  return outcome.session.messages;
}

/** What is on disk now: the session's tool-result directory (each file in `readdir` order, its text) and its stored transcript. */
function point(at, seeded) {
  const toolResults = readdirSync(seeded.dir).map((name) => [name, readFileSync(join(seeded.dir, name), 'utf8')]);
  return { at, toolResults, transcript: storedTranscript(seeded) };
}

// Runs `compact`; a rejection is the case's `error` (its code).
async function settled(run) {
  try {
    const result = await run;
    return { changed: result.changed, error: null };
  } catch (error) {
    return { changed: null, error: error.code ?? String(error) };
  }
}

const queue = (seeded) => manager.enqueuePendingMessage(seeded.sessionId, { content: `look at ${seeded.files.queued}` });
// A turn starts once the compaction is adopted, before its save: the prune is left pending.
const underATurn = (seeded) => settled(compact(seeded, { adopted: () => manager.markSessionAskStart(seeded.sessionId) }));
// The turn ends (`end`), and the prune it stopped has run.
async function turnEnds(seeded, end) {
  end(seeded.sessionId);
  await _settleDeferredPrunesForTest();
  return point('after-turn-end', seeded);
}
// The session is resumed (`resumeSession`, from its stored copy), and the pending prune has run.
async function resumed(seeded) {
  evictLiveSession(seeded.sessionId);
  if (!(await manager.resumeSession(seeded.sessionId))) throw new Error(`${seeded.sessionId} was not resumed`);
  await _settleDeferredPrunesForTest();
  await settleRecorder(seeded.sessionId);
  return point('after-resume', seeded);
}
const ended = (end) => async (seeded) => {
  const outcome = await underATurn(seeded);
  return [outcome, [point('after-commit', seeded), await turnEnds(seeded, end)]];
};
const SCENARIOS = {
  'queued-at-listing': async (seeded) => [await settled(compact(seeded, { listing: () => queue(seeded) })), [point('after-commit', seeded)]],
  'turn-before-save': async (seeded) => {
    const outcome = await settled(compact(seeded, { adopted: () => manager.markSessionAskStart(seeded.sessionId) }));
    const points = [point('after-commit', seeded)];
    manager.markSessionDone(seeded.sessionId);
    await _settleDeferredPrunesForTest();
    points.push(point('after-turn-end', seeded));
    return [outcome, points];
  },
  'queued-before-save': async (seeded) => [await settled(compact(seeded, { adopted: () => queue(seeded) })), [point('after-commit', seeded)]],
  dropped: async (seeded) => [await settled(compact(seeded, { adopted: () => fenceSessionWrites(seeded.sessionId) })), [point('after-commit', seeded)]],
  superseded: async (seeded) => {
    // Another writer's header patch, appended after the log's last record (`session-writers.test.mjs`).
    const appendForeign = () => {
      const logPath = join(dataDir, 'sessions', `${seeded.sessionId}.log.jsonl`);
      const { seq } = parseSessionLog(readFileSync(logPath));
      appendFileSync(logPath, encodePatch(seq + 1, [['status', JSON.stringify('error')]], []));
    };
    return [await settled(compact(seeded, { adopted: appendForeign })), [point('after-commit', seeded)]];
  },
  thrown: async (seeded) => {
    const io = _sessionLogIoForTest();
    const fsync = io.fsync;
    const failOnce = () => {
      io.fsync = (fd, done) => {
        io.fsync = fsync;
        done(Object.assign(new Error('injected fsync failure'), { code: 'EIO' }));
      };
    };
    try {
      return [await settled(compact(seeded, { adopted: failOnce })), [point('after-commit', seeded)]];
    } finally {
      io.fsync = fsync;
    }
  },
  'auto-clear': async (seeded) => [await settled(compact(seeded, { options: { requireReduction: true } })), [point('after-commit', seeded)]],
  'cancelled-turn': ended((id) => manager.markSessionCancelled(id)),
  'failed-turn': ended((id) => manager.markSessionError(id, 'the provider failed')),
  'closed-before-turn-end': async (seeded) => {
    const outcome = await underATurn(seeded);
    const points = [point('after-commit', seeded)];
    if (!(await manager.closeSession(seeded.sessionId, 'manual', { tombstone: false }))) throw new Error('not closed');
    await _settleDeferredPrunesForTest();
    points.push(point('after-close', seeded), await resumed(seeded));
    return [outcome, points];
  },
  'process-stopped': async (seeded) => {
    // The child recorder seeds this case's session on this data dir, compacts it under a turn and exits.
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', args.get('tree'), '--patch', args.get('patch'), '--child', 'process-stopped', '--data', dataDir], {
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    });
    if (run.status !== 0) throw new Error(`the stopped process failed: ${run.error ?? run.stderr}`);
    const stopped = JSON.parse(run.stdout.trim().split('\n').at(-1));
    seeded.seed = stopped.seed;
    seeded.compacted = stopped.compacted;
    return [stopped.outcome, [point('after-stop', seeded), await resumed(seeded)]];
  },
  're-referenced': async (seeded) => {
    const outcome = await underATurn(seeded);
    const points = [point('after-commit', seeded)];
    // The turn names `stray` again; the session's transcript is stored before the turn ends.
    const session = loadSession(seeded.sessionId);
    session.messages.push({ role: 'user', content: `look again at ${seeded.files.stray}` });
    await saveSessionAsync(session, { expectedGeneration: session.generation });
    points.push(point('after-reference', seeded), await turnEnds(seeded, (id) => manager.markSessionDone(id)));
    return [outcome, points];
  },
};

if (child === 'process-stopped') {
  const seeded = await storedSession(child);
  const outcome = await underATurn(seeded);
  console.log(JSON.stringify({ seed: seeded.seed, compacted: seeded.compacted, outcome }));
  process.exit(0);
}

const only = args.get('only');
if (only && !SCENARIOS[only]) throw new Error(`no case ${only}`);
const cases = [];
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  // The stopped process seeds its own session (`--child`).
  const seeded = name === 'process-stopped' ? seededElsewhere(name) : await storedSession(name);
  const [outcome, points] = await scenario(seeded);
  cases.push(masked({ name, ...outcome, seed: seeded.seed, compacted: seeded.compacted, points }));
}

await settlePendingMessageWrites({ throwOnTimeout: true });
drainSessionStore();
// A resume indexes the session in the catalog: its database is closed before the data dir is removed.
await settleSessionSummaryIndex();
await closeSessionCatalogDb();
rmSync(dataDir, { recursive: true, force: true });
if (only) {
  console.log(JSON.stringify(cases));
  process.exit(0);
}
const finalDir = join(FIXTURES_ROOT, 'offload-prune-order');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's compaction offload prune around a queued message, a turn and each save outcome, at ${NODE_COMMIT} with the prune-after-save fix`, clockMs: CLOCK_MS, sidecarMtimeMs: SIDECAR_MTIME_MS, cases });
writeSetManifest(stage, {
  set: 'offload-prune-order',
  recorder,
  command: `node ${recorder} --tree <export of ${NODE_COMMIT} with the patch> --patch benchmarks/rust-core/recorders/patches/node-fix-prune-after-save.patch`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    tests: ['src/runtime/agent/orchestrator/session/manager/compaction-prune-after-save.test.mjs (added by the patch)', 'src/runtime/agent/orchestrator/session/manager/compaction-runner.mjs (pruneCompactedOffloads)', 'src/runtime/agent/orchestrator/session/tool-result-offload.mjs (pruneOffloadSession)'],
    clock: `Date.now() stands still at ${CLOCK_MS} for the whole run (lib/mc-record.mjs freezeClock); every sidecar's mtime is ${SIDECAR_MTIME_MS} (an hour older): the prune's ten-minute age gate reads both`,
    normalised: {
      dataDir: 'the data dir is a temporary one: every string naming it names <DATA>',
      summaryHash: "the summary header's `sha256=` hashes the dropped messages, which name the temporary data dir: it is <SHA>",
    },
    exclusions: {
      sessionFiles: "the session store's own files (sessions/<id>.json, <id>.log.jsonl) are Node's format; the core's store writes its own record log, so their names and bytes are not compared: the stored transcript is, whole, as each store reads it back",
      summary: 'the summary is a scripted provider answer naming the kept sidecar; the compaction itself is recorded elsewhere (compaction-commit)',
    },
  },
});
commitStage(stage, finalDir);
console.log(JSON.stringify(cases.map(({ name, changed, error, points }) => ({ name, changed, error, points: points.map(({ at, toolResults }) => [at, toolResults.map(([n]) => n.slice(0, 8))]) }))));
