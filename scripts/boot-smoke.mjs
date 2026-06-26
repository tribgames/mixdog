#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THRESHOLD_MS = Number(process.env.MIXDOG_BOOT_SMOKE_LIMIT_MS || 5_000);

function runCase(name, args, { env = {}, input = null, expectStdout = null, expectStderr = null } = {}) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: Math.max(10_000, THRESHOLD_MS + 5_000),
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
  if (ms > THRESHOLD_MS) {
    throw new Error(`${name} boot smoke exceeded ${THRESHOLD_MS}ms (${ms.toFixed(1)}ms)`);
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
  runCase('runtime_import', ['--input-type=module', '-e', `
    const mod = await import('./src/mixdog-session-runtime.mjs');
    if (typeof mod.createMixdogSessionRuntime !== 'function') throw new Error('runtime export missing');
  `]),
  runCase('runtime_tools', ['--input-type=module', '-e', `
    const mod = await import('./src/mixdog-session-runtime.mjs');
    const runtime = await mod.createMixdogSessionRuntime({ toolMode: 'full' });
    const status = runtime.toolsStatus();
    const active = new Set(status.activeTools || []);
    for (const name of ['read','code_graph','grep','glob','list','apply_patch','explore','bridge','tool_search']) {
      if (!active.has(name)) throw new Error('missing ' + name + ' in ' + [...active].join(','));
    }
    for (const name of ['bash','edit','write']) {
      if (active.has(name)) throw new Error('unexpected ' + name + ' in ' + [...active].join(','));
    }
    await runtime.close('runtime-tools-smoke');
    console.log('runtime_tools active=' + status.activeCount + '/' + status.count);
  `], {
    expectStdout: 'runtime_tools active=',
  }),
  runCase('runtime_select', ['--input-type=module', '-e', `
    const mod = await import('./src/mixdog-session-runtime.mjs');
    async function withRuntime(fn) {
      const runtime = await mod.createMixdogSessionRuntime({ toolMode: 'full' });
      try { return await fn(runtime); }
      finally { await runtime.close('runtime-select-smoke'); }
    }
    await withRuntime((runtime) => {
      const editResult = runtime.selectTools('edit');
      if (editResult.added.length || !editResult.already.includes('apply_patch')) {
        throw new Error('edit alias should resolve to already-active apply_patch: ' + JSON.stringify(editResult));
      }
      const afterEdit = new Set(editResult.status.activeTools || []);
      if (afterEdit.has('edit') || afterEdit.has('write') || afterEdit.has('bash')) {
        throw new Error('edit alias leaked extra tools: ' + [...afterEdit].join(','));
      }

      const writeResult = runtime.selectTools('write');
      if (writeResult.added.length || !writeResult.already.includes('apply_patch')) {
        throw new Error('write alias should resolve to already-active apply_patch: ' + JSON.stringify(writeResult));
      }
      const afterWrite = new Set(writeResult.status.activeTools || []);
      if (afterWrite.has('edit') || afterWrite.has('write') || afterWrite.has('bash')) {
        throw new Error('write alias leaked edit/bash: ' + [...afterWrite].join(','));
      }
    });
    await withRuntime((runtime) => {
      const result = runtime.selectTools('shell');
      if (!result.added.includes('shell') || !result.added.includes('task')) {
        throw new Error('shell alias should add shell/task: ' + JSON.stringify(result));
      }
      const active = new Set(result.status.activeTools || []);
      if (active.has('edit') || active.has('write')) {
        throw new Error('shell alias leaked edit/write: ' + [...active].join(','));
      }
    });
    console.log('runtime_select ok');
  `], {
    expectStdout: 'runtime_select ok',
  }),
  runCase('boot_profile', ['src/cli.mjs', '--help'], {
    env: { MIXDOG_BOOT_PROFILE: '1' },
    expectStdout: 'standalone mixdog CLI/TUI coding agent',
    expectStderr: 'app:run:start',
  }),
  runCase('plain_quit', ['src/cli.mjs', '--plain'], {
    input: '/quit\n',
    expectStdout: 'bye.',
  }),
];

for (const row of rows) {
  process.stdout.write(`${row.name}: ${row.ms}ms\n`);
}
process.stdout.write('boot smoke passed\n');
