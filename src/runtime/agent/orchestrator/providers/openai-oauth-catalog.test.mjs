import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';

// The catalog cache is a real file under the data dir, so the data dir is
// moved into a unique temp directory before any import and the resolved cache
// path is asserted to live there before the suite writes it. No operator
// catalog cache or credential file is touched: the suite never authenticates
// (a cache hit must not reach ensureAuth, which is what `rejectAuth` proves).
// The catalog module also keeps a process-wide mirror of that cache, so the
// empty-catalog case has to run before anything populates it.
const dataDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mixdog-openai-catalog-')));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;

const [
  { makeModelCache },
  { _normalizeCodexModel },
  {
    codexModelSupportsServiceTier,
    ensureLatestCodexModel,
    findCachedCodexModel,
    listCodexModels,
    resolveLatestCodexModel,
  },
] = await Promise.all([
  import('./model-cache.mjs'),
  import('./openai-codex-model.mjs'),
  import('./openai-oauth-catalog.mjs'),
]);

test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const rejectAuth = () => {
  throw new Error('catalog must not authenticate on a cache hit');
};

test('an empty catalog refreshes once and then fails loudly instead of guessing a model', async () => {
  let refreshes = 0;
  await assert.rejects(
    () =>
      ensureLatestCodexModel(async () => {
        refreshes += 1;
      }),
    /model catalog unavailable after warmup/
  );
  assert.equal(refreshes, 1, 'the default model resolves through exactly one catalog warmup');
});

test('a fresh cache serves the picker, the lookups and the default model without auth', async () => {
  const cached = [
    { slug: 'gpt-5.5', priority: 12, visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast' }] },
    { slug: 'gpt-5.6-terra', priority: 7, visibility: 'list' },
    { slug: 'gpt-reserve', priority: 1, visibility: 'hide' },
    { slug: 'gpt-5.6-mini', priority: 9, visibility: 'list', additional_speed_tiers: ['priority'] },
  ].map(_normalizeCodexModel);
  const cache = makeModelCache({ fileName: 'openai-oauth-models.json', ttlMs: 60_000, version: 5 });
  assert.ok(
    resolve(cache.path()).startsWith(dataDir + sep),
    'the catalog cache must resolve inside the test sandbox before it is written'
  );
  cache.save(cached);

  const models = await listCodexModels(rejectAuth);
  assert.deepEqual(
    models.map((model) => model.id),
    ['gpt-5.5', 'gpt-5.6-terra', 'gpt-reserve', 'gpt-5.6-mini']
  );

  assert.equal(findCachedCodexModel('gpt-5.6-terra').family, 'gpt-5');
  assert.equal(findCachedCodexModel('gpt-5.6-sol'), null);
  assert.equal(findCachedCodexModel(''), null);

  // Tier capability is catalog-driven: advertised tiers and speed tiers count,
  // a model id never does.
  assert.equal(codexModelSupportsServiceTier('gpt-5.5', 'priority'), true);
  assert.equal(codexModelSupportsServiceTier('gpt-5.6-mini', 'priority'), true);
  assert.equal(codexModelSupportsServiceTier('gpt-5.6-terra', 'priority'), false);
  assert.equal(codexModelSupportsServiceTier('gpt-5.5', 'fast'), false);

  // The lowest-priority picker-visible entry wins; hidden entries never do.
  assert.equal(resolveLatestCodexModel(), 'gpt-5.6-terra');
  assert.equal(await ensureLatestCodexModel(rejectAuth), 'gpt-5.6-terra');
});
