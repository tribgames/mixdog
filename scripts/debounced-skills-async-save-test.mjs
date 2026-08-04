#!/usr/bin/env node
// Proves the debounced skills save persists through the ASYNC config path and
// that the debounce-timer flush routes through async I/O (async icacls), never
// the sync icacls, on the timer path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, '../src');

test('patchSkillsDisabledAsync persists agent.skills.disabled to disk (async path)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-skills-async-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  // Keep the test hermetic: skip the user-data backup copy tree.
  process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
  try {
    // Import AFTER env is set: shared/config.mjs resolves DATA_DIR at load.
    const cfg = await import(pathToFileURL(join(SRC, 'runtime/agent/orchestrator/config.mjs')).href);
    const out = await cfg.patchSkillsDisabledAsync(['zeta', 'alpha']);
    assert.deepEqual(out.disabled, ['alpha', 'zeta']); // normalized + sorted
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'mixdog-config.json'), 'utf8'));
    assert.deepEqual(onDisk.agent.skills.disabled, ['alpha', 'zeta']);
    // A second async patch must last-writer-win, not append.
    await cfg.patchSkillsDisabledAsync(['beta']);
    const onDisk2 = JSON.parse(readFileSync(join(dataDir, 'mixdog-config.json'), 'utf8'));
    assert.deepEqual(onDisk2.agent.skills.disabled, ['beta']);
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    delete process.env.MIXDOG_DATA_DIR;
    delete process.env.MIXDOG_SKIP_USER_DATA_BACKUP;
  }
});

test('debounce timer path routes through the async flush (async icacls), sync flush retained', () => {
  const lifecycle = readFileSync(`${SRC}/session-runtime/config-lifecycle.mjs`, 'utf8');
  // Skills timer schedules the ASYNC flush, and the async runner uses the async
  // persist twin — so the timer path never hits the sync icacls RMW.
  assert.match(lifecycle, /scheduleSkillsSave\(names\)[\s\S]*?setTimeout\(\(\) => \{ flushSkillsSaveAsync\(\); \}/);
  assert.match(lifecycle, /runSkillsFlushAsync[\s\S]*?cfgMod\.patchSkillsDisabledAsync\(names\)/);
  // Config/backend/outputStyle timers likewise fire the async flush.
  assert.match(lifecycle, /setTimeout\(\(\) => \{ flushConfigSaveAsync\(\); \}/);
  assert.match(lifecycle, /setTimeout\(\(\) => \{ flushBackendSaveAsync\(\); \}/);
  assert.match(lifecycle, /setTimeout\(\(\) => \{ flushOutputStyleSaveAsync\(\); \}/);
  // Sync flushes stay for reloadFullConfig/teardown durability.
  assert.match(lifecycle, /function flushConfigSave\(\)/);
  assert.match(lifecycle, /function flushSkillsSave\(\)/);
  assert.match(lifecycle, /reloadFullConfig[\s\S]*?flushConfigSave\(\);/);

  const atomic = readFileSync(`${SRC}/runtime/shared/atomic-file.mjs`, 'utf8');
  // The async writer enforces the owner-only ACL via the async icacls variant.
  assert.match(atomic, /export async function writeFileAtomicAsync[\s\S]*?await _enforceOwnerOnlyAclWin32Async\(tmp\)/);
  assert.match(atomic, /_enforceOwnerOnlyAclWin32Async[\s\S]*?_execFileAsync\(icacls/);
});
