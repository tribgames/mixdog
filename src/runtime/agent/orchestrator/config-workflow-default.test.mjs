import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('new and unset workflows use Solo without replacing explicit selections', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-workflow-default-'));
  const source = String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import {
      buildDefaultConfig, loadConfig, saveConfig, saveConfigAsync,
    } from './src/runtime/agent/orchestrator/config.mjs';
    import { createWorkflowHelpers } from './src/session-runtime/workflow.mjs';

    const path = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
    const { activeWorkflowId } = createWorkflowHelpers({
      rootDir: join(process.cwd(), 'src'),
      dataDir: process.env.MIXDOG_DATA_DIR,
    });
    assert.equal(buildDefaultConfig({ detectCredentials: false }).workflow.active, 'solo');
    assert.equal(loadConfig({ secrets: false }).workflow.active, 'solo');
    assert.equal(activeWorkflowId({}), 'solo');

    for (const agent of [
      {},
      { workflow: {} },
      { workflow: { active: '' } },
      { workflow: null },
    ]) {
      writeFileSync(path, JSON.stringify({ agent }));
      const loaded = loadConfig({ secrets: false });
      assert.equal(loaded.workflow.active, 'solo');
      assert.equal(activeWorkflowId(loaded), 'solo');
    }

    for (const save of [saveConfig, saveConfigAsync]) {
      await save({});
      assert.equal(JSON.parse(readFileSync(path, 'utf8')).agent.workflow.active, 'solo');
      assert.equal(loadConfig({ secrets: false }).workflow.active, 'solo');

      for (const active of ['solo', 'default', 'custom-workflow']) {
        writeFileSync(path, JSON.stringify({ agent: { workflow: { active } } }));
        const loaded = loadConfig({ secrets: false });
        assert.equal(loaded.workflow.active, active);
        assert.equal(activeWorkflowId(loaded), active);
        await save(loaded);
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).agent.workflow.active, active);
        assert.equal(loadConfig({ secrets: false }).workflow.active, active);
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
