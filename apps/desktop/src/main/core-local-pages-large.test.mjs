// A virtual page is one `projectFs/localPage/virtual` request: ECharts (1,121,883 bytes) and Mermaid (5,494,801) alone are
// over the core's 262144-byte inbound frame, which closes the connection. The page is built from the real bundles and sent
// as the core would receive it: every frame under the limit, the library uploaded with blob/put and named by a $blobRef the
// core expands at /files/*/dataBase64, and the lease still a virtual one.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createCoreLocalPages } from './core-local-pages.ts';
import { BLOB_REF_FIELDS } from '../shared/core-lanes/blob-ref-fields.ts';
import { inlineExportDocument } from './visualize/export-offscreen.ts';
import { inlinePageFiles } from './visualize/inline-page.ts';

const MAX_INBOUND_FRAME_BYTES = 262_144;
const echarts = readFileSync(new URL('../../node_modules/echarts/dist/echarts.min.js', import.meta.url), 'utf8');
const mermaid = readFileSync(new URL('../../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8');
const frame = (method, params) => Buffer.byteLength(JSON.stringify({ id: 1, method, params }));

/** The core: blob/put stores chunks by digest; a request's {$blobRef} at a listed pointer is expanded as the app server does. */
function core() {
  const frames = [];
  const staged = new Map();
  const requests = [];
  const stored = new Set();
  const hashes = new Map();
  const call = async (method, params) => {
    frames.push([method, frame(method, params)]);
    if (method === 'blob/read') {
      // The existence probe: one byte from the start of a blob the core holds, blobNotFound otherwise.
      if (!stored.has(params.digest)) throw new Error('blobNotFound');
      return { bytesB64: '' };
    }
    assert.equal(method, 'blob/put');
    const parts = staged.get(params.digest) ?? [];
    assert.equal(params.offset, parts.reduce((sum, part) => sum + part.length, 0), 'chunks arrive in order');
    const chunk = Buffer.from(params.bytesB64, 'base64');
    parts.push(chunk);
    staged.set(params.digest, parts);
    const hash = hashes.get(params.digest) ?? createHash('sha256');
    hash.update(chunk);
    hashes.set(params.digest, hash);
    // A slow publication: the next uploader of the digest would see it complete only after a turn.
    await new Promise((resolve) => setImmediate(resolve));
    if (`sha256:${hash.copy().digest('hex')}` === params.digest) stored.add(params.digest);
    return {};
  };
  const invoke = async (name, args) => {
    assert.equal(name, 'localPageVirtualIn');
    const [files, ownerId] = args;
    frames.push([name, frame('projectFs/localPage/virtual', { files, ownerId })]);
    assert.deepEqual(BLOB_REF_FIELDS['projectFs/localPage/virtual'], ['/files/*/dataBase64']);
    requests.push(
      files.map((file) => {
        const ref = file.dataBase64;
        if (typeof ref === 'string') return { path: file.path, bytes: Buffer.from(ref, 'base64') };
        assert.deepEqual(Object.keys(ref).sort(), ['$blobRef', 'as']);
        assert.equal(ref.as, 'base64');
        const bytes = Buffer.concat(staged.get(ref.$blobRef));
        assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, ref.$blobRef);
        return { path: file.path, bytes };
      })
    );
    return 'http://127.0.0.1:1/lease/index.html';
  };
  return { frames, requests, pages: createCoreLocalPages(invoke, { call }) };
}

const chart = { kind: 'chart', source: JSON.stringify({ series: [{ type: 'bar', data: [3, 5, 2] }] }) };
const diagram = { kind: 'mermaid', source: 'graph TD; A-->B; B-->C; B-->D' };

for (const [name, files, library, libraryFile] of [
  ['an inline chart page', () => inlinePageFiles(chart, async () => echarts), echarts, 'echarts.js'],
  ['an inline mermaid export page', async () => (await inlineExportDocument(diagram, async () => mermaid)).files, mermaid, 'mermaid.js'],
]) {
  test(`${name} with its real library is one virtual lease and every frame is under the limit`, async () => {
    const { frames, requests, pages } = core();
    assert.equal(await pages.virtual(await files(), { ownerId: 'w1' }), 'http://127.0.0.1:1/lease/index.html');
    for (const [method, bytes] of frames) assert.ok(bytes <= MAX_INBOUND_FRAME_BYTES, `${method}: ${bytes} bytes`);
    assert.ok(frames.filter(([method]) => method === 'blob/put').length > 1, 'the library travelled in chunks');
    assert.equal(requests.length, 1);
    const byPath = Object.fromEntries(requests[0].map((file) => [file.path, file.bytes]));
    assert.equal(byPath[libraryFile].toString('utf8'), library, 'the core received the library byte for byte');
    assert.match(byPath['index.html'].toString('utf8'), /<!doctype html>/i);
  });
}

test('pages carrying the same library, built at once, upload it once; later pages upload nothing', async () => {
  const { frames, requests, pages } = core();
  const a = await inlinePageFiles(chart, async () => echarts);
  const b = await inlinePageFiles({ ...chart, source: JSON.stringify({ series: [{ type: 'line', data: [1] }] }) }, async () => echarts);
  await Promise.all([pages.virtual(a, { ownerId: 'w1' }), pages.virtual(b, { ownerId: 'w2' })]);
  const puts = frames.filter(([method]) => method === 'blob/put').length;
  assert.equal(puts, Math.ceil(Buffer.byteLength(echarts) / (96 * 1024)), 'one upload of the library, in 96 KiB chunks');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.find((file) => file.path === 'echarts.js').bytes.toString('utf8'), echarts);
  }
  await pages.virtual(a, { ownerId: 'w1' });
  assert.equal(frames.filter(([method]) => method === 'blob/put').length, puts, 'the core has it: no upload');
});

test('a small page (markdown, html) sends its files inline: no upload', async () => {
  const { frames, pages } = core();
  await pages.virtual(await inlinePageFiles({ kind: 'html', source: '<h1>hi</h1>' }), { ownerId: 'w1' });
  assert.deepEqual(frames.map(([method]) => method), ['localPageVirtualIn']);
});

test('a page file too large for one request without a core connection to upload it is refused, not sent over the limit', async () => {
  const sent = [];
  const pages = createCoreLocalPages(async (name, args) => void sent.push([name, args]));
  await assert.rejects(pages.virtual({ 'index.html': { type: 'text/html', body: Buffer.alloc(300_000) } }), /needs the core connection/);
  assert.deepEqual(sent, []);
});
