import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'model-cache-publish-'));
process.env.MIXDOG_DATA_DIR = dir;
after(() => rmSync(dir, { recursive: true, force: true }));

const { makeModelCache } = await import('./model-cache.mjs');
const { rosterReasoningOptions } = await import('../../../shared/llm/provider-catalog-cache.mjs');

test('a roster from a request another process started later is never overwritten', () => {
  const cache = makeModelCache({ fileName: 'publish-test-models.json', ttlMs: 60_000 });
  const publish = cache.beginSave(() => true);
  // Another process started its request after ours and already published.
  writeFileSync(
    cache.path(),
    JSON.stringify({ fetchedAt: Date.now(), requestedAt: Date.now() + 60_000, models: [{ id: 'newer' }] })
  );
  assert.equal(publish([{ id: 'older' }]), false);
  assert.deepEqual(JSON.parse(readFileSync(cache.path(), 'utf8')).models, [{ id: 'newer' }]);

  const fresh = cache.beginSave(() => true);
  rmSync(cache.path());
  assert.equal(fresh([{ id: 'latest' }]), true);
  assert.deepEqual(cache.loadSync(), [{ id: 'latest' }]);
});

test('an effort entry without values declares no ladder', () => {
  assert.deepEqual(rosterReasoningOptions({ reasoningOptions: [{ type: 'effort', values: [] }] }), []);
  assert.deepEqual(
    rosterReasoningOptions({ reasoningOptions: [{ type: 'effort', values: [] }], reasoningLevels: ['low', 'high'] }),
    [{ type: 'effort', values: ['low', 'high'] }]
  );
});
