import assert from 'node:assert/strict';
import test from 'node:test';

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { buildShellSpawnEnv } from './bash-tool.mjs';
import { scrubRuntimeRootVars } from '../env-scrub.mjs';
import { skillLauncherDir, skillScriptRuntime } from '../../../../shared/skill-script-runtime.mjs';

test('shell child receives the caller session cwd without mutating the daemon env', () => {
  const base = {
    PATH: process.env.PATH || '',
    MIXDOG_SESSION_CWD: 'C:\\wrong-session',
  };
  const env = buildShellSpawnEnv('C:\\Project\\mixdog', base);
  assert.equal(env.MIXDOG_SESSION_CWD, 'C:\\Project\\mixdog');
  assert.equal(base.MIXDOG_SESSION_CWD, 'C:\\wrong-session');
});

test('model shells get the skill-launcher directory first on PATH; the daemon env and env built from it do not', () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-shell-launcher-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  const daemonPath = process.env.PATH;
  try {
    const dir = skillLauncherDir(skillScriptRuntime(), dataDir);
    const env = buildShellSpawnEnv('C:\\x', { PATH: ['A', 'B'].join(delimiter) });
    assert.equal(env.PATH, [dir, 'A', 'B'].join(delimiter));
    assert.ok(existsSync(join(dir, 'mixdog-skill-node')));
    if (process.platform === 'win32') assert.ok(existsSync(join(dir, 'mixdog-skill-node.cmd')));
    // The daemon's own PATH, and every env derived from it for hooks and
    // internal workers, never carries the entry.
    buildShellSpawnEnv('C:\\x');
    assert.equal(process.env.PATH, daemonPath);
    assert.ok(!String(scrubRuntimeRootVars({ ...process.env }).PATH || '').includes(dir));
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
