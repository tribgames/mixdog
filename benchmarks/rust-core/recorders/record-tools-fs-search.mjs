#!/usr/bin/env node
// What Node's file and search tools answer in the cases the Rust core's `glob`, `grep`, `list`, `read` and `code_graph` replay
// (native/core/crates/mixdog-tools, `fs::tests` and `code_graph::tests`): the real tools of the exact export of b6f10295a, called
// through `executeBuiltinTool` / `executeCodeGraphTool` over a fresh workspace per scenario, in order, in one Node process per
// scenario. Glob, grep and find need Node's resident search server and code_graph its parser: both are the `mixdog-graph` binary built
// from the same commit's native/mixdog-graph (`--graph-bin`).
//
// Each scenario's process runs in a job object of its own (lib/job-run.mjs): the search server it starts is ended with it on every path.
//
//   node benchmarks/rust-core/recorders/record-tools-fs-search.mjs --tree <exact export of b6f10295a with node_modules> \
//        --graph-bin <mixdog-graph built from b6f10295a:native/mixdog-graph> --scratch <scratch parent> [--only <scenario>]
//
// Output: native/core/fixtures/tools-fs-search/<scenario>.json (+ MANIFEST.json); with --only the one scenario is recorded and printed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-tools-fs-search.mjs';
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 240_000;
// Every file of a workspace is dated here unless its scenario dates it otherwise (glob lists newest first).
const FIXED = '2026-01-02T03:04:05Z';

// A scenario: the workspace (`files`: path -> text; `junctions`: path -> the workspace directory it points at; `mtimes`: path -> ISO
// time), the folder the calls run in (`cwd`, under the workspace), unrecorded `warmup` calls and the calls, in order. `<ROOT>` in an input is the workspace
// path, written with forward slashes.
const SCENARIOS = [
  // gaps-tools item 12: a glob-shaped `list` path is answered as a name search (list-tool.mjs -> executeFindFilesTool).
  {
    name: 'list-glob-path',
    files: {
      'src/a.ts': 'a\n',
      'src/b.ts': 'b'.repeat(3000),
      'src/c.js': 'c\n',
      'src/sub/d.ts': 'd\n',
      'src/.hid.ts': 'h\n',
      'src/.cfg/e.ts': 'e\n',
      'src/node_modules/m/i.ts': 'i\n',
      'src/node_modules/top.ts': 't\n',
      'README.md': 'r\n',
      'docs/x.md': 'x\n',
    },
    mtimes: { 'src/a.ts': '2026-01-05T00:00:00Z', 'src/sub/d.ts': '2026-01-04T00:00:00Z', 'docs/x.md': '2026-01-03T10:00:00Z', 'src/sub': '2026-01-06T00:00:00Z', 'src/node_modules': '2026-01-07T00:00:00Z' },
    warmup: [{ tool: 'list', input: { path: 'warm/*.none' } }, { tool: 'list', input: { path: '*.none' } }],
    calls: [
      { tool: 'list', input: { path: 'src/*.ts' } },
      { tool: 'list', input: { path: 'src/**/*.ts' } },
      { tool: 'list', input: { path: '**/*.md' } },
      { tool: 'list', input: { path: '*.md' } },
      { tool: 'list', input: { path: 'src/*.ts', limit: 1 } },
      { tool: 'list', input: { path: 'src/*.ts', offset: 1 } },
      { tool: 'list', input: { path: 'src/*.ts', hidden: true } },
      { tool: 'list', input: { path: 'src/*.ts', meta: true } },
      { tool: 'list', input: { path: 'src/*.TS' } },
      { tool: 'list', input: { path: 'src/*.zz' } },
      { tool: 'list', input: { path: '<ROOT>/src/*.ts' } },
      { tool: 'list', input: { path: 'src/{a,c}.*' } },
      { tool: 'list', input: { path: 'src/s*' } },
      { tool: 'list', input: { path: 'src/n*' } },
      { tool: 'list', input: { path: 'src/**/i.ts' } },
      { tool: 'list', input: { path: 'src/**/e.ts' } },
      { tool: 'list', input: { path: 'src/**/e.ts', hidden: true } },
      { tool: 'list', input: { path: 'README.md/*.x' } },
      { tool: 'list', input: { path: 'src/*.ts', limit: 0 } },
    ],
  },
];

const deadline = (promise, ms, what) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const ws = process.env.RECORDER_WORKSPACE;
  const scenario = SCENARIOS.find((s) => s.name === process.env.RECORDER_SCENARIO);
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  for (const [rel, text] of Object.entries(scenario.files ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  for (const [rel, target] of Object.entries(scenario.junctions ?? {})) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    symlinkSync(join(ws, target), join(ws, rel), 'junction');
  }
  for (const rel of Object.keys(scenario.files ?? {})) {
    const at = new Date(scenario.mtimes?.[rel] ?? FIXED);
    utimesSync(join(ws, rel), at, at);
  }
  // Directories are dated last: writing their files moved their mtimes.
  for (const [rel, iso] of Object.entries(scenario.mtimes ?? {})) {
    if (!(rel in (scenario.files ?? {}))) utimesSync(join(ws, rel), new Date(iso), new Date(iso));
  }
  const { executeBuiltinTool } = await imp('src/runtime/agent/orchestrator/tools/builtin.mjs');
  const { executeCodeGraphTool } = await imp('src/runtime/agent/orchestrator/tools/code-graph.mjs');
  const { normalizeToolEnvelope } = await imp('src/runtime/agent/orchestrator/session/tool-envelope.mjs');
  const fwd = ws.replace(/\\/g, '/');
  const scrub = (text) => String(text).replaceAll(ws, '<ROOT>').replaceAll(fwd, '<ROOT>');
  const cwd = scenario.cwd ? join(ws, scenario.cwd) : ws;
  // Unrecorded calls first: the search server's first start can miss Node's 1 s readiness bound, which is a cold-start
  // artefact of the recording machine, not an answer.
  for (const call of scenario.warmup ?? []) await executeBuiltinTool(call.tool, call.input, cwd).catch(() => {});
  const calls = [];
  for (const call of scenario.calls) {
    const input = JSON.parse(JSON.stringify(call.input).replaceAll('<ROOT>', fwd));
    let outcome;
    try {
      const raw = call.tool === 'code_graph' ? await executeCodeGraphTool('code_graph', input, cwd) : await executeBuiltinTool(call.tool, input, cwd);
      const env = normalizeToolEnvelope(raw);
      const text = typeof env.result === 'string' ? env.result : JSON.stringify(env.result ?? '');
      outcome = { text: scrub(text), isError: env.isError === true || /^Error[\s:[]/.test(text) };
    } catch (error) {
      outcome = { thrown: scrub(String(error?.message ?? error)) };
    }
    calls.push({ tool: call.tool, input: call.input, ...outcome });
  }
  writeFileSync(process.env.RECORDER_RESULT, JSON.stringify(calls));
  process.exit(0);
}

const { FIXTURES_ROOT, REPO_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const graphBin = args.get('graph-bin');
if (!graphBin || !existsSync(graphBin)) throw new Error('--graph-bin <mixdog-graph built from b6f10295a:native/mixdog-graph> is required');
const scratch = args.get('scratch');
if (!scratch) throw new Error('--scratch <scratch parent> is required');
const only = args.get('only');
const selected = only ? SCENARIOS.filter((s) => s.name === only) : SCENARIOS;
if (only && selected.length === 0) throw new Error(`no scenario ${only}`);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'fs-search-'));

/** One scenario in a Node process of its own, inside a job that ends with it. */
async function recordScenario(scenario) {
  const sandbox = join(run, scenario.name);
  const ws = join(sandbox, 'ws');
  mkdirSync(ws, { recursive: true });
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, RECORDER_WORKSPACE: ws, RECORDER_SCENARIO: scenario.name, RECORDER_RESULT: join(sandbox, 'result.json'), MIXDOG_GRAPH_BIN: graphBin, MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_FEATURE_MEMORY: '0' };
  for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    env[name] = join(sandbox, name.toLowerCase());
    mkdirSync(env[name], { recursive: true });
  }
  const report = join(sandbox, 'job.json');
  const child = spawnInJob(process.execPath, [SELF, '--child'], { env, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], report });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  try {
    await deadline(exited, DEADLINE_MS, `scenario ${scenario.name}`);
  } catch (error) {
    // Ending the job's host closes the job, which ends every process in it.
    child.kill();
    await deadline(exited, 30_000, `scenario ${scenario.name}'s job host ending`);
    throw new Error(`${error.message}\n${output}`);
  }
  const job = readJobReport(report);
  if (job.exitCode !== 0) throw new Error(`scenario ${scenario.name} failed (${job.exitCode}):\n${output}`);
  const { calls: _calls, ...rest } = scenario;
  return { ...rest, calls: JSON.parse(readFileSync(join(sandbox, 'result.json'), 'utf8')) };
}

let failure = null;
try {
  const recorded = [];
  for (const scenario of selected) recorded.push(await recordScenario(scenario));
  if (only) {
    console.log(JSON.stringify(recorded[0], null, 1));
  } else {
    const finalDir = join(FIXTURES_ROOT, 'tools-fs-search');
    const stage = stageSet(finalDir);
    for (const scenario of recorded) writeJson(join(stage, `${scenario.name}.json`), scenario);
    writeSetManifest(stage, {
      set: 'tools-fs-search',
      recorder: RECORDER,
      command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}> --graph-bin <mixdog-graph built from ${NODE_COMMIT}:native/mixdog-graph> --scratch <scratch parent>`,
      identity,
      extra: {
        node: process.version,
        recorderSha256: sha256(readFileSync(SELF)),
        inputs: ['benchmarks/rust-core/recorders/lib/common.mjs', 'benchmarks/rust-core/recorders/lib/job-run.mjs'].map((path) => ({ path, sha256: sha256(readFileSync(join(REPO_ROOT, path))) })),
        graphBinary: { builtFrom: `${NODE_COMMIT}:native/mixdog-graph (cargo build --locked --bin mixdog-graph, dev profile)`, sha256: sha256(readFileSync(graphBin)) },
        scenarios: recorded.map((s) => s.name),
        normalised: ['the workspace path (backslash and forward-slash forms) is <ROOT> in every text'],
        exclusions: ['what each scenario process left running at its exit (Node\'s resident search server) is ended with its job and not recorded'],
      },
    });
    commitStage(stage, finalDir);
    console.log(`recorded ${recorded.length} scenario(s)`);
  }
} catch (error) {
  failure = error;
}
if (failure) {
  console.error(`the run's folder ${run} is kept`);
  throw failure;
}
rmSync(run, { recursive: true, force: true });
process.exit(0);
