import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTransportError, transportErrorText } from './transport-error-text.mjs';
import { presentErrorText, backgroundTaskFailureStatusLabel } from './err-text.mjs';

function undiciTerminated(withCause = true) {
  const err = new TypeError('terminated');
  if (withCause) {
    err.cause = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
  }
  return err;
}

test('undici body abort reads as a lost connection with the innermost code', () => {
  assert.equal(presentErrorText(undiciTerminated(true)), 'Connection to the provider was lost (UND_ERR_SOCKET).');
  assert.equal(presentErrorText(undiciTerminated(false)), 'Connection to the provider was lost.');
  assert.equal(
    presentErrorText(undiciTerminated(true), { surface: 'turn' }),
    'Connection to the provider was lost (UND_ERR_SOCKET).'
  );
});

test('WebSocket closes normalize typed, nested, and persisted provider errors', () => {
  for (const closeCode of [1000, 1001, 1005, 1006, 1011, 1012]) {
    const raw = `OpenAI OAuth WS closed before response.completed (code=${closeCode})`;
    const error = Object.assign(new Error(raw), { wsCloseCode: closeCode, wsCloseReason: '' });
    const expected = 'Connection to the provider was lost.';
    for (const input of [error, new Error('provider failed', { cause: error }), raw, String(error)]) {
      assert.equal(presentErrorText(input, { surface: 'turn' }), expected);
    }
    assert.deepEqual(classifyTransportError({ wsCloseCode: String(closeCode) }), {
      kind: 'lost',
      code: `WS ${closeCode}`,
      status: 0,
    });
    assert.equal(error.message, raw);
    assert.equal(error.wsCloseCode, closeCode);
  }
  for (const provider of ['OpenAI OAuth', 'OpenAI', 'xAI']) {
    assert.equal(
      presentErrorText(`${provider} WS handshake closed before open (code=1006)`),
      'Connection to the provider was lost.'
    );
  }
  assert.equal(
    presentErrorText('OpenAI OAuth WS closed before response.completed (code=1012, reason=service restart)'),
    'Connection to the provider was lost.'
  );
  assert.equal(
    backgroundTaskFailureStatusLabel('failed', 'OpenAI OAuth WS closed before response.completed (code=1006)'),
    'Failed · Connection to the provider was lost'
  );
});

test('WebSocket close metadata does not replace more specific failures', () => {
  const error = Object.assign(new Error('OpenAI OAuth WS closed before response.completed (code=1006)'), {
    wsCloseCode: 1006,
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });
  assert.equal(presentErrorText(error), 'Connection to the provider was lost (ECONNRESET).');
  assert.equal(
    presentErrorText(Object.assign(new Error('upstream unavailable'), { wsCloseCode: 1006, httpStatus: 503 })),
    'Provider is temporarily unavailable (503).'
  );
  assert.equal(
    presentErrorText(Object.assign(new Error('not authorized'), { wsCloseCode: 1006, httpStatus: 401 })),
    'Provider authentication failed.'
  );
  for (const closeCode of [1008, 1009, 4000, 4401]) {
    const raw = `OpenAI OAuth WS closed before response.completed (code=${closeCode})`;
    assert.equal(classifyTransportError(Object.assign(new Error(raw), { wsCloseCode: closeCode })), null);
    assert.equal(classifyTransportError(raw), null);
  }
  assert.equal(classifyTransportError('Job failed (code=1006)'), null);
  assert.equal(
    classifyTransportError('Quoted diagnostic: OpenAI OAuth WS closed before response.completed (code=1006)'),
    null
  );
});

test('bare fetch failures and DNS/refused errors read as unreachable', () => {
  const fetchFailed = new TypeError('fetch failed');
  fetchFailed.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.example.invalid'), { code: 'ENOTFOUND' });
  assert.equal(presentErrorText(fetchFailed), 'Could not reach the provider (ENOTFOUND).');
  assert.equal(presentErrorText(new TypeError('fetch failed')), 'Could not reach the provider.');
  assert.equal(
    presentErrorText(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })),
    'Could not reach the provider (ECONNREFUSED).'
  );
});

test('socket resets, timeouts, TLS, and gateway statuses each get their own sentence', () => {
  assert.equal(
    presentErrorText(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
    'Connection to the provider was lost (ECONNRESET).'
  );
  assert.equal(presentErrorText(new Error('socket hang up')), 'Connection to the provider was lost.');
  assert.equal(
    presentErrorText(Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })),
    'The provider did not respond in time (UND_ERR_CONNECT_TIMEOUT).'
  );
  assert.equal(
    presentErrorText(
      Object.assign(new Error('self signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
    ),
    'Provider TLS certificate check failed (SELF_SIGNED_CERT_IN_CHAIN).'
  );
  assert.equal(
    presentErrorText(
      Object.assign(new Error('Anthropic OAuth API 503: <html>upstream unavailable</html>'), { httpStatus: 503 })
    ),
    'Provider is temporarily unavailable (503).'
  );
  assert.equal(
    presentErrorText(new Error('OpenAI OAuth HTTP fallback 502')),
    'Provider is temporarily unavailable (502).'
  );
});

test('non-transport failures are left alone', () => {
  assert.equal(classifyTransportError(new Error('terminated by signal SIGKILL (exit 137)')), null);
  assert.equal(classifyTransportError(new Error('Session terminated')), null);
  assert.equal(
    classifyTransportError(Object.assign(new Error('Anthropic OAuth API 400: bad request'), { httpStatus: 400 })),
    null
  );
  assert.equal(transportErrorText('agent compact failed (stage=pre_send)'), null);
  assert.equal(
    presentErrorText(new Error('The model is currently at capacity due to high demand.')),
    'Provider is busy at capacity.'
  );
  // A stalled stream keeps its duration-bearing sentence.
  const stall = Object.assign(new Error('stream timed out after 120000ms of inactivity'), {
    name: 'StreamStalledError',
    code: 'ESTREAMSTALL',
  });
  assert.equal(presentErrorText(stall, { surface: 'turn' }), 'No progress 2m.');
});

test('background task labels carry the normalized transport reason', () => {
  assert.equal(
    backgroundTaskFailureStatusLabel('failed', undiciTerminated(true)),
    'Failed · Connection to the provider was lost (UND_ERR_SOCKET)'
  );
  assert.equal(
    backgroundTaskFailureStatusLabel('failed', 'terminated by signal SIGKILL (exit 137)'),
    'Failed · terminated by signal SIGKILL (exit 137)'
  );
});
