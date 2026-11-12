// Records the session-send cases (session-send-world/cases.mjs) on Node b6f10295a in the app's own process layout, twice, and writes
// native/core/fixtures/session-send-world/{golden.json,MANIFEST.json}; with --replay <mixdogd.exe> replays them against the core.
//
//   record:  node --import tsx <repo>/benchmarks/rust-core/recorders/record-session-send-world.mjs --tree <exact export of b6f10295a with node_modules> --service <daemon.cjs> [--only <case>]
//   replay:  node --import tsx <repo>/benchmarks/rust-core/recorders/record-session-send-world.mjs --tree <same> --replay <mixdogd.exe> [--only <case>]
//            (cwd: <export>/apps/desktop, where `tsx` resolves)
//
// The daemon module is the export's desktop service built by apps/desktop/scripts/build-daemon.mjs (`--outfile=<daemon.cjs>`), as the app loads it.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { nodeTreeIdentity, parseArgs, REPO_ROOT, resolveTree, sha256, stableStringify } from './lib/common.mjs';
import { withJob } from './lib/process-job.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import { CASES, caseRoot, eachAtOnce, normalized } from './session-send-world/cases.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SUPERVISOR = 'D:\\mixdog-build\\tmp\\real-turn-harness\\cache\\supervisor-v0.1.1\\mixdog-supervisor-win32-x64.exe';
const here = dirname(fileURLToPath(import.meta.url));
const SET_DIR = join(REPO_ROOT, 'native', 'core', 'fixtures', 'session-send-world');
const args = parseArgs(process.argv.slice(2));
const tree = resolveTree(args);
const only = args.get('only');
const chosen = CASES.filter((c) => !only || only.split(',').includes(c.name));
if (only && chosen.length !== only.split(',').length) throw new Error(`--only names a case that is not in cases.mjs: ${only}`);
// The cases share nothing (each its own folder, daemon or core, ports and model endpoint): `--jobs` of them run at once (default 5).
const JOBS = Number(args.get('jobs') ?? 5);
if (!Number.isInteger(JOBS) || JOBS < 1) throw new Error(`--jobs takes a whole number of at least 1, not ${args.get('jobs')}`);

/** One case on Node in its own process (the app's main process), its daemon and every process it starts ended with the job. */
async function recordCase(c, run) {
  const root = caseRoot(c);
  // The second run keeps the first's raw recording beside its own (`home` is the run's app home and `core/data/userdata` its user
  // data, both made anew).
  if (run === 'run-1') rmSync(root, { recursive: true, force: true });
  else for (const dir of ['home', 'core']) rmSync(join(root, dir), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const out = join(root, `${run}.json`);
  const spec = join(root, 'case.json');
  writeFileSync(spec, JSON.stringify({ ...c, root, supervisor: SUPERVISOR, serviceModule: args.get('service') }));
  const done = await withJob(c.name, (job) => job.run(c.name, process.execPath, ['--import', 'tsx', join(here, 'session-send-world', 'world.mjs'), tree, spec, out], { cwd: join(tree, 'apps', 'desktop'), ms: 300_000 }));
  writeFileSync(join(root, `${run}.stderr.txt`), done.stderr);
  let result = null;
  try {
    result = JSON.parse(readFileSync(out, 'utf8'));
  } catch {}
  if (done.timedOut) throw new Error(`${c.name} (${run}): not done within 300 s (ended with the ${done.left} process(es) of its job)\n${done.stderr.slice(-4000)}`);
  if (done.code !== 0 || !result || result.failure) throw new Error(`${c.name} (${run}): exit ${done.code}\n${result?.failure ?? ''}\n${done.stderr.slice(-4000)}`);
  if (done.left) throw new Error(`${c.name} (${run}): ${done.left} process(es) outlived the case (ended with its job)`);
  return normalized(result.recorded);
}

async function recordAll(run) {
  const out = {};
  await eachAtOnce(chosen, JOBS, async (c) => {
    out[c.name] = await recordCase(c, run);
  });
  return out;
}

if (args.get('once')) {
  // A look at Node's answers while a case is written: one run, normalized, beside the case's raw recording.
  await eachAtOnce(chosen, JOBS, async (c) => {
    try {
      writeFileSync(join(caseRoot(c), 'node-normalized.json'), JSON.stringify(await recordCase(c, 'run-1'), null, 2));
      console.log(`recorded ${c.name}`);
    } catch (error) {
      console.log(`FAILED ${c.name}: ${error.message.slice(0, 3000)}`);
    }
  });
} else if (!args.get('replay')) {
  const identity = nodeTreeIdentity(args, tree, args.get('commit') ?? COMMIT);
  const provenance = recorderProvenance(import.meta.url);
  // The manifest holds one provenance for the whole set: a partial run keeps the other cases, so it may write only while the scripts
  // are the ones that recorded them.
  if (only) {
    const recorded = JSON.parse(readFileSync(join(SET_DIR, 'MANIFEST.json'), 'utf8'));
    if (stableStringify(recorded.provenance) !== stableStringify(provenance) || stableStringify(recorded.product) !== stableStringify(identity)) {
      throw new Error('--only: the scripts or the tree differ from those that recorded the other cases (MANIFEST.json provenance/product); record the whole set in one run');
    }
  }
  const first = await recordAll('run-1');
  const second = await recordAll('run-2');
  const differing = chosen.filter((c) => stableStringify(first[c.name]) !== stableStringify(second[c.name])).map((c) => c.name);
  if (differing.length) {
    for (const name of differing) {
      const root = caseRoot({ name });
      writeFileSync(join(root, 'run-1.normalized.json'), JSON.stringify(first[name], null, 2));
      writeFileSync(join(root, 'run-2.normalized.json'), JSON.stringify(second[name], null, 2));
    }
    throw new Error(`the two recordings differ: ${differing.join(', ')}`);
  }
  mkdirSync(SET_DIR, { recursive: true });
  const previous = only ? JSON.parse(readFileSync(join(SET_DIR, 'golden.json'), 'utf8')).cases : {};
  const cases = { ...previous, ...first };
  const golden = `${stableStringify({ cases }, 2)}\n`;
  writeFileSync(join(SET_DIR, 'golden.json'), golden);
  const manifest = {
    set: 'session-send-world',
    command: 'node --import tsx benchmarks/rust-core/recorders/record-session-send-world.mjs --tree <tree> --service <daemon.cjs>   (cwd <tree>/apps/desktop)',
    exclusions: [
      'The model endpoint is the one stand-in: a scripted OpenAI-chat endpoint (session-send-world/cases.mjs createModel) answering by the mark in the last user message. Every other step is the tree run unchanged: the app main process (DesktopServiceClient over SessionTransport), its daemon (the tree desktop service built by apps/desktop/scripts/build-daemon.mjs) and the supervisor, stopped and started again at a case step.',
      'Scripted at the source: the window submission ids (desktop-submit-<alias>-<n>, as the renderer passes them), and in the daemon (session-send-world/daemon-clock.mjs, its execArgv) Date.now as virtual time along each causal chain (a start instant per daemon start; a timer of 1 s or more moves its callback chain by its delay) and crypto.randomUUID numbered within each call site. The memory daemon keeps the real clock.',
      "Placed by the recorder: the app's user-data folder is <case>/core/data/userdata, where the replay's core keeps its own (<data>/userdata).",
      'Normal form (cases.mjs normalized): session ids by alias, the user-data folder named <userData> and the case folder <case>, other minted ids (atask, msg, sess_desktop, call, it, uuids) numbered by first appearance, padding runs named.',
    ],
    cases: Object.keys(cases).length,
    files: [{ path: 'golden.json', bytes: Buffer.byteLength(golden), sha256: sha256(Buffer.from(golden)) }],
    product: identity,
    provenance,
  };
  writeFileSync(join(SET_DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`recorded ${chosen.length} cases twice, identical; golden sha256 ${sha256(Buffer.from(golden))}; tree ${identity.commit}`);
} else {
  const { replayAll } = await import('./session-send-world/replay.mjs');
  const golden = JSON.parse(readFileSync(join(SET_DIR, 'golden.json'), 'utf8')).cases;
  const got = await replayAll({ exe: args.get('replay'), cases: chosen, jobs: JOBS });
  let failed = 0;
  for (const c of chosen) {
    const mine = got[c.name].failure ? got[c.name] : normalized(got[c.name].recorded);
    if (isDeepStrictEqual(mine, golden[c.name])) console.log(`ok   ${c.name}`);
    else {
      failed += 1;
      writeFileSync(join(caseRoot(c), 'core-normalized.json'), JSON.stringify(mine, null, 2));
      console.log(`FAIL ${c.name}: written ${join(caseRoot(c), 'core-normalized.json')}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
