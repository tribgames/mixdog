import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LOCAL_PROVIDER_MANIFEST,
  localProviderCatalogStatus,
} from './catalog.mjs';
import { downloadVerifiedLocalAsset } from './asset-installer.mjs';
import { resolveSessionContextMeta } from '../agent/orchestrator/session/manager/context-meta.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('Local Provider manifest pins complete HTTPS assets with matching aggregate sizes', () => {
  const platform = LOCAL_PROVIDER_MANIFEST.runtime.platforms['win32-x64-nvidia'];
  assert.equal(
    platform.downloadBytes,
    platform.assets.reduce((total, asset) => total + asset.size, 0),
  );
  for (const asset of [...platform.assets, ...LOCAL_PROVIDER_MANIFEST.models]) {
    assert.equal(new URL(asset.url).protocol, 'https:');
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  }
});

test('catalog exposes the compatible RTX recommendation before anything is installed', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-local-provider-catalog-'));
  try {
    const status = localProviderCatalogStatus({
      dataDir,
      platform: 'win32',
      arch: 'x64',
      hardware: {
        platform: 'win32',
        arch: 'x64',
        supported: true,
        gpu: {
          vendor: 'NVIDIA',
          name: 'NVIDIA GeForce RTX 3090',
          memoryBytes: 24 * 1024 ** 3,
        },
      },
    });
    assert.equal(status.available, true);
    assert.equal(status.runtime.installed, false);
    assert.equal(status.recommendation?.id, 'qwen3.8-27b-q4-k-m');
    assert.equal(status.recommendation?.recommended, true);
    assert.equal(status.recommendation?.compatible, true);
    assert.equal(status.recommendation?.installed, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('catalog does not recommend or install-enable a model that exceeds available VRAM', () => {
  const status = localProviderCatalogStatus({
    platform: 'win32',
    arch: 'x64',
    hardware: {
      platform: 'win32',
      arch: 'x64',
      supported: true,
      gpu: {
        vendor: 'NVIDIA',
        name: 'NVIDIA GeForce RTX 3070',
        memoryBytes: 8 * 1024 ** 3,
      },
    },
  });
  assert.equal(status.available, false);
  assert.equal(status.recommendation, null);
  assert.equal(status.models[0].recommended, false);
  assert.equal(status.models[0].compatible, false);
});

test('verified downloads resume partial files and publish only after SHA-256 succeeds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-local-provider-download-'));
  const destination = join(root, 'asset.bin');
  const payload = Buffer.from('verified local provider asset');
  const prefix = payload.subarray(0, 9);
  const seenRanges = [];
  const progress = [];
  writeFileSync(`${destination}.part`, prefix);
  try {
    await downloadVerifiedLocalAsset({
      name: 'asset.bin',
      url: 'https://assets.example/asset.bin',
      size: payload.length,
      sha256: sha256(payload),
    }, destination, {
      onProgress: (value) => progress.push(value),
      fetchFn: async (_url, options) => {
        seenRanges.push(options.headers.Range);
        return new Response(payload.subarray(prefix.length), { status: 206 });
      },
    });
    assert.deepEqual(seenRanges, [`bytes=${prefix.length}-`]);
    assert.deepEqual(readFileSync(destination), payload);
    assert.equal(progress.at(-2).stage, 'verifying');
    assert.equal(progress.at(-1).stage, 'complete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verified downloads reject a digest mismatch without publishing the destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-local-provider-digest-'));
  const destination = join(root, 'asset.bin');
  const payload = Buffer.from('tampered');
  try {
    await assert.rejects(
      downloadVerifiedLocalAsset({
        name: 'asset.bin',
        url: 'https://assets.example/asset.bin',
        size: payload.length,
        sha256: '0'.repeat(64),
      }, destination, {
        fetchFn: async () => new Response(payload, { status: 200 }),
      }),
      /SHA-256 mismatch/,
    );
    assert.throws(() => readFileSync(destination));
    assert.throws(() => readFileSync(`${destination}.part`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('allocated runtime capacity bounds both the picker and restored oversized context selections', () => {
  const status = localProviderCatalogStatus({
    dataDir: join(tmpdir(), 'mixdog-local-context-uninstalled'),
    hardware: { gpu: { vendor: 'NVIDIA', memoryBytes: 24 * 1024 ** 3 } },
  });
  const model = status.models[0];
  assert.equal(model.maxContextWindow, model.contextWindow);
  assert.equal(model.runtimeContextWindow, model.contextWindow);
  const provider = { name: 'mixdog-local', getCachedModelInfo: () => model };
  const restored = resolveSessionContextMeta(provider, model.id, { selectedContextWindow: 262144 });
  assert.equal(restored.contextWindow, model.contextWindow);
  const smaller = resolveSessionContextMeta(provider, model.id, { selectedContextWindow: 8192 });
  assert.equal(smaller.contextWindow, 8192);
});

test('a partial download is allowed when only the remaining bytes fit on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-local-resume-space-'));
  const destination = join(root, 'asset.bin');
  const payload = Buffer.from('a model which is mostly downloaded');
  const prefix = payload.subarray(0, 25);
  writeFileSync(`${destination}.part`, prefix);
  try {
    await downloadVerifiedLocalAsset({
      name: 'asset.bin', url: 'https://assets.example/model',
      size: payload.length, sha256: sha256(payload),
    }, destination, {
      checkDiskSpace: (_path, bytes) => {
        if (bytes > payload.length - prefix.length) throw new Error('not enough free disk space');
      },
      fetchFn: async () => new Response(payload.subarray(prefix.length), { status: 206 }),
    });
    // Once verified, no new disk allocation or network request is necessary.
    await downloadVerifiedLocalAsset({
      name: 'asset.bin', url: 'https://assets.example/model',
      size: payload.length, sha256: sha256(payload),
    }, destination, {
      checkDiskSpace: () => assert.fail('an installed asset needs no download space'),
      fetchFn: () => assert.fail('an installed asset needs no download'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a server declining Range cannot bypass the full-download disk check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-local-range-space-'));
  const destination = join(root, 'asset.bin');
  const payload = Buffer.from('model payload');
  writeFileSync(`${destination}.part`, payload.subarray(0, 5));
  let cancelled = false;
  try {
    await assert.rejects(downloadVerifiedLocalAsset({
      name: 'asset.bin', url: 'https://assets.example/model',
      size: payload.length, sha256: sha256(payload),
    }, destination, {
      checkDiskSpace: (_path, bytes) => {
        if (bytes === payload.length) throw new Error('disk space changed');
      },
      fetchFn: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; },
      }), { status: 200 }),
    }), /disk space changed/);
    assert.equal(cancelled, true);
    assert.throws(() => readFileSync(destination));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('download cancellation closes the stream and preserves partial bytes for a verified resume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-local-cancel-'));
  const destination = join(root, 'asset.bin');
  const payload = Buffer.from('cancel and resume this model');
  const controller = new AbortController();
  let cancelled = false;
  try {
    const asset = { name: 'asset.bin', url: 'https://assets.example/model', size: payload.length, sha256: sha256(payload) };
    writeFileSync(`${destination}.part`, payload.subarray(0, 8));
    await assert.rejects(downloadVerifiedLocalAsset(asset, destination, {
      signal: controller.signal,
      fetchFn: async () => new Response(new ReadableStream({
        start(stream) { stream.enqueue(payload.subarray(8, 12)); },
        cancel() { cancelled = true; },
      }), { status: 206 }),
      onProgress: () => setImmediate(() => controller.abort(new Error('user cancelled download'))),
    }), /abort|cancel/i);
    assert.equal(cancelled, true);
    assert.throws(() => readFileSync(destination));
    const partial = readFileSync(`${destination}.part`);
    assert.ok(partial.length >= 8);
    assert.ok(partial.length < payload.length);
    await downloadVerifiedLocalAsset(asset, destination, {
      fetchFn: async (_url, { headers }) => {
        const start = Number(String(headers.Range || '').match(/bytes=(\d+)-/)?.[1] || 0);
        return new Response(payload.subarray(start), { status: start ? 206 : 200 });
      },
    });
    assert.deepEqual(readFileSync(destination), payload);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
