#!/usr/bin/env node
// Records what Node's model is sent, and whether any file Node writes keeps a value, when a value marked sensitive in one
// session has reached others (lib/sensitive-carry-scenario.mjs): real createSession / askSession Lead turns and the real agent
// tool (createStandaloneAgent, as the session runtime builds it) over one scripted OpenAI-chat provider configured as a custom
// provider, with the runtime's notification bus (createNotificationBus) delivering a worker's report to its owner's queue and
// no completion wake (`autoWakeCompletions` off: its onCompletionQueued only counts what was queued, for the scenario's waits).
// A worker's provider call is answered only while its Lead is idle (lib/sensitive-carry-scenario.mjs leadTurns), so a report
// is never queued while the Lead's turn runs: when it would land in that turn follows the race of the two turns.
//
// The tree is the export of b6f10295a with the sensitive-value patches applied in order (`--patch`): side-writes,
// header-summary, memory-scrub and carry (node-patches/node-fix-sensitive-carry.patch: the report redacted with the worker's
// values, the values carried to the sessions its text reached and their stored copies rewritten).
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> node benchmarks/rust-core/recorders/record-sensitive-carry.mjs --tree <tree> --patch <patch>,...
//
// Output: native/core/fixtures/sensitive-carry/golden.json (+ MANIFEST.json).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT, AGENT_MD, CODES, MODEL, STEPS, leadTurns, orderedCalls, scriptedProvider } from './lib/sensitive-carry-scenario.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-sensitive-carry.mjs';
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 300_000;
const PROVIDER = 'custom-33333333-3333-4333-8333-333333333333';
/** Files where Node's recording is known to keep a value, each with why; a hit anywhere else fails the recording. */
const KNOWN_OPEN = {
  'mixdog_data_dir/history/agent-trace.jsonl':
    "the diagnostic trace's rows written before a value reached the session (here the Lead's spawn of the keeper, quoting the code before the first worker marked it): the patches redact a row when it is written, never one already written; the core writes no such file",
};
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const WORKSPACE = process.env.RECORDER_WORKSPACE;
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  const S = 'src/runtime/agent/orchestrator/';
  const calls = [];
  const turns = leadTurns();
  const prov = await scriptedProvider(calls, PROVIDER, { held: turns.held });
  const data = process.env.MIXDOG_DATA_DIR;
  // A custom provider as the desktop saves it, and the agent every worker runs.
  writeFileSync(join(data, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { [PROVIDER]: { type: 'custom', name: 'sc', enabled: true, protocol: 'openai-chat', baseURL: prov.baseURL, auth: 'none', models: [{ id: MODEL }] } } } }));
  mkdirSync(join(data, 'agents', AGENT), { recursive: true });
  writeFileSync(join(data, 'agents', AGENT, 'AGENT.md'), AGENT_MD);

  const { createSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
  const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
  const { modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
  const { sessionOptions } = await imp('src/session-runtime/session-create/session-options.mjs');
  const { workflowHelpers } = await imp('src/session-runtime/boot/shared.mjs');
  const { setInternalToolsProvider } = await imp(`${S}internal-tools.mjs`);
  const { createStandaloneAgent } = await imp('src/session-runtime/services/agent-tool.mjs');
  const { createNotificationBus } = await imp('src/session-runtime/notification-bus.mjs');
  const { drainSessionStore } = await imp(`${S}session/store.mjs`);
  const { backfillSessionSearch } = await imp('src/runtime/session-search/session-search-ingest.mjs');
  const { stopOwnedPgForShutdown } = await imp('src/runtime/memory/lib/pg/supervisor.mjs');
  const cfgMod = await imp(`${S}config.mjs`);
  const reg = await imp(`${S}providers/registry.mjs`);
  const mgr = await imp(`${S}session/manager.mjs`);
  await reg.initProviders(cfgMod.loadConfig().providers);

  // Completions queued per session; a wait resolves once its session has had `count`.
  const queued = new Map();
  const waiters = [];
  const settleWaiters = () => {
    for (const w of [...waiters]) {
      if ((queued.get(w.sessionId) ?? 0) < w.count) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  };
  const until = (sessionId, count) => new Promise((resolve) => { waiters.push({ sessionId, count, resolve }); settleWaiters(); });
  const bus = createNotificationBus({
    listeners: new Set(),
    mgr,
    onCompletionQueued: ({ sessionId }) => { queued.set(sessionId, (queued.get(sessionId) ?? 0) + 1); settleWaiters(); },
  });
  const scopeId = 'sensitive-carry-scope';
  const agentTool = createStandaloneAgent({ cfgMod: { loadConfig: cfgMod.loadConfig, resolveRuntimeSpec: cfgMod.resolveRuntimeSpec }, reg, mgr, dataDir: cfgMod.getPluginData(), cwd: WORKSPACE, mcpScopeId: scopeId, notifySessionCompletion: bus.notifySessionCompletion });
  setInternalToolsProvider({ scopeId, tools: agentTool.tools, executor: (_name, args, callerCtx) => agentTool.execute(args, callerCtx) });

  const leads = new Map();
  const answers = [];
  // A worker's session id, as the agent tool's own status of its tag names it (`target: <tag> <session>`).
  const workerSession = async (tag, lead) => {
    const status = String(await agentTool.execute({ type: 'status', tag }, { callerSessionId: lead, sessionId: lead }));
    return status.match(new RegExp(`target: ${tag} (\\S+)`))?.[1] ?? null;
  };
  for (const step of STEPS) {
    if (!leads.has(step.lead)) {
      const built = sessionOptions(
        {
          rt: { route: { provider: PROVIDER, model: MODEL }, config: {}, mode: 'full', toolProfile: 'interactive', sessionProfile: null, currentCwd: WORKSPACE, mcpScopeId: scopeId },
          cfgMod,
          activeWorkflowContext: workflowHelpers.activeWorkflowContext,
          schemaAllowedTools: modelToolSchemaAllowlist('interactive'),
          featureDisallowedTools: () => [],
        },
        null
      );
      leads.set(step.lead, createSession(built).id);
    }
    const lead = leads.get(step.lead);
    for (const [who, count] of Object.entries(step.waitFor ?? {})) {
      const sessionId = who === 'lead' ? lead : await workerSession(who, lead);
      if (!sessionId) throw new Error(`no session for ${who}`);
      await deadline(until(sessionId, count), 120_000, `${count} completion(s) queued for ${who} before "${step.prompt}"`).catch((error) => {
        throw new Error(`${error.message}\nthe provider calls so far:\n${JSON.stringify(calls)}`);
      });
    }
    const answer = await turns.turn(step.lead, () => deadline(askSession(lead, step.prompt, null, null, null, null, {}), 120_000, `the turn "${step.prompt}"`));
    answers.push(answer?.content ?? null);
  }
  // Every session's stored copies written (the carried rewrites included), the search copy caught up, the memory database stopped.
  await drainSessionStore();
  await deadline(backfillSessionSearch(), 120_000, 'the session-search backfill');
  await stopOwnedPgForShutdown({ timeoutMs: 120_000 });
  await prov.close();
  writeFileSync(process.env.RECORDER_STATE, JSON.stringify({ calls, answers }));
  process.exit(0);
}

const { recorderProvenance } = await import('./lib/provenance.mjs');
const { FIXTURES_ROOT, commitStage, parseArgs, patchedProductIdentity, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const { scanSecrets } = await import('./lib/sensitive-writes-files.mjs');
const args = parseArgs();
for (const name of args.keys()) if (!['tree', 'patch'].includes(name)) throw new Error(`unknown option --${name} (known: --tree, --patch)`);
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('pass --patch with the four sensitive-value patches, in order');
const identity = patchedProductIdentity(tree, NODE_COMMIT, args.get('patch'));
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent (under D:\\mixdog-build\\tmp\\<slot>)');
const PROFILE_DIRS = ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];

/** One recording in its own profile; then every file under it searched for the codes. */
async function record(run, label) {
  const sandbox = join(run, label);
  const workspace = join(sandbox, 'ws');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, RECORDER_WORKSPACE: workspace, RECORDER_STATE: join(sandbox, 'state.json'), MIXDOG_SKIP_USER_DATA_BACKUP: '1', ...(process.env.SENSITIVE_CARRY_TEXT ? { SENSITIVE_CARRY_TEXT: '1' } : {}) };
  for (const name of PROFILE_DIRS) env[name] = join(sandbox, 'profile', name.toLowerCase());
  for (const dir of [workspace, ...PROFILE_DIRS.map((n) => env[n])]) mkdirSync(dir, { recursive: true });
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
  if (result.code !== job.exitCode || job.exitCode !== 0) throw new Error(`recording ${label} failed (${result.code ?? result.signal}, the program's ${job.exitCode}):\n${output}`);
  const state = JSON.parse(readFileSync(env.RECORDER_STATE, 'utf8'));
  // A hit as its file, spelling and value (its offset follows the run's timings in the file's other rows).
  const scan = scanSecrets(join(sandbox, 'profile'), Object.values(CODES)).map(({ file, encoding, value }) => ({ file, encoding, value }));
  return { calls: orderedCalls(state.calls), answers: state.answers, scan };
}

mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'sc-rec-'));
let failure = null;
try {
  const a = await record(run, 'a');
  const unexpected = a.scan.filter((hit) => !Object.hasOwn(KNOWN_OPEN, hit.file));
  if (unexpected.length) throw new Error(`Node left a value readable:\n${unexpected.map((hit) => `${hit.file}@${hit.offset} (${hit.encoding} of ${hit.value})`).join('\n')}`);
  const unscripted = a.calls.filter((c) => !c.key || Object.hasOwn(c, 'text'));
  if (unscripted.length) throw new Error(`unscripted provider calls:\n${JSON.stringify(unscripted, null, 1)}`);
  const b = await record(run, 'b');
  const view = (r) => JSON.stringify({ calls: r.calls, answers: r.answers, scan: r.scan }, null, 1);
  if (view(a) !== view(b)) {
    writeFileSync(join(run, 'a.json'), view(a));
    writeFileSync(join(run, 'b.json'), view(b));
    throw new Error(`two recordings differ (${join(run, 'a.json')} against b.json)`);
  }
  const golden = {
    note: 'what Node (b6f10295a with the sensitive-value patches) sent its model per provider call, as the conversation, the call\'s place in it, whether each code is there in plain and how many markers it holds; the Lead answers; and the search of every file under its profile for the codes (hits only in knownOpen)',
    codes: CODES,
    knownOpen: KNOWN_OPEN,
    calls: a.calls,
    answers: a.answers,
    scan: a.scan,
  };
  const finalDir = join(FIXTURES_ROOT, 'sensitive-carry');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), golden);
  const patches = identity.patches.map((p) => `benchmarks/rust-core/recorders/node-patches/${p.file}`);
  writeSetManifest(stage, {
    set: 'sensitive-carry',
    recorder,
    command: `MIXDOG_RECORDER_SCRATCH=<scratch parent> node ${recorder} --tree <export of ${NODE_COMMIT} with the patches applied> --patch ${patches.join(',')}`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url, patches),
      recorded: { tree: `export of ${NODE_COMMIT} with ${identity.patches.map((p) => `${p.file} (sha256 ${p.sha256})`).join(', then ')} applied`, scenario: 'lib/sensitive-carry-scenario.mjs' },
      compared: 'per provider call (ordered by conversation and place, the conversations run at once): the plain presence of each code and the number of markers; the scan of the profile for every spelling of the codes (lib/sensitive-writes-files.mjs scanSecrets)',
    },
  });
  commitStage(stage, finalDir);
  console.log(`calls=${golden.calls.length}`);
} catch (error) {
  failure = error;
}
if (failure) {
  console.error(`the run's folder ${run} is kept`);
  throw failure;
}
rmSync(run, { recursive: true, force: true });
process.exit(0);
