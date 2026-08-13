import test from 'node:test';
import assert from 'node:assert/strict';
import './native-spawn-test-runtime.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execShellCommand } from '../src/runtime/agent/orchestrator/tools/shell-command.mjs';
import {
  commandNeedsShell,
  planDirectExeSpawn,
  resolveDirectExe,
  tokenizeDirectArgv,
} from '../src/runtime/agent/orchestrator/tools/builtin/shell-direct-exe.mjs';

function withFakeExe(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-direct-exe-'));
  try {
    writeFileSync(join(dir, name), 'fake');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WIN_PS = { platform: 'win32', shellType: 'powershell' };

test('tokenizeDirectArgv keeps Windows paths and quoted args', () => {
  assert.deepEqual(tokenizeDirectArgv('git status'), ['git', 'status']);
  assert.deepEqual(
    tokenizeDirectArgv('C:\\foo\\bar.exe -e "a b"'),
    ['C:\\foo\\bar.exe', '-e', 'a b'],
  );
  assert.equal(tokenizeDirectArgv('node -e "oops'), null);
});

test('commandNeedsShell rejects operators and expansion', () => {
  assert.equal(commandNeedsShell('git status'), false);
  assert.equal(commandNeedsShell('node -e "console.log(1)"'), false);
  assert.equal(commandNeedsShell('git status && git diff'), true);
  assert.equal(commandNeedsShell('git status | more'), true);
  assert.equal(commandNeedsShell('git commit -m "a & b"'), false);
  assert.equal(commandNeedsShell('git commit -m "cost $n"'), true);
  assert.equal(commandNeedsShell('echo $env:PATH'), true);
});

test('planDirectExeSpawn is Windows+pwsh and real .exe only', () => {
  withFakeExe('git.exe', (dir) => {
    const hit = planDirectExeSpawn('git status', { ...WIN_PS, cwd: dir, pathValue: dir, env: {} });
    assert.ok(hit);
    assert.equal(hit.exe.toLowerCase(), join(dir, 'git.exe').toLowerCase());
    assert.deepEqual(hit.argv, ['status']);
    assert.equal(planDirectExeSpawn('git status', {
      ...WIN_PS, cwd: dir, pathValue: dir, env: { MIXDOG_SHELL_DIRECT_EXE: '0' },
    }), null);
    assert.equal(planDirectExeSpawn('git status', {
      platform: 'linux', shellType: 'powershell', cwd: dir, pathValue: dir, env: {},
    }), null);
    assert.equal(planDirectExeSpawn('git status', {
      platform: 'win32', shellType: 'posix', cwd: dir, pathValue: dir, env: {},
    }), null);
    assert.equal(planDirectExeSpawn('git status && git diff', {
      ...WIN_PS, cwd: dir, pathValue: dir, env: {},
    }), null);
  });
});

test('planDirectExeSpawn refuses cmdlets, aliases, and script wrappers', () => {
  withFakeExe('ls.exe', (dir) => {
    writeFileSync(join(dir, 'npm.cmd'), 'rem');
    writeFileSync(join(dir, 'Get-ChildItem.exe'), 'fake');
    assert.equal(planDirectExeSpawn('ls', { ...WIN_PS, cwd: dir, pathValue: dir, env: {} }), null);
    assert.equal(planDirectExeSpawn('Get-ChildItem', { ...WIN_PS, cwd: dir, pathValue: dir, env: {} }), null);
    assert.equal(planDirectExeSpawn('npm install', { ...WIN_PS, cwd: dir, pathValue: dir, env: {} }), null);
    assert.equal(resolveDirectExe('npm', { cwd: dir, pathValue: dir }), null);
  });
});

test('planDirectExeSpawn accepts node -e with a real node.exe', () => {
  const plan = planDirectExeSpawn(`"${process.execPath}" -e "process.stdout.write('ok')"`, {
    ...WIN_PS,
    cwd: process.cwd(),
    pathValue: '',
    env: {},
  });
  if (process.platform !== 'win32' && !/\.exe$/i.test(process.execPath)) {
    assert.equal(plan, null);
    return;
  }
  assert.ok(plan);
  assert.equal(plan.exe, process.execPath);
  assert.deepEqual(plan.argv, ['-e', "process.stdout.write('ok')"]);
});

test('execShellCommand directArgv runs the exe without a shell wrapper', { timeout: 15_000 }, async () => {
  const result = await execShellCommand({
    shell: process.execPath,
    shellArg: '',
    shellArgs: [],
    command: 'node -e direct',
    directArgv: ['-e', 'process.stdout.write("ok")'],
    env: process.env,
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(String(result.stdout || '').trim(), 'ok');
});
