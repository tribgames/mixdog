#!/usr/bin/env node
// What Node's survivor tracker does with a scripted process table: `createProcessTreeTracker` observations,
// `killShellDescendants` (the signals it sends, the waits between them, the process tables it reads, in order) and
// `waitForShellDescendants` (when it reads and when it settles). The real shell-descendants.mjs and the real
// `killProcessTrees` of child-tree.mjs run on a clean checkout of one commit; only the process table read
// (`readProcessTable`), `process.kill` and the timers are scripted, and the POSIX branch is taken by presenting
// `process.platform` as `linux` before the modules load. Each scenario is recorded with the inputs that drove it, so the
// Rust tracker replays exactly the same script (native/mixdog-spawn/src/tree.rs, `tests`).
//
//   node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-shell-tracker-trace.mjs \
//        --tree <git checkout at --commit, with node_modules> --commit <40-hex>
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import { FIXTURES_ROOT, commitCheckoutIdentity, importFrom, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';
import { mkdirSync, rmSync } from 'node:fs';

const hostPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'linux' });

const args = parseArgs();
const tree = resolveTree(args);
const commit = args.get('commit') ?? (() => { throw new Error('--commit is required'); })();
const identity = commitCheckoutIdentity(tree, commit);

const urlOf = (rel) => pathToFileURL(join(tree, rel)).href;
const CHILD_TREE = urlOf('src/runtime/agent/orchestrator/mcp/child-tree.mjs');
const { processTable } = await importFrom(tree, 'src/runtime/agent/orchestrator/tools/lib/process-table-fixture.mjs');
const real = await import(`${CHILD_TREE}?real`);

let run = null;
let trace = [];
const last = (list, index) => list[Math.min(index, list.length - 1)];
mock.module(CHILD_TREE, {
  namedExports: {
    readProcessTable: async () => {
      trace.push({ op: 'read' });
      const table = last(run.tables, run.reads);
      run.reads += 1;
      if (table.error) throw new Error(table.error);
      return processTable(table);
    },
    killProcessTrees: real.killProcessTrees,
  },
});
const sd = await import(urlOf('src/runtime/agent/orchestrator/tools/lib/shell-descendants.mjs'));

process.kill = (pid, signal) => {
  const group = pid < 0;
  trace.push({ op: 'kill', target: group ? 'group' : 'pid', id: Math.abs(pid), signal });
  if (signal !== 0 || !run.armed) return true;
  const alive = last(group ? run.groupProbes : run.pidProbes, group ? run.groupAsked++ : run.pidAsked++);
  if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  return true;
};

mock.timers.enable({ apis: ['setTimeout'] });
const mockedSetTimeout = globalThis.setTimeout;
let lastScheduled = null;
globalThis.setTimeout = (fn, ms, ...rest) => {
  lastScheduled = ms;
  trace.push({ op: 'sleep', ms });
  return mockedSetTimeout(fn, ms, ...rest);
};
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
// Lets everything that can run, run; then lets the one pending timer fire.
async function pump(promise) {
  let settled = false;
  const done = promise.then(
    (value) => { settled = true; return value; },
    (error) => { settled = true; throw error; }
  );
  for (let i = 0; i < 400 && !settled; i += 1) {
    await flush();
    if (settled) break;
    if (lastScheduled != null) {
      const ms = lastScheduled;
      lastScheduled = null;
      mock.timers.tick(ms);
    }
  }
  if (!settled) throw new Error('the scenario did not settle');
  return done;
}

const ROOT = 5100;
const row = (pid, ppid, pgid, token) => ({ pid, ppid, pgid, token });
const SURVIVOR = row(5101, 1, ROOT, 'a');

const observeScenario = async ({ capture = null, tables }) => {
  const tracker = sd.createProcessTreeTracker({ pid: ROOT, exitObserved: true });
  if (capture) {
    run.tables = [capture];
    run.reads = 0;
    await tracker.capture();
  }
  run.tables = tables;
  run.reads = 0;
  const steps = [];
  for (let i = 0; i < tables.length; i += 1) {
    try {
      const state = await tracker.observe({ rootExited: true });
      steps.push({ state, live: tracker.live.map(({ pid, token }) => ({ pid, token })) });
    } catch {
      steps.push({ state: 'unknown', live: [] });
    }
  }
  return { steps };
};

// The command's survivors as the post-exit probe finds them (the first table), recorded from there on.
async function probed(tables) {
  run.armed = false;
  run.tables = tables;
  run.reads = 0;
  const handle = await sd.probeShellDescendants({ pid: ROOT });
  trace = [];
  run.armed = true;
  return handle;
}

const cancelScenario = async ({ tables }) => {
  const handle = await probed(tables);
  const outcome = await pump(sd.killShellDescendants(handle));
  return { terminated: outcome.terminated };
};

const waitScenario = async ({ tables }) => {
  const handle = await probed(tables);
  await pump(sd.waitForShellDescendants(handle));
  return { reads: trace.filter((event) => event.op === 'read').length, recheckMs: sd.TERMINATION_RECHECK_MS };
};

const KINDS = { observe: observeScenario, cancel: cancelScenario, wait: waitScenario };
const SCENARIOS = [
  {
    name: 'a member that left the group stays tracked; a recycled root pid is never adopted',
    kind: 'observe',
    tables: [
      [row(5101, 1, ROOT, 'a'), row(5102, 1, ROOT, 'b')],
      [row(5102, 1, 5102, 'b')],
      [row(ROOT, 1, ROOT, 'reused'), row(5190, ROOT, ROOT, 'u1'), row(5191, 1, ROOT, 'u2'), row(5102, 1, 5102, 'b')],
      [row(ROOT, 1, ROOT, 'reused'), row(5190, ROOT, ROOT, 'u1')],
    ],
  },
  {
    name: 'a root whose token was taken while it was ours owns its links; a different token under its pid does not',
    kind: 'observe',
    capture: [row(ROOT, 1, ROOT, 'rt')],
    tables: [
      [row(ROOT, 1, ROOT, 'rt'), row(5120, ROOT, ROOT, 'c')],
      [row(ROOT, 1, ROOT, 'rt2'), row(5121, ROOT, ROOT, 'd')],
    ],
  },
  {
    name: 'a table that cannot be read is unknown, never empty',
    kind: 'observe',
    tables: [{ error: 'process enumeration denied' }, [SURVIVOR], { error: 'process enumeration denied' }, []],
  },
  {
    name: 'the group ends on SIGTERM: no SIGKILL, the target gets SIGTERM and a grace',
    kind: 'cancel',
    tables: [[SURVIVOR], [SURVIVOR], []],
    groupProbes: [false],
    pidProbes: [false],
  },
  {
    name: 'what ignores SIGTERM gets SIGKILL after the grace, and a second round ends the target',
    kind: 'cancel',
    tables: [[SURVIVOR], [SURVIVOR], [SURVIVOR], []],
    groupProbes: [true],
    pidProbes: [true, false],
  },
  {
    name: 'a root pid held by another process: the group is not signalled, the observed target still is',
    kind: 'cancel',
    tables: [[SURVIVOR], [row(ROOT, 1, ROOT, 'other'), SURVIVOR], []],
    groupProbes: [true],
    pidProbes: [false],
  },
  {
    name: 'a table that cannot be read at the start signals nothing',
    kind: 'cancel',
    tables: [[SURVIVOR], { error: 'process enumeration denied' }],
    groupProbes: [true],
    pidProbes: [false],
  },
  {
    name: 'survivors that outlast every round are reported as not terminated after three rounds',
    kind: 'cancel',
    tables: [[SURVIVOR]],
    groupProbes: [false],
    pidProbes: [false],
  },
  {
    name: 'a table that cannot be read after the kill is not a termination',
    kind: 'cancel',
    tables: [[SURVIVOR], [SURVIVOR], { error: 'process enumeration denied' }],
    groupProbes: [false],
    pidProbes: [false],
  },
  {
    name: 'the passive wait looks at every recheck, an unreadable table is not an end, the end is the first empty look',
    kind: 'wait',
    tables: [[SURVIVOR], [SURVIVOR], { error: 'process enumeration denied' }, [SURVIVOR], []],
  },
];

const recorded = [];
for (const scenario of SCENARIOS) {
  const { name, kind, tables, capture = null, groupProbes = [], pidProbes = [] } = scenario;
  run = { tables, reads: 0, groupProbes, pidProbes, groupAsked: 0, pidAsked: 0, armed: true };
  trace = [];
  lastScheduled = null;
  const result = await KINDS[kind](scenario);
  const entry = { name, kind, root: ROOT, tables, ...(capture ? { capture } : {}), ...(kind === 'cancel' ? { groupProbes, pidProbes } : {}), result };
  if (kind !== 'observe') entry.events = trace;
  recorded.push(entry);
}

const dir = join(FIXTURES_ROOT, 'shell-tracker-trace');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeJson(join(dir, 'golden.json'), {
  platform: hostPlatform,
  presentedPlatform: 'linux',
  node: process.version,
  nodeCommit: commit,
  note: 'POSIX branch of shell-descendants.mjs driven with a scripted process table, process.kill and timers; events are in call order',
  scenarios: recorded,
});
writeSetManifest(dir, {
  set: 'shell-tracker-trace',
  recorder: 'benchmarks/rust-core/recorders/record-shell-tracker-trace.mjs',
  command: `node --experimental-test-module-mocks benchmarks/rust-core/recorders/record-shell-tracker-trace.mjs --tree <git checkout of ${commit}> --commit ${commit}`,
  identity,
  extra: {
    scenarios: SCENARIOS.map((scenario) => scenario.name),
    blocked: ['real-kernel POSIX recording (pidfd waits, /proc table, SIGTERM delivery): this machine is Windows'],
  },
});
console.log('recorded shell-tracker-trace');
process.exit(0);
