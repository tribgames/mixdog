#!/usr/bin/env node
// Model listings of grok-oauth, cursor-api, devin-oauth and mixdog-local
// (WP-AI-LISTING-MISC): Node's REAL `listModels` of each provider, driven
// against a stubbed network (no credential, no provider call), and the rows it
// returns. Rust replays the same scripted answers and must produce the same rows.
//
//   node benchmarks/rust-core/recorders/record-listing-misc.mjs [--tree <dir>]
//
// Output: native/core/fixtures/providers/{grok,cursor,devin,local}-models/cases.json,
// and the reviewed Devin family table the Rust side loads as data
// (crates/mixdog-ai/src/providers/devin/reviewed_families.json).
// They live inside `providers/`: record-providers.mjs calls `recordListingMisc`
// before its manifest write; run alone, this re-lists providers/MANIFEST.json.
//
// What is recorded is the provider's own listing: the shared catalog enrichment
// is answered "not found" (it is the catalog's), and the shared sanitizer must
// leave every row in place (checked below), so each `expected` is the
// provider-native row list. The Cursor and Devin cases also record what a turn
// sends: the model resolved per requested id and ask (`resolutions`), and the
// wire uid per model and effort (`wire`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, importFrom, parseArgs, refreshSetManifest, resolveTree, writeJson } from './lib/common.mjs';

const P = 'src/runtime/agent/orchestrator/providers';
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------
// grok-oauth
// ---------------------------------------------------------------------------

// api.x.ai answers first in each pair, the Grok CLI proxy second. A status
// replaces the body; `rows` is what the listing must hold.
const GROK_CASES = {
  merge: {
    api: [
      { id: 'grok-4.3', created: 20, context_length: 1000000 },
      { id: 'grok-4.20', created: 10 },
      { id: 'grok-image-1', created: 99 },
      { id: 'grok-video-1' },
      { id: '' },
      { created: 5 },
    ],
    proxy: [
      { id: 'grok-4.3', created: 1, name: 'Proxy Name', context_window: 400000 },
      { id: 'grok-4.7-build-fast', created: 100 },
    ],
  },
  efforts: {
    api: [
      { id: 'grok-4.5-non-reasoning-0309', context_length: 500000 },
      { id: 'grok-4.5-multi-agent-0309', reasoningEfforts: ['LOW', { value: 'xhigh' }, 'low', 'invalid'] },
      { id: 'grok-9-caps', capabilities: { reasoning_effort: ['none', 'low', 'high', 'unknown'] } },
      { id: 'grok-9-bare' },
      { id: 'grok-build-0.1' },
      { id: 'grok-display', display: 'Custom Display' },
      { id: 'grok-custom', name: 'Native Name' },
      { id: 'grok-4.6', created: 30 },
    ],
    proxy: [
      {
        id: 'grok-4.7-build-fast',
        name: 'Grok 4.7 Fast',
        context_window: 500000,
        reasoning_efforts: [{ value: 'xhigh' }, { value: 'high' }, { value: 'medium' }, { value: 'low' }],
      },
      { id: 'grok-9-meta', _meta: { reasoningEfforts: ['max', 'medium'] }, context_window: 262144 },
    ],
  },
  proxyUnavailable: { api: [{ id: 'grok-4.6' }, { id: 'grok-4.2' }], proxyStatus: 503 },
  proxyBadShape: { api: [{ id: 'grok-4.6', created: 7 }], proxyBody: {} },
  apiUnavailable: { apiStatus: 503, proxy: [{ id: 'grok-4.6' }] },
  apiBadShape: { apiBody: {}, proxy: [] },
};

async function recordGrok(tree, outFile) {
  const dataDir = mkdtempSync(join(tmpdir(), 'bench-grok-models-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  process.env.MIXDOG_DISABLE_LIVE_CLI_VERSIONS = '1';
  writeFileSync(
    join(dataDir, 'grok-oauth.json'),
    JSON.stringify({
      access_token: 'fixture-grok-access',
      refresh_token: 'fixture-grok-refresh',
      expires_at: Date.now() + 10 * 365 * 24 * 3600 * 1000,
    })
  );
  const sent = [];
  let script = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const side = url === 'https://api.x.ai/v1/models' ? 'api' : url === 'https://cli-chat-proxy.grok.com/v1/models' ? 'proxy' : null;
    if (!side) return new Response('not found', { status: 404 });
    sent.push({
      side,
      method: init.method ?? 'GET',
      url,
      redirect: init.redirect ?? null,
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
    });
    const status = script[`${side}Status`];
    if (status) return jsonResponse({}, status);
    return jsonResponse(script[`${side}Body`] ?? { data: script[side] ?? [] });
  };
  try {
    const { GrokOAuthProvider } = await importFrom(tree, `${P}/grok-oauth.mjs`);
    const { flushModelCacheWrites } = await importFrom(tree, `${P}/model-cache.mjs`);
    const cases = {};
    for (const [name, scripted] of Object.entries(GROK_CASES)) {
      script = scripted;
      sent.length = 0;
      // The previous case's roster is the cache; listModels reads it first.
      await flushModelCacheWrites();
      rmSync(join(dataDir, 'grok-oauth-models.json'), { force: true });
      const provider = new GrokOAuthProvider({ preconnect: false });
      let expected = null;
      let error = null;
      try {
        expected = plain(await provider.listModels());
      } catch (e) {
        error = String(e?.message ?? e);
      }
      // The shared sanitizer must not have dropped or merged a chat row.
      if (expected) {
        const wanted = new Set(
          [...(scripted.api ?? []), ...(scripted.proxy ?? [])].map((m) => m.id).filter((id) => id && !/imagine|image|video/i.test(id))
        );
        const got = new Set(expected.map((m) => m.id));
        if (wanted.size !== got.size || [...wanted].some((id) => !got.has(id))) {
          throw new Error(
            `grok case ${name}: the shared sanitizer changed the roster: dropped ${[...wanted].filter((id) => !got.has(id))}`
          );
        }
      }
      cases[name] = { script: scripted, requests: sent.splice(0), expected, error };
    }
    writeJson(outFile, { recorder: 'benchmarks/rust-core/recorders/record-listing-misc.mjs', cases });
    return Object.keys(cases).length;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// cursor-api
// ---------------------------------------------------------------------------

const enumValue = (value, displayName, extra = {}) => ({ value, ...(displayName ? { displayName } : {}), ...extra });
const enumDef = (id, name, values) => ({ id, name, parameterType: { enumParameter: { values } } });
const boolDef = (id, name, values = [enumValue('true', 'On'), enumValue('false', 'Off')]) => ({
  id,
  name,
  parameterType: { booleanParameter: { values } },
});
const variant = (parameters, extra = {}) => ({
  parameterValues: Object.entries(parameters).map(([id, value]) => ({ id, value })),
  ...extra,
});

const CURSOR_ROSTER = [
  // Auto under its old id; folded to `auto`, listed first.
  { name: 'default', clientDisplayName: 'Default', contextTokenLimit: 200000, supportsNonMaxMode: true },
  // Effort + fast + a context axis; two max-mode variants.
  {
    name: 'claude-opus-5',
    clientDisplayName: 'Claude Opus 5',
    tagline: 'Claude Opus 5 · <b>Deep</b> reasoning with a 1m context window',
    supportsThinking: true,
    supportsImages: true,
    supportsMaxMode: true,
    supportsNonMaxMode: true,
    contextTokenLimit: 200000,
    contextTokenLimitForMaxMode: 1000000,
    legacySlugs: ['claude-opus-5-high'],
    parameterDefinitions: [
      enumDef('effort', 'Effort', [
        enumValue('low', 'Low'),
        enumValue('medium', 'Medium'),
        enumValue('high', 'High'),
        enumValue('extra-high', 'Extra High'),
        enumValue('max', 'Max', { blockedByAdminAllowlist: true }),
      ]),
      boolDef('fast', 'Fast'),
      enumDef('context', 'Context', [enumValue('200k', '200K'), enumValue('1m', '1M')]),
    ],
    variants: [
      variant({ effort: 'low', fast: 'false', context: '200k' }),
      variant({ effort: 'high', fast: 'false', context: '200k' }, { isDefaultNonMaxConfig: true, legacySlug: 'claude-opus-5-high' }),
      variant({ effort: 'high', fast: 'true', context: '200k' }),
      variant({ effort: 'extra-high', fast: 'false', context: '200k' }),
      variant({ effort: 'high', fast: 'false', context: '1m' }, { isMaxMode: true, isDefaultMaxConfig: true }),
      variant({ effort: 'high', fast: 'true', context: '1m' }, { isMaxMode: true }),
    ],
  },
  // Not hidden-from-picker: dropped.
  { name: 'secret-model', isHidden: true, supportsNonMaxMode: true },
  // Max-only model: reports its max-mode window.
  {
    name: 'gpt-5.6-sol',
    inputboxShortModelName: 'GPT-5.6 Sol',
    supportsMaxMode: true,
    contextTokenLimit: 272000,
    contextTokenLimitForMaxMode: 1050000,
    tooltipData: { primaryText: 'GPT-5.6 Sol', secondaryText: 'Secondary text', markdownContent: '**GPT-5.6 Sol** (new) · [docs](https://example.invalid) · 1.5m context window' },
    parameterDefinitions: [
      enumDef('reasoning_effort', 'Reasoning', [enumValue('minimal'), enumValue('medium'), enumValue('high')]),
      boolDef('thinking', 'Thinking'),
    ],
    variants: [
      variant({ reasoning_effort: 'medium', thinking: 'true' }, { isMaxMode: true, isDefaultMaxConfig: true }),
      variant({ reasoning_effort: 'high', thinking: 'false' }, { isMaxMode: true }),
    ],
  },
  // The server's own name instead of `name`; description from the secondary text.
  {
    serverModelName: 'grok-4.6',
    clientDisplayName: 'Grok 4.6',
    supportsNonMaxMode: true,
    autoContextMaxTokens: 128000,
    autoContextExtendedMaxTokens: 256000,
    supportsThinking: true,
    tooltipData: { secondaryText: 'xAI · 128k context window' },
    idAliases: ['grok-4-6', 'grok-4.6'],
    parameterDefinitions: [enumDef('fast', 'Fast', [enumValue('on'), enumValue('off')])],
  },
  // A weaker entry with the same id, then a richer one: the richer wins, at the first position.
  { name: 'dup-model', clientDisplayName: 'Dup A', supportsNonMaxMode: true },
  { name: 'dup-model', clientDisplayName: 'Dup B', parameterDefinitions: [enumDef('fast', 'Fast', [enumValue('true')])], supportsNonMaxMode: true },
  // A parameter axis that is neither effort nor fast; a definition without values is dropped.
  {
    name: 'composer-2.5',
    clientDisplayName: 'Composer 2.5',
    supportsNonMaxMode: true,
    contextTokenLimit: 0,
    parameterDefinitions: [
      enumDef('tier', 'Tier', [enumValue('Standard', 'Standard'), enumValue('Pro ', 'Pro')]),
      enumDef('empty', 'Empty', []),
      enumDef('', 'No id', [enumValue('x')]),
    ],
    variants: [variant({ tier: 'Standard' }, { isDefaultNonMaxConfig: true }), variant({ tier: 'Pro ' })],
  },
  // No parameters, no mode flags: named by their ids. The ids sharing a base are one row.
  { name: 'plain-model', clientDisplayName: 'Plain Model Fast', supportsThinking: true, supportsImages: true, tagline: 'ignored' },
  { name: 'zen-3-low', clientDisplayName: 'Zen 3 Low', contextTokenLimit: 123000 },
  { name: 'zen-3-high', clientDisplayName: 'Zen 3 High' },
  { name: 'zen-3-high-fast', clientDisplayName: 'Zen 3 High Fast' },
  { name: 'zen-3-extra-high', clientDisplayName: 'Zen 3 Extra High' },
  { name: 'zen-3', clientDisplayName: 'Zen 3' },
  // The thinking marker in the middle of the id and at its end: one base.
  { name: 'mist-thinking-medium', clientDisplayName: 'Mist Medium Thinking', supportsThinking: true },
  { name: 'mist-high-thinking', clientDisplayName: 'Mist High Thinking' },
  { name: 'mist-thinking-high-fast', clientDisplayName: 'Mist High Thinking Fast' },
  { name: 'mist-thinking', clientDisplayName: 'Mist Thinking' },
  // Only a fast id and a max id: the preferred one describes the row.
  { name: 'solo-fast', clientDisplayName: 'Solo Fast' },
  { name: 'solo-max', clientDisplayName: 'Solo Max' },
  // Suffixes are lowercase.
  { name: 'Case-Model-HIGH', clientDisplayName: 'Case Model HIGH' },
  // Its base is a parameterized model: the group is not a row of its own.
  { name: 'claude-opus-5-low', clientDisplayName: 'Claude Opus 5 Low' },
];

// Auto described by nothing: a plain id-named model like any other.
const CURSOR_PLAIN_AUTO_ROSTER = [
  { name: 'default', clientDisplayName: 'Default' },
  { name: 'zen-3-low', clientDisplayName: 'Zen 3 Low' },
  { name: 'zen-3-high', clientDisplayName: 'Zen 3 High' },
];

// What a request names and asks, for the send path's model resolution.
const CURSOR_RESOLVE_MODELS = [
  '', 'auto', 'default', 'zen-3', 'zen-3-low', 'zen-3-high', 'zen-3-high-fast', 'zen-3-extra-high', 'zen-3-medium',
  'mist-thinking', 'mist-thinking-medium', 'mist-high-thinking', 'mist-thinking-high-fast', 'solo', 'solo-fast', 'solo-max',
  'Case-Model-HIGH', 'Case-Model', 'claude-opus-5', 'claude-opus-5-high', 'claude-opus-5-low', 'gpt-5.6-sol', 'grok-4.6',
  'grok-4-6', 'dup-model', 'composer-2.5', 'plain-model', 'unknown-model', 'unknown-model-high',
];
const CURSOR_RESOLVE_ASKS = [
  {},
  { effort: 'low' },
  { effort: 'high' },
  { effort: 'xhigh' },
  { effort: 'LOW' },
  { effort: '  ' },
  { fast: true },
  { effort: 'medium', fast: true },
  { effort: 'high', fast: true },
  { effort: 'high', modelParameters: { context: '1m' }, selectedContextWindow: 300000 },
];

async function recordCursor(tree, outFile) {
  const requests = [];
  let answer = null;
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      requests.push({
        path: headers[':path'],
        method: headers[':method'],
        headers: Object.fromEntries(
          Object.entries(headers)
            .filter(([k]) => !k.startsWith(':') && k !== 'x-request-id')
            .map(([k, v]) => [k, String(v)])
        ),
        hasRequestId: Boolean(headers['x-request-id']),
        body: hex(Buffer.concat(chunks)),
      });
      stream.respond({ ':status': 200, 'content-type': 'application/proto' });
      stream.end(answer);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.CURSOR_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.MIXDOG_CURSOR_CLIENT_VERSION = 'cli-2026.10.22-27dcf5f';
  process.env.NO_PROXY = '127.0.0.1';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not found', { status: 404 });
  try {
    const { encodeMessage } = await importFrom(tree, `${P}/cursor-wire-protobuf.mjs`);
    const { clearModelCache } = await importFrom(tree, `${P}/cursor-wire-models.mjs`);
    const { CursorApiProvider } = await importFrom(tree, `${P}/cursor.mjs`);
    const cases = {};
    for (const [name, roster] of [['roster', CURSOR_ROSTER], ['plain-auto', CURSOR_PLAIN_AUTO_ROSTER], ['no-auto', CURSOR_ROSTER.slice(1)]]) {
      const response = encodeMessage('AvailableModelsResponse', { models: roster, useModelParameters: true });
      // The same answer wrapped in one Connect envelope (some replies are).
      const framed = Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), Buffer.from(response)]);
      framed.writeUInt32BE(response.length, 1);
      for (const [shape, bytes] of [['bare', Buffer.from(response)], ['enveloped', framed]]) {
        clearModelCache();
        requests.length = 0;
        answer = bytes;
        const provider = new CursorApiProvider({ accessToken: 'fixture-cursor-token' });
        const expected = plain(await provider.listModels());
        const recorded = { response: hex(bytes), requests: requests.splice(0), expected };
        if (shape === 'bare') {
          // The model a turn sends, per requested id and ask (`_resolveCursorModel`).
          const runtime = await provider._runtime();
          recorded.resolutions = [];
          for (const model of CURSOR_RESOLVE_MODELS) {
            for (const ask of CURSOR_RESOLVE_ASKS) {
              let outcome;
              try {
                outcome = { ok: plain(await provider._resolveCursorModel(model, ask, runtime, 'fixture-cursor-token')) };
              } catch (error) {
                outcome = { error: error.message };
              }
              recorded.resolutions.push({ model, ask, ...outcome });
            }
          }
          // What a turn then sends: the model on the chat body and the
          // `pricingModel` of the send result.
          let sentBody = null;
          provider._runtimeOverride = {
            ...runtime,
            handleChatCompletion: async (body) => {
              sentBody = body;
              const sse = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
              return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
            },
          };
          recorded.sends = [];
          for (const model of CURSOR_RESOLVE_MODELS) {
            for (const ask of [{}, { effort: 'high' }]) {
              let outcome;
              try {
                const result = await provider.send([{ role: 'user', content: 'hi' }], model, [], ask);
                outcome = { ok: { sentModel: sentBody.model, pricingModel: result.pricingModel ?? null } };
              } catch (error) {
                outcome = { error: error.message };
              }
              recorded.sends.push({ model, ask, ...outcome });
            }
          }
          requests.length = 0;
        }
        cases[`${name}-${shape}`] = recorded;
      }
    }
    // The model rows the server never marked as parameterized are not read.
    writeJson(outFile, { recorder: 'benchmarks/rust-core/recorders/record-listing-misc.mjs', provider: 'cursor-api', cases });
    return Object.keys(cases).length;
  } finally {
    globalThis.fetch = realFetch;
    server.close();
    server.closeAllConnections?.();
  }
}

// ---------------------------------------------------------------------------
// devin-oauth
// ---------------------------------------------------------------------------

const DEVIN_DISPLAY = { MODEL_ROUTER: 3, QUICK_REVIEW: 4, INTERNAL_DEFAULT: 6, NORMAL: 8 };
const features = (supportsImages, supportsToolCalls, supportsThinking, supportsParallelToolCalls = false) => ({
  supportsImages,
  supportsToolCalls,
  supportsThinking,
  supportsParallelToolCalls,
});
const devinConfig = (modelUid, label, { displayOption = DEVIN_DISPLAY.NORMAL, info = {}, ...rest } = {}) => ({
  modelUid,
  label,
  modelInfo: { displayOption, ...info },
  ...rest,
});

// Uids chosen so that no server family, reviewed family or thinking twin applies.
const DEVIN_CONFIGS = [
  devinConfig('zeta-model', ' Zeta ', {
    maxTokens: 128000,
    description: '  Zeta description  ',
    isNew: true,
    info: { maxOutputTokens: 32000, modelFeatures: features(true, true, false, true) },
  }),
  devinConfig('Alpha_Model', 'Alpha', {
    maxTokens: 0,
    isBeta: true,
    isRecommended: true,
    info: { modelFeatures: features(false, true, true) },
  }),
  devinConfig('alpha-model', '', { info: { modelFeatures: features(true, false, false) } }),
  devinConfig('beta-2', 'Beta 2', { supportsImages: true, info: { modelFeatures: features(false, true, false), maxTokens: 9 } }),
  devinConfig('beta-10', 'Beta 10', { info: { modelFeatures: features(true, true, true), maxOutputTokens: -5 } }),
  // Advertises images but its backend drops them.
  devinConfig('swe-1-6', 'SWE 1.6', { maxTokens: 64000, info: { modelFeatures: features(true, true, false) } }),
  // No features at all: tools on; images from the config itself.
  devinConfig('plain-one', 'Plain', { supportsImages: true, maxTokens: 50000 }),
  // A harness-less router is listed; a harness-backed composite is a chat uid.
  devinConfig('adaptive', 'Adaptive', { displayOption: DEVIN_DISPLAY.MODEL_ROUTER, supportsImages: true, info: { displayOption: DEVIN_DISPLAY.MODEL_ROUTER } }),
  devinConfig('composite', 'Composite', { info: { displayOption: DEVIN_DISPLAY.MODEL_ROUTER, isModelRouter: true, harnessUids: ['zeta-model'], modelFeatures: features(false, true, true) } }),
  devinConfig('fusion-only', 'Fusion only', { info: { modelFeatures: features(false, true, false) } }),
  devinConfig('fusion-lead-sidekick-other', 'Pairing', { info: { modelFeatures: features(false, true, false) } }),
  devinConfig('disabled-one', 'Disabled', { disabled: true }),
  devinConfig('quick-review', 'Quick', { displayOption: DEVIN_DISPLAY.QUICK_REVIEW, info: { displayOption: DEVIN_DISPLAY.QUICK_REVIEW } }),
  devinConfig('internal-one', 'Internal', { info: { displayOption: DEVIN_DISPLAY.INTERNAL_DEFAULT } }),
  devinConfig('zeta-model', 'Zeta again', {}),
  { label: 'no uid' },
];

// Effort siblings. A family the server declares (`modelFamilyMetadata`): the
// label names the lane, `Fast Mode` and `1M Context` are separate lanes, the
// `Effort` entry is the lane's axis and `Thinking: off` the off route.
const familyMeta = (label, entries, isDefaultModelInFamily = false) => ({
  modelFamilyMetadata: {
    modelFamilyLabel: label,
    entries: Object.entries(entries).map(([key, [order, name]]) => ({ key, value: { order, name } })),
    isDefaultModelInFamily,
  },
});
const priced = (input, denominator = '1M tokens', extra = []) => ({
  modelDimensions: [{ label: 'Input', value: input, denominator, kind: 1 }, ...extra],
});
const thinks = features(true, true, true);

const DEVIN_SERVER_FAMILIES = [
  devinConfig('falcon-nothink', 'Falcon No Thinking', { maxTokens: 100000, info: { modelFeatures: features(false, true, false) }, ...familyMeta('Falcon', { Thinking: [0, 'Off'], Effort: [1, 'Medium'] }) }),
  devinConfig('falcon-low', 'Falcon Low', { maxTokens: 200000, info: { modelFeatures: thinks }, ...familyMeta('Falcon', { Thinking: [1, 'On'], Effort: [1, 'Low'] }) }),
  devinConfig('falcon-medium', 'Falcon Medium', { maxTokens: 150000, info: { modelFeatures: thinks }, ...familyMeta('Falcon', { Thinking: [1, 'On'], Effort: [2, 'Medium'] }, true) }),
  devinConfig('falcon-high', 'Falcon High', { maxTokens: 120000, info: { modelFeatures: thinks }, ...familyMeta('Falcon', { Thinking: [1, 'On'], 'Reasoning Effort': [3, 'High'] }) }),
  // A second `Low` for the same lane: the first one keeps the route.
  devinConfig('falcon-low-again', 'Falcon Low again', { info: { modelFeatures: thinks }, ...familyMeta('Falcon', { Thinking: [1, 'On'], Effort: [1, 'Low'] }) }),
  // Fast service and 1M context are lanes of their own.
  devinConfig('falcon-fast-low', 'Falcon Fast Low', { info: { modelFeatures: thinks }, ...familyMeta('Falcon', { 'Fast Mode': [1, 'On'], Effort: [1, 'Low'] }) }),
  devinConfig('falcon-fast-high', 'Falcon Fast High', { info: { modelFeatures: thinks }, ...familyMeta('Falcon', { 'Fast Mode': [1, 'On'], Effort: [3, 'High'] }, true) }),
  devinConfig('falcon-1m-high', 'Falcon 1M High', { maxTokens: 1000000, info: { modelFeatures: thinks }, ...familyMeta('Falcon', { '1M Context': [1, 'On'], Effort: [3, 'High'] }) }),
  // A lane with only an off route stays uncollapsed; so does one with an unknown effort name.
  devinConfig('solo-off', 'Solo off', { info: { modelFeatures: features(false, true, false) }, ...familyMeta('Solo', { Thinking: [0, 'Off'] }) }),
  devinConfig('turbo-one', 'Turbo', { info: { modelFeatures: thinks }, ...familyMeta('Turbo', { Effort: [1, 'Turbo'] }) }),
  // A router is never an effort tier.
  devinConfig('router-fam', 'Router fam', { displayOption: DEVIN_DISPLAY.MODEL_ROUTER, info: { displayOption: DEVIN_DISPLAY.MODEL_ROUTER }, ...familyMeta('Router Fam', { Effort: [1, 'Low'] }) }),
  // A label without letters names no lane.
  devinConfig('no-lane', 'No lane', { info: { modelFeatures: thinks }, ...familyMeta('!!!', { Effort: [1, 'Low'] }) }),
  devinConfig('lane-plain', 'Plain lane', { info: { modelFeatures: features(true, true, false) } }),
];

// The reviewed table: ladders by uid, enum-style uids, a single-uid rename,
// routes that point at an absent member, a default member.
const REVIEWED_FEATURES = features(true, true, false);
const DEVIN_REVIEWED = [
  ...['low', 'high', 'max'].map((tier) => devinConfig(`claude-opus-5-${tier}`, `Opus ${tier}`, { maxTokens: 200000, info: { modelFeatures: REVIEWED_FEATURES } })),
  devinConfig('claude-opus-5-low-fast', 'Opus low fast', { maxTokens: 100000, info: { modelFeatures: thinks } }),
  ...['none', 'high'].map((tier) => devinConfig(`gpt-5-4-${tier}`, `GPT ${tier}`, { maxTokens: 400000, info: { modelFeatures: REVIEWED_FEATURES } })),
  devinConfig('gpt-5-4-none-priority', 'GPT none priority', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('MODEL_GPT_5_2_LOW', 'GPT 5.2 Low', { info: { modelFeatures: thinks } }),
  devinConfig('MODEL_GPT_5_2_HIGH', 'GPT 5.2 High', { info: { modelFeatures: thinks } }),
  devinConfig('MODEL_PRIVATE_11', 'Private 11', { info: { modelFeatures: thinks } }),
  devinConfig('gemini-3-7-flash-low', 'Flash low', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('gemini-3-7-flash-medium', 'Flash medium', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('glm-5-2', 'GLM', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('glm-5-2-max', 'GLM max', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('swe-1-7-medium', 'SWE medium', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('swe-1-7', 'SWE max', { info: { modelFeatures: REVIEWED_FEATURES } }),
  // The family id as a plain uid, and its thinking twin: claimed, not paired.
  devinConfig('kimi-k3', 'Kimi plain', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('kimi-k3-low', 'Kimi low', { info: { modelFeatures: thinks } }),
  devinConfig('kimi-k3-thinking', 'Kimi thinking', { info: { modelFeatures: thinks } }),
  // A member of the nemotron family whose default member is absent.
  devinConfig('nemotron-3-ultra-medium', 'Nemotron medium', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('nemotron-3-ultra-none', 'Nemotron none', { info: { modelFeatures: REVIEWED_FEATURES } }),
  devinConfig('Other-Model', 'Other', { info: { modelFeatures: REVIEWED_FEATURES } }),
];

// `X` + `X-thinking` pairs.
const DEVIN_PAIRS = [
  devinConfig('zz-chat', 'ZZ Chat', { maxTokens: 64000, info: { modelFeatures: features(false, true, false) } }),
  devinConfig('zz-chat-thinking', 'ZZ Chat Thinking', { maxTokens: 96000, info: { modelFeatures: thinks } }),
  devinConfig('mm-x', 'MM X', { info: { modelFeatures: features(false, true, false) } }),
  devinConfig('mm-reasoning-x', 'MM Reasoning X', { info: { modelFeatures: thinks } }),
  // Negated markers and longer words are not twins.
  devinConfig('cc-model', 'CC', { info: { modelFeatures: features(false, true, false) } }),
  devinConfig('cc-non-thinking-model', 'CC non', { info: { modelFeatures: features(false, true, false) } }),
  devinConfig('rr-model', 'RR', { info: { modelFeatures: features(false, true, false) } }),
  devinConfig('rr-reasoners-model', 'RR reasoners', { info: { modelFeatures: features(false, true, false) } }),
  // Different real prices: distinct SKUs. The same price, however written: one model.
  devinConfig('dd-model', 'DD', { info: { modelFeatures: features(false, true, false) }, ...priced(1) }),
  devinConfig('dd-model-thinking', 'DD Thinking', { info: { modelFeatures: features(false, true, false) }, ...priced(3) }),
  devinConfig('ee-model', 'EE', { info: { modelFeatures: features(false, true, false) }, ...priced(0.5) }),
  devinConfig('ee-model-thinking', 'EE Thinking', { info: { modelFeatures: features(false, true, false) }, ...priced(0.25, '500K tokens') }),
  // Reading stops at the Sidekick marker; one priced twin and one unpriced twin pair.
  devinConfig('ss-model', 'SS', { info: { modelFeatures: features(false, true, false) }, ...priced(2, '1M tokens', [{ label: 'Sidekick', value: 0, denominator: '', kind: 0 }, { label: 'Input', value: 9, denominator: '1M tokens', kind: 1 }]) }),
  devinConfig('ss-model-thinking', 'SS Thinking', { info: { modelFeatures: features(false, true, false) }, ...priced(2) }),
  devinConfig('uu-model', 'UU', { info: { modelFeatures: features(false, true, false) }, ...priced(2) }),
  devinConfig('uu-model-thinking', 'UU Thinking', { info: { modelFeatures: features(false, true, false) } }),
  // A server lane, then a thinking twin of the family it makes: the family wins.
  devinConfig('orbit-low', 'Orbit Low', { info: { modelFeatures: thinks }, ...familyMeta('Orbit', { Thinking: [1, 'On'], Effort: [1, 'Low'] }) }),
  devinConfig('orbit-high', 'Orbit High', { info: { modelFeatures: thinks }, ...familyMeta('Orbit', { Thinking: [1, 'On'], Effort: [3, 'High'] }) }),
  devinConfig('orbit-thinking', 'Orbit Thinking', { info: { modelFeatures: thinks } }),
];

async function recordDevin(tree, outFile) {
  const requests = [];
  let script = null;
  const fetchFn = async (url, init = {}) => {
    requests.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: hex(init.body ?? new Uint8Array()),
    });
    if (script.status) return new Response('{"code":"unauthenticated","message":"no"}', { status: script.status, headers: { 'content-type': 'application/json' } });
    return new Response(script.bytes, { status: 200, headers: { 'content-type': 'application/proto' } });
  };
  const { encodeDevinMessage } = await importFrom(tree, `${P}/devin-wire-protobuf.mjs`);
  const { DevinOAuthProvider, devinWireUid } = await importFrom(tree, `${P}/devin.mjs`);
  const { fetchDevinModels, normalizeDevinModels } = await importFrom(tree, `${P}/devin-wire-models.mjs`);
  const cases = {};
  const scenarios = [
    ['rows', { configs: DEVIN_CONFIGS, defaultModelUid: 'kimi-pick', extra: [devinConfig('kimi-pick', 'Kimi', { info: { modelFeatures: features(false, true, true) } })] }],
    ['no-default', { configs: DEVIN_CONFIGS.slice(0, 4), defaultModelUid: '' }],
    ['unauthenticated', { status: 401 }],
    ['server-families', { configs: DEVIN_SERVER_FAMILIES, defaultModelUid: '' }],
    // The account's own default is one tier of a family it routes to.
    ['server-families-account-default', { configs: DEVIN_SERVER_FAMILIES, defaultModelUid: 'falcon-high' }],
    ['reviewed-families', { configs: DEVIN_REVIEWED, defaultModelUid: '' }],
    ['reviewed-families-account-default', { configs: DEVIN_REVIEWED, defaultModelUid: 'claude-opus-5-high' }],
    ['reviewed-families-default-member', { configs: DEVIN_REVIEWED, defaultModelUid: 'gemini-3-7-flash-low' }],
    ['thinking-pairs', { configs: DEVIN_PAIRS, defaultModelUid: '' }],
    ['thinking-pairs-account-default', { configs: DEVIN_PAIRS, defaultModelUid: 'zz-chat-thinking' }],
    ['everything', { configs: [...DEVIN_CONFIGS, ...DEVIN_SERVER_FAMILIES, ...DEVIN_REVIEWED, ...DEVIN_PAIRS], defaultModelUid: 'mm-reasoning-x' }],
  ];
  const EFFORTS = [undefined, 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'bogus'];
  for (const [name, scenario] of scenarios) {
    script = scenario.status
      ? { status: scenario.status }
      : {
          bytes: encodeDevinMessage('GetCliModelConfigsResponse', {
            clientModelConfigs: [...scenario.configs, ...(scenario.extra ?? [])],
            ...(scenario.defaultModelUid ? { defaultOverrideModelConfig: { modelUid: scenario.defaultModelUid } } : {}),
          }),
        };
    requests.length = 0;
    const provider = new DevinOAuthProvider({ fetchFn, accessToken: 'fixture-devin-session', baseUrl: 'https://devin.example.invalid' });
    let expected = null;
    let error = null;
    try {
      expected = plain(await provider.listModels());
    } catch (e) {
      error = { code: e.code ?? null, status: e.status ?? null };
    }
    const recorded = { response: script.bytes ? hex(script.bytes) : null, status: script.status ?? 200, requests: requests.splice(0), expected, error };
    if (!error) {
      // The catalog rows a turn sends from, and the wire uid each model and
      // effort goes to (`devinWireUid`, the send path's routing).
      const configs = await fetchDevinModels({ sessionToken: 'fixture-devin-session', fetchFn, baseUrl: 'https://devin.example.invalid' });
      const rows = normalizeDevinModels(configs, { defaultModelUid: configs.defaultModelUid });
      recorded.rows = plain(rows).map((row) => ({ id: row.id, uid: row.uid, effortUids: row.effortUids ?? null, requiresEffort: row.requiresEffort ?? false, defaultEffort: row.defaultEffort ?? null }));
      recorded.wire = rows.flatMap((row) => EFFORTS.map((effort) => ({ model: row.id, effort: effort ?? null, uid: devinWireUid(row, row.id, effort) })));
      recorded.wire.push({ model: 'unlisted', effort: 'high', uid: devinWireUid(null, 'unlisted', 'high') });
      recorded.wire.push({ model: 'unlisted', effort: null, uid: devinWireUid(null, 'unlisted', undefined) });
      requests.length = 0;
    }
    cases[name] = recorded;
  }
  // The reviewed family table the Rust side loads as data (Node's DEVIN_REVIEWED_FAMILIES).
  const { DEVIN_REVIEWED_FAMILIES } = await importFrom(tree, `${P}/devin-wire-families.mjs`);
  writeJson(join(FIXTURES_ROOT, '..', 'crates', 'mixdog-ai', 'src', 'providers', 'devin', 'reviewed_families.json'), plain(DEVIN_REVIEWED_FAMILIES));
  writeJson(outFile, { recorder: 'benchmarks/rust-core/recorders/record-listing-misc.mjs', provider: 'devin-oauth', cases });
  return Object.keys(cases).length;
}

// ---------------------------------------------------------------------------
// mixdog-local
// ---------------------------------------------------------------------------

async function recordLocal(tree, outFile) {
  const dataDir = mkdtempSync(join(tmpdir(), 'bench-local-models-'));
  process.env.MIXDOG_DATA_DIR = dataDir;
  const { registerLocalModel } = await importFrom(tree, 'src/runtime/local-provider/registered-models.mjs');
  const { MixdogLocalProvider } = await importFrom(tree, `${P}/mixdog-local.mjs`);
  const modelRoot = join(dataDir, 'local-provider', 'models');
  mkdirSync(modelRoot, { recursive: true });
  const entry = (letter, extra = {}) => {
    const id = `hf-${letter.repeat(24)}`;
    return {
      id,
      filename: `${id}.gguf`,
      remoteFilename: 'model.gguf',
      repository: 'test/model',
      revision: 'b'.repeat(40),
      name: `Registered ${letter}`,
      source: 'https://huggingface.co/test/model',
      url: `https://huggingface.co/test/model/resolve/${'b'.repeat(40)}/model.gguf`,
      size: 1024,
      sha256: 'c'.repeat(64),
      contextWindow: 8192,
      estimatedVramBytes: 1024 ** 3,
      minimumVramBytes: 1024 ** 3,
      ...extra,
    };
  };
  const cases = {};
  const provider = new MixdogLocalProvider({});
  const install = (model) => writeFileSync(join(modelRoot, model.filename), Buffer.alloc(model.size, 1));
  cases.empty = { expected: plain(await provider.listModels()) };
  const installed = entry('a');
  const second = entry('d', { name: 'Registered d', contextWindow: 32768, maxContextWindow: 65536 });
  const absent = entry('e');
  for (const model of [installed, second, absent]) registerLocalModel(model, dataDir);
  install(installed);
  install(second);
  cases.installed = { registered: [installed, second, absent], expected: plain(await provider.listModels()) };
  writeJson(outFile, { recorder: 'benchmarks/rust-core/recorders/record-listing-misc.mjs', provider: 'mixdog-local', cases });
  return Object.keys(cases).length;
}

export async function recordListingMisc(tree, setDir) {
  let count = 0;
  count += await recordGrok(tree, join(setDir, 'grok-models', 'cases.json'));
  count += await recordCursor(tree, join(setDir, 'cursor-models', 'cases.json'));
  count += await recordDevin(tree, join(setDir, 'devin-models', 'cases.json'));
  count += await recordLocal(tree, join(setDir, 'local-models', 'cases.json'));
  return count;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs();
  const tree = resolveTree(args);
  const setDir = join(FIXTURES_ROOT, 'providers');
  const count = await recordListingMisc(tree, setDir);
  refreshSetManifest(setDir, tree);
  console.log(`recorded ${count} model-listing cases; providers/MANIFEST.json re-listed`);
  process.exit(0);
}
