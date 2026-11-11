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
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { exact } from './lib/exact.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { markTmp } from './lib/tmp-mark.mjs';
import { DETERMINISM, clock, installDeterminism } from './lib/session-wire-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OTHER_PRELOAD = pathToFileURL(join(HERE, 'lib', 'determinism-preload-other-process.mjs')).href;
const CHILD_DEADLINE_MS = 120_000;

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
  if (op === 'detach') await store.bumpSessionGenerationAttempt(id, reason, { outcome: {} });
  else await store.markSessionClosedAttempt(id, reason, { outcome: {} });
  process.exit(0);
}
const OTHER_PROCESS = ['--import', OTHER_PRELOAD, process.argv[1], '--tree', tree];

const providerName = 'session-lifecycle-twin';
const provider = { name: providerName, contextWindow: 128000, async send() { throw new Error('no turn runs'); } };
const options = { provider: providerName, model: 'fake-model', owner: 'cli', agent: 'lead', lane: 'cli', sourceType: 'lead', sourceName: 'main', skipSkills: true };

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
      });
    }
  }
});

const PRELOADS = ['benchmarks/rust-core/recorders/lib/determinism-preload.mjs', 'benchmarks/rust-core/recorders/lib/determinism-preload-other-process.mjs'];
// Declared: the temp root in the stored system prompt (a message's content, bpNEnvironmentContext) -> <TMP>.
const tmpPath = (path) => path.at(-1) === 'content' && path.at(-3) === 'messages' || /^bp\d+EnvironmentContext$/.test(path.at(-1));
writeJson(join(stage, 'twin.json'), markTmp({ clock: { rule: 'Date.now() = 1000 * (step + 1): the session\'s creation is step 0, its nth barrier step n', fenceChildren: 1_700_000_000_000 }, barriers, fence }, tmpPath));
writeSetManifest(stage, {
  set: 'session-lifecycle',
  recorder: 'benchmarks/rust-core/recorders/record-session-lifecycle.mjs',
  command: 'node benchmarks/rust-core/recorders/record-session-lifecycle.mjs --tree <tree>',
  identityTree: cli.get('identity-tree') ?? tree,
  extra: {
    ...recorderProvenance(import.meta.url, PRELOADS),
    testFile: 'src/runtime/agent/orchestrator/session/store/lifecycle-barriers.mjs (no test file: a golden twin of the barriers)',
    entry: 'Ran the real session store (store.mjs loadSession, saveSessionAsync, drainSessionStore; store/lifecycle-barriers.mjs bumpSessionGenerationAttempt and markSessionClosedAttempt) and manager/session-lifecycle.mjs createSession on a temp MIXDOG_DATA_DIR. The fence barriers run in a second Node process (this recorder with --child, node --import lib/determinism-preload-other-process.mjs, 120 s deadline). Did not run a turn (the provider throws if asked).',
    replay: 'A replay drives the Rust core through the public app-server protocol (native/core/crates/mixdog-app-protocol methods.rs) and compares WHOLE stored records (thread/read of the thread, before and after each step; every recorded before/after/recorded/late/storedAfter is a whole Node session record): detach (cli-exit, no live session clients) <- thread/unsubscribe of the last subscriber; close with tombstone (manual, desktop-session-delete) <- thread/delete; agent-task-cancel <- thread/agentControl; a late save carrying an expected generation <- turn/start and thread/name/set issued with a stale generation, whose refusal/acceptance is the recorded outcome. The daemon-internal reasons (idle-sweep, SIGTERM, cli-agent-close, owner close) have no protocol method: Rust-side work, to be driven through the thread directory\'s own close/detach calls. Node-only fields (updatedAt, ownerClosedAt, cancelledAt) are the virtual clock 1000 * (step + 1). The existing close.rs unit tests read the old nine-key before/after/recorded projections of this file: they must read the whole records now.',
    values: 'exact (benchmarks/rust-core/recorders/lib/exact.mjs)',
    exclusions: [
      'no value is normalised; timestamps are the virtual clock (see twin.json clock) in the parent and 1700000000000 in the child process',
      'this machine\'s roots (the OS temp dir -> <TMP>, the checkout process.cwd() -> <CWD>, the user home -> <HOME>; every spelling found, text after the root and its separators kept: lib/tmp-mark.mjs), in string values at barriers/fence ... messages[*].content and bpNEnvironmentContext only (the stored system prompt). The rest of the prompt (scratch dir name under rec-session-lifecycle, environment facts) is the recording machine\'s and stays as written',
      ...DETERMINISM,
    ],
  },
});
commitStage(stage, outDir);
console.log(`session-lifecycle: ${barriers.length} barrier cases, ${fence.length} fence cases -> ${outDir}`);
// The session writers still hold their lock files; the sandbox is removed with its lock files released at exit.
if (work) process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* a writer still holds a lock file: left for the OS temp cleanup */ } });
process.exit(0);
