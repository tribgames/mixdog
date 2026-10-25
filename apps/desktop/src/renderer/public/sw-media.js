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
// File downloads (shared/file-downloads.ts) use the same lane: the page opens
// a worker-only `/__mixdog-download__/<lease asset id>` URL (built by
// remote-media-lane.ts fileDownloadLaneUrl) and this worker streams the
// lease's `download` variant back as a decrypted attachment, window by window,
// holding one segment at a time. The relay never serves that path, so a
// navigation this worker did not take cannot hand ciphertext to the
// browser's downloader.
//
// Loaded by sw.js through importScripts('/sw-media.js'); everything is behind
// the one global below so it cannot collide with sibling scripts.
// biome-ignore lint/correctness/noUnusedVariables: read by sw.js and sw-media.slow.test.mjs as a worker global.
const mixdogMediaLane = (() => {
  const ROUTE = /^\/media\/([0-9a-fA-F-]{8,64})$/;
  const DOWNLOAD_ROUTE = /^\/__mixdog-download__\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  const DOWNLOAD_VARIANT = 'download';
  const DOWNLOAD_VERSION = /^[A-Za-z0-9_-]{43}$/;
  const DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;
  const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
  const CONTEXT = 'mixdog-relay-media-v1';
  const SCHEME = 'e2ee1';
  const SEGMENT_BYTES = 64 * 1024;
  const WINDOW_BYTES = 1024 * 1024;
  // The host's download window (remote-relay-media.ts DOWNLOAD_WINDOW_MAX_BYTES).
  const DOWNLOAD_WINDOW_BYTES = 8 * 1024 * 1024;
  const MAX_FILE_NAME_CHARS = 120;
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

  /** `{ assetId, variant, sid }` for a request this lane answers, else null.
   *  A download route also carries `download: { size, version, name, token }`. */
  function match(request, url) {
    if (request.method !== 'GET') return null;
    const download = DOWNLOAD_ROUTE.exec(url.pathname);
    // Downloads are navigations (anchor clicks) or a page's resume fetch.
    if (download) return matchDownload(download[1], url.searchParams);
    if (request.mode === 'navigate') return null;
    if (!ELEMENT_DESTINATIONS.has(request.destination)) return null;
    const route = ROUTE.exec(url.pathname);
    const sid = url.searchParams.get('sid') || '';
    const variant = url.searchParams.get('variant') || 'original';
    // Without the opt-in the request is not ours: it passes to the network.
    if (!route || !SESSION_ID.test(sid) || url.searchParams.get('enc') !== SCHEME) return null;
    // A download lease is only ever served as an attachment.
    if (variant === DOWNLOAD_VARIANT) return null;
    return { assetId: route[1], variant, sid };
  }

  function matchDownload(assetId, params) {
    const sid = params.get('sid') || '';
    const version = params.get('v') || '';
    const size = /^\d{1,10}$/.test(params.get('size') || '') ? Number(params.get('size')) : -1;
    if (!SESSION_ID.test(sid) || params.get('enc') !== SCHEME || !DOWNLOAD_VERSION.test(version)) return null;
    if (size < 0 || size > DOWNLOAD_MAX_BYTES) return null;
    return {
      assetId,
      variant: DOWNLOAD_VARIANT,
      sid,
      download: { size, version, name: params.get('name') || '', token: params.get('token') || '' },
    };
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
      (meta.version !== undefined && typeof meta.version !== 'string') ||
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
   * host or relay refused (412 when the window is not of the expected file),
   * else `{ meta, next(), cancel() }` where next() yields decrypted segments
   * `{ offset, bytes }` and then null.
   */
  async function openWindow(lane, start, last) {
    const aligned = Math.floor(start / SEGMENT_BYTES) * SEGMENT_BYTES;
    const wanted = Math.min(last, aligned + lane.window - 1);
    // An empty file has no byte to ask for: its whole-file answer is the meta.
    const headers = wanted >= aligned ? { Range: `bytes=${aligned}-${wanted}` } : {};
    const response = await fetch(lane.upstream, {
      headers,
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
      // A download continues one leased file version; anything else is a
      // different file, never bytes spliced into this one.
      if (lane.expect && (meta.size !== lane.expect.size || meta.version !== lane.expect.version)) {
        cancel();
        return { status: 412 };
      }
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

  /** `attachment` with the name as an ASCII fallback and RFC 5987 UTF-8. The
   *  name is the host's (already a bare file name), cleaned again here: no
   *  path separators, controls, bidi/invisible marks, lone surrogates,
   *  reserved Windows names or leading/trailing dots and spaces. */
  function attachmentDisposition(name) {
    let clean = '';
    let count = 0;
    for (const char of String(name || '').normalize('NFC')) {
      if (count >= MAX_FILE_NAME_CHARS) break;
      const code = char.codePointAt(0);
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
      if ((code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e)) continue;
      if ((code >= 0x2066 && code <= 0x2069) || code === 0xfeff) continue;
      if (code >= 0xd800 && code <= 0xdfff) continue;
      clean += /[\\/:*?"<>|]/.test(char) ? '_' : char;
      count += 1;
    }
    clean = clean.replace(/^[\s.]+|[\s.]+$/g, '');
    if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i.test(clean)) clean = `_${clean}`;
    if (!clean) clean = 'download';
    const ascii = clean.replace(/[^\x20-\x7e]|[%;\\]/g, '_');
    const encoded = encodeURIComponent(clean).replace(
      /['()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
  }

  /** The decrypted body for plaintext `start..end` (inclusive), pulled one
   *  segment at a time: nothing is fetched or held ahead of the reader beyond
   *  the open window's in-flight bytes. `first` is the already open window. */
  function windowStream(lane, controller, first, start, end) {
    let current = first;
    let position = start;
    return new ReadableStream({
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
  }

  /** A download lease as an attachment. Range resumes from a byte offset;
   *  `If-Range` must name the transfer's version (its ETag) or the whole file
   *  is sent. Every window must be of exactly that size and version. */
  async function answerDownload(request, route) {
    const { size, version, name, token } = route.download;
    const etag = `"${version}"`;
    const key = await keyFor(route.sid);
    if (!key) return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const controller = new AbortController();
    const query = new URLSearchParams({ variant: DOWNLOAD_VARIANT, sid: route.sid, enc: SCHEME });
    if (token) query.set('token', token);
    const lane = {
      upstream: `${new URL(request.url).origin}/media/${route.assetId}?${query.toString()}`,
      key,
      asset: { assetId: route.assetId, variant: DOWNLOAD_VARIANT },
      signal: controller.signal,
      window: DOWNLOAD_WINDOW_BYTES,
      expect: { size, version },
    };
    const unsatisfiable = () =>
      new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
    try {
      let range = parseRange(request.headers.get('range'));
      if (range?.invalid) return unsatisfiable();
      const ifRange = request.headers.get('if-range');
      if (range && ifRange && ifRange.trim() !== etag) range = null;
      let start = 0;
      let end = size - 1;
      if (range) {
        if (range.start === null) start = Math.max(0, size - range.end);
        else {
          start = range.start;
          if (range.end !== null) end = Math.min(range.end, size - 1);
        }
        if (start > end) return unsatisfiable();
      }
      const first = await openWindow(lane, start, end);
      if (!first.meta) {
        return new Response(null, { status: first.status, headers: { 'Cache-Control': 'no-store' } });
      }
      const headers = new Headers({
        'Content-Type': responseType(first.meta.mime, 'document'),
        'Content-Disposition': attachmentDisposition(name),
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      });
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      return new Response(windowStream(lane, controller, first, start, end), {
        status: range ? 206 : 200,
        headers,
      });
    } catch {
      controller.abort();
      return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  async function answer(request, route) {
    if (route.download) return answerDownload(request, route);
    const key = await keyFor(route.sid);
    if (!key) return new Response(null, { status: 503 });
    const controller = new AbortController();
    const lane = {
      upstream: request.url,
      key,
      asset: { assetId: route.assetId, variant: route.variant },
      signal: controller.signal,
      window: WINDOW_BYTES,
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
      const first = await openWindow(
        lane,
        start,
        range && range.start !== null && range.end !== null ? range.end : Infinity
      );
      if (!first.meta) return new Response(null, { status: first.status });
      const { size, mime } = first.meta;
      const end = range && range.start !== null && range.end !== null ? Math.min(range.end, size - 1) : size - 1;
      if (range && (start > end || size === 0)) {
        first.cancel();
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      const body = windowStream(lane, controller, first, start, end);
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

  return {
    match,
    answer,
    acceptKey,
    parseRange,
    attachmentDisposition,
    KEY_MESSAGE,
    KEY_REVOKE_MESSAGE,
    KEY_REQUEST_MESSAGE,
  };
})();
