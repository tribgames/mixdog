import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('config migration removes retired local endpoints and persists Local Provider install state', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-local-provider-config-'));
  const source = String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { loadConfig, saveConfig } from './src/runtime/agent/orchestrator/config.mjs';

    const path = join(process.env.MIXDOG_DATA_DIR, 'mixdog-config.json');
    writeFileSync(path, JSON.stringify({
      agent: {
        providers: {
          ollama: { enabled: true, baseURL: 'http://localhost:11434/v1' },
          lmstudio: { enabled: true, baseURL: 'http://localhost:1234/v1' },
          'mixdog-local': { enabled: true }
        },
        presets: [
          { id: 'legacy-local', provider: 'ollama', model: 'old-model' },
          { id: 'cloud', provider: 'openai', model: 'gpt-test' }
        ],
        default: 'legacy-local',
        agents: {
          worker: { provider: 'lmstudio', model: 'old-model' },
          keeper: { provider: 'openai', model: 'gpt-test' }
        },
        maintenance: {
          memory: { provider: 'ollama', model: 'old-model' }
        },
        modelSettings: {
          'ollama/old-model': { contextPercent: 50 },
          'openai/gpt-test': { contextPercent: 70 }
        },
        modules: { localProvider: { enabled: true } },
        builtins: { localProvider: { installed: true } }
      }
    }));

    const loaded = loadConfig({ secrets: false });
    assert.equal(loaded.providers.ollama, undefined);
    assert.equal(loaded.providers.lmstudio, undefined);
    assert.equal(loaded.providers['mixdog-local'].enabled, true);
    assert.equal(loaded.presets.some((entry) => entry.id === 'legacy-local'), false);
    assert.equal(loaded.default, null);
    assert.equal(loaded.agents.worker, undefined);
    assert.equal(loaded.agents.keeper.provider, 'openai');
    assert.equal(loaded.modelSettings['ollama/old-model'], undefined);
    assert.equal(loaded.modelSettings['openai/gpt-test'].contextPercent, 70);
    assert.equal(loaded.builtins.localProvider.installed, true);

    saveConfig(loaded);
    const persisted = JSON.parse(readFileSync(path, 'utf8')).agent;
    assert.deepEqual(persisted.builtins.localProvider, { installed: true });
    assert.equal(persisted.providers.ollama, undefined);
    assert.equal(persisted.providers.lmstudio, undefined);
    assert.equal(loadConfig({ secrets: false }).builtins.localProvider.installed, true);
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: repoRoot,
      env: { ...process.env, MIXDOG_DATA_DIR: dataDir, MIXDOG_CONFIG_READ_TTL_MS: '0' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
