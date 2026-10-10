// Encrypted media lane, service worker half. The relay serves `/media/<asset>`
// as AES-GCM frames it cannot read (shared/remote-media-crypto.ts is the host
// half and defines the format). An <img>/<video>/<audio> cannot decrypt, so
// this worker answers those requests itself: it fetches segment-aligned
// encrypted windows with Range, decrypts them with the session's media key and
// replies with ordinary 200/206 responses the element can stream and seek.
//
// The key is a non-extractable CryptoKey the page derived during the E2EE
// handshake and posts here (structured clone). It lives in this worker's memory
// only and is never part of any request: the request carries the public `sid`
// label. A worker the browser stopped asks the open windows for the key again.
//
// Loaded by sw.js through importScripts('/sw-media.js'); everything is behind
// the one global below so it cannot collide with sibling scripts.
// biome-ignore lint/correctness/noUnusedVariables: read by sw.js and sw-media.test.mjs as a worker global.
const mixdogMediaLane = (() => {
  const ROUTE = /^\/media\/([0-9a-fA-F-]{8,64})$/;
  const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
  const CONTEXT = 'mixdog-relay-media-v1';
  const SCHEME = 'e2ee1';
  const SEGMENT_BYTES = 64 * 1024;
  const WINDOW_BYTES = 1024 * 1024;
  const NONCE_BYTES = 12;
  const TAG_BYTES = 16;
  const MAX_META_BYTES = 4096;
  const KEY_WAIT_MS = 3000;
  const MAX_KEYS = 8;
  const KEY_MESSAGE = 'mixdog:media-key';
  const KEY_REVOKE_MESSAGE = 'mixdog:media-key-revoke';
  const KEY_REQUEST_MESSAGE = 'mixdog:media-key-request';
  // Documents the relay origin would execute; as image/video/audio bytes they
  // are data, but nothing else may be handed out under these types.
  const ACTIVE_TYPE =
    /^(?:text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/ecmascript)/;
  const ELEMENT_DESTINATIONS = new Set(['', 'image', 'video', 'audio']);
  const encoder = new TextEncoder();
  const keys = new Map();
  const waiters = new Map();

  /** `{ assetId, variant, sid }` for a request this lane answers, else null. */
  function match(request, url) {
    if (request.method !== 'GET' || request.mode === 'navigate') return null;
    if (!ELEMENT_DESTINATIONS.has(request.destination)) return null;
    const route = ROUTE.exec(url.pathname);
    const sid = url.searchParams.get('sid') || '';
    // Without the opt-in the request is not ours: it passes to the network.
    if (!route || !SESSION_ID.test(sid) || url.searchParams.get('enc') !== SCHEME) return null;
    return { assetId: route[1], variant: url.searchParams.get('variant') || 'original', sid };
  }

  function acceptKey(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === KEY_REVOKE_MESSAGE && SESSION_ID.test(String(data.sid))) {
      keys.delete(data.sid);
      return;
    }
    if (data.type !== KEY_MESSAGE || !SESSION_ID.test(String(data.sid))) return;
    if (!data.key || typeof data.key !== 'object' || data.key.type !== 'secret') return;
    keys.delete(data.sid);
    keys.set(data.sid, data.key);
    while (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value);
    waiters.get(data.sid)?.settle(data.key);
  }

  function keyFor(sid) {
    const held = keys.get(sid);
    if (held) return Promise.resolve(held);
    let waiter = waiters.get(sid);
    if (!waiter) {
      waiter = {};
      waiter.promise = new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(sid);
          resolve(null);
        }, KEY_WAIT_MS);
        waiter.settle = (key) => {
          clearTimeout(timer);
          waiters.delete(sid);
          resolve(key);
        };
      });
      waiters.set(sid, waiter);
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((windows) => {
          for (const client of windows) client.postMessage({ type: KEY_REQUEST_MESSAGE, sid });
        })
        .catch(() => undefined);
    }
    return waiter.promise;
  }

  function metaAad(asset, start) {
    return encoder.encode(`${CONTEXT}\0meta\0${asset.assetId}\0${asset.variant}\0${start}`);
  }

  function dataAad(asset, offset, size) {
    return encoder.encode(`${CONTEXT}\0data\0${asset.assetId}\0${asset.variant}\0${offset}\0${size}`);
  }

  async function openFrame(key, body, additionalData) {
    if (body.byteLength < NONCE_BYTES + TAG_BYTES) throw new Error('Truncated media frame.');
    return new Uint8Array(
      await self.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: body.subarray(0, NONCE_BYTES), additionalData },
        key,
        body.subarray(NONCE_BYTES)
      )
    );
  }

  async function decryptMeta(key, asset, expectedStart, body) {
    const meta = JSON.parse(new TextDecoder().decode(await openFrame(key, body, metaAad(asset, expectedStart))));
    if (
      !Number.isSafeInteger(meta.size) ||
      !Number.isSafeInteger(meta.start) ||
      !Number.isSafeInteger(meta.end) ||
      typeof meta.mime !== 'string' ||
      meta.start !== expectedStart ||
      meta.end < meta.start - 1 ||
      meta.end >= meta.size
    ) {
      throw new Error('Invalid media window.');
    }
    return meta;
  }

  /** Re-frames the byte stream: u32be length, then nonce + ciphertext. */
  function frameReader() {
    let pending = new Uint8Array(0);
    const maxBody = Math.max(SEGMENT_BYTES, MAX_META_BYTES) + NONCE_BYTES + TAG_BYTES;
    return (chunk) => {
      const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
      joined.set(pending, 0);
      joined.set(chunk, pending.byteLength);
      const bodies = [];
      let at = 0;
      while (joined.byteLength - at >= 4) {
        const length = new DataView(joined.buffer, joined.byteOffset + at, 4).getUint32(0, false);
        if (length < NONCE_BYTES + TAG_BYTES || length > maxBody) throw new Error('Invalid media frame length.');
        if (joined.byteLength - at - 4 < length) break;
        bodies.push(joined.slice(at + 4, at + 4 + length));
        at += 4 + length;
      }
      pending = joined.slice(at);
      return bodies;
    };
  }

  /**
   * One encrypted window starting at the segment containing `start`, no
   * further than `last` (inclusive, plaintext). Resolves `{ status }` when the
   * host or relay refused, else `{ meta, next(), cancel() }` where next()
   * yields decrypted segments `{ offset, bytes }` and then null.
   */
  async function openWindow(lane, start, last) {
    const aligned = Math.floor(start / SEGMENT_BYTES) * SEGMENT_BYTES;
    const wanted = Math.min(last, aligned + WINDOW_BYTES - 1);
    const response = await fetch(lane.upstream, {
      headers: { Range: `bytes=${aligned}-${wanted}` },
      cache: 'no-store',
      credentials: 'same-origin',
      signal: lane.signal,
    });
    if (!response.ok || !response.body) return { status: response.status || 502 };
    const reader = response.body.getReader();
    const split = frameReader();
    const queue = [];
    const nextBody = async () => {
      while (!queue.length) {
        const { done, value } = await reader.read();
        if (done) return null;
        queue.push(...split(value));
      }
      return queue.shift();
    };
    const cancel = () => {
      reader.cancel().catch(() => undefined);
    };
    try {
      const metaBody = await nextBody();
      if (!metaBody) throw new Error('Missing media window.');
      const meta = await decryptMeta(lane.key, lane.asset, aligned, metaBody);
      let offset = meta.start;
      return {
        meta,
        cancel,
        async next() {
          if (offset > meta.end) return null;
          const body = await nextBody();
          if (!body) throw new Error('Truncated media window.');
          const bytes = await openFrame(lane.key, body, dataAad(lane.asset, offset, meta.size));
          if (bytes.byteLength !== Math.min(SEGMENT_BYTES, meta.end - offset + 1)) {
            throw new Error('Unexpected media segment length.');
          }
          const segment = { offset, bytes };
          offset += bytes.byteLength;
          return segment;
        },
      };
    } catch (error) {
      cancel();
      throw error;
    }
  }

  /** null: no Range. `{ invalid }`: unusable. Else `{ start, end }` where a
   *  suffix range has `start: null` and `end` holding the length. */
  function parseRange(header) {
    const raw = String(header || '').trim();
    if (!raw) return null;
    const found = /^bytes=(\d*)-(\d*)$/.exec(raw);
    if (!found || (!found[1] && !found[2])) return { invalid: true };
    if (!found[1]) return { start: null, end: Number(found[2]) };
    return { start: Number(found[1]), end: found[2] ? Number(found[2]) : null };
  }

  function responseType(mime, destination) {
    const base = String(mime).split(';')[0].trim().toLowerCase();
    if (!base || !/^[\x20-\x7e]{1,200}$/.test(String(mime))) return 'application/octet-stream';
    // An SVG is inert as an <img> (no scripts run); anywhere else it is a document.
    if (ACTIVE_TYPE.test(base) && !(destination === 'image' && base.startsWith('image/svg'))) {
      return 'application/octet-stream';
    }
    return mime;
  }

  async function answer(request, route) {
    const key = await keyFor(route.sid);
    if (!key) return new Response(null, { status: 503 });
    const controller = new AbortController();
    const lane = {
      upstream: request.url,
      key,
      asset: { assetId: route.assetId, variant: route.variant },
      signal: controller.signal,
    };
    try {
      const range = parseRange(request.headers.get('range'));
      if (range?.invalid) return new Response(null, { status: 416 });
      let start = range && range.start !== null ? range.start : 0;
      if (range && range.start === null) {
        // Suffix range: the size is only known from the host.
        const probe = await openWindow(lane, 0, 0);
        if (!probe.meta) return new Response(null, { status: probe.status });
        probe.cancel();
        start = Math.max(0, probe.meta.size - range.end);
      }
      const first = await openWindow(lane, start, range && range.start !== null && range.end !== null ? range.end : Infinity);
      if (!first.meta) return new Response(null, { status: first.status });
      const { size, mime } = first.meta;
      const end = range && range.start !== null && range.end !== null ? Math.min(range.end, size - 1) : size - 1;
      if (range && (start > end || size === 0)) {
        first.cancel();
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      let current = first;
      let position = start;
      const body = new ReadableStream({
        async pull(stream) {
          try {
            for (;;) {
              if (position > end) {
                current?.cancel();
                stream.close();
                return;
              }
              if (!current) {
                current = await openWindow(lane, position, end);
                if (!current.meta) throw new Error('Media window refused.');
              }
              const segment = await current.next();
              if (!segment) {
                // A window that carried nothing new would loop forever.
                if (current.progressed !== true) throw new Error('Empty media window.');
                current = null;
                continue;
              }
              current.progressed = true;
              const segmentEnd = segment.offset + segment.bytes.byteLength;
              if (segmentEnd <= position) continue;
              const to = Math.min(segment.bytes.byteLength, end - segment.offset + 1);
              stream.enqueue(segment.bytes.subarray(position - segment.offset, to));
              position = segment.offset + to;
              return;
            }
          } catch (error) {
            controller.abort();
            stream.error(error);
          }
        },
        cancel() {
          controller.abort();
          current?.cancel();
        },
      });
      const headers = new Headers({
        'Content-Type': responseType(mime, request.destination),
        'Accept-Ranges': 'bytes',
        'Content-Length': String(Math.max(0, end - start + 1)),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch {
      controller.abort();
      return new Response(null, { status: 502 });
    }
  }

  return { match, answer, acceptKey, parseRange, KEY_MESSAGE, KEY_REVOKE_MESSAGE, KEY_REQUEST_MESSAGE };
})();
