// Unloading a settled agent session (after every turn) must leave its
// background shell jobs running: their completions wake the agent, the Lead may
// use a server it left, a later `send` may await them. Only an explicit close
// stops the agent's shells (cancelOwnedShellTrees); other sessions' jobs stay.
// Import before runtime modules: several paths are captured at module load.
import { fixtureRoot } from '../../tools/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { execShellCommand } from '../../tools/shell-command.mjs';
import { shutdownShellJobs } from '../../tools/builtin/shell-jobs.mjs';
import {
  _resetNativeSpawnClientForTest,
  _setNativeSpawnBinaryForTest,
  getNativeTask,
  shutdownNativeSpawnServer,
} from '../../tools/lib/native-spawn-client.mjs';
import { closeSession, unloadSessionRuntime } from './session-close.mjs';

const AGENT = 'sess_unload_agent';
const OTHER = 'sess_unload_other';

const binary = resolve(
  'native/mixdog-spawn/target/debug',
  process.platform === 'win32' ? 'mixdog-spawn.exe' : 'mixdog-spawn'
);
const hasBinary = existsSync(binary);
const skipNative = hasBinary ? false : `native spawn test binary not found: ${binary}`;
if (hasBinary) _setNativeSpawnBinaryForTest(binary);
const keepAlive = setInterval(() => {}, 1_000);
test.after(async () => {
  clearInterval(keepAlive);
  if (!hasBinary) return;
  await shutdownShellJobs('test-cleanup');
  await shutdownNativeSpawnServer('test-finish').catch(() => {});
  _resetNativeSpawnClientForTest();
});

async function startBackgroundJob(owner) {
  const result = await execShellCommand({
    shell: process.execPath,
    shellArg: '',
    env: process.env,
    cwd: fixtureRoot,
    command: `long ${owner}`,
    directArgv: ['-e', 'setTimeout(() => {}, 60000)'],
    timeoutMs: 0,
    autoBackgroundMs: 200,
    backgroundOnTimeout: true,
    ownerSessionId: owner,
    callerSessionId: owner,
  });
  assert.equal(result.backgrounded, true, result.stderr);
  assert.equal(getNativeTask(result.jobId)?.status, 'running');
  return result.jobId;
}

test('unloading an agent session keeps its background shell job running; explicit close stops it', {
  skip: skipNative,
  timeout: 60_000,
}, async () => {
  const agentJob = await startBackgroundJob(AGENT);
  const otherJob = await startBackgroundJob(OTHER);

  assert.equal(unloadSessionRuntime(AGENT, 'agent-turn-complete'), true);
  await delay(1_000);
  assert.equal(getNativeTask(agentJob)?.status, 'running', 'unload leaves the agent job running');
  assert.equal(getNativeTask(otherJob)?.status, 'running');

  assert.equal(closeSession(AGENT, 'agent-close'), true);
  const deadline = Date.now() + 20_000;
  while (getNativeTask(agentJob)?.status === 'running' && Date.now() < deadline) await delay(50);
  assert.notEqual(getNativeTask(agentJob)?.status, 'running', 'explicit close stops the agent job');
  assert.equal(getNativeTask(otherJob)?.status, 'running', "another session's job is untouched");
});
