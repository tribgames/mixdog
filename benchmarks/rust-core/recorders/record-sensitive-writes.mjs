#!/usr/bin/env node
// Records every file Node writes, and what its model is sent, for a conversation that holds values marked sensitive
// (lib/sensitive-writes-scenario.mjs): real createSession / askSession turns over a scripted provider (only its `send` is
// scripted) and a fake desktop browser bridge (the discovery file and its `/command` endpoint, answering per
// `browserAnswer`), a manual compaction (`compactSessionMessages`), the end of the process with the memory ingest of the
// loaded session (`createMemoryIngest` of session-runtime/lifecycle/memory-ingest.mjs, the function the runtime's teardown
// calls, `teardown.mjs:192`, over a memory module that records what it is handed), and, in a second process, the reload
// (`resumeSession`) and one more turn.
//
// The tree is the export of b6f10295a with the Node fixes of the sensitive writes applied in order (`--patch`, the shared
// option of lib/common.mjs `patchedProductIdentity`): node-patches/node-fix-sensitive-side-writes.patch (the trace, the
// tool-failure log, the memory ingest) and node-patches/node-fix-sensitive-header-summary.patch (the session header's title
// and repeat-failure guards, the session summary index).
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> node benchmarks/rust-core/recorders/record-sensitive-writes.mjs --tree <tree> --patch <patch>,<patch>
//
// Output: native/core/fixtures/sensitive-writes/golden.json (+ MANIFEST.json).
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CODE, FAILED, MODEL, REPLIES, SECRET, TURNS, browserAnswer } from './lib/sensitive-writes-scenario.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-sensitive-writes.mjs';
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 300_000;
/** Files Node writes that the core does not write at all: listed, searched for the values, not compared. */
const NO_CORE_COUNTERPART = {
  'mixdog_data_dir/history/agent-trace.jsonl': 'the agent trace: the core writes none (a known gap)',
  'mixdog_data_dir/prompt-cache-idle-gaps.json': "the prompt cache's idle-gap statistics: the core keeps none",
};
/** Files both write that this recording cannot compare: listed, searched for the values, not compared. */
const NOT_COMPARED = {
  'mixdog_data_dir/gateway-usage.local.jsonl':
    "usage telemetry, no session content: Node buffers its rows and flushes them on a timer (route-meta.mjs recordGatewayUsageEvent), so a phase's process that exits first loses them; this recording keeps only the last turn's row",
};
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

if (process.argv[2] === '--child') {
  const phase = Number(process.argv[3]);
  const tree = process.env.RECORDER_TREE;
  const WORKSPACE = process.env.RECORDER_WORKSPACE;
  const STATE = process.env.RECORDER_STATE;
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  const S = 'src/runtime/agent/orchestrator/';
  if (phase === 3) {
    // Reads only: the folded summary index, by the readers' own replay of the delta log over the base.
    const { applySummaryLogText } = await imp(`${S}session/store-summary-log.mjs`);
    const { _normalizeSummaryIndex, summaryIndexPath } = await imp(`${S}session/store-summary-index.mjs`);
    const { summaryLogPath } = await imp(`${S}session/store-summary-log.mjs`);
    const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');
    const base = read(summaryIndexPath());
    const state = JSON.parse(readFileSync(STATE, 'utf8'));
    state.summaryIndex = _normalizeSummaryIndex(applySummaryLogText(base ? JSON.parse(base) : {}, read(summaryLogPath(summaryIndexPath()))));
    // The session as a reader loads it from its log (the record split depends on when the debounced saves and the redaction
    // rewrite ran; the folded session does not).
    const { getStoreDir } = await imp(`${S}session/store/session-paths.mjs`);
    const { storedSessionSync } = await imp(`${S}session/store/stored-session.mjs`);
    state.storedSession = storedSessionSync(getStoreDir(), state.sessionId, false);
    writeFileSync(STATE, JSON.stringify(state));
    process.exit(0);
  }
  const { createSession, resumeSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
  const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
  const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
  const { modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
  const { sessionOptions } = await imp('src/session-runtime/session-create/session-options.mjs');
  const { workflowHelpers } = await imp('src/session-runtime/boot/shared.mjs');
  const { createMemoryIngest } = await imp('src/session-runtime/lifecycle/memory-ingest.mjs');
  const { stopOwnedPgForShutdown } = await imp('src/runtime/memory/lib/pg/supervisor.mjs');
  const { backfillSessionSearch } = await imp('src/runtime/session-search/session-search-ingest.mjs');
  const cfgMod = await imp(`${S}config.mjs`);
  const mgr = await imp(`${S}session/manager.mjs`);
  // The desktop tools of the session runtime (boot/tools.mjs wireInternalTools): the `browser` tool and `handoff_user`, with
  // the product's own handlers (internal-tool-executor/bridge-tools.mjs, ask-user-tool.mjs), under the session's MCP scope.
  const { setInternalToolsProvider } = await imp(`${S}internal-tools.mjs`);
  const { TOOL_DEFS: BROWSER_TOOL_DEFS } = await imp('src/runtime/browser-bridge/tool-defs.mjs');
  const { HANDOFF_USER_TOOL_DEFS } = await imp(`${S}runtime-core/ask-user-tool-defs.mjs`);
  const { createBridgeToolHandlers } = await imp('src/session-runtime/internal-tool-executor/bridge-tools.mjs');
  const { createAskUserToolHandlers } = await imp('src/session-runtime/internal-tool-executor/ask-user-tool.mjs');
  const scopeId = 'sensitive-writes-scope';
  const rt = { currentCwd: WORKSPACE, mcpScopeId: scopeId, session: null };
  const handlers = { ...createBridgeToolHandlers({ rt }), ...createAskUserToolHandlers({ rt }) };
  setInternalToolsProvider({
    scopeId,
    tools: [...BROWSER_TOOL_DEFS.filter((tool) => tool.name === 'browser'), ...HANDOFF_USER_TOOL_DEFS],
    executor: (name, args, callerCtx = {}) => handlers[name](args, { name, callerCtx, callerCwd: WORKSPACE }),
  });

  // The desktop's browser bridge: the discovery file Node reads (bridge-discovery.mjs) and the `/command` endpoint it posts to.
  const commands = [];
  const token = 'bridge-token-sensitive-writes';
  const bridge = createServer((req, res) => {
    const body = [];
    req.on('data', (d) => body.push(d));
    req.on('end', () => {
      const command = JSON.parse(Buffer.concat(body).toString('utf8'));
      commands.push(command);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(browserAnswer(command)));
    });
  });
  await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
  writeFileSync(join(process.env.MIXDOG_BRIDGE_DISCOVERY_DIR, 'browser-bridge.json'), JSON.stringify({ version: 1, port: bridge.address().port, token, pid: process.pid }));

  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { sends: [], approvals: [], commands: [], answers: [], ingests: [], compaction: null };
  const providerName = 'sensitive-writes';
  const reply = (step) => ({
    content: step.text,
    ...(step.calls.length ? { toolCalls: step.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })), stopReason: 'tool_use' } : {}),
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages) {
      state.sends.push({ phase, messages: JSON.parse(JSON.stringify(messages)) });
      const step = REPLIES[state.sends.length - 1];
      if (!step) throw new Error(`no scripted reply for send ${state.sends.length}`);
      return JSON.parse(JSON.stringify(reply(step)));
    },
  };
  const onToolApproval = async (request) => {
    state.approvals.push(JSON.parse(JSON.stringify(request)));
    return request?.name === 'handoff_user' ? { approved: true, response: 'provide-secret' } : { approved: true };
  };
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    let sessionId = state.sessionId;
    if (phase === 1) {
      const built = sessionOptions(
        {
          rt: { route: { provider: providerName, model: MODEL }, config: {}, mode: 'full', toolProfile: 'interactive', sessionProfile: null, currentCwd: WORKSPACE, mcpScopeId: scopeId },
          cfgMod,
          activeWorkflowContext: workflowHelpers.activeWorkflowContext,
          schemaAllowedTools: modelToolSchemaAllowlist('interactive'),
          featureDisallowedTools: () => [],
        },
        null
      );
      const session = createSession(built);
      rt.session = session;
      sessionId = session.id;
      state.sessionId = sessionId;
    } else {
      const resumed = await resumeSession(sessionId, 'full', { mcpScopeId: scopeId });
      if (!resumed) throw new Error(`the session ${sessionId} did not resume`);
      rt.session = resumed;
    }
    for (const turn of TURNS.filter((t) => t.phase === phase)) {
      const answer = await deadline(askSession(sessionId, turn.prompt, null, null, null, null, { onToolApproval }), 120_000, `the turn "${turn.prompt}"`);
      state.answers.push(answer?.content ?? null);
    }
    if (phase === 1) {
      const result = await deadline(mgr.compactSessionMessages(sessionId, {}), 120_000, 'the compaction');
      state.compaction = result ? { changed: result.changed ?? null, error: result.error ? String(result.error?.message ?? result.error) : null, skipped: result.skipped ?? null, reason: result.reason ?? null } : null;
      // The end of the process: the runtime's teardown ingests the loaded session into memory (teardown.mjs:192) through
      // `createMemoryIngest`; its memory module records what it is handed, which is what reaches the memory database.
      const ingest = createMemoryIngest({
        getMemoryModPromise: () => Promise.resolve({ handleToolCall: async (name, args) => { state.ingests.push({ name, args: JSON.parse(JSON.stringify(args)) }); } }),
        getCurrentCwd: () => WORKSPACE,
        withTeardownDeadline: (promise) => promise,
      });
      await ingest(mgr.getSession(sessionId));
    }
  });
  // The search copy: the stored-session backfill every runtime runs once (session-search-ingest.mjs), awaited, which also waits
  // for the session's per-turn ingests queued before it (they run one at a time, in order).
  await deadline(backfillSessionSearch(), 120_000, 'the session-search backfill');
  state.commands.push(...commands.map((c) => ({ phase, ...c })));
  bridge.close();
  rmSync(join(process.env.MIXDOG_BRIDGE_DISCOVERY_DIR, 'browser-bridge.json'), { force: true });
  await stopOwnedPgForShutdown({ timeoutMs: 120_000 });
  writeFileSync(STATE, JSON.stringify(state));
  // An ordinary exit, whose `exit` hooks write what is still queued (the trace, the failure log).
  process.exit(0);
}

const { recorderProvenance } = await import('./lib/provenance.mjs');
const { FIXTURES_ROOT, commitStage, parseArgs, patchedProductIdentity, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const { normalizeTree, scanSecrets } = await import('./lib/sensitive-writes-files.mjs');
const args = parseArgs();
for (const name of args.keys()) if (!['tree', 'patch'].includes(name)) throw new Error(`unknown option --${name} (known: --tree, --patch)`);
const tree = resolveTree(args);
if (!args.get('patch')) throw new Error('pass --patch node-patches/node-fix-sensitive-side-writes.patch,node-patches/node-fix-sensitive-header-summary.patch');
const identity = patchedProductIdentity(tree, NODE_COMMIT, args.get('patch'));
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent (under D:\\mixdog-build\\tmp\\<slot>)');

const PROFILE_DIRS = ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'];

async function runPhase(label, phase, sandbox, workspace) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, RECORDER_WORKSPACE: workspace, RECORDER_STATE: join(sandbox, 'state.json'), MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_BRIDGE_DISCOVERY_DIR: join(sandbox, 'bridge') };
  for (const name of PROFILE_DIRS) env[name] = join(sandbox, 'profile', name.toLowerCase());
  for (const dir of [env.MIXDOG_BRIDGE_DISCOVERY_DIR, ...PROFILE_DIRS.map((n) => env[n])]) mkdirSync(dir, { recursive: true });
  const report = join(sandbox, `job-${phase}.json`);
  const child = spawnInJob(process.execPath, [SELF, '--child', String(phase)], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], report });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let result;
  try {
    result = await deadline(exited, DEADLINE_MS, `recording ${label} phase ${phase}`);
  } catch (error) {
    child.kill();
    await deadline(exited, 30_000, `recording ${label} ending after its kill`);
    throw new Error(`${error.message}\n${output}`);
  }
  const job = readJobReport(report);
  if (result.code !== job.exitCode || job.exitCode !== 0) throw new Error(`recording ${label} phase ${phase} failed (${result.code ?? result.signal}, the program's ${job.exitCode}):\n${output}`);
  return { env, output, left: job.left };
}

/** One recording in its own profile: both phases, then every file under the profile, normalised. */
async function record(label, run, workspace) {
  const sandbox = join(run, label);
  mkdirSync(sandbox, { recursive: true });
  const one = await runPhase(label, 1, sandbox, workspace);
  const two = await runPhase(label, 2, sandbox, workspace);
  const state = JSON.parse(readFileSync(join(sandbox, 'state.json'), 'utf8'));
  const profile = join(sandbox, 'profile');
  // The summary index as every reader sees it (the delta log replayed over the base), read by Node's own code in a process of
  // the same profile after both phases have exited (the exit drain appends to the log).
  const folding = await runPhase(label, 3, sandbox, workspace);
  const scan = scanSecrets(profile, [CODE, FAILED, SECRET]);
  const { summaryIndex, storedSession } = JSON.parse(readFileSync(join(sandbox, 'state.json'), 'utf8'));
  const normalized = normalizeTree(profile, { sessionId: state.sessionId, workspace });
  normalized.files['mixdog_data_dir/session-summaries (folded)'] = normalized.maskValue(summaryIndex);
  normalized.files['mixdog_data_dir/sessions/<session> (folded)'] = normalized.maskValue(storedSession);
  return { state, normalized, scan, outputs: [one.output, two.output, folding.output], left: [one.left, two.left] };
}

mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'sw-rec-'));
const workspace = join(run, 'ws');
mkdirSync(workspace);
let failure = null;
try {
  const a = await record('a', run, workspace);
  if (a.scan.length) throw new Error(`Node left a sensitive value readable:\n${a.scan.map((hit) => `${hit.file}@${hit.offset} (${hit.encoding} of ${hit.value})`).join('\n')}`);
  const b = await record('b', run, workspace);
  const view = (r) => JSON.stringify({ files: r.normalized.files, scan: r.scan, state: r.normalized.maskValue({ ...r.state, sessionId: undefined }) }, null, 1);
  if (view(a) !== view(b)) {
    writeFileSync(join(run, 'a.json'), view(a));
    writeFileSync(join(run, 'b.json'), view(b));
    throw new Error(`two recordings differ after the stated normalisation (${join(run, 'a.json')} against b.json)`);
  }
  const masked = a.normalized.maskValue({ ...a.state, sessionId: undefined });
  const golden = {
    note: 'every file Node (b6f10295a with node-fix-sensitive-side-writes.patch, then node-fix-sensitive-header-summary.patch) wrote under its profile for lib/sensitive-writes-scenario.mjs, recorded twice and normalised by lib/sensitive-writes-files.mjs; what its model was sent per provider call; the bridge commands; the memory ingest it handed the memory module',
    values: { CODE, FAILED, SECRET },
    files: a.normalized.files,
    noCoreCounterpart: NO_CORE_COUNTERPART,
    notCompared: NOT_COMPARED,
    normalisation: a.normalized.names,
    sends: masked.sends,
    approvals: masked.approvals,
    commands: masked.commands,
    answers: masked.answers,
    compaction: masked.compaction,
    ingests: masked.ingests,
  };
  const finalDir = join(FIXTURES_ROOT, 'sensitive-writes');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), golden);
  writeSetManifest(stage, {
    set: 'sensitive-writes',
    recorder,
    command: `MIXDOG_RECORDER_SCRATCH=<scratch parent> node ${recorder} --tree <export of ${NODE_COMMIT} with the patches applied> --patch ${identity.patches.map((p) => `benchmarks/rust-core/recorders/node-patches/${p.file}`).join(',')}`,
    identity,
    extra: {
      ...recorderProvenance(import.meta.url, identity.patches.map((p) => `benchmarks/rust-core/recorders/node-patches/${p.file}`)),
      noCoreCounterpart: NO_CORE_COUNTERPART,
      notCompared: NOT_COMPARED,
      recorded: { tree: `export of ${NODE_COMMIT} with ${identity.patches.map((p) => `${p.file} (sha256 ${p.sha256})`).join(', then ')} applied`, scenario: 'lib/sensitive-writes-scenario.mjs' },
      normalised: 'lib/sensitive-writes-files.mjs: the session id as <session>, the workspace as <ws>, the profile folder as <profile>, every other run-specific id (uuid, prefixed random id) as <id:N> by first appearance in file order, every ISO time as <iso> and every epoch time in milliseconds as <ms>, file names with the same substitutions; a binary file (SQLite, WAL) is listed by name and size only and searched for the values',
    },
  });
  commitStage(stage, finalDir);
  console.log(`files=${Object.keys(golden.files).length} sends=${golden.sends.length}`);
} catch (error) {
  failure = error;
}
if (failure) {
  console.error(`the run's folder ${run} is kept`);
  throw failure;
}
rmSync(run, { recursive: true, force: true });
process.exit(0);
