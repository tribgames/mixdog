#!/usr/bin/env node
// anthropic-api-key-fetch.test.mjs, the cases the gzip golden of branch tests-session-providers (native/core/fixtures/anthropic-request-gzip) excludes: :38 a
// Headers-instance request, :48 the count_tokens / kill-switch requests, :74 the provider wiring of the official, custom-baseURL, gateway and custom-name
// clients, :130 a compressor that throws, :156 compression awaited off the main thread. The product's own `createAnthropicApiKeyFetch` and the provider
// clients' `client.fetch` send through the global fetch to the scripted loopback endpoint: every request is recorded as it arrived (origin the product
// addressed, path, header pairs in arrival order, body bytes - the gzip bytes where the product compressed).
//   node benchmarks/rust-core/recorders/record-anthropic-api-key-fetch-rest.mjs --tree <exact export of b6f10295a>
import { gzipSync } from 'node:zlib';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-anthropic-api-key-fetch-rest',
  entry: 'src/runtime/agent/orchestrator/providers/anthropic-api-key-fetch.mjs createAnthropicApiKeyFetch({ compress }) with the global fetch, anthropic.mjs AnthropicProvider({ apiKey, baseURL, name }).client.fetch, wire-gateway.mjs GatewayMessagesEngine({ apiKey, name, baseURL }).client.fetch. The compress callback of :130/:156 is a scripted function (recorded as its behaviour). Not run: a live Anthropic endpoint.',
  compare: 'mixdog-ai providers::anthropic transport (the gzip lane of the Messages request, registry/builder.rs custom_messages_engine for the gateway/custom clients): send each case\'s request and compare `requests` (origin, path, every header in order, body bytes) and `result`.',
  replay: 'Rust entry (pub, on o1): mixdog_ai::providers::anthropic::AnthropicAdapter (anthropic/adapter.rs:169) with AnthropicCodec (anthropic/codec.rs:148), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75); the custom and gateway clients are built by mixdog_ai::registry DefaultProviderBuilder::build (registry/builder.rs:1295). Not callable in Rust (work for the Rust side): a request that arrives as a Headers instance (:38) and an injected compressor (:130, :156): Rust has one compressor on a CPU lane (searched mixdog-ai/src/providers/anthropic and transport).',
});
const P = 'agent/orchestrator/providers/';
const { createAnthropicApiKeyFetch } = await rec.P(`${P}anthropic-api-key-fetch.mjs`);
const { AnthropicProvider } = await rec.P(`${P}anthropic.mjs`);
const { GatewayMessagesEngine } = await rec.P(`${P}wire-gateway.mjs`);
const { anthropicGzipLatch } = await rec.raw(`${P}lib/request-compression.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/anthropic-api-key-fetch.test.mjs';
const OFFICIAL = 'https://api.anthropic.com/v1/messages';
const big = () => JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'x'.repeat(16 * 1024) }] });
const post = (body, headers = { 'content-type': 'application/json' }) => ({ method: 'POST', headers, body });
const statuses = async (responses) => Promise.all(responses.map(async (r) => ({ response: r, text: await r.clone().text() })));
const fresh = async (net, fn) => {
  anthropicGzipLatch.reset();
  delete process.env.MIXDOG_ANTHROPIC_REQ_GZIP;
  net.reply = () => ({ status: 200, contentType: 'application/json', body: '{}' });
  return fn();
};

await rec.run('headers-instance-headers-supported-and-content-length-dropped', `${SRC}:38`, { url: `${OFFICIAL}?beta=true`, headers: new Headers({ 'content-length': '99', a: 'b' }) }, ({ net }) => fresh(net, async () => {
  const fetchFn = createAnthropicApiKeyFetch({});
  return { response: (await statuses([await fetchFn(`${OFFICIAL}?beta=true`, post(big(), new Headers({ 'content-length': '99', a: 'b' })))]))[0] };
}));
await rec.run('small-body-count-tokens-and-kill-switch-not-compressed', `${SRC}:48`, { requests: ['small body to /v1/messages', 'big body to /v1/messages/count_tokens', 'big body to /v1/messages with MIXDOG_ANTHROPIC_REQ_GZIP=0'] }, ({ net }) => fresh(net, async () => {
  const fetchFn = createAnthropicApiKeyFetch({});
  const out = [];
  out.push(await fetchFn(OFFICIAL, post('{"a":1}')));
  out.push(await fetchFn('https://api.anthropic.com/v1/messages/count_tokens', post(big())));
  process.env.MIXDOG_ANTHROPIC_REQ_GZIP = '0';
  out.push(await fetchFn(OFFICIAL, post(big())));
  return { responses: await statuses(out) };
}));
await rec.run('provider-wiring-official-compresses-custom-and-gateway-do-not', `${SRC}:74`, { clients: ['AnthropicProvider({ apiKey })', 'AnthropicProvider({ apiKey, baseURL: https://proxy.example.com })', 'GatewayMessagesEngine({ apiKey, name: deepseek, baseURL: https://api.deepseek.com/anthropic })', 'AnthropicProvider({ apiKey, name: custom-x, baseURL: https://api.anthropic.com })'] }, ({ net }) => fresh(net, async () => {
  const out = [];
  const official = new AnthropicProvider({ apiKey: 'fixture-key' });
  out.push(await official.client.fetch(OFFICIAL, post(big())));
  const custom = new AnthropicProvider({ apiKey: 'fixture-key', baseURL: 'https://proxy.example.com' });
  out.push(await custom.client.fetch('https://proxy.example.com/v1/messages', post(big())));
  const gateway = new GatewayMessagesEngine({ apiKey: 'fixture-key', name: 'deepseek', baseURL: 'https://api.deepseek.com/anthropic' });
  out.push(await gateway.client.fetch('https://api.deepseek.com/anthropic/v1/messages', post(big())));
  const custom2 = new AnthropicProvider({ apiKey: 'fixture-key', name: 'custom-x', baseURL: 'https://api.anthropic.com' });
  out.push(await custom2.client.fetch(OFFICIAL, post(big())));
  return { responses: await statuses(out) };
}));
function compress() { return Promise.reject(new Error('boom')); }
await rec.run('compression-that-throws-fails-open-to-the-plain-body', `${SRC}:130`, { compress: 'an async function that rejects with Error("boom")', url: OFFICIAL }, ({ net }) => fresh(net, async () => {
  const fetchFn = createAnthropicApiKeyFetch({ compress });
  return { response: (await statuses([await fetchFn(OFFICIAL, post(big()))]))[0] };
}));
await rec.run('async-compress-is-awaited-request-waits-for-it', `${SRC}:156`, { compress: 'an async function that waits for a gate, then returns gzipSync(raw)', steps: ['call fetch', 'one event-loop turn: no request has arrived', 'release the gate'] }, ({ net }) => fresh(net, async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchFn = createAnthropicApiKeyFetch({ compress: async (raw) => { await gate; return gzipSync(raw); } });
  const pending = fetchFn(OFFICIAL, post(big()));
  await new Promise((resolve) => setImmediate(resolve));
  const requestsBeforeRelease = net.records.length;
  release();
  const response = (await statuses([await pending]))[0];
  return { requestsBeforeRelease, response };
}));
await rec.finish();
