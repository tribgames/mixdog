#!/usr/bin/env node
// Provider stream recordings (PW fixture strategy): the REAL Node adapters are
// driven against local fake servers that serve scripted SSE frames; the exact
// request bytes the adapter sent and the exact frame bytes served are stored
// next to the normalized result. No credential, no real provider call.
//
//   node benchmarks/rust-core/recorders/record-providers.mjs --tree <dir>
//
// Output: native/core/fixtures/providers/<provider>/<scenario>/{request.json,
// response.sse,result.json}; the sets of the recorders it runs; providers/oracles/
// (copies of the given tree's own parity fixtures, the run fails when one is missing);
// and providers/MANIFEST.json. Only the files in EXTERNAL are carried over unrecorded.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installDeterminism } from './lib/determinism.mjs';
import { cleanHeaders } from './lib/headers.mjs';
import { FIXTURES_ROOT, GIT_TIMEOUT_MS, REPO_ROOT, commitStage, exactProductIdentity, recordingProvenance, sha256, stageSet, importFrom, parseArgs, resolveTree, stableStringify, writeJson, writeSetManifest, writeText } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const finalDir = join(FIXTURES_ROOT, 'providers');
// The files of the set no recorder writes: assembled by their work packages, kept as they are and stated in the
// manifest with their own source and hash. Every other file is written by this run.
const EXTERNAL = {
  'gemini-explicit-cache/cases.json': 'WP-AI-GOOGLE, by hand (added in 90113883e5)',
  'google-models/cases.json': 'WP-AI-GOOGLE, by hand (added in 3af96f66f2)',
  'oracles/openai-codex-metadata-golden.json': 'WP-AI-OPENAI, by hand (added in 3af96f66f2)',
  'oracles/openai-models-golden.json': 'WP-AI-OPENAI, by hand (added in e7ecb60838)',
  'oracles/openai-reasoning-replay-golden.json': 'WP-AI-OPENAI, by hand (added in 90113883e5)',
  'oracles/openai-retry-policy-golden.json': 'WP-AI-OPENAI, by hand (added in 3af96f66f2)',
  'oracles/openai-transport-switch-golden.json': 'WP-AI-OPENAI, by hand (added in 3af96f66f2)',
  'oracles/openai-ws-delta-golden.json': 'WP-AI-OPENAI, by hand (added in 3af96f66f2)',
};
// Written into an empty staging directory and swapped in at the end; only the external files are carried over.
const setDir = stageSet(finalDir);
for (const file of Object.keys(EXTERNAL)) {
  mkdirSync(dirname(join(setDir, file)), { recursive: true });
  cpSync(join(finalDir, file), join(setDir, file));
}

const P = 'src/runtime/agent/orchestrator/providers';
const KEY = 'fixture-key-not-a-credential';
// Headers and retry determinism come from the shared libs: all request headers
// kept (credential values redacted), Math.random seeded per scenario, scheduled
// retry delays recorded. `host` is normalized to the original provider host.
const hub = { records: [] };
installDeterminism(hub, tree);
const ORIGIN_OF = { anthropic: 'https://api.anthropic.com', 'openai-compat-chat': 'https://api.groq.com', 'mixdog-local': 'http://127.0.0.1', 'openai-responses-http-sse': 'https://api.openai.com' };

const sse = (events, { named = false } = {}) =>
  events.map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('');

const TOOLS = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const BASE_MESSAGES = [
  { role: 'system', content: 'You are a fixture assistant.' },
  { role: 'user', content: 'Look up the answer.' },
];
const WITH_RESULT = [
  ...BASE_MESSAGES,
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_fx1', name: 'lookup', arguments: { key: 'answer' } }] },
  { role: 'tool', toolCallId: 'call_fx1', content: '42' },
];

/** One local server; each scenario sets `script` = { status, body, contentType }. */
async function withServer(script, fn) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push({ method: req.method, path: req.url, headers: cleanHeaders(req.headers, script.origin ?? null), rawHeaderOrder: req.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()), bodyText: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(script.status ?? 200, { 'content-type': script.contentType ?? 'text/event-stream' });
    res.end(script.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const norm = (r) => ({
  content: r?.content ?? null,
  toolCalls: (r?.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
  stopReason: r?.stopReason ?? null,
  usage: r?.usage ?? null,
});

const recorded = [];
async function record(provider, scenario, script, run) {
  const dir = join(setDir, provider, scenario);
  script = { origin: ORIGIN_OF[provider] ?? null, ...script };
  await withServer(script, async (base, requests) => {
    const events = [];
    let result;
    hub.records = requests;
    hub.beginScenario(`${provider}/${scenario}`);
    try {
      result = { ok: norm(await run(base, (e) => events.push(e))) };
    } catch (e) {
      result = { error: { name: e?.name, message: String(e?.message ?? e).slice(0, 300), status: e?.status ?? e?.httpStatus ?? null } };
    }
    const determinism = hub.endScenario();
    writeJson(join(dir, 'request.json'), { requests, determinism });
    writeText(join(dir, 'response.sse'), script.body);
    writeJson(join(dir, 'result.json'), { ...result, dispatchedToolCalls: events });
    recorded.push(`${provider}/${scenario}`);
  });
}

// ---- Anthropic Messages (api key), SSE ------------------------------------
const anthropicText = sse(
  [
    { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The result ' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'is 42.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' },
  ],
  { named: true }
);
// A reply that wrote 300 cache tokens, 200 of them with the 1-hour TTL (message_start reports the split).
const anthropicCache1h = sse(
  [
    { type: 'message_start', message: { id: 'msg_fx3', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cached.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ],
  { named: true }
);
const anthropicTool = sse(
  [
    { type: 'message_start', message: { id: 'msg_fx2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fx1', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"key":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"answer"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ],
  { named: true }
);
const { AnthropicProvider } = await importFrom(tree, `${P}/anthropic.mjs`);
const anthropicRun = (messages) => async (base, onToolCall) =>
  new AnthropicProvider({ apiKey: KEY, baseURL: base, maxRetries: 0 }).send(messages, 'claude-sonnet-4-6', TOOLS, { onToolCall });
await record('anthropic', 'text', { body: anthropicText }, anthropicRun(BASE_MESSAGES));
await record('anthropic', 'cache-write-1h', { body: anthropicCache1h }, anthropicRun(BASE_MESSAGES));
await record('anthropic', 'tool-call', { body: anthropicTool }, anthropicRun(BASE_MESSAGES));
await record('anthropic', 'tool-result-followup', { body: anthropicText }, anthropicRun(WITH_RESULT));
await record(
  'anthropic',
  'error-400',
  { status: 400, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture bad request' } }) },
  anthropicRun(BASE_MESSAGES)
);
// Stream closes without message_stop: death is decided by the missing terminal event.
await record('anthropic', 'truncated-no-terminal', { body: anthropicText.split('event: message_delta')[0] }, anthropicRun(BASE_MESSAGES));

// ---- OpenAI-compatible chat completions ------------------------------------
const { OpenAICompatProvider } = await importFrom(tree, `${P}/openai-compat.mjs`);
const chatChunk = (delta, finish = null, extra = {}) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-fx', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const chatText = chatChunk({ role: 'assistant', content: '' }) + chatChunk({ content: 'The result ' }) + chatChunk({ content: 'is 42.' }) + chatChunk({}, 'stop') +
  `data: ${JSON.stringify({ id: 'chatcmpl-fx', object: 'chat.completion.chunk', model: 'fixture-model', choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\ndata: [DONE]\n\n`;
const chatTool = chatChunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_fx1', type: 'function', function: { name: 'lookup', arguments: '' } }] }) +
  chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"key":' } }] }) + chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"answer"}' } }] }) +
  chatChunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const compatRun = (messages) => async (base, onToolCall) =>
  new OpenAICompatProvider('groq', { apiKey: KEY, baseURL: `${base}/v1`, preconnect: false }).send(messages, 'fixture-model', TOOLS, { onToolCall });
await record('openai-compat-chat', 'text', { body: chatText }, compatRun(BASE_MESSAGES));
await record('openai-compat-chat', 'tool-call', { body: chatTool }, compatRun(BASE_MESSAGES));
await record('openai-compat-chat', 'tool-result-followup', { body: chatText }, compatRun(WITH_RESULT));
await record('openai-compat-chat', 'error-401', { status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'fixture unauthorized', type: 'invalid_request_error' } }) }, compatRun(BASE_MESSAGES));
await record('openai-compat-chat', 'truncated-no-done', { body: chatText.split('data: [DONE]')[0].split('"choices":[],')[0] }, compatRun(BASE_MESSAGES));

// ---- mixdog-local (strict single-system chat endpoint) ----------------------
const { MixdogLocalProvider } = await importFrom(tree, `${P}/mixdog-local.mjs`);
await record('mixdog-local', 'tool-call', { body: chatTool }, async (base, onToolCall) =>
  new MixdogLocalProvider({}, { ensureServer: async () => ({ baseURL: `${base}/v1`, apiKey: KEY }) }).send(BASE_MESSAGES, 'fixture-local', TOOLS, { onToolCall })
);

// ---- OpenAI Responses over HTTP SSE (openai direct auth shape) --------------
const { sendViaHttpSse } = await importFrom(tree, `${P}/openai-oauth-http-sse.mjs`);
const { buildRequestBody } = await importFrom(tree, `${P}/openai-oauth.mjs`);
const respText = sse(
  [
    { type: 'response.created', response: { id: 'resp_fx', model: 'gpt-fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fx', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_fx', delta: 'The result ' },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_fx', delta: 'is 42.' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_fx', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] } },
    { type: 'response.completed', response: { id: 'resp_fx', model: 'gpt-fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [{ type: 'message', id: 'msg_fx', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] }] } },
  ],
  { named: true }
);
const respTool = sse(
  [
    { type: 'response.created', response: { id: 'resp_fx2', model: 'gpt-fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_fx', call_id: 'call_fx1', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_fx', delta: '{"key":"answer"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_fx', arguments: '{"key":"answer"}' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_fx', call_id: 'call_fx1', name: 'lookup', arguments: '{"key":"answer"}' } },
    { type: 'response.completed', response: { id: 'resp_fx2', model: 'gpt-fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 }, output: [{ type: 'function_call', id: 'fc_fx', call_id: 'call_fx1', name: 'lookup', arguments: '{"key":"answer"}' }] } },
  ],
  { named: true }
);
const responsesRun = (messages) => async (base, onToolCall) => {
  const body = buildRequestBody(messages, 'gpt-fixture', TOOLS, {});
  return sendViaHttpSse({
    auth: { type: 'openai-direct', apiKey: KEY },
    body,
    useModel: 'gpt-fixture',
    onToolCall,
    fetchFn: (url, init) => fetch(`${base}${new URL(url).pathname}`, init),
  });
};
await record('openai-responses-http-sse', 'text', { body: respText }, responsesRun(BASE_MESSAGES));
await record('openai-responses-http-sse', 'tool-call', { body: respTool }, responsesRun(BASE_MESSAGES));
await record('openai-responses-http-sse', 'tool-result-followup', { body: respText }, responsesRun(WITH_RESULT));
await record('openai-responses-http-sse', 'truncated-no-completed', { body: respText.split('event: response.completed')[0] }, responsesRun(BASE_MESSAGES));

// ---- Request-builder vectors (pure; WS frames, OAuth request bodies) --------
const vecDir = join(setDir, 'request-builders');
const { _buildRequestBodyForCacheSmoke } = await importFrom(tree, `${P}/anthropic-oauth.mjs`);
writeJson(join(vecDir, 'anthropic-oauth.json'), {
  text: _buildRequestBodyForCacheSmoke(BASE_MESSAGES, 'claude-sonnet-4-6', TOOLS, {}),
  toolResult: _buildRequestBodyForCacheSmoke(WITH_RESULT, 'claude-sonnet-4-6', TOOLS, {}),
  effortHigh: _buildRequestBodyForCacheSmoke(BASE_MESSAGES, 'claude-sonnet-4-6', TOOLS, { effort: 'high' }),
});
writeJson(join(vecDir, 'openai-responses.json'), {
  text: buildRequestBody(BASE_MESSAGES, 'gpt-fixture', TOOLS, {}),
  toolResult: buildRequestBody(WITH_RESULT, 'gpt-fixture', TOOLS, {}),
});
const ws = await importFrom(tree, `${P}/openai-ws-delta.mjs`);
const full = buildRequestBody(WITH_RESULT, 'gpt-fixture', TOOLS, {});
const prior = buildRequestBody(BASE_MESSAGES, 'gpt-fixture', TOOLS, {});
writeJson(join(vecDir, 'openai-ws-response-create.json'), {
  fullFrame: ws._buildResponseCreateFrame(full),
  delta: (() => {
    try {
      return ws._computeDelta(prior, full, ['resp_fx']);
    } catch (e) {
      return { unavailable: String(e.message) };
    }
  })(),
});

// ---- The product's own in-repo oracles, copied by value from this tree ------
const PRODUCT_ORACLES = {
  'openai-responses-payload-parity.fixture.json': `${P}/openai-responses-payload-parity.fixture.json`,
  'openai-compat-responses-head-parity.json': `${P}/openai-compat-responses-head-parity.json`,
  'xai-tool-search-head-parity.json': `${P}/xai-tool-search-head-parity.json`,
  'native-request-bytes.head.json': 'scripts/tool-contracts/native-request-bytes.head.json',
};
mkdirSync(join(setDir, 'oracles'), { recursive: true });
for (const [name, from] of Object.entries(PRODUCT_ORACLES)) {
  if (!existsSync(join(tree, from))) throw new Error(`the tree ${tree} has no ${from} (the oracle oracles/${name})`);
  // The commit check of the manifest covers src/ and apps/ only; a file outside them is held to the commit's blob here.
  if (args.get('commit') && !/^(src|apps)\//.test(from)) {
    const git = (...a) => execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }).trim();
    const want = git('rev-parse', `${args.get('commit')}:${from}`);
    const have = git('hash-object', '--no-filters', join(tree, from));
    if (have !== want) throw new Error(`${join(tree, from)} is blob ${have}, not ${args.get('commit')}:${from} (${want})`);
  }
  cpSync(join(tree, from), join(setDir, 'oracles', name));
}

// Recorders with their own command line, each run in its own process (they install process-wide state) and writing
// into this set.
const STANDALONE = [];
function standalone(file, out, extra = []) {
  STANDALONE.push(file);
  execFileSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), file), '--tree', tree, '--out', join(setDir, out), ...extra], { stdio: 'inherit', timeout: 600_000 });
}
standalone('record-action-input-union.mjs', 'action-input-union/cases.json');
standalone('record-compat-tool-exclusion.mjs', 'compat-tool-exclusion/cases.json');
standalone('record-cursor-tool-choice.mjs', 'cursor-tool-choice/cases.json');
standalone('record-cursor-tools.mjs', 'cursor-tools/cases.json');
standalone('record-gemini-tool-schema.mjs', 'gemini-tool-schema/cases.json');
standalone('record-schema-wording.mjs', 'schema-wording/cases.json');
standalone('record-model-meta.mjs', 'oracles/model-meta.json', args.get('commit') ? ['--commit', args.get('commit')] : []);

// Owned by WP-AI-ANTHROPIC's recorders; regenerated here, before the manifest write, so the staged set always has them.
// Each runs in its own process: they install process-wide state (data dir, fetch, cached product modules), and in
// this process the scenarios above and the earlier recorders leak into the later ones (the anthropic-oauth listing
// came out as the offline list instead of the served one).
const ISOLATED = [];
function isolated(file, name, ...callArgs) {
  ISOLATED.push(file);
  const url = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), file)).href;
  execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); await m[${JSON.stringify(name)}](...${JSON.stringify(callArgs)});`, 'record-providers:isolated'], { stdio: 'inherit', timeout: 600_000 });
}
isolated('record-anthropic-effort.mjs', 'recordAnthropicEffort', tree, join(setDir, 'anthropic-effort', 'cases.json'));
isolated('record-anthropic-shared-prefix.mjs', 'recordAnthropicSharedPrefix', tree, join(setDir, 'anthropic-shared-prefix', 'cases.json'));
isolated('record-anthropic-models.mjs', 'recordAnthropicModels', tree, join(setDir, 'anthropic-models', 'cases.json'));
isolated('record-xai-responses-continuation.mjs', 'recordXaiResponsesContinuation', tree, join(setDir, 'oracles', 'xai-responses-continuation.json'));
isolated('record-xai-cache-routing.mjs', 'recordXaiCacheRouting', tree, join(setDir, 'oracles', 'xai-cache-routing.json'));
isolated('record-wire-route.mjs', 'recordWireRoute', tree, join(setDir, 'oracles', 'wire-route.json'));
isolated('record-compat-listing.mjs', 'recordCompatListing', tree, join(setDir, 'oracles', 'compat-listing.json'));
isolated('record-custom-listing.mjs', 'recordCustomListing', tree, join(setDir, 'oracles', 'custom-listing.json'));
isolated('record-chat-parts.mjs', 'recordChatParts', tree, join(setDir, 'oracles', 'chat-parts-messages.json'));
// WP-AI-LISTING-MISC: the grok-, cursor-, devin- and local-models cases.
isolated('record-listing-misc.mjs', 'recordListingMisc', tree, setDir);
isolated('record-openai-login.mjs', 'recordOpenAiLogin', tree, join(setDir, 'oracles', 'openai-login-golden.json'));
isolated('record-openai-max-context.mjs', 'recordOpenAiMaxContext', tree, join(setDir, 'oracles', 'openai-max-context-golden.json'));

// `--commit <full id>`: the tree is a `git archive` export that must be exactly that commit, and the manifest says so.
const commit = args.get('commit');
const RECORDERS = 'benchmarks/rust-core/recorders';
writeSetManifest(setDir, {
  set: 'providers',
  recorder: `${RECORDERS}/record-providers.mjs`,
  command: `node ${RECORDERS}/record-providers.mjs --tree <tree with node_modules>${commit ? ` --commit ${commit}` : ''}`,
  ...(commit ? { identity: exactProductIdentity(tree, commit) } : {}),
  extra: {
    ...recordingProvenance(`${RECORDERS}/record-providers.mjs`, [
      ...ISOLATED.map((file) => `${RECORDERS}/${file}`),
      ...STANDALONE.map((file) => `${RECORDERS}/${file}`),
      ...['common.mjs', 'determinism.mjs', 'headers.mjs', 'tool-definitions.mjs'].map((file) => `${RECORDERS}/lib/${file}`),
    ]),
    scenarios: recorded.sort(),
    productOracles: Object.fromEntries(Object.entries(PRODUCT_ORACLES).map(([name, from]) => [`oracles/${name}`, from])),
    // Not written by this run: carried over unchanged from the committed set.
    externalFixtures: Object.entries(EXTERNAL).map(([path, source]) => ({ path, source, sha256: sha256(readFileSync(join(setDir, path))) })),
  },
});
commitStage(setDir, finalDir);
console.log(`recorded ${recorded.length} scenarios`);
