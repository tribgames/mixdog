import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawnSync(process.execPath, ['src/cli.mjs', '--help'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 10000,
});

if (child.status !== 0) {
  process.stderr.write(child.stderr || child.stdout);
  process.exit(child.status || 1);
}

if (!child.stdout.includes('standalone mixdog CLI/TUI coding agent')) {
  process.stderr.write(`unexpected help output:\n${child.stdout}`);
  process.exit(1);
}

process.stdout.write('smoke passed ✓\n');
