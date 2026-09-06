import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHuggingFaceCatalog } from './hugging-face.mjs';
import { registeredLocalModels, registerLocalModel } from './registered-models.mjs';
import { parseGgufHeader, ggufMemoryPlan } from './gguf-header.mjs';

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
function gguf() {
  const values = [
    ['general.architecture', 8, str('testarch')],
    ['testarch.context_length', 4, u32(16384)], ['testarch.block_count', 4, u32(16)],
    ['testarch.embedding_length', 4, u32(2048)], ['testarch.attention.head_count', 4, u32(16)],
    ['testarch.attention.head_count_kv', 4, u32(4)],
  ];
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(10), u64(values.length),
    ...values.flatMap(([key, type, value]) => [str(key), u32(type), value])]);
}
function fixture(dataDir) {
  const payload = gguf();
  const info = { id: 'publisher/model', sha: 'a'.repeat(40), cardData: { license: 'apache-2.0' },
    siblings: [{ rfilename: 'model.gguf', size: payload.length, lfs: { size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') } }] };
  let time = 0;
  const service = createHuggingFaceCatalog({ dataDir, now: () => time, fetchFn: async (url) => {
    if (url.includes('/api/models?')) return Response.json([{ id: 'publisher/model', downloads: 10 }]);
    if (url.includes('/api/models/')) return Response.json(info);
    return new Response(payload, { status: 206, headers: { 'content-range': `bytes 0-${payload.length - 1}/${payload.length}` } });
  } });
  return { payload, info, service, expire: () => { time += 16 * 60_000; } };
}

test('HF search and inspection do not install; approval registers a revision-pinned descriptor from actual GGUF metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-hf-preview-'));
  try {
    const { service } = fixture(root);
    assert.equal((await service.search('model')).models[0].repository, 'publisher/model');
    const listing = await service.inspect({ repository: 'publisher/model' });
    assert.equal(listing.files[0].filename, 'model.gguf');
    const preview = await service.inspect({ repository: 'publisher/model', filename: 'model.gguf' });
    assert.equal(preview.model.contextWindow, 8192);
    assert.equal(preview.model.architecture, 'testarch');
    assert.deepEqual(registeredLocalModels(root), []);
    assert.equal(existsSync(join(root, 'local-provider', 'models')), false);
    assert.throws(() => service.register(preview.previewId, false), /license acceptance/);
    const registered = service.register(preview.previewId, true);
    assert.match(registered.model.url, /resolve\/a{40}\/model.gguf$/);
    assert.equal(registeredLocalModels(root)[0].id, registered.model.id);
    assert.equal(existsSync(join(root, 'local-provider', 'models', registered.model.filename)), false);
    assert.throws(() => registerLocalModel({ ...registered.model, filename: '../escape.gguf' }, root), /invalid registered/);
    assert.throws(() => service.register(preview.previewId, true), /expired/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HF refuses missing integrity metadata, restricted repos, shards, traversal and expired approval receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-hf-reject-'));
  try {
    const { service, info, expire } = fixture(root);
    await assert.rejects(service.inspect({ repository: '../model' }), /repository/);
    await assert.rejects(service.inspect({ repository: 'publisher/model', filename: '../model.gguf' }), /unsupported/);
    await assert.rejects(service.inspect({ repository: 'publisher/model', filename: 'model-00001-of-00002.gguf' }), /unsupported/);
    const preview = await service.inspect({ repository: 'publisher/model', filename: 'model.gguf' });
    expire();
    assert.throws(() => service.register(preview.previewId, true), /expired/);
    info.gated = true;
    await assert.rejects(service.inspect({ repository: 'publisher/model' }), /ungated/);
    info.gated = false;
    info.siblings[0].lfs.sha256 = '';
    await assert.rejects(service.inspect({ repository: 'publisher/model', filename: 'model.gguf' }), /SHA-256/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('GGUF inspection validates structure and computes context-dependent allocation instead of trusting the repository label', () => {
  const header = parseGgufHeader(gguf());
  const small = ggufMemoryPlan(header, 1_000_000, 4096);
  const large = ggufMemoryPlan(header, 1_000_000, 8192);
  assert.ok(large.estimatedVramBytes > small.estimatedVramBytes);
  assert.equal(large.memoryEstimate.kvBytes, small.memoryEstimate.kvBytes * 2);
  assert.throws(() => parseGgufHeader(Buffer.from('not GGUF')), /not GGUF/);
  assert.throws(() => parseGgufHeader(gguf().subarray(0, 20)), /prefix/);
  assert.throws(() => ggufMemoryPlan(header, 1_000_000, 999999), /contextWindow/);
});
