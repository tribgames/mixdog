import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-muse-code-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MUSE_CODE_OAUTH_CREDENTIALS_PATH = join(dir, 'muse-code-oauth.json');

const { pollDeviceToken, requestDeviceAuthorization, completeLogin, defaultSleep } = await import(
  './muse-code-oauth-login.mjs'
);
const tokens = await import('./muse-code-oauth-tokens.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const device = { deviceCode: 'dc', userCode: 'ABCD-1234', intervalS: 5, expiresInS: 600 };

function scripted(responses, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next;
  };
}

test('device authorization sends client id with Meta headers and parses the response', async () => {
  const calls = [];
  const fetchFn = scripted(
    [
      reply(200, {
        user_code: 'ABCD-1234',
        device_code: 'dc',
        verification_uri: 'https://meta.com/device',
        verification_uri_complete: 'https://meta.com/device?c=ABCD-1234',
        interval: 7,
        expires_in: 300,
      }),
    ],
    calls
  );
  const result = await requestDeviceAuthorization({ fetchFn });
  assert.equal(result.userCode, 'ABCD-1234');
  assert.equal(result.verificationUriComplete, 'https://meta.com/device?c=ABCD-1234');
  assert.equal(result.intervalS, 7);
  assert.equal(result.expiresInS, 300);
  assert.equal(calls[0].url, 'https://auth.meta.com/oidc/device/authorization/');
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(calls[0].init.headers['x-api-version'], '1.0.0');
  assert.equal(new URLSearchParams(calls[0].init.body).get('client_id'), '1031625952748946');
});

test('polling keeps waiting on authorization_pending, then returns the access token', async () => {
  const sleeps = [];
  const calls = [];
  const fetchFn = scripted(
    [reply(400, { error: 'authorization_pending' }), reply(200, { access_token: 'acct-token' })],
    calls
  );
  const token = await pollDeviceToken(device, { fetchFn, sleep: async (ms) => sleeps.push(ms), now: () => 0 });
  assert.equal(token, 'acct-token');
  // Polls immediately, then sleeps between attempts.
  assert.deepEqual(sleeps, [5000]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://auth.meta.com/oidc/device/token/');
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('device_code'), 'dc');
  assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
  assert.equal(calls[0].init.headers['x-api-version'], '1.0.0');
});

test('slow_down widens the polling interval', async () => {
  const sleeps = [];
  const fetchFn = scripted([reply(400, { error: 'slow_down' }), reply(200, { access_token: 't' })]);
  await pollDeviceToken(device, { fetchFn, sleep: async (ms) => sleeps.push(ms), now: () => 0 });
  assert.deepEqual(sleeps, [10000]);
  const again = [];
  await pollDeviceToken(device, {
    fetchFn: scripted([
      reply(400, { error: 'slow_down' }),
      reply(400, { error: 'authorization_pending' }),
      reply(200, { access_token: 't' }),
    ]),
    sleep: async (ms) => again.push(ms),
    now: () => 0,
  });
  assert.deepEqual(again, [10000, 10000]);
});

test('the first poll happens before any sleep and the interval is clamped to one second', async () => {
  const order = [];
  const fetchFn = async () => {
    order.push('fetch');
    return order.length > 2 ? reply(200, { access_token: 't' }) : reply(400, { error: 'authorization_pending' });
  };
  await pollDeviceToken(
    { ...device, intervalS: 0 },
    { fetchFn, sleep: async (ms) => order.push(`sleep:${ms}`), now: () => 0 }
  );
  assert.deepEqual(order, ['fetch', 'sleep:1000', 'fetch']);
});

test('without expires_in the poll has no deadline', async () => {
  const sleeps = [];
  let calls = 0;
  const fetchFn = async () =>
    ++calls < 4 ? reply(400, { error: 'authorization_pending' }) : reply(200, { access_token: 't' });
  let clock = 0;
  const token = await pollDeviceToken(
    { ...device, expiresInS: null },
    {
      fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += 1e12;
      },
      now: () => clock,
    }
  );
  assert.equal(token, 't');
  assert.equal(sleeps.length, 3);
});

test('an in-flight poll is aborted when the device code expires', async () => {
  const fetchFn = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  // AbortSignal.timeout timers are unref'd; keep the loop alive for the test.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(
      pollDeviceToken({ ...device, expiresInS: 0.05 }, { fetchFn, sleep: async () => {} }),
      /expired/
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('the token response must be HTTP success without an OAuth error', async () => {
  await assert.rejects(
    pollDeviceToken(device, {
      fetchFn: scripted([
        reply(200, { error: 'invalid_request', error_description: 'bad grant type', access_token: 'x' }),
      ]),
      sleep: async () => {},
      now: () => 0,
    }),
    /invalid_request: bad grant type/
  );
});

test('a transient 500 is retried after the interval, then the login succeeds', async () => {
  const sleeps = [];
  const calls = [];
  const token = await pollDeviceToken(device, {
    fetchFn: scripted([reply(500, { access_token: 'bad' }), reply(200, { access_token: 'good' })], calls),
    sleep: async (ms) => sleeps.push(ms),
    now: () => 0,
  });
  assert.equal(token, 'good');
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [5000]);
});

test('four consecutive 5xx replies fail with the redacted error; a well-formed reply resets the count', async () => {
  const calls = [];
  await assert.rejects(
    pollDeviceToken(device, {
      fetchFn: scripted(
        [reply(503, 'dc down'), reply(502, 'x'), reply(500, 'x'), reply(504, 'upstream dc gone')],
        calls
      ),
      sleep: async () => {},
      now: () => 0,
    }),
    (err) => /device token 504/.test(err.message) && !/\bdc\b/.test(err.message)
  );
  assert.equal(calls.length, 4);
  const token = await pollDeviceToken(device, {
    fetchFn: scripted([
      reply(500, 'x'),
      reply(500, 'x'),
      reply(500, 'x'),
      reply(400, { error: 'authorization_pending' }),
      reply(500, 'x'),
      reply(200, { access_token: 't' }),
    ]),
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(token, 't');
});

test('429 widens the interval and Retry-After is honoured; network errors are retried', async () => {
  const sleeps = [];
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) throw new Error('socket hang up');
    if (n === 2) return { ...reply(429, 'slow'), headers: new Headers({ 'retry-after': '30' }) };
    if (n === 3) return reply(429, 'slow');
    return reply(200, { access_token: 't' });
  };
  const token = await pollDeviceToken(device, { fetchFn, sleep: async (ms) => sleeps.push(ms), now: () => 0 });
  assert.equal(token, 't');
  // The network error doubles the 5s interval to 10s; each 429 then adds 5s on top.
  assert.deepEqual(sleeps, [10000, 30000, 20000]);
});

// Make every postForm timeout signal fire at once so the request fails as a timeout.
async function withInstantTimeouts(run) {
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => {
    const c = new AbortController();
    c.abort(new Error('t'));
    return c.signal;
  };
  try {
    return await run();
  } finally {
    AbortSignal.timeout = realTimeout;
  }
}

test('connection timeouts double the persistent poll interval (RFC 8628 §3.5)', async () => {
  const sleeps = [];
  let n = 0;
  const fetchFn = async () => {
    if (n++ < 3) throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return reply(200, { access_token: 't' });
  };
  const token = await withInstantTimeouts(() =>
    pollDeviceToken({ ...device, expiresInS: null }, { fetchFn, sleep: async (ms) => sleeps.push(ms), now: () => 0 })
  );
  assert.equal(token, 't');
  // 5s → 10s → 20s → 40s: every failure sleeps the grown interval.
  assert.deepEqual(sleeps, [10000, 20000, 40000]);
});

test('the grown interval is kept after the endpoint recovers and is capped at 60s', async () => {
  const sleeps = [];
  const script = ['net', 'net', 'pending', 'pending', 'done'];
  let n = 0;
  const fetchFn = async () => {
    const step = script[n++];
    if (step === 'net') throw new TypeError('fetch failed');
    if (step === 'pending') return reply(400, { error: 'authorization_pending' });
    return reply(200, { access_token: 't' });
  };
  const token = await pollDeviceToken(
    { ...device, intervalS: 20, expiresInS: null },
    { fetchFn, sleep: async (ms) => sleeps.push(ms), now: () => 0 }
  );
  assert.equal(token, 't');
  // 20s → 40s → 60s (capped); pending polls keep waiting at the 60s interval.
  assert.deepEqual(sleeps, [40000, 60000, 60000, 60000]);
});

test('a transient failure after the interval reached the 60s cap fails instead of polling at the same rate', async () => {
  const sleeps = [];
  let calls = 0;
  await assert.rejects(
    pollDeviceToken(
      { ...device, intervalS: 20, expiresInS: null },
      {
        fetchFn: async () => {
          calls++;
          throw new TypeError('fetch failed');
        },
        sleep: async (ms) => sleeps.push(ms),
        now: () => 0,
      }
    ),
    (err) => err.kind === 'device-token' && /fetch failed/.test(err.message)
  );
  // 20s → 40s → 60s (cap reached); the next failure cannot back off further.
  assert.deepEqual(sleeps, [40000, 60000]);
  assert.equal(calls, 3);
});

for (const intervalS of [60, 90]) {
  test(`a server interval of ${intervalS}s fails on the first transient error without a retry`, async () => {
    const sleeps = [];
    let calls = 0;
    await assert.rejects(
      pollDeviceToken(
        { ...device, intervalS, expiresInS: null },
        {
          fetchFn: async () => {
            calls++;
            throw new TypeError('fetch failed');
          },
          sleep: async (ms) => sleeps.push(ms),
          now: () => 0,
        }
      ),
      (err) => err.kind === 'device-token'
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });
}

test('a timeout backs the interval off and the retry stays bounded at three consecutive failures', async () => {
  const sleeps = [];
  const calls = [];
  await withInstantTimeouts(() =>
    assert.rejects(
      pollDeviceToken(
        { ...device, expiresInS: null },
        {
          fetchFn: async () => {
            calls.push(1);
            throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
          },
          sleep: async (ms) => sleeps.push(ms),
          now: () => 0,
        }
      ),
      (err) => err.kind === 'timeout'
    )
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [10000, 20000, 40000]);
});

test('slow_down and Retry-After still add to a backed-off interval', async () => {
  const sleeps = [];
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    if (n === 2) return reply(400, { error: 'slow_down' });
    return reply(200, { access_token: 't' });
  };
  await pollDeviceToken(device, { fetchFn, sleep: async (ms) => sleeps.push(ms), now: () => 0 });
  assert.deepEqual(sleeps, [10000, 15000]);
});

test('OAuth 4xx errors, access_denied and expired_token are never retried', async () => {
  for (const [status, error, pattern] of [
    [400, 'invalid_grant', /invalid_grant/],
    [400, 'access_denied', /denied/],
    [400, 'expired_token', /expired/],
  ]) {
    const calls = [];
    await assert.rejects(
      pollDeviceToken(device, {
        fetchFn: scripted([reply(status, { error }), reply(200, { access_token: 't' })], calls),
        sleep: async () => {},
        now: () => 0,
      }),
      pattern
    );
    assert.equal(calls.length, 1);
  }
});

test('device and token requests time out after 30s and refuse redirects', async () => {
  const calls = [];
  await pollDeviceToken(device, {
    fetchFn: scripted([reply(200, { access_token: 't' })], calls),
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const { DEVICE_REQUEST_TIMEOUT_MS } = await import('./muse-code-oauth-login.mjs');
  assert.equal(DEVICE_REQUEST_TIMEOUT_MS, 30_000);
});

test('a cross-origin redirect on the device-token request is rejected and the body is not resent', async () => {
  const { createServer } = await import('node:http');
  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const received = [];
  const target = createServer((req, res) => {
    received.push(req.url);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"access_token":"leaked"}');
  });
  const targetPort = await listen(target);
  const origin = createServer((req, res) => {
    req.resume();
    res.writeHead(307, { Location: `http://localhost:${targetPort}/steal` });
    res.end();
  });
  const originPort = await listen(origin);
  // Route the fixed token URL to the local origin; everything else is the real request.
  const fetchFn = (url, init) => fetch(`http://127.0.0.1:${originPort}/token`, init);
  try {
    await assert.rejects(
      pollDeviceToken(device, { fetchFn, sleep: async () => {}, now: () => 0 }),
      (err) => err.kind === 'device-token' && /device-token request failed/.test(err.message)
    );
    assert.deepEqual(received, []);
  } finally {
    origin.close();
    target.close();
  }
});

test('fractional intervals keep millisecond precision; slow_down adds five seconds', async () => {
  const ok = { user_code: 'U', device_code: 'D', verification_uri: 'https://m/d' };
  const frac = await requestDeviceAuthorization({ fetchFn: scripted([reply(200, { ...ok, interval: 2.5 })]) });
  assert.equal(frac.intervalS, 2.5);
  const sleeps = [];
  await pollDeviceToken(frac, {
    fetchFn: scripted([reply(400, { error: 'authorization_pending' }), reply(200, { access_token: 't' })]),
    sleep: async (ms) => sleeps.push(ms),
    now: () => 0,
  });
  assert.deepEqual(sleeps, [2500]);
});

test('a supplied zero or negative expires_in is already expired; an absent one is no deadline', async () => {
  const ok = { user_code: 'U', device_code: 'D', verification_uri: 'https://m/d' };
  for (const expires_in of [0, -5]) {
    const dev = await requestDeviceAuthorization({ fetchFn: scripted([reply(200, { ...ok, expires_in })]) });
    assert.equal(dev.expiresInS, expires_in);
    let polled = false;
    await assert.rejects(
      pollDeviceToken(dev, {
        fetchFn: async () => {
          polled = true;
          return reply(200, { access_token: 't' });
        },
        sleep: async () => {},
        now: () => 0,
      }),
      /expired/
    );
    assert.equal(polled, false);
  }
  const none = await requestDeviceAuthorization({ fetchFn: scripted([reply(200, ok)]) });
  assert.equal(none.expiresInS, null);
});

test('device-auth and polling failures carry structured status and kind', async () => {
  await assert.rejects(
    requestDeviceAuthorization({ fetchFn: scripted([reply(503, { error: 'down' })]) }),
    (err) => err.kind === 'device-auth' && err.status === 503
  );
  await assert.rejects(
    requestDeviceAuthorization({ fetchFn: scripted([reply(200, { user_code: 'U' })]) }),
    (err) => err.kind === 'validation' && err.status === 200
  );
  const poll = (body, status = 400) =>
    pollDeviceToken(device, { fetchFn: scripted([reply(status, body)]), sleep: async () => {}, now: () => 0 });
  await assert.rejects(
    poll({ error: 'access_denied' }),
    (err) => err.kind === 'device-token' && err.code === 'access_denied' && err.status === 400
  );
  await assert.rejects(
    poll({ error: 'expired_token' }),
    (err) => err.kind === 'device-token' && err.code === 'expired_token'
  );
  await assert.rejects(
    poll({ error: 'invalid_request', error_description: 'nope' }),
    (err) => err.kind === 'device-token' && err.code === 'invalid_request' && err.status === 400
  );
});

test('transport failures are classified: device-auth/device-token, timeout, cancelled', async () => {
  const boom = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(
    requestDeviceAuthorization({ fetchFn: boom }),
    (err) => err.kind === 'device-auth' && /fetch failed/.test(err.message)
  );
  await assert.rejects(
    pollDeviceToken(device, { fetchFn: boom, sleep: async () => {}, now: () => 0 }),
    (err) => err.kind === 'device-token' && /fetch failed/.test(err.message)
  );
  const timedOut = async () => {
    throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
  };
  const realTimeout = AbortSignal.timeout;
  AbortSignal.timeout = () => {
    const c = new AbortController();
    c.abort(new Error('t'));
    return c.signal;
  };
  try {
    await assert.rejects(requestDeviceAuthorization({ fetchFn: timedOut }), (err) => err.kind === 'timeout');
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  const controller = new AbortController();
  controller.abort(new Error('user closed'));
  await assert.rejects(
    requestDeviceAuthorization({ fetchFn: boom, signal: controller.signal }),
    (err) => err.kind === 'cancelled' && err.cancelled === true && /user closed/.test(err.message)
  );
  const live = new AbortController();
  await assert.rejects(
    pollDeviceToken(device, {
      fetchFn: async () => {
        live.abort(new Error('stop'));
        throw new Error('aborted');
      },
      signal: live.signal,
      sleep: async () => {},
      now: () => 0,
    }),
    (err) => err.kind === 'cancelled'
  );
});

test('the default sleep removes its abort listener when it completes', async () => {
  const controller = new AbortController();
  const { getEventListeners } = await import('node:events');
  for (let i = 0; i < 50; i += 1) await defaultSleep(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  // An abort during a pending sleep still rejects as cancelled.
  const pending = defaultSleep(10_000, controller.signal);
  controller.abort(new Error('stop'));
  await assert.rejects(pending, (err) => err.kind === 'cancelled');
});

test('device authorization requires string codes and tolerates a missing expiry', async () => {
  const ok = { user_code: 'U', device_code: 'D', verification_uri: 'https://m/d' };
  const result = await requestDeviceAuthorization({ fetchFn: scripted([reply(200, ok)]) });
  assert.equal(result.expiresInS, null);
  assert.equal(result.intervalS, 5);
  const clamped = await requestDeviceAuthorization({ fetchFn: scripted([reply(200, { ...ok, interval: 0.2 })]) });
  assert.equal(clamped.intervalS, 1);
  for (const bad of [
    { ...ok, device_code: 123 },
    { ...ok, user_code: undefined },
    { ...ok, verification_uri: undefined, verification_uri_complete: 'https://m/c' },
  ]) {
    await assert.rejects(
      requestDeviceAuthorization({ fetchFn: scripted([reply(200, bad)]) }),
      /missing required fields/
    );
  }
});

test('expired_token and a passed deadline both fail as expired', async () => {
  await assert.rejects(
    pollDeviceToken(device, {
      fetchFn: scripted([reply(400, { error: 'expired_token' })]),
      sleep: async () => {},
      now: () => 0,
    }),
    /expired/
  );
  let clock = 0;
  await assert.rejects(
    pollDeviceToken(device, {
      fetchFn: scripted([reply(400, { error: 'authorization_pending' })]),
      sleep: async () => {
        clock += 601_000;
      },
      now: () => clock,
    }),
    /expired/
  );
});

test('access_denied is surfaced', async () => {
  await assert.rejects(
    pollDeviceToken(device, {
      fetchFn: scripted([reply(400, { error: 'access_denied' })]),
      sleep: async () => {},
      now: () => 0,
    }),
    /denied/
  );
});

const keyBody = {
  api_key: 'sk-muse',
  user_id: 'u-1',
  user_email: 'Me@Example.com',
  is_subs_active: true,
};

test('an active subscription mints the key once and stores the credential', async () => {
  const calls = [];
  const creds = await completeLogin('acct-token', { fetchFn: scripted([reply(200, keyBody)], calls) });
  assert.deepEqual(creds, { accessToken: 'acct-token', apiKey: 'sk-muse', accountId: 'u-1', email: 'me@example.com' });
  assert.equal(calls[0].url, 'https://api.meta.ai/muse-code/key');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer acct-token');
  assert.equal(calls[0].init.headers['x-api-version'], '1.0.0');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].init.body), { onboard: true });
  assert.ok(existsSync(tokens.getOwnTokenPath()));
  assert.equal(JSON.parse(readFileSync(tokens.getOwnTokenPath(), 'utf-8')).apiKey, 'sk-muse');
  assert.equal(tokens.hasMuseCodeOAuthCredentials(), true);
  assert.equal(tokens.describeMuseCodeOAuthCredentials().authenticated, true);
  assert.equal(tokens.forgetMuseCodeOAuthCredentials().removed, true);
  assert.equal(tokens.hasMuseCodeOAuthCredentials(), false);
});

test('an inactive subscription is rejected with structured reauth metadata', () => {
  assert.throws(
    () => tokens.credentialsFromKeyResponse({ ...keyBody, is_subs_active: false }, 't'),
    (err) =>
      /subscription inactive/.test(err.message) &&
      /invalid_grant/.test(err.message) &&
      err.status === 403 &&
      err.kind === 'token-exchange' &&
      err.reauthRequired === true
  );
});

test('payment required is an entitlement error; action URLs are trimmed before choosing', () => {
  assert.throws(
    () =>
      tokens.credentialsFromKeyResponse(
        { require_payment: true, action_url: '   ', require_payment_action_url: ' https://meta.ai/pay3 ' },
        't'
      ),
    (err) => err.kind === 'entitlement' && err.actionUrl === 'https://meta.ai/pay3' && /pay3$/.test(err.message)
  );
});

test('key responses with wrong field types are rejected, not stringified', () => {
  for (const bad of [
    { api_key: 123 },
    { api_key: 'k', user_id: 42 },
    { api_key: 'k', user_email: {} },
    { api_key: 'k', is_subs_active: 'yes' },
  ]) {
    assert.throws(
      () => tokens.credentialsFromKeyResponse(bad, 't'),
      (err) => err.kind === 'validation'
    );
  }
});

test('a partial credential file is treated as signed out', async () => {
  const { writeFileSync } = await import('node:fs');
  const path = tokens.getOwnTokenPath();
  writeFileSync(path, JSON.stringify({ apiKey: 'k', accountId: 'u' }));
  assert.equal(tokens.loadTokens(), null);
  assert.equal(tokens.hasMuseCodeOAuthCredentials(), false);
  writeFileSync(path, JSON.stringify({ accessToken: 'a', accountId: 'u' }));
  assert.equal(tokens.loadTokens(), null);
  tokens.forgetMuseCodeOAuthCredentials();
});

test('payment required reports the action URL', () => {
  assert.throws(
    () =>
      tokens.credentialsFromKeyResponse(
        { is_subs_active: true, require_payment: true, require_payment_action_url: 'https://meta.ai/pay' },
        't'
      ),
    /https:\/\/meta\.ai\/pay/
  );
  assert.throws(
    () => tokens.credentialsFromKeyResponse({ action_url: 'https://meta.ai/pay2' }, 't'),
    /https:\/\/meta\.ai\/pay2/
  );
});

test('a response with no stable identity is rejected, email is the fallback id', () => {
  assert.throws(() => tokens.credentialsFromKeyResponse({ api_key: 'k' }, 't'), /stable account identity/);
  const creds = tokens.credentialsFromKeyResponse({ api_key: 'k', user_email: 'A@B.C' }, 't');
  assert.equal(creds.accountId, 'a@b.c');
});

test('a failed key request carries the HTTP status and no secrets', async () => {
  await assert.rejects(
    tokens.requestMuseCodeKey('t', { fetchFn: scripted([reply(401, '{"api_key":"leak"}')]) }),
    (err) => err.status === 401 && !err.message.includes('leak')
  );
});
