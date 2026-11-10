import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRemoteVersion, parseNpmLatest } from './npm-cli-version.mjs';

const registryUrl = 'https://registry.example.invalid/pkg/latest';

test('a lookup resolves the published version', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ version: '2.3.4' }));
  assert.equal(await fetchRemoteVersion(registryUrl, parseNpmLatest, 1_000), '2.3.4');
});

test('a lookup whose body read misses the abort still resolves null at its deadline', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ version: '2.3.4' }));
  // The deadline timer is unref'd; this handle keeps the loop running the way
  // a live process does, so only the lookup itself can leave the await pending.
  const alive = setInterval(() => {}, 1_000);
  try {
    assert.equal(await fetchRemoteVersion(registryUrl, () => new Promise(() => {}), 20), null);
  } finally {
    clearInterval(alive);
  }
});
