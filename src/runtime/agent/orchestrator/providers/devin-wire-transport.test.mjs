import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { decodeDevinMessage, encodeDevinMessage } from './devin-wire-protobuf.mjs';
import {
  DEVIN_MAX_FRAME_BYTES,
  DevinWireError,
  devinStream,
  devinUnary,
  encodeDevinFrame,
} from './devin-wire-transport.mjs';

const BASE = 'https://devin.test';
const CHAT_PATH = '/exa.api_server_pb.ApiServerService/GetChatMessage';
const enc = new TextEncoder();

// Hand-built envelope: flags byte, 4-byte big-endian length, payload.
function frame(payload, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return new Uint8Array(Buffer.concat([header, Buffer.from(payload)]));
}

const delta = (text) => encodeDevinMessage('GetChatMessageResponse', { deltaText: text });
const trailer = (body = {}, flags = 2) => frame(enc.encode(JSON.stringify(body)), flags);

function streamResponse(chunks, init = {}) {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!chunks.length) return controller.close();
      controller.enqueue(chunks.shift());
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { status: 200, ...init });
  return { response, wasCancelled: () => cancelled };
}

function streamCall(fetchFn, extra = {}) {
  return devinStream({
    baseUrl: BASE,
    path: CHAT_PATH,
    requestType: 'GetChatMessageRequest',
    responseType: 'GetChatMessageResponse',
    message: { chatModelUid: 'm' },
    fetchFn,
    ...extra,
  });
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function rejectsWith(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DevinWireError, `expected DevinWireError, got ${error?.stack || error}`);
    for (const [key, value] of Object.entries(expected)) {
      if (value instanceof RegExp) assert.match(String(error[key]), value, key);
      else assert.equal(error[key], value, key);
    }
    return true;
  });
}

test('stream request is one gzip-compressed Connect frame with Connect headers', async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return streamResponse([trailer()]).response;
  };
  await collect(streamCall(fetchFn, { headers: { 'x-extra': '1' } }));
  assert.equal(seen.url, `${BASE}${CHAT_PATH}`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['content-type'], 'application/connect+proto');
  assert.equal(seen.init.headers['connect-protocol-version'], '1');
  assert.equal(seen.init.headers['connect-content-encoding'], 'gzip');
  assert.equal(seen.init.headers['connect-accept-encoding'], 'gzip');
  assert.equal(seen.init.headers['x-extra'], '1');
  const body = Buffer.from(seen.init.body);
  assert.equal(body[0], 0x01);
  assert.equal(body.readUInt32BE(1), body.length - 5);
  // 21 (aa01):"m"
  assert.equal(gunzipSync(body.subarray(5)).toString('hex'), 'aa01016d');
});

test('frames decode identically whether coalesced or split byte by byte', async () => {
  const wire = Buffer.concat([
    frame(delta('a')),
    frame(gzipSync(delta('b')), 0x01),
    frame(gzipSync(enc.encode('{}')), 0x03),
  ]);
  const coalesced = await collect(streamCall(async () => streamResponse([new Uint8Array(wire)]).response));
  const split = await collect(
    streamCall(async () => streamResponse([...wire].map((byte) => Uint8Array.of(byte))).response)
  );
  assert.deepEqual(
    coalesced.map((msg) => msg.deltaText),
    ['a', 'b']
  );
  assert.deepEqual(split, coalesced);
});

test('end-of-stream trailer errors map to codes, including compressed trailers', async () => {
  const cases = [
    [
      { code: 'unauthenticated', message: 'bad token' },
      { code: 'unauthenticated', status: 401, retryable: false },
    ],
    [
      { code: 'permission_denied', message: 'no seat' },
      { code: 'permission', status: 403, retryable: false },
    ],
    [
      { code: 'resource_exhausted', message: 'rate limit exceeded' },
      { code: 'resource_exhausted', retryable: true },
    ],
    [
      { code: 'resource_exhausted', message: 'request payload is too large' },
      { code: 'request_too_large', status: 413, retryable: false },
    ],
    [
      { code: 'invalid_argument', message: 'Error', details: [{ type: 'google.rpc.DebugInfo', debug: { d: 'x' } }] },
      { code: 'invalid_argument', status: 400, message: /\[details: google\.rpc\.DebugInfo: \{"d":"x"\}\]/ },
    ],
    [
      { code: 'unavailable', message: 'try later' },
      { code: 'unavailable', retryable: true },
    ],
    [{ code: 'canceled', message: '' }, { code: 'aborted' }],
  ];
  for (const [error, expected] of cases) {
    await rejectsWith(
      collect(streamCall(async () => streamResponse([frame(delta('x')), trailer({ error })]).response)),
      {
        connectCode: error.code,
        ...expected,
      }
    );
  }
  const compressed = frame(
    gzipSync(enc.encode(JSON.stringify({ error: { code: 'unauthenticated', message: 'm' } }))),
    3
  );
  await rejectsWith(collect(streamCall(async () => streamResponse([compressed]).response)), {
    code: 'unauthenticated',
  });
});

test('trailer retry-after metadata is carried as retryAfterMs', async () => {
  const body = { error: { code: 'resource_exhausted', message: 'slow down' }, metadata: { 'retry-after': ['3'] } };
  await rejectsWith(collect(streamCall(async () => streamResponse([trailer(body)]).response)), {
    code: 'resource_exhausted',
    retryAfterMs: 3000,
  });
});

test('an advertised frame length over the cap fails on the header without buffering the payload', async () => {
  let pulled = 0;
  const header = Buffer.alloc(5);
  header.writeUInt32BE(DEVIN_MAX_FRAME_BYTES * 2, 1);
  let sentHeader = false;
  const body = new ReadableStream({
    pull(controller) {
      if (!sentHeader) {
        sentHeader = true;
        controller.enqueue(new Uint8Array(header));
        return;
      }
      pulled += 1024 * 1024;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
  });
  await rejectsWith(collect(streamCall(async () => new Response(body))), {
    code: 'protocol',
    message: new RegExp(`${DEVIN_MAX_FRAME_BYTES * 2}.*${DEVIN_MAX_FRAME_BYTES}`),
  });
  assert.ok(pulled <= 2 * 1024 * 1024, `pulled ${pulled} bytes`);
});

test('decompressed size is capped separately from the frame length', async () => {
  const bomb = frame(gzipSync(Buffer.alloc(64 * 1024)), 0x01);
  assert.ok(bomb.length < 1024);
  await rejectsWith(
    collect(streamCall(async () => streamResponse([bomb, trailer()]).response, { maxDecompressedBytes: 4096 })),
    { code: 'protocol', message: /decompressed payload exceeds 4096/ }
  );
});

test('truncated, malformed and unterminated streams are protocol errors', async () => {
  const good = frame(delta('a'));
  await rejectsWith(collect(streamCall(async () => streamResponse([good.subarray(0, good.length - 1)]).response)), {
    code: 'protocol',
    retryable: true,
    message: /ended inside a frame/,
  });
  // deltaText (field 3) sent as varint
  await rejectsWith(
    collect(streamCall(async () => streamResponse([frame(Uint8Array.of(0x18, 0x01)), trailer()]).response)),
    {
      code: 'protocol',
      retryable: false,
      message: /malformed GetChatMessageResponse/,
    }
  );
  await rejectsWith(collect(streamCall(async () => streamResponse([frame(Uint8Array.of(1, 2, 3), 0x01)]).response)), {
    code: 'protocol',
    message: /invalid gzip/,
  });
});

test('stream ends like the native client: lenient trailer, flags and termination', async () => {
  const texts = async (chunks) =>
    (await collect(streamCall(async () => streamResponse(chunks).response))).map((msg) => msg.deltaText);
  // Reserved flag bits are ignored.
  assert.deepEqual(await texts([frame(delta('a'), 0x04), trailer({}, 0x06)]), ['a']);
  // A trailer that is not JSON (or empty) carries no error.
  assert.deepEqual(await texts([frame(delta('a')), frame(enc.encode('{nope'), 0x02), frame(new Uint8Array(0), 0x02)]), [
    'a',
  ]);
  // Reading continues to the end of the body after an error-free trailer.
  assert.deepEqual(await texts([frame(delta('a')), trailer(), frame(delta('b'))]), ['a', 'b']);
});

test('a body that stops without an end-of-stream trailer is a retryable truncated stream', async () => {
  // Cut at a frame boundary or before any frame.
  for (const [chunks, expected] of [
    [[frame(delta('a'))], ['a']],
    [[], []],
  ]) {
    const seen = [];
    await rejectsWith(
      (async () => {
        for await (const msg of streamCall(async () => streamResponse(chunks).response)) seen.push(msg.deltaText);
      })(),
      { code: 'protocol', retryable: true, message: /without an end-of-stream trailer/ }
    );
    assert.deepEqual(seen, expected, 'frames before the cut are delivered, never completed');
  }
});

test('throttles Devin words under other codes are typed as throttles', async () => {
  const trailerError = (code, message) =>
    collect(streamCall(async () => streamResponse([trailer({ error: { code, message } })]).response));
  // A model at capacity is a throttle (the reference maps it to 429), not a permission failure.
  await rejectsWith(
    trailerError('permission_denied', 'The model is currently in high demand, please try again later (trace ID: 0)'),
    { code: 'resource_exhausted', status: 429, retryable: true, connectCode: 'permission_denied' }
  );
  // A spent quota is a throttle too; nothing says it is permanent or plan-wide.
  await assert.rejects(
    trailerError('failed_precondition', 'User monthly ACU quota exhausted (trace ID: 12345)'),
    (error) => {
      assert.equal(error.code, 'resource_exhausted');
      assert.equal(error.status, 429);
      assert.equal(error.retryable, true);
      assert.equal('quotaScope' in error, false);
      return true;
    }
  );
  // Other wording, including an account message cap, keeps the code's own mapping.
  await rejectsWith(trailerError('permission_denied', 'no seat'), { code: 'permission', status: 403 });
  await rejectsWith(
    trailerError('permission_denied', 'Reached overall message rate limit. Your limit will reset in 13 minutes.'),
    { code: 'permission', status: 403 }
  );
  await rejectsWith(trailerError('failed_precondition', 'Client version 3000.1.0 is no longer supported'), {
    code: 'invalid_argument',
    status: 400,
  });
  // An HTTP carrier status does not override the throttle it reports.
  await rejectsWith(
    collect(
      streamCall(
        async () =>
          new Response(JSON.stringify({ code: 'permission_denied', message: 'model in high demand' }), {
            status: 403,
          })
      )
    ),
    { code: 'resource_exhausted', status: 429, message: /HTTP 403/ }
  );
});

test('HTTP failures map Connect JSON bodies and statuses', async () => {
  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  await rejectsWith(collect(streamCall(async () => json(401, { code: 'unauthenticated', message: 'expired' }))), {
    code: 'unauthenticated',
    status: 401,
    message: /expired/,
  });
  await rejectsWith(
    collect(
      streamCall(async () => json(429, { code: 'resource_exhausted', message: 'quota' }, { 'retry-after': '2' }))
    ),
    {
      code: 'resource_exhausted',
      status: 429,
      retryable: true,
      retryAfterMs: 2000,
    }
  );
  await rejectsWith(collect(streamCall(async () => new Response('too big', { status: 413 }))), {
    code: 'request_too_large',
    status: 413,
  });
  await rejectsWith(collect(streamCall(async () => json(403, { code: 'permission_denied', message: 'no' }))), {
    code: 'permission',
  });
  const html = new Response('<html><body>Bad gateway</body></html>', {
    status: 503,
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(collect(streamCall(async () => html)), (error) => {
    assert.equal(error.code, 'unavailable');
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.message, /html/i);
    return true;
  });
  await rejectsWith(collect(streamCall(async () => json(400, { code: 'invalid_argument', message: 'bad' }))), {
    code: 'invalid_argument',
  });
});

test('network failures are retryable unavailable errors; aborts are aborted', async () => {
  await rejectsWith(
    collect(
      streamCall(async () => {
        throw new TypeError('fetch failed');
      })
    ),
    { code: 'unavailable', retryable: true }
  );

  const preAborted = new AbortController();
  preAborted.abort();
  let called = false;
  await rejectsWith(
    collect(
      streamCall(
        async () => {
          called = true;
        },
        { signal: preAborted.signal }
      )
    ),
    { code: 'aborted' }
  );
  assert.equal(called, false);

  const controller = new AbortController();
  const fetchFn = async (_url, init) => {
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(frame(delta('a')));
        init.signal.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(body);
  };
  const iterator = streamCall(fetchFn, { signal: controller.signal });
  const first = await iterator.next();
  assert.equal(first.value.deltaText, 'a');
  const pending = iterator.next();
  controller.abort();
  await rejectsWith(pending, { code: 'aborted', retryable: false });
});

test('stopping iteration early cancels the response body', async () => {
  const { response, wasCancelled } = streamResponse([frame(delta('a')), frame(delta('b')), trailer()]);
  for await (const message of streamCall(async () => response)) {
    assert.equal(message.deltaText, 'a');
    break;
  }
  assert.equal(wasCancelled(), true);
});

test('unary calls send bare protobuf and accept plain or gzip bodies', async () => {
  const reply = encodeDevinMessage('GetUserJwtResponse', { userJwt: 'jwt' });
  for (const body of [reply, gzipSync(reply)]) {
    let seen;
    const result = await devinUnary({
      baseUrl: `${BASE}/`,
      path: '/exa.auth_pb.AuthService/GetUserJwt',
      requestType: 'GetUserJwtRequest',
      responseType: 'GetUserJwtResponse',
      message: { metadata: { apiKey: 'k' } },
      fetchFn: async (url, init) => {
        seen = { url, init };
        return new Response(body);
      },
    });
    assert.deepEqual(result, { userJwt: 'jwt' });
    assert.equal(seen.url, `${BASE}/exa.auth_pb.AuthService/GetUserJwt`);
    assert.equal(seen.init.headers['content-type'], 'application/proto');
    // 1:{3:"k"}
    assert.equal(Buffer.from(seen.init.body).toString('hex'), '0a031a016b');
    assert.deepEqual(decodeDevinMessage('GetUserJwtRequest', seen.init.body), { metadata: { apiKey: 'k' } });
  }
  await rejectsWith(
    devinUnary({
      baseUrl: BASE,
      path: '/x/Y',
      requestType: 'GetUserJwtRequest',
      responseType: 'GetUserJwtResponse',
      fetchFn: async () => new Response(Uint8Array.of(0x0a, 0x09, 0x61)),
    }),
    { code: 'protocol' }
  );
});

test('every RPC refuses redirects without sending a second request', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/elsewhere` });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await rejectsWith(
      devinUnary({
        baseUrl,
        path: '/exa.auth_pb.AuthService/GetUserJwt',
        requestType: 'GetUserJwtRequest',
        responseType: 'GetUserJwtResponse',
        message: { metadata: { apiKey: 'devin-session-token$secret-token' } },
      }),
      { code: 'protocol', retryable: false, message: /redirect/ }
    );
    assert.equal(hits, 1);
    await rejectsWith(collect(streamCall(fetch, { baseUrl })), { code: 'protocol', message: /redirect/ });
    assert.equal(hits, 2);
  } finally {
    server.close();
  }

  // A fetch implementation that returns the redirect instead of rejecting it.
  let seen;
  await rejectsWith(
    collect(
      streamCall(async (_url, init) => {
        seen = init;
        return new Response(null, { status: 308, headers: { location: 'https://evil.example/' } });
      })
    ),
    { code: 'protocol', status: 308, message: /redirect/ }
  );
  assert.equal(seen.redirect, 'error');
});

test('server diagnostics never surface the credentials the request carried', async () => {
  const sessionToken = 'devin-session-token$SESSIONSECRET123';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl';
  const assignment = 'ASSIGNMENTSECRET456';
  const message = {
    metadata: { apiKey: sessionToken, userJwt: jwt },
    modelAssignmentJwt: assignment,
    chatModelUid: 'm',
  };
  const echo = `key ${sessionToken} bare SESSIONSECRET123 jwt ${jwt} assignment ${assignment} auth Bearer HEADERSECRET789 other Bearer UNKNOWNBEARER`;
  const secrets = ['SESSIONSECRET123', jwt, assignment, 'HEADERSECRET789', 'UNKNOWNBEARER'];
  const assertClean = (error) => {
    assert.ok(error instanceof DevinWireError);
    const surfaced = [error.message, error.detail, error.stack, error.connectCode, JSON.stringify(error)];
    if (error.cause) surfaced.push(String(error.cause), error.cause.stack);
    for (const text of surfaced) {
      for (const secret of secrets) assert.ok(!String(text ?? '').includes(secret), `${secret} leaked in ${text}`);
    }
    return true;
  };
  const call = (fetchFn) =>
    collect(streamCall(fetchFn, { message, headers: { authorization: 'Bearer HEADERSECRET789' } }));

  // Trailer message and details.
  const trailerBody = { error: { code: 'invalid_argument', message: echo, details: [{ type: 't', debug: { echo } }] } };
  await assert.rejects(
    call(async () => streamResponse([trailer(trailerBody)]).response),
    (error) => assertClean(error) && /\[redacted\]/.test(error.detail) && error.code === 'invalid_argument'
  );
  // Compressed trailer.
  const compressed = frame(gzipSync(enc.encode(JSON.stringify(trailerBody))), 3);
  await assert.rejects(
    call(async () => streamResponse([compressed]).response),
    assertClean
  );
  // HTTP error bodies: Connect JSON and plain text.
  await assert.rejects(
    call(async () => new Response(JSON.stringify({ code: 'permission_denied', message: echo }), { status: 403 })),
    (error) => assertClean(error) && error.code === 'permission'
  );
  await assert.rejects(
    call(async () => new Response(echo, { status: 500 })),
    assertClean
  );
  // A server-chosen code outside the Connect vocabulary is not echoed.
  await assert.rejects(
    call(async () => streamResponse([trailer({ error: { code: sessionToken, message: 'x' } })]).response),
    (error) => assertClean(error) && error.connectCode === 'unknown'
  );
  // A transport failure message echoing the token.
  await assert.rejects(
    call(async () => {
      throw new TypeError(`socket closed while sending ${sessionToken}`);
    }),
    (error) => assertClean(error) && error.code === 'unavailable'
  );
});

test('encodeDevinFrame writes the envelope header', () => {
  assert.equal(Buffer.from(encodeDevinFrame(Uint8Array.of(0xaa, 0xbb), 1)).toString('hex'), '0100000002aabb');
});
