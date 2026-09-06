import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithubService } from './github-service.ts';

test('desktop GitHub operations honor the same install and enable markers without touching auth', async () => {
  const previous = process.env.MIXDOG_FEATURE_GIT;
  delete process.env.MIXDOG_FEATURE_GIT;
  const config = { builtins: {}, modules: { git: { enabled: true } }, desktop: { git: { commitPreset: 'custom' } } };
  let executions = 0;
  const service = createGithubService(async () => ({ readConfig: () => config }), async (_cwd, input) => {
    executions++;
    return { action: input.action, repo: 'owner/repo', data: [] };
  });
  try {
    await assert.rejects(service(process.cwd(), { action: 'repo.list' }), /Enable Git & GitHub/);
    config.builtins.git = { installed: true };
    await service(process.cwd(), { action: 'repo.list' });
    config.modules.git.enabled = false;
    await assert.rejects(service(process.cwd(), { action: 'repo.list' }), /Enable Git & GitHub/);
    assert.equal(executions, 1);
    assert.equal(config.builtins.git.installed, true);
    assert.equal(config.desktop.git.commitPreset, 'custom');
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_FEATURE_GIT; else process.env.MIXDOG_FEATURE_GIT = previous;
  }
});
