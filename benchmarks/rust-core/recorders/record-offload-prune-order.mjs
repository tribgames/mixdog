#!/usr/bin/env node
// Records what a compaction leaves on disk when the session moves around its prune, through Node's own
// `compactSessionMessages` with the prune-after-save fix (the prune runs once the compacted transcript is stored, idle
// only, reading the references the session holds when it deletes; a prune a running turn stopped runs once the turn
// ends; nothing of a prune is remembered on disk: every resume reconciles the session's tool-result directory with what
// is stored then: `pruneCompactedOffloads`, `pruneOffloadSession`, `reconcileOffloadsOnResume`). A stored session holds
// three sidecars an hour old on the recorder's clock: `kept` (the summary names it), `queued` (only a queued message may
// name it) and `stray` (only the request the compaction drops names it). "A turn" is Node's own ask markers
// (`markSessionAskStart`, and `markSessionDone` for its end: the turn's state and its end, no turn rows), except in
// `cancelled-turn` and `failed-turn`, which run a real turn (`askSession`, the scripted provider's model request).
// Cases:
//   queued-at-listing   a message naming `queued` is queued while the prune lists the session's sidecars;
//   turn-before-save    a turn starts once the compaction is adopted, before its save; the turn then ends, and the
//                       prune it stopped runs with no second compaction (`after-turn-end`);
//   queued-before-save  the message is queued once the compaction is adopted, before its save;
//   dropped             a delete's fence lands before the save: the save resolves dropped;
//   superseded          another writer records after this copy before the save: the save is refused;
//   thrown              the save's fsync fails;
//   auto-clear          the automatic compaction (`requireReduction`, the idle auto-clear's): pruned once saved;
//   cancelled-turn      a real turn is asked once the compaction is adopted, before its save; it claims the session
//                       after the save (`settleTurnBase` waits for it), so the prune runs at the save; its model
//                       request is then cancelled (`abortSessionTurn`, the turn's interrupt);
//   failed-turn         as cancelled-turn, the model request failing;
//   closed-before-turn-end  the session is closed (no tombstone, as a resume-away or an exit closes it) before the
//                       turn ends, then resumed;
//   process-stopped     the process stops before the turn ends (a child recorder process, which exits), then the
//                       session is resumed;
//   re-referenced       before the turn ends, the stored transcript names `stray` again: the prune keeps it;
//   saved-then-stopped  the process stops once the compacted transcript is durable, before the prune (a child recorder
//                       process, which exits in the save's fsync callback); the session is then resumed;
//   unreadable-archive  a session (not compacted) whose transcript names an archive sidecar naming another sidecar, and
//                       a `stray` nothing names: resumed while the archive cannot be read (a directory in its place),
//                       closed, the archive put back, resumed again;
//   nothing-to-prune    a session (not compacted) whose transcript names its old sidecar and whose other sidecar is
//                       young: resumed; each file's mtime is recorded too;
//   clear-fork          a session (not compacted) whose transcript names `named` (a `stray` nothing names) is cleared
//                       as an agent home's fresh start (`archiveAs`: its conversation copied to the fork first),
//                       closed and resumed: the fork keeps `named`;
//   heir-fork           as clear-fork, but a new session inherits the conversation (`inheritToNewSession`), the heir
//                       is cleared with a fork and the source without one: the heir's fork keeps `named`;
//   owner-let-go        the session is resumed and closed (its writer claim let go) while the resume's reconcile
//                       lists its directory: nothing is deleted; it is resumed again.
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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
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
const { createLifecycleApi } = await importFrom(tree, 'src/session-runtime/lifecycle-api.mjs');
// The prune's listing: `pruneOffloadSession` reads the directory with `readdir` of node:fs/promises. `onListing` sees
// it; `holdListing` may return a promise the listing waits for.
let onListing = null;
let holdListing = null;
const readdir = fsp.readdir;
fsp.readdir = function (path, ...rest) {
  onListing?.(String(path));
  const held = holdListing?.(String(path));
  return held ? held.then(() => readdir.call(this, path, ...rest)) : readdir.call(this, path, ...rest);
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
async function compact(seeded, { adopted = () => {}, listing = () => {}, options = {}, turn = null } = {}) {
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
  // `turn` answers every model request after the compaction's own (a real turn's).
  let requests = 0;
  const provider = { name: 'anthropic', send: async (...request) => ((requests += 1) === 1 || !turn ? { content: summaryNaming(files.kept) } : turn(...request)) };
  try {
    return await _withRegisteredProviderForTestAsync('anthropic', provider, () => manager.compactSessionMessages(sessionId, options));
  } finally {
    process.stderr.write = write;
    onListing = null;
  }
}

// The data dir is a temporary one: every string naming it names `<DATA>` instead, the summary header's hash of the
// dropped messages (which name it) is `<SHA>`, a turn completion's `attemptId` (a random UUID) is `<ATTEMPT>` and its
// `verb` (the client's label) is `<VERB>`.
const masked = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(JSON.stringify(dataDir).slice(1, -1), '<DATA>')
      .replace(/(messages=\d+ sha256=)[0-9a-f]{16}/g, '$1<SHA>')
      .replace(/("status":"[a-z]+","attemptId":)"[0-9a-f-]{36}"(,"at":\d+,"verb":)"[A-Za-z]+"/g, '$1"<ATTEMPT>"$2"<VERB>"')
  );

/** The stored transcript: the session's record as it is on disk. */
function storedTranscript({ sessionId }) {
  const sessions = join(dataDir, 'sessions');
  const outcome = resolveSessionRecordSync({ jsonPath: join(sessions, `${sessionId}.json`), logPath: join(sessions, `${sessionId}.log.jsonl`), loadLegacy: loadLegacySession });
  return outcome.session.messages;
}

/** What is on disk now: the session's tool-result directory (each entry in `readdir` order, its text, null for a
 *  directory; with `mtimes`, each file's mtime too) and its stored transcript. */
function point(at, seeded, { mtimes = false } = {}) {
  const toolResults = readdirSync(seeded.dir).map((name) => {
    const path = join(seeded.dir, name);
    const stat = statSync(path);
    const entry = [name, stat.isDirectory() ? null : readFileSync(path, 'utf8')];
    return mtimes ? [...entry, stat.mtimeMs] : entry;
  });
  return { at, toolResults, transcript: storedTranscript(seeded) };
}

/** A stored session, not compacted: `sidecars` (role, content, mtime) and the transcript `messages(files)` names. */
async function plainSession(tag, sidecars, messages) {
  const sessionId = `sess_prune_order_${tag.replaceAll('-', '_')}`;
  const files = {};
  for (const { role, content, mtimeMs } of sidecars) {
    files[role] = persistToolResultArtifactSync({ sessionId, toolCallId: `call_${role}`, content }).path;
    utimesSync(files[role], mtimeMs / 1000, mtimeMs / 1000);
  }
  await saveSessionAsync({ id: sessionId, provider: 'anthropic', model: 'fake-model', owner: 'agent', messages: messages(files), tools: [], generation: 0, closed: false });
  const seeded = { sessionId, files, dir: join(dataDir, 'tool-results', sessionId) };
  return { ...seeded, seed: { sessionId, sidecars, transcript: storedTranscript(seeded) } };
}
const sidecarName = (content) => `${createHash('sha256').update(content).digest('hex')}.txt`;

// A real turn (`askSession`) asked once the compaction is adopted: its model request waits until the turn is observed,
// then fails (`failed`) or is cancelled (`cancelled`, `abortSessionTurn`).
async function realTurn(seeded, how) {
  let requested;
  const inFlight = new Promise((resolve) => (requested = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let ask = null;
  const turn = async () => {
    requested();
    await released;
    if (how === 'failed') throw new Error('the provider failed');
    return { content: 'done' };
  };
  const provider = { name: 'anthropic', send: async () => ({ content: summaryNaming(seeded.files.kept) }) };
  return _withRegisteredProviderForTestAsync('anthropic', provider, async () => {
    const outcome = await settled(compact(seeded, { turn, adopted: () => (ask = manager.askSession(seeded.sessionId, 'do the thing').catch((error) => error)) }));
    provider.send = turn;
    await inFlight;
    // The turn's prompt is saved before its model request; the save lands before the directory is read.
    await settleRecorder(seeded.sessionId);
    const points = [point('after-commit', seeded)];
    if (how === 'cancelled') manager.abortSessionTurn(seeded.sessionId);
    release();
    await ask;
    await _settleDeferredPrunesForTest();
    await settleRecorder(seeded.sessionId);
    points.push(point('after-turn-end', seeded));
    return [outcome, points];
  });
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
  'cancelled-turn': (seeded) => realTurn(seeded, 'cancelled'),
  'failed-turn': (seeded) => realTurn(seeded, 'failed'),
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
    const stopped = stoppedChild('process-stopped');
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
  'saved-then-stopped': async (seeded) => {
    const stopped = stoppedChild('saved-then-stopped');
    seeded.seed = stopped.seed;
    seeded.compacted = stopped.compacted;
    return [stopped.outcome, [point('after-stop', seeded), await resumed(seeded)]];
  },
  'unreadable-archive': async (seeded) => {
    const content = readFileSync(seeded.files.archive, 'utf8');
    rmSync(seeded.files.archive);
    mkdirSync(seeded.files.archive);
    const points = [{ ...(await resumed(seeded)), at: 'after-unreadable-resume' }];
    if (!(await manager.closeSession(seeded.sessionId, 'manual', { tombstone: false }))) throw new Error('not closed');
    rmSync(seeded.files.archive, { recursive: true });
    persistToolResultArtifactSync({ sessionId: seeded.sessionId, toolCallId: 'call_archive', content });
    points.push({ ...(await resumed(seeded)), at: 'after-readable-resume' });
    return [{ changed: null, error: null }, points];
  },
  'clear-fork': async (seeded) => {
    // An agent home's fresh start: the conversation is copied to the archive id (the fork), then cleared.
    const forkId = `${seeded.sessionId}_archive`;
    seeded.seed.forkId = forkId;
    if (!(await manager.clearSessionMessages(seeded.sessionId, { archiveAs: forkId }))) throw new Error('not cleared');
    await settleRecorder(forkId);
    await settleRecorder(seeded.sessionId);
    const points = [point('after-clear', seeded)];
    if (!(await manager.closeSession(seeded.sessionId, 'manual', { tombstone: false }))) throw new Error('not closed');
    points.push(await resumed(seeded));
    return [{ changed: null, error: null }, points];
  },
  'heir-fork': async (seeded) => {
    // A new session inherits the conversation (`inheritToNewSession`); the heir is cleared with a fork (the fork holds
    // the copy), the source without one (`fork: false`).
    const provider = { name: 'anthropic', contextWindow: 128_000, send: async () => ({ content: 'no turn runs' }) };
    const lifecycle = createLifecycleApi({ getSession: () => null, getRoute: () => ({ provider: 'anthropic', model: 'fake-model' }), mgr: manager, invalidateContextStatusCache() {}, saveSession() {} });
    const { sessionId: heirId } = await _withRegisteredProviderForTestAsync('anthropic', provider, () => lifecycle.inheritToNewSession(seeded.sessionId));
    if (!(await manager.clearSessionMessages(heirId))) throw new Error('the heir was not cleared');
    if (!(await manager.clearSessionMessages(seeded.sessionId, { fork: false }))) throw new Error('not cleared');
    await settleRecorder(heirId);
    await settleRecorder(seeded.sessionId);
    const points = [point('after-clear', seeded)];
    if (!(await manager.closeSession(seeded.sessionId, 'manual', { tombstone: false }))) throw new Error('not closed');
    points.push(await resumed(seeded));
    return [{ changed: null, error: null }, points];
  },
  'owner-let-go': async (seeded) => {
    // The resume's reconcile has listed the directory; the session is closed (its writer claim let go) before the
    // reconcile reads on. It is then resumed again.
    let release;
    const listed = new Promise((resolve) => (release = resolve));
    holdListing = (path) => (path.endsWith(seeded.sessionId) ? listed : null);
    try {
      evictLiveSession(seeded.sessionId);
      if (!(await manager.resumeSession(seeded.sessionId))) throw new Error(`${seeded.sessionId} was not resumed`);
      if (!(await manager.closeSession(seeded.sessionId, 'manual', { tombstone: false }))) throw new Error('not closed');
    } finally {
      holdListing = null;
      release();
    }
    await _settleDeferredPrunesForTest();
    await settleRecorder(seeded.sessionId);
    return [{ changed: null, error: null }, [point('after-close', seeded), await resumed(seeded)]];
  },
  'nothing-to-prune': async (seeded) => {
    const before = point('before-resume', seeded, { mtimes: true });
    evictLiveSession(seeded.sessionId);
    if (!(await manager.resumeSession(seeded.sessionId))) throw new Error(`${seeded.sessionId} was not resumed`);
    await _settleDeferredPrunesForTest();
    await settleRecorder(seeded.sessionId);
    return [{ changed: null, error: null }, [before, point('after-resume', seeded, { mtimes: true })]];
  },
};

// The sessions the cases that do not compact seed.
const PLAIN = {
  'unreadable-archive': () =>
    plainSession(
      'unreadable-archive',
      [
        { role: 'archived', content: 'archived output', mtimeMs: SIDECAR_MTIME_MS },
        { role: 'archive', content: `older output is at ${sidecarName('archived output')}`, mtimeMs: SIDECAR_MTIME_MS },
        { role: 'stray', content: 'stray output', mtimeMs: SIDECAR_MTIME_MS },
      ],
      (files) => [
        { role: 'user', content: `the archive is at ${files.archive}` },
        { role: 'assistant', content: 'noted' },
      ]
    ),
  ...Object.fromEntries(
    ['clear-fork', 'heir-fork', 'owner-let-go'].map((tag) => [
      tag,
      () =>
        plainSession(
          tag,
          [
            { role: 'named', content: `named output of ${tag}`, mtimeMs: SIDECAR_MTIME_MS },
            { role: 'stray', content: `stray output of ${tag}`, mtimeMs: SIDECAR_MTIME_MS },
          ],
          (files) => [
            { role: 'user', content: `the result is at ${files.named}` },
            { role: 'assistant', content: 'noted' },
          ]
        ),
    ])
  ),
  'nothing-to-prune': () =>
    plainSession(
      'nothing-to-prune',
      [
        { role: 'named', content: 'named output', mtimeMs: SIDECAR_MTIME_MS },
        { role: 'young', content: 'young output', mtimeMs: CLOCK_MS },
      ],
      (files) => [
        { role: 'user', content: `the result is at ${files.named}` },
        { role: 'assistant', content: 'noted' },
      ]
    ),
};

/** Runs this recorder as the child `name` on this data dir; its last stdout line is the case it reports. */
function stoppedChild(name) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', args.get('tree'), '--patch', args.get('patch'), '--child', name, '--data', dataDir], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(`the stopped process failed: ${run.error ?? run.stderr}`);
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}

if (child === 'process-stopped') {
  const seeded = await storedSession(child);
  const outcome = await underATurn(seeded);
  console.log(JSON.stringify({ seed: seeded.seed, compacted: seeded.compacted, outcome }));
  process.exit(0);
}
if (child === 'saved-then-stopped') {
  // The process exits in the fsync callback of the compaction's save: the compacted transcript is durable and the
  // prune has not run. The compaction never answers: no outcome.
  const seeded = await storedSession(child);
  const io = _sessionLogIoForTest();
  const fsync = io.fsync;
  await compact(seeded, {
    adopted: () => {
      io.fsync = (fd, done) =>
        fsync(fd, (error) => {
          if (error) return done(error);
          console.log(JSON.stringify({ seed: seeded.seed, compacted: seeded.compacted, outcome: { changed: null, error: null } }));
          process.exit(0);
        });
    },
  });
  process.exit(1);
}

const only = args.get('only');
if (only && !SCENARIOS[only]) throw new Error(`no case ${only}`);
const cases = [];
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (only && only !== name) continue;
  // A stopped process seeds its own session (`--child`).
  const seeded = ['process-stopped', 'saved-then-stopped'].includes(name) ? seededElsewhere(name) : PLAIN[name] ? await PLAIN[name]() : await storedSession(name);
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
      attemptId: "a turn completion's `attemptId` (meta.transcript.completion, cancelled-turn and failed-turn) is a random UUID on both sides: it is <ATTEMPT>",
      completionVerb:
        "a turn completion's `verb` is the client's label: Node's runtime has none without a client (`failedTurnCompletion`'s `Thought`), the core's `turn/start` stamps the client's `pickDoneVerb(stats.turns)` (`Mapped` for its first turn); it is <VERB>",
    },
    exclusions: {
      sessionFiles: "the session store's own files (sessions/<id>.json, <id>.log.jsonl) are Node's format; the core's store writes its own record log, so their names and bytes are not compared: the stored transcript is, whole, as each store reads it back",
      summary: 'the summary is a scripted provider answer naming the kept sidecar; the compaction itself is recorded elsewhere (compaction-commit)',
      forks:
        "clear-fork and heir-fork record the cleared session's directory and transcript; the fork's and the heir's transcripts are not compared (the carry into them is recorded elsewhere): what they keep is the sidecar they name, which the cleared session's directory shows",
    },
  },
});
commitStage(stage, finalDir);
console.log(JSON.stringify(cases.map(({ name, changed, error, points }) => ({ name, changed, error, points: points.map(({ at, toolResults }) => [at, toolResults.map(([n]) => n.slice(0, 8))]) }))));
