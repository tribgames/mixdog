import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// The probes run through the off-thread git runner. A real child would hold the
// repository as its cwd for as long as it lives, outliving the test and blocking
// its removal on Windows, so the runner answers here and no git child ever runs
// in the repo. The prewarm and the synchronous fallback stay the real ones.
const gitRunner = await import('../../runtime/shared/git-runner.mjs');
const runnerCalls = [];
mock.module(new URL('../../runtime/shared/git-runner.mjs', import.meta.url).href, {
  namedExports: {
    ...gitRunner,
    runGitOffThread: async (args, options) => {
      runnerCalls.push({ args, cwd: options.cwd, input: options.input });
      // status: clean tree; check-ignore: exit 1, nothing ignored.
      return args.includes('check-ignore') ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
    },
  },
});
const { settleGitStartupProbes } = await import(
  '../../runtime/agent/orchestrator/tools/builtin/runtime-capabilities.mjs'
);
const { createPolicyStage } = await import('./policy-stage.mjs');

test('staging a policy answers the git probes off-thread: no synchronous git spawn follows', async (t) => {
  // The change-state and ignore probes only run inside a git work tree.
  const repo = mkdtempSync(join(tmpdir(), 'policy-stage-git-'));
  // Probes in flight settle before the removal below (hooks run in registration order).
  t.after(() => settleGitStartupProbes());
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  childProcess.spawnSync('git', ['init', '-q'], { cwd: repo });
  // Prewarming filters .git out; an ordinary entry makes the check-ignore probe run too.
  writeFileSync(join(repo, 'notes.txt'), 'x');
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
  await settleGitStartupProbes();
  const ran = (name) => runnerCalls.filter((call) => call.args.includes(name) && call.cwd === repo);
  assert.ok(ran('status').length > 0, 'the change-state probe ran off-thread in the repo');
  assert.ok(
    ran('check-ignore').some((call) => call.input.split('\0').includes('notes.txt')),
    'the ignore probe asked about the fixture file'
  );
});
