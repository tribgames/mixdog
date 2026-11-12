#!/usr/bin/env node
// openai-ws-handshake.test.mjs (2 tests): the real `attachHandshakeFailureHandlers` over an EventEmitter socket that emits an
// `unexpected-response` with a scripted status / headers / body chunks. The settled value is recorded whole (status, headers, code,
// retry-after / reset advice, raw body, message).
//   node benchmarks/rust-core/recorders/record-openai-ws-handshake.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-handshake',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs acquireWebSocket (the real ws client; openai-ws-handshake.mjs attachHandshakeFailureHandlers inside it) against a loopback server (lib/ws-world.mjs) that refuses the upgrade with a scripted non-101 response. Not run: a live endpoint.',
  compare: 'mixdog-ai transport/ws.rs connect (:40 handshake failure): serve `input.refusal` (status, header pairs, body chunks) and compare the error whole (message, status, httpStatus, headers, code, retryAfterMs, resetAt, httpBody) and the ordered `events` (dial, upgrade request with every header, the refusal).',
  replay: "Rust entry (pub, on o1): mixdog_ai::transport::ws::connect (transport/ws.rs:237) and ConnectError (transport/ws.rs:70); the adapter above it is OpenAiAdapter (openai/adapter.rs:308).",
});
const world = await rec.wsWorld();
const { acquireWebSocket } = await rec.raw('agent/orchestrator/providers/openai-ws-pool.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-handshake.test.mjs';
const AUTH = { type: 'openai-oauth', access_token: 'fixture-access-token', account_id: 'acct-fixture' };
// The provider's real client dials a server that refuses the upgrade with a non-101 response (status, headers, body chunks as the server writes them);
// attachHandshakeFailureHandlers (through acquireWebSocket) settles the connect with the error, recorded whole.
const handshake = async (refusal, auth = AUTH) => {
  world.reset({ refuse: () => refusal });
  let outcome;
  try {
    outcome = { value: await acquireWebSocket({ auth, poolKey: '', cacheKey: 'ws-handshake-test', forceFresh: true }) };
  } catch (error) {
    outcome = { error };
  }
  await world.until((t) => t.some((e) => e.event === 'upgrade-refused'), 'upgrade refused');
  return { outcome, events: world.trace.map((e) => ({ ...e })) };
};
const body = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'm'.repeat(400), resets_at: 1893456000 } });
const refusal429 = { status: 429, headers: [['retry-after', '30'], ['x-request-id', 'req_1']], bodyChunks: [body.slice(0, 50), body.slice(50)] };
await rec.run('unexpected-response-preserves-status-headers-body', `${SRC}:28`, { refusal: refusal429 }, () => handshake(refusal429));
const refusal403 = { status: 403, headers: [['server', 'cloudflare']], bodyChunks: ['<html>blocked</html>'] };
await rec.run('non-json-body-keeps-status-and-headers', `${SRC}:46`, { refusal: refusal403 }, () => handshake(refusal403));
// A rejection that echoes the credential the upgrade carried inside ordinary message text: the error text and the kept body carry it redacted
// (node-patches/node-fix-scrub-echoed-credential.patch).
const refusalEcho = { status: 400, headers: [['x-request-id', 'req_2']], bodyChunks: [JSON.stringify({ error: { type: 'invalid_request_error', message: 'the credential fixture-access-token was refused for this account' } })] };
await rec.run('unexpected-response-redacts-the-credential-it-echoes', `${SRC}:28`, { refusal: refusalEcho }, () => handshake(refusalEcho));
// The same rejection for a token with characters an encoder rewrites, repeated in the spellings a server uses (percent-encoded as in a query
// string, URL-safe base64, as sent), in the body and in a header: the error text, the kept body and the kept headers carry each redacted
// (node-patches/node-fix-scrub-echoed-credential.patch).
const ODD_TOKEN = 'fixture/odd+token&1';
const spellings = `${encodeURIComponent(ODD_TOKEN)}, ${Buffer.from(ODD_TOKEN).toString('base64url')} and ${ODD_TOKEN}`;
const refusalForms = {
  status: 400,
  headers: [['x-request-id', 'req_3'], ['x-echo', `token ${spellings}`]],
  bodyChunks: [JSON.stringify({ error: { type: 'invalid_request_error', message: `the credential ${spellings} was refused for this account` } })],
};
await rec.run('unexpected-response-redacts-the-credential-in-each-spelling-it-echoes', `${SRC}:28`, { refusal: refusalForms, accessToken: ODD_TOKEN }, () => handshake(refusalForms, { ...AUTH, access_token: ODD_TOKEN }));
await rec.finish();
