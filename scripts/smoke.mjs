import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runNode(args, label) {
  const child = spawnSync(process.execPath, args, {
    cwd: root,
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
`], 'statusline sub-percent context smoke');

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
