// The active WORKFLOW.md feeds every session's 2 s status pulse (boot/facade
// currentWorkflow). Pulse reads must be shared process-wide and revalidated
// off the caller's stack, while edits made through the app's own workflow
// writers are visible to the pulse at once.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowHelpers } from '../workflow.mjs';
import { SHARED_SCAN_REVALIDATE_MS } from './shared-scan-cache.mjs';
import { createWorkflowPacksApi } from '../workflow-agents-api/workflow-packs.mjs';
import { normalizeAgentPermissionOrNone, readMarkdownDocument } from '../../runtime/shared/markdown-frontmatter.mjs';

function writePack(root, id, name, body = 'Lead delegates.') {
  mkdirSync(join(root, 'workflows', id), { recursive: true });
  writeFileSync(join(root, 'workflows', id, 'WORKFLOW.md'), `---\nid: ${id}\nname: ${name}\n---\n${body}\n`);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-workflow-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writePack(root, 'default', 'Default');
  const helpers = () => createWorkflowHelpers({ rootDir: root, dataDir: data, readMarkdownDocument, normalizeAgentPermissionOrNone });
  return { root, data, helpers };
}

function spyReads(t, root) {
  const inRoot = (path) => String(path).startsWith(root);
  const sync = mock.method(fs, 'readFileSync');
  const async = mock.method(fsPromises, 'readFile');
  syncBuiltinESMExports();
  t.after(() => {
    sync.mock.restore();
    async.mock.restore();
    syncBuiltinESMExports();
  });
  return {
    sync: () => sync.mock.calls.filter((call) => inRoot(call.arguments[0])).length,
    async: () => async.mock.calls.filter((call) => inRoot(call.arguments[0])).length,
  };
}

async function settle(read, predicate) {
  for (let i = 0; i < 500; i += 1) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return read();
}

test('many sessions share one WORKFLOW.md read per interval and pick up an on-disk edit', async (t) => {
  const { root, data, helpers } = fixture(t);
  const reads = spyReads(t, root);
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const sessions = Array.from({ length: 32 }, helpers);

  for (let tick = 0; tick < 3; tick += 1) {
    for (const session of sessions) assert.equal(session.sharedWorkflowPack(data, 'default').name, 'Default');
  }
  // Cold resolve: the missing user override, then the built-in pack.
  assert.equal(reads.sync(), 2, 'one cold resolve for all 32 sessions');
  assert.equal(reads.async(), 0);

  writePack(root, 'default', 'Edited');
  for (const session of sessions) assert.equal(session.sharedWorkflowPack(data, 'default').name, 'Default');

  mock.timers.tick(SHARED_SCAN_REVALIDATE_MS);
  for (const session of sessions) {
    // Stale-while-revalidate: the tick returns at once with the cached pack.
    assert.equal(session.sharedWorkflowPack(data, 'default').name, 'Default');
  }
  const pack = await settle(
    () => sessions[0].sharedWorkflowPack(data, 'default'),
    (value) => value.name === 'Edited'
  );
  assert.equal(pack.name, 'Edited');
  for (const session of sessions) assert.equal(session.sharedWorkflowPack(data, 'default').name, 'Edited');
  assert.equal(reads.async(), 2, 'one background resolve for all 32 sessions');
  assert.equal(reads.sync(), 2, 'revalidation never reads on the caller stack');
});

test('saves, deletes and switches through the workflow writers reach the pulse read at once', async (t) => {
  const { data, helpers } = fixture(t);
  mock.timers.enable({ apis: ['Date'], now: 2_000_000 });
  t.after(() => mock.timers.reset());
  const session = helpers();
  let config = { workflow: { active: 'default' } };
  const api = createWorkflowPacksApi({
    ...session,
    getConfig: () => config,
    displayConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
    },
    cfgMod: { getPluginData: () => data },
    STANDALONE_DATA_DIR: data,
  });
  // The exact read boot/facade currentWorkflow makes on every tick.
  const pulse = () => session.activeWorkflowSummary(config, data);
  assert.equal(pulse().name, 'Default');

  await api.saveWorkflowPack({ id: 'default', name: 'My Default', body: 'Override.' });
  assert.equal(pulse().name, 'My Default');
  assert.equal(pulse().source, 'user');

  await api.deleteWorkflow('default');
  assert.equal(pulse().name, 'Default');
  assert.equal(pulse().source, 'built-in');

  await api.createWorkflow({ id: 'review', name: 'Review', body: 'Review first.' });
  await api.setWorkflow('review');
  assert.equal(pulse().id, 'review');
  assert.equal(pulse().name, 'Review');
  await api.saveWorkflowPack({ id: 'review', name: 'Review v2', body: 'Review first.' });
  assert.equal(pulse().name, 'Review v2');
});
