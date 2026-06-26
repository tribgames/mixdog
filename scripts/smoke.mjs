import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runNode(args, label, options = {}) {
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  if (child.status !== 0) {
    process.stderr.write(child.stderr || child.stdout || `${label} failed\n`);
    process.exit(child.status || 1);
  }
  return child;
}

const child = runNode(['src/cli.mjs', '--help'], 'help smoke');
const isolatedStatuslineEnv = {
  MIXDOG_DATA_DIR: resolve(root, '.mixdog-smoke-data-empty'),
  MIXDOG_HOME: resolve(root, '.mixdog-smoke-home-empty'),
  MIXDOG_CONFIG_DIR: resolve(root, '.mixdog-smoke-config-empty'),
};

if (!child.stdout.includes('standalone mixdog CLI/TUI coding agent')) {
  process.stderr.write(`unexpected help output:\n${child.stdout}`);
  process.exit(1);
}

runNode(['--input-type=module', '-e', `
  const mod = await import('./src/tui/dist/index.mjs');
  if (typeof mod.runTui !== 'function') throw new Error('runTui export missing');
`], 'tui bundle import smoke');

runNode(['--input-type=module', '-e', `
  process.stdout.columns = 120;
  const { renderStatusline } = await import('./src/ui/statusline.mjs');
  const line = await renderStatusline({
    provider: 'openai',
    model: 'gpt-5.5',
    contextWindow: 1000000,
    stats: { currentContextTokens: 999 },
  });
  if (/▓/.test(line) || !line.includes('░') || !line.includes('0.1%')) throw new Error('sub-1% context bar should stay empty: ' + JSON.stringify(line));
`], 'statusline sub-percent context smoke', { env: isolatedStatuslineEnv });

runNode(['--input-type=module', '-e', `
  process.stdout.columns = 120;
  const { renderStatusline } = await import('./src/ui/statusline.mjs');
  const line = await renderStatusline({
    provider: 'openai',
    model: 'gpt-5.5',
    contextWindow: 950000,
    rawContextWindow: 1000000,
    stats: { currentContextTokens: 900000 },
  });
  if (!line.includes('94%') || line.includes('100%')) throw new Error('statusline context% should use effective compact capacity, not the 90% auto-compact trigger: ' + JSON.stringify(line));
`], 'statusline compact-capacity context smoke', { env: isolatedStatuslineEnv });

runNode(['--input-type=module', '-e', `
  process.stdout.columns = 120;
  const { renderStatusline } = await import('./src/ui/statusline.mjs');
  const line = await renderStatusline({
    provider: 'openai',
    model: 'gpt-5.5',
    contextWindow: 950000,
    stats: { currentContextTokens: 350000, currentContextSource: 'estimated' },
  });
  if (line.includes('37%') || !line.includes('0%')) throw new Error('statusline must not show local estimated context as session usage: ' + JSON.stringify(line));
`], 'statusline estimated-context isolation smoke', { env: isolatedStatuslineEnv });

runNode(['--input-type=module', '-e', `
  process.stdout.columns = 120;
  const { renderStatusline } = await import('./src/ui/statusline.mjs');
  const line = await renderStatusline({
    provider: 'openai',
    model: 'gpt-5.5',
    contextWindow: 950000,
    stats: { currentContextTokens: 360000, currentContextSource: 'post_compact_estimate' },
  });
  if (!line.includes('37%')) throw new Error('statusline must show post-compact estimated context after stale API usage: ' + JSON.stringify(line));
`], 'statusline post-compact context smoke', { env: isolatedStatuslineEnv });

runNode(['--input-type=module', '-e', `
  process.stdout.columns = 120;
  const { renderStatusline } = await import('./src/ui/statusline.mjs');
  const line = await renderStatusline({
    provider: 'openai',
    model: 'gpt-5.5',
    contextWindow: 950000,
    stats: { currentContextTokens: 0 },
    bridgeJobs: [{ task_id: 'task_statusline_smoke', status: 'running', tag: 'bench-agent', startedAt: new Date().toISOString() }],
  });
  if (!line.includes('Running') || !line.includes('bench-agent')) throw new Error('statusline must render live bridge job state: ' + JSON.stringify(line));
`], 'statusline live bridge job smoke', { env: isolatedStatuslineEnv });

runNode(['--input-type=module', '-e', `
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'mixdog-status-smoke-'));
  mkdirSync(join(root, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'runtime', 'active-instance.json'), JSON.stringify({
    gateway_port: 3468,
    gateway_server_pid: process.pid,
    gateway_provider: 'openai',
    gateway_model: 'gpt-5.5',
    gateway_context_window: 950000,
    gateway_raw_context_window: 1000000,
    gateway_auto_compact_token_limit: 950000,
    gateway_context_used_pct: 37,
    gateway_cc_session_id: 'other-session',
    gateway_updated_at: Date.now()
  }));
  process.env.MIXDOG_RUNTIME_ROOT = join(root, 'runtime');
  const { loadGatewayStatus } = await import('./src/vendor/statusline/bin/statusline-route.mjs');
  const status = loadGatewayStatus({ sessionId: 'fresh-session', clientHostPid: process.pid, activeContextTokens: 0 });
  if (status?.contextUsedPct === 37) throw new Error('statusline leaked active-instance context from another session');
`], 'statusline session metrics isolation smoke', { env: isolatedStatuslineEnv });

const boot = spawnSync(process.execPath, ['src/cli.mjs', '--help'], {
  cwd: root,
  env: { ...process.env, MIXDOG_BOOT_PROFILE: '1' },
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 10000,
});

if (boot.status !== 0 || !boot.stderr.includes('[mixdog-boot]') || !boot.stderr.includes('app:run:start')) {
  process.stderr.write(boot.stderr || boot.stdout || 'boot profile smoke failed\n');
  process.exit(boot.status || 1);
}

process.stdout.write('smoke passed ✓\n');
