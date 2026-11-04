// The periodic overlay refresh runs on the daemon's event loop: when it fires
// it must make no synchronous fs call, on success (cache write, pricing audit
// over the live rosters) or on failure (stale-ok disk copy).
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';
import { syncFsCalls } from '../sync-fs-calls.fixture.mjs';

const directory = makeTempDirSync('model-catalog-refresh-async');
process.env.MIXDOG_DATA_DIR = directory;

const litellm = {
  'gemini/gemini-refresh-test': {
    litellm_provider: 'gemini',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 4e-6,
  },
};
const modelsdev = { openai: { models: { 'gpt-refresh-test': { cost: { input: 2, output: 8 } } } } };
writeFileSync(
  join(directory, 'gemini-models.json'),
  JSON.stringify({ models: [{ id: 'gemini-refresh-test' }, { id: 'gemini-unpriced-test' }] })
);
writeFileSync(
  join(directory, 'openai-oauth-models.json'),
  JSON.stringify({ models: [{ id: 'gpt-refresh-test' }, { id: 'gpt-other-test' }, { id: 'gpt-third-test' }] })
);

const catalog = await import('./model-catalog.mjs');

test('a fired catalog refresh makes no synchronous fs call, fetched or failed', async (t) => {
  let clock = Date.now();
  let failing = false;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (failing) throw new Error('fixture network unavailable');
    const body = String(url).includes('models.dev') ? modelsdev : litellm;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  await catalog.refreshCatalog();
  const cacheFile = join(directory, 'litellm-catalog.json');
  assert.ok(existsSync(cacheFile));

  const reads = [];
  const realReadFile = fsp.readFile;
  t.mock.method(fsp, 'readFile', function countedReadFile(path, ...rest) {
    reads.push(String(path));
    return realReadFile.call(this, path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => {
    fsp.readFile = realReadFile;
    syncBuiltinESMExports();
  });

  clock += catalog.PRICING_CATALOG_REFRESH_MS + 1;
  const fetched = await syncFsCalls(() => catalog.warmCatalogsInBackground());
  assert.deepEqual(fetched, [], 'a fetched refresh writes its cache and audits without sync fs');
  assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).fetchedAt, clock, 'the disk cache was rewritten');
  const rosterReads = reads.filter((path) => path.endsWith('-models.json'));
  assert.deepEqual(
    rosterReads.map((path) => path.slice(directory.length + 1)).sort(),
    [...new Set(rosterReads.map((path) => path.slice(directory.length + 1)))].sort(),
    'each roster file is read once per refresh, not per model'
  );
  assert.ok(rosterReads.some((path) => path.endsWith('openai-oauth-models.json')));

  clock += catalog.PRICING_CATALOG_REFRESH_MS + 1;
  failing = true;
  const failed = await syncFsCalls(() => catalog.warmCatalogsInBackground());
  assert.deepEqual(failed, [], 'a failed refresh falls back to its disk copy without sync fs');
  assert.equal(catalog.getModelMetadataSync('gemini-refresh-test', 'gemini')?.inputCostPerM, 1);
  assert.ok(stderr.mock.calls.some((call) => /fetch failed/.test(String(call.arguments[0]))));
});
