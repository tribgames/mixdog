#!/usr/bin/env node
// managed-runtime.test.mjs (10 tests): the real local-provider catalog (manifest, hardware recommendation, platform runtime) and the real
// verified asset installer (`downloadVerifiedLocalAsset`: resume, digest check, disk-space check, Range refusal, cancellation) over scripted
// `checkDiskSpace` (the product's injection point for the disk) over the loopback asset server (the product's own default fetch, redirected: ranges, partial content and the digest are real). Files the installer
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
  exclusions: ['catalog status disk.availableBytes: the host\'s real free disk space, written <host free disk bytes>'],
  entry: 'src/runtime/local-provider/catalog.mjs LOCAL_PROVIDER_MANIFEST / localProviderCatalogStatus({ dataDir, platform, arch, hardware }), asset-installer.mjs downloadVerifiedLocalAsset(asset, destination, { onProgress, checkDiskSpace, signal }) over the loopback asset server, agent/orchestrator/session/manager/context-meta.mjs resolveSessionContextMeta. Not run: a real download.',
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
// The recorder's own file steps (case directories, the partial files a case starts from, reading back what the installer left) run through
// `rec.own`: a failure of them stops the recording, it is never a case's answer.
const caseDir = (name) => rec.own(`creating the case directory ${name}`, () => {
  const dir = join(rec.dataDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
});
const filesOf = (dir) => rec.own(`reading the files under ${dir}`, () => Object.fromEntries(readdirSync(dir).map((name) => [name, { $bytesHex: readFileSync(join(dir, name)).toString('hex') }])));
const writePart = (path, bytes) => rec.own(`writing ${path}`, () => writeFileSync(path, bytes));
const exists = (path) => rec.own(`checking ${path}`, () => existsSync(path));
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

// The asset server is the loopback endpoint (the product's own default fetch, redirected): it serves `payload` from the byte offset of the Range header (206 with Content-Range) or whole (200);
// every request that arrived (head and Range header) is `requests` of the case.
const serveFile = (payload) => (record) => {
  const start = Number(/bytes=(\d+)-/.exec(record.h.range ?? '')?.[1] ?? 0);
  return { status: start ? 206 : 200, contentType: 'application/octet-stream', body: payload.subarray(start), headers: start ? { 'content-range': `bytes ${start}-${payload.length - 1}/${payload.length}` } : {} };
};
const asset = (payload, extra = {}) => ({ name: 'asset.bin', url: 'https://assets.example/asset.bin', size: payload.length, sha256: sha256(payload), ...extra });
await rec.run('resume-partial-publish-after-sha256', `${SRC}:106`, { payload: 'verified local provider asset', prefixBytes: 9 }, async () => {
  const dir = caseDir('dl-resume');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('verified local provider asset');
  const prefix = payload.subarray(0, 9);
  const progress = [];
  rec.net.reply = serveFile(payload);
  writePart(`${destination}.part`, prefix);
  const out = await attempt(downloadVerifiedLocalAsset(asset(payload), destination, { onProgress: (v) => progress.push(v) }));
  return { ...out, progress, files: filesOf(dir) };
});
await rec.run('digest-mismatch-not-published', `${SRC}:140`, { payload: 'tampered' }, async () => {
  const dir = caseDir('dl-digest');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('tampered');
  rec.net.reply = serveFile(payload);
  const out = await attempt(downloadVerifiedLocalAsset({ ...asset(payload), sha256: '0'.repeat(64) }, destination, {}));
  return { ...out, destinationExists: exists(destination), partExists: exists(`${destination}.part`), files: filesOf(dir) };
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
  writePart(`${destination}.part`, prefix);
  rec.net.reply = serveFile(payload);
  const spaceChecks = [];
  const first = await attempt(downloadVerifiedLocalAsset(asset(payload, { url: 'https://assets.example/model' }), destination, {
    checkDiskSpace: (_path, bytes) => { spaceChecks.push(bytes); if (bytes > payload.length - prefix.length) throw new Error('not enough free disk space'); },
  }));
  const requestsAfterFirst = rec.net.records.length;
  let secondSpaceChecks = 0;
  const second = await attempt(downloadVerifiedLocalAsset(asset(payload, { url: 'https://assets.example/model' }), destination, { checkDiskSpace: () => { secondSpaceChecks += 1; } }));
  return { first, spaceChecks, second, requestsAfterFirst, requestsAfterSecond: rec.net.records.length, secondSpaceChecks, files: filesOf(dir) };
});
await rec.run('server-declining-range-cannot-bypass-disk-check', `${SRC}:226`, { payload: 'model payload', prefixBytes: 5 }, async () => {
  const dir = caseDir('dl-range');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('model payload');
  writePart(`${destination}.part`, payload.subarray(0, 5));
  // The server declines the range (200, whole file) and keeps the body open: the installer must close the connection.
  rec.net.reply = () => ({ status: 200, contentType: 'application/octet-stream', chunks: [], hold: true });
  const spaceChecks = [];
  const out = await attempt(downloadVerifiedLocalAsset(asset(payload, { url: 'https://assets.example/model' }), destination, {
    checkDiskSpace: (_path, bytes) => { spaceChecks.push(bytes); if (bytes === payload.length) throw new Error('disk space changed'); },
  }));
  await rec.own('the first request\'s connection closing', () => rec.net.records[0].whenClientClosed);
  return { ...out, spaceChecks, clientClosedTheConnection: true, destinationExists: exists(destination), files: filesOf(dir) };
});
await rec.run('cancellation-closes-stream-preserves-partial-for-resume', `${SRC}:263`, { payload: 'cancel and resume this model', prefixBytes: 8, enqueued: [8, 12] }, async () => {
  const dir = caseDir('dl-cancel');
  const destination = join(dir, 'asset.bin');
  const payload = Buffer.from('cancel and resume this model');
  const controller = new AbortController();
  const a = asset(payload, { url: 'https://assets.example/model' });
  writePart(`${destination}.part`, payload.subarray(0, 8));
  const progress = [];
  // The server answers the ranged request with bytes 8-11 and keeps the body open until the client closes the connection.
  rec.net.reply = () => ({ status: 206, contentType: 'application/octet-stream', headers: { 'content-range': `bytes 8-${payload.length - 1}/${payload.length}` }, chunks: [payload.subarray(8, 12)], hold: true });
  const cancelledRun = await attempt(downloadVerifiedLocalAsset(a, destination, {
    signal: controller.signal,
    onProgress: (v) => { progress.push(v); controller.abort(new Error('user cancelled download')); },
  }));
  await rec.own('the first request\'s connection closing', () => rec.net.records[0].whenClientClosed);
  const afterCancel = { clientClosedTheConnection: true, destinationExists: exists(destination), partialBytes: rec.own('reading the partial file', () => readFileSync(`${destination}.part`).length), files: filesOf(dir) };
  rec.net.reply = serveFile(payload);
  const resumed = await attempt(downloadVerifiedLocalAsset(a, destination, {}));
  return { cancelledRun, progress, afterCancel, resumed, files: filesOf(dir) };
});
await rec.finish();
