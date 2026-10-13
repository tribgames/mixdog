// Muse rows resolve through the shared metadata lookup: discovered fields,
// then models.dev `meta` (the same api.meta.ai endpoint), then seeds.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const dir = mkdtempSync(join(tmpdir(), 'mixdog-muse-catalog-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MUSE_CODE_OAUTH_CREDENTIALS_PATH = join(dir, 'muse-code-oauth.json');
test.after(() => rmSync(dir, { recursive: true, force: true }));

const FIVE = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const SIX = [...FIVE, 'max'];
const spark = (name, cost, values) => ({
  name,
  reasoning: true,
  tool_call: true,
  modalities: { input: ['text', 'image'] },
  limit: { context: 1048576, output: 65536 },
  cost,
  reasoning_options: [{ type: 'effort', values }],
});
writeFileSync(
  join(dir, 'modelsdev-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      meta: {
        models: {
          'muse-spark-1.3': spark('Muse Spark 1.3', { input: 1.5, output: 5, cache_read: 0.2 }, SIX),
          'muse-spark-1.3-contributor': spark('Muse Spark 1.3 Contributor', { input: 0.2, output: 0.4 }, FIVE),
          'muse-spark-1.1': {
            name: 'Muse Spark 1.1',
            reasoning: false,
            tool_call: false,
            modalities: { input: ['text'] },
            limit: { context: 400000 },
          },
        },
      },
    },
  })
);

const { MuseCodeOAuthProvider } = await import('./muse-code-oauth.mjs');
const tokens = await import('./muse-code-oauth-tokens.mjs');
const { getModelMetadataSync } = await import('./model-catalog.mjs');
const { providerCachedModelsSync } = await import('./provider-catalog-cache.mjs');

const values = (row) => row.reasoningOptions.find((o) => o.type === 'effort').values;

async function listed(items) {
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  provider._ensureInner('k')._fetchModelItems = async () => items;
  const rows = Object.fromEntries((await provider.listModels()).map((m) => [m.id, m]));
  return { provider, rows };
}

test('discovered and catalog data win over seeds; seeds fill only the rest', async () => {
  const { provider, rows } = await listed([
    { id: 'muse-spark-1.3-contributor', name: 'MUSE SPARK 1.3' },
    { id: 'muse-spark-1.3', context_window: 500000 },
    { id: 'muse-spark-1.2' },
    { id: 'muse-spark-1.2-contributor' },
  ]);
  const contributor = rows['muse-spark-1.3-contributor'];
  assert.deepEqual(values(contributor), SIX, 'verified correction: Muse OAuth accepts max');
  assert.equal(contributor.contextWindow, 1048576);
  assert.equal(contributor.outputTokens, 65536, 'catalog beats the seed');
  assert.equal(contributor.inputCostPerM, 0.2, 'catalog beats the seed');
  assert.equal(contributor.name, 'Muse Spark 1.3 (C)', 'same name without the tier marker keeps (C)');

  const standard = rows['muse-spark-1.3'];
  assert.equal(standard.contextWindow, 500000, 'discovery beats the catalog');
  assert.deepEqual(values(standard), SIX);
  assert.equal(standard.inputCostPerM, 1.5);

  const offline = rows['muse-spark-1.2'];
  assert.deepEqual(values(offline), FIVE);
  assert.equal(offline.outputTokens, 131072);
  assert.equal(offline.inputCostPerM, 1.25);
  assert.equal(rows['muse-spark-1.2-contributor'].name, 'Muse Spark 1.2 (C)');

  // The send path reads the same rows.
  assert.deepEqual(values(provider.getCachedModelInfo('muse-spark-1.3-contributor')), SIX);
});

test('the discovered roster is persisted for the sync lookup, without seed values', async () => {
  await listed([
    { id: 'muse-spark-1.3', context_window: 500000 },
    { id: 'muse-spark-1.2', name: 'Spark Classic' },
  ]);
  const cached = Object.fromEntries(providerCachedModelsSync('muse-code-oauth').map((m) => [m.id, m]));
  assert.deepEqual(Object.keys(cached).sort(), ['muse-spark-1.2', 'muse-spark-1.3']);
  assert.equal(cached['muse-spark-1.2'].contextWindow, undefined, 'seed limits are not persisted');
  assert.equal(cached['muse-spark-1.2'].reasoningOptions, undefined);
  assert.equal(getModelMetadataSync('muse-spark-1.3', 'muse-code-oauth').contextWindow, 500000);
  assert.equal(getModelMetadataSync('muse-spark-1.2', 'muse-code-oauth').contextWindow, 1048576);
});

test('a catalog row declaring text-only, no reasoning, no tools is not re-enabled by seeds', async () => {
  const { provider, rows } = await listed([{ id: 'muse-spark-1.1' }]);
  for (const row of [rows['muse-spark-1.1'], provider.getCachedModelInfo('muse-spark-1.1')]) {
    assert.equal(row.supportsVision, false);
    assert.equal(row.supportsReasoning, false);
    assert.equal(row.supportsFunctionCalling, false);
    assert.deepEqual(row.reasoningOptions, []);
    assert.deepEqual(row.reasoningLevels, []);
    assert.equal(row.contextWindow, 400000);
    assert.equal(row.outputTokens, 131072, 'an absent limit is still seed-filled');
    assert.equal(row.inputCostPerM, 1.25, 'absent pricing is still seed-filled');
  }
});

test('a stale or other-credential discovery response is not published', async () => {
  const cachedIds = () => providerCachedModelsSync('muse-code-oauth').map((m) => m.id);
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  const pending = [];
  provider._ensureInner('k')._fetchModelItems = () => new Promise((resolve) => pending.push(resolve));
  const until = async (n) => {
    while (pending.length < n) await new Promise((r) => setImmediate(r));
  };

  // The older request answers last and must not overwrite the newer roster.
  const older = provider.listModels();
  await until(1);
  const newer = provider.listModels();
  await until(2);
  pending[1]([{ id: 'muse-spark-1.3' }]);
  await newer;
  pending[0]([{ id: 'muse-spark-1.2' }]);
  await older;
  assert.deepEqual(cachedIds(), ['muse-spark-1.3']);
  const liveIds = () => provider._ensureInner('k')._enrichedModels.map((m) => m.id);
  assert.deepEqual(liveIds(), ['muse-spark-1.3'], 'the live roster keeps the newer response');

  // The active key changed while the request was in flight.
  const switched = provider.listModels();
  await until(3);
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k2', accountId: 'u', email: '' });
  pending[2]([{ id: 'muse-spark-1.2' }]);
  await switched;
  assert.deepEqual(cachedIds(), ['muse-spark-1.3']);
});

test('a different discovered name is kept', async () => {
  const { rows } = await listed([{ id: 'muse-spark-1.3-contributor', name: 'Spark Contributor Edition' }]);
  assert.equal(rows['muse-spark-1.3-contributor'].name, 'Spark Contributor Edition');
});
