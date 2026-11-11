#!/usr/bin/env node
// Records what a read-only I/O call held past its deadline gives the model, as Node's production path does it: real `askSession`
// turns (the loop, `executeToolOwned` -> `runReadOnlyIoWithDeadline`, tool-exec.mjs:130, read-only-deadline.mjs) against a
// scripted provider (only the provider's `send` is scripted). The call is held by a batch oplock on its file
// (lib/read-only-deadline-scenarios.mjs OPLOCK_HOLDER), released once the turn has ended. What is recorded per scenario: the tool
// messages of each request after the first (what the model is given back), the request count, the answer, and the turn's rows of
// history/tool-failures.jsonl (normalised by lib/tool-failure-rows.mjs, as record-tool-failures.mjs does).
//
// Each scenario runs in a Node process of its own (its `env` laid over the process environment), twice, in two fresh profiles but
// the same workspace path; the two recordings must be identical.
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> node benchmarks/rust-core/recorders/record-read-only-deadline.mjs --tree <exact export of b6f10295a with node_modules> [--only <n>,<n>]
//
// Output: native/core/fixtures/read-only-deadline/golden.json (+ MANIFEST.json); with --only the scenarios named are recorded and printed.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-read-only-deadline.mjs';
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 240_000;
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const { FILES, HELD_FILE, MODEL, holdOplock, scenarios } = await import('./lib/read-only-deadline-scenarios.mjs');

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
  const providerName = `read-only-deadline-${index}`;
  const sends = [];
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages) {
      sends.push(messages.map((m) => ({ role: m.role, content: m.content })));
      return JSON.parse(JSON.stringify(reply(scenario.replies[sends.length - 1])));
    },
  };
  const holder = await holdOplock(join(workspace, HELD_FILE), join(process.env.TEMP, 'oplock-holder.ps1'));
  let sessionId;
  let outcome;
  try {
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
  } finally {
    await holder.release();
  }
  const toolMessages = sends.slice(1).map((messages) => {
    const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
    return messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  });
  await stopOwnedPgForShutdown({ timeoutMs: 120_000 });
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'results.json'), JSON.stringify({ name: scenario.name, session: sessionId, outcome, sends: sends.length, toolMessages }));
  // An ordinary exit, whose `exit` hook writes the failure rows still queued; the parent reads the file after it.
  process.exit(0);
}

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { maskWorkspace, rowsByScenario } = await import('./lib/tool-failure-rows.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const tree = resolveTree(parseArgs(onlyAt >= 0 ? argv.filter((_, i) => i !== onlyAt && i !== onlyAt + 1) : argv));
const identity = exactProductIdentity(tree, NODE_COMMIT);
const { recorderProvenance } = await import('./lib/provenance.mjs');
const SCENARIO_COUNT = scenarios().length;
const selected = only ? only.split(',').map(Number) : [...Array(SCENARIO_COUNT).keys()];

/**
 * One scenario in its own profile under the run's folder, in a job object of its own (lib/job-run.mjs): on a deadline the child's
 * host is ended through the handle held here, which closes the job and ends its members (the oplock holder among them).
 */
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
  const file = join(env.MIXDOG_DATA_DIR, 'history', 'tool-failures.jsonl');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const sessions = Array.from({ length: SCENARIO_COUNT }, (_, k) => (k === index ? results.session : undefined));
  const rows = rowsByScenario(text, sessions, workspace, env.MIXDOG_DATA_DIR)[index];
  const masked = JSON.parse(maskWorkspace(maskWorkspace(JSON.stringify({ ...results, session: undefined }), workspace), env.MIXDOG_DATA_DIR, '<DATA>').split(results.session).join(`<session:${index}>`));
  return { rows, result: masked };
}

async function record(label, run, workspace) {
  const rows = Array(SCENARIO_COUNT).fill(null);
  const results = Array(SCENARIO_COUNT).fill(null);
  for (const index of selected) {
    const one = await recordScenario(`${label}-${index}`, index, run, workspace);
    rows[index] = one.rows;
    results[index] = one.result;
  }
  return { rows, results };
}

if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent (under D:\\mixdog-build\\tmp\\<slot>); the replay is run with the same one');
mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'rod-rec-'));
const workspace = join(run, 'ws');
mkdirSync(workspace);
let failure = null;
try {
  const a = await record('a', run, workspace);
  const b = await record('b', run, workspace);
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`two recordings differ beyond the session ids, ts, tool_ms and the workspace:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`);
  const all = scenarios();
  const golden = {
    note: 'what a read-only I/O call held past its deadline gives back (real askSession turns over a scripted provider, the call held by a batch oplock), recorded twice at b6f10295a: per scenario the tool messages of each later request, the request count, the answer and the turn\'s history/tool-failures.jsonl rows (lib/tool-failure-rows.mjs)',
    workspaceLength: workspace.length,
    scenarios: all,
    files: FILES,
    model: MODEL,
    rows: a.rows,
    results: a.results,
  };
  if (only) {
    console.log(JSON.stringify(golden, null, 1));
  } else {
    const finalDir = join(FIXTURES_ROOT, 'read-only-deadline');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), golden);
    writeSetManifest(stage, {
      set: 'read-only-deadline',
      recorder,
      command: `MIXDOG_RECORDER_SCRATCH=<scratch parent> node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
      identity,
      extra: {
        normalised: ['session_id (and the session id in a text)', 'ts', 'tool_ms', 'workspace', 'data folder'],
        excluded: ['the first request of each turn (it carries no tool message)', 'messages before the last assistant message of a request (the earlier turn state; the tool messages after it are the answer to that request\'s calls)'],
        notCompared: ['results[i].outcome.answer: the scripted provider\'s last reply text, which the replay serves itself; recorded to show the turn ended'],
        ...recorderProvenance(import.meta.url),
        syntheticInputs: {
          provider: `a scripted provider (only its send is scripted; model ${MODEL}): the replies of each scenario in lib/read-only-deadline-scenarios.mjs`,
          session: 'sessionOptions (src/session-runtime/session-create/session-options.mjs) with the headless tool profile, no session profile, skipSkills true and workflow { id: headless, delegatesAgents: false }',
          heldCall: `a batch oplock on ${HELD_FILE} taken before the turn by lib/read-only-deadline-scenarios.mjs OPLOCK_HOLDER and released after it`,
          environment: all.map((s) => ({ scenario: s.name, env: s.env })),
          workspaceFiles: Object.fromEntries(Object.entries(FILES).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])),
        },
      },
    });
    commitStage(stage, finalDir);
    console.log(`scenarios=${selected.length} rows=${a.rows.map((r) => r?.length ?? 0).join(',')}`);
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
