// A session runtime's config at create: served by the event-driven snapshot,
// never a synchronous reload, and still current after this process's writes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-config-create-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(root, 'backups');
after(() => rmSync(root, { recursive: true, force: true }));

const cfgMod = await import('../../runtime/agent/orchestrator/config.mjs');
const sharedCfgMod = await import('../../runtime/shared/config.mjs');
const { beginBoot } = await import('./begin.mjs');
const { resolveConfig } = await import('./config.mjs');

function bootWith(cfg) {
  const boot = beginBoot({ provider: 'openai', model: 'gpt-5.4', toolMode: 'full', cwd: root });
  boot.cfgMod = cfg;
  boot.sharedCfgMod = sharedCfgMod;
  return boot;
}

test('create reads the snapshot, runs no synchronous loadConfig, and sees a write made just before', async () => {
  let loads = 0;
  const cfg = {
    ...cfgMod,
    loadConfig: (...args) => {
      loads += 1;
      return cfgMod.loadConfig(...args);
    },
  };
  const first = bootWith(cfg);
  await resolveConfig(first);

  await sharedCfgMod.updateSectionAsync('agent', (agent) => ({ ...agent, autoClear: { idleMs: 123456 } }));
  const second = bootWith(cfg);
  await resolveConfig(second);

  assert.equal(loads, 0, 'no loadConfig on the create path');
  assert.equal(second.rt.config.autoClear.idleMs, 123456);
});
