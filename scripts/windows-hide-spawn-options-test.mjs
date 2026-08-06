import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
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

test('child guardians share one broker without coupling child lifetimes', { timeout: 10_000 }, async () => {
  const firstChild = spawnIdleNode();
  const secondChild = spawnIdleNode();
  let first = null;
  let second = null;
  try {
    first = startChildGuardian({ childPid: firstChild.pid, pollMs: 100 });
    second = startChildGuardian({ childPid: secondChild.pid, pollMs: 100 });
    assert.ok(first?.pid);
    assert.equal(second?.pid, first.pid);
    assert.equal(first.stop(), true);
    await delay(250);
    assert.equal(pidAlive(first.pid), true, 'the broker remains for the second child');
    assert.equal(pidAlive(firstChild.pid), true);
    assert.equal(pidAlive(secondChild.pid), true);
    assert.equal(second.stop(), true);
    assert.equal(await waitUntil(() => !pidAlive(first.pid)), true);
  } finally {
    first?.stop?.();
    second?.stop?.();
    killIdleNode(firstChild);
    killIdleNode(secondChild);
  }
});

test('a naturally exited child is removed from the parent guardian registry', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 150)'], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const guardian = startChildGuardian({ childPid: child.pid, pollMs: 100 });
  try {
    assert.ok(guardian?.pid);
    assert.equal(await waitUntil(() => !pidAlive(child.pid)), true);
    assert.equal(await waitUntil(() => !pidAlive(guardian.pid)), true);
    assert.equal(guardian.stop(), false,
      'natural child exit must clear the parent-side broker target');
  } finally {
    guardian?.stop?.();
    killIdleNode(child);
  }
});
