#!/usr/bin/env node
// Anthropic model listing (WP-AI-ANTHROPIC): Node's REAL `listModels` request
// on both routes (a stubbed global fetch records it; no network, no
// credential) and Node's REAL `_normalizeAnthropicModel` of each route on one
// scripted `/v1/models` roster. The two routes normalize differently (the
// OAuth normalizer derives `releaseDate` and a `latest` mark; the API-key one
// reads more alias fields), so each is recorded on its own.
//
//   node benchmarks/rust-core/recorders/record-anthropic-models.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/anthropic-models/cases.json. It lives
// inside `providers/`, so record-providers.mjs must call `recordAnthropicModels`
// before its manifest write, as for the other anthropic-* sets.
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const ok = (supported) => ({ supported });

// One `/v1/models` page. Row order matters: it is the order the list is returned in.
const ROSTER = [
  {
    id: 'claude-opus-5-20260101',
    display_name: 'Claude Opus 5',
    max_input_tokens: 1000000,
    max_tokens: 128000,
    capabilities: {
      effort: { supported: true, low: ok(true), medium: ok(true), high: ok(true), xhigh: ok(true), max: ok(true) },
      thinking: { supported: true, types: { adaptive: ok(true), enabled: ok(false) } },
    },
  },
  {
    id: 'claude-opus-5',
    display_name: 'Claude Opus 5',
    max_input_tokens: 1000000,
    capabilities: { effort: { supported: true, low: ok(true), high: ok(true) } },
  },
  // Blanket effort support without a per-level map: the ladder comes from the id's generation.
  { id: 'claude-opus-4-8', capabilities: { effort: true, thinking: ok(true) } },
  { id: 'claude-opus-4-6', capabilities: { effort: { supported: true } } },
  { id: 'claude-opus-4-5', capabilities: { effort: { supported: true } } },
  // Control keys ride the effort map; they are never levels.
  {
    id: 'claude-sonnet-4-6',
    context_window: 900000,
    max_context_window: 800000,
    max_input_tokens: 700000,
    max_output_tokens: 64000,
    capabilities: { effort: { supported: true, enabled: true, default: true, high: true, low: true, medium: false } },
  },
  // Thinking only: a thinking capability without effort still reasons.
  {
    id: 'claude-sonnet-4-5-20250929',
    max_tokens: 64000,
    max_output_tokens: 1,
    capabilities: { thinking: { supported: true, types: { enabled: { supported: true } } } },
  },
  // No capabilities at all.
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200000 },
  // A one-segment version: `-20250514` is a release date, never a minor version.
  { id: 'claude-opus-4-20250514', max_input_tokens: 200000 },
  { id: 'claude-3-7-sonnet-20250219', max_input_tokens: 200000, capabilities: { thinking: true } },
  { id: 'claude-sonnet-5-5-2026-01-01', max_input_tokens: 1000000 },
  // Effort map that enumerates nothing and does not claim blanket support.
  { id: 'claude-quasar-7', max_input_tokens: 750000, capabilities: { effort: { supported: false, low: ok(false) } } },
  // Alias fields only the API-key normalizer reads.
  { name: 'claude-by-name', max_input_tokens: 1000 },
  { model: 'claude-by-model', displayName: 'By model', inputTokenLimit: 2000, outputTokenLimit: 300 },
  { id: 'claude-camel', display: 'Camel', input_token_limit: 4000, output_token_limit: 500 },
  { id: 'not-a-claude-id', max_input_tokens: 32000 },
  // No window stated: the release-generation default (1M from version 5, and opus/sonnet 4.6-4.8).
  { id: 'claude-opus-4-7' },
  { id: 'claude-sonnet-4-8-20270101' },
  { id: 'claude-fable-5-1' },
  { id: 'claude-opus-4-60' },
  { display_name: 'no id at all' },
];

// A gateway's configured headers: two new ones, and two that collide with defaults.
const EXTRA_HEADERS = { 'x-gateway-tenant': 'fixture-tenant', 'anthropic-version': '2099-01-01', 'x-api-key': 'extra-key', 'anthropic-beta': 'extra-beta' };

export async function recordAnthropicModels(tree, outFile) {
  const dataDir = mkdtempSync(join(tmpdir(), 'bench-anthropic-models-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  writeFileSync(
    join(dataDir, 'anthropic-oauth-credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-token',
        refreshToken: 'fixture-refresh-token',
        expiresAt: Date.now() + 10 * 365 * 24 * 3600 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
      },
    })
  );

  // Every /v1/models call is answered with the roster; anything else (catalog
  // enrichment looking for metadata) is a 404 and records nothing.
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1')) return realFetch(input, init);
    if (!/\/v1\/models(?:\?|$)/.test(url)) return new Response('not found', { status: 404 });
    sent.push({
      method: init.method ?? 'GET',
      url,
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
    });
    return new Response(JSON.stringify({ data: ROSTER, has_more: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const messages = await importFrom(tree, `${P}/anthropic-messages.mjs`);
    const resolve = await importFrom(tree, `${P}/anthropic-model-resolve.mjs`);
    const { AnthropicProvider } = await importFrom(tree, `${P}/anthropic.mjs`);
    const { AnthropicOAuthProvider } = await importFrom(tree, `${P}/anthropic-oauth.mjs`);

    // The request each route's real listModels sent.
    sent.length = 0;
    await new AnthropicProvider({
      apiKey: 'fixture-key-not-a-credential',
      baseURL: 'https://gateway.example.invalid/',
    }).listModels();
    const apiRequest = sent.splice(0);
    await new AnthropicProvider({ apiKey: 'fixture-key-not-a-credential' }).listModels();
    const apiDefaultRequest = sent.splice(0);

    // `extraHeaders` on the API-key route: the listing, and a messages send
    // (the SDK's default headers). A configured header replaces a default of
    // the same name; the request's own anthropic-beta wins over an extra one.
    sent.length = 0;
    await new AnthropicProvider({
      apiKey: 'fixture-key-not-a-credential',
      baseURL: 'https://gateway.example.invalid',
      extraHeaders: EXTRA_HEADERS,
    }).listModels();
    const extraListing = sent.splice(0);
    const messageHeaders = [];
    const server = http.createServer(async (req, res) => {
      for await (const _ of req);
      messageHeaders.push(req.headers);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      );
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    await new AnthropicProvider({
      apiKey: 'fixture-key-not-a-credential',
      baseURL: `http://127.0.0.1:${server.address().port}`,
      maxRetries: 0,
      extraHeaders: EXTRA_HEADERS,
    }).send([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6', [], {});
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    const picked = (h) => Object.fromEntries(Object.keys(EXTRA_HEADERS).map((k) => [k.toLowerCase(), h[k.toLowerCase()] ?? null]).concat([['anthropic-beta', h['anthropic-beta'] ?? null]]));
    const extraMessages = { model: 'claude-sonnet-4-6', headers: picked(messageHeaders.at(-1)) };
    const oauthProvider = new AnthropicOAuthProvider({});
    const listed = await oauthProvider.listModels();
    const oauthRequest = sent.splice(0);

    // What each route's normalizer makes of every roster row. The OAuth route
    // marks the highest version per family `latest` in a second pass over the
    // whole list; `listed` (the real listModels result) checks that the pass
    // below, made on the unenriched rows, is the same one.
    const api = ROSTER.map((raw) => messages._normalizeAnthropicModel(raw, 'anthropic'));
    const oauth = ROSTER.map((raw) => resolve._normalizeAnthropicModel(raw));
    const byFamily = new Map();
    for (const row of oauth) {
      if (!row || row.tier !== 'version') continue;
      const best = byFamily.get(row.family);
      if (!best || resolve._compareVersion(row.id, best.id) > 0) byFamily.set(row.family, row);
    }
    for (const row of byFamily.values()) row.latest = true;
    for (const row of listed) {
      const mine = oauth.find((m) => m?.id === row.id);
      if (mine && mine.latest !== (row.latest === true)) throw new Error(`latest mark differs for ${row.id}`);
      // The catalog merge keeps the window the normalizer set (stated, else the default).
      if (mine && mine.contextWindow !== row.contextWindow) throw new Error(`final window differs for ${row.id}`);
    }

    writeJson(outFile, {
      recorder: 'benchmarks/rust-core/recorders/record-anthropic-models.mjs',
      roster: ROSTER,
      requests: {
        anthropic: apiRequest,
        'anthropic-default-base': apiDefaultRequest,
        'anthropic-extra-headers': extraListing,
        'messages-extra-headers': extraMessages,
        'anthropic-oauth': oauthRequest,
      },
      // Row i of `expected.<route>` is what the route's normalizer returns for roster row i (null: dropped).
      expected: { anthropic: api, 'anthropic-oauth': oauth },
    });
    return ROSTER.length * 2 + 3;
  } finally {
    globalThis.fetch = realFetch;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  const tree = resolveTree(args);
  const count = await recordAnthropicModels(tree, join(FIXTURES_ROOT, 'providers', 'anthropic-models', 'cases.json'));
  console.log(`recorded ${count} anthropic model-listing cases; providers/MANIFEST.json is regenerated by P0-BENCH`);
  process.exit(0);
}
