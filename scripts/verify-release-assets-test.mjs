import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PATCH_PLATFORMS,
  validatePatchManifest,
  validateRuntimeManifest,
  verifyAssetDownloads,
} from './verify-release-assets.mjs';

const VERSION = '1.2.3';
const bytes = Buffer.from('local release fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');

function patchFixture() {
  return {
    version: VERSION,
    _comment: 'test fixture',
    assets: Object.fromEntries(Object.entries(PATCH_PLATFORMS).map(([platform, filename]) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/patch-v${VERSION}/${filename}`,
        sha256,
      },
    ])),
  };
}

function runtimeFixture() {
  return {
    release_tag: 'runtime-v1.2.3',
    assets: Object.fromEntries(Object.keys(PATCH_PLATFORMS).map((platform) => [
      platform,
      { url: `https://fixtures.invalid/${platform}`, sha256, size: bytes.length },
    ])),
  };
}

test('accepts strict local patch and runtime manifest fixtures', () => {
  assert.equal(validatePatchManifest(patchFixture(), `[package]\nversion = "${VERSION}"\n`).version, VERSION);
  assert.equal(validateRuntimeManifest(runtimeFixture()).release_tag, 'runtime-v1.2.3');
});

test('rejects stale Cargo version, partial schema, and wrong patch tag URL', () => {
  assert.throws(
    () => validatePatchManifest(patchFixture(), '[package]\nversion = "1.2.2"\n'),
    /does not match manifest version/,
  );

  const partial = patchFixture();
  delete partial.assets['linux-arm64'];
  assert.throws(
    () => validatePatchManifest(partial, `[package]\nversion = "${VERSION}"\n`),
    /keys must be exactly/,
  );

  const wrongTag = patchFixture();
  wrongTag.assets['linux-x64'].url = wrongTag.assets['linux-x64'].url.replace('patch-v1.2.3', 'patch-v1.2.2');
  assert.throws(
    () => validatePatchManifest(wrongTag, `[package]\nversion = "${VERSION}"\n`),
    /patch-v1\.2\.3/,
  );

  const extraPatch = patchFixture();
  extraPatch.assets['freebsd-x64'] = extraPatch.assets['linux-x64'];
  assert.throws(
    () => validatePatchManifest(extraPatch, `[package]\nversion = "${VERSION}"\n`),
    /keys must be exactly/,
  );

  const extraRuntime = runtimeFixture();
  extraRuntime.assets['freebsd-x64'] = extraRuntime.assets['linux-x64'];
  assert.throws(() => validateRuntimeManifest(extraRuntime), /keys must be exactly/);
});

test('downloads local fixture responses, retries, and checks sha256 without network', async () => {
  let calls = 0;
  await verifyAssetDownloads(
    { fixture: { url: 'https://fixtures.invalid/asset', sha256, size: bytes.length } },
    {
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('fixture transient failure');
        return new Response(bytes);
      },
      retryDelay: async () => {},
    },
  );
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256: '0'.repeat(64) } },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response(bytes);
        },
        retryDelay: async () => {},
      },
    ),
    /verification failed after 3 attempts: sha256 mismatch/,
  );
  assert.equal(calls, 3);
});

test('cancels an undeclared-size patch stream immediately at the absolute ceiling', async () => {
  let chunksProduced = 0;
  let cancellations = 0;
  let aborts = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(Buffer.from('abc'));
      },
      cancel() {
        cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );

  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256 } },
      {
        attempts: 1,
        maxAssetBytes: 5,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener('abort', () => { aborts += 1; });
          return { ok: true, status: 200, body: stream };
        },
      },
    ),
    /byte ceiling exceeded \(5 bytes\)/,
  );
  assert.equal(chunksProduced, 2);
  assert.equal(cancellations, 1);
  assert.equal(aborts, 1);
});

test('cancels immediately when a stream exceeds its declared size below the absolute ceiling', async () => {
  let chunksProduced = 0;
  let cancellations = 0;
  let aborts = 0;
  const stream = new ReadableStream(
    {
      pull(controller) {
        chunksProduced += 1;
        controller.enqueue(Buffer.from('abc'));
      },
      cancel() {
        cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );

  await assert.rejects(
    verifyAssetDownloads(
      { fixture: { url: 'https://fixtures.invalid/asset', sha256, size: 5 } },
      {
        attempts: 1,
        maxAssetBytes: 10,
        fetchImpl: async (_url, { signal }) => {
          signal.addEventListener('abort', () => { aborts += 1; });
          return { ok: true, status: 200, body: stream };
        },
      },
    ),
    /byte ceiling exceeded \(5 bytes\)/,
  );
  assert.equal(chunksProduced, 2);
  assert.equal(cancellations, 1);
  assert.equal(aborts, 1);
});

test('release workflow runs the blocker before install and npm publish', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const blocker = workflow.indexOf('node scripts/verify-release-assets.mjs');
  const installStep = workflow.indexOf('- name: Install');
  const npmCi = workflow.indexOf('run: npm ci');
  const publish = workflow.indexOf('npm publish --provenance --access public');
  assert.ok(blocker >= 0, 'release workflow must invoke the release asset blocker');
  assert.ok(installStep > blocker, 'release asset blocker must run before the Install step');
  assert.ok(npmCi > blocker, 'release asset blocker must run before npm ci');
  assert.ok(publish > blocker, 'release asset blocker must run before npm publish');
});
