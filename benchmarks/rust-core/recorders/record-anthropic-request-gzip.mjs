#!/usr/bin/env node
// Records what Node's Anthropic API-key fetch (`createAnthropicApiKeyFetch`, providers/anthropic-api-key-fetch.mjs over
// lib/request-compression.mjs) sends for the cases of anthropic-api-key-fetch.test.mjs, and what Node's SSE framing
// (`frameSseRegion` / `frameAndParseSse`, providers/lib/sse-framing.mjs) makes of the regions of lib/sse-framing.test.mjs
// written with Anthropic events as payloads.
//
//   node benchmarks/rust-core/recorders/record-anthropic-request-gzip.mjs --tree <exact export of b6f10295a with node_modules>
//
// Output: native/core/fixtures/anthropic-request-gzip/golden.json (+ MANIFEST.json).
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-anthropic-request-gzip.mjs';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const { recorderProvenance } = await import('./lib/provenance.mjs');
const args = parseArgs();
const tree = resolveTree(args);
const identity = nodeTreeIdentity(args, tree, NODE_COMMIT);
const P = 'src/runtime/agent/orchestrator/providers';
const { createAnthropicApiKeyFetch } = await importFrom(tree, `${P}/anthropic-api-key-fetch.mjs`);
const { anthropicGzipLatch, REQ_COMPRESSION_MIN_BYTES } = await importFrom(tree, `${P}/lib/request-compression.mjs`);
const { frameAndParseSse, frameSseRegion } = await importFrom(tree, `${P}/lib/sse-framing.mjs`);

// --- anthropic-api-key-fetch.test.mjs ---------------------------------------------------------------------------
// A send is described by what the replay can compare on either side: its base URL, the Content-Encoding it carried,
// and whether its body is the request's bytes gzipped or as they are.
const SMALL = 'small';
const LARGE = 'large';
const bodyOf = (size) => JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: size === LARGE ? 'x'.repeat(16 * 1024) : 'hi' }] });

async function scenario(name, { sends, statuses = () => 200, env = null, extraHeaders = null }) {
  anthropicGzipLatch.reset();
  delete process.env.MIXDOG_ANTHROPIC_REQ_GZIP;
  if (env !== null) process.env.MIXDOG_ANTHROPIC_REQ_GZIP = env;
  const calls = [];
  const fetchFn = createAnthropicApiKeyFetch({
    baseFetch: async (url, init) => {
      calls.push({ url, init });
      return new Response('{}', { status: statuses(calls.length) });
    },
  });
  const results = [];
  for (const send of sends) {
    const raw = bodyOf(send.size);
    const headers = { 'content-type': 'application/json', ...(extraHeaders ?? {}) };
    const before = calls.length;
    const response = await fetchFn(`${send.base}/v1/messages`, { method: 'POST', headers, body: raw });
    results.push({
      base: send.base,
      size: send.size,
      status: response.status,
      sent: calls.slice(before).map((call) => {
        const encodingKey = Object.keys(call.init.headers).find((k) => k.toLowerCase() === 'content-encoding');
        const encoding = encodingKey === undefined ? null : call.init.headers[encodingKey];
        const body = typeof call.init.body === 'string' ? (call.init.body === raw ? 'plain' : 'other') : gunzipSync(call.init.body).toString('utf8') === raw ? 'gzip' : 'other';
        return { encoding, body };
      }),
    });
  }
  delete process.env.MIXDOG_ANTHROPIC_REQ_GZIP;
  return { name, env, extraHeaders, statuses: calls.map((_, i) => statuses(i + 1)), sends: results, latched: anthropicGzipLatch.disabled() };
}

const OFFICIAL = 'https://api.anthropic.com';
const gzip = [
  await scenario('official origin: a large body is gzipped', { sends: [{ base: OFFICIAL, size: LARGE }] }),
  await scenario('a small body is not compressed', { sends: [{ base: OFFICIAL, size: SMALL }] }),
  await scenario('the kill switch turns compression off', { env: '0', sends: [{ base: OFFICIAL, size: LARGE }] }),
  await scenario('custom bases and look-alike origins are never compressed', {
    sends: ['https://proxy.example.com', 'http://api.anthropic.com', 'https://api.anthropic.com.evil.test', 'https://api.anthropic.com:8443', 'http://localhost:8080'].map((base) => ({ base, size: LARGE })),
  }),
  ...(await Promise.all([])),
];
for (const status of [400, 415]) {
  gzip.push(await scenario(`${status} on a gzipped request: one plain resend, latch after it succeeds`, { statuses: (n) => (n === 1 ? status : 200), sends: [{ base: OFFICIAL, size: LARGE }, { base: OFFICIAL, size: LARGE }] }));
}
gzip.push(await scenario('no latch when the plain resend also fails; its response is returned', { statuses: (n) => (n === 1 ? 400 : n === 2 ? 401 : 200), sends: [{ base: OFFICIAL, size: LARGE }, { base: OFFICIAL, size: LARGE }] }));
gzip.push(await scenario('a request that already has Content-Encoding is not double-encoded', { extraHeaders: { 'content-encoding': 'br' }, sends: [{ base: OFFICIAL, size: LARGE }] }));

// --- lib/sse-framing.test.mjs -----------------------------------------------------------------------------------
const delta = (text) => JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const regions = [
  `event:content_block_delta\ndata:${delta('a')}\n\nevent: content_block_delta\ndata: ${delta('b')}\n\n`,
  `: ping\nid: 7\ndata:\ndata: \nretry: 5\ndata:${delta('c')}\n`,
  `data:${delta('d')}\n`,
];
let carry = '';
const framing = regions.map((region) => {
  const framed = frameSseRegion(region, carry);
  const parsed = frameAndParseSse(region, carry);
  carry = framed.currentEvent;
  return { region, frames: framed.frames, currentEvent: framed.currentEvent, events: parsed.events };
});

const finalDir = join(FIXTURES_ROOT, 'anthropic-request-gzip');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's Anthropic API-key fetch and SSE framing at ${NODE_COMMIT} over their unit tests' cases`, minBytes: REQ_COMPRESSION_MIN_BYTES, gzip, framing });
writeSetManifest(stage, {
  set: 'anthropic-request-gzip',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    tests: [`${P}/anthropic-api-key-fetch.test.mjs (:28, :48, :62, :100, :117, :128, :152)`, `${P}/lib/sse-framing.test.mjs (every case)`],
    exclusions: {
      body: "each body is the test's 16 KiB (or tiny) JSON; the replay sends a request of the same size class through the Rust codec, so a body is compared as gzip-of-the-request or the request itself",
      countTokens: ':48 also sends /v1/messages/count_tokens; the Rust adapter has no count_tokens send',
      headersInstance: ':38 is the fetch `Headers` object (no counterpart: headers are a list)',
      providerWiring: ':74 custom-name and gateway Messages engines: Rust builds them as an HttpAdapter that never compresses (registry/builder.rs custom_messages_engine); the official and custom-base adapters are replayed here',
      compressFailure: ':137 injects a throwing compressor; the Rust gzip lane has no injection point',
      offThread: ':156 asserts the compressor is awaited off the main thread; the Rust compressor is a CPU-lane job by construction',
      sseFraming: 'the test regions are written with Anthropic content_block_delta payloads so the Rust decoder (its consumer) yields them as text',
    },
  },
});
commitStage(stage, finalDir);
console.log(`gzip=${gzip.length} framing=${framing.length}`);
