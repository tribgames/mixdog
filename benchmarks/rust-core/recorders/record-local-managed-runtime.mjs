#!/usr/bin/env node
// managed-runtime.test.mjs (10 tests): the real local-provider catalog (manifest, hardware recommendation, platform runtime) and the real
// verified asset installer (`downloadVerifiedLocalAsset`: resume, digest check, disk-space check, Range refusal, cancellation) over scripted
// `fetchFn` / `checkDiskSpace` (the product's injection points: the network and the disk are the scripted external side). Files the installer
// leaves in the case directory are recorded (path relative to it, bytes as hex); progress events in order.
// Deviation from the test: the cancellation case aborts from inside the progress callback (the test defers it by one setImmediate).
//   node benchmarks/rust-core/recorders/record-local-managed-runtime.mjs --tree <exact export of b6f10295a>
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-local-managed-runtime',
  net: false,
  exclusions: ['catalog status disk.availableBytes: the host\'s real free disk space, written <host free disk bytes>'],
  entry: 'src/runtime/local-provider/catalog.mjs LOCAL_PROVIDER_MANIFEST / localProviderCatalogStatus({ dataDir, platform, arch, hardware }), asset-installer.mjs downloadVerifiedLocalAsset(asset, destination, { fetchFn, onProgress, checkDiskSpace, signal }), agent/orchestrator/session/manager/context-meta.mjs resolveSessionContextMeta. Not run: a real download.',
  compare: 'mixdog-services local_provider catalog.rs:290, hardware.rs, assets.rs:73-112,828,877: compare the manifest/status rows whole, and for each download row the requests (`ranges`), `progress` stages, the thrown error text and the files left (`files`).',
  replay: "Rust entry (pub, on o1): mixdog_services::local_provider local_context_settings (context.rs:48), save_local_context (context.rs:75), Catalog::status (catalog.rs:224), RequestQueue::run (request_queue.rs:124), download_verified_asset (assets.rs:324); the local provider adapter is mixdog_ai::providers::local::adapter() (local/mod.rs:109).",
});
const SRC = 'src/runtime/local-provider/managed-runtime.test.mjs';
const { LOCAL_PROVIDER_MANIFEST, localProviderCatalogStatus: realStatus } = await rec.P('local-provider/catalog.mjs');
// disk.availableBytes is the host's real free space (not part of the behaviour under test): written as a marker.
const localProviderCatalogStatus = (options) => {
  const status = realStatus(options);
  return status.disk && 'availableBytes' in status.disk ? { ...status, disk: { ...status.disk, availableBytes: '<host free disk bytes>' } } : status;
};
const { downloadVerifiedLocalAsset } = await rec.P('local-provider/asset-installer.mjs');
const { resolveSessionContextMeta } = await rec.P('agent/orchestrator/session/manager/context-meta.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const caseDir = (name) => {
  const dir = join(rec.dataDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const filesOf = (dir) => Object.fromEntries(readdirSync(dir).map((name) => [name, { $bytesHex: readFileSync(join(dir, name)).toString('hex') }]));
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};

await rec.run('manifest-pins-https-assets-matching-sizes', `${SRC}:16`, {}, () => {
  const platforms = Object.values(LOCAL_PROVIDER_MANIFEST.runtime.platforms);
  return {
    manifest: LOCAL_PROVIDER_MANIFEST,
    platformKeys: Object.keys(LOCAL_PROVIDER_MANIFEST.runtime.platforms),
    aggregates: platforms.map((p) => ({ downloadBytes: p.downloadBytes, sumOfAssets: p.assets.reduce((total, a) => total + a.size, 0) })),
    assetChecks: [...platforms.flatMap((p) => p.assets), ...LOCAL_PROVIDER_MANIFEST.models].map((a) => ({ url: a.url, protocol: new URL(a.url).protocol, shaOk: /^[a-f0-9]{64}$/.test(a.sha256), sizeOk: Number.isSafeInteger(a.size) && a.size > 0 })),
    modelRevisions: LOCAL_PROVIDER_MANIFEST.models.map((m) => ({ id: m.id, revisionOk: /^[a-f0-9]{40}$/.test(m.revision), urlPinsRevision: new URL(m.url).pathname.includes(`/resolve/${m.revision}/`) })),
  };
});
const rtx = { platform: 'win32', arch: 'x64', supported: true, gpu: { vendor: 'NVIDIA', name: 'NVIDIA GeForce RTX 3090', memoryBytes: 24 * 1024 ** 3 } };
await rec.run('rtx-recommendation-before-install', `${SRC}:36`, { hardware: rtx }, () => ({ status: localProviderCatalogStatus({ dataDir: caseDir('catalog-rtx'), platform: 'win32', arch: 'x64', hardware: rtx }) }));
const apple = { supported: true, gpu: { vendor: 'Apple', name: 'Apple M4', memoryBytes: 32 * 1024 ** 3 } };
const intel = { supported: false, gpu: null };
await rec.run('apple-silicon-metal-and-unsupported-hosts', `${SRC}:65`, { apple, intel }, () => ({
  metal: localProviderCatalogStatus({ platform: 'darwin', arch: 'arm64', hardware: apple }),
  intel: localProviderCatalogStatus({ platform: 'darwin', arch: 'x64', hardware: intel }),
}));
const rtx3070 = { platform: 'win32', arch: 'x64', supported: true, gpu: { vendor: 'NVIDIA', name: 'NVIDIA GeForce RTX 3070', memoryBytes: 8 * 1024 ** 3 } };
await rec.run('no-recommendation-beyond-vram', `${SRC}:87`, { hardware: rtx3070 }, () => ({ status: localProviderCatalogStatus({ platform: 'win32', arch: 'x64', hardware: rtx3070 }) }));

const asset = (payload, extra = {}) => ({ name: 'asset.bin', url: 'https://assets.example/asset.bin', size: payload.length, sha256: sha256(payload), ...extra });
await rec.run('resume-partial-publish-after-sha256', `${SRC}:106`, { payload: 'verified local provider asset', prefixBytes: 9 }, async () => {
  const dir = caseDir('dl-resume');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('verified local provider asset');
  const prefix = payload.subarray(0, 9);
  const ranges = [];
  const progress = [];
  writeFileSync(`${destination}.part`, prefix);
  const out = await attempt(downloadVerifiedLocalAsset(asset(payload), destination, { onProgress: (v) => progress.push(v), fetchFn: async (_url, options) => { ranges.push(options.headers.Range); return new Response(payload.subarray(prefix.length), { status: 206 }); } }));
  return { ...out, ranges, progress, files: filesOf(dir) };
});
await rec.run('digest-mismatch-not-published', `${SRC}:140`, { payload: 'tampered' }, async () => {
  const dir = caseDir('dl-digest');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('tampered');
  const out = await attempt(downloadVerifiedLocalAsset({ ...asset(payload), sha256: '0'.repeat(64) }, destination, { fetchFn: async () => new Response(payload, { status: 200 }) }));
  return { ...out, destinationExists: existsSync(destination), partExists: existsSync(`${destination}.part`), files: filesOf(dir) };
});
await rec.run('runtime-capacity-bounds-picker-and-restored-selection', `${SRC}:171`, { selectedContextWindows: [262144, 8192], hardware: { gpu: { vendor: 'NVIDIA', memoryBytes: 24 * 1024 ** 3 } } }, () => {
  const status = localProviderCatalogStatus({ dataDir: caseDir('catalog-capacity'), hardware: { gpu: { vendor: 'NVIDIA', memoryBytes: 24 * 1024 ** 3 } } });
  const model = status.models[0];
  const provider = { name: 'mixdog-local', getCachedModelInfo: () => model };
  return { model, manifestMax: LOCAL_PROVIDER_MANIFEST.models[0].maxContextWindow, restored: resolveSessionContextMeta(provider, model.id, { selectedContextWindow: 262144 }), smaller: resolveSessionContextMeta(provider, model.id, { selectedContextWindow: 8192 }) };
});
await rec.run('partial-download-allowed-when-remaining-bytes-fit', `${SRC}:188`, { payload: 'a model which is mostly downloaded', prefixBytes: 25 }, async () => {
  const dir = caseDir('dl-space');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('a model which is mostly downloaded');
  const prefix = payload.subarray(0, 25);
  writeFileSync(`${destination}.part`, prefix);
  const spaceChecks = [];
  const first = await attempt(downloadVerifiedLocalAsset(asset(payload, { url: 'https://assets.example/model' }), destination, {
    checkDiskSpace: (_path, bytes) => { spaceChecks.push(bytes); if (bytes > payload.length - prefix.length) throw new Error('not enough free disk space'); },
    fetchFn: async () => new Response(payload.subarray(prefix.length), { status: 206 }),
  }));
  let secondFetches = 0;
  let secondSpaceChecks = 0;
  const second = await attempt(downloadVerifiedLocalAsset(asset(payload, { url: 'https://assets.example/model' }), destination, { checkDiskSpace: () => { secondSpaceChecks += 1; }, fetchFn: async () => { secondFetches += 1; return new Response(''); } }));
  return { first, spaceChecks, second, secondFetches, secondSpaceChecks, files: filesOf(dir) };
});
await rec.run('server-declining-range-cannot-bypass-disk-check', `${SRC}:226`, { payload: 'model payload', prefixBytes: 5 }, async () => {
  const dir = caseDir('dl-range');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('model payload');
  writeFileSync(`${destination}.part`, payload.subarray(0, 5));
  let cancelled = false;
  const spaceChecks = [];
  const out = await attempt(downloadVerifiedLocalAsset(asset(payload, { url: 'https://assets.example/model' }), destination, {
    checkDiskSpace: (_path, bytes) => { spaceChecks.push(bytes); if (bytes === payload.length) throw new Error('disk space changed'); },
    fetchFn: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 }),
  }));
  return { ...out, spaceChecks, streamCancelled: cancelled, destinationExists: existsSync(destination), files: filesOf(dir) };
});
await rec.run('cancellation-closes-stream-preserves-partial-for-resume', `${SRC}:263`, { payload: 'cancel and resume this model', prefixBytes: 8, enqueued: [8, 12] }, async () => {
  const dir = caseDir('dl-cancel');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('cancel and resume this model');
  const controller = new AbortController();
  let cancelled = false;
  const a = asset(payload, { url: 'https://assets.example/model' });
  writeFileSync(`${destination}.part`, payload.subarray(0, 8));
  const progress = [];
  const cancelledRun = await attempt(downloadVerifiedLocalAsset(a, destination, {
    signal: controller.signal,
    fetchFn: async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(payload.subarray(8, 12)); }, cancel() { cancelled = true; } }), { status: 206 }),
    onProgress: (v) => { progress.push(v); controller.abort(new Error('user cancelled download')); },
  }));
  const afterCancel = { streamCancelled: cancelled, destinationExists: existsSync(destination), partialBytes: readFileSync(`${destination}.part`).length, files: filesOf(dir) };
  const ranges = [];
  const resumed = await attempt(downloadVerifiedLocalAsset(a, destination, { fetchFn: async (_url, { headers }) => { ranges.push(headers.Range ?? null); const start = Number(String(headers.Range || '').match(/bytes=(\d+)-/)?.[1] || 0); return new Response(payload.subarray(start), { status: start ? 206 : 200 }); } }));
  return { cancelledRun, progress, afterCancel, resumed, resumeRanges: ranges, files: filesOf(dir) };
});
await rec.finish();
