import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('config load moves routes off the retired Daybreak Blue model and persists it', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-daybreak-config-'));
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { loadConfig } from './src/runtime/agent/orchestrator/config.mjs';

    // The last fetched catalog drives the migration; nothing names a model.
    writeFileSync(join(process.env.MIXDOG_DATA_DIR, 'openai-oauth-models.json'), JSON.stringify({
      version: 7,
      fetchedAt: Date.now(),
      models: [
        { id: 'gpt-6-astra', priority: 2, accessPrograms: ['standard'] },
        { id: 'gpt-6-sol', priority: 3, accessPrograms: ['standard', 'daybreak_blue'] },
        { id: 'gpt-6-luna', priority: 4, accessPrograms: ['standard', 'daybreak_blue'] },
        { id: 'gpt-daybreak-blue-latest', priority: 11, accessPrograms: ['daybreak_blue'], hidden: true }
      ]
    }));
    const path = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
    writeFileSync(path, JSON.stringify({
      agent: {
        presets: [{ id: 'blue-lead', provider: 'openai-oauth', model: 'gpt-daybreak-blue-latest' }],
        agents: {
          security: {
            provider: 'openai-oauth',
            model: 'gpt-daybreak-blue-latest',
            effort: 'xhigh',
            modelParameters: {},
            fast: false
          },
          reviewer: { provider: 'openai-oauth', model: 'gpt-6-astra', effort: 'high' }
        },
        modelSettings: {
          'openai-oauth/gpt-daybreak-blue-latest': { effort: 'max', contextPercent: 30 },
          'openai-oauth/gpt-6-sol': { effort: 'high', contextPercent: 30 }
        }
      }
    }));

    const loaded = loadConfig({ secrets: false });
    assert.deepEqual(loaded.agents.security, {
      provider: 'openai-oauth',
      model: 'gpt-6-sol',
      effort: 'xhigh',
      modelParameters: { daybreak: 'on' },
      fast: false
    });
    assert.equal(loaded.agents.reviewer.model, 'gpt-6-astra');
    assert.equal(loaded.presets.find((p) => p.id === 'blue-lead').model, 'gpt-6-sol');
    assert.equal(loaded.modelSettings['openai-oauth/gpt-daybreak-blue-latest'], undefined);
    assert.deepEqual(loaded.modelSettings['openai-oauth/gpt-6-sol'], { effort: 'high', contextPercent: 30 });

    // The load persists the migration so every reader sees the new route.
    const persisted = JSON.parse(readFileSync(path, 'utf8')).agent;
    assert.equal(persisted.agents.security.model, 'gpt-6-sol');
    assert.deepEqual(persisted.agents.security.modelParameters, { daybreak: 'on' });
    assert.equal(persisted.modelSettings['openai-oauth/gpt-daybreak-blue-latest'], undefined);
    assert.equal(JSON.stringify(persisted).includes('gpt-daybreak-blue-latest'), false);
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
