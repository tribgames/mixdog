import '../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';

import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { ensureSessionScratchDir, sessionScratchDir } from '../../../shared/session-scratch.mjs';
import { buildShellSpawnEnv } from '../tools/builtin/bash-tool/spawn-env.mjs';
import { execShellCommand } from '../tools/shell-command.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  shutdownNativeSpawnServer,
} from '../tools/lib/native-spawn-client.mjs';
import { composeSessionSystem, buildWorkspacePromptContext } from './manager/session-prompt-composition.mjs';
import { deleteSession } from './store/session-delete.mjs';

const isWin = process.platform === 'win32';

test('shell env points TEMP, TMP and TMPDIR at the session scratch directory under the data dir', () => {
  const base = { PATH: process.env.PATH || '', TEMP: '/system/temp', TMP: '/system/temp', TMPDIR: '/system/temp' };
  const env = buildShellSpawnEnv('/project', base, 'sess_scratch_a');
  const dir = sessionScratchDir('sess_scratch_a');
  assert.ok(dir.startsWith(join(resolvePluginData(), 'scratch')));
  assert.ok(existsSync(dir));
  assert.deepEqual([env.TEMP, env.TMP, env.TMPDIR], [dir, dir, dir]);
  assert.equal(base.TEMP, '/system/temp');
  assert.notEqual(sessionScratchDir('sess_scratch_b'), dir);
  // No session: the environment keeps the system temp directory.
  assert.equal(buildShellSpawnEnv('/project', base).TEMP, '/system/temp');
  // A path-shaped id never names a directory.
  assert.equal(sessionScratchDir('../escape'), '');
});

test('deleting a session removes its scratch directory', () => {
  const id = 'sess_scratch_delete';
  const dir = ensureSessionScratchDir(id);
  const other = ensureSessionScratchDir('sess_scratch_keep');
  writeFileSync(join(dir, 'note.txt'), 'x');
  assert.equal(deleteSession(id), true);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(other), true);
});

function compose(sessionId, cwd) {
  const surface = {
    ownerIsAgent: false,
    resolvedAgent: 'lead',
    skills: [],
    ruleOmitTools: [],
    schemaAllowedTools: null,
    agentRulesProfile: undefined,
    toolsForRouting: [],
  };
  return composeSessionSystem(
    { cwd, systemPrompt: '' },
    { profile: null, providerName: 'test', modelName: 'm', surface, sessionId }
  );
}

test('the session environment names the scratch path in one stable line', () => {
  const dir = sessionScratchDir('sess_scratch_prompt');
  const first = compose('sess_scratch_prompt', process.cwd());
  const second = compose('sess_scratch_prompt', process.cwd());
  const lines = first.sessionEnvironment.split('\n').filter((line) => line.startsWith('- Scratch:'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(dir));
  assert.equal(second.sessionEnvironment, first.sessionEnvironment);
  assert.equal(second.environmentTailContext, first.environmentTailContext);
  // Re-rooting the workspace keeps the same line.
  const rerooted = buildWorkspacePromptContext({ id: 'sess_scratch_prompt', owner: 'user' }, process.cwd());
  assert.ok(rerooted.environmentContext.includes(lines[0]));
  // No session id, no line.
  assert.ok(!compose(undefined, process.cwd()).sessionEnvironment.includes('- Scratch:'));
});

const spawnBinary = ['release', 'debug']
  .map((profile) => resolve('native/mixdog-spawn/target', profile, isWin ? 'mixdog-spawn.exe' : 'mixdog-spawn'))
  .find((path) => existsSync(path));

test('shell children get the scratch env and, on Windows, no console window (nor do their children)', async (t) => {
  if (!spawnBinary) {
    t.skip('native spawn binary not built');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'mixdog-scratch-spawn-'));
  const admission = {
    async acquire() {
      return { signal: null, async detachDependency() {}, async release() {} };
    },
  };
  const run = (directArgv, env) =>
    execShellCommand({
      shell: directArgv[0],
      shellArg: '',
      command: 'scratch spawn test',
      directArgv: directArgv.slice(1),
      env,
      cwd: root,
      timeoutMs: 30_000,
      ownerSessionId: 'sess_scratch_spawn',
      clientHostPid: process.pid,
      admission,
    });
  try {
    _setNativeSpawnBinaryForTest(spawnBinary);
    const env = buildShellSpawnEnv(root, process.env, 'sess_scratch_spawn');
    const seen = await run(
      [process.execPath, '-e', 'console.log(JSON.stringify([process.env.TEMP, process.env.TMP, process.env.TMPDIR]))'],
      env
    );
    const dir = sessionScratchDir('sess_scratch_spawn');
    assert.deepEqual(JSON.parse(seen.stdout), [dir, dir, dir]);
    assert.equal(relative(resolvePluginData(), dir).startsWith('..'), false);

    if (isWin) {
      // GetConsoleWindow is NULL for a console process created without a window.
      const probe = join(root, 'probe.ps1');
      mkdirSync(root, { recursive: true });
      writeFileSync(
        probe,
        "Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow();' -Name W -Namespace N\n[N.W]::GetConsoleWindow().ToString()\n"
      );
      const opts = '-NoProfile -ExecutionPolicy Bypass';
      const windows = await run(
        [
          'powershell.exe',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `& '${probe}'; & powershell.exe ${opts} -File '${probe}'`,
        ],
        process.env
      );
      assert.deepEqual(windows.stdout.trim().split(/\r?\n/), ['0', '0']);
    }
  } finally {
    await shutdownNativeSpawnServer('test-finish').catch(() => {});
    _resetNativeSpawnClientForTest();
    rmSync(root, { recursive: true, force: true });
  }
});
