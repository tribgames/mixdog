import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  buildPageSrcdoc,
  createRemotePreviewApi,
  readRemoteFile,
  REMOTE_PREVIEW_CHUNK_BYTES,
  resolvePageReference,
} from './remote-file-preview.ts';
import { openSandboxedPagePreview } from './sandboxed-page-preview.ts';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.document = dom.window.document;

// Fake host serving `files` through the same two methods as the real one.
function fakeHost(files) {
  const calls = [];
  const call = async (method, params) => {
    calls.push([method, ...params]);
    const [, rel] = params;
    const file = files[rel];
    if (!file) throw new Error('missing');
    if (method === 'previewProjectFile') return { kind: 'video', mime: file.mime, mtimeMs: 1, size: file.bytes.length };
    const [, , , offset, length] = params;
    const slice = file.bytes.subarray(offset, offset + length);
    return { data: Buffer.from(slice).toString('base64'), mime: file.mime, offset, size: file.bytes.length, mtimeMs: 1 };
  };
  return { call, calls };
}
const file = (text, mime) => ({ bytes: Buffer.from(text), mime });

test('large files are read in several bounded ranges', async () => {
  const bytes = Buffer.alloc(REMOTE_PREVIEW_CHUNK_BYTES * 2 + 5, 7);
  const host = fakeHost({ 'a.mp4': { bytes, mime: 'video/mp4' } });
  const read = await readRemoteFile(host.call, ['p', 'a.mp4', null], bytes.length);
  assert.equal(read.size, bytes.length);
  assert.deepEqual(host.calls.map((c) => c[4]), [0, REMOTE_PREVIEW_CHUNK_BYTES, REMOTE_PREVIEW_CHUNK_BYTES * 2]);
  await assert.rejects(readRemoteFile(host.call, ['p', 'a.mp4', null], 10), /too large/);
});

test('previewProjectFile builds a cached blob URL and refuses oversize files', async () => {
  const made = [];
  globalThis.URL.createObjectURL = (blob) => {
    made.push(blob);
    return `blob:test/${made.length}`;
  };
  globalThis.URL.revokeObjectURL = () => {};
  const host = fakeHost({ 'a.mp4': file('hello', 'video/mp4') });
  const api = createRemotePreviewApi(host.call);
  const first = await api.previewProjectFile('p', 'a.mp4');
  const second = await api.previewProjectFile('p', 'a.mp4');
  assert.equal(first.url, 'blob:test/1');
  assert.equal(second.url, first.url);
  assert.equal(made[0].type, 'video/mp4');
  assert.equal(first.kind, 'video');
  const huge = createRemotePreviewApi(async () => ({ kind: 'video', mime: 'video/mp4', mtimeMs: 1, size: 1e12 }));
  await assert.rejects(huge.previewProjectFile('p', 'big.mp4'), /too large/);
});

async function withFetch(fetchImpl, body) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

test('a host with the media lane is previewed by streaming, with no RPC range reads', async () => {
  const calls = [];
  const probes = [];
  const call = async (method) => {
    calls.push(method);
    return { kind: 'video', mime: 'video/mp4', mtimeMs: 3, size: 1e12, mediaAssetId: 'aaaaaaaa-1111' };
  };
  await withFetch(
    async (url, init) => {
      probes.push([url, init.headers.Range]);
      return new Response(null, { status: 206 });
    },
    async () => {
      const api = createRemotePreviewApi(call, (assetId, variant) => `https://relay.test/media/${assetId}?variant=${variant}&sid=s`);
      const preview = await api.previewProjectFile('p', 'big.mp4');
      assert.equal(preview.url, 'https://relay.test/media/aaaaaaaa-1111?variant=original&sid=s');
      assert.equal(preview.kind, 'video');
      assert.equal(preview.size, 1e12);
      assert.deepEqual(calls, ['previewProjectFile']);
      assert.deepEqual(probes, [[preview.url, 'bytes=0-0']]);
    }
  );
});

test('an older host, a missing lane, or a lane that does not answer keeps the RPC blob path', async () => {
  globalThis.URL.createObjectURL = () => 'blob:test/fallback';
  globalThis.URL.revokeObjectURL = () => {};
  const bytes = Buffer.from('hello');
  const hostCall = (extra) => async (method, params) => {
    if (method === 'previewProjectFile') return { kind: 'video', mime: 'video/mp4', mtimeMs: 1, size: bytes.length, ...extra };
    const [, , , offset, length] = params;
    return {
      data: bytes.subarray(offset, offset + length).toString('base64'),
      mime: 'video/mp4',
      offset,
      size: bytes.length,
      mtimeMs: 1,
    };
  };
  const laneUrl = (id) => `https://relay.test/media/${id}`;
  await withFetch(
    async () => new Response(null, { status: 503 }),
    async () => {
      // Old host: no lease in its answer.
      const old = createRemotePreviewApi(hostCall({}), laneUrl);
      assert.equal((await old.previewProjectFile('p', 'a.mp4')).url, 'blob:test/fallback');
      // New host, but this browser has no lane (no worker / old host handshake).
      const noLane = createRemotePreviewApi(hostCall({ mediaAssetId: 'aaaaaaaa-1111' }), () => '');
      assert.equal((await noLane.previewProjectFile('p', 'a.mp4')).url, 'blob:test/fallback');
      // Lane advertised but the relay or host refuses it (version skew).
      const refused = createRemotePreviewApi(hostCall({ mediaAssetId: 'aaaaaaaa-1111' }), laneUrl);
      assert.equal((await refused.previewProjectFile('p', 'a.mp4')).url, 'blob:test/fallback');
    }
  );
  await withFetch(
    async () => {
      throw new TypeError('network');
    },
    async () => {
      const failing = createRemotePreviewApi(hostCall({ mediaAssetId: 'aaaaaaaa-1111' }), laneUrl);
      assert.equal((await failing.previewProjectFile('p', 'b.mp4')).url, 'blob:test/fallback');
    }
  );
  // Documents are never streamed: pdf keeps its own path even with a lease.
  const pdf = createRemotePreviewApi(async () => {
    return { kind: 'pdf', mime: 'application/pdf', mtimeMs: 1, size: 1e12, mediaAssetId: 'aaaaaaaa-1111' };
  }, laneUrl);
  await assert.rejects(pdf.previewProjectFile('p', 'x.pdf'), /too large/);
});

test('page references resolve inside the project only', () => {
  assert.equal(resolvePageReference('site/index.html', 'css/a.css?v=1'), 'site/css/a.css');
  assert.equal(resolvePageReference('site/index.html', '../shared/a.js'), 'shared/a.js');
  assert.equal(resolvePageReference('site/index.html', '/root.png'), 'root.png');
  assert.equal(resolvePageReference('index.html', '../escape.png'), '');
  assert.equal(resolvePageReference('index.html', 'https://x.test/a.js'), '');
  assert.equal(resolvePageReference('index.html', '//x.test/a.js'), '');
  assert.equal(resolvePageReference('index.html', 'data:image/png;base64,AA'), '');
});

test('a page is inlined with its relative assets and unresolved ones are kept', async () => {
  const host = fakeHost({
    'site/index.html': file(
      '<link rel="stylesheet" href="a.css"><script src="app.js"></script><img src="p.png"><img src="gone.png"><script src="https://cdn.test/x.js"></script>',
      'text/html'
    ),
    'site/a.css': file('body{color:red}', 'text/css'),
    'site/app.js': file('var s="</script>";', 'text/javascript'),
    'site/p.png': file('PNG', 'image/png'),
  });
  const html = await buildPageSrcdoc(host.call, 'p', 'site/index.html', null);
  assert.match(html, /<style>body\{color:red\}<\/style>/);
  assert.match(html, /<script>var s="<\\\/script>";<\/script>/);
  assert.match(html, /src="data:image\/png;base64,UE5H"/);
  assert.match(html, /src="gone\.png"/);
  assert.match(html, /src="https:\/\/cdn\.test\/x\.js"/);
});

test('the viewer frame is sandboxed to scripts only, hands the document over on ready, and closes', () => {
  globalThis.window = dom.window;
  const close = openSandboxedPagePreview('<p>x</p>', 'index.html');
  const frame = document.querySelector('iframe');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('src'), '/preview-frame');
  const posted = [];
  const frameWindow = frame.contentWindow;
  frameWindow.postMessage = (message, target) => posted.push([message, target]);
  const ready = { type: 'mixdog-preview-ready' };
  // A message from anything but the frame is ignored.
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: ready, source: dom.window }));
  assert.equal(posted.length, 0);
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: ready, source: frameWindow }));
  // Only one document is ever delivered.
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: ready, source: frameWindow }));
  assert.deepEqual(posted, [[{ type: 'mixdog-preview-document', html: '<p>x</p>' }, '*']]);
  close();
  assert.equal(document.querySelector('iframe'), null);
});

test('the viewer falls back to srcdoc when the frame route never answers', async () => {
  globalThis.window = dom.window;
  const close = openSandboxedPagePreview('<p>y</p>', 'index.html');
  const frame = document.querySelector('iframe');
  await new Promise((resolve) => setTimeout(resolve, 3100));
  assert.equal(frame.getAttribute('src'), null);
  assert.equal(frame.srcdoc, '<p>y</p>');
  close();
});
