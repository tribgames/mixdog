// The REAL host lane (main/remote-relay-media.ts) feeds the REAL worker script
// (public/sw-media.js, evaluated in a VM like a worker) through a fake relay
// that forwards bytes untouched. Whatever the worker returns to an element is
// what a <video>/<img> would receive.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { leaseMediaFile } from '../main/media-leases.ts';
import { MEDIA_WINDOW_MAX_BYTES, createRelayMediaLane } from '../main/remote-relay-media.ts';

const source = readFileSync(new URL('./public/sw-media.js', import.meta.url), 'utf8');
const ORIGIN = 'https://relay.mixdog.test';
const SID = 'W'.repeat(43);
const dir = mkdtempSync(join(tmpdir(), 'sw-media-'));

function lease(name, size, mime = 'video/mp4') {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 131 + (index >> 10)) & 0xff;
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { bytes, assetId: leaseMediaFile(path, mime) };
}

async function setup({ mutate, redirect } = {}) {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const upstream = [];
  // Relay stand-in: asks the host, then hands the body over in odd-sized pieces.
  // `redirect` lets a test play a hostile relay that asks for something else.
  const fetchThroughRelay = async (url, init) => {
    const parsed = new URL(url);
    const requestedAsset = /\/media\/([^/?]+)/.exec(parsed.pathname)[1];
    const [assetId, range = init.headers.Range] = redirect
      ? redirect(requestedAsset, init.headers.Range)
      : [requestedAsset];
    upstream.push(init.headers.Range);
    const sent = [];
    const lane = createRelayMediaLane({
      host: { invokeCapability: async () => null },
      sendEnvelope: (envelope) => sent.push(envelope),
      socketBacklog: () => 0,
      mediaKey: (sid) => (sid === SID ? key : null),
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
          for (let at = 0; at < body.length; at += 7001) controller.enqueue(new Uint8Array(body.subarray(at, at + 7001)));
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
  return { get, upstream, worker, key };
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
  assert.equal((await get(svg.assetId, { destination: 'video' })).headers.get('content-type'), 'application/octet-stream');
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
