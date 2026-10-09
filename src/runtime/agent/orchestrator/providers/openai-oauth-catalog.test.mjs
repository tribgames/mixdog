import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const previousLiveVersions = process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS;
process.env.MIXDOG_DATA_DIR = dataDir;
// The reported Codex version stays at the shipped floor: no registry lookup.
process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';

const [
  { CODEX_CLIENT_VERSION_FLOOR },
  { makeModelCache },
  { _normalizeCodexModel },
  {
    codexModelSupportsEffortUpdates,
    codexModelSupportsServiceTier,
    ensureLatestCodexModel,
    findCachedCodexModel,
    listCodexModels,
    resolveLatestCodexModel,
  },
  { effortConfigurationMode },
] = await Promise.all([
  import('./codex-client-meta.mjs'),
  import('./model-cache.mjs'),
  import('./openai-codex-model.mjs'),
  import('./openai-oauth-catalog.mjs'),
  import('./effort-configuration.mjs'),
]);

test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  if (previousLiveVersions === undefined) delete process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS;
  else process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = previousLiveVersions;
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

test('a catalog past its TTL still answers capability lookups but not freshness checks', () => {
  const cache = makeModelCache({ fileName: 'openai-oauth-models.json', ttlMs: 60_000, version: 6 });
  assert.ok(resolve(cache.path()).startsWith(dataDir + sep));
  const models = [
    { slug: 'gpt-6-astra', priority: 3, visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast' }] },
  ].map(_normalizeCodexModel);
  writeFileSync(
    cache.path(),
    JSON.stringify({ version: 6, fetchedAt: Date.now() - 2 * 24 * 60 * 60_000, models })
  );

  assert.equal(cache.loadSync(), null, 'the TTL still marks the cache as due for refetch');
  assert.equal(codexModelSupportsServiceTier('gpt-6-astra', 'priority'), true);
  assert.equal(findCachedCodexModel('gpt-6-astra').id, 'gpt-6-astra');
  // Stale data never stands in for a fresh catalog: default-model resolution
  // still sees none and refreshes.
  assert.equal(resolveLatestCodexModel(), null);
});

test('a fresh cache serves the picker, the lookups and the default model without auth', async () => {
  const cached = [
    { slug: 'gpt-5.5', priority: 12, visibility: 'list', service_tiers: [{ id: 'priority', name: 'Fast' }] },
    { slug: 'gpt-5.6-terra', priority: 7, visibility: 'list', supports_reasoning_effort_updates: true },
    { slug: 'gpt-reserve', priority: 1, visibility: 'hide', supports_reasoning_effort_updates: false },
    { slug: 'gpt-5.6-mini', priority: 9, visibility: 'list', additional_speed_tiers: ['priority'] },
  ].map(_normalizeCodexModel);
  const cache = makeModelCache({ fileName: 'openai-oauth-models.json', ttlMs: 60_000, version: 6 });
  assert.ok(
    resolve(cache.path()).startsWith(dataDir + sep),
    'the catalog cache must resolve inside the test sandbox before it is written'
  );
  cache.save(cached, { clientVersion: CODEX_CLIENT_VERSION_FLOOR });

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

  // Effort updates follow the catalog flag on the OAuth route; a model the
  // catalog does not describe, and the public API route, use the built-in list.
  assert.equal(codexModelSupportsEffortUpdates('gpt-5.6-terra'), true);
  assert.equal(codexModelSupportsEffortUpdates('gpt-reserve'), false);
  assert.equal(codexModelSupportsEffortUpdates('gpt-5.5'), null);
  assert.equal(effortConfigurationMode('openai-oauth', 'gpt-5.6-terra'), 'responses');
  assert.equal(effortConfigurationMode('openai-oauth', 'gpt-reserve'), null);
  assert.equal(effortConfigurationMode('openai-oauth', 'gpt-5.5'), null);
  assert.equal(effortConfigurationMode('openai-oauth', 'gpt-6.1-sol'), 'responses');
  assert.equal(effortConfigurationMode('openai', 'gpt-5.6-terra'), null);

  // The lowest-priority picker-visible entry wins; hidden entries never do.
  assert.equal(resolveLatestCodexModel(), 'gpt-5.6-terra');
  assert.equal(await ensureLatestCodexModel(rejectAuth), 'gpt-5.6-terra');
});

test('a catalog fetched for an older client version is refetched, and kept if that fails', async () => {
  const cache = makeModelCache({ fileName: 'openai-oauth-models.json', ttlMs: 60_000, version: 6 });
  assert.ok(resolve(cache.path()).startsWith(dataDir + sep));
  const models = [{ slug: 'gpt-6-astra', priority: 2, visibility: 'list' }].map(_normalizeCodexModel);

  for (const recorded of [{ clientVersion: '0.144.1' }, {}]) {
    cache.save(models, recorded);
    let refetches = 0;
    const listed = await listCodexModels(() => {
      refetches += 1;
      throw new Error('offline');
    });
    assert.equal(refetches, 1, `refetched for ${JSON.stringify(recorded)}`);
    assert.deepEqual(
      listed.map((model) => model.id),
      ['gpt-6-astra']
    );
  }

  cache.save(models, { clientVersion: CODEX_CLIENT_VERSION_FLOOR });
  assert.deepEqual(
    (await listCodexModels(rejectAuth)).map((model) => model.id),
    ['gpt-6-astra']
  );
});
