import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('Default and independent orchestration preserve legacy Solo/Cowork selections', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-workflow-default-'));
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import {
      buildDefaultConfig, loadConfig, saveConfig, saveConfigAsync,
    } from './src/runtime/agent/orchestrator/config.mjs';
    import { createWorkflowHelpers } from './src/runtime/agent/orchestrator/runtime-core/workflow.mjs';

    const path = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
    const { activeWorkflowId } = createWorkflowHelpers({
      rootDir: join(process.cwd(), 'src'),
      dataDir: process.env.MIXDOG_DATA_DIR,
    });
    assert.equal(buildDefaultConfig({ detectCredentials: false }).workflow.active, 'default');
    assert.equal(buildDefaultConfig({ detectCredentials: false }).orchestrationMode, 'balanced');
    assert.equal(loadConfig({ secrets: false }).workflow.active, 'default');
    assert.equal(activeWorkflowId({}), 'default');

    for (const agent of [
      {},
      { workflow: {} },
      { workflow: { active: '' } },
      { workflow: null },
    ]) {
      writeFileSync(path, JSON.stringify({ agent }));
      const loaded = loadConfig({ secrets: false });
      assert.equal(loaded.workflow.active, 'default');
      // Solo was the old default workflow, so it is not carried over as a mode.
      assert.equal(loaded.orchestrationMode, 'balanced');
      assert.equal(activeWorkflowId(loaded), 'default');
    }

    for (const save of [saveConfig, saveConfigAsync]) {
      await save({});
      // The default workflow lives in code and is not written.
      assert.equal(Object.hasOwn(JSON.parse(readFileSync(path, 'utf8')).agent, 'workflow'), false);
      assert.equal(loadConfig({ secrets: false }).workflow.active, 'default');
      assert.equal(loadConfig({ secrets: false }).orchestrationMode, 'balanced');

      for (const active of ['solo', 'default', 'custom-workflow']) {
        writeFileSync(path, JSON.stringify({ agent: { workflow: { active } } }));
        const loaded = loadConfig({ secrets: false });
        const nextActive = active === 'solo' ? 'default' : active;
        const mode = active === 'solo' ? 'balanced' : 'swarm';
        assert.equal(loaded.workflow.active, nextActive);
        assert.equal(activeWorkflowId(loaded), nextActive);
        assert.equal(loaded.orchestrationMode, mode);
        await save(loaded);
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).agent.workflow?.active ?? 'default', nextActive);
        assert.equal(loadConfig({ secrets: false }).workflow.active, nextActive);
        assert.equal(loadConfig({ secrets: false }).orchestrationMode, mode);
      }
      for (const orchestrationMode of ['none', 'focused', 'balanced', 'swarm']) {
        await save({ workflow: { active: 'default' }, orchestrationMode });
        const loaded = loadConfig({ secrets: false });
        assert.equal(loaded.workflow.active, 'default');
        assert.equal(loaded.orchestrationMode, orchestrationMode);
      }
    }
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_CONFIG_READ_TTL_MS: '0',
        MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'backups'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
