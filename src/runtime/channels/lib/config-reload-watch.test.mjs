import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

const sharedConfig = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'config.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-channels-reload-'));
const saved = new Map();
for (const [key, value] of Object.entries({
  MIXDOG_DATA_DIR: path.join(root, 'data'),
  MIXDOG_USER_DATA_BACKUP_ROOT: path.join(root, 'backups'),
})) {
  saved.set(key, process.env[key]);
  process.env[key] = value;
}
fs.mkdirSync(process.env.MIXDOG_DATA_DIR);
const { updateSection } = await import('../../shared/config.mjs');
const { createConfigReloadWatch } = await import('./config-reload-watch.mjs');

after(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
  return true;
}

// Another process's write: it reaches this one only through the watch.
function writeFromAnotherProcess(revision) {
  const script = `
    const { updateSection } = await import(${JSON.stringify(pathToFileURL(sharedConfig).href)});
    updateSection('channels', (section) => ({ ...section, revision: ${revision} }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('every config write by another process reloads the channels runtime, not only the first atomic rename', async () => {
  let reloads = 0;
  const watch = createConfigReloadWatch(async () => {
    reloads += 1;
  });
  watch.start();
  try {
    for (let write = 1; write <= 3; write += 1) {
      writeFromAnotherProcess(write);
      assert.ok(await waitFor(() => reloads >= write), `write ${write} reloaded (reloads=${reloads})`);
    }
  } finally {
    watch.stop();
  }
  const settled = reloads;
  updateSection('channels', (section) => ({ ...section, revision: 4 }));
  await sleep(400);
  assert.equal(reloads, settled, 'a stopped watch reloads nothing');
});

test('changes outside the channels and voice sections never restart the listeners', async () => {
  let reloads = 0;
  const watch = createConfigReloadWatch(async () => {
    reloads += 1;
  });
  watch.start();
  try {
    updateSection('agent', (section) => ({ ...section, promptCacheWarming: false }));
    await sleep(400);
    assert.equal(reloads, 0, 'an agent setting leaves the webhook server running');
    updateSection('voice', (section) => ({ ...section, language: 'ko' }));
    assert.ok(await waitFor(() => reloads === 1), 'a voice change reloads');
  } finally {
    watch.stop();
  }
});

test('a slower load of an older config never overwrites a newer one', async () => {
  const { createConfigReloader } = await import('./owned-runtime/config-reload.mjs');
  const loads = new Map();
  let calls = 0;
  let config = null;
  const reload = createConfigReloader({
    state: { automationRunning: true },
    getConfig: () => config,
    setConfig: (value) => {
      config = value;
    },
    getBridgeRuntimeConnected: () => false,
    scheduler: { reloadConfig() {} },
    services: { syncWebhookAndEventRuntime() {}, stopWebhookAndEventRuntime: async () => {} },
    load: () => {
      calls += 1;
      return new Promise((resolve) => loads.set(calls, resolve));
    },
  });
  const watch = createConfigReloadWatch(reload);
  watch.start();
  try {
    updateSection('channels', (section) => ({ ...section, revision: 101 }));
    assert.ok(await waitFor(() => loads.size === 1), 'revision 1 load started');
    updateSection('channels', (section) => ({ ...section, revision: 102 }));
    assert.ok(await waitFor(() => loads.size === 2), 'revision 2 load started');
    loads.get(2)({ revision: 2 });
    assert.ok(await waitFor(() => config?.revision === 2), 'revision 2 applied');
    loads.get(1)({ revision: 1 });
    await sleep(100);
    assert.equal(config.revision, 2, 'the older load resolving last is discarded');
  } finally {
    watch.stop();
  }
});
