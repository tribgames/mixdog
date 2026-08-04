import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  GRAPH_PLATFORMS,
  PATCH_PLATFORMS,
  validateGraphManifest,
  validatePatchManifest,
  validateRuntimeManifest,
  verifyAssetDownloads,
  verifyReleaseAssets,
} from './verify-release-assets.mjs';

const VERSION = '1.2.3';
const APP_VERSION = '0.9.49';
const GRAPH_VERSION = '0.1.0';
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

function graphFixture() {
  return {
    version: GRAPH_VERSION,
    _comment: 'test fixture',
    assets: Object.fromEntries(Object.entries(GRAPH_PLATFORMS).map(([platform, filename]) => [
      platform,
      {
        url: `https://github.com/tribgames/mixdog/releases/download/graph-v${GRAPH_VERSION}/${filename}`,
        sha256,
      },
    ])),
  };
}

test('accepts independent strict patch, runtime, app, and graph versions', () => {
  assert.equal(validatePatchManifest(patchFixture(), `[package]\nversion = "${VERSION}"\n`).version, VERSION);
  assert.equal(validateRuntimeManifest(runtimeFixture()).release_tag, 'runtime-v1.2.3');
  assert.equal(validateGraphManifest(graphFixture(), { version: APP_VERSION }).version, GRAPH_VERSION);
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

test('rejects stale, noncanonical, partial, and malformed graph manifests', () => {
  const partial = graphFixture();
  delete partial.assets['darwin-arm64'];
  assert.throws(() => validateGraphManifest(partial, { version: APP_VERSION }), /keys must be exactly/);

  for (const replacement of [
    'https://github.com/tribgames/mixdog/releases/download/v0.7.18/mixdog-graph-linux-x64',
    'https://github.com/tribgames/mixdog/releases/download/graph-v0.1.1/mixdog-graph-linux-x64',
    'https://example.com/tribgames/mixdog/releases/download/graph-v0.1.0/mixdog-graph-linux-x64',
    'https://github.com/tribgames/mixdog/releases/download/graph-v0.1.0/mixdog-graph-wrong',
  ]) {
    const noncanonical = graphFixture();
    noncanonical.assets['linux-x64'].url = replacement;
    assert.throws(
      () => validateGraphManifest(noncanonical, { version: APP_VERSION }),
      /graph asset URL must be/,
    );
  }

  const malformedDigest = graphFixture();
  malformedDigest.assets['win32-x64'].sha256 = 'not-a-digest';
  assert.throws(
    () => validateGraphManifest(malformedDigest, { version: APP_VERSION }),
    /invalid graph asset sha256/,
  );

  const malformedVersion = graphFixture();
  malformedVersion.version = '0.1';
  assert.throws(
    () => validateGraphManifest(malformedVersion, { version: APP_VERSION }),
    /not strict MAJOR\.MINOR\.PATCH/,
  );
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

test('full guard reads deterministic fixtures and downloads every declared asset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-release-assets-'));
  const patch = patchFixture();
  const runtime = runtimeFixture();
  const graph = graphFixture();
  const expectedUrls = new Set(
    [...Object.values(patch.assets), ...Object.values(runtime.assets), ...Object.values(graph.assets)]
      .map(({ url }) => url),
  );
  const paths = {
    patchManifestPath: join(dir, 'patch.json'),
    cargoPath: join(dir, 'Cargo.toml'),
    runtimeManifestPath: join(dir, 'runtime.json'),
    graphManifestPath: join(dir, 'graph.json'),
    packagePath: join(dir, 'package.json'),
  };
  await Promise.all([
    writeFile(paths.patchManifestPath, JSON.stringify(patch)),
    writeFile(paths.cargoPath, `[package]\nversion = "${VERSION}"\n`),
    writeFile(paths.runtimeManifestPath, JSON.stringify(runtime)),
    writeFile(paths.graphManifestPath, JSON.stringify(graph)),
    writeFile(paths.packagePath, JSON.stringify({ version: APP_VERSION })),
  ]);
  let downloads = 0;
  const requestedUrls = [];
  try {
    await verifyReleaseAssets({
      ...paths,
      downloadOptions: {
        attempts: 1,
        timeoutMs: 1000,
        fetchImpl: async (url) => {
          downloads += 1;
          requestedUrls.push(url);
          return new Response(bytes);
        },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(downloads, 15);
  assert.deepEqual(new Set(requestedUrls), expectedUrls);
});
