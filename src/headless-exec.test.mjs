// Isolate Mixdog user data in a temp dir before any module under test loads.
import '../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { classifyCliInvocation } from './headless-command.mjs';
import { prewarmHeadlessSearch, runHeadlessExec } from './headless-exec.mjs';
import { resolveCursorOAuthAccessToken } from './runtime/agent/orchestrator/providers/cursor-auth.mjs';
import { createPristineExecutionBoundary } from './runtime/shared/pristine-execution.mjs';
import { spawnSync } from 'node:child_process';
import {
  MODEL_PROXY_OPERATIONS,
  ModelProxyChannel,
  decodeModelProxyWire,
  encodeModelProxyWire,
  getModelProxyChannel,
} from './runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import {
  ModelProxyBridgeChannel,
  createModelProxyBridgeServer,
} from './runtime/agent/orchestrator/providers/model-proxy-bridge.mjs';
import { boundProviderAuthPath } from './runtime/shared/provider-auth-binding.mjs';
import { newProviderAccountId } from './runtime/shared/provider-accounts.mjs';
import {
  withGrandfatheredBuiltins,
  featureDisallowedToolsFor,
} from './runtime/agent/orchestrator/runtime-core/builtin-features.mjs';
import {
  applyDeferredToolSurface,
  deferredCatalogUnion,
  selectDeferredTools,
} from './runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';

test('headless search prewarm starts only the canonical native server', async () => {
  const calls = [];
  await prewarmHeadlessSearch('/app/project', {
    loadNativeSearch: async () => ({
      async warmNativeSearchServer() {
        calls.push('server');
        return true;
      },
    }),
  });
  assert.deepEqual(calls, ['server']);
});

test('pristine headless execution binds Cursor OAuth credentials in process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-cursor-auth-test-'));
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, 'cursor-oauth.json'),
    JSON.stringify({
      access_token: 'cursor-test-token',
    })
  );
  const selectedGraph = join(root, 'selected-graph');
  const env = {
    MIXDOG_HOME: root,
    MIXDOG_SEARCH_SERVER_BIN: selectedGraph,
    MIXDOG_UNLISTED_OVERRIDE: 'must not reach execution',
  };
  const boundary = createPristineExecutionBoundary({
    provider: 'cursor-oauth',
    model: 'gemini-3.7-flash',
    env,
  });
  try {
    assert.equal(env.MIXDOG_SEARCH_SERVER_BIN, selectedGraph);
    assert.equal(env.MIXDOG_UNLISTED_OVERRIDE, undefined);
    assert.equal(boundary.audit.authMode, 'in-process-host-oauth-binding');
    assert.equal(await resolveCursorOAuthAccessToken(), 'cursor-test-token');
    assert.deepEqual(boundary.loadConfig().providers, {
      'cursor-oauth': { enabled: true },
    });
    const config = withGrandfatheredBuiltins(boundary.loadConfig());
    assert.deepEqual(config.builtins, {});
    const disallowedTools = featureDisallowedToolsFor(config, { toolProfile: 'headless' });
    const session = {
      provider: 'openai-oauth',
      model: 'gpt-test',
      tools: ['git', 'office', 'github'].map((name) => ({
        name,
        inputSchema: { type: 'object', properties: {} },
      })),
      disallowedTools,
    };
    applyDeferredToolSurface(session, 'full');
    assert.deepEqual(
      deferredCatalogUnion(session).map((tool) => tool.name),
      ['git']
    );
    assert.deepEqual(selectDeferredTools(session, ['office', 'github'], 'full').added, []);
  } finally {
    boundary.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [provider, model] of [
  ['muse-code-oauth', 'muse-spark-1.3'],
  ['command-code-oauth', 'deepseek/deepseek-v4-flash'],
  ['mimo-oauth', 'mimo-v2.5'],
]) {
  test(`pristine headless execution binds ${provider} credentials and copies its model catalog`, () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-oauth-test-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, `${provider}.json`), JSON.stringify({ apiKey: 'k', access_token: 'k' }));
    writeFileSync(join(dataDir, `${provider}-models.json`), '{}');
    const boundary = createPristineExecutionBoundary({ provider, model, env: { MIXDOG_HOME: root } });
    try {
      assert.equal(boundary.audit.authMode, 'in-process-host-oauth-binding');
      assert.equal(boundary.audit.injectedModelCatalogFileCount, 1);
    } finally {
      boundary.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('pristine headless execution binds the selected provider-accounts credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-pool-auth-test-'));
  const dataDir = join(root, 'data');
  const id = newProviderAccountId();
  const poolPath = join(dataDir, 'provider-accounts', 'antigravity-oauth', `${id}.json`);
  mkdirSync(join(dataDir, 'provider-accounts', 'antigravity-oauth'), { recursive: true });
  writeFileSync(
    join(dataDir, 'provider-accounts.json'),
    JSON.stringify({
      version: 1,
      providers: { 'antigravity-oauth': { accounts: [{ id, label: 'Account 1' }], selectedId: id, auto: true } },
    })
  );
  writeFileSync(
    poolPath,
    JSON.stringify({ access_token: 'pool-token', refresh_token: 'refresh', expires_at: Date.now() + 3600_000 })
  );
  const boundary = createPristineExecutionBoundary({
    provider: 'antigravity-oauth',
    model: 'gemini-3.8-flash',
    env: { MIXDOG_HOME: root },
  });
  try {
    assert.equal(boundary.audit.authMode, 'in-process-host-oauth-binding');
    assert.equal(boundProviderAuthPath('antigravity-oauth'), poolPath);
  } finally {
    boundary.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
  // No selected account and no legacy file: the boundary still fails closed.
  const emptyRoot = mkdtempSync(join(tmpdir(), 'mixdog-headless-no-auth-test-'));
  mkdirSync(join(emptyRoot, 'data'), { recursive: true });
  try {
    assert.throws(
      () =>
        createPristineExecutionBoundary({
          provider: 'antigravity-oauth',
          model: 'gemini-3.8-flash',
          env: { MIXDOG_HOME: emptyRoot },
        }),
      /credentials are unavailable/
    );
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

// Remote (SSH) mode: a headless boundary in a skill-script process reaches the
// PC through the daemon's model proxy bridge, published in the host runtime
// root's daemon.json.
async function remoteDaemonFixture(t, { endpoints } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-bridge-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const runtimeRoot = join(root, 'host-runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  const channel = new ModelProxyChannel();
  const server = createModelProxyBridgeServer({ channel });
  const endpoint = await server.start();
  t.after(() => server.close());
  const writeDiscovery = (record) => writeFileSync(join(runtimeRoot, 'daemon.json'), JSON.stringify(record));
  writeDiscovery({ pid: process.pid, endpoints: endpoints ?? { modelProxy: endpoint } });
  return { root, runtimeRoot, channel, endpoint, writeDiscovery };
}

test('remote mode: the pristine boundary uses the daemon model proxy bridge and never a local credential', async (t) => {
  const fx = await remoteDaemonFixture(t);
  const methods = [];
  const handled = new Set();
  t.after(
    fx.channel.attachPublisher((snapshot) => {
      for (const { id } of snapshot.requests) {
        if (handled.has(id)) continue;
        handled.add(id);
        queueMicrotask(() => {
          const call = decodeModelProxyWire(fx.channel.handleOperation(MODEL_PROXY_OPERATIONS.claim, [id]).payload);
          methods.push(call.method);
          fx.channel.handleOperation(MODEL_PROXY_OPERATIONS.resolve, [id, true, encodeModelProxyWire(true), null]);
        });
      }
    })
  );
  const env = {
    MIXDOG_MODEL_PROXY: 'client',
    MIXDOG_RUNTIME_ROOT: fx.runtimeRoot,
    MIXDOG_HOME: join(fx.root, 'home'),
    OPENAI_API_KEY: 'sk-host-key',
    ANTHROPIC_OAUTH_CREDENTIALS_PATH: join(fx.root, 'anthropic.json'),
    PATH: 'user-path',
  };
  const hostEnv = { ...env };
  const original = getModelProxyChannel();
  for (const provider of ['openai', 'anthropic-oauth']) {
    const boundary = createPristineExecutionBoundary({
      provider,
      model: 'model-test',
      env,
      apiKeyResolver: () => {
        throw new Error('a credential was looked up in model proxy mode');
      },
    });
    let bridge = null;
    try {
      assert.equal(boundary.audit.authMode, 'model-proxy-bridge');
      assert.equal(env.MIXDOG_MODEL_PROXY, 'client');
      assert.equal(env.MIXDOG_RUNTIME_ROOT, boundary.runtimeRoot, 'child services keep the pristine runtime root');
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.ANTHROPIC_OAUTH_CREDENTIALS_PATH, undefined);
      assert.equal(env.PATH, 'user-path');
      assert.deepEqual(boundary.loadConfig().providers, { [provider]: { enabled: true } });
      assert.equal(boundary.audit.injectedModelCatalogFileCount, 0);
      bridge = getModelProxyChannel();
      assert.ok(bridge instanceof ModelProxyBridgeChannel);
      assert.equal(await bridge.whenConnected(3_000), true);
      assert.equal(await bridge.request({ provider, method: 'isAvailable' }), true);
    } finally {
      boundary.cleanup();
    }
    assert.deepEqual(env, hostEnv, 'cleanup restores the environment');
    assert.equal(getModelProxyChannel(), original, 'cleanup restores the channel');
    await assert.rejects(bridge.request({ provider, method: 'isAvailable' }), { code: 'MODEL_PROXY_UNAVAILABLE' });
  }
  assert.deepEqual(methods, ['isAvailable', 'isAvailable']);
});

test('remote mode: a missing or stale bridge endpoint fails closed, with no local-credential fallback', async (t) => {
  const fx = await remoteDaemonFixture(t, { endpoints: { session: { port: 1, token: 'x' } } });
  const original = getModelProxyChannel();
  const attempt = (overrides = {}) => {
    const env = {
      MIXDOG_MODEL_PROXY: 'client',
      MIXDOG_RUNTIME_ROOT: fx.runtimeRoot,
      MIXDOG_HOME: join(fx.root, 'home'),
      OPENAI_API_KEY: 'sk-host-key',
      ...overrides,
    };
    const before = { ...env };
    let thrown = null;
    try {
      createPristineExecutionBoundary({
        provider: 'openai',
        model: 'gpt-test',
        env,
        apiKeyResolver: () => 'sk-host-key',
      });
    } catch (error) {
      thrown = error;
    }
    assert.deepEqual(env, before, 'a refused boundary leaves the environment untouched');
    assert.equal(getModelProxyChannel(), original);
    return thrown;
  };
  assert.deepEqual(
    { code: attempt()?.code, reason: attempt()?.reason },
    { code: 'MODEL_PROXY_UNAVAILABLE', reason: 'endpoint-missing' }
  );
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  fx.writeDiscovery({ pid: exited, endpoints: { modelProxy: fx.endpoint } });
  assert.equal(attempt()?.reason, 'daemon-not-running');
  rmSync(join(fx.runtimeRoot, 'daemon.json'));
  assert.equal(attempt()?.reason, 'discovery-missing');
  assert.equal(attempt({ MIXDOG_RUNTIME_ROOT: undefined })?.reason, 'runtime-root-missing');
  assert.match(attempt()?.message || '', /^model proxy unavailable: /);
});

test('headless exec runs one implicit-approval session and waits for tracked tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-exec-test-'));
  const usageLogPath = join(root, 'usage.json');
  const output = [];
  const errors = [];
  const runtimeOptions = [];
  const activeScopes = [];
  let boundaryCleaned = false;
  let boundaryCleanupOptions = null;
  let runtimeClosed = false;
  const daemonCleanupCalls = [];
  const cleanupOrder = [];
  try {
    const code = await runHeadlessExec({
      message: 'fix it',
      provider: 'openai-oauth',
      model: 'gpt-test',
      effort: 'high',
      fast: true,
      usageLogPath,
      write: (text) => output.push(text),
      writeErr: (text) => errors.push(text),
      boundaryFactory: () => ({
        runtimeRoot: join(root, 'runtime-root'),
        loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
        cleanup: (options) => {
          boundaryCleaned = true;
          boundaryCleanupOptions = options;
          cleanupOrder.push('boundary');
        },
      }),
      runtimeFactory: async (options) => {
        runtimeOptions.push(options);
        return {
          id: 'sess_exec_test',
          model: 'gpt-test',
          clientHostPid: 123,
          ask: async (_prompt, optionsForAsk) => {
            optionsForAsk.onUsageDelta({
              model: 'gpt-fallback',
              deltaInput: 11,
              deltaCachedRead: 7,
              deltaCacheWrite: 3,
              deltaOutput: 5,
            });
            return { result: { content: 'done' } };
          },
          close: async () => {
            runtimeClosed = true;
            cleanupOrder.push('runtime');
          },
        };
      },
      memoryRuntimeCleanup: async () => {
        cleanupOrder.push('memory');
      },
      daemonRuntimeCleanup: async (runtimeRoot, options) => {
        daemonCleanupCalls.push({ runtimeRoot, options });
        cleanupOrder.push('daemon');
      },
      usageLedgerCleanup: () => {
        cleanupOrder.push('ledger');
      },
      sessionStoreDrain: async () => {
        cleanupOrder.push('sessions');
      },
      hasActiveTasks: (scope) => {
        activeScopes.push(scope);
        return false;
      },
      installSignalCleanupFn: () => ({ uninstall() {} }),
    });

    assert.equal(code, 0);
    assert.deepEqual(output, ['done\n']);
    assert.deepEqual(errors, []);
    assert.equal(runtimeOptions[0].approvalMode, 'implicit');
    assert.equal(runtimeOptions[0].disallowDelegation, true);
    assert.equal(runtimeOptions[0].toolProfile, 'headless');
    assert.deepEqual(runtimeOptions[0].initialConfig.workflow, { active: 'headless' });
    assert.equal(runtimeOptions[0].autoWakeCompletions, false);
    assert.equal(runtimeOptions[0].toolMode, 'full');
    assert.deepEqual(activeScopes[0], {
      callerSessionId: 'sess_exec_test',
      clientHostPid: 123,
    });
    assert.equal(boundaryCleaned, true);
    assert.equal(runtimeClosed, true);
    // The ledger handle must be gone before the pristine root is removed:
    // an open SQLite file turns that rmSync into a ~128s EBUSY retry loop on Windows.
    // Pending session saves flush before the boundary restores the host data dir.
    assert.deepEqual(cleanupOrder, ['runtime', 'sessions', 'ledger', 'daemon', 'memory', 'boundary']);
    // A finished answer never waits the default removal budget on a straggling root.
    assert.deepEqual(boundaryCleanupOptions, { tolerateRootRemovalFailure: true, rootRemovalRetries: 10 });
    assert.deepEqual(daemonCleanupCalls, [
      {
        runtimeRoot: join(root, 'runtime-root'),
        options: { waitForExit: true, timeoutMs: 8_000 },
      },
    ]);
    const usage = JSON.parse(readFileSync(usageLogPath, 'utf8'));
    assert.deepEqual(usage.sessions[0].models, ['gpt-test', 'gpt-fallback']);
    assert.deepEqual(usage.totals, {
      inputTokens: 11,
      cacheTokens: 7,
      cacheWriteTokens: 3,
      outputTokens: 5,
      toolCallCountApprox: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('headless exec preserves the pristine root when isolated daemon shutdown fails', async () => {
  const errors = [];
  let cleanupOptions = null;
  const code = await runHeadlessExec({
    message: 'done',
    provider: 'openai-oauth',
    model: 'gpt-test',
    usageLogPath: '',
    write() {},
    writeErr: (text) => errors.push(text),
    boundaryFactory: () => ({
      runtimeRoot: '/isolated/runtime',
      loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
      cleanup: (options) => {
        cleanupOptions = options;
      },
    }),
    runtimeFactory: async () => ({
      id: 'sess_cleanup_failure',
      model: 'gpt-test',
      clientHostPid: 123,
      async ask() {
        return { result: { content: 'done' } };
      },
      async close() {},
    }),
    daemonRuntimeCleanup: async () => {
      throw new Error('daemon stuck');
    },
    memoryRuntimeCleanup: async () => {},
    hasActiveTasks: () => false,
    installSignalCleanupFn: () => ({ uninstall() {} }),
  });

  assert.equal(code, 1);
  assert.deepEqual(cleanupOptions, { preserveRoot: true });
  assert.ok(errors.some((line) => line.includes('shutdown failed: daemon stuck')));
});

test('headless exec flushes the usage snapshot mid-session, before any exit path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-usage-flush-test-'));
  const usageLogPath = join(root, 'usage.json');
  // What a killed run would have left behind: read the file while `ask` is
  // still running. Before the per-response flush this was always absent, so
  // an agent-timeout trial reported no token spend at all.
  let midSession = null;
  try {
    const code = await runHeadlessExec({
      message: 'fix it',
      provider: 'openai-oauth',
      model: 'gpt-test',
      effort: 'high',
      fast: true,
      usageLogPath,
      write: () => {},
      writeErr: () => {},
      boundaryFactory: () => ({
        loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
        cleanup: () => {},
      }),
      runtimeFactory: async () => ({
        id: 'sess_flush_test',
        model: 'gpt-test',
        clientHostPid: 123,
        ask: async (_prompt, options) => {
          options.onUsageDelta({
            deltaInput: 9,
            deltaCachedRead: 4,
            deltaCacheWrite: 2,
            deltaOutput: 6,
          });
          try {
            midSession = JSON.parse(readFileSync(usageLogPath, 'utf8'));
          } catch (error) {
            midSession = { error: error?.message ?? String(error) };
          }
          return { result: { content: 'done' } };
        },
        close: async () => {},
      }),
      hasActiveTasks: () => false,
      installSignalCleanupFn: () => ({ uninstall() {} }),
    });

    assert.equal(code, 0);
    assert.deepEqual(midSession?.totals, {
      inputTokens: 9,
      cacheTokens: 4,
      cacheWriteTokens: 2,
      outputTokens: 6,
      toolCallCountApprox: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('headless exec answers an arrived completion and exits without waiting on live work', async () => {
  const output = [];
  const errors = [];
  const prompts = [];
  let closeOptions = null;
  let notificationListener = null;
  const code = await runHeadlessExec({
    message: 'start the long task',
    provider: 'openai-oauth',
    model: 'gpt-test',
    usageLogPath: '',
    write: (text) => output.push(text),
    writeErr: (text) => errors.push(text),
    boundaryFactory: () => ({
      loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
      cleanup() {},
    }),
    runtimeFactory: async () => ({
      id: 'sess_headless_drain',
      model: 'gpt-test',
      clientHostPid: 123,
      onNotification(listener) {
        notificationListener = listener;
        return () => {
          notificationListener = null;
        };
      },
      async ask(prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          notificationListener?.({
            content: 'background task completed',
            meta: { status: 'completed', execution_id: 'job_drain' },
          });
          return { result: { content: 'task started' } };
        }
        return { result: { content: 'final result' } };
      },
      async close(_reason, options) {
        closeOptions = options ?? null;
      },
    }),
    // The job the model left running never ends — a server it was asked to
    // keep up. Exit must not wait for it, and must not reap it either: this
    // test hangs on a regression instead of failing slowly.
    hasActiveTasks: () => true,
    installSignalCleanupFn: () => ({ uninstall() {} }),
  });

  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(prompts, ['start the long task', '']);
  assert.deepEqual(output, ['final result\n']);
  assert.deepEqual(closeOptions, { keepBackgroundWork: true });
});

test('headless exec emits a timestamped JSONL lifecycle and exact tool count', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-json-test-'));
  const usageLogPath = join(root, 'usage.json');
  const output = [];
  const errors = [];
  let notificationListener = null;
  try {
    const code = await runHeadlessExec({
      message: 'fix it',
      provider: 'openai-oauth',
      model: 'gpt-test',
      effort: 'high',
      fast: true,
      json: true,
      usageLogPath,
      write: (text) => output.push(text),
      writeErr: (text) => errors.push(text),
      boundaryFactory: () => ({
        loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
        cleanup() {},
      }),
      runtimeFactory: async () => ({
        id: 'sess_json_test',
        provider: 'openai-oauth',
        model: 'gpt-test',
        effort: 'high',
        fast: true,
        cwd: '/app',
        clientHostPid: 123,
        onNotification(listener) {
          notificationListener = listener;
          return () => {
            notificationListener = null;
          };
        },
        async ask(_prompt, options) {
          options.onProviderSendStarted();
          options.onReasoningDelta('inspect first');
          options.onUsageDelta({
            deltaInput: 11,
            deltaCachedRead: 7,
            deltaCacheWrite: 3,
            deltaOutput: 5,
          });
          const call = {
            id: 'call_1',
            name: 'shell',
            arguments: { command: 'echo ok' },
          };
          options.onAssistantToolCallObserved(call);
          await options.onToolCall(1, [call]);
          options.onToolPhaseStarted();
          const toolClock = Date.now();
          options.onToolResult({
            role: 'tool',
            toolCallId: 'call_1',
            content: 'ok\n',
            __earlyNotify: true,
            toolTiming: {
              dispatchStartedAt: toolClock,
              executionStartedAt: toolClock + 2,
              executionCompletedAt: toolClock + 5,
            },
          });
          options.onToolResult({
            role: 'tool',
            toolCallId: 'call_1',
            content: 'ok\n',
            toolKind: 'normal',
            toolTiming: {
              dispatchStartedAt: toolClock,
              executionStartedAt: toolClock + 2,
              executionCompletedAt: toolClock + 5,
              postprocessStartedAt: toolClock + 6,
              resultCompletedAt: toolClock + 8,
            },
          });
          options.onToolPhaseCompleted({ iteration: 1, calls: 1, elapsedMs: 2 });
          notificationListener?.({
            content: 'background task completed',
            meta: { status: 'progress' },
          });
          options.onProviderSendStarted();
          options.onAssistantText('done');
          options.onUsageDelta({
            deltaInput: 5,
            deltaCachedRead: 0,
            deltaCacheWrite: 0,
            deltaOutput: 2,
          });
          return { result: { content: 'done', stopReason: 'end_turn' } };
        },
        async close() {},
      }),
      hasActiveTasks: () => false,
      installSignalCleanupFn: () => ({ uninstall() {} }),
    });

    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    const events = output
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events[0].type, 'thread.started');
    assert.equal(events[1].type, 'turn.started');
    assert.equal(Object.hasOwn(events[0].session, 'memory'), false);
    assert.ok(events.every((event) => event.schema_version === 1 && event.timestamp));
    const toolStarted = events.find((event) => event.type === 'item.started' && event.item?.type === 'tool_call');
    const toolCompleted = events.find((event) => event.type === 'item.completed' && event.item?.id === 'call_1');
    assert.equal(toolStarted.item.name, 'shell');
    assert.equal(toolCompleted.item.output, 'ok\n');
    assert.equal(toolCompleted.item.status, 'completed');
    assert.ok(toolCompleted.item.duration_ms >= 0);
    assert.equal(toolCompleted.item.timing.dispatch_ms, 2);
    assert.equal(toolCompleted.item.timing.execution_ms, 3);
    assert.equal(toolCompleted.item.timing.batch_wait_ms, 1);
    assert.equal(toolCompleted.item.timing.postprocess_ms, 2);
    assert.equal(events.filter((event) => event.type === 'item.completed' && event.item?.id === 'call_1').length, 1);
    assert.ok(events.some((event) => event.type === 'notification'));
    assert.equal(events.filter((event) => event.type === 'model.request.completed').length, 2);
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'result');
    assert.equal(terminal.subtype, 'success');
    assert.equal(terminal.session_id, 'sess_json_test');
    assert.equal(terminal.provider_requests, 2);
    assert.equal(terminal.tool_calls, 1);
    assert.deepEqual(terminal.usage, {
      input_tokens: 16,
      cached_input_tokens: 7,
      cache_write_input_tokens: 3,
      output_tokens: 7,
      tool_calls: 1,
    });
    const usage = JSON.parse(readFileSync(usageLogPath, 'utf8'));
    assert.equal(usage.totals.toolCallCountApprox, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('headless exec emits structured JSONL failure before returning exit 1', async () => {
  const output = [];
  const errors = [];
  const code = await runHeadlessExec({
    message: 'fail',
    provider: 'openai-oauth',
    model: 'gpt-test',
    json: true,
    usageLogPath: '',
    write: (text) => output.push(text),
    writeErr: (text) => errors.push(text),
    boundaryFactory: () => ({
      loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
      cleanup() {},
    }),
    runtimeFactory: async () => ({
      id: 'sess_json_failure',
      model: 'gpt-test',
      clientHostPid: 123,
      async ask() {
        throw new Error('boom');
      },
      async close() {},
    }),
    installSignalCleanupFn: () => ({ uninstall() {} }),
  });

  const events = output
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(code, 1);
  assert.ok(events.some((event) => event.type === 'turn.failed'));
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).subtype, 'error_during_execution');
  assert.deepEqual(events.at(-1).errors, ['boom']);
  assert.deepEqual(errors, ['mixdog: boom\n']);
});

test('headless exec exposes typed refusal as an API error result', async () => {
  const output = [];
  const code = await runHeadlessExec({
    message: 'request',
    provider: 'anthropic-oauth',
    model: 'claude-test',
    json: true,
    usageLogPath: '',
    write: (text) => output.push(text),
    writeErr() {},
    boundaryFactory: () => ({
      loadConfig: () => ({ providers: { 'anthropic-oauth': { enabled: true } } }),
      cleanup() {},
    }),
    runtimeFactory: async () => ({
      id: 'sess_json_refusal',
      model: 'claude-test',
      clientHostPid: 123,
      async ask() {
        return {
          result: {
            content: 'Unable to respond.',
            stopReason: 'refusal',
            terminationReason: 'refusal',
          },
        };
      },
      async close() {},
    }),
    hasActiveTasks: () => false,
    installSignalCleanupFn: () => ({ uninstall() {} }),
  });

  const terminal = output
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .at(-1);
  assert.equal(code, 0);
  assert.equal(terminal.subtype, 'success');
  assert.equal(terminal.is_error, true);
  assert.equal(terminal.stop_reason, 'refusal');
  assert.equal(terminal.termination_reason, 'refusal');
});

test('--json is accepted for exec and rejected for the interactive command', () => {
  const exec = classifyCliInvocation(['exec', '--provider', 'openai-oauth', '--model', 'gpt-test', '--json', 'fix it']);
  assert.equal(exec.kind, 'exec');
  assert.equal(exec.options.json, true);

  const interactive = classifyCliInvocation(['--json']);
  assert.equal(interactive.kind, 'error');
  assert.equal(interactive.error, 'option --json is only supported for mixdog exec');
});

test('headless exec rejects workflow selection', () => {
  const invocation = classifyCliInvocation([
    'exec',
    '--provider',
    'openai-oauth',
    '--model',
    'gpt-test',
    '--workflow',
    'solo',
    'fix it',
  ]);
  assert.equal(invocation.kind, 'error');
  assert.equal(invocation.error, 'option --workflow is not supported for mixdog exec');
});

test('headless exec rejects memory because pristine state is discarded', () => {
  const invocation = classifyCliInvocation([
    'exec',
    '--provider',
    'openai-oauth',
    '--model',
    'gpt-test',
    '--memory',
    'fix it',
  ]);
  assert.equal(invocation.kind, 'error');
  assert.equal(invocation.error, 'option --memory is not supported for mixdog exec');
});
