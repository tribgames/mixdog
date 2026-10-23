import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeDevinMessage, encodeDevinMessage } from './devin-wire-protobuf.mjs';
import {
  DEVIN_DEFAULT_BASE_URL,
  devinRequestMetadata,
  exchangeDevinUserJwt,
  normalizeDevinSessionToken,
  validateDevinApiHost,
} from './devin-wire-session.mjs';
import { DevinWireError } from './devin-wire-transport.mjs';

const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';

function jwtServer(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const metadata = decodeDevinMessage('GetUserJwtRequest', init.body).metadata;
    calls.push({ url, metadata, headers: init.headers, redirect: init.redirect });
    return handler(metadata, calls.length);
  };
  return { calls, fetchFn };
}

const jwtReply = (value) => new Response(encodeDevinMessage('GetUserJwtResponse', value));

test('session tokens gain the wire prefix exactly once', () => {
  assert.equal(normalizeDevinSessionToken('abc'), 'devin-session-token$abc');
  assert.equal(normalizeDevinSessionToken('devin-session-token$abc'), 'devin-session-token$abc');
  assert.equal(normalizeDevinSessionToken(''), '');
});

test('request metadata carries the CLI and discovery identities', () => {
  assert.deepEqual(devinRequestMetadata({ apiKey: 'k', userJwt: 'j' }), {
    apiKey: 'k',
    userJwt: 'j',
    ideName: 'devin-cli',
    ideType: 'chisel',
    ideVersion: '3000.11.3',
    extensionName: 'chisel',
    extensionVersion: '3000.11.3',
    locale: 'en',
    os: OS,
  });
  assert.deepEqual(devinRequestMetadata({ apiKey: 'raw', client: 'legacy' }), {
    apiKey: 'raw',
    ideName: 'windsurf',
    ideVersion: '3.2.23',
    extensionName: 'windsurf',
    extensionVersion: '1.48.2',
    locale: 'en',
  });
  const discovery = devinRequestMetadata({ apiKey: 'k', client: 'discovery' });
  assert.equal(discovery.ideName, 'chisel');
  assert.equal(discovery.ideVersion, '0.0.0-dev');
  assert.deepEqual(discovery.supportedModelDisplays, [3, 4, 6, 7, 8]);
  assert.equal(discovery.userJwt, undefined);
});

test('GetUserJwt sends the prefixed session token and returns the validated API host', async () => {
  const { calls, fetchFn } = jwtServer(() =>
    jwtReply({ userJwt: 'the-jwt', customApiServerUrl: 'https://acme.windsurf.example/api/' })
  );
  const result = await exchangeDevinUserJwt({ sessionToken: 'tok', fetchFn });
  assert.deepEqual(result, {
    jwt: 'the-jwt',
    apiKey: 'devin-session-token$tok',
    apiHost: 'https://acme.windsurf.example/api',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DEVIN_DEFAULT_BASE_URL}/exa.auth_pb.AuthService/GetUserJwt`);
  assert.equal(calls[0].headers['content-type'], 'application/proto');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].metadata.apiKey, 'devin-session-token$tok');
  assert.equal(calls[0].metadata.ideName, 'devin-cli');
  assert.equal(calls[0].metadata.ideType, 'chisel');
});

test('a rejected prefixed token is retried once as a raw API key', async () => {
  const { calls, fetchFn } = jwtServer((metadata) =>
    metadata.apiKey.startsWith('devin-session-token$')
      ? new Response(JSON.stringify({ code: 'unauthenticated', message: 'no' }), { status: 401 })
      : jwtReply({ userJwt: 'legacy-jwt' })
  );
  const result = await exchangeDevinUserJwt({ sessionToken: 'raw-key', fetchFn });
  assert.deepEqual(result, { jwt: 'legacy-jwt', apiKey: 'raw-key' });
  assert.deepEqual(
    calls.map((call) => call.metadata.apiKey),
    ['devin-session-token$raw-key', 'raw-key']
  );

  // Only an HTTP 401 triggers the raw retry.
  const forbidden = jwtServer(() => new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 403 }));
  await assert.rejects(exchangeDevinUserJwt({ sessionToken: 'raw-key', fetchFn: forbidden.fetchFn }), {
    status: 403,
  });
  assert.equal(forbidden.calls.length, 1);

  const prefixed = jwtServer(() => new Response('{}', { status: 401 }));
  await assert.rejects(exchangeDevinUserJwt({ sessionToken: 'devin-session-token$x', fetchFn: prefixed.fetchFn }), {
    code: 'unauthenticated',
  });
  assert.equal(prefixed.calls.length, 1);
});

test('an exchange failure never echoes the session token, prefixed or raw', async () => {
  const secret = 'S3ssionSecretValue42';
  const { fetchFn } = jwtServer(
    (metadata) =>
      new Response(
        JSON.stringify({ code: 'unauthenticated', message: `token ${metadata.apiKey} rejected (raw ${secret})` }),
        { status: 401 }
      )
  );
  await assert.rejects(exchangeDevinUserJwt({ sessionToken: secret, fetchFn }), (error) => {
    assert.equal(error.code, 'unauthenticated');
    for (const text of [error.message, error.detail, error.stack, JSON.stringify(error), String(error.cause)]) {
      assert.doesNotMatch(String(text), new RegExp(secret));
    }
    assert.match(error.detail, /token \[redacted\] rejected \(raw \[redacted\]\)/);
    return true;
  });
});

test('empty JWTs, missing tokens and unsafe hosts fail before use', async () => {
  await assert.rejects(exchangeDevinUserJwt({ sessionToken: 't', fetchFn: async () => jwtReply({}) }), {
    code: 'protocol',
  });
  await assert.rejects(exchangeDevinUserJwt({ sessionToken: '', fetchFn: async () => jwtReply({}) }), {
    code: 'unauthenticated',
  });
  await assert.rejects(
    exchangeDevinUserJwt({
      sessionToken: 't',
      fetchFn: async () => jwtReply({ userJwt: 'j', customApiServerUrl: 'http://evil.example' }),
    }),
    (error) => error instanceof DevinWireError && error.code === 'protocol' && /unsafe API host/.test(error.message)
  );
});

test('API host validation accepts public https and rejects unsafe destinations', () => {
  assert.equal(validateDevinApiHost('https://server.codeium.com/'), 'https://server.codeium.com');
  assert.equal(validateDevinApiHost('https://eu.windsurf.example:8443/x/'), 'https://eu.windsurf.example:8443/x');
  assert.equal(validateDevinApiHost('https://8.8.8.8'), 'https://8.8.8.8');
  for (const unsafe of [
    'http://server.codeium.com',
    'ftp://server.codeium.com',
    'https://user:pw@server.codeium.com',
    'https://server.codeium.com/?a=1',
    'https://server.codeium.com/#x',
    'https://localhost',
    'https://api.localhost',
    'https://printer.local',
    'https://intranet',
    'https://127.0.0.1',
    'https://10.1.2.3',
    'https://172.20.0.1',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://100.64.0.1',
    'https://0.0.0.0',
    'https://[::1]',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]',
    'https://2130706433',
    'not a url',
  ]) {
    assert.throws(() => validateDevinApiHost(unsafe), { code: 'protocol' }, unsafe);
  }
});
