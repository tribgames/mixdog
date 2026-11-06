#!/usr/bin/env node
// What Node's native web search does around a provider send (native-web-search.mjs,
// native-web-search/routes.mjs, native-web-search-usage.mjs, and the ledger row
// accountProviderSend writes).
//   node benchmarks/rust-core/recorders/record-hosted-search.mjs [--tree <dir>]
//
// Output: native/core/fixtures/hosted-search/golden.json.
// Day keys are local-time dates; pin the zone so the recording is the same on every machine.
process.env.TZ = 'Asia/Seoul';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'hosted-search');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-hosted-search.mjs';
const at = (path) => importFrom(tree, path);
await at('src/runtime/shared/llm/usage-test-support.mjs');
process.env.MIXDOG_USAGE_LEDGER_PATH = join(mkdtempSync(join(tmpdir(), 'hosted-search-')), 'ledger.sqlite');
const { UsageLedger, closeUsageLedgers } = await at('src/runtime/shared/llm/usage-ledger.mjs');
const { accountProviderSend } = await at('src/runtime/shared/llm/usage-accounting.mjs');
const { createNativeWebSearch } = await at('src/session-runtime/native-web-search.mjs');
const { registerNativeWebSearchUsageSink } = await at('src/session-runtime/native-web-search-usage.mjs');
const workflow = await at('src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { makeWebSearchCapableFor } = await at('src/runtime/agent/orchestrator/runtime-core/model-capabilities.mjs');

const START = 1_700_000_000_000;
let clock = START;
Date.now = () => clock;
let rows = [];
UsageLedger.prototype.recordQueued = async function recordQueued(row) {
  rows.push(row);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const view = (row) => ({ ...row, id: row.id.replace(UUID, '<req>'), rates: JSON.stringify(row.rates) });

// One fake runtime: the facade accessors close over `world`.
function runtime(world) {
  const config = { webSearchRoute: world.webSearchRoute, providers: {} };
  const capable = makeWebSearchCapableFor(workflow.webSearchProviderFamily, (id, provider) => world.global?.[`${provider}/${id}`] ?? null);
  const calls = [];
  const search = createNativeWebSearch({
    getRoute: () => world.main,
    // The facade never holds "unset": it holds the follow-Main default.
    getWebSearchRoute: () => world.webSearchRoute ?? { provider: 'default', model: 'default' },
    setWebSearchRoute() {},
    getConfig: () => config,
    getSession: () => (world.session ? { id: world.session } : null),
    getReg: () => ({
      getProvider: (provider) => {
        const instance = { constructor: { inputExcludesCache: provider.startsWith('anthropic') } };
        return {
          ...(world.cached?.[provider] ? { getCachedModelInfo: (model) => world.cached[provider][model] ?? null } : {}),
          ...(world.listed?.[provider] ? { listModels: async () => world.listed[provider] } : {}),
          send: (messages, model, tools, opts) =>
            accountProviderSend(
              provider,
              instance,
              async () => {
                const { signal, onStageChange, onStreamDelta, ...plain } = opts;
                calls.push({ provider, model, messages, tools: tools ?? null, opts: plain, signal: Boolean(signal) });
                clock += world.sendMs ?? 250;
                const next = world.replies.shift();
                if (next.throw) throw Object.assign(new Error(next.throw.message), next.throw.props || {});
                return structuredClone(next.result);
              },
              model,
              opts
            ),
        };
      },
    }),
    ensureFullConfig: () => config,
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    ensureProviderEnabled: (value) => value,
    normalizeWebSearchProviderId: workflow.normalizeWebSearchProviderId,
    webSearchProviderFamily: workflow.webSearchProviderFamily,
    isDefaultWebSearchRouteConfig: workflow.isDefaultWebSearchRouteConfig,
    isWebSearchCapableProvider: workflow.isWebSearchCapableProvider,
    webSearchCapableFor: capable,
  });
  return { search, calls };
}

const strip = (candidate) => ({
  key: candidate.key, provider: candidate.provider, model: candidate.model, source: candidate.source,
  effort: candidate.effort, fast: candidate.fast, modelParameters: candidate.modelParameters, toolType: candidate.toolType,
});

const oai = { provider: 'openai', model: 'gpt-5.2' };
const routeCases = [
  { name: 'default follows a capable main model', main: { ...oai, effort: 'high', fast: true, modelParameters: { verbosity: 'low' } } },
  { name: 'default takes the effective effort first', main: { ...oai, effort: 'low', effectiveEffort: 'medium' } },
  { name: 'default refuses a codex main model', main: { provider: 'openai-oauth', model: 'gpt-5.2-codex' } },
  { name: 'default without a main route', main: null },
  { name: 'default main on a provider with no web search', main: { provider: 'mixdog-local', model: 'x' } },
  {
    name: 'a cached row declaring web search lifts the id rule',
    main: { provider: 'openai', model: 'gpt-4-0613' },
    cached: { openai: { 'gpt-4-0613': { id: 'gpt-4-0613', supportsWebSearch: true } } },
  },
  {
    name: 'a listed row is used when the provider caches none',
    main: { provider: 'openai', model: 'gpt-4-0613' },
    listed: { openai: [{ id: 'gpt-4-0613', supportedTools: ['web_search'] }] },
  },
  {
    name: 'a row declaring no web search leaves the global catalog the word',
    main: { provider: 'openai', model: 'gpt-4-0613' },
    cached: { openai: { 'gpt-4-0613': { id: 'gpt-4-0613' } } },
    global: { 'openai/gpt-4-0613': { id: 'gpt-4-0613', supportsWebSearch: true } },
  },
  {
    name: 'a row declaring no web search for a retired id',
    main: { provider: 'openai', model: 'gpt-4-0613' },
    cached: { openai: { 'gpt-4-0613': { id: 'gpt-4-0613' } } },
  },
  {
    name: 'a chain keeps its order, tuning and tool types',
    main: oai,
    webSearchRoute: {
      provider: 'default', model: 'default', toolType: 'web_search_preview',
      fallbacks: [
        { provider: 'gemini', model: 'gemini-2.5-flash', effort: 'low', toolType: 'google_search' },
        { provider: 'anthropic', model: 'claude-sonnet-4-5', fast: true, modelParameters: { thinking: 'on' } },
        { provider: 'xai', model: 'grok-4', toolType: 'web_search' },
      ],
    },
  },
  {
    name: 'a chain skips a provider with no hosted search',
    main: oai,
    webSearchRoute: { provider: 'mixdog-local', model: 'x', fallbacks: [{ provider: 'openai-oauth', model: 'gpt-5.2' }] },
  },
  { name: 'a chain of one explicit route', main: null, webSearchRoute: { provider: 'openai-api', model: 'gpt-5.2-mini' } },
  {
    name: 'a chain with two names for one provider is refused',
    main: oai,
    webSearchRoute: { provider: 'openai', model: 'a', fallbacks: [{ provider: 'openai-api', model: 'b' }] },
  },
];
const routes = [];
for (const spec of routeCases) {
  const world = { webSearchRoute: undefined, replies: [], ...spec };
  const { search } = runtime(world);
  const out = { ...spec };
  try {
    out.candidates = (await search.nativeWebSearchRoutes()).map(strip);
  } catch (error) {
    out.error = error.message;
  }
  if (out.candidates && out.candidates.length === 0) {
    try {
      await search.runNativeWebSearch({ query: 'q' });
    } catch (error) {
      out.noCandidate = error.message;
    }
  }
  routes.push(out);
}

// Sends: the chain is the stored route; each reply is what the provider gives.
const text = (content, extra = {}) => ({ result: { content, ...extra } });
const usage = { inputTokens: 120, outputTokens: 30, cachedTokens: 40, cacheWriteTokens: 0, promptTokens: 120 };
const sendCases = [
  {
    name: 'openai with usage, a model, citations and search calls',
    session: 'lead-1',
    webSearchRoute: { provider: 'openai', model: 'zz-gpt', effort: 'high', fast: true, modelParameters: { verbosity: 'low' } },
    args: { query: 'q', prompt: 'find x', site: 'a.com OR b.com', contextSize: 'medium', maxResults: 3 },
    replies: [
      text('  the answer  ', {
        usage: { ...usage, raw: { output_tokens_details: { reasoning_tokens: 7 } } },
        citations: [{ url: 'https://a.com/1', title: 'A' }],
        webSearchCalls: [{ type: 'web_search_call', action: { query: 'x', sources: [{ url: 'https://b.com/2' }] } }],
      }),
    ],
  },
  {
    name: 'gemini asks automatically and defaults the session id',
    session: null,
    webSearchRoute: { provider: 'gemini', model: 'zz-gemini' },
    args: { query: 'q', prompt: 'p' },
    replies: [text('g', { usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, cacheWriteTokens: 0, promptTokens: 10 } })],
  },
  {
    name: 'anthropic bills its prompt as input plus cache',
    session: 'lead-2',
    webSearchRoute: { provider: 'anthropic', model: 'zz-claude', effort: 'low' },
    args: { query: 'q', prompt: 'p', maxResults: 20, site: 'x.org' },
    replies: [text('a', { usage: { inputTokens: 50, outputTokens: 9, cachedTokens: 30, cacheWriteTokens: 12, promptTokens: 92 } })],
  },
  {
    name: 'xai with a tool type and no usage',
    session: 'lead-3',
    webSearchRoute: { provider: 'xai', model: 'zz-grok', toolType: 'web_search' },
    args: { query: 'q', prompt: 'p', site: 'y.com' },
    replies: [text('x')],
  },
  {
    name: 'a capacity refusal moves to the next provider',
    session: 'lead-4',
    webSearchRoute: {
      provider: 'openai', model: 'zz-gpt',
      fallbacks: [{ provider: 'gemini', model: 'zz-gemini' }],
    },
    args: { query: 'q', prompt: 'p' },
    replies: [
      { throw: { message: 'limited', props: { status: 429 } } },
      text('second', { usage: { inputTokens: 5, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, promptTokens: 5 } }),
    ],
  },
  {
    name: 'every provider refusing joins the reasons',
    session: 'lead-5',
    webSearchRoute: {
      provider: 'openai', model: 'zz-gpt',
      fallbacks: [{ provider: 'anthropic', model: 'zz-claude' }],
    },
    args: { query: 'q', prompt: 'p' },
    replies: [
      { throw: { message: 'limited', props: { status: 429 } } },
      { throw: { message: 'busy', props: { status: 503 } } },
    ],
  },
  {
    name: 'a denied credential stops the chain',
    session: 'lead-6',
    webSearchRoute: {
      provider: 'openai', model: 'zz-gpt',
      fallbacks: [{ provider: 'gemini', model: 'zz-gemini' }],
    },
    args: { query: 'q', prompt: 'p' },
    replies: [{ throw: { message: 'denied', props: { status: 403 } } }],
  },
];
const sends = [];
for (const spec of sendCases) {
  clock = START;
  rows = [];
  const world = { main: oai, ...spec, replies: [...spec.replies] };
  const { search, calls } = runtime(world);
  const deltas = [];
  const release = spec.session ? registerNativeWebSearchUsageSink(spec.session, (delta) => deltas.push(delta)) : () => {};
  const out = { ...spec, startedAt: START };
  try {
    const result = await search.runNativeWebSearch({ ...spec.args });
    out.result = { ...result, durationMs: undefined };
  } catch (error) {
    out.error = error.message;
  }
  release();
  out.calls = calls;
  out.deltas = deltas;
  out.rows = rows.map(view);
  sends.push(out);
}

writeJson(join(stage, 'golden.json'), { startedAt: START, routes, sends });
writeSetManifest(stage, { set: 'hosted-search', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
closeUsageLedgers();
