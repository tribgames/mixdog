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
import { CASES, caseRoot, normalized } from './session-send-world/cases.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const SUPERVISOR = 'D:\\mixdog-build\\tmp\\real-turn-harness\\cache\\supervisor-v0.1.1\\mixdog-supervisor-win32-x64.exe';
const here = dirname(fileURLToPath(import.meta.url));
const SET_DIR = join(REPO_ROOT, 'native', 'core', 'fixtures', 'session-send-world');
const args = parseArgs(process.argv.slice(2));
const tree = resolveTree(args);
const only = args.get('only');
const chosen = CASES.filter((c) => !only || only.split(',').includes(c.name));

/** One case on Node in its own process (the app's main process), its daemon and every process it starts ended with the job. */
async function recordCase(c, run) {
  const root = caseRoot(c);
  // The second run keeps the first's raw recording beside its own (`home` is the run's app home, made anew).
  if (run === 'run-1') rmSync(root, { recursive: true, force: true });
  else rmSync(join(root, 'home'), { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const out = join(root, `${run}.json`);
  const spec = join(root, 'case.json');
  writeFileSync(spec, JSON.stringify({ ...c, root, supervisor: SUPERVISOR, serviceModule: args.get('service') }));
  const done = await withJob(c.name, (job) => job.run(c.name, process.execPath, ['--import', 'tsx', join(here, 'session-send-world', 'world.mjs'), tree, spec, out], { cwd: join(tree, 'apps', 'desktop'), ms: 600_000 }));
  writeFileSync(join(root, `${run}.stderr.txt`), done.stderr);
  let result = null;
  try {
    result = JSON.parse(readFileSync(out, 'utf8'));
  } catch {}
  if (done.timedOut) throw new Error(`${c.name} (${run}): not done within 600 s (ended with the ${done.left} process(es) of its job)\n${done.stderr.slice(-4000)}`);
  if (done.code !== 0 || !result || result.failure) throw new Error(`${c.name} (${run}): exit ${done.code}\n${result?.failure ?? ''}\n${done.stderr.slice(-4000)}`);
  if (done.left) throw new Error(`${c.name} (${run}): ${done.left} process(es) outlived the case (ended with its job)`);
  return normalized(result.recorded);
}

async function recordAll(run) {
  const out = {};
  for (const c of chosen) out[c.name] = await recordCase(c, run);
  return out;
}

if (args.get('once')) {
  // A look at Node's answers while a case is written: one run, normalized, beside the case's raw recording.
  for (const c of chosen) {
    try {
      writeFileSync(join(caseRoot(c), 'node-normalized.json'), JSON.stringify(await recordCase(c, 'run-1'), null, 2));
      console.log(`recorded ${c.name}`);
    } catch (error) {
      console.log(`FAILED ${c.name}: ${error.message.slice(0, 3000)}`);
    }
  }
} else if (!args.get('replay')) {
  const identity = nodeTreeIdentity(args, tree, args.get('commit') ?? COMMIT);
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
  const golden = `${stableStringify({ cases: { ...previous, ...first } }, 2)}\n`;
  writeFileSync(join(SET_DIR, 'golden.json'), golden);
  console.log(`recorded ${chosen.length} cases twice, identical; golden sha256 ${sha256(Buffer.from(golden))}; tree ${identity.commit}`);
} else {
  const { replayAll } = await import('./session-send-world/replay.mjs');
  const golden = JSON.parse(readFileSync(join(SET_DIR, 'golden.json'), 'utf8')).cases;
  const got = await replayAll({ exe: args.get('replay'), cases: chosen });
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
