import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPolicyStage } from './policy-stage.mjs';

test('staging a policy answers the git probes off-thread: no synchronous git spawn follows', async (t) => {
  // The change-state and ignore probes only run inside a git work tree.
  const repo = mkdtempSync(join(tmpdir(), 'policy-stage-git-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: repo });
  const real = childProcess.spawnSync;
  const spawned = [];
  childProcess.spawnSync = function spy(command, ...rest) {
    spawned.push(String(command));
    return real.call(this, command, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawnSync = real;
    syncBuiltinESMExports();
  });
  const stage = createPolicyStage({
    getRoute: () => ({ provider: 'anthropic', model: 'claude-test' }),
    getMode: () => 'default',
    getDataDir: () => process.cwd(),
    getConfig: () => ({}),
    modelStandaloneTools: () => [],
    featureDisallowedTools: () => [],
    loadCoreMemoryContext: async () => '',
    loadInstructionFilesContext: () => '',
    activeWorkflowContext: () => ({
      summary: null,
      leadPromptParts: () => ({}),
      packContext: '',
      orchestrationMode: '',
    }),
  });
  const session = {
    id: 's1',
    cwd: repo,
    callerDisallowedTools: [],
    tools: [{ name: 'git' }],
    bp3EnvironmentContext: '# Environment\n',
  };
  await stage.stagePolicy(session, {}, {});
  stage.refreshEnvironmentFacts(session);
  assert.deepEqual(spawned, []);
});
