// Records what Node's `submitNewTask` does when a request comes in again (b6f10295a, the real SessionHost and NewTaskRequests, run
// unchanged from an exact export), and replays the same scenarios against a built `mixdogd`.
//
//   record:  node benchmarks/rust-core/recorders/record-new-task-dedupe.mjs --tree <exact export of b6f10295a with node_modules>
//   replay:  node --import tsx ../../benchmarks/rust-core/recorders/record-new-task-dedupe.mjs --tree <same> --replay <mixdogd.exe built with --features crash-gates>
//            [--only <scenario name>]      (cwd: apps/desktop, whose node_modules holds tsx: the replay loads the desktop's TypeScript client)
//
// Every scenario runs in a folder of its own under D:\mixdog-build\tmp\new-task-dedupe (removed when the scenario is done). A step list is
// run in legs: a crash step ends its leg's process at the gate it names and the next step starts a new process over the same data
// directory. The recording is written twice over (two full runs): the values that differ between the two runs are the random ones
// (`freshSessionId`, new-task-requests.ts:85), and they are the only values the comparison replaces (by order of appearance).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, exactProductIdentity, parseArgs, resolveTree, stableStringify, writeSetManifest, writeText } from './lib/common.mjs';
import { withJob } from './lib/process-job.mjs';
import { recordingScripts } from './lib/recording-scripts.mjs';
import { COMPARISON, SCENARIOS } from './new-task-dedupe/scenarios.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const WORK = 'D:\\mixdog-build\\tmp\\new-task-dedupe';
const SET_DIR = join(FIXTURES_ROOT, 'new-task-dedupe');
const args = parseArgs();
const tree = resolveTree(args);
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const only = args.get('only') ?? null;
/** Scenarios run side by side (each its own folder, process and job). */
const AT_ONCE = 4;

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const derived = (id) => `sess_desktop_${sha256(id)}`;
const FRESH = /sess_desktop_[0-9a-f]{64}/g;

/** The scenario's addresses, the derived ones kept and every other one numbered by first appearance: `<fresh:1>`, `<fresh:2>`, … */
export function numberFresh(scenario, value) {
  const keep = new Set(scenario.steps.flatMap((step) => [step.id, ...(step.calls ?? []).map((call) => call.id)]).filter(Boolean).map(derived));
  const seen = [];
  // Numbered over the value with its keys in sorted order, so that both sides number the same address the same way.
  return JSON.parse(stableStringify(value, 0).replace(FRESH, (address) => {
    if (keep.has(address)) return address;
    if (!seen.includes(address)) seen.push(address);
    return `<fresh:${seen.indexOf(address) + 1}>`;
  }));
}

const legs = (steps) => {
  const out = [];
  let current = [];
  steps.forEach((step, index) => {
    current.push({ step, index });
    if (step.op === 'crash') {
      out.push({ steps: current, crash: { at: step.at } });
      current = [];
    }
  });
  if (current.length) out.push({ steps: current });
  return out;
};

function readState(dir) {
  const receipts = join(dir, 'userData', 'new-task-receipts');
  let files = null;
  try {
    files = Object.fromEntries(readdirSync(receipts).sort().map((name) => [name, readFileSync(join(receipts, name)).toString('latin1')]));
  } catch {}
  let sessions = {};
  try {
    sessions = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8')).sessions).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, entry]) => [id, { prompts: entry.prompts.length, reserved: entry.reserved }]));
  } catch {}
  return { receipts: files, sessions };
}

/** One scenario on Node: the reply, the daemon's calls, the receipt files' bytes and the sessions after every step. Its legs run in a job of
 *  their own (lib/process-job.mjs): whatever a leg started is ended with it, and a leg that leaves a process running fails the scenario. */
async function recordScenario(scenario) {
  const dir = join(WORK, 'node', scenario.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const profile = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_CONFIG_DIR'].map((name) => [name, join(dir, 'profile', name)]));
  for (const folder of Object.values(profile)) mkdirSync(folder, { recursive: true });
  const steps = [];
  try {
    await withJob(scenario.name, async (job) => {
      for (const leg of legs(scenario.steps)) {
        const child = await job.run(scenario.name, process.execPath, ['--import', 'tsx', join(here, 'new-task-dedupe', 'leg.mjs'), tree, dir, JSON.stringify(leg)], {
          cwd: join(tree, 'apps', 'desktop'),
          // The profile folders the product may read (the provider registry's config and credentials included) are the scenario's own.
          env: { ...process.env, ...profile },
          ms: 120_000,
        });
        if (child.timedOut) throw new Error(`${scenario.name}: the leg did not finish within 120 s (ended with its job)`);
        if (child.left) throw new Error(`${scenario.name}: the leg left ${child.left} process(es) running (ended with its job)`);
        for (const line of child.stdout.split('\n').filter((text) => text.startsWith('{'))) {
          const done = JSON.parse(line);
          steps[done.index] = { step: scenario.steps[done.index], reply: done.reply, daemonCalls: done.daemonCalls, ...pickState(done) };
        }
        if (leg.crash) {
          const index = leg.steps.at(-1).index;
          // The process ended at its gate: SIGKILL (a Windows kill is exit code 1 with no signal name).
          if (child.code === 0 || child.stderr.includes('the process was to end at its gate')) throw new Error(`${scenario.name}: the process did not end at its gate:\n${child.stdout}`);
          steps[index] = { step: scenario.steps[index], reply: { crashed: leg.crash.at }, daemonCalls: null, ...readState(dir) };
        } else if (child.code !== 0) {
          throw new Error(`${scenario.name}: leg failed (${child.code}):\n${child.stderr}\n${child.stdout}`);
        }
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return steps;
}

/** Every scenario, `AT_ONCE` at a time; resolves with their steps by name. */
async function recordAll() {
  const results = new Array(chosen.length);
  let next = 0;
  const worker = async () => {
    while (next < chosen.length) {
      const index = next++;
      results[index] = await recordScenario(chosen[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, chosen.length) }, worker));
  return Object.fromEntries(chosen.map((scenario, index) => [scenario.name, results[index]]));
}

const pickState = (done) => ({ receipts: done.receipts, sessions: done.sessions });

const chosen = SCENARIOS.filter((scenario) => !only || scenario.name === only);

if (!args.get('replay')) {
  const started = Date.now();
  const first = await recordAll();
  const second = await recordAll();
  console.log(`two runs of ${chosen.length} scenarios in ${Math.round((Date.now() - started) / 1000)} s`);
  const golden = {};
  const random = [];
  for (const scenario of chosen) {
    const a = numberFresh(scenario, first[scenario.name]);
    const b = numberFresh(scenario, second[scenario.name]);
    // The two runs agree once the fresh addresses are numbered, and differ before: those addresses are the random values.
    if (stableStringify(a) !== stableStringify(b)) throw new Error(`${scenario.name}: two recordings differ beyond the random addresses:\n${stableStringify(a)}\n${stableStringify(b)}`);
    const differing = stableStringify(first[scenario.name]) !== stableStringify(second[scenario.name]);
    if (differing) random.push(scenario.name);
    golden[scenario.name] = { steps: scenario.steps, recorded: a };
  }
  if (!only) {
    writeText(join(SET_DIR, 'golden.json'), stableStringify({ scenarios: golden }));
    writeSetManifest(SET_DIR, {
      set: 'new-task-dedupe',
      recorder: 'benchmarks/rust-core/recorders/record-new-task-dedupe.mjs',
      command: 'node benchmarks/rust-core/recorders/record-new-task-dedupe.mjs --tree <exact export of b6f10295a with node_modules>',
      identity: exactProductIdentity(tree, COMMIT),
      extra: {
        random: {
          'fresh session address': 'a session address after a refusal reset or a changed-content retry is `sess_desktop_` + 32 random bytes in hex (freshSessionId, new-task-requests.ts:85); numbered `<fresh:N>` by first appearance in a scenario',
          scenariosWhereTheTwoRunsDiffered: random,
        },
        daemon: 'the daemon is a model (leg.mjs) of the rules the new-task path uses; its calls are recorded for Node only',
        comparison: COMPARISON,
        recording: recordingScripts(['benchmarks/rust-core/recorders/record-new-task-dedupe.mjs', 'benchmarks/rust-core/recorders/new-task-dedupe/leg.mjs']),
        processes: 'each scenario runs its legs in a Windows job of its own (lib/process-job.mjs): every process a leg starts is ended with it, and a leg that leaves one running fails',
      },
    });
  }
  if (only) console.log(stableStringify(golden));
  console.log(`recorded ${chosen.length} scenarios; ${random.length} contain a random address`);
} else {
  const { replayNewTaskDedupe } = await import('./new-task-dedupe/replay.mjs');
  const golden = JSON.parse(readFileSync(join(SET_DIR, 'golden.json'), 'utf8')).scenarios;
  process.exit(await replayNewTaskDedupe({ exe: args.get('replay'), scenarios: chosen, golden, numberFresh }));
}
