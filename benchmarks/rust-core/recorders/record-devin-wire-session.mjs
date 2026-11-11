#!/usr/bin/env node
// devin-wire-session.test.mjs (7 tests): the real Devin session helpers (token prefix, request metadata, GetUserJwt exchange, API host
// validation). The GetUserJwt endpoint is a scripted `fetchFn` (the product's injection point) that records every call as the product made it
// (url, header pairs, redirect mode, body hex and its decoded metadata) and answers with protobuf bytes built by the product's own encoder.
//   node benchmarks/rust-core/recorders/record-devin-wire-session.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-devin-wire-session',
  net: false,
  entry: 'devin-wire-session.mjs normalizeDevinSessionToken, devinRequestMetadata, exchangeDevinUserJwt({ sessionToken, fetchFn }), validateDevinApiHost; devin-wire-protobuf.mjs encode/decodeDevinMessage for the scripted replies and the recorded request metadata. Not run: a live endpoint.',
  compare: 'mixdog-ai providers::devin session.rs (:276-291, :332-339): feed `input` and compare `result`/`error` (code, status, detail) and `calls` (url, headers, redirect, body hex, decoded metadata) in order. `os` in the metadata is the platform the recording ran on (windows): a replay on another platform compares everything but metadata.os.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::devin::DevinAdapter (devin/mod.rs:165), DevinCodec (devin/mod.rs:88) and DevinDecoder (devin/decoder.rs:48), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079). The session login (JWT exchange) has no pub item located (devin/session.rs is private): work for the Rust side.",
});
const P = 'agent/orchestrator/providers/';
const { decodeDevinMessage, encodeDevinMessage } = await rec.P(`${P}devin-wire-protobuf.mjs`);
const { DEVIN_DEFAULT_BASE_URL, devinRequestMetadata, exchangeDevinUserJwt, normalizeDevinSessionToken, validateDevinApiHost } = await rec.P(`${P}devin-wire-session.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/devin-wire-session.test.mjs';
const jwtReply = (value) => new Response(encodeDevinMessage('GetUserJwtResponse', value));
function jwtServer(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const metadata = decodeDevinMessage('GetUserJwtRequest', init.body).metadata;
    calls.push({ url, metadata, headers: Object.entries(init.headers), redirect: init.redirect, bodyHex: Buffer.from(init.body).toString('hex') });
    return handler(metadata, calls.length);
  };
  return { calls, fetchFn };
}
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};

await rec.run('token-prefix-exactly-once', `${SRC}:28`, {}, () => ({ plain: normalizeDevinSessionToken('abc'), prefixed: normalizeDevinSessionToken('devin-session-token$abc'), empty: normalizeDevinSessionToken('') }));
await rec.run('request-metadata-identities', `${SRC}:34`, {}, () => ({
  cli: devinRequestMetadata({ apiKey: 'k', userJwt: 'j' }),
  legacy: devinRequestMetadata({ apiKey: 'raw', client: 'legacy' }),
  discovery: devinRequestMetadata({ apiKey: 'k', client: 'discovery' }),
}));
await rec.run('get-user-jwt-prefixed-token-validated-host', `${SRC}:67`, { sessionToken: 'tok' }, async () => {
  const { calls, fetchFn } = jwtServer(() => jwtReply({ userJwt: 'the-jwt', customApiServerUrl: 'https://acme.windsurf.example/api/' }));
  const out = await attempt(exchangeDevinUserJwt({ sessionToken: 'tok', fetchFn }));
  return { ...out, calls, defaultBaseUrl: DEVIN_DEFAULT_BASE_URL };
});
await rec.run('rejected-prefixed-token-retried-raw-once', `${SRC}:87`, { sessionToken: 'raw-key' }, async () => {
  const retry = jwtServer((metadata) => (metadata.apiKey.startsWith('devin-session-token$') ? new Response(JSON.stringify({ code: 'unauthenticated', message: 'no' }), { status: 401 }) : jwtReply({ userJwt: 'legacy-jwt' })));
  const retried = await attempt(exchangeDevinUserJwt({ sessionToken: 'raw-key', fetchFn: retry.fetchFn }));
  const forbidden = jwtServer(() => new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 403 }));
  const forbiddenOut = await attempt(exchangeDevinUserJwt({ sessionToken: 'raw-key', fetchFn: forbidden.fetchFn }));
  const prefixed = jwtServer(() => new Response('{}', { status: 401 }));
  const prefixedOut = await attempt(exchangeDevinUserJwt({ sessionToken: 'devin-session-token$x', fetchFn: prefixed.fetchFn }));
  return { retried, retryCalls: retry.calls, forbidden: forbiddenOut, forbiddenCalls: forbidden.calls, prefixed: prefixedOut, prefixedCalls: prefixed.calls };
});
await rec.run('failure-never-echoes-session-token', `${SRC}:107`, { secret: 'S3ssionSecretValue42' }, async () => {
  const secret = 'S3ssionSecretValue42';
  const { fetchFn } = jwtServer((metadata) => new Response(JSON.stringify({ code: 'unauthenticated', message: `token ${metadata.apiKey} rejected (raw ${secret})` }), { status: 401 }));
  const out = await attempt(exchangeDevinUserJwt({ sessionToken: secret, fetchFn }));
  const e = out.error;
  return { ...out, detail: e.detail, secretInAnyOf: [e.message, e.detail, e.stack, JSON.stringify(e), String(e.cause)].map((t) => String(t).includes(secret)) };
});
await rec.run('empty-jwt-missing-token-unsafe-host', `${SRC}:126`, {}, async () => ({
  emptyJwt: await attempt(exchangeDevinUserJwt({ sessionToken: 't', fetchFn: async () => jwtReply({}) })),
  missingToken: await attempt(exchangeDevinUserJwt({ sessionToken: '', fetchFn: async () => jwtReply({}) })),
  unsafeHost: await attempt(exchangeDevinUserJwt({ sessionToken: 't', fetchFn: async () => jwtReply({ userJwt: 'j', customApiServerUrl: 'http://evil.example' }) })),
}));
const unsafeHosts = ['http://server.codeium.com', 'ftp://server.codeium.com', 'https://user:pw@server.codeium.com', 'https://server.codeium.com/?a=1', 'https://server.codeium.com/#x', 'https://localhost', 'https://api.localhost', 'https://printer.local', 'https://intranet', 'https://127.0.0.1', 'https://10.1.2.3', 'https://172.20.0.1', 'https://192.168.1.1', 'https://169.254.169.254', 'https://100.64.0.1', 'https://0.0.0.0', 'https://[::1]', 'https://[fd00::1]', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]', 'https://2130706433', 'not a url'];
await rec.run('api-host-validation', `${SRC}:142`, { accepted: ['https://server.codeium.com/', 'https://eu.windsurf.example:8443/x/', 'https://8.8.8.8'], unsafe: unsafeHosts }, () => ({
  accepted: ['https://server.codeium.com/', 'https://eu.windsurf.example:8443/x/', 'https://8.8.8.8'].map((host) => ({ host, validated: validateDevinApiHost(host) })),
  unsafe: unsafeHosts.map((host) => {
    try {
      return { host, validated: validateDevinApiHost(host) };
    } catch (error) {
      return { host, error };
    }
  }),
}));
await rec.finish();
