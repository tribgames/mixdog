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

runNode(['src/cli.mjs', '--help'], 'help smoke');

runNode(['--input-type=module', '-e', `
  const mod = await import('./src/tui/dist/index.mjs');
  if (typeof mod.runTui !== 'function') throw new Error('runTui export missing');
`], 'tui bundle import smoke');

const boot = runNode(['src/cli.mjs', '--help'], 'boot profile smoke', {
  env: { MIXDOG_BOOT_PROFILE: '1' },
});
if (!boot.stderr.includes('[mixdog-boot]')) {
  process.stderr.write(boot.stderr || boot.stdout || 'boot profile smoke failed\n');
  process.exit(1);
}

process.stdout.write('smoke passed ✓\n');
