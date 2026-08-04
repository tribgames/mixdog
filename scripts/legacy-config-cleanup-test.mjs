import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('agent config migrates legacy Fast preferences and stops persisting dead containers', async () => {
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-legacy-config-'));
  const configPath = join(dataDir, 'mixdog-config.json');
  writeFileSync(configPath, JSON.stringify({
    agent: {
      fastModels: {
        'example/migrated': true,
        'example/explicit': true,
      },
      modelSettings: {
        'example/explicit': { fast: false, effort: 'high' },
      },
      agentMaintenance: { enabled: true, interval: '1h' },
      runtime: { unused: true },
    },
  }), 'utf8');

  try {
    process.env.MIXDOG_DATA_DIR = dataDir;
    const configModule = await import(`../src/runtime/agent/orchestrator/config.mjs?legacy-cleanup=${Date.now()}`);
    const loaded = configModule.loadConfig({ secrets: false });

    assert.equal(loaded.modelSettings['example/migrated'].fast, true);
    assert.equal(loaded.modelSettings['example/explicit'].fast, false);
    assert.equal(Object.hasOwn(loaded, 'fastModels'), false);
    assert.equal(Object.hasOwn(loaded, 'agentMaintenance'), false);
    assert.equal(Object.hasOwn(loaded, 'runtime'), false);

    configModule.saveConfig(loaded);
    const savedAgent = JSON.parse(readFileSync(configPath, 'utf8')).agent;
    assert.equal(savedAgent.modelSettings['example/migrated'].fast, true);
    assert.equal(savedAgent.modelSettings['example/explicit'].fast, false);
    assert.equal(Object.hasOwn(savedAgent, 'fastModels'), false);
    assert.equal(Object.hasOwn(savedAgent, 'agentMaintenance'), false);
    assert.equal(Object.hasOwn(savedAgent, 'runtime'), false);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});
