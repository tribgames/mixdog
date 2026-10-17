// The REAL host lane (main/remote-relay-media.ts) feeds the REAL worker script
// (public/sw-media.js, evaluated in a VM like a worker) through a fake relay
// that forwards bytes untouched. Whatever the worker returns to an element is
// what a <video>/<img> would receive.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { leaseMediaFile } from '../main/media-leases.ts';
import { DOWNLOAD_WINDOW_MAX_BYTES, MEDIA_WINDOW_MAX_BYTES, createRelayMediaLane } from '../main/remote-relay-media.ts';
import { FileDownloadError } from '../shared/file-downloads.ts';
import { MEDIA_SEGMENT_BYTES } from '../shared/remote-media-crypto.ts';
import { fileDownloadLaneUrl, publishMediaKey, revokeMediaKey } from './remote-media-lane.ts';

const source = readFileSync(new URL('./public/sw-media.js', import.meta.url), 'utf8');
const ORIGIN = 'https://relay.mixdog.test';
const SID = 'W'.repeat(43);
const PHONE_DEVICE = 'phone-credential';
const LEASE_ID = '11111111-2222-4333-8444-555555555555';
const VERSION = 'v'.repeat(43);
const dir = mkdtempSync(join(tmpdir(), 'sw-media-'));

function lease(name, size, mime = 'video/mp4') {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 131 + (index >> 10)) & 0xff;
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { bytes, assetId: leaseMediaFile(path, mime, { within: dir, identity: statSync(path, { bigint: true }) }) };
}

async function setup({ mutate, redirect, downloads, device = PHONE_DEVICE } = {}) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const upstream = [];
  const upstreamUrls = [];
  // Relay stand-in: asks the host, then hands the body over in odd-sized pieces.
  // `redirect` lets a test play a hostile relay that asks for something else.
  const fetchThroughRelay = async (url, init) => {
    const parsed = new URL(url);
    const requestedAsset = /\/media\/([^/?]+)/.exec(parsed.pathname)[1];
    const [assetId, range = init.headers.Range ?? ''] = redirect
      ? redirect(requestedAsset, init.headers.Range)
      : [requestedAsset];
    upstream.push(init.headers.Range);
    upstreamUrls.push(parsed);
    const sent = [];
    const lane = createRelayMediaLane({
      host: { invokeCapability: async () => null },
      sendEnvelope: (envelope) => sent.push(envelope),
      socketBacklog: () => 0,
      mediaKey: (sid) => (sid === SID ? key : null),
      mediaDevice: (sid) => (sid === SID ? device : null),
      downloads,
    });
    await lane.serve({
      id: 'u',
      assetId,
      variant: parsed.searchParams.get('variant') || 'original',
      method: 'GET',
      range,
      sid: parsed.searchParams.get('sid') || '',
      enc: parsed.searchParams.get('enc') || '',
    });
    const head = sent[0];
    if (head.status !== 200) return new Response(null, { status: head.status });
    let body = Buffer.concat(sent.filter((e) => e.type === 'media-chunk').map((e) => Buffer.from(e.data, 'base64')));
    if (mutate) body = mutate(body, parsed);
    return new Response(
      new ReadableStream({
        start(controller) {
          for (let at = 0; at < body.length; at += 7001)
            controller.enqueue(new Uint8Array(body.subarray(at, at + 7001)));
          controller.close();
        },
      }),
      { status: 200 }
    );
  };
  const context = {
    AbortController,
    Headers,
    Promise,
    ReadableStream,
    Response,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    clearTimeout,
    fetch: fetchThroughRelay,
    setTimeout,
    self: { crypto: globalThis.crypto, clients: { matchAll: async () => [] } },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${source}\n;globalThis.__lane = mixdogMediaLane;`, context);
  const worker = context.__lane;
  worker.acceptKey({ type: worker.KEY_MESSAGE, sid: SID, key });
  const get = async (assetId, { range, destination = 'video', variant = 'original', sid = SID } = {}) => {
    const url = `${ORIGIN}/media/${assetId}?variant=${variant}&sid=${sid}&enc=e2ee1&token=t`;
    const request = {
      url,
      method: 'GET',
      mode: 'no-cors',
      destination,
      headers: new Headers(range ? { range } : {}),
    };
    const route = worker.match(request, new URL(url));
    assert.ok(route, 'the worker recognizes the media URL');
    return worker.answer(request, route);
  };
  // A download as the browser would open it: a navigation (anchor click) or
  // the page's own resume fetch of the URL the page built.
  const download = async (url, { range, ifRange, mode = 'navigate', destination = 'document' } = {}) => {
    const headers = new Headers();
    if (range) headers.set('range', range);
    if (ifRange) headers.set('if-range', ifRange);
    const request = { url, method: 'GET', mode, destination, headers };
    const route = worker.match(request, new URL(url));
    assert.ok(route?.download, 'the worker recognizes the download URL');
    return worker.answer(request, route);
  };
  return { get, download, upstream, upstreamUrls, worker, key };
}

const SIZE = MEDIA_WINDOW_MAX_BYTES * 2 + 123;

test('a plain request streams the whole file across several encrypted windows', async () => {
  const { bytes, assetId } = lease('whole.mp4', SIZE);
  const { get, upstream } = await setup();
  const response = await get(assetId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-length'), String(SIZE));
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(upstream, [
    `bytes=0-${MEDIA_WINDOW_MAX_BYTES - 1}`,
    `bytes=${MEDIA_WINDOW_MAX_BYTES}-${MEDIA_WINDOW_MAX_BYTES * 2 - 1}`,
    `bytes=${MEDIA_WINDOW_MAX_BYTES * 2}-${SIZE - 1}`,
  ]);
});

test('seeking answers 206 with exactly the requested bytes, fetching only what it needs', async () => {
  const { bytes, assetId } = lease('seek.mp4', SIZE);
  const { get, upstream } = await setup();
  const mid = await get(assetId, { range: 'bytes=1500000-1500099' });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('content-range'), `bytes 1500000-1500099/${SIZE}`);
  assert.equal(mid.headers.get('content-length'), '100');
  assert.deepEqual(Buffer.from(await mid.arrayBuffer()), bytes.subarray(1_500_000, 1_500_100));
  // One small, segment-aligned window instead of the megabyte after the seek.
  assert.deepEqual(upstream, ['bytes=1441792-1500099']);

  const across = await get(assetId, { range: 'bytes=1000000-2200000' });
  assert.equal(across.status, 206);
  assert.deepEqual(Buffer.from(await across.arrayBuffer()), bytes.subarray(1_000_000, 2_200_001));

  const open = await get(assetId, { range: `bytes=${SIZE - 70_000}-` });
  assert.equal(open.headers.get('content-range'), `bytes ${SIZE - 70_000}-${SIZE - 1}/${SIZE}`);
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), bytes.subarray(SIZE - 70_000));

  const suffix = await get(assetId, { range: 'bytes=-50' });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(SIZE - 50));

  const past = await get(assetId, { range: `bytes=${SIZE + 10}-` });
  assert.equal(past.status, 416);
  const invalid = await get(assetId, { range: 'bytes=abc' });
  assert.equal(invalid.status, 416);
});

test('a cancelled element stops fetching further windows', async () => {
  const { assetId } = lease('cancel.mp4', SIZE);
  const { get, upstream } = await setup();
  const response = await get(assetId);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(upstream.length, 1);
});

test('modified ciphertext never reaches the element as bytes', async () => {
  const { assetId } = lease('tamper.mp4', 300_000);
  const flip = await setup({
    mutate: (body) => {
      const copy = Buffer.from(body);
      copy[copy.length - 5] ^= 0x01;
      return copy;
    },
  });
  await assert.rejects((await flip.get(assetId)).arrayBuffer());
  const truncate = await setup({ mutate: (body) => body.subarray(0, body.length - 100) });
  await assert.rejects((await truncate.get(assetId)).arrayBuffer());
});

test('frames of another asset or window cannot be replayed into a response', async () => {
  const a = lease('a.mp4', 300_000);
  const b = lease('b.mp4', 300_000);
  // A hostile relay answers a request for B with what the host produced for A.
  const crossAsset = await setup({ redirect: (assetId) => [assetId === b.assetId ? a.assetId : assetId] });
  assert.equal((await crossAsset.get(b.assetId)).status, 502);
  // ...or answers a request for a later window with the first one.
  const big = lease('big.mp4', SIZE);
  const crossWindow = await setup({ redirect: (assetId) => [assetId, 'bytes=0-65535'] });
  assert.equal((await crossWindow.get(big.assetId, { range: 'bytes=1500000-1500099' })).status, 502);
});

test('response types are made safe and non-element requests are not intercepted', async () => {
  const page = lease('page.html', 2000, 'text/html');
  const svg = lease('pic.svg', 2000, 'image/svg+xml');
  const { get, worker } = await setup();
  assert.equal((await get(page.assetId)).headers.get('content-type'), 'application/octet-stream');
  assert.equal(
    (await get(svg.assetId, { destination: 'video' })).headers.get('content-type'),
    'application/octet-stream'
  );
  assert.equal((await get(svg.assetId, { destination: 'image' })).headers.get('content-type'), 'image/svg+xml');
  const url = new URL(`${ORIGIN}/media/0123456789abcdef?sid=${SID}&enc=e2ee1`);
  const request = (overrides) => ({ method: 'GET', mode: 'no-cors', destination: 'video', ...overrides });
  // A request without the scheme marker (an older page) is left to the network.
  assert.equal(worker.match(request({}), new URL(`${ORIGIN}/media/0123456789abcdef?sid=${SID}`)), null);
  assert.ok(worker.match(request({}), url));
  assert.equal(worker.match(request({ mode: 'navigate', destination: 'document' }), url), null);
  assert.equal(worker.match(request({ destination: 'script' }), url), null);
  assert.equal(worker.match(request({ method: 'POST' }), url), null);
  assert.equal(worker.match(request({}), new URL(`${ORIGIN}/media/0123456789abcdef`)), null);
  assert.equal(worker.match(request({}), new URL(`${ORIGIN}/media/healthz?sid=${SID}`)), null);
});

test('a host that refuses answers with its status, never with bytes', async () => {
  const { assetId } = lease('refuse.mp4', 1000);
  const { get } = await setup();
  assert.equal((await get('deadbeef-0000-0000-0000-000000000000')).status, 404);
  const wrongSession = await setup();
  wrongSession.worker.acceptKey({ type: wrongSession.worker.KEY_MESSAGE, sid: 'X'.repeat(43), key: wrongSession.key });
  assert.equal((await wrongSession.get(assetId, { sid: 'X'.repeat(43) })).status, 403);
});

// ── File downloads (variant `download`) ─────────────────────────────────────

const DOWNLOAD_SIZE = DOWNLOAD_WINDOW_MAX_BYTES + 70_123;

function downloadBytes(size) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 13 + (index >> 9)) & 0xff;
  return bytes;
}

/** A host lease of `bytes` owned by the phone (file-downloads.ts resolveMedia). */
function leaseSource(bytes, { mime = 'application/pdf', version = VERSION } = {}) {
  const state = { changed: false, reads: 0 };
  return {
    state,
    resolveMedia(assetId, variant, deviceId) {
      if (assetId !== LEASE_ID || variant !== 'download' || deviceId !== PHONE_DEVICE) return null;
      return {
        size: bytes.length,
        mime,
        version,
        read: async (offset, length) => {
          state.reads += 1;
          if (state.changed) throw new FileDownloadError('changed', 'The file changed on the host.');
          return bytes.subarray(offset, offset + length);
        },
      };
    },
  };
}

const transferOf = (size, overrides = {}) => ({
  transferId: '99999999-8888-4777-8666-555555555555',
  name: 'Quarterly report.pdf',
  size,
  mime: 'application/pdf',
  version: VERSION,
  expiresAt: Date.now() + 60_000,
  rangeMaxBytes: 4 * 1024 * 1024,
  media: { assetId: LEASE_ID, variant: 'download', expiresAt: Date.now() + 60_000 },
  ...overrides,
});

/** The URL the page itself builds (remote-media-lane.ts), as a controlled page. */
function pageUrl(key, transfer) {
  const saved = ['navigator', 'location'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('navigator', {
    serviceWorker: { controller: { postMessage: () => undefined }, addEventListener: () => undefined },
  });
  define('location', { origin: ORIGIN });
  try {
    publishMediaKey(SID, key, { base: ORIGIN, token: () => 'tok' });
    return fileDownloadLaneUrl(transfer);
  } finally {
    revokeMediaKey(SID);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

/** Every byte a body yields before it ends or errors. */
async function drain(response) {
  const reader = response.body.getReader();
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { bytes: Buffer.concat(parts), error: null };
      parts.push(Buffer.from(value));
    }
  } catch (error) {
    return { bytes: Buffer.concat(parts), error };
  }
}

function splitFrames(body) {
  const frames = [];
  for (let at = 0; at < body.length; ) {
    const length = body.readUInt32BE(at);
    frames.push(body.subarray(at, at + 4 + length));
    at += 4 + length;
  }
  return frames;
}

test('a download is a decrypted, no-store attachment streamed across large windows', async () => {
  const bytes = downloadBytes(DOWNLOAD_SIZE);
  const lane = await setup({ downloads: leaseSource(bytes) });
  const url = pageUrl(lane.key, transferOf(bytes.length));
  assert.ok(url.startsWith(`${ORIGIN}/__mixdog-download__/${LEASE_ID}?`));
  const response = await lane.download(url);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-disposition'),
    `attachment; filename="Quarterly report.pdf"; filename*=UTF-8''Quarterly%20report.pdf`
  );
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('etag'), `"${VERSION}"`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.deepEqual(lane.upstream, [
    `bytes=0-${DOWNLOAD_WINDOW_MAX_BYTES - 1}`,
    `bytes=${DOWNLOAD_WINDOW_MAX_BYTES}-${bytes.length - 1}`,
  ]);
  // The worker asks the relay's media route for the download variant, with
  // the page's credential; the page-only download path never leaves it.
  const asked = lane.upstreamUrls[0];
  assert.equal(asked.pathname, `/media/${LEASE_ID}`);
  assert.deepEqual(
    ['variant', 'sid', 'enc', 'token'].map((name) => asked.searchParams.get(name)),
    ['download', SID, 'e2ee1', 'tok']
  );
  assert.equal(asked.searchParams.get('name'), null);
});

test('an interrupted download resumes from its acknowledged offset with the same version', async () => {
  const bytes = downloadBytes(DOWNLOAD_SIZE);
  const lane = await setup({ downloads: leaseSource(bytes) });
  const url = pageUrl(lane.key, transferOf(bytes.length));
  const offset = DOWNLOAD_WINDOW_MAX_BYTES - 1000;
  const resumed = await lane.download(url, {
    range: `bytes=${offset}-`,
    ifRange: `"${VERSION}"`,
    mode: 'cors',
    destination: '',
  });
  assert.equal(resumed.status, 206);
  assert.equal(resumed.headers.get('content-range'), `bytes ${offset}-${bytes.length - 1}/${bytes.length}`);
  assert.equal(resumed.headers.get('content-length'), String(bytes.length - offset));
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), bytes.subarray(offset));
  // A validator of another version restarts from zero instead of splicing.
  const restarted = await lane.download(url, { range: `bytes=${offset}-`, ifRange: `"${'x'.repeat(43)}"` });
  assert.equal(restarted.status, 200);
  assert.deepEqual(Buffer.from(await restarted.arrayBuffer()), bytes);
  assert.equal((await lane.download(url, { range: `bytes=${bytes.length}-` })).status, 416);
  assert.equal((await lane.download(url, { range: 'bytes=x-' })).status, 416);
});

test('another version, size or a changed host file is refused, never served as this download', async () => {
  const bytes = downloadBytes(200_000);
  const source = leaseSource(bytes);
  const lane = await setup({ downloads: source });
  const otherVersion = pageUrl(lane.key, transferOf(bytes.length, { version: 'y'.repeat(43) }));
  assert.equal((await lane.download(otherVersion)).status, 412);
  const otherSize = pageUrl(lane.key, transferOf(bytes.length + 1));
  assert.equal((await lane.download(otherSize)).status, 412);
  source.state.changed = true;
  const url = pageUrl(lane.key, transferOf(bytes.length));
  assert.equal((await lane.download(url, { range: 'bytes=70000-' })).status, 412);
});

test('a lease of another device is not found, even with this session key', async () => {
  const bytes = downloadBytes(1000);
  const lane = await setup({ downloads: leaseSource(bytes), device: 'tablet-credential' });
  const response = await lane.download(pageUrl(lane.key, transferOf(bytes.length)));
  assert.equal(response.status, 404);
  assert.equal(response.body, null);
});

test('corrupt, reordered or truncated segments end the download without a wrong byte', async () => {
  const bytes = downloadBytes(400_000);
  const flip = (body) => {
    const copy = Buffer.from(body);
    copy[copy.length - 5] ^= 0x01;
    return copy;
  };
  // Swap the second and third data frames (frame 0 is the meta).
  const reorder = (body) => {
    const frames = splitFrames(body);
    [frames[2], frames[3]] = [frames[3], frames[2]];
    return Buffer.concat(frames);
  };
  const truncate = (body) => body.subarray(0, body.length - 100);
  const dropLast = (body) => Buffer.concat(splitFrames(body).slice(0, -1));
  for (const mutate of [flip, reorder, truncate, dropLast]) {
    const lane = await setup({ downloads: leaseSource(bytes), mutate });
    const response = await lane.download(pageUrl(lane.key, transferOf(bytes.length)));
    assert.equal(response.status, 200, mutate.name);
    const { bytes: received, error } = await drain(response);
    assert.ok(error, `${mutate.name} must fail the body`);
    assert.ok(received.length < bytes.length, mutate.name);
    assert.deepEqual(received, bytes.subarray(0, received.length), `${mutate.name} yields only authentic bytes`);
  }
});

test('the worker pulls a download one segment at a time, never buffering the file', async () => {
  const bytes = downloadBytes(DOWNLOAD_SIZE);
  const source = leaseSource(bytes);
  const lane = await setup({ downloads: source });
  const response = await lane.download(pageUrl(lane.key, transferOf(bytes.length)));
  const reader = response.body.getReader();
  for (let index = 0; index < 3; index += 1) {
    const { value } = await reader.read();
    assert.ok(value.byteLength <= MEDIA_SEGMENT_BYTES);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Only the first window was asked for; the rest waits for the reader.
  assert.equal(lane.upstream.length, 1);
  await reader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(lane.upstream.length, 1);
});

test('an empty file downloads as an empty attachment', async () => {
  const lane = await setup({ downloads: leaseSource(Buffer.alloc(0)) });
  const response = await lane.download(pageUrl(lane.key, transferOf(0, { name: 'empty.txt' })));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), '0');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.deepEqual(lane.upstream, [undefined]);
});

test('download file names are sanitized into a safe attachment header', async () => {
  const { worker } = await setup();
  const disposition = worker.attachmentDisposition;
  assert.equal(disposition('report.pdf'), `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`);
  assert.equal(
    disposition('../../etc/passwd'),
    `attachment; filename="_.._etc_passwd"; filename*=UTF-8''_.._etc_passwd`
  );
  assert.equal(disposition('a\u202Egnp.exe'), `attachment; filename="agnp.exe"; filename*=UTF-8''agnp.exe`);
  assert.equal(
    disposition('résumé "final".txt'),
    `attachment; filename="r_sum_ _final_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9%20_final_.txt`
  );
  assert.equal(
    disposition('evil\r\nSet-Cookie: x'),
    `attachment; filename="evilSet-Cookie_ x"; filename*=UTF-8''evilSet-Cookie_%20x`
  );
  assert.equal(disposition('CON.txt'), `attachment; filename="_CON.txt"; filename*=UTF-8''_CON.txt`);
  assert.equal(disposition('100%;x'), `attachment; filename="100__x"; filename*=UTF-8''100%25%3Bx`);
  assert.equal(
    disposition("it's (1).txt"),
    `attachment; filename="it's (1).txt"; filename*=UTF-8''it%27s%20%281%29.txt`
  );
  for (const empty of ['', ' ... ', '\u202E', '\ud800']) {
    assert.equal(disposition(empty), `attachment; filename="download"; filename*=UTF-8''download`);
  }
  assert.ok(/filename="(a{120})"/.test(disposition('a'.repeat(500))));
  // Whatever the name, the header is a valid byte string.
  for (const name of ['한글 파일.zip', '😀.png', 'a\ud83dz', '\u0000\u007f\u0085']) {
    assert.doesNotThrow(() => new Headers({ 'Content-Disposition': disposition(name) }), name);
  }
});

test('download routes are matched only with their full contract, and leases never inline', async () => {
  const { worker } = await setup();
  const query = `sid=${SID}&enc=e2ee1&v=${VERSION}&size=10&name=a.txt`;
  const at = (path) => new URL(`${ORIGIN}${path}`);
  const navigate = { method: 'GET', mode: 'navigate', destination: 'document' };
  const route = worker.match(navigate, at(`/__mixdog-download__/${LEASE_ID}?${query}`));
  assert.deepEqual(
    { ...route, download: { ...route.download } },
    {
      assetId: LEASE_ID,
      variant: 'download',
      sid: SID,
      download: { size: 10, version: VERSION, name: 'a.txt', token: '' },
    }
  );
  assert.ok(
    worker.match({ ...navigate, mode: 'cors', destination: '' }, at(`/__mixdog-download__/${LEASE_ID}?${query}`))
  );
  for (const path of [
    `/__mixdog-download__/${LEASE_ID}?${query.replace('enc=e2ee1', 'enc=e2ee0')}`,
    `/__mixdog-download__/${LEASE_ID}?${query.replace(`v=${VERSION}`, 'v=short')}`,
    `/__mixdog-download__/${LEASE_ID}?${query.replace('size=10', `size=${256 * 1024 * 1024 + 1}`)}`,
    `/__mixdog-download__/${LEASE_ID}?${query.replace('size=10', 'size=-1')}`,
    `/__mixdog-download__/not-a-uuid?${query}`,
  ]) {
    assert.equal(worker.match(navigate, at(path)), null, path);
  }
  assert.equal(worker.match({ ...navigate, method: 'POST' }, at(`/__mixdog-download__/${LEASE_ID}?${query}`)), null);
  // The element route never serves a download lease inline.
  const element = { method: 'GET', mode: 'no-cors', destination: 'image' };
  assert.equal(worker.match(element, at(`/media/${LEASE_ID}?variant=download&sid=${SID}&enc=e2ee1`)), null);
});
