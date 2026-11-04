// The overlay warm and the first hot-path metadata read must not parse the
// multi-MB catalogs on the daemon's main thread, nor touch disk synchronously.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { makeTempDirSync } from '../../../../scripts/lib/scoped-temp.mjs';
import { syncFsCalls } from '../sync-fs-calls.fixture.mjs';

const directory = makeTempDirSync('model-catalog-warm-main');
process.env.MIXDOG_DATA_DIR = directory;

const padding = Object.fromEntries(
  Array.from({ length: 4000 }, (_, i) => [`pad-model-${i}`, { litellm_provider: 'pad', note: 'x'.repeat(100) }])
);
const litellm = {
  ...padding,
  'gemini/gemini-warm-test': { litellm_provider: 'gemini', input_cost_per_token: 1e-6, output_cost_per_token: 4e-6 },
};
writeFileSync(join(directory, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: 1, data: litellm }));

test('warming the catalog from disk and reading metadata parse nothing large on the main thread', async (t) => {
  const mainParses = [];
  const realParse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, ...rest) => {
    if (typeof text === 'string' && text.length > 100_000) mainParses.push(text.length);
    return realParse(text, ...rest);
  });
  let catalog;
  const syncCalls = await syncFsCalls(async () => {
    catalog = await import('./model-catalog.mjs');
    const keepAlive = setInterval(() => {}, 1000);
    await catalog.warmCatalogFromDisk();
    clearInterval(keepAlive);
  });
  const metadata = catalog.getModelMetadataSync('gemini-warm-test', 'gemini');
  assert.equal(metadata?.inputCostPerM, 1, 'the warm filled the table before the first read');
  assert.deepEqual(mainParses, []);
  assert.deepEqual(
    syncCalls.filter((call) => /litellm-catalog|modelsdev-catalog/.test(call)),
    []
  );
});
