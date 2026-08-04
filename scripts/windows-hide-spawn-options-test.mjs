import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  childGuardianMemoryFloorMb,
  childGuardianSpawnEnv,
  startChildGuardian,
} from '../src/runtime/shared/child-guardian.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function source(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

function spawnIdleNode() {
  return spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
}

function killIdleNode(child) {
  if (!child?.pid || !pidAlive(child.pid)) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

test('Windows-sensitive Node re-execs keep their windows hidden', () => {
  const cli = source('src/cli.mjs');
  const jitRebuild = source('src/tui/dev/jit-rebuild.mjs');

  assert.match(cli, /spawnSync\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), \.\.\.argv\], \{\r?\n\s*stdio: 'inherit',\r?\n\s*env: \{ \.\.\.process\.env, MIXDOG_SWAP_REEXEC: '1' \},\r?\n\s*windowsHide: true,\r?\n\s*\}\)/);
  assert.match(jitRebuild, /spawnSync\(process\.execPath, \[script\], \{\r?\n\s*stdio: process\.env\.MIXDOG_TUI_DEV_VERBOSE \? 'inherit' : 'ignore',\r?\n\s*windowsHide: true,\r?\n\s*\}\)/);
});

test('child guardians re-exec Electron as Node without forwarding secrets', () => {
  assert.deepEqual(childGuardianSpawnEnv({
    PATH: 'fixture-path',
    SystemRoot: 'C:\\Windows',
    WINDIR: '',
    ELECTRON_RUN_AS_NODE: '0',
    MIXDOG_TEST_SECRET: 'must-not-forward',
  }), {
    PATH: 'fixture-path',
    SystemRoot: 'C:\\Windows',
    WINDIR: 'C:\\Windows',
    ELECTRON_RUN_AS_NODE: '1',
  });
});

test('persistent token helper relies on stdio ownership without an Electron guardian', () => {
  const tokenNative = source('src/runtime/agent/orchestrator/session/token-native.mjs');
  assert.doesNotMatch(tokenNative, /startChildGuardian/);
  assert.match(tokenNative, /stdio:\s*\['pipe', 'pipe', 'ignore'\]/);
});

test('child guardian memory floor matches resource admission configuration', () => {
  assert.equal(childGuardianMemoryFloorMb({}), 1024);
  assert.equal(childGuardianMemoryFloorMb({ MIXDOG_MIN_FREE_MEMORY_MB: '2048' }), 2048);
  assert.equal(childGuardianMemoryFloorMb({ MIXDOG_MIN_FREE_MEMORY_MB: '0' }), 0);
  assert.equal(childGuardianMemoryFloorMb({ MIXDOG_MIN_FREE_MEMORY_MB: 'invalid' }), 1024);
});

test('command-scoped child guardians can stop without killing a reusable child', { timeout: 10_000 }, async () => {
  const child = spawnIdleNode();
  let guardian = null;
  try {
    guardian = startChildGuardian({
      childPid: child.pid,
      childGroupPid: child.pid,
      label: 'guardian-stop-test',
      pollMs: 100,
    });
    assert.ok(guardian?.pid);
    assert.equal(await waitUntil(() => pidAlive(guardian.pid)), true);
    assert.equal(guardian.stop(), true);
    assert.equal(await waitUntil(() => !pidAlive(guardian.pid)), true);
    assert.equal(pidAlive(child.pid), true);
  } finally {
    guardian?.stop?.();
    killIdleNode(child);
  }
});

test('memory-protected child guardians kill their owned tree under host pressure', { timeout: 10_000 }, async () => {
  const child = spawnIdleNode();
  let guardian = null;
  try {
    guardian = startChildGuardian({
      childPid: child.pid,
      childGroupPid: child.pid,
      label: 'guardian-memory-test',
      pollMs: 100,
      minFreeMemoryMb: Math.ceil(totalmem() / (1024 * 1024)) + 1024,
    });
    assert.ok(guardian?.pid);
    assert.equal(await waitUntil(() => !pidAlive(child.pid)), true);
  } finally {
    guardian?.stop?.();
    killIdleNode(child);
  }
});
