// Standalone agent surfaces, channel worker daemon environment, and async
// completion notification routing. Also the headless exec CLI parser.
import './_env.mjs';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './_env.mjs';
import { waitFor } from './_helpers.mjs';
import { parseHeadlessExecCommand } from '../../src/app.mjs';
import { AGENT_TOOL, createStandaloneAgent } from '../../src/standalone/agent-tool.mjs';
import { createStandaloneChannelWorker } from '../../src/standalone/channel-worker.mjs';
import { initProviders } from '../../src/runtime/agent/orchestrator/providers/registry.mjs';

test('headless exec parser accepts exec form and rejects legacy shapes', () => {
  const command = parseHeadlessExecCommand([
    'exec', '--provider', 'openai-oauth', '--model', 'gpt-test', 'check', 'this',
  ]);
  if (command?.message !== 'check this') {
    throw new Error(`headless exec command parse failed: ${JSON.stringify(command)}`);
  }
  const missing = parseHeadlessExecCommand(['exec']);
  if (!missing?.error || !/mixdog exec/.test(missing.error)) {
    throw new Error(`headless exec without a message must be rejected: ${JSON.stringify(missing)}`);
  }
  const tuiDefault = parseHeadlessExecCommand([]);
  if (tuiDefault !== null) {
    throw new Error(`empty argv must keep TUI default: ${JSON.stringify(tuiDefault)}`);
  }
  const legacyRole = parseHeadlessExecCommand(['reviewer', 'check', 'this']);
  if (legacyRole !== null) {
    throw new Error(`legacy role shorthand must not enter headless exec: ${JSON.stringify(legacyRole)}`);
  }
});

test('agent tool keeps its async tagged delegation description', () => {
  if (!/background tasks/i.test(AGENT_TOOL.description || '')
    || !/same-tag spawn respawns/i.test(AGENT_TOOL.description || '')
    || !/spawn\/send return task_id immediately/i.test(AGENT_TOOL.description || '')) {
    throw new Error('agent description must preserve async tagged delegation contract');
  }
});

test('agent read/list errors surface as Error results without runtime resolve', async () => {
  const agentSmoke = createStandaloneAgent({
    cfgMod: {
      loadConfig: () => ({ providers: {}, presets: [] }),
      resolveRuntimeSpec: () => { throw new Error('agent smoke should not resolve runtime for read/list errors'); },
    },
    reg: { initProviders: async () => {} },
    mgr: {
      getSession: () => null,
      listSessions: () => [],
      closeSession: () => false,
    },
    dataDir: root,
    cwd: root,
    defaultMode: 'async',
  });
  const agentMissingJob = await agentSmoke.execute({ type: 'read', task_id: 'task_missing_smoke' }, { invocationSource: 'model-tool', cwd: root });
  if (!/^Error[\s:[]/.test(String(agentMissingJob)) || !/task_missing_smoke/.test(String(agentMissingJob))) {
    throw new Error(`agent missing task must return Error result:\n${agentMissingJob}`);
  }
  const agentBadType = await agentSmoke.execute({ type: 'definitely_bad_type' }, { invocationSource: 'model-tool', cwd: root });
  if (!/^Error[\s:[]/.test(String(agentBadType)) || !/unknown type/i.test(String(agentBadType))) {
    throw new Error(`agent unknown type must return Error result:\n${agentBadType}`);
  }
  agentSmoke.closeAll('tool-contracts-agent-errors-complete');
});

test('channel worker daemon spawn env advertises host identity', async () => {
  const channelWorkerTmp = mkdtempSync(join(tmpdir(), 'mixdog-channel-worker-env-'));
  let channelEnvWorker = null;
  const prevDaemonHost = process.env.MIXDOG_DAEMON_HOST;
  const prevRuntimeRoot = process.env.MIXDOG_RUNTIME_ROOT;
  const prevEnvOut = process.env.SMOKE_CHANNEL_ENV_OUT;
  const prevDaemonEntry = process.env.MIXDOG_DAEMON_ENTRY;
  const prevSupervisorPid = process.env.MIXDOG_SUPERVISOR_PID;
  try {
    // Daemon-mode worker env coverage: start() spawn-or-attaches the machine
    // -global daemon (the stub daemon entry — no Discord token).
    // Assert the flags on the spawned daemon's environment.
    const stubEntry = join(root, 'scripts', 'daemon-stub.mjs');
    const dataDir = join(channelWorkerTmp, 'data');
    const runtimeDir = join(channelWorkerTmp, 'runtime');
    const envOut = join(channelWorkerTmp, 'env.json');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    process.env.MIXDOG_DAEMON_HOST = '1';
    process.env.MIXDOG_RUNTIME_ROOT = runtimeDir;
    process.env.SMOKE_CHANNEL_ENV_OUT = envOut;
    process.env.MIXDOG_DAEMON_ENTRY = stubEntry;
    process.env.MIXDOG_SUPERVISOR_PID = '2147483647';
    channelEnvWorker = createStandaloneChannelWorker({
      rootDir: root,
      dataDir,
      cwd: root,
      leadPid: process.pid,
    });
    await channelEnvWorker.start();
    const childEnv = JSON.parse(readFileSync(envOut, 'utf8'));
    if (childEnv.host !== '1') {
      throw new Error(`channel service smoke expected host=1, got ${childEnv.host}`);
    }
    if (childEnv.cliOwned !== '0') {
      throw new Error(`channel service must advertise owner HTTP (MIXDOG_CLI_OWNED=0), got ${childEnv.cliOwned}`);
    }
    if (Number(childEnv.supervisorPid) !== process.pid) {
      throw new Error(`channel service must replace a stale inherited supervisor PID with its live runtime PID, got ${childEnv.supervisorPid}`);
    }
    const identityProbe = await channelEnvWorker.execute('reload_config', {});
    if (Number(identityProbe?.leadPid) !== process.pid) {
      throw new Error(`channel client must register its live runtime PID, got ${identityProbe?.leadPid}`);
    }
  } finally {
    try { await channelEnvWorker?.stop?.('channel-worker-env-smoke', { force: true }); } catch {}
    if (prevDaemonHost == null) delete process.env.MIXDOG_DAEMON_HOST;
    else process.env.MIXDOG_DAEMON_HOST = prevDaemonHost;
    if (prevRuntimeRoot == null) delete process.env.MIXDOG_RUNTIME_ROOT;
    else process.env.MIXDOG_RUNTIME_ROOT = prevRuntimeRoot;
    if (prevEnvOut == null) delete process.env.SMOKE_CHANNEL_ENV_OUT;
    else process.env.SMOKE_CHANNEL_ENV_OUT = prevEnvOut;
    if (prevDaemonEntry == null) delete process.env.MIXDOG_DAEMON_ENTRY;
    else process.env.MIXDOG_DAEMON_ENTRY = prevDaemonEntry;
    if (prevSupervisorPid == null) delete process.env.MIXDOG_SUPERVISOR_PID;
    else process.env.MIXDOG_SUPERVISOR_PID = prevSupervisorPid;
    // Detach only ends OUR attachment; the stub daemon self-shuts after its
    // client-grace window. Give it that window before deleting its tmp root.
    await new Promise((resolveWait) => setTimeout(resolveWait, 700));
    rmSync(channelWorkerTmp, { recursive: true, force: true });
  }
});

test('agent completion notifications route to the owner exactly once', async () => {
  const agentNotifyTmp = mkdtempSync(join(tmpdir(), 'mixdog-agent-notify-'));
  let agentNotifySmoke = null;
  try {
    const ownerNotifications = [];
    const workerQueued = [];
    agentNotifySmoke = createStandaloneAgent({
      cfgMod: {
        loadConfig: () => ({
          default: 'sonnet-high',
          providers: { 'openai-oauth': { enabled: true } },
          presets: [
            { id: 'sonnet-high', name: 'sonnet-high', provider: 'openai-oauth', model: 'smoke-model', type: 'agent', tools: 'full' },
            { id: 'haiku', name: 'HAIKU', provider: 'openai-oauth', model: 'smoke-haiku', type: 'agent', tools: 'full' },
          ],
        }),
        resolveRuntimeSpec: () => ({ scopeKey: 'smoke-notify', lane: 'agent' }),
      },
      reg: { initProviders },
      mgr: {
        askSession: async (sessionId, _prompt, _context, _onToolCall, _cwdOverride, _prefetch, askOpts = {}) => {
          const nestedText = `background task\ntask_id: task_shell_notify_smoke\nsurface: shell\noperation: shell\nstatus: completed\nstarted: 2026-01-01T00:00:00.000Z\nfinished: 2026-01-01T00:00:01.000Z\n\nnested background done for ${sessionId}`;
          askOpts.notifyFn?.(nestedText, {
            type: 'shell_task_result',
            execution_surface: 'shell',
            execution_id: 'task_shell_notify_smoke',
            status: 'completed',
          });
          askOpts.onTerminalResult?.({ content: 'worker completed' }, { sessionId, beforeSave: true });
          return { content: 'worker completed' };
        },
        enqueuePendingMessage: (sessionId, message) => {
          workerQueued.push({ sessionId, message });
          return 1;
        },
        getSession: () => null,
        listSessions: () => [],
        closeSession: () => false,
        hideSessionFromList: () => false,
      },
      dataDir: agentNotifyTmp,
      cwd: root,
      defaultMode: 'async',
      notifySessionCompletion: (sessionId, text, meta) => {
        ownerNotifications.push({ sessionId, text, meta });
        return true;
      },
    });
    const notifyContext = {
      invocationSource: 'model-tool',
      callerCwd: root,
      callerSessionId: 'sess_owner_notify_smoke',
      clientHostPid: 424242,
    };
    const notifyStart = await agentNotifySmoke.execute({ type: 'spawn', agent: 'worker', tag: 'notify-smoke', prompt: 'notify smoke' }, notifyContext);
    if (!/agent task:/i.test(String(notifyStart)) || !/status: running/i.test(String(notifyStart))) {
      throw new Error(`agent async notify smoke did not start task:\n${notifyStart}`);
    }
    await waitFor(
      () => workerQueued.some((event) =>
        /task_shell_notify_smoke/.test(String(event.message?.text || event.message?.content || event.message))),
      'agent child background completion routing',
    );
    if (ownerNotifications.some((event) => /task_shell_notify_smoke/.test(event.text))) {
      throw new Error(`agent child shell completion must stay in the worker session: ${JSON.stringify(ownerNotifications)}`);
    }
    await waitFor(
      () => ownerNotifications.some((event) => /worker completed/.test(event.text)),
      'agent early completion routing',
    );
    const agentCompletionCount = ownerNotifications.filter((event) => /worker completed/.test(event.text)).length;
    if (agentCompletionCount !== 1) {
      throw new Error(`agent early completion should suppress duplicate final notify, got ${agentCompletionCount}: ${JSON.stringify(ownerNotifications)}`);
    }
    await agentNotifySmoke.execute({ type: 'cleanup', force: true }, notifyContext);
  } finally {
    try { agentNotifySmoke?.closeAll('tool-contracts-agent-notify-complete'); } catch {}
    rmSync(agentNotifyTmp, { recursive: true, force: true });
  }
});
