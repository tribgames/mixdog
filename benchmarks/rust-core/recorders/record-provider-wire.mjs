#!/usr/bin/env node
// What Node puts on the wire and reads back for five provider paths the Rust core replays against its real codecs
// (fixtures/provider-wire/<group>/<scenario>/):
//   hosted-search      a provider's own web search: the send `sendCandidate` makes (native-web-search.mjs:63-77) per provider;
//   vertex-maas        a Vertex AI open model over the OpenAI-compatible endpoint: token refresh after a 401, a 429 and a 529 retry;
//   antigravity-claude the Claude replay normalisation of antigravity-request.mjs:54-176 (the ten cases of antigravity-request.test.mjs:402-795);
//   anthropic-fallback a turn served by Anthropic's server-side fallback model, with the ledger row accountProviderSend writes;
//   gemini-usage       Gemini and Vertex usage with each usageMetadata field missing in turn (gemini-cache.mjs:245-285).
// Every send runs the real provider class through lib/intercept.mjs (global fetch -> loopback hub); the hub records the bytes
// sent and answers from the scenario's script.
//   node benchmarks/rust-core/recorders/record-provider-wire.mjs --tree <export of b6f10295a> [--only <group>/<scenario>]
process.env.TZ = 'Asia/Seoul';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIXTURES_ROOT,
  commitStage,
  exactProductIdentity,
  parseArgs,
  recordingProvenance,
  resolveTree,
  stageSet,
  writeJson,
  writeSetManifest,
} from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-provider-wire.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const only = args.get('only') ?? null;

const at = (rel) => import(pathToFileURL(join(tree, rel)).href);
// The ledger suites' price data (Claude Opus 4.8 is priced): it points MIXDOG_DATA_DIR at its own scratch folder, which is
// the data directory of the whole run.
await at('src/runtime/shared/llm/usage-test-support.mjs');
const dataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_HOME = join(dataDir, 'home');
process.env.HOME = process.env.USERPROFILE = join(dataDir, 'home');
for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|GOOGLE|VERTEX|CLOUD/.test(k) && !/^MIXDOG_(DATA|HOME)/.test(k)) delete process.env[k];
process.env.MIXDOG_OAI_TRANSPORT = 'http';

const { install } = await import(pathToFileURL(join(import.meta.dirname, 'lib/intercept.mjs')).href);
const hub = await install(tree);
// Wall-clock reads (ledger ts/day, durations, first-output times, the session id's base-36 stamp) all read START; the
// one product timer these scenarios run, the retry sleep, keeps its real (1 ms) delay and is logged by the hub.
const START = 1_700_000_000_000;
Date.now = () => START;
const P = (file) => at(`src/runtime/agent/orchestrator/providers/${file}`);

process.env.MIXDOG_USAGE_LEDGER_PATH = join(dataDir, 'ledger.sqlite');
const { UsageLedger, closeUsageLedgers } = await at('src/runtime/shared/llm/usage-ledger.mjs');
const { accountProviderSend } = await at('src/runtime/shared/llm/usage-accounting.mjs');
const { nativeWebSearchMessages, nativeWebSearchTool, nativeWebSearchToolTypes } = await at('src/session-runtime/native-web-search/tool-shape.mjs');
const { webSearchProviderFamily } = await at('src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
let rows = [];
UsageLedger.prototype.recordQueued = async function recordQueued(row) {
  rows.push(row);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const FAR = 4_000_000_000_000;
const cred = (name, doc) => writeFileSync(join(dataDir, name), JSON.stringify(doc));
const oauthDoc = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: FAR, account_id: 'acct-fixture', email: 'fixture@example.invalid' };

// ---- served bytes ------------------------------------------------------------------
const j = JSON.stringify;
const sse = (events, named = false) => events.map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${j(e)}\n\n`).join('');
const responsesText = () =>
  sse(
    [
      { type: 'response.created', response: { id: 'resp_x', model: 'fixture' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'The answer is 42.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 42.' }] } },
      { type: 'response.completed', response: { id: 'resp_x', model: 'fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 42.' }] }] } },
    ],
    true
  );
const anthropicStream = (events) => sse(events, true);
const anthropicText = (model) =>
  anthropicStream([
    { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The answer is 42.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ]);
const geminiChunks = (chunks) => chunks.map((c) => `data: ${j(c)}\n\n`).join('');
const geminiText = (usageMetadata = { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 }, envelope = false) => {
  const wrap = (c) => (envelope ? { response: c } : c);
  return geminiChunks([
    wrap({ candidates: [{ content: { role: 'model', parts: [{ text: 'The answer ' }] } }], modelVersion: 'fixture' }),
    wrap({ candidates: [{ content: { role: 'model', parts: [{ text: 'is 42.' }] }, finishReason: 'STOP' }], usageMetadata, modelVersion: 'fixture' }),
  ]);
};
const chatText = (usage = { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_tokens_details: { cached_tokens: 800 } }) =>
  [
    { id: 'r1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'The answer is 42.' } }] },
    { id: 'r1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage },
  ]
    .map((c) => `data: ${j(c)}\n\n`)
    .join('') + 'data: [DONE]\n\n';
const ok = (body, contentType = 'text/event-stream') => ({ status: 200, contentType, body });

// Auxiliary requests (catalog lookups, updater manifests, token grants) get fixed answers; token grants are numbered so a
// refreshed token differs from the one it replaces.
const router = (reply) => {
  let tokens = 0;
  return (rec, n) => {
    if (/oauth2?\/token|\/token$|oauth2\.googleapis/.test(rec.path) || /oauth2\.googleapis/.test(rec.origin ?? '')) {
      tokens += 1;
      return ok(j({ access_token: `fixture-token-${tokens}`, expires_in: 3600, token_type: 'Bearer' }), 'application/json');
    }
    if (rec.method === 'GET') return ok(j({ object: 'list', data: [], models: [] }), 'application/json');
    return reply(rec, n);
  };
};
// The n-th non-auxiliary request gets the n-th reply.
const sequence = (...replies) => {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)];
};

// ---- providers ------------------------------------------------------------------------
// Every credential file exists before any provider module reads one (a store that once found none keeps that answer).
cred('openai-oauth.json', oauthDoc);
cred('anthropic-oauth-credentials.json', { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: FAR, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } });
cred('antigravity-oauth.json', { ...oauthDoc, project_id: 'fixture-project' });
cred('grok-oauth.json', oauthDoc);
const PROVIDERS = {
  openai: async () => new (await P('openai-ws.mjs')).OpenAIDirectProvider({ apiKey: 'fixture-key' }),
  'openai-oauth': async () => new (await P('openai-oauth.mjs')).OpenAIOAuthProvider({}),
  anthropic: async () => new (await P('anthropic.mjs')).AnthropicProvider({ apiKey: 'fixture-key' }),
  'anthropic-oauth': async () => new (await P('anthropic-oauth.mjs')).AnthropicOAuthProvider({}),
  gemini: async () => new (await P('gemini.mjs')).GeminiProvider({ apiKey: 'fixture-key' }),
  'vertex-ai-express': async () => new (await P('vertex-ai.mjs')).VertexAIProvider({ authMode: 'api-key', apiKey: 'fixture-key' }),
  'vertex-ai-adc': async () => {
    const file = join(dataDir, 'adc.json');
    writeFileSync(file, j({ type: 'authorized_user', client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: 'fixture-refresh-token' }));
    process.env.GOOGLE_APPLICATION_CREDENTIALS = file;
    return new (await P('vertex-ai.mjs')).VertexAIProvider({ authMode: 'adc', projectId: 'fixture-project', location: 'global' });
  },
  'antigravity-oauth': async () => new (await P('antigravity-oauth.mjs')).AntigravityOAuthProvider({}),
  'grok-oauth': async () => new (await P('grok-oauth.mjs')).GrokOAuthProvider({}),
};

// ---- scenarios ------------------------------------------------------------------------
const scenarios = [];

// Hosted web search: the arguments of a search, the tool each family gets (`toolFor`, `toolTypesFor`) and the options
// `sendCandidate` sends with (native-web-search.mjs:63-77), under the session id it derives at START.
const searchArgs = { query: 'q', prompt: 'find x', site: 'a.com OR b.com', contextSize: 'medium', maxResults: 3 };
const SEARCH = [
  ['openai', 'gpt-5.2', responsesText],
  ['openai-oauth', 'gpt-5.2', responsesText],
  ['anthropic', 'claude-sonnet-4-6', () => anthropicText('claude-sonnet-4-6')],
  ['anthropic-oauth', 'claude-sonnet-4-6', () => anthropicText('claude-sonnet-4-6')],
  ['gemini', 'gemini-2.5-pro', () => geminiText()],
  ['antigravity-oauth', 'gemini-3-pro', () => geminiText(undefined, true)],
  ['grok-oauth', 'grok-4', responsesText],
];
for (const [provider, model, reply] of SEARCH) {
  const family = webSearchProviderFamily(provider);
  const [toolType] = nativeWebSearchToolTypes({ provider, model }, family);
  scenarios.push({
    group: 'hosted-search',
    name: provider,
    provider,
    model,
    messages: nativeWebSearchMessages(searchArgs),
    tools: null,
    opts: {
      role: 'web-search',
      sessionId: `lead-1:native-web-search:${START.toString(36)}`,
      sourceType: 'native-web-search',
      sourceName: 'web_search',
      nativeTools: [nativeWebSearchTool(searchArgs, toolType, family)],
      nativeInclude: family === 'openai' ? ['web_search_call.action.sources'] : [],
      toolChoice: family === 'gemini' ? 'auto' : 'required',
      fast: false,
      modelParameters: {},
    },
    script: () => router(sequence(ok(reply()))),
  });
}

// Vertex AI open models (vertex-ai-maas.mjs): a token refresh after a 401, then a 429 (array-wrapped) and a 529, each retried.
const hi = [{ role: 'user', content: 'hi' }];
const advice = { 'retry-after-ms': '1' };
const MAAS = [
  ['refresh-after-401', ok(j({ error: { message: 'token expired' } }), 'application/json'), 401],
  ['retry-429', ok(j([{ error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } }]), 'application/json'), 429],
  ['retry-529', ok(j({ error: { code: 529, message: 'Overloaded' } }), 'application/json'), 529],
];
for (const [name, failure, status] of MAAS) {
  scenarios.push({
    group: 'vertex-maas',
    name,
    provider: 'vertex-ai-adc',
    model: 'zai-org/glm-5-maas',
    messages: hi,
    tools: null,
    opts: {},
    script: () => router(sequence({ ...failure, status, headers: status === 401 ? {} : advice }, ok(chatText()))),
  });
}

// Antigravity Claude replay (antigravity-request.test.mjs:402-795): each case's history, sent through the provider.
const GLOB = [{ name: 'glob', description: 'Find files', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } }];
const CLAUDE = 'claude-sonnet-4-6';
const THINKING = 'claude-opus-4-6-thinking';
const SENTINEL = 'skip_thought_signature_validator';
const replayOf = (items, model, provider = 'antigravity') => ({ version: 1, provider, items, ...(model ? { requestContext: { model } } : {}) });
const call = (id = 'toolu_9') => ({ functionCall: { name: 'glob', args: { pattern: '*' }, id } });
const toolTurn = (assistant, id = 'toolu_9') => [
  { role: 'user', content: 'go' },
  { ...assistant, toolCalls: [{ id, name: 'glob', arguments: { pattern: '*' } }] },
  { role: 'tool', toolCallId: id, content: 'ok' },
  { role: 'user', content: 'next' },
];
const openLoop = (assistant) => [
  { role: 'user', content: 'earlier' },
  { role: 'assistant', content: 'earlier answer', providerReplay: replayOf([{ thought: true, text: 'old', thoughtSignature: 'sig-old' }, { text: 'earlier answer' }], THINKING) },
  { role: 'user', content: 'go' },
  { ...assistant, toolCalls: [{ id: 'toolu_9', name: 'glob', arguments: { pattern: '*' } }] },
  { role: 'tool', toolCallId: 'toolu_9', content: 'ok' },
];
const CLAUDE_CASES = {
  'empty-text-parts': [
    'claude-sonnet-5-5-low',
    [
      { role: 'user', content: 'find markdown' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_1', name: 'glob', arguments: { pattern: '*.md' } }], providerReplay: replayOf([{ text: '' }, { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_1' } }, { text: '' }, { text: '', thoughtSignature: 'sig' }], 'claude-sonnet-5-5-low') },
      { role: 'tool', toolCallId: 'toolu_1', content: 'README.md' },
    ],
  ],
  'only-empty-parts-omitted': [
    'claude-sonnet-5-5-low',
    [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '', providerReplay: replayOf([{ text: '' }, { text: '' }], 'claude-sonnet-5-5-low') },
      { role: 'user', content: 'second' },
    ],
  ],
  'rejoin-thinking': [
    'claude-sonnet-5-5-low',
    [
      { role: 'user', content: 'find markdown' },
      {
        role: 'assistant',
        content: 'answer text',
        toolCalls: [{ id: 'toolu_2', name: 'glob', arguments: { pattern: '*.md' } }],
        providerReplay: replayOf(
          [
            { text: '' },
            { thought: true, text: 'first ' },
            { thought: true, text: 'second' },
            { thought: true, text: '', thoughtSignature: 'sig-a' },
            { thought: true, text: 'next block', thoughtSignature: 'sig-b' },
            { text: 'answer ' },
            { text: 'text' },
            { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_2' } },
            { text: '' },
          ],
          'claude-sonnet-5-5-low'
        ),
      },
      { role: 'tool', toolCallId: 'toolu_2', content: 'README.md' },
    ],
  ],
  'plain-history-drops-thinking': [CLAUDE, toolTurn({ role: 'assistant', content: 'answer' })],
  'foreign-family-replay': [
    CLAUDE,
    toolTurn({ role: 'assistant', content: 'answer', providerReplay: replayOf([{ thought: true, text: 'gemini thought', thoughtSignature: 'gemini-sig' }, { text: 'answer', thoughtSignature: 'gemini-text-sig' }, { ...call(), thoughtSignature: 'gemini-call-sig' }], 'gemini-3.1-pro-high') }),
  ],
  'interrupted-unsigned-run': [CLAUDE, toolTurn({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'cut ' }, { thought: true, text: 'off' }, { text: '' }, call()], CLAUDE) })],
  'sentinel-is-not-a-signature': [CLAUDE, toolTurn({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'a', thoughtSignature: SENTINEL }, { thought: true, text: 'b', thoughtSignature: '' }, call()], CLAUDE) })],
  'thinking-only-turn': [
    CLAUDE,
    [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'thinking' }, { thought: true, text: '', thoughtSignature: 'sig' }], CLAUDE) },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'unsigned' }, { text: '' }], CLAUDE) },
      { role: 'user', content: 'third' },
    ],
  ],
  'thinking-after-call': [
    CLAUDE,
    toolTurn({
      role: 'assistant',
      content: '',
      providerReplay: replayOf([{ thought: true, text: 'before', thoughtSignature: 'sig-1' }, call(), { thought: true, text: 'after ' }, { thought: true, text: 'call' }, { thought: true, text: '', thoughtSignature: 'sig-2' }, { thought: true, text: 'tail without signature' }], CLAUDE),
    }),
  ],
  'runs-never-merge-across-messages': [
    CLAUDE,
    [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_a', name: 'glob', arguments: { pattern: '*' } }], providerReplay: replayOf([{ thought: true, text: 'unsigned head' }, call('toolu_a')], CLAUDE) },
      { role: 'tool', toolCallId: 'toolu_a', content: 'ok' },
      { role: 'assistant', content: 'done', providerReplay: replayOf([{ thought: true, text: 'split ' }, { text: 'interleaved' }, { thought: true, text: 'run', thoughtSignature: 'sig-b' }], CLAUDE) },
      { role: 'user', content: 'next' },
    ],
  ],
  'open-loop-interrupted': [THINKING, openLoop({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'cut' }, call()], THINKING) })],
  'open-loop-foreign': [THINKING, openLoop({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'g', thoughtSignature: 'gemini-sig' }, call()], 'gemini-3.1-pro-high') })],
  'open-loop-compacted': [THINKING, openLoop({ role: 'assistant', content: '' })],
  'open-loop-signed': [THINKING, openLoop({ role: 'assistant', content: '', providerReplay: replayOf([{ thought: true, text: 'plan', thoughtSignature: 'sig-plan' }, call()], THINKING) })],
  'open-loop-thinking-off': [CLAUDE, openLoop({ role: 'assistant', content: '' })],
  'open-loop-effort-on': [CLAUDE, openLoop({ role: 'assistant', content: '' }), { effort: 'high' }],
  'open-loop-later-steps': [
    THINKING,
    [
      ...openLoop({ role: 'assistant', content: '' }),
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_10', name: 'glob', arguments: { pattern: '*.md' } }], providerReplay: replayOf([{ thought: true, text: 'fresh', thoughtSignature: 'sig-fresh' }, { functionCall: { name: 'glob', args: { pattern: '*.md' }, id: 'toolu_10' } }], THINKING) },
      { role: 'tool', toolCallId: 'toolu_10', content: 'README.md' },
    ],
  ],
};
for (const [name, [model, messages, opts = {}]] of Object.entries(CLAUDE_CASES)) {
  scenarios.push({
    group: 'antigravity-claude',
    name,
    provider: 'antigravity-oauth',
    model,
    messages: [{ role: 'system', content: 'You are a fixture assistant.' }, ...messages],
    tools: GLOB,
    opts,
    script: () => router(sequence(ok(geminiText(undefined, true)))),
  });
}

// Anthropic server-side fallback (anthropic-server-fallback.mjs), as the stream carries it: before any output (message_start
// already names the fallback model) and mid-output (message_start names the requested model).
const fallbackBlock = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } };
const iterations = [
  { type: 'message', model: 'claude-opus-5', input_tokens: 535, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 412, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
];
const FALLBACK = {
  'before-output': [
    { type: 'message_start', message: { id: 'msg_f', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], usage: { input_tokens: 412, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: fallbackBlock },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi! How can I help?' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9, iterations } },
    { type: 'message_stop' },
  ],
  'mid-output': [
    { type: 'message_start', message: { id: 'msg_f', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], usage: { input_tokens: 535, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial ' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: fallbackBlock },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'answer.' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 412, output_tokens: 9, iterations } },
    { type: 'message_stop' },
  ],
};
for (const [name, events] of Object.entries(FALLBACK)) {
  scenarios.push({
    group: 'anthropic-fallback',
    name,
    provider: 'anthropic-oauth',
    model: 'claude-opus-5',
    messages: [{ role: 'system', content: 'You are a fixture assistant.' }, { role: 'user', content: 'Hello' }],
    tools: null,
    opts: { sessionId: 'fallback-session', sourceType: 'lead' },
    accounted: true,
    script: () => router(sequence(ok(anthropicStream(events)))),
  });
}

// Gemini usage (gemini-cache.mjs:245-285 through normalizeGeminiUsage), each field missing in turn, on the Gemini API and on
// Vertex AI (whose usage is cache-exclusive, vertex-ai-maas.mjs:33-45).
const USAGE = {
  'total-without-prompt': { totalTokenCount: 1000, candidatesTokenCount: 150, thoughtsTokenCount: 50 },
  'snake-total-without-prompt': { total_token_count: 1200, candidates_token_count: 175, thoughts_token_count: 25 },
  'explicit-zero-prompt': { prompt_token_count: 0, total_token_count: 1200, candidates_token_count: 175, thoughts_token_count: 25 },
  'total-cached-alias': { prompt_token_count: 1200, total_cached_tokens: 500, candidates_token_count: 5 },
  'zero-cached-wins-over-alias': { promptTokenCount: 100, cachedContentTokenCount: 0, totalCachedTokens: 80, candidatesTokenCount: 5 },
  'null-cached-takes-alias': { promptTokenCount: 100, cachedContentTokenCount: null, totalCachedTokens: 80, candidatesTokenCount: 5 },
  'tool-use-prompt': { promptTokenCount: 100, toolUsePromptTokenCount: 20, cachedContentTokenCount: 30, candidatesTokenCount: 5 },
  'cached-over-prompt': { promptTokenCount: 100, cachedContentTokenCount: 150, candidatesTokenCount: 5 },
};
for (const [provider, model] of [['gemini', 'gemini-2.5-pro'], ['vertex-ai-express', 'gemini-2.5-pro']]) {
  for (const [name, usageMetadata] of Object.entries(USAGE)) {
    scenarios.push({
      group: 'gemini-usage',
      name: `${provider}-${name}`,
      provider,
      model,
      messages: [{ role: 'system', content: 'You are a fixture assistant.' }, { role: 'user', content: 'Look up the answer.' }],
      tools: null,
      opts: {},
      script: () => router(sequence(ok(geminiText(usageMetadata)))),
    });
  }
}

// ---- run ---------------------------------------------------------------------------------
const finalDir = join(FIXTURES_ROOT, 'provider-wire');
const groups = [...new Set(scenarios.map((s) => s.group))];
const selected = scenarios.filter((s) => !only || `${s.group}/${s.name}` === only || s.group === only);
if (!selected.length) throw new Error(`--only ${only}: no such scenario`);
const stage = stageSet(finalDir, only ? [...new Set(selected.map((s) => `${s.group}/${s.name}`))] : groups);

const view = (row) => ({ ...row, id: row.id.replace(UUID, '<req>'), rates: JSON.stringify(row.rates) });
const plainResult = (r) => {
  const out = {};
  for (const [key, value] of Object.entries(r ?? {})) if (typeof value !== 'function') out[key] = value;
  return JSON.parse(JSON.stringify(out));
};
for (const s of selected) {
  const id = `${s.group}/${s.name}`;
  rmSync(join(stage, s.group, s.name), { recursive: true, force: true });
  await (await P('openai-ws-pool.mjs'))._clearWebSocketPoolForTest?.();
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  rows = [];
  const dispatched = [];
  let result;
  await hub.run({ http: s.script() }, async () => {
    const provider = await PROVIDERS[s.provider]();
    // anthropic-oauth fires `void this._refreshModelCache()` after a reply; it is settled inside its own scenario so its
    // GET lands there (record-providers-intercepted.mjs does the same).
    const background = [];
    if (typeof provider._refreshModelCache === 'function') {
      const real = provider._refreshModelCache.bind(provider);
      provider._refreshModelCache = (...a) => {
        const p = real(...a);
        background.push(p.catch(() => {}));
        return p;
      };
    }
    const ac = new AbortController();
    const opts = { ...structuredClone(s.opts), signal: ac.signal, onToolCall: (c) => dispatched.push({ id: c.id, name: c.name, arguments: c.arguments }) };
    const messages = structuredClone(s.messages);
    const send = (o) => provider.send(messages, s.model, s.tools ?? undefined, o);
    try {
      const value = s.accounted ? await accountProviderSend(s.provider, provider, send, s.model, opts) : await send(opts);
      result = { ok: plainResult(value) };
    } catch (e) {
      result = { error: { name: e?.name ?? null, message: String(e?.message ?? e), status: e?.status ?? e?.httpStatus ?? null, code: e?.code ?? null } };
    }
    await Promise.all(background);
  }, id);
  const dir = join(stage, s.group, s.name);
  writeJson(join(dir, 'input.json'), { provider: s.provider, model: s.model, messages: s.messages, tools: s.tools, opts: s.opts });
  writeJson(join(dir, 'exchange.json'), { records: hub.records.map((r) => ({ ...r })), determinism: hub.lastDeterminism });
  writeJson(join(dir, 'result.json'), { ...result, dispatchedToolCalls: dispatched, ...(s.accounted ? { rows: rows.map(view) } : {}) });
  console.log(`recorded ${id}`);
}

writeSetManifest(stage, {
  set: 'provider-wire',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    exclusions: [
      'request headers: the replays compare the request line and body bytes; header order and client headers are the socket-level checks (mixdog-core wire_parity_tests)',
      'requestId of an Antigravity body: agent-<randomUUID> drawn per send',
      'GET /v1/models of an Anthropic send: a background catalog read, not part of the turn',
      'usage.promptTokens: the neutral usage has no such field; the ledger derives the prompt from the counts compared',
      'ledger ttftMs: no Rust adapter reports where generation starts in its stream yet (Completed.generation_ms is unset)',
      'HTTP status of a scripted refusal: the script (vertex-maas group) states it; records keep the body served',
    ],
    ...recordingProvenance(RECORDER, [
    'benchmarks/rust-core/recorders/lib/common.mjs',
    'benchmarks/rust-core/recorders/lib/intercept.mjs',
    'benchmarks/rust-core/recorders/lib/intercept-hooks.mjs',
    'benchmarks/rust-core/recorders/lib/intercept-ws.mjs',
    'benchmarks/rust-core/recorders/lib/intercept-http2.mjs',
    'benchmarks/rust-core/recorders/lib/determinism.mjs',
    'benchmarks/rust-core/recorders/lib/headers.mjs',
    ]),
  },
});
await hub.close();
closeUsageLedgers();
commitStage(stage, finalDir);
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
