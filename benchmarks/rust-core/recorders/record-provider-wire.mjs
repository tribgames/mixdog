#!/usr/bin/env node
// What Node puts on the wire and reads back for five provider paths the Rust core replays against its real codecs
// (fixtures/provider-wire/<group>/<scenario>/):
//   hosted-search      a provider's own web search: the send `sendCandidate` makes (native-web-search.mjs:63-77) per provider,
//                      answered with the search call, its sources and a citation as each wire reports them;
//   vertex-maas        a Vertex AI open model over the OpenAI-compatible endpoint: token refresh after a 401, a 429 and a 529 retry;
//   vertex-claude      Claude on Vertex AI through streamRawPredict (`_sendClaude`): plain, with tools and effort, a 529 retried;
//   vertex-claude-cancel the caller's signal (vertex-ai.mjs:507-537) aborting that send before the first byte, mid-stream
//                      and during the retry wait, with what the endpoint saw (requests, a connection the client closed);
//   antigravity-claude the Claude replay normalisation of antigravity-request.mjs:54-176 (the ten cases of antigravity-request.test.mjs:402-795);
//   anthropic-fallback a turn served by Anthropic's server-side fallback model, with the ledger row accountProviderSend writes
//                      and the assistant turn the loop commits;
//   served-model       each compatible Chat Completions provider answering as another model than the one asked for;
//   gemini-usage       Gemini and Vertex usage with each usageMetadata field missing in turn (gemini-cache.mjs:245-285).
// Every send runs the real provider class through lib/intercept.mjs (global fetch -> loopback hub); the hub records the bytes
// sent and answers from the scenario's script.
//   node benchmarks/rust-core/recorders/record-provider-wire.mjs --tree <export of b6f10295a> [--only <group>/<scenario>]
process.env.TZ = 'Asia/Seoul';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { cleanHeaders } from './lib/headers.mjs';
import { recorderProvenance } from './lib/provenance.mjs';
import {
  FIXTURES_ROOT,
  commitStage,
  exactProductIdentity,
  parseArgs,
  resolveTree,
  stageSet,
  writeJson,
  within,
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

// The mixdog build the providers name as their client version (MiMo's `mimocode/<version>` user agent).
const { PACKAGE_VERSION } = await at('src/runtime/web-search/lib/package-version.mjs');

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
const { buildIntermediateAssistantMessage } = await at('src/runtime/agent/orchestrator/session/loop/assistant-commit.mjs');
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
const responsesText = (model) =>
  sse(
    [
      { type: 'response.created', response: { id: 'resp_x', model } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'The answer is 42.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 42.' }] } },
      { type: 'response.completed', response: { id: 'resp_x', model, status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 42.' }] }] } },
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
const geminiText = (usageMetadata = { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 }, envelope = false, last = {}) => {
  const wrap = (c) => (envelope ? { response: c } : c);
  return geminiChunks([
    wrap({ candidates: [{ content: { role: 'model', parts: [{ text: 'The answer ' }] } }], modelVersion: 'fixture' }),
    wrap({ candidates: [{ content: { role: 'model', parts: [{ text: 'is 42.' }] }, finishReason: 'STOP', ...last }], usageMetadata, modelVersion: 'fixture' }),
  ]);
};
const chatText = (usage = { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_tokens_details: { cached_tokens: 800 } }, model = 'm') =>
  [
    { id: 'r1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: 'The answer is 42.' } }] },
    { id: 'r1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: 'stop' }], usage },
  ]
    .map((c) => `data: ${j(c)}\n\n`)
    .join('') + 'data: [DONE]\n\n';

// A hosted search as each wire reports it: the search call with its sources and an answer citing one of them.
const SOURCE_A = { url: 'https://a.com/x', title: 'A page' };
const SOURCE_B = { url: 'https://b.com/y', title: 'B page' };
const webSearchCall = { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'find x', sources: [{ type: 'url', url: SOURCE_A.url }, { type: 'url', url: SOURCE_B.url }] } };
const urlCitation = { type: 'url_citation', start_index: 0, end_index: 17, url: SOURCE_A.url, title: SOURCE_A.title };
const citedMessage = { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'The answer is 42.', annotations: [urlCitation] }] };
const responsesSearch = () =>
  sse(
    [
      { type: 'response.created', response: { id: 'resp_x', model: 'fixture' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } },
      { type: 'response.web_search_call.in_progress', output_index: 0, item_id: 'ws_1' },
      { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' },
      { type: 'response.web_search_call.completed', output_index: 0, item_id: 'ws_1' },
      { type: 'response.output_item.done', output_index: 0, item: webSearchCall },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'm1', content_index: 0, delta: 'The answer is 42.' },
      { type: 'response.output_text.annotation.added', output_index: 1, item_id: 'm1', content_index: 0, annotation_index: 0, annotation: urlCitation },
      { type: 'response.output_item.done', output_index: 1, item: citedMessage },
      { type: 'response.completed', response: { id: 'resp_x', model: 'fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [webSearchCall, citedMessage] } },
    ],
    true
  );
const anthropicSearch = (model) =>
  sse(
    [
      { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"find x"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: SOURCE_A.url, title: SOURCE_A.title, encrypted_content: 'enc-a', page_age: null }] } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', cited_text: 'x is 42', url: SOURCE_A.url, title: SOURCE_A.title, encrypted_index: 'ei-a' } } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'The answer is 42.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8, server_tool_use: { web_search_requests: 1 } } },
      { type: 'message_stop' },
    ],
    true
  );
const grounding = {
  groundingMetadata: {
    webSearchQueries: ['find x'],
    groundingChunks: [{ web: { uri: SOURCE_A.url, title: 'a.com' } }, { web: { uri: SOURCE_B.url, title: 'b.com' } }],
    groundingSupports: [{ segment: { startIndex: 0, endIndex: 17, text: 'The answer is 42.' }, groundingChunkIndices: [0] }],
  },
};
const ok = (body, contentType = 'text/event-stream') => ({ status: 200, contentType, body });

// Auxiliary requests (catalog lookups, updater manifests, token grants) get fixed answers; token grants are numbered so a
// refreshed token differs from the one it replaces.
// `models`: the ids a catalog read lists (a gateway sends only a model it lists).
const router = (reply, models = []) => {
  let tokens = 0;
  return (rec, n) => {
    if (/oauth2?\/token|\/token$|oauth2\.googleapis/.test(rec.path) || /oauth2\.googleapis/.test(rec.origin ?? '')) {
      tokens += 1;
      return ok(j({ access_token: `fixture-token-${tokens}`, expires_in: 3600, token_type: 'Bearer' }), 'application/json');
    }
    // OpenCode Go's gateway configuration (record-providers-intercepted.mjs answers it the same way).
    if (/\/api\/v2\/config/.test(rec.path)) {
      return ok(j({ providers: { 'opencode-go': { settings: { baseURL: 'https://opencode.ai/inference/go/openai/v1' }, models: Object.fromEntries(models.map((id) => [id, { name: id, limit: { context: 128000, output: 8192 } }])) } } }), 'application/json');
    }
    if (rec.method === 'GET') return ok(j({ object: 'list', data: models.map((id) => ({ id, object: 'model' })), models: models.map((id) => ({ name: id, id })) }), 'application/json');
    return reply(rec, n);
  };
};
// The n-th non-auxiliary request gets the n-th reply.
const sequence = (...replies) => {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)];
};

// ---- providers ------------------------------------------------------------------------
// Every credential file exists before any provider module reads one (a store that once found none keeps that answer). Each
// scenario's input.json names its provider's file and document, and the configuration the provider was built with.
const CREDENTIALS = {
  'openai-oauth': ['openai-oauth.json', oauthDoc],
  'anthropic-oauth': ['anthropic-oauth-credentials.json', { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: FAR, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }],
  'antigravity-oauth': ['antigravity-oauth.json', { ...oauthDoc, project_id: 'fixture-project' }],
  'grok-oauth': ['grok-oauth.json', oauthDoc],
  'mimo-oauth': ['mimo-oauth.json', { apiKey: 'fixture-key', uid: 'u1' }],
  'command-code-oauth': ['command-code-oauth.json', { apiKey: 'fixture-key', userId: 'u1', userName: 'fixture' }],
  'muse-code-oauth': ['muse-code-oauth.json', { accessToken: 'fixture-access-token', apiKey: 'fixture-key', accountId: 'acct-fixture', email: 'fixture@example.invalid' }],
  'opencode-go-oauth': ['opencode-go-oauth.json', oauthDoc],
  // gcloud's login, named by GOOGLE_APPLICATION_CREDENTIALS.
  'vertex-ai-adc': ['adc.json', { type: 'authorized_user', client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: 'fixture-refresh-token' }],
};
for (const [file, doc] of Object.values(CREDENTIALS)) cred(file, doc);
const CONFIGS = {
  openai: { apiKey: 'fixture-key' },
  'openai-oauth': {},
  anthropic: { apiKey: 'fixture-key' },
  'anthropic-oauth': {},
  gemini: { apiKey: 'fixture-key' },
  'vertex-ai-express': { authMode: 'api-key', apiKey: 'fixture-key' },
  'vertex-ai-adc': { authMode: 'adc', projectId: 'fixture-project', location: 'global' },
  'antigravity-oauth': {},
  'grok-oauth': {},
  // xAI's Chat Completions mode (its default is Responses).
  xai: { apiKey: 'fixture-key', preconnect: false, apiMode: 'chat' },
  deepseek: { apiKey: 'fixture-key', preconnect: false },
  openrouter: { apiKey: 'fixture-key', preconnect: false },
  'mimo-oauth': { preconnect: false },
  'command-code-oauth': { preconnect: false },
  'muse-code-oauth': { preconnect: false },
  'opencode-go-oauth': { preconnect: false },
};
const compat = async (name) => new (await P('openai-compat.mjs')).OpenAICompatProvider(name, CONFIGS[name]);
const PROVIDERS = {
  openai: async () => new (await P('openai-ws.mjs')).OpenAIDirectProvider(CONFIGS.openai),
  'openai-oauth': async () => new (await P('openai-oauth.mjs')).OpenAIOAuthProvider(CONFIGS['openai-oauth']),
  anthropic: async () => new (await P('anthropic.mjs')).AnthropicProvider(CONFIGS.anthropic),
  'anthropic-oauth': async () => new (await P('anthropic-oauth.mjs')).AnthropicOAuthProvider(CONFIGS['anthropic-oauth']),
  gemini: async () => new (await P('gemini.mjs')).GeminiProvider(CONFIGS.gemini),
  'vertex-ai-express': async () => new (await P('vertex-ai.mjs')).VertexAIProvider(CONFIGS['vertex-ai-express']),
  'vertex-ai-adc': async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(dataDir, CREDENTIALS['vertex-ai-adc'][0]);
    return new (await P('vertex-ai.mjs')).VertexAIProvider(CONFIGS['vertex-ai-adc']);
  },
  'antigravity-oauth': async () => new (await P('antigravity-oauth.mjs')).AntigravityOAuthProvider(CONFIGS['antigravity-oauth']),
  'grok-oauth': async () => new (await P('grok-oauth.mjs')).GrokOAuthProvider(CONFIGS['grok-oauth']),
  xai: () => compat('xai'),
  deepseek: () => compat('deepseek'),
  openrouter: () => compat('openrouter'),
  'mimo-oauth': async () => new (await P('mimo-oauth.mjs')).MimoOAuthProvider(CONFIGS['mimo-oauth']),
  'command-code-oauth': async () => new (await P('command-code-oauth.mjs')).CommandCodeOAuthProvider(CONFIGS['command-code-oauth']),
  'muse-code-oauth': async () => new (await P('muse-code-oauth.mjs')).MuseCodeOAuthProvider(CONFIGS['muse-code-oauth']),
  'opencode-go-oauth': async () => new (await P('opencode-go-oauth.mjs')).OpenCodeGoOAuthProvider(CONFIGS['opencode-go-oauth']),
};

// ---- scenarios ------------------------------------------------------------------------
const scenarios = [];

// Hosted web search: the arguments of a search, the tool each family gets (`toolFor`, `toolTypesFor`) and the options
// `sendCandidate` sends with (native-web-search.mjs:63-77), under the session id it derives at START.
const searchArgs = { query: 'q', prompt: 'find x', site: 'a.com OR b.com', contextSize: 'medium', maxResults: 3 };
const SEARCH = [
  ['openai', 'gpt-5.2', responsesSearch],
  ['openai-oauth', 'gpt-5.2', responsesSearch],
  ['anthropic', 'claude-sonnet-4-6', () => anthropicSearch('claude-sonnet-4-6')],
  ['anthropic-oauth', 'claude-sonnet-4-6', () => anthropicSearch('claude-sonnet-4-6')],
  ['gemini', 'gemini-2.5-pro', () => geminiText(undefined, false, grounding)],
  ['antigravity-oauth', 'gemini-3-pro', () => geminiText(undefined, true, grounding)],
  ['grok-oauth', 'grok-4', responsesSearch],
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

// Claude on Vertex AI (`_sendClaude`, vertex-ai.mjs:449-552): an Anthropic request through streamRawPredict, plain, with
// tools and effort, and a 529 retried on the Anthropic backoff.
const claudeTurn = [{ role: 'system', content: 'You are a fixture assistant.' }, { role: 'user', content: 'Hello' }];
const VERTEX_CLAUDE = [
  ['text', null, {}, () => router(sequence(ok(anthropicText('claude-sonnet-4-6'))))],
  ['tools-effort', 'GLOB', { effort: 'high' }, () => router(sequence(ok(anthropicText('claude-sonnet-4-6'))))],
  ['retry-529', null, {}, () => router(sequence({ ...ok(j({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 'application/json'), status: 529, headers: advice }, ok(anthropicText('claude-sonnet-4-6'))))],
];

// The model a compatible provider reports (`response.model || useModel`, openai-compat-chat-send.mjs:321 and
// chunk-events.mjs:56; Muse Code always sends Responses, muse-code-oauth.mjs:390-394): each provider's answer names
// another model than the one asked for.
const SERVED = [
  ['xai', 'grok-4', chatText],
  ['deepseek', 'deepseek-chat', chatText],
  // A model no OpenRouter family claims: the gateway sends it on Chat (an `openai/gpt-*` one goes to Responses).
  ['openrouter', 'meta-llama/llama-4-maverick', chatText],
  ['mimo-oauth', 'mimo-fixture', chatText],
  ['command-code-oauth', 'cc-fixture', chatText],
  ['muse-code-oauth', 'muse-fixture', (_usage, served) => responsesText(served)],
  ['opencode-go-oauth', 'go-fixture', chatText],
];
for (const [provider, model, reply] of SERVED) {
  scenarios.push({
    group: 'served-model',
    name: provider,
    provider,
    model,
    messages: claudeTurn,
    tools: null,
    // xAI's x-grok-conv-id falls back to the process id without a session (openai-compat-xai.mjs:59): a fixed session
    // keeps it the same from run to run; OpenCode Go's x-opencode-session is the session id, else a randomUUID
    // (opencode-go.mjs:132-134): a fixed session lets its value be compared.
    opts: provider === 'xai' || provider === 'opencode-go-oauth' ? { sessionId: 'fixture-session' } : {},
    script: () => router(sequence(ok(reply({ prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }, `${model}-served`))), [model]),
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
for (const [name, tools, opts, script] of VERTEX_CLAUDE) {
  scenarios.push({ group: 'vertex-claude', name, provider: 'vertex-ai-adc', model: 'claude-sonnet-4-6', messages: claudeTurn, tools: tools ? GLOB : null, opts, script });
}

// The caller cancelling a Vertex AI Claude send (`opts.signal`, vertex-ai.mjs:507-537). `hold` answers are served by the
// holding endpoint below: `head` sends nothing, `part` sends the head and the bytes given, then each signals that step
// (the caller aborts) and records whether the client closed the connection. The retry wait is a 529 advising a wait
// far longer than the run; the caller aborts once Node's retry sleep has armed its timer (`sleepWithAbort`, the clock
// telling the wait began), after the sleep has subscribed to the signal.
const claudeOpening = anthropicStream([
  { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The answer' } },
]);
const VERTEX_CLAUDE_CANCEL = [
  ['before-first-byte', () => router(sequence({ status: 200, hold: 'head', body: '' }))],
  ['mid-stream', () => router(sequence({ ...ok(claudeOpening), hold: 'part' }))],
  ['retry-wait', () => router(sequence({ ...ok(j({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 'application/json'), status: 529, headers: { 'retry-after-ms': '600000' } }, ok(anthropicText('claude-sonnet-4-6'))))],
];
for (const [name, script] of VERTEX_CLAUDE_CANCEL) {
  scenarios.push({ group: 'vertex-claude-cancel', name, cancel: name, provider: 'vertex-ai-adc', model: 'claude-sonnet-4-6', messages: claudeTurn, tools: null, opts: {}, script });
}

// The holding endpoint: the hub's request record and answers (with the status and headers it answered), plus `hold` and
// `closedByClient`. `abortNow` is the running scenario's caller abort; `closings` the connections still to settle before
// its record is written.
let abortNow = () => {};
let closings = [];
// The retry-wait step: the first timer a retry sleep arms calls `onRetrySleep` once that sleep is waiting.
let onRetrySleep = null;
const armTimer = globalThis.setTimeout;
globalThis.setTimeout = function setTimeoutSeen(callback, delay, ...rest) {
  const timer = armTimer.call(this, callback, delay, ...rest);
  if (onRetrySleep && /sleepWithAbort/.test(new Error().stack)) {
    const step = onRetrySleep;
    onRetrySleep = null;
    queueMicrotask(step);
  }
  return timer;
};
const holding = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const origin = req.headers['x-bench-origin'] ?? null;
  const rec = { transport: 'http', origin, method: req.method, path: req.url, headers: cleanHeaders(req.headers, origin), rawHeaderOrder: req.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()).filter((n) => n !== 'x-bench-origin'), bodyText: Buffer.concat(chunks).toString('utf8') };
  hub.records.push(rec);
  const reply = hub.script.http(rec, hub.records.length);
  rec.served = reply.body;
  rec.status = reply.status ?? 200;
  rec.answerHeaders = { 'content-type': reply.contentType ?? 'text/event-stream', ...(reply.hold ? {} : (reply.headers ?? {})) };
  if (!reply.hold) {
    res.writeHead(rec.status, rec.answerHeaders);
    res.end(reply.body);
    return;
  }
  rec.hold = reply.hold;
  closings.push(new Promise((resolve) => res.on('close', () => {
    rec.closedByClient = !res.writableEnded;
    resolve();
  })));
  // `head`: nothing was sent, so the request itself is the step; `part`: the caller aborts once it has read the delta.
  if (reply.hold === 'head') abortNow();
  else {
    res.writeHead(rec.status, rec.answerHeaders);
    res.write(reply.body);
  }
});
await new Promise((resolve, reject) => {
  holding.once('error', reject);
  holding.listen(0, '127.0.0.1', resolve);
});

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
  // The fallback names a dated snapshot of the requested model: only the fallback record marks the answer substituted
  // (`servedModelSubstituted`, usage-request-status.mjs:33-42).
  'snapshot-target': [
    { type: 'message_start', message: { id: 'msg_f', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], usage: { input_tokens: 412, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { ...fallbackBlock, to: { model: 'claude-opus-5-20260301' }, trigger: { type: 'overloaded' } } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi! How can I help?' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
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
  const events = [];
  let callbackNames = [];
  let result;
  // A cancelled send is answered by the holding endpoint (global fetch reads the hub's port per request).
  const hubPort = hub.httpPort;
  if (s.cancel) hub.httpPort = holding.address().port;
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
    abortNow = s.cancel === 'before-first-byte' ? () => ac.abort() : () => {};
    onRetrySleep = s.cancel === 'retry-wait' ? () => ac.abort() : null;
    // Every callback the caller passes, in the order the provider calls them. A hosted search passes only onStageChange
    // and onStreamDelta (native-web-search.mjs:76-77); a turn of the loop passes the stream callbacks of
    // ask-turn-loop-options.mjs:113-236, where an onStreamDelta with no kind is 'semantic' (:232).
    const callbacks = {
      onToolCall: (c) => {
        dispatched.push({ id: c.id, name: c.name, arguments: c.arguments });
        events.push({ on: 'toolCall', id: c.id, name: c.name, arguments: c.arguments });
      },
      onStageChange: (stage, detail) => {
        if (stage === 'notice') events.push({ on: 'notice', tone: detail?.tone ?? null, message: detail?.message ?? null });
      },
      onStreamDelta: (kind = 'semantic') => events.push({ on: 'streamDelta', kind }),
      ...(s.group === 'hosted-search'
        ? {}
        : {
            onTextDelta: (text) => {
              events.push({ on: 'textDelta', text });
              if (s.cancel === 'mid-stream') ac.abort();
            },
            onTextReset: (detail) => events.push({ on: 'textReset', ...detail }),
            onReasoningDelta: (text) => events.push({ on: 'reasoningDelta', text }),
            onStreamItemStart: (detail) => events.push({ on: 'itemStart', ...detail }),
          }),
    };
    callbackNames = Object.keys(callbacks);
    const opts = { ...structuredClone(s.opts), signal: ac.signal, ...callbacks };
    const messages = structuredClone(s.messages);
    const send = (o) => provider.send(messages, s.model, s.tools ?? undefined, o);
    try {
      const value = await within(`${id}: the send`, s.accounted ? accountProviderSend(s.provider, provider, send, s.model, opts) : send(opts));
      result = { ok: plainResult(value) };
      // The assistant turn the loop commits from an accounted answer (assistant-commit.mjs:72-104).
      if (s.accounted) result.committed = plainResult(buildIntermediateAssistantMessage(value));
    } catch (e) {
      result = { error: { name: e?.name ?? null, message: String(e?.message ?? e), status: e?.status ?? e?.httpStatus ?? null, code: e?.code ?? null } };
    }
    await within(`${id}: the background model-list refresh`, Promise.all(background));
    await within(`${id}: the client closing the held connections`, Promise.all(closings));
    closings = [];
    if (onRetrySleep) throw new Error(`${id}: Node never entered its retry wait`);
  }, id);
  hub.httpPort = hubPort;
  const dir = join(stage, s.group, s.name);
  const credential = CREDENTIALS[s.provider];
  writeJson(join(dir, 'input.json'), {
    provider: s.provider,
    config: CONFIGS[s.provider],
    ...(credential ? { credential: { file: credential[0], document: credential[1] } } : {}),
    clientVersion: PACKAGE_VERSION,
    model: s.model,
    messages: s.messages,
    tools: s.tools,
    opts: s.opts,
    callbacks: callbackNames,
  });
  writeJson(join(dir, 'exchange.json'), { records: hub.records.map((r) => ({ ...r })), determinism: hub.lastDeterminism });
  writeJson(join(dir, 'result.json'), { ...result, dispatchedToolCalls: dispatched, events, ...(s.accounted ? { rows: rows.map(view) } : {}) });
  console.log(`recorded ${id}`);
}

writeSetManifest(stage, {
  set: 'provider-wire',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    exclusions: [
      'request header value x-stainless-runtime-version: the Node that runs the SDK client, the recorder\'s here (checked equal to nodeVersion) and the desktop\'s Electron runtime in the product (checked equal to grok::SDK_RUNTIME_VERSION); its place in the head is compared',
      'request header value x-grok-req-id: randomUUID() per request; its place in the head is compared',
      'credential header values (authorization, x-api-key, x-goog-api-key, ...): redacted by lib/headers.mjs to the scheme word; a token minted during the send is checked against the token grant\'s recorded answer',
      'requestId of an Antigravity body: agent-<randomUUID> drawn per send; its presence is compared',
      'GET requests (catalog listings such as /v1/models, client-version lookups): reads beside the send, which the core makes from its catalog services outside the send',
      'HEAD preconnect of the core\'s socket warm-up: a raw undici.request in Node, which the hub (a fetch redirect) never sees',
      'result generationMs and ledger ttftMs: no Rust adapter reports where generation starts in its stream yet (Completed.generation_ms is unset)',
      'result hasThinkingContent, contentBlockTypes: Anthropic\'s summary of its blocks for the empty-turn trace, derived from the replay blocks compared',
      'result assistantBlocks: the same list as providerReplay.items (checked equal), which is compared',
      'result providerState.<owner>.updatedAt: the wall clock when the state was taken (Date.now pinned to START here, the system clock in the core); its presence is compared',
      'result requestServiceTier: stamped by Node\'s accounting on the result; the core keeps it in the ledger row, compared where the scenario is accounted',
      'usage.promptTokens, usage.totalTokens: Node\'s sums of the compared counts; usage.raw keeps the provider\'s own',
      'usage.serverToolUse: Anthropic\'s copy of usage.raw.server_tool_use (compared in raw), read by no Node code',
      'stopReason null and an absent usage.cacheWriteTokens read as no stop reason and 0 (Node\'s readers use || 0)',
      'stream callback onStreamDelta(\'transport\'): raised per network read, its count follows the socket\'s chunking',
      'core item starts of a plain text or reasoning block: Node reports a started item only for a client tool call or a phased message (send-callbacks.mjs reportStreamItemStart and its callers), so those are compared and the core\'s other openings are not callbacks',
      'stream callback placement of a delta\'s kind report (before or after the delta, by path): compared as one with its delta',
      'Codex identity (installation id, user agent OS, beta features): the recording machine\'s, given to the replay as the recorder had it',
      'HTTP status of a scripted refusal: the script (vertex-maas, vertex-claude, vertex-claude-cancel groups) states it; records keep the body served',
      'vertex-claude-cancel error name, message and code: the DOMException AbortError Node\'s fetch and withRetry throw; the core\'s send ends as Cancelled, compared as that pairing',
      'vertex-claude-cancel/retry-wait retrySleeps delayMs: the jittered wait Node armed; the core\'s wait is shown entered (its send pending after the retry\'s discard, under a paused clock) and ended by the cancel before the clock moves, not measured',
    ],
    ...recorderProvenance(import.meta.url),
  },
});
await hub.close();
holding.closeAllConnections();
holding.close();
closeUsageLedgers();
commitStage(stage, finalDir);
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
