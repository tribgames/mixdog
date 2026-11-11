#!/usr/bin/env node
// Golden twin of the lifecycle barriers and the generation fence of the session store:
// `bumpSessionGenerationAttempt` (the detach, `store/lifecycle-barriers.mjs:269-285`), `markSessionClosedAttempt`
// (the tombstone, `:209-256`) and the save fence `_dropsAgainst` (`store.mjs:149-153`), over the real
// `createSession` / `saveSessionAsync` of the session store.
//
// `barriers`: a session's whole stored record before and after each barrier of a sequence. `fence`: for a record at a recorded
// generation (open after a detach, or closed), a late copy that names an expected generation is saved: the whole stored record,
// the whole late copy, the outcome and the whole record after.
//
// Time is a virtual wall clock: `Date.now()` is 1000 * (step + 1) for the session's creation (step 0) and for its nth barrier
// (step n); every timestamp the barriers write is recorded as that number. The barriers of the fence land in a second process
// (its own pid, Date.now() fixed at 1700000000000 by lib/determinism-preload-other-process.mjs), so what it writes is recorded
// whole too.
//
//   node benchmarks/rust-core/recorders/record-session-lifecycle.mjs --tree <dir with node_modules>
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { exact } from './lib/exact.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { markTmp } from './lib/tmp-mark.mjs';
import { DETERMINISM, clock, installDeterminism } from './lib/session-wire-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OTHER_PRELOAD = pathToFileURL(join(HERE, 'lib', 'determinism-preload-other-process.mjs')).href;
const CHILD_DEADLINE_MS = 120_000;
const STORED_MARK = 'STORED-RECORD ';

const cli = parseArgs();
const tree = resolveTree(cli);
// A child process lands one barrier in the parent's data dir and exits: the record then reaches the parent as it would
// reach another process, with no live recorder of this process holding it (which would drop every late copy outright).
const child = cli.get('child');
let stage;
let outDir;
let work = null;
let determinism = null;
if (child) {
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
} else {
  determinism = installDeterminism();
  outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'session-lifecycle');
  stage = stageSet(outDir);
  // A fixed dir (under this machine's temp dir): the system prompt the session stores names its scratch path.
  work = join(tmpdir(), 'rec-session-lifecycle');
  rmSync(work, { recursive: true, force: true });
  const data = join(work, 'data');
  mkdirSync(data, { recursive: true });
  process.env.MIXDOG_DATA_DIR = data;
  process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
}
const dir = 'src/runtime/agent/orchestrator';
const { createSession } = await importFrom(tree, `${dir}/session/manager/session-lifecycle.mjs`);
const store = await importFrom(tree, `${dir}/session/store.mjs`);
const { _withRegisteredProviderForTestAsync } = await importFrom(tree, `${dir}/providers/registry.mjs`);
if (child) {
  const [op, reason] = child.split(':');
  const id = cli.get('id');
  // The record as a process that holds nothing of the session reads it from the store: what the save left durable.
  if (op === 'read') process.stdout.write(`${STORED_MARK}${JSON.stringify(exact(store.loadSession(id)))}\n`);
  else if (op === 'detach') await store.bumpSessionGenerationAttempt(id, reason, { outcome: {} });
  else await store.markSessionClosedAttempt(id, reason, { outcome: {} });
  process.exit(0);
}
const OTHER_PROCESS = ['--import', OTHER_PRELOAD, process.argv[1], '--tree', tree];

const providerName = 'session-lifecycle-twin';
const provider = { name: providerName, contextWindow: 128000, async send() { throw new Error('no turn runs'); } };
// The session's cwd is the fixed work dir: the stored system prompt lists the cwd's entries and its git state, so a fixed dir that is not a repository makes both the same on every run (the default is the checkout the recorder was started in).
const options = { cwd: work, provider: providerName, model: 'fake-model', owner: 'cli', agent: 'lead', lane: 'cli', sourceType: 'lead', sourceName: 'main', skipSkills: true };

let step = 0;
const tick = (n) => { step = n; clock.now = 1000 * (n + 1); };
const fresh = async () => {
  determinism.reset();
  tick(0);
  const session = createSession(options);
  await store.saveSessionAsync(session, {});
  return session.id;
};

const barriers = [];
const BARRIER_CASES = [
  { name: 'detach', steps: [{ op: 'detach', reason: 'no live session clients' }] },
  { name: 'detach-twice', steps: [{ op: 'detach', reason: 'no live session clients' }, { op: 'detach', reason: 'SIGTERM' }] },
  { name: 'owner-close', steps: [{ op: 'detach', reason: 'cli-agent-close', ownerClose: true }] },
  { name: 'close', steps: [{ op: 'close', reason: 'idle-sweep' }] },
  { name: 'detach-then-close', steps: [{ op: 'detach', reason: 'cli-exit' }, { op: 'close', reason: 'manual' }] },
  { name: 're-close', steps: [{ op: 'close', reason: 'manual' }, { op: 'close', reason: 'desktop-session-delete' }] },
  { name: 'cancel-close', steps: [{ op: 'close', reason: 'agent-task-cancel' }] },
];
const fence = [];
await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
  for (const c of BARRIER_CASES) {
    const id = await fresh();
    const record = [];
    let n = 0;
    for (const s of c.steps) {
      const before = exact(store.loadSession(id));
      n += 1;
      tick(n);
      const generation = s.op === 'detach'
        ? await store.bumpSessionGenerationAttempt(id, s.reason, { outcome: {}, ownerClose: s.ownerClose === true })
        : await store.markSessionClosedAttempt(id, s.reason, { outcome: {} });
      record.push({ ...s, clock: clock.now, before, generation: exact(generation), after: exact(store.loadSession(id)) });
    }
    barriers.push({ name: c.name, steps: record });
  }

  // The fence: a record in each lifecycle state, a late copy per expected generation.
  const STATES = [
    { name: 'open-fresh', ops: [] },
    { name: 'open-detached-once', ops: [{ op: 'detach', reason: 'cli-exit' }] },
    { name: 'open-detached-twice', ops: [{ op: 'detach', reason: 'cli-exit' }, { op: 'detach', reason: 'cli-exit' }] },
    { name: 'closed', ops: [{ op: 'close', reason: 'manual' }] },
  ];
  for (const state of STATES) {
    for (const expected of [null, 0, 1, 2]) {
      const id = await fresh();
      const late = structuredClone(store.loadSession(id));
      store.drainSessionStore();
      // Each barrier lands in another process; this one then holds nothing of the session (its writer lock is free).
      for (const op of state.ops) {
        execFileSync(process.execPath, [...OTHER_PROCESS, '--child', `${op.op}:${op.reason}`, '--id', id], { stdio: 'inherit', timeout: CHILD_DEADLINE_MS, killSignal: 'SIGKILL' });
      }
      const recorded = exact(store.loadSession(id));
      late.messages.push({ role: 'user', content: `late write ${state.name} ${expected}` });
      const lateFull = exact(late);
      const outcome = await store.saveSessionAsync(late, expected === null ? {} : { expectedGeneration: expected });
      fence.push({
        state: state.name,
        recorded,
        expected,
        late: lateFull,
        outcome: exact(outcome),
        dropped: outcome !== 'saved',
        storedAfter: exact(store.loadSession(id)),
        // storedAfter is this process's loadSession, its live snapshot: a dropped copy is admitted to it (store.mjs _admit
        // setLiveSession) before _write drops it. durableAfter is the record another process reads from the store.
        durableAfter: (() => {
          const out = execFileSync(process.execPath, [...OTHER_PROCESS, '--child', 'read:', '--id', id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: CHILD_DEADLINE_MS, killSignal: 'SIGKILL' });
          const line = out.split('\n').find((l) => l.startsWith(STORED_MARK));
          if (!line) throw new Error(`the reading process printed no record for ${id}: ${out}`);
          return JSON.parse(line.slice(STORED_MARK.length));
        })(),
      });
    }
  }
});

const PRELOADS = ['benchmarks/rust-core/recorders/lib/determinism-preload.mjs', 'benchmarks/rust-core/recorders/lib/determinism-preload-other-process.mjs'];
// Declared: the temp root in the stored system prompt (a message's content, bpNEnvironmentContext) -> <TMP>.
const tmpPath = (path) => path.at(-1) === 'content' && path.at(-3) === 'messages' || /^bp\d+EnvironmentContext$/.test(path.at(-1)) || path.at(-1) === 'cwd';
writeJson(join(stage, 'twin.json'), markTmp({ clock: { rule: 'Date.now() = 1000 * (step + 1): the session\'s creation is step 0, its nth barrier step n', fenceChildren: 1_700_000_000_000 }, barriers, fence }, tmpPath));
writeSetManifest(stage, {
  set: 'session-lifecycle',
  recorder: 'benchmarks/rust-core/recorders/record-session-lifecycle.mjs',
  command: `node benchmarks/rust-core/recorders/record-session-lifecycle.mjs --tree <tree>${cli.get('commit') ? ` --commit ${cli.get('commit')}` : ''}`,
  identityTree: cli.get('identity-tree') ?? tree,
  // `--commit <full id>`: the tree must be exactly that commit's export; the manifest then names it.
  identity: cli.get('commit') ? nodeTreeIdentity(cli, cli.get('identity-tree') ?? tree, cli.get('commit')) : null,
  extra: {
    ...recorderProvenance(import.meta.url, PRELOADS),
    testFile: 'src/runtime/agent/orchestrator/session/store/lifecycle-barriers.mjs (no test file: a golden twin of the barriers)',
    entry: 'Ran the real session store (store.mjs loadSession, saveSessionAsync, drainSessionStore; store/lifecycle-barriers.mjs bumpSessionGenerationAttempt and markSessionClosedAttempt) and manager/session-lifecycle.mjs createSession on a temp MIXDOG_DATA_DIR. The fence barriers run in a second Node process (this recorder with --child, node --import lib/determinism-preload-other-process.mjs, 120 s deadline). Did not run a turn (the provider throws if asked).',
    replay: 'mixdog-core-session session/lifecycle_replay.rs, one test per recorded case, over the real thread store in a scratch data dir: each recorded record is a thread created under its id with the record as its header (create_with_id). Barriers: the directory\'s own detach and close (close.rs SessionClose::detach(id, reason, ownerClose) for detach / owner-close, SessionClose::close(id, reason) for close, re-close and agent-task-cancel), the calls thread/delete, thread/switchContext, the exit and the idle sweep make, at the recorded clock; the whole stored record (thread header) is compared before and after each step, with the generation it resolved. Fence: the late save is close.rs patch_header_fenced over SessionThreads (thread/header/read + the guarded header write), the write a save issued with an expected generation makes (agent_send_world.rs patch); its change is the late record\'s fields that differ from the stored one; the outcome (saved / dropped), the whole durableAfter record and, for a save that landed, the whole storedAfter record are compared.',
    values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
    exclusions: [
      'no value is normalised; timestamps are the virtual clock (see twin.json clock) in the parent and 1700000000000 in the child process',
      'this machine\'s roots (the OS temp dir -> <TMP>, the checkout process.cwd() -> <CWD>, the user home -> <HOME>; every spelling found, text after the root and its separators kept: lib/tmp-mark.mjs), in string values at barriers/fence ... messages[*].content and bpNEnvironmentContext (the stored system prompt) and every "cwd" field of a stored session. The sessions are created with cwd = the work dir <TMP>\\rec-session-lifecycle (an explicit input: createSession options.cwd), so the prompt\'s cwd entries and git state do not depend on the checkout. The rest of the prompt (scratch dir name under rec-session-lifecycle, environment facts) is the recording machine\'s and stays as written',
      'fence storedAfter is the saving process\'s loadSession, its live snapshot: Node admits a copy to it (store.mjs _admit: setLiveSession) before _write drops it against the generation (_dropsAgainst), so after a dropped save it holds the dropped copy while the store keeps the recorded record (durableAfter, read by another process). The core has no in-process snapshot apart from the store: storedAfter is compared only where the save landed; durableAfter is compared in every case',
      'the place of the messages field: a session Node made in this process keeps it where createSession put it, while Node\'s loader assembles a stored session as its header fields followed by its messages (the transcript is the log beside the header), so a record read back after a barrier or from another process has it last. The replay\'s thread holds the recorded messages as one header field; each comparison places that field where the recorded record has it, every field, value and the order of all other fields compared whole',
      ...DETERMINISM,
    ],
  },
});
commitStage(stage, outDir);
console.log(`session-lifecycle: ${barriers.length} barrier cases, ${fence.length} fence cases -> ${outDir}`);
// The session writers still hold their lock files; the sandbox is removed with its lock files released at exit.
if (work) process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a writer still holds a lock file: left for the OS temp cleanup */ } });
process.exit(0);
