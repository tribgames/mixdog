#!/usr/bin/env node
// Records the agent-trace rows a run's tool batches write, as Node's production path writes them: real `askSession` turns (the
// loop: `recordToolBatch`, session/loop/tool-phase.mjs:46, and `traceAgentTool`, session/tool-batch/finalize.mjs:226) against a
// scripted provider (only the provider's `send` is scripted), with the local trace on (MIXDOG_DIAGNOSTICS). What is recorded per
// scenario: the session's `batch`/`tool`/`tool_slow` rows of history/agent-trace.jsonl (normalised by lib/agent-trace-run-rows.mjs),
// the count of its other row kinds, and its rows of history/tool-failures.jsonl (lib/tool-failure-rows.mjs).
//
// Each scenario runs in a Node process of its own (its `env` laid over the process environment), twice, in two fresh profiles but
// the same workspace path; the two recordings must be identical.
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> node benchmarks/rust-core/recorders/record-agent-trace-run.mjs --tree <exact export of b6f10295a with node_modules> [--only <n>,<n>]
//
// Output: native/core/fixtures/agent-trace-run/golden.json (+ MANIFEST.json); with --only the scenarios named are recorded and printed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-agent-trace-run.mjs';
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
const SCENARIOS_FILE = fileURLToPath(new URL('./lib/agent-trace-run-scenarios.mjs', import.meta.url));
const TRACE_ROWS_FILE = fileURLToPath(new URL('./lib/agent-trace-run-rows.mjs', import.meta.url));
const ROWS_FILE = fileURLToPath(new URL('./lib/tool-failure-rows.mjs', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 240_000;
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const { FILES, MODEL, scenarios } = await import('./lib/agent-trace-run-scenarios.mjs');

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const workspace = process.env.RECORDER_WORKSPACE;
  const index = Number(process.env.RECORDER_SCENARIO);
  const scenario = scenarios()[index];
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  const S = 'src/runtime/agent/orchestrator/';
  const { createSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
  const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
  const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
  const { HEADLESS_TOOL_PROFILE, modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
  const { sessionOptions } = await imp('src/session-runtime/session-create/session-options.mjs');
  const { workflowHelpers } = await imp('src/session-runtime/boot/shared.mjs');
  const { stopOwnedPgForShutdown } = await imp('src/runtime/memory/lib/pg/supervisor.mjs');
  const cfgMod = await imp(`${S}config.mjs`);

  for (const entry of readdirSync(workspace)) rmSync(join(workspace, entry), { recursive: true, force: true });
  for (const [name, text] of Object.entries(FILES)) writeFileSync(join(workspace, name), text);
  const reply = (step) => ({
    content: step.text,
    ...(step.calls.length ? { toolCalls: step.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })), stopReason: 'tool_use' } : {}),
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const providerName = `agent-trace-run-${index}`;
  let sends = 0;
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send() {
      sends += 1;
      return JSON.parse(JSON.stringify(reply(scenario.replies[sends - 1])));
    },
  };
  let sessionId;
  let outcome;
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    // A headless user session, as record-tool-failures.mjs builds one (sessionOptions with no session profile).
    const built = sessionOptions(
      {
        rt: { route: { provider: providerName, model: MODEL }, config: {}, mode: 'full', toolProfile: HEADLESS_TOOL_PROFILE, sessionProfile: null, currentCwd: workspace },
        cfgMod,
        activeWorkflowContext: workflowHelpers.activeWorkflowContext,
        schemaAllowedTools: modelToolSchemaAllowlist(HEADLESS_TOOL_PROFILE),
        featureDisallowedTools: () => [],
      },
      null
    );
    const session = createSession({ ...built, skipSkills: true, workflow: { id: 'headless', delegatesAgents: false } });
    sessionId = session.id;
    try {
      outcome = { answer: (await askSession(session.id, 'go', null, null, null, null, {})).content };
    } catch (error) {
      outcome = { threw: error.message.split(sessionId).join('<session>') };
    }
  });
  await stopOwnedPgForShutdown({ timeoutMs: 120_000 });
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'results.json'), JSON.stringify({ name: scenario.name, session: sessionId, outcome, sends }));
  // An ordinary exit, whose `exit` hooks write the rows still queued; the parent reads the files after it.
  process.exit(0);
}

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { rowsByScenario } = await import('./lib/tool-failure-rows.mjs');
const { traceRowsByScenario } = await import('./lib/agent-trace-run-rows.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const tree = resolveTree(parseArgs(onlyAt >= 0 ? argv.filter((_, i) => i !== onlyAt && i !== onlyAt + 1) : argv));
const identity = exactProductIdentity(tree, NODE_COMMIT);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const SCENARIO_COUNT = scenarios().length;
const selected = only ? only.split(',').map(Number) : [...Array(SCENARIO_COUNT).keys()];
const fileText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** One scenario in its own profile under the run's folder, in a job object of its own (lib/job-run.mjs). */
async function recordScenario(label, index, run, workspace) {
  const sandbox = join(run, `profile-${label}`);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, RECORDER_WORKSPACE: workspace, RECORDER_SCENARIO: String(index), MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_FEATURE_MEMORY: '0', ...scenarios()[index].env };
  for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    env[name] = join(sandbox, name.toLowerCase());
    mkdirSync(env[name], { recursive: true });
  }
  const report = join(sandbox, 'job.json');
  const child = spawnInJob(process.execPath, [SELF, '--child'], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], report });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let result;
  try {
    result = await deadline(exited, DEADLINE_MS, `recording ${label}`);
  } catch (error) {
    child.kill();
    await deadline(exited, 30_000, `recording ${label} ending after its kill`);
    throw new Error(`${error.message}\n${output}`);
  }
  const job = readJobReport(report);
  if (result.code !== job.exitCode) throw new Error(`recording ${label}'s job host failed (${result.code ?? result.signal}, the program's ${job.exitCode}):\n${output}`);
  if (job.exitCode !== 0) throw new Error(`recording ${label} failed (${job.exitCode}):\n${output}`);
  const results = JSON.parse(readFileSync(join(env.MIXDOG_DATA_DIR, 'results.json'), 'utf8'));
  const sessions = Array.from({ length: SCENARIO_COUNT }, (_, k) => (k === index ? results.session : undefined));
  const trace = traceRowsByScenario(fileText(join(env.MIXDOG_DATA_DIR, 'history', 'agent-trace.jsonl')), sessions, workspace)[index];
  const failures = rowsByScenario(fileText(join(env.MIXDOG_DATA_DIR, 'history', 'tool-failures.jsonl')), sessions, workspace, env.MIXDOG_DATA_DIR)[index];
  return { trace: trace.rows, others: trace.others, failures, results: { name: results.name, outcome: results.outcome, sends: results.sends } };
}

async function record(label, run, workspace) {
  const out = { trace: Array(SCENARIO_COUNT).fill(null), others: Array(SCENARIO_COUNT).fill(null), failures: Array(SCENARIO_COUNT).fill(null), results: Array(SCENARIO_COUNT).fill(null) };
  for (const index of selected) {
    const one = await recordScenario(`${label}-${index}`, index, run, workspace);
    for (const key of Object.keys(out)) out[key][index] = one[key];
  }
  return out;
}

if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent (under D:\\mixdog-build\\tmp\\<slot>); the replay is run with the same one');
mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'atr-rec-'));
const workspace = join(run, 'ws');
mkdirSync(workspace);
let failure = null;
try {
  const a = await record('a', run, workspace);
  const b = await record('b', run, workspace);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    writeFileSync(join(run, 'a.json'), JSON.stringify(a, null, 1));
    writeFileSync(join(run, 'b.json'), JSON.stringify(b, null, 1));
    throw new Error(`two recordings differ beyond what is normalised: ${join(run, 'a.json')} and b.json`);
  }
  const all = scenarios();
  const golden = {
    note: 'the agent-trace rows of a run\'s tool batches (real askSession turns over a scripted provider, MIXDOG_DIAGNOSTICS on), recorded twice at b6f10295a: per scenario the session\'s batch/tool/tool_slow rows of history/agent-trace.jsonl (lib/agent-trace-run-rows.mjs), the count of its other kinds, and its history/tool-failures.jsonl rows (lib/tool-failure-rows.mjs)',
    workspaceLength: workspace.length,
    scenarios: all,
    files: FILES,
    model: MODEL,
    ...a,
  };
  if (only) {
    console.log(JSON.stringify(golden, null, 1));
  } else {
    const finalDir = join(FIXTURES_ROOT, 'agent-trace-run');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), golden);
    writeSetManifest(stage, {
      set: 'agent-trace-run',
      recorder,
      command: `MIXDOG_RECORDER_SCRATCH=<scratch parent> node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
      identity,
      extra: {
        normalised: ['session_id', 'ts and each execution_intervals mark', 'batch ids (v4 UUIDs, by the order of their batch rows)', 'tool_ms and each payload.timing value', 'workspace', 'data folder (tool-failures rows)'],
        excluded: ['agent-trace rows of kinds other than batch, tool and tool_slow (context: the request\'s context accounting; usage: the usage log): written by other call sites than the tool batch; their count per kind is recorded (others) and not compared'],
        notCompared: ['others: the counts of the excluded kinds', 'results: the scripted turn\'s answer and send count, recorded to show the turn ended as scripted'],
        node: process.version,
        recorderSha256: sha256(SELF),
        scenariosSha256: sha256(SCENARIOS_FILE),
        traceRowsLibSha256: sha256(TRACE_ROWS_FILE),
        rowsLibSha256: sha256(ROWS_FILE),
        syntheticInputs: {
          provider: `a scripted provider (only its send is scripted; model ${MODEL}): the replies of each scenario in lib/agent-trace-run-scenarios.mjs`,
          session: 'sessionOptions (src/session-runtime/session-create/session-options.mjs) with the headless tool profile, no session profile, skipSkills true and workflow { id: headless, delegatesAgents: false }',
          environment: all.map((s) => ({ scenario: s.name, env: s.env })),
          workspaceFiles: Object.fromEntries(Object.entries(FILES).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])),
        },
      },
    });
    commitStage(stage, finalDir);
    console.log(`scenarios=${selected.length} trace=${a.trace.map((r) => r?.length ?? 0).join(',')} failures=${a.failures.map((r) => r?.length ?? 0).join(',')}`);
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
