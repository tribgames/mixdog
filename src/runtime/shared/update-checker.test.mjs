import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('update checks publish one parseable atomic cache file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-update-cache-'));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ version: '999.0.0' }),
  });
  try {
    const checker = await import(`./update-checker.mjs?test=${Date.now()}`);
    const result = await checker.checkLatestVersion({ force: true, dataDir: root });
    assert.equal(result.latestVersion, '999.0.0');
    const names = readdirSync(root);
    assert.deepEqual(names, ['update-check-cache.json']);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'update-check-cache.json'), 'utf8')),
      { latestVersion: '999.0.0', lastCheckedAt: result.lastCheckedAt },
    );
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
