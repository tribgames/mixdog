#!/usr/bin/env node
// Provider recordings for adapters with no base-URL seam, made in-process by
// intercepting the network layer (lib/intercept.mjs: global fetch, `ws` and
// `node:http2` stand-ins -> loopback hub). Product code is untouched; fake
// credential stores live in a temp MIXDOG_DATA_DIR. Every scenario stores the
// ORIGINAL origin the adapter targeted, the request/handshake headers (secrets
// redacted), request body bytes or WS frames both ways, served bytes and the
// adapter's normalized result. Scenarios that never reach the network are
// listed in unrecorded.json with the adapter's error, never silently dropped.
//
//   node benchmarks/rust-core/recorders/record-providers-intercepted.mjs --tree T [--only <id>]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, stageSet, parseArgs, resolveTree, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');
const dataDir = mkdtempSync(join(tmpdir(), 'bench-intercept-data-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_HOME = join(dataDir, 'home');
process.env.HOME = process.env.USERPROFILE = join(dataDir, 'home');
for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/.test(k) && !/^MIXDOG_/.test(k)) delete process.env[k];

const { install } = await import(pathToFileURL(join(import.meta.dirname, 'lib/intercept.mjs')).href);
const hub = await install(tree);
const P = (f) => import(pathToFileURL(join(tree, 'src/runtime/agent/orchestrator/providers', f)).href);

const FAR = Date.now() + 10 * 365 * 24 * 3600 * 1000;
const cred = (name, doc) => writeFileSync(join(dataDir, name), JSON.stringify(doc));
const oauthDoc = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: FAR, account_id: 'acct-fixture', email: 'fixture@example.invalid' };

const TOOLS = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const MSG = [{ role: 'system', content: 'You are a fixture assistant.' }, { role: 'user', content: 'Look up the answer.' }];

// ---- wire script builders -----------------------------------------------------
const j = JSON.stringify;
const sse = (events, named = false) => events.map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${j(e)}\n\n`).join('');
const respEvents = (tool) => tool
  ? [
      { type: 'response.created', response: { id: 'resp_t', model: 'fixture' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call_fx1', name: 'lookup', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"key":"answer"}' },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc1', arguments: '{"key":"answer"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call_fx1', name: 'lookup', arguments: '{"key":"answer"}' } },
      { type: 'response.completed', response: { id: 'resp_t', model: 'fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 }, output: [{ type: 'function_call', id: 'fc1', call_id: 'call_fx1', name: 'lookup', arguments: '{"key":"answer"}' }] } },
    ]
  : [
      { type: 'response.created', response: { id: 'resp_x', model: 'fixture' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'The result ' },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'is 42.' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] } },
      { type: 'response.completed', response: { id: 'resp_x', model: 'fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] }] } },
    ];
const failedFrame = { type: 'response.failed', response: { id: 'resp_f', status: 'failed', error: { code: 'server_error', message: 'fixture upstream failure' } } };

const anthropic = (kind) => {
  const start = { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 20, output_tokens: 1 } } };
  if (kind === 'tool-call') return sse([start, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fx1', name: 'lookup', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"key":"answer"}' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }, { type: 'message_stop' }], true);
  const body = [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The result is 42.' } }, { type: 'content_block_stop', index: 0 }];
  return sse(kind === 'truncated' ? body : [...body, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } }, { type: 'message_stop' }], true);
};
const gemini = (kind) => {
  const chunk = (parts, extra = {}) => `data: ${j({ candidates: [{ content: { role: 'model', parts }, ...extra }], modelVersion: 'fixture' })}\n\n`;
  if (kind === 'tool-call') return chunk([{ functionCall: { name: 'lookup', args: { key: 'answer' } } }], { finishReason: 'STOP' }).replace('"modelVersion":"fixture"', '"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":6,"totalTokenCount":26},"modelVersion":"fixture"');
  const first = chunk([{ text: 'The result ' }]);
  if (kind === 'truncated') return first;
  return first + chunk([{ text: 'is 42.' }], { finishReason: 'STOP' }).replace('"modelVersion":"fixture"', '"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":8,"totalTokenCount":28},"modelVersion":"fixture"');
};
// Vertex streamGenerateContent without alt=sse streams one JSON array.
const geminiArray = (kind) => {
  const parts = gemini(kind).split('\n\n').filter(Boolean).map((p) => p.replace(/^data: /, ''));
  return kind === 'truncated' ? `[${parts.join(',')},` : `[${parts.join(',')}]`;
};
const chat = (kind) => {
  const c = (delta, finish = null) => `data: ${j({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const usage = `data: ${j({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`;
  if (kind === 'tool-call') return c({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fx1', type: 'function', function: { name: 'lookup', arguments: '' } }] }) + c({ tool_calls: [{ index: 0, function: { arguments: '{"key":"answer"}' } }] }) + c({}, 'tool_calls') + usage + 'data: [DONE]\n\n';
  const head = c({ role: 'assistant', content: '' }) + c({ content: 'The result is 42.' });
  return kind === 'truncated' ? head : head + c({}, 'stop') + usage + 'data: [DONE]\n\n';
};

const FIXTURE_MODELS = ['gpt-fixture', 'claude-sonnet-4-6', 'gemini-2.5-pro', 'grok-4', 'muse-fixture', 'cc-fixture', 'mimo-fixture', 'go-fixture', 'cursor-fixture', 'devin-fixture', 'gemini-3-pro'];
// HTTP router: auxiliary GETs and token refreshes get fixed replies; the rest is the scenario.
const httpRouter = (reply) => (rec, n) => {
  if (rec.method === 'GET' && /well-known/.test(rec.path)) return { status: 200, contentType: 'application/json', body: j({ issuer: 'https://auth.x.ai', authorization_endpoint: 'https://auth.x.ai/oauth2/auth', token_endpoint: 'https://auth.x.ai/oauth2/token' }) };
  if (/\/api\/v2\/config/.test(rec.path)) return { status: 200, contentType: 'application/json', body: j({ providers: { 'opencode-go': { settings: { baseURL: 'https://opencode.ai/inference/go/openai/v1' }, models: { 'go-fixture': { name: 'Go Fixture', limit: { context: 128000, output: 8192 } } } } } }) };
  if (rec.method === 'GET') return { status: 200, contentType: 'application/json', body: j({ object: 'list', data: FIXTURE_MODELS.map((id) => ({ id, object: 'model' })), models: FIXTURE_MODELS.map((id) => ({ name: id, id })) }) };
  if (/exchange_user_api_key/.test(rec.path)) return { status: 200, contentType: 'application/json', body: j({ accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token' }) };
  if (/oauth2?\/token|\/token$|oauth2\.googleapis/.test(rec.path)) return { status: 200, contentType: 'application/json', body: j({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 3600, token_type: 'Bearer' }) };
  return typeof reply === 'function' ? reply(rec, n) : reply;
};
const sseReply = (body) => ({ status: 200, contentType: 'text/event-stream', body });
const errReply = (status = 401) => ({ status, contentType: 'application/json', body: j({ error: { message: 'fixture upstream error', type: 'fixture_error', code: String(status) } }) });
const httpScenarios = (bodyFor) => ({
  text: () => ({ http: httpRouter(sseReply(bodyFor('text'))) }),
  'tool-call': () => ({ http: httpRouter(sseReply(bodyFor('tool-call'))) }),
  'error-401': () => ({ http: httpRouter(errReply(401)) }),
  'error-400': () => ({ http: httpRouter(errReply(400)) }),
  'truncated-eof': () => ({ http: httpRouter(sseReply(bodyFor('truncated'))) }),
  'truncated-reset': () => ({ http: httpRouter({ ...sseReply(bodyFor('truncated')), truncate: true }) }),
});
const wsScenarios = {
  text: () => ({ ws: { onMessage: (_t, c) => respEvents(false).forEach((e) => c.out(e)) } }),
  'tool-call': () => ({ ws: { onMessage: (_t, c) => respEvents(true).forEach((e) => c.out(e)) } }),
  'error-http-handshake-401': () => ({ wsHandshakeStatus: 401, ws: {} }),
  'error-failed-frame': () => ({ ws: { onMessage: (_t, c) => { c.out({ type: 'response.created', response: { id: 'resp_f', model: 'fixture' } }); c.out(failedFrame); } } }),
  'error-error-frame': () => ({ ws: { onMessage: (_t, c) => c.out({ type: 'error', status: 400, error: { type: 'invalid_request_error', code: 'bad', message: 'fixture bad request' } }) } }),
  truncated: () => ({ ws: { onMessage: (_t, c) => { respEvents(false).slice(0, 3).forEach((e) => c.out(e)); setTimeout(() => c.terminate(), 30); } } }),
};
const respSse = (kind) => (kind === 'truncated' ? sse(respEvents(false).slice(0, 4), true) : sse(respEvents(kind === 'tool-call'), true));

// ---- adapters ---------------------------------------------------------------------
const adapters = [
  { id: 'openai-responses-ws', env: { MIXDOG_OAI_TRANSPORT: 'ws' }, make: async () => new (await P('openai-ws.mjs')).OpenAIDirectProvider({ apiKey: 'fixture-key' }), model: 'gpt-fixture', scenarios: wsScenarios },
  { id: 'openai-oauth-responses-ws', env: { MIXDOG_OAI_TRANSPORT: 'ws' }, setup: () => cred('openai-oauth.json', oauthDoc), make: async () => new (await P('openai-oauth.mjs')).OpenAIOAuthProvider({}), model: 'gpt-fixture', scenarios: wsScenarios },
  { id: 'openai-oauth-responses-sse', env: { MIXDOG_OAI_TRANSPORT: 'http' }, setup: () => cred('openai-oauth.json', oauthDoc), make: async () => new (await P('openai-oauth.mjs')).OpenAIOAuthProvider({}), model: 'gpt-fixture', scenarios: httpScenarios(respSse) },
  { id: 'openai-responses-sse-direct', env: { MIXDOG_OAI_TRANSPORT: 'http' }, make: async () => new (await P('openai-ws.mjs')).OpenAIDirectProvider({ apiKey: 'fixture-key' }), model: 'gpt-fixture', scenarios: httpScenarios(respSse) },
  { id: 'anthropic-oauth', setup: () => cred('anthropic-oauth-credentials.json', { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: FAR, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } }), make: async () => new (await P('anthropic-oauth.mjs')).AnthropicOAuthProvider({}), model: 'claude-sonnet-4-6', scenarios: httpScenarios(anthropic) },
  { id: 'gemini', make: async () => new (await P('gemini.mjs')).GeminiProvider({ apiKey: 'fixture-key' }), model: 'gemini-2.5-pro', scenarios: httpScenarios(gemini) },
  { id: 'vertex-ai-api-key', make: async () => new (await P('vertex-ai.mjs')).VertexAIProvider({ authMode: 'api-key', apiKey: 'fixture-key' }), model: 'gemini-2.5-pro', scenarios: httpScenarios(geminiArray) },
  { id: 'vertex-ai-adc', setup: () => { const f = join(dataDir, 'adc.json'); writeFileSync(f, j({ type: 'authorized_user', client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: 'fixture-refresh-token' })); process.env.GOOGLE_APPLICATION_CREDENTIALS = f; }, make: async () => new (await P('vertex-ai.mjs')).VertexAIProvider({ authMode: 'adc', project: 'fixture-project', location: 'us-central1' }), model: 'gemini-2.5-pro', scenarios: httpScenarios(geminiArray) },
  { id: 'grok-oauth', setup: () => cred('grok-oauth.json', oauthDoc), make: async () => new (await P('grok-oauth.mjs')).GrokOAuthProvider({}), model: 'grok-4', scenarios: httpScenarios(respSse) },
  { id: 'antigravity-oauth', setup: () => cred('antigravity-oauth.json', { ...oauthDoc, project_id: 'fixture-project' }), make: async () => new (await P('antigravity-oauth.mjs')).AntigravityOAuthProvider({}), model: 'gemini-3-pro', scenarios: httpScenarios(gemini) },
  { id: 'muse-code-oauth', setup: () => cred('muse-code-oauth.json', { accessToken: 'fixture-access-token', apiKey: 'fixture-key', accountId: 'acct-fixture', email: 'fixture@example.invalid' }), make: async () => new (await P('muse-code-oauth.mjs')).MuseCodeOAuthProvider({}), model: 'muse-fixture', scenarios: httpScenarios(chat) },
  { id: 'command-code-oauth', setup: () => cred('command-code-oauth.json', { apiKey: 'fixture-key', userId: 'u1', userName: 'fixture' }), make: async () => new (await P('command-code-oauth.mjs')).CommandCodeOAuthProvider({}), model: 'cc-fixture', scenarios: httpScenarios(chat) },
  { id: 'mimo-oauth', setup: () => cred('mimo-oauth.json', { apiKey: 'fixture-key', uid: 'u1' }), make: async () => new (await P('mimo-oauth.mjs')).MimoOAuthProvider({}), model: 'mimo-fixture', scenarios: httpScenarios(chat) },
  { id: 'opencode-go-oauth', setup: () => cred('opencode-go-oauth.json', oauthDoc), make: async () => new (await P('opencode-go-oauth.mjs')).OpenCodeGoOAuthProvider({}), model: 'go-fixture', scenarios: httpScenarios(chat) },
  { id: 'cursor-api', setup: () => cred('cursor-oauth.json', { access_token: 'fixture-access-token', expires_at: FAR }), make: async () => new (await P('cursor.mjs')).CursorApiProvider({ apiKey: 'fixture-key' }), model: 'cursor-fixture', scenarios: { 'error-http-401': () => ({ http: httpRouter(errReply(401)), h2: () => ({ status: 401, contentType: 'application/json', frames: [Buffer.from(j({ code: 'unauthenticated', message: 'fixture' }))] }) }), truncated: () => ({ http: httpRouter(errReply(401)), h2: () => ({ status: 200, frames: [Buffer.from([0, 0, 0, 0, 2, 123, 125])], reset: true }) }) } },
  { id: 'devin-oauth', setup: () => cred('devin-oauth.json', { access_token: 'fixture-access-token', expires_at: FAR }), make: async () => new (await P('devin.mjs')).DevinOAuthProvider({}), model: 'devin-fixture', scenarios: { 'error-401': () => ({ http: httpRouter(errReply(401)) }), 'error-400': () => ({ http: httpRouter(errReply(400)) }), 'truncated-reset': () => ({ http: httpRouter({ status: 200, contentType: 'application/connect+proto', body: '\u0000\u0000\u0000\u0000\u0002{}', truncate: true }) }) } },
];

const norm = (r) => ({ content: r?.content ?? null, toolCalls: (r?.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })), stopReason: r?.stopReason ?? null, usage: r?.usage ? { inputTokens: r.usage.inputTokens ?? null, outputTokens: r.usage.outputTokens ?? null } : null });
const finalDir = join(FIXTURES_ROOT, 'providers-intercepted');
// Staged and swapped in only after the whole set is written (a crash keeps the old set).
const outDir = stageSet(finalDir, only ? [only] : null);
const recorded = [];
const unrecorded = [];
for (const a of adapters) {
  if (only && a.id !== only) continue;
  rmSync(join(outDir, a.id), { recursive: true, force: true });
  for (const [name, mk] of Object.entries(a.scenarios)) {
    const saved = {};
    for (const [k, v] of Object.entries(a.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      a.setup?.();
      const dispatched = [];
      let result;
      const script = mk();
      await (await P('openai-ws-pool.mjs'))._clearWebSocketPoolForTest?.();
      await hub.run(script, async () => {
        try {
          const provider = await a.make();
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error('recorder: no terminal after 45s')), 45000);
          // anthropic-oauth fires `void this._refreshModelCache()` after a reply; its GET
          // /v1/models and the catalog it installs would otherwise land in whichever scenario
          // happens to be running (a race). Track and settle it inside its own scenario.
          const background = [];
          if (typeof provider._refreshModelCache === 'function') {
            const real = provider._refreshModelCache.bind(provider);
            provider._refreshModelCache = (...args) => { const p = real(...args); background.push(p.catch(() => {})); return p; };
          }
          try {
            result = { ok: norm(await provider.send(MSG, a.model, TOOLS, { signal: ac.signal, onToolCall: (c) => dispatched.push({ id: c.id, name: c.name, arguments: c.arguments }) })) };
          } finally { clearTimeout(timer); await Promise.all(background); }
        } catch (e) {
          const abortedByRecorder = /recorder: no terminal/.test(String(e?.message ?? e)) || e?.cause?.message?.includes?.('recorder: no terminal');
          result = { error: { name: e?.name ?? null, message: String(e?.message ?? e).slice(0, 300), status: e?.status ?? e?.httpStatus ?? null }, ...(abortedByRecorder ? { abortedByRecorder: true } : {}) };
        }
      }, `${a.id}/${name}`);
      const determinism = hub.lastDeterminism;
      const records = hub.records.map((r) => ({ ...r }));
      if (!records.length) { unrecorded.push({ id: a.id, scenario: name, reason: 'adapter made no network call', adapterResult: result }); continue; }
      const dir = join(outDir, a.id, name);
      writeJson(join(dir, 'exchange.json'), { transports: [...new Set(records.map((r) => r.transport))], records, determinism });
      writeJson(join(dir, 'result.json'), { ...result, dispatchedToolCalls: dispatched });
      recorded.push(`${a.id}/${name}`);
    } catch (e) {
      unrecorded.push({ id: a.id, scenario: name, reason: String(e?.message ?? e).slice(0, 300) });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
}
writeJson(join(outDir, 'unrecorded.json'), { note: 'Scenarios that did not produce a recording, with the reason.', unrecorded });
writeSetManifest(outDir, { set: 'providers-intercepted', recorder: 'benchmarks/rust-core/recorders/record-providers-intercepted.mjs', command: 'node benchmarks/rust-core/recorders/record-providers-intercepted.mjs --tree <tree>', extra: { scenarios: recorded.sort(), unrecordedCount: unrecorded.length } });
await hub.close();
commitStage(outDir, finalDir);
rmSync(dataDir, { recursive: true, force: true });
console.log(`recorded ${recorded.length}; unrecorded ${unrecorded.length}`);
for (const u of unrecorded) console.log(` - ${u.id}/${u.scenario}: ${u.reason}`);
process.exit(0);
