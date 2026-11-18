import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { assetFor, platformKey, verifySha256 } from './provision-pg-runtime.mjs';

const manifest = JSON.parse(readFileSync(new URL('../../src/runtime/memory/data/runtime-manifest.json', import.meta.url), 'utf8'));

test('the hosted runners of the gate each have an asset in the shipped manifest', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']]) {
    const asset = assetFor(manifest, platformKey(platform, arch));
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    assert.match(asset.url, /^https:\/\//);
  }
});

test('a platform the manifest does not list fails and names what it lists', () => {
  assert.throws(() => assetFor(manifest, platformKey('freebsd', 'x64')), /no asset .* for freebsd-x64; it has .*linux-x64/);
  assert.throws(() => assetFor({ assets: { 'linux-x64': { url: 'https://x' } } }, 'linux-x64'), /no asset/);
});

test('a download that is not the manifest hash is refused, whatever the case of the hash', () => {
  const bytes = Buffer.from('runtime');
  const hash = createHash('sha256').update(bytes).digest('hex');
  verifySha256(bytes, hash);
  verifySha256(bytes, hash.toUpperCase());
  assert.throws(() => verifySha256(Buffer.from('other'), hash), /the manifest says/);
});
