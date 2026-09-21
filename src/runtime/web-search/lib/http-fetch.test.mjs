import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { fetchDocument, fetchPinnedForPausedRequest, MAX_BODY_BYTES, parseRetryAfter } from './http-fetch.mjs';
import { assertPublicUrl, resolveAndValidate } from './ssrf-guard.mjs';

test('public URL guard keeps exact protocol errors and rejects credentials and private hosts', () => {
  for (const [url, protocol] of [
    ['file:///secret', 'file:'],
    ['ftp://example.com/file', 'ftp:'],
    ['data:text/plain,secret', 'data:'],
    ['javascript:alert(1)', 'javascript:'],
    ['ws://example.com/socket', 'ws:'],
    ['wss://example.com/socket', 'wss:'],
    ['custom://example.com/path', 'custom:'],
  ]) {
    assert.throws(() => assertPublicUrl(url), { message: `Blocked non-HTTP protocol: ${protocol}` });
  }
  for (const url of ['http://example.com', 'https://example.com', 'HTTPS://example.com']) {
    assert.equal(assertPublicUrl(url), undefined);
  }
  assert.throws(() => assertPublicUrl('https://user:secret@example.com'), {
    message: 'Blocked URL with userinfo credentials: example.com',
  });
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.throws(() => assertPublicUrl(`https://${host}`), {
      message: `Blocked request to private address: ${host}`,
    });
  }
  assert.throws(() => assertPublicUrl('https://[::ffff:127.0.0.1]'), {
    message: 'Blocked request to private address: 127.0.0.1',
  });
});

test('the IPv6 address rules reject only IPv6 literals, never hostnames that start like one', () => {
  for (const host of ['ffmpeg.org', 'fdroid.org', 'fe80.example.com', 'fc-barcelona.example.com']) {
    assert.equal(assertPublicUrl(`https://${host}`), undefined);
  }
  for (const host of [
    '[::1]',
    '[fe80::1]',
    '[fc00::1]',
    '[fd00::1]',
    '[ff02::1]',
    '[::ffff:10.0.0.1]',
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    'localhost',
  ]) {
    assert.throws(() => assertPublicUrl(`https://${host}`), /^Error: Blocked request to private address: /);
  }
});

test('public cross-host redirects preserve final URL and format without forwarding cookies', async () => {
  const calls = [];
  const document = await fetchDocument('https://example.com/start', 5000, undefined, {
    request: async (url, options) => {
      calls.push({ url, headers: options.headers });
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: { location: '/next', 'set-cookie': 'session=private; Secure; Path=/' },
        });
      if (calls.length === 2)
        return new Response(null, { status: 301, headers: { location: 'https://example.org/doc.md' } });
      return new Response('# Document\n<main>literal</main>', { headers: { 'content-type': 'text/plain' } });
    },
  });
  assert.equal(document.url, 'https://example.org/doc.md');
  assert.equal(document.redirects.length, 2);
  assert.equal(calls[1].headers.Cookie, 'session=private');
  assert.equal(calls[2].headers.Cookie, undefined);
  assert.equal(document.body, '# Document\n<main>literal</main>');
});

test('redirect policy rejects private, credentialed and non-HTTP targets before requesting them', async () => {
  for (const location of [
    'http://127.0.0.1/',
    'http://169.254.169.254/',
    'http://[::ffff:7f00:1]/',
    'https://user:secret@example.org/',
    'file:///secret',
  ]) {
    let count = 0;
    await assert.rejects(
      fetchDocument('https://example.com', 1000, undefined, {
        request: async () => {
          count++;
          return new Response(null, { status: 302, headers: { location } });
        },
      }),
      /Blocked/
    );
    assert.equal(count, 1);
  }
});

test('redirect loops and oversized or binary responses fail with bounded reads', async () => {
  let count = 0;
  await assert.rejects(
    fetchDocument('https://example.com', 1000, undefined, {
      request: async () => {
        count++;
        return new Response(null, { status: 302, headers: { location: '/again' } });
      },
    }),
    /Too many redirects/
  );
  assert.equal(count, 6);
  for (const headers of [
    { 'content-type': 'application/octet-stream' },
    { 'content-type': 'text/plain', 'content-length': String(MAX_BODY_BYTES + 1) },
  ])
    await assert.rejects(
      fetchDocument('https://example.com', 1000, undefined, { request: async () => new Response('data', { headers }) }),
      /Blocked non-text|too large/
    );
  await assert.rejects(
    fetchDocument('https://example.com', 1000, undefined, {
      request: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_BODY_BYTES));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/plain' } }
        ),
    }),
    /too large/
  );
});

test('HTTP retry metadata and charset survive transport handling', async () => {
  await assert.rejects(
    fetchDocument('https://example.com', 1000, undefined, {
      request: async () => new Response(null, { status: 429, headers: { 'retry-after': '12' } }),
    }),
    (error) => error.status === 429 && error.retryAfterMs === 12000
  );
  assert.equal(parseRetryAfter('Wed, 01 Jan 2025 00:00:05 GMT', Date.parse('2025-01-01T00:00:00Z')), 5000);
  assert.equal(parseRetryAfter('nonsense'), 0);
  const document = await fetchDocument('https://example.com', 1000, undefined, {
    request: async () =>
      new Response(new Uint8Array([99, 97, 102, 233]), {
        headers: { 'content-type': 'text/plain; charset="windows-1252"' },
      }),
  });
  assert.equal(document.body, 'café');
});

test('Chromium receives redirect and separate cookies instead of final HTML at the old URL', async () => {
  let calls = 0;
  const result = await fetchPinnedForPausedRequest('https://example.com', {
    request: async () => {
      calls++;
      const headers = new Headers({ location: 'https://example.org/next' });
      headers.append('set-cookie', 'a=one; Path=/');
      headers.append('set-cookie', 'b=two; Path=/');
      return new Response(null, { status: 302, headers });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 302);
  assert.equal(result.responseHeaders.find((header) => header.name === 'location').value, 'https://example.org/next');
  assert.deepEqual(
    result.responseHeaders.filter((header) => header.name === 'set-cookie').map((header) => header.value),
    ['a=one; Path=/', 'b=two; Path=/']
  );
  await assert.rejects(
    fetchPinnedForPausedRequest('https://example.com', {
      request: async () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1' } }),
    }),
    /private/
  );
});

test('DNS validation rejects private addresses mixed with public records', async (t) => {
  t.mock.method(dns.promises, 'lookup', async () => [{ address: '93.184.216.34', family: 4 }]);
  t.mock.method(dns.promises, 'resolve4', async () => ['93.184.216.34', '10.0.0.1']);
  t.mock.method(dns.promises, 'resolve6', async () => []);
  await assert.rejects(resolveAndValidate('example.com'), /private/);
});

test('caller cancellation reaches the HTTP transport', async () => {
  const controller = new AbortController();
  let transportSignal;
  const pending = fetchDocument('https://example.com', 1000, controller.signal, {
    request: async (_url, { signal }) => {
      transportSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      );
    },
  });
  controller.abort(new Error('cancel request'));
  await assert.rejects(pending, /cancel request/);
  assert.equal(transportSignal.aborted, true);
});

test('explicit challenge headers reject even HTTP 200 without reading page wording', async () => {
  for (const status of [200, 403, 503]) {
    await assert.rejects(
      fetchDocument('https://example.com', 1000, undefined, {
        request: async () =>
          new Response('Any language or page title', {
            status,
            headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' },
          }),
      }),
      (failure) => failure.code === 'BLOCKED_CONTENT' && failure.status === status
    );
  }
});
