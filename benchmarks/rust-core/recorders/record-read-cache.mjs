#!/usr/bin/env node
// Records what the model is shown when a session's tool results are cached across its turns: Node's own `askSession` turns (the loop,
// the tool batch, the read cache of session/cache/read-cache.mjs, the read snapshots of tools/builtin/snapshot-store.mjs) over a
// scripted provider (only its `send` is scripted), several turns of ONE session with something between them: nothing, a write to the
// file on disk, a write by the session's own apply_patch, a manual compaction, the session's close and resume, the entry cap. The
// scenarios are lib/read-cache-scenarios.mjs, the same file the Rust replay (replay-read-cache.mjs) is given.
//
// Each scenario runs in a Node process of its own (a fresh profile, the same workspace path), twice; the two recordings must be
// identical once the workspace and the data folder are masked, and the golden holds them.
//
//   MIXDOG_RECORDER_SCRATCH=<scratch parent> node benchmarks/rust-core/recorders/record-read-cache.mjs --tree <exact export of b6f10295a with node_modules> --patch-bin <mixdog-patch executable> [--only <n>,<n>]
//
// Output: native/core/fixtures/read-cache/golden.json (+ MANIFEST.json); with --only the scenarios named are recorded and printed.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, MODEL, scenarios } from './lib/read-cache-scenarios.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-read-cache.mjs';
const SELF = fileURLToPath(import.meta.url);
const DEADLINE_MS = 300_000;
const deadline = (p, ms, what) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};

if (process.argv[2] === '--child') {
  const tree = process.env.RECORDER_TREE;
  const workspace = process.env.RECORDER_WORKSPACE;
  const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
  const S = 'src/runtime/agent/orchestrator/';
  const { createSession, resumeSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
  const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
  const { closeSession } = await imp(`${S}session/manager/session-close.mjs`);
  const { runSessionCompaction } = await imp(`${S}session/manager/compaction-runner.mjs`);
  const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
  const { HEADLESS_TOOL_PROFILE, modelToolSchemaAllowlist } = await imp(`${S}runtime-core/tool-profile.mjs`);
  const { sessionOptions } = await imp('src/session-runtime/session-create/session-options.mjs');
  const { workflowHelpers } = await imp('src/session-runtime/boot/shared.mjs');
  const { stopOwnedPgForShutdown } = await imp('src/runtime/memory/lib/pg/supervisor.mjs');
  const cfgMod = await imp(`${S}config.mjs`);
  const mgr = await imp(`${S}session/manager.mjs`);
  const readCache = await imp(`${S}session/cache/read-cache.mjs`);
  const scopedCache = await imp(`${S}session/cache/scoped-cache.mjs`);

  const scenario = scenarios()[Number(process.env.RECORDER_SCENARIO)];
  for (const entry of readdirSync(workspace)) rmSync(join(workspace, entry), { recursive: true, force: true });
  for (const [name, text] of Object.entries({ ...FILES, ...scenario.files })) writeFileSync(join(workspace, name), text);
  const reply = (step) => ({
    content: step.text,
    ...(step.calls.length ? { toolCalls: step.calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args })), stopReason: 'tool_use' } : {}),
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const providerName = 'read-cache';
  let queue = [];
  let sends = [];
  let sent = 0;
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages) {
      sent += 1;
      const lastAssistant = messages.map((m) => m.role).lastIndexOf('assistant');
      if (lastAssistant >= 0) sends.push(messages.slice(lastAssistant + 1).filter((m) => m.role === 'tool').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))));
      return JSON.parse(JSON.stringify(reply(queue.shift())));
    },
  };
  const turns = [];
  const steps = [];
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
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
    for (const phase of scenario.phases) {
      if (phase.direct) {
        const sessionId = 'direct-session';
        const looks = [];
        const readArgs = { path: 'a.txt' };
        const listArgs = { path: '.' };
        for (const op of phase.direct) {
          if (op.close) readCache.clearReadDedupSession(sessionId);
          else if (op.fill === 'read') readCache.setReadCached({ sessionId, args: readArgs, cwd: workspace, content: op.content, toolUseId: op.id });
          else if (op.fill === 'list') scopedCache.setScopedToolCached({ sessionId, toolName: 'list', args: listArgs, cwd: workspace, content: op.content, toolUseId: op.id });
          else {
            const hit = op.look === 'read' ? readCache.tryReadCached({ sessionId, args: readArgs, cwd: workspace }) : scopedCache.tryScopedToolCached({ sessionId, toolName: 'list', args: listArgs, cwd: workspace });
            looks.push(hit ? { content: hit.content, firstToolUseId: hit.firstToolUseId } : null);
          }
        }
        steps.push({ direct: looks });
      } else if (phase.turn) {
        queue = [...phase.turn];
        sends = [];
        let outcome;
        try {
          outcome = { answer: (await askSession(session.id, `go ${turns.length + 1}`, null, null, null, null, {})).content };
        } catch (error) {
          outcome = { threw: error.message.split(session.id).join('<session>') };
        }
        turns.push({ outcome, sends, unused: queue.length });
      } else if (phase.write) {
        writeFileSync(join(workspace, phase.write.file), phase.write.text);
        steps.push({ write: phase.write.file });
      } else if (phase.compact) {
        queue = [{ text: 'SUMMARY', calls: [] }];
        sent = 0;
        const result = await runSessionCompaction(mgr.loadSession(session.id), { mode: 'manual', force: true, provider, sessionId: session.id });
        steps.push({ compact: { changed: result?.changed ?? null, reason: result?.reason ?? null, skipped: result?.skipped ?? null, error: result?.error ?? null, providerCalls: sent } });
      } else if (phase.close) {
        const closed = await closeSession(session.id, 'resume-away', { tombstone: false });
        // The runtime entry of the closed session is cleared on the next tick (teardownSessionRuntime's setImmediate); a resume comes after it.
        await new Promise((resolve) => setImmediate(resolve));
        const resumed = await resumeSession(session.id, built.preset ?? 'full');
        steps.push({ close: closed, resumed: resumed !== null });
      }
    }
  });
  await stopOwnedPgForShutdown({ timeoutMs: 120_000 });
  writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'results.json'), JSON.stringify({ name: scenario.name, session: null, turns, steps }));
  process.exit(0);
}

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const { maskWorkspace } = await import('./lib/tool-failure-rows.mjs');
const { readJobReport, spawnInJob } = await import('./lib/job-run.mjs');
const argv = process.argv.slice(2);
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? argv[onlyAt + 1] : null;
const cli = parseArgs(onlyAt >= 0 ? argv.filter((_, i) => i !== onlyAt && i !== onlyAt + 1) : argv);
const tree = resolveTree(cli);
const patchBin = cli.get('patch-bin');
if (!patchBin) throw new Error('--patch-bin <mixdog-patch executable> is required: the engine Node\'s apply_patch runs on (an installed product ships it; a source tree downloads it in the background)');
const identity = exactProductIdentity(tree, NODE_COMMIT);
const scratch = process.env.MIXDOG_RECORDER_SCRATCH;
if (!scratch) throw new Error('MIXDOG_RECORDER_SCRATCH must name the scratch parent (under C:\\mixdog-build\\tmp\\<slot>); the replay is run with the same one');
const SCENARIO_COUNT = scenarios().length;
const selected = only ? only.split(',').map(Number) : [...Array(SCENARIO_COUNT).keys()];

async function recordScenario(label, index, run, workspace) {
  const sandbox = join(run, `profile-${label}-${index}`);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, RECORDER_TREE: tree, RECORDER_WORKSPACE: workspace, RECORDER_SCENARIO: String(index), MIXDOG_SKIP_USER_DATA_BACKUP: '1', MIXDOG_FEATURE_MEMORY: '0', MIXDOG_PATCH_NATIVE_BIN: patchBin };
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
    result = await deadline(exited, DEADLINE_MS, `recording ${label} ${index}`);
  } catch (error) {
    child.kill();
    await deadline(exited, 30_000, `recording ${label} ${index} ending after its kill`);
    throw new Error(`${error.message}\n${output}`);
  }
  const job = readJobReport(report);
  if (result.code !== job.exitCode || job.exitCode !== 0) throw new Error(`recording ${label} ${index} failed (${result.code ?? result.signal}, the program's ${job.exitCode}):\n${output}`);
  const text = readFileSync(join(env.MIXDOG_DATA_DIR, 'results.json'), 'utf8');
  return JSON.parse(maskWorkspace(maskWorkspace(text, workspace), env.MIXDOG_DATA_DIR, '<DATA>'));
}

const run = mkdtempSync(join(scratch, 'rc-rec-'));
const workspace = join(run, 'ws');
mkdirSync(workspace);
let failure = null;
try {
  const record = async (label) => {
    const out = Array(SCENARIO_COUNT).fill(null);
    for (const index of selected) out[index] = await recordScenario(label, index, run, workspace);
    return out;
  };
  const a = await record('a');
  const b = await record('b');
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`two recordings differ:\n${JSON.stringify(a, null, 1)}\n${JSON.stringify(b, null, 1)}`);
  const golden = {
    note: 'what the model is shown by Node\'s read cache over several turns of one session (real askSession turns over a scripted provider), recorded twice at b6f10295a',
    workspaceLength: workspace.length,
    model: MODEL,
    files: FILES,
    scenarios: scenarios(),
    results: a,
  };
  if (only) {
    console.log(JSON.stringify(golden.results, null, 1));
  } else {
    const finalDir = join(FIXTURES_ROOT, 'read-cache');
    const stage = stageSet(finalDir);
    writeJson(join(stage, 'golden.json'), golden);
    writeSetManifest(stage, {
      set: 'read-cache',
      recorder,
      command: `MIXDOG_RECORDER_SCRATCH=<scratch parent> node ${recorder} --tree <exact export of ${NODE_COMMIT}> --patch-bin <mixdog-patch executable>`,
      identity,
      extra: {
        ...recorderProvenance(import.meta.url),
        normalised: ['workspace folder (every spelling) as <WS>', 'the profile data folder as <DATA>'],
        syntheticInputs: {
          provider: `a scripted provider (only its send is scripted; model ${MODEL}): the replies of each scenario in lib/read-cache-scenarios.mjs`,
          sessionBuilderInputs: 'sessionOptions with the headless tool profile, skipSkills true and workflow { id: headless, delegatesAgents: false }',
          workspaceFiles: Object.fromEntries(Object.entries(FILES).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])),
          patchBinary: { givenAs: 'MIXDOG_PATCH_NATIVE_BIN (the engine apply_patch runs on)', sha256: createHash('sha256').update(readFileSync(patchBin)).digest('hex') },
          betweenTurns: 'write: the file rewritten on disk by the recorder; compact: runSessionCompaction(session, { mode: manual, force: true, provider }); close: closeSession(id, resume-away, { tombstone: false }) then the next askSession on the same id; direct: setReadCached / tryReadCached / setScopedToolCached / tryScopedToolCached / clearReadDedupSession called in the recorded order under one session id',
        },
        node: process.version,
      },
    });
    commitStage(stage, finalDir);
    console.log('recorded', a.length, 'scenarios');
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
