// Review regressions for the request-boundary exposure migration: the saved
// session carries the new prompt with the new exposure, and a native ↔
// bridge round trip at the boundary keeps native discoveries.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-exposure-save-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;

const { saveSessionAsync } = await import('../store.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { migrateToolExposureAtBoundary } = await import('./tool-exposure-migration.mjs');
const { applyDeferredToolSurface, selectDeferredTools } = await import('../../runtime-core/tool-catalog.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  await (await import('../store/lifecycle-barriers.mjs')).flushSessionCloseMetrics();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const def = (name, readOnly = false) => ({
  name,
  description: `${name} tool.`,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: readOnly },
});
const CATALOG = [def('read', true), def('shell'), def('bridge_probe', true), def('office')];
const ALL = CATALOG.map((tool) => tool.name);
const OLD_MANIFEST = '<available-deferred-tools>\n- bridge_probe: Probe.\n</available-deferred-tools>';
const now = Date.now();

test('a saved boundary migration persists the bridge prompt with bridge-v1, never the old manifest', async () => {
  const session = {
    id: 'sess_exposure_save',
    owner: 'user',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    provider: 'openrouter',
    model: 'fixture-model',
    toolSpec: 'full',
    deferredProviderMode: 'canonical',
    deferredSurfaceMode: 'lead',
    tools: CATALOG.slice(),
    deferredToolCatalog: CATALOG.slice(),
    deferredSelectedTools: ALL,
    deferredCallableTools: ALL,
    deferredToolBp2Applied: true,
    messages: [
      { role: 'system', content: '# Tool Use' },
      { role: 'system', content: `# Profile\n\n---\n\n${OLD_MANIFEST}` },
      { role: 'system', content: '# Session', cacheTier: 'tier3' },
      { role: 'user', content: 'earlier request' },
      { role: 'assistant', content: 'earlier answer' },
    ],
  };
  await saveSessionAsync(session);
  // The running turn works on its own array built on the stored transcript.
  const working = [...session.messages, { role: 'user', content: 'next request' }];
  assert.equal(migrateToolExposureAtBoundary(session, working), true);
  assert.match(working[1].content, /<tool-bridge>/);
  assert.equal(session.messages[1], working[1], 'the canonical transcript takes the rewritten prompt');
  await saveSessionAsync(session);

  const disk = JSON.parse(readFileSync(join(root, 'sessions', `${session.id}.json`), 'utf8'));
  assert.equal(disk.toolExposureMode, 'bridge-v1');
  const system = disk.messages.filter((message) => message.role === 'system').map((message) => message.content);
  assert.equal(system.join('\n').match(/<tool-bridge>/g)?.length, 1);
  // The old manifest is gone; the bridge roster replaced it once.
  assert.doesNotMatch(system.join('\n'), /- bridge_probe: Probe\./);
  assert.equal(system.join('\n').match(/<available-deferred-tools>/g)?.length, 1);
  assert.match(system.join('\n'), /^- bridge_probe: bridge_probe tool\.$/m);
  // Reloaded, the session needs no second migration.
  const reloaded = { ...disk, tools: session.tools };
  assert.equal(migrateToolExposureAtBoundary(reloaded, reloaded.messages), false);
});

test('native → bridge → native at the request boundary keeps native discoveries', () => {
  const session = {
    id: 'sess_exposure_roundtrip',
    provider: 'anthropic-oauth',
    model: 'fixture-model',
    toolSpec: 'full',
    tools: CATALOG.slice(),
    messages: [
      { role: 'system', content: '# Tool Use' },
      { role: 'system', content: '# Profile' },
      { role: 'user', content: 'hi' },
    ],
  };
  applyDeferredToolSurface(session, 'lead', []);
  assert.deepEqual(selectDeferredTools(session, ['office'], 'lead').added, ['office']);
  assert.ok(session.deferredDiscoveredTools.includes('office'));

  // The persisted provider changed without a surface rebuild (e.g. a stored
  // route): the boundary migrates it.
  session.provider = 'gemini';
  assert.equal(migrateToolExposureAtBoundary(session, session.messages), true);
  assert.equal(session.toolExposureMode, 'bridge-v1');
  assert.ok(session.nativeDeferredDiscovery.includes('office'));

  session.provider = 'anthropic-oauth';
  assert.equal(migrateToolExposureAtBoundary(session, session.messages), true);
  assert.equal(session.toolExposureMode, undefined);
  assert.ok(session.deferredDiscoveredTools.includes('office'), 'the native discovery survives the round trip');
  assert.equal(session.nativeDeferredDiscovery, undefined);
});
