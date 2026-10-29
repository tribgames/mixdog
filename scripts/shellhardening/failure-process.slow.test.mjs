import '../lib/isolated-test-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, mkdtempSync, rmSync, tmpdir, join, execShellCommand } from './_shared.mjs';

// Real shell children and real trace writers in child node processes: these
// wait on process signals and file appearance, so they run in the slow lane.

test('execShellCommand carries cancellation cause alongside process signal', async () => {
  const controller = new AbortController();
  const isWindows = process.platform === 'win32';
  // Cancel once the command is visibly running: an abort that lands while the
  // run is still being admitted or spawned is a spawn-phase failure, not a
  // process kill, and a cold spawn path can take well over 100 ms.
  const result = await execShellCommand({
    shell: isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: isWindows ? 'echo started& ping 127.0.0.1 -n 20 > nul' : 'echo started; sleep 10',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 15000,
    abortSignal: controller.signal,
    backgroundOnTimeout: false,
    onOutputTail: () => controller.abort(),
  });
  assert.equal(result.killed, true);
  assert.equal(result.killCause, 'cancellation');
  assert.ok(result.signal || process.platform === 'win32');
});

test('cancellation racing with auto-background promotion is returned as cancelled', async () => {
  const controller = new AbortController();
  // Abort synchronously at the promotion re-check. Earlier preflight reads
  // remain false, so unrelated admission/spawn probes cannot consume the race.
  const racingSignal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === 'aborted' && String(new Error().stack || '').includes('_autoBackground') && !target.aborted) {
        controller.abort();
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const isWindows = process.platform === 'win32';
  const result = await execShellCommand({
    shell: isWindows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    shellArg: isWindows ? '/c' : '-c',
    command: isWindows ? 'ping 127.0.0.1 -n 20 > nul' : 'sleep 10',
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 5000,
    abortSignal: racingSignal,
    autoBackgroundMs: 25,
    backgroundOnTimeout: false,
  });
  assert.equal(result.backgrounded, false);
  assert.equal(result.killed, true);
  assert.equal(result.killCause, 'cancellation');
});

test('implicit test traces are isolated while ship failures remain queryable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-trace-isolation-'));
  try {
    const traceScript = `
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      import { drainAgentTrace } from './src/runtime/agent/orchestrator/agent-trace-io.mjs';
      traceAgentTool({
        sessionId: 'test-isolation',
        iteration: 1,
        toolName: 'read',
        toolKind: 'builtin',
        toolMs: 1,
        resultKind: 'normal',
        resultText: 'ok',
      });
      await drainAgentTrace();
      process.stdout.write(JSON.stringify({
        trace: existsSync(join(process.env.MIXDOG_DATA_DIR, 'history', 'agent-trace.jsonl')),
        failures: existsSync(join(process.env.MIXDOG_DATA_DIR, 'history', 'tool-failures.jsonl')),
      }));
    `;
    const isolated = spawnSync(process.execPath, ['--input-type=module', '-e', traceScript], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: dir,
        MIXDOG_MODE: 'dev',
        MIXDOG_DIAGNOSTICS: '1',
        MIXDOG_AGENT_TRACE_PATH: '',
        MIXDOG_TOOL_FAILURE_LOG_PATH: '',
        MIXDOG_AGENT_TRACE_DISABLE: '',
        NODE_TEST_CONTEXT: '1',
        MIXDOG_RUNTIME_ROOT: join(dir, 'no-service'),
      },
    });
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.deepEqual(JSON.parse(isolated.stdout), { trace: false, failures: false });

    const failureScript = `
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { traceAgentTool } from './src/runtime/agent/orchestrator/agent-trace-format.mjs';
      traceAgentTool({
        sessionId: 'ship-failure',
        iteration: 1,
        toolName: 'read',
        toolKind: 'builtin',
        toolMs: 1,
        resultKind: 'error',
        resultText: 'Error: production failure probe',
      });
      const failuresPath = join(process.env.MIXDOG_DATA_DIR, 'history', 'tool-failures.jsonl');
      for (let i = 0; i < 200 && !existsSync(failuresPath); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      process.stdout.write(JSON.stringify({
        trace: existsSync(join(process.env.MIXDOG_DATA_DIR, 'history', 'agent-trace.jsonl')),
        failures: existsSync(join(process.env.MIXDOG_DATA_DIR, 'history', 'tool-failures.jsonl')),
      }));
    `;
    const shipped = spawnSync(process.execPath, ['--input-type=module', '-e', failureScript], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: dir,
        MIXDOG_MODE: 'ship',
        MIXDOG_DIAGNOSTICS: '',
        MIXDOG_AGENT_TRACE_PATH: '',
        MIXDOG_TOOL_FAILURE_LOG_PATH: '',
        MIXDOG_AGENT_TRACE_DISABLE: '',
        MIXDOG_TOOL_FAILURE_LOG_DISABLE: '',
        NODE_TEST_CONTEXT: '',
        MIXDOG_RUNTIME_ROOT: join(dir, 'no-service'),
      },
    });
    assert.equal(shipped.status, 0, shipped.stderr);
    assert.deepEqual(JSON.parse(shipped.stdout), { trace: false, failures: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

