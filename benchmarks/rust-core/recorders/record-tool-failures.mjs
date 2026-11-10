#!/usr/bin/env node
// Records `history/tool-failures.jsonl` as Node's production path writes it: real `askSession` turns (the loop, the tool
// executor, `traceAgentTool` -> `traceAgentToolFailure` -> the buffered writer of agent-trace-io.mjs, flushed by its exit hook) against
// a scripted provider (only the provider's `send` is scripted), over every class of failed call the contract names. The scenarios
// are lib/tool-failure-scenarios.mjs, the same file the Rust replay (replay-tool-failures.mjs) is given.
//
// The turns run in a child process, twice, in two fresh profiles but the same workspace path (the workspace path is part of the
// rows: it is `cwd` and it is inside the tool texts). Each recording's rows are normalised by lib/tool-failure-rows.mjs (session ids
// by scenario, ts, tool_ms, the workspace): the two must then be identical, and the golden holds them, so two runs of this recorder
// write the same bytes.
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> node benchmarks/rust-core/recorders/record-tool-failures.mjs --tree <exact export of b6f10295a with node_modules> [--only <n>,<n>]
//
// Output: native/core/fixtures/tool-failures/golden.json (+ MANIFEST.json); with --only the scenarios named are recorded and printed.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-tool-failures.mjs';
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
const SCENARIOS_FILE = fileURLToPath(new URL('./lib/tool-failure-scenarios.mjs', import.meta.url));
const ROWS_FILE = fileURLToPath(new URL('./lib/tool-failure-rows.mjs', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 300_000;
// Both recordings run in one workspace folder (its path is part of the rows), made fresh for this run and removed once at its end;
// the child is given it and clears only what is inside it between scenarios.
const WORKSPACE = process.argv[2] === '--child' ? process.env.RECORDER_WORKSPACE : null;
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
const { FILES, MODEL, scenarios } = await import('./lib/tool-failure-scenarios.mjs');

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  const S = 'src/runtime/agent/orchestrator/';
  const { createSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
  const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
  const { abortSessionTurn } = await imp(`${S}session/manager/session-close.mjs`);
  const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
  const { modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
  const { makeInvalidToolArgsMarker } = await imp(`${S}providers/lib/openai-tool-args.mjs`);
  const { setInternalToolsProvider } = await imp(`${S}internal-tools.mjs`);
  const { connectMcpServers, disconnectAll } = await imp(`${S}mcp/client.mjs`);
  const { stopOwnedPgForShutdown } = await imp('src/runtime/memory/lib/pg/supervisor.mjs');
  const { createStandaloneAgent } = await imp('src/session-runtime/services/agent-tool.mjs');
  const cfgMod = await imp(`${S}config.mjs`);
  const reg = await imp(`${S}providers/registry.mjs`);
  const mgr = await imp(`${S}session/manager.mjs`);

  const reply = (step) => ({
    content: step.text,
    ...(step.calls.length
      ? {
          toolCalls: step.calls.map((c) => ({
            id: c.id,
            name: c.name,
            // The provider's own parse of an argument text that is not JSON (parseCompletedToolCallArgumentsJson).
            arguments: c.raw === undefined ? c.args : makeInvalidToolArgsMarker(c.raw, parseError(c.raw)),
          })),
          stopReason: 'tool_use',
        }
      : {}),
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const parseError = (raw) => {
    try {
      JSON.parse(raw);
    } catch (error) {
      return error.message;
    }
    throw new Error(`${raw} parses`);
  };
  const results = [];
  for (const [index, scenario] of scenarios(WORKSPACE).entries()) {
    if (process.env.RECORDER_ONLY && !process.env.RECORDER_ONLY.split(',').map(Number).includes(index)) {
      results.push(null);
      continue;
    }
    for (const entry of readdirSync(WORKSPACE)) rmSync(join(WORKSPACE, entry), { recursive: true, force: true });
    for (const [name, text] of Object.entries(FILES)) writeFileSync(join(WORKSPACE, name), text);
    const providerName = `tool-failures-${index}`;
    const sends = [];
    const provider = {
      name: providerName,
      contextWindow: 128000,
      async send(messages) {
        sends.push(messages.map((m) => ({ role: m.role, content: m.content })));
        return JSON.parse(JSON.stringify(reply(scenario.replies[sends.length - 1])));
      },
    };
    let sessionId;
    let outcome;
    const scopeId = `tool-failures-scope-${index}`;
    const disposers = [];
    await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
      // The headless allowlist has no skill, delegated-agent or MCP tools: a `full` scenario gets the whole surface, with the agent tool the
      // way headless-role.mjs builds it (real modules, no boot) and the stdio server `fx` connected under the session's MCP scope.
      const session = scenario.full
        ? createSession({ provider: providerName, model: MODEL, cwd: WORKSPACE, mcpScopeId: scopeId })
        : createSession({ provider: providerName, model: MODEL, cwd: WORKSPACE, skipSkills: true, schemaAllowedTools: modelToolSchemaAllowlist('headless'), workflow: { id: 'headless', delegatesAgents: false } });
      sessionId = session.id;
      if (scenario.full) {
        const agentTool = createStandaloneAgent({ cfgMod: { loadConfig: cfgMod.loadConfig, resolveRuntimeSpec: cfgMod.resolveRuntimeSpec }, reg, mgr, dataDir: cfgMod.getPluginData(), cwd: WORKSPACE, mcpScopeId: scopeId });
        disposers.push(setInternalToolsProvider({ scopeId, tools: agentTool.tools, executor: (_name, toolArgs, callerCtx) => agentTool.execute(toolArgs, callerCtx) }));
        await connectMcpServers({ fx: { command: process.execPath, args: ['fx-mcp.mjs'], cwd: WORKSPACE } }, { scopeId });
      }
      if (scenario.hook) session.beforeToolHook = async () => scenario.hook;
      // The tool has started when it has made its file: a directory event, watched from before the turn starts so it cannot be missed.
      const toolStarted = scenario.abortWhenFile
        ? new Promise((resolve) => {
            const watcher = watch(WORKSPACE, (_event, name) => {
              if (name !== scenario.abortWhenFile) return;
              watcher.close();
              resolve();
            });
            disposers.push(() => watcher.close());
          })
        : null;
      const turn = askSession(session.id, 'go', null, null, null, null, scenario.approval ? { onToolApproval: async () => scenario.approval } : {});
      turn.catch(() => {});
      if (scenario.abortWhenFile) {
        await deadline(toolStarted, 60_000, `the tool of scenario ${index} creating ${scenario.abortWhenFile}`);
        abortSessionTurn(session.id);
      }
      try {
        outcome = { answer: (await turn).content };
      } catch (error) {
        outcome = { threw: error.message.split(sessionId).join('<session>') };
      }
      for (const dispose of disposers) dispose();
      if (scenario.full) await disconnectAll();
    });
    const toolMessages = sends.slice(1).map((messages) => {
      const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
      return messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
    });
    results.push({ name: scenario.name, session: sessionId, outcome, sends: sends.length, toolMessages });
  }
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'results.json'), JSON.stringify(results));
  // The memory database the session machinery started is stopped by the product's own stop, not left for the parent to find. The
  // stop first awaits a start still under way (its initdb included) for at most `timeoutMs` (supervisor.mjs:793-810): a first start
  // in a fresh profile runs initdb, which its 6 s default does not cover, and an initdb left running would outlive this process.
  await stopOwnedPgForShutdown({ timeoutMs: 120_000 });
  process.exit(0);
}

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { maskWorkspace, rowsByScenario } = await import('./lib/tool-failure-rows.mjs');
const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const tree = resolveTree(parseArgs(onlyAt >= 0 ? argv.filter((_, i) => i !== onlyAt && i !== onlyAt + 1) : argv));
const identity = exactProductIdentity(tree, NODE_COMMIT);
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Processes whose command line names `folder`, other than the lister itself: what a finished recording must not leave behind. */
function processesNaming(folder) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${folder.replace(/'/g, "''")}*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const listed = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0) throw new Error(`listing the processes that name ${folder} failed (${listed.status ?? listed.signal}): ${listed.stderr}`);
  return listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** One recording in its own profile under the run's folder; the child is ended only through the handle held here. */
async function record(label, run, workspace) {
  const sandbox = join(run, `profile-${label}`);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, RECORDER_WORKSPACE: workspace, MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_FEATURE_MEMORY: '0', ...(only ? { RECORDER_ONLY: only } : {}) };
  for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    env[name] = join(sandbox, name.toLowerCase());
    mkdirSync(env[name], { recursive: true });
  }
  const child = spawn(process.execPath, [SELF, '--child'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  if (result.code !== 0) throw new Error(`recording ${label} failed (${result.code ?? result.signal}):\n${output}`);
  const results = JSON.parse(readFileSync(join(env.MIXDOG_DATA_DIR, 'results.json'), 'utf8'));
  const sessions = results.map((r) => r?.session ?? null);
  const file = join(env.MIXDOG_DATA_DIR, 'history', 'tool-failures.jsonl');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // Each recording's own session ids, workspace and data folder become placeholders; what is left must be what the other recording wrote.
  const rows = rowsByScenario(text, sessions, workspace, env.MIXDOG_DATA_DIR);
  const masked = results.map((r, i) => (r === null ? null : JSON.parse(maskWorkspace(maskWorkspace(JSON.stringify({ ...r, session: undefined }), workspace), env.MIXDOG_DATA_DIR, '<DATA>').split(sessions[i]).join(`<session:${i}>`))));
  return { rows, results: masked };
}

// The run's own folder: both profiles and the workspace (`<run>\ws`, whose path and length are part of the rows) live in it, and it is
// removed once at the end, unless something still names it.
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent (under D:\\mixdog-build\\tmp\\<slot>); the replay is run with the same one');
mkdirSync(scratch, { recursive: true });
const run = mkdtempSync(join(scratch, 'tf-rec-'));
const workspace = join(run, 'ws');
mkdirSync(workspace);
let failure = null;
try {
  const a = await record('a', run, workspace);
  const b = await record('b', run, workspace);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`two recordings differ beyond the session ids, ts, tool_ms and the workspace:\n${JSON.stringify(a.rows)}\n${JSON.stringify(b.rows)}\n${JSON.stringify(a.results)}\n${JSON.stringify(b.results)}`);
  }
  const all = scenarios(workspace);
  const golden = {
    note: 'history/tool-failures.jsonl as the Node tool loop writes it (real askSession turns over a scripted provider), recorded twice at b6f10295a; rows normalised by lib/tool-failure-rows.mjs and grouped by scenario, in file order',
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
    const finalDir = join(FIXTURES_ROOT, 'tool-failures');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), golden);
    // Everything the recording was given that Node did not produce itself.
    const syntheticInputs = {
      provider: `a scripted provider (only its send is scripted; model ${MODEL}): the replies of each scenario in lib/tool-failure-scenarios.mjs`,
      scenarios: all.map((s) => ({ name: s.name, replies: s.replies.length, hook: s.hook ?? null, approval: s.approval ?? null, full: s.full === true, abortWhenFile: s.abortWhenFile ?? null })),
      hookDecisions: all.filter((s) => s.hook).map((s) => ({ scenario: s.name, ...s.hook })),
      approvalAnswers: all.filter((s) => s.approval).map((s) => ({ scenario: s.name, ...s.approval })),
      mcpServer: { file: 'fx-mcp.mjs', sha256: createHash('sha256').update(FILES['fx-mcp.mjs']).digest('hex'), tools: ['fail', 'boom', 'ok', 'big'] },
      workspaceFiles: Object.fromEntries(Object.entries(FILES).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])),
    };
    writeSetManifest(stage, {
      set: 'tool-failures',
      recorder,
      command: `MIXDOG_RECORDER_SCRATCH=<scratch parent> node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
      identity,
      extra: {
        rows: a.rows.flat().length,
        normalised: ['session_id', 'ts', 'tool_ms', 'workspace', 'data folder (with result_bytes_est counted on the masked text)'],
        node: process.version,
        recorderSha256: sha256(SELF),
        scenariosSha256: sha256(SCENARIOS_FILE),
        rowsLibSha256: sha256(ROWS_FILE),
        syntheticInputs,
      },
    });
    commitStage(stage, finalDir);
    console.log(`rows=${a.rows.map((r) => r.length).join(',')}`);
  }
} catch (error) {
  failure = error;
}
// Nothing may outlive the recording: a process still naming the run's folder fails it, and the folder is kept for a look.
const left = processesNaming(run);
if (left.length) {
  console.error(`processes still naming ${run}: ${left.join(', ')}; the folder is kept`);
  process.exitCode = 1;
} else if (failure) {
  console.error(`the run's folder ${run} is kept`);
} else {
  rmSync(run, { recursive: true, force: true });
}
if (failure) throw failure;
process.exit(process.exitCode ?? 0);

