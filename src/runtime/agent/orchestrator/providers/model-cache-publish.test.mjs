import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('a NUL-filled roster cache is a miss, is refetched silently, and never stops a save', () => {
  for (const [name, publishWith] of [
    ['save', (cache) => cache.save([{ id: 'saved' }])],
    ['beginSave', (cache) => cache.beginSave(() => true)([{ id: 'saved' }])],
  ]) {
    const cache = makeModelCache({ fileName: `nul-${name}-oauth-models.json`, ttlMs: 60_000, version: 1 });
    writeFileSync(cache.path(), Buffer.alloc(4583));
    assert.equal(cache.loadSync(), null);
    assert.equal(cache.loadEntrySync({ allowStale: true }), null);
    publishWith(cache);
    assert.deepEqual(cache.loadSync(), [{ id: 'saved' }]);
    assert.equal(existsSync(`${cache.path()}.bak`), false, 'a cache keeps no backup of NUL bytes');
  }
  assert.ok(readdirSync(dir).some((entry) => entry.startsWith('nul-beginSave-oauth-models.json.corrupt-')));
});

test('an effort entry without values declares no ladder', () => {
  assert.deepEqual(rosterReasoningOptions({ reasoningOptions: [{ type: 'effort', values: [] }] }), []);
  assert.deepEqual(
    rosterReasoningOptions({ reasoningOptions: [{ type: 'effort', values: [] }], reasoningLevels: ['low', 'high'] }),
    [{ type: 'effort', values: ['low', 'high'] }]
  );
});
