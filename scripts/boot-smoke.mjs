#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLD_MS = Number(process.env.MIXDOG_BOOT_SMOKE_LIMIT_MS || 5_000);
const FAST_BACKGROUND_ENV = {
  MIXDOG_DISABLE_SESSION_PREWARM: '1',
  MIXDOG_DISABLE_PROVIDER_WARMUP: '1',
  MIXDOG_DISABLE_CHANNEL_START: '1',
};
const DEFAULT_BACKGROUND_ENV = {
  MIXDOG_DISABLE_SESSION_PREWARM: '',
  MIXDOG_ENABLE_SESSION_PREWARM: '',
  MIXDOG_SESSION_PREWARM_DELAY_MS: '',
  MIXDOG_DISABLE_PROVIDER_WARMUP: '',
  MIXDOG_ENABLE_PROVIDER_WARMUP: '',
  MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN: '',
  MIXDOG_PROVIDER_WARMUP_DELAY_MS: '',
  MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS: '',
};

function runCase(name, args, { env = {}, input = null, expectStdout = null, expectStderr = null, maxMs = THRESHOLD_MS } = {}) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: Math.max(10_000, maxMs + 5_000),
  });
  const ms = performance.now() - startedAt;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (result.status !== 0) {
    throw new Error(`${name} exited ${result.status}:\n${stderr || stdout}`);
  }
  if (expectStdout && !stdout.includes(expectStdout)) {
    throw new Error(`${name} stdout missing ${expectStdout}:\n${stdout.slice(0, 1000)}`);
  }
  if (expectStderr && !stderr.includes(expectStderr)) {
    throw new Error(`${name} stderr missing ${expectStderr}:\n${stderr.slice(0, 1000)}`);
  }
  if (ms > maxMs) {
    throw new Error(`${name} boot smoke exceeded ${maxMs}ms (${ms.toFixed(1)}ms)`);
  }
  return { name, ms: Math.round(ms * 10) / 10 };
}

const rows = [
  runCase('help', ['src/cli.mjs', '--help'], {
    expectStdout: 'standalone mixdog CLI/TUI coding agent',
  }),
  runCase('tui_import', ['--input-type=module', '-e', `
    const mod = await import('./src/tui/dist/index.mjs');
    if (typeof mod.runTui !== 'function') throw new Error('runTui export missing');
  `]),
  runCase('runtime_tools', ['--input-type=module', '-e', `
    const mod = await import('./src/mixdog-session-runtime.mjs');
    if (typeof mod.createMixdogSessionRuntime !== 'function') throw new Error('runtime export missing');
    const runtime = await mod.createMixdogSessionRuntime({ toolMode: 'full' });
    try {
      const status = runtime.toolsStatus();
      const active = new Set(status.activeTools || []);
      for (const name of ['read','code_graph','grep','find','glob','list','apply_patch','explore','Skill','tool_search']) {
        if (!active.has(name)) throw new Error('missing ' + name + ' in ' + [...active].join(','));
      }
      for (const name of ['bash','task','agent','shell','recall','search','web_fetch','cwd']) {
        if (active.has(name)) throw new Error('unexpected ' + name + ' in ' + [...active].join(','));
      }
      const result = runtime.selectTools('shell');
      if (!result.added.includes('shell') || !result.added.includes('task')) {
        throw new Error('shell alias should add shell and task: ' + JSON.stringify(result));
      }
      const nextActive = new Set(result.status.activeTools || []);
      const nextDiscovered = new Set(result.status.discoveredTools || []);
      for (const name of ['shell','task']) {
        const selected = result.native === true ? nextDiscovered : nextActive;
        if (!selected.has(name)) throw new Error('selected tool missing ' + name + ' in ' + [...selected].join(','));
      }
      console.log('runtime_tools active=' + status.activeCount + '/' + status.count + ' selected=' + result.added.join(','));
    } finally {
      await runtime.close('runtime-tools-smoke', { waitForExit: false });
    }
  `], {
    env: FAST_BACKGROUND_ENV,
    expectStdout: 'runtime_tools active=',
  }),
  runCase('boot_profile', ['src/cli.mjs', '--help'], {
    env: { MIXDOG_BOOT_PROFILE: '1' },
    expectStdout: 'standalone mixdog CLI/TUI coding agent',
    expectStderr: 'app:run:start',
  }),
  runCase('plain_quit', ['src/cli.mjs', '--plain'], {
    env: FAST_BACKGROUND_ENV,
    input: '/quit\n',
    expectStdout: 'bye.',
  }),
  runCase('runtime_idle_exit', ['--input-type=module', '-e', `
    const { createMixdogSessionRuntime } = await import('./src/mixdog-session-runtime.mjs');
    const runtime = await createMixdogSessionRuntime({ toolMode: 'full' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const startedAt = performance.now();
    await runtime.close('runtime-idle-exit-smoke', { waitForExit: false });
    console.log('runtime_idle_exit close_ms=' + (performance.now() - startedAt).toFixed(1));
  `], {
    env: { ...DEFAULT_BACKGROUND_ENV, MIXDOG_BOOT_PROFILE: '1' },
    expectStdout: 'runtime_idle_exit close_ms=',
    expectStderr: 'session:prewarm-skipped',
    maxMs: 2_000,
  }),
  runCase('runtime_idle_exit_provider_optin', ['--input-type=module', '-e', `
    const { createMixdogSessionRuntime } = await import('./src/mixdog-session-runtime.mjs');
    const runtime = await createMixdogSessionRuntime({ toolMode: 'full' });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runtime.close('runtime-provider-optin-exit-smoke', { waitForExit: false });
    console.log('runtime_idle_exit_provider_optin ok');
  `], {
    env: {
      ...DEFAULT_BACKGROUND_ENV,
      MIXDOG_BOOT_PROFILE: '1',
      MIXDOG_ENABLE_PROVIDER_WARMUP: '1',
      MIXDOG_PROVIDER_WARMUP_DELAY_MS: '100',
    },
    expectStdout: 'runtime_idle_exit_provider_optin ok',
    expectStderr: 'providers:warm-deferred',
    maxMs: 2_000,
  }),
];

for (const row of rows) {
  process.stdout.write(`${row.name}: ${row.ms}ms\n`);
}
process.stdout.write('boot smoke passed\n');
