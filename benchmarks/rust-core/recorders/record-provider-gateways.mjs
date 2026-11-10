#!/usr/bin/env node
// End-to-end sends through Node's first-party gateways (one per wire each serves) and through a custom provider with
// several API keys (the key pool's failover), recorded from the b6f tree for the Rust gateway engines and key pool
// (`mixdog-ai` `registry::gateway_replay`). Every provider is built by the real registry (`initProviders` +
// `getProvider`), so the class Node instantiates, its account or key pool and its wire routing all run. Every request
// goes to a scripted loopback endpoint: `fetch` is redirected to a local server that records the request as it
// arrived (origin the product addressed, path, headers in arrival order, body bytes) and answers from the scenario's
// script. Fixture keys are short placeholders and are kept as sent, so the failover scenarios show which key served.
// Node's time is a virtual queue: `Date.now` and `setTimeout` follow `clock`, a timer runs only when `advance`
// reaches it (due time, then registration order, one callback at a time, microtasks drained between callbacks); no
// scenario advances it, so no product timer (watchdogs, preconnect) ever fires, and the cooldowns the pool stores are
// relative to the fixed clock. The keychain is a stub (no OS keychain is read) and the Windows ACL helper a no-op (no
// child process).
//
//   node benchmarks/rust-core/recorders/record-provider-gateways.mjs --tree <b6f tree> [--only <scenario id>]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire, register } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, recordingProvenance, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { installDeterministicWorld } from './lib/deterministic-world.mjs';

const RECORDER = 'benchmarks/rust-core/recorders/record-provider-gateways.mjs';
const args = parseArgs();
const tree = resolveTree(args);
const only = args.get('only');

const T0 = Date.parse('2026-11-09T12:00:00Z');
mkdirSync('D:/mixdog-build/tmp/w6', { recursive: true });
const dataDir = mkdtempSync('D:/mixdog-build/tmp/w6/gateways-');
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_HOME = join(dataDir, 'home');
process.env.HOME = process.env.USERPROFILE = join(dataDir, 'home');
// The usage ledger stays in memory: a file in the data directory would stay open past the recording.
process.env.MIXDOG_USAGE_LEDGER_PATH = ':memory:';
for (const k of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|^MIXDOG_(XAI|OAI)_/.test(k)) delete process.env[k];

// ---- deterministic world: fixed pid and random draws, virtual time ----
installDeterministicWorld({ start: T0, pid: 4242 });
let seed = 0x2545f491;
Math.random = () => {
  seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
  return seed / 4294967296;
};
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
// A failure bound on one send, on the real clock (the product's own timers are virtual and never fire).
const SEND_DEADLINE_MS = 60_000;
const withinDeadline = (label, promise) => {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`recorder: ${label} did not settle within ${SEND_DEADLINE_MS} ms`)), SEND_DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => realClearTimeout(timer));
};
const clock = { now: T0, seq: 0, timers: new Map() };
Date.now = () => clock.now;
globalThis.setTimeout = (fn, ms = 0, ...rest) => {
  const id = ++clock.seq;
  clock.timers.set(id, { id, due: clock.now + Math.max(0, Number(ms) || 0), fn, rest });
  return { id, unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
};
globalThis.clearTimeout = (timer) => void clock.timers.delete(timer?.id ?? timer);

// ---- no OS keychain, no ACL child process ----
const secrets = {};
const keychain = createRequire(join(tree, 'package.json'))('./src/lib/keychain-cjs.cjs');
keychain.getSecret = (account) => secrets[account] ?? null;
keychain.getSecretAsync = async (account) => secrets[account] ?? null;
keychain.hasSecret = (account) => Boolean(secrets[account]);
const permissionsStub = [
  'export function disableOwnerOnlyAclSyncBridgeForTests() {}',
  'export async function prewarmOwnerOnlyAclWin32() {}',
  'export function ownerOnlyAclHelperForTests() { return null; }',
  'export function enforceOwnerOnlyAclWin32() {}',
  'export async function enforceOwnerOnlyAclWin32Async() {}',
  'export async function enforceOwnerOnlyDirectoryWin32Async() {}',
].join('\n');
const hooks = `export async function load(url, context, next) {
  if (url.endsWith('/src/runtime/shared/file-permissions.mjs')) return { format: 'module', source: ${JSON.stringify(permissionsStub)}, shortCircuit: true };
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

// ---- the scripted loopback endpoint ----
// `events`: the current send's callback log; each request's arrival is logged in it, so a notice is placed between
// the requests it came between.
const hub = { records: [], reply: null, events: null };
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const origin = req.headers['x-bench-origin'];
  const order = req.rawHeaders.filter((_v, i) => i % 2 === 0).map((n) => n.toLowerCase()).filter((n) => n !== 'x-bench-origin');
  const headers = {};
  for (const name of order) headers[name] = name === 'host' ? new URL(origin).host : req.headers[name];
  const rec = { method: req.method, origin, path: req.url, headers, body: Buffer.concat(chunks).toString('utf8') };
  hub.records.push(rec);
  hub.events?.push({ on: 'request', n: hub.records.length });
  const reply = hub.reply?.(rec, hub.records.length) ?? { status: 404, contentType: 'application/json', body: '{"error":{"message":"not scripted"}}' };
  rec.reply = reply;
  res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'text/event-stream' });
  res.end(reply.body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  const headers = new Headers(init?.headers ?? req?.headers ?? {});
  headers.set('x-bench-origin', url.origin);
  const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
  return realFetch(target, req ? { method: req.method, body: req.body, duplex: 'half', signal: req.signal, ...init, headers } : { ...init, headers });
};

const P = (f) => import(pathToFileURL(join(tree, 'src/runtime', f)).href);
writeFileSync(join(dataDir, 'litellm-catalog.json'), JSON.stringify({ fetchedAt: T0, data: {} }));
writeFileSync(join(dataDir, 'modelsdev-catalog.json'), JSON.stringify({ fetchedAt: T0, data: {} }));
const { initProviders, getProvider } = await P('agent/orchestrator/providers/registry.mjs');
const { pinSessionWireRoute } = await P('agent/orchestrator/providers/wire-route.mjs');
const { newProviderAccountId, readProviderAccountPool, setCustomProviderKeyIds } = await P('shared/provider-accounts.mjs');

// ---- answers ----
const j = JSON.stringify;
const sse = (events, named = false) => events.map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${j(e)}\n\n`).join('');
const ok = (body) => ({ status: 200, contentType: 'text/event-stream', body });
const refusal = (status, error) => ({ status, contentType: 'application/json', body: j({ error }) });
const chatText = (text) => {
  const c = (delta, finish = null) => ({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] });
  return `${sse([c({ role: 'assistant', content: '' }), c({ content: text }), c({}, 'stop'), { id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }])}data: [DONE]\n\n`;
};
const chatTool = () => {
  const c = (delta, finish = null) => ({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] });
  return `${sse([c({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fx1', type: 'function', function: { name: 'lookup', arguments: '' } }] }), c({ tool_calls: [{ index: 0, function: { arguments: '{"key":"answer"}' } }] }), c({}, 'tool_calls'), { id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } }])}data: [DONE]\n\n`;
};
// Text, then an in-band quota error before the stream ends: output already reached the caller.
const chatTextThenQuota = () => {
  const c = (delta) => ({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] });
  return sse([c({ role: 'assistant', content: '' }), c({ content: 'Partial ' }), { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } }]);
};
const responsesText = () => sse([
  { type: 'response.created', response: { id: 'resp_x', model: 'fixture' } },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [] } },
  { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'The result ' },
  { type: 'response.output_text.delta', output_index: 0, item_id: 'm1', delta: 'is 42.' },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] } },
  { type: 'response.completed', response: { id: 'resp_x', model: 'fixture', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 }, output: [{ type: 'message', id: 'm1', role: 'assistant', content: [{ type: 'output_text', text: 'The result is 42.' }] }] } },
], true);
const anthropicText = () => sse([
  { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The result is 42.' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
], true);
const geminiText = () => sse([
  { candidates: [{ content: { role: 'model', parts: [{ text: 'The result ' }] } }], modelVersion: 'fixture' },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'is 42.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 }, modelVersion: 'fixture' },
]);
const QUOTA = { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' };

// ---- inputs ----
const SYSTEM = { role: 'system', content: 'You are a fixture assistant.' };
const USER = { role: 'user', content: 'Look up the answer.' };
const TOOLS = [{ name: 'lookup', description: 'Read a value', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }];
const cred = (name, doc) => writeFileSync(join(dataDir, name), j(doc));
const FAR = T0 + 10 * 365 * 24 * 3600 * 1000;
const base = { enabled: true, preconnect: false };
const custom = (apiKey, extra = {}) => ({
  type: 'custom', name: 'Keys', protocol: 'openai-chat', baseURL: 'https://keys.example.com/v1', enabled: true, apiKey, preconnect: false,
  schemaVersion: 2, modelOverrides: { m1: { manual: true } }, headers: { 'X-Team': 'blue' }, ...extra,
});
const keyOf = (rec) => String(rec.headers.authorization || rec.headers['x-api-key'] || '').replace(/^Bearer /, '');
const chatReasoningText = (reasoning, text) => {
  const c = (delta, finish = null) => ({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] });
  return `${sse([c({ role: 'assistant', content: '' }), c({ reasoning_content: reasoning }), c({ content: text }), c({}, 'stop'), { id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }])}data: [DONE]\n\n`;
};
// An earlier tool round without reasoning, then a turn that kept its reasoning.
const REASONED_HISTORY = [
  { role: 'user', content: 'Before.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'lookup', arguments: { key: 'a' } }] },
  { role: 'tool', toolCallId: 'call_a', content: '1' },
  { role: 'assistant', content: 'Earlier answer.', reasoning: 'Earlier thought.', reasoningContent: 'Earlier thought.' },
];
const ANTHROPIC_QUOTA = { type: 'error', error: { type: 'insufficient_quota', message: 'You exceeded your current quota.' } };
// Reasoning, then an in-band quota error, in one body: the reasoning reached the caller before the refusal.
const chatReasoningThenQuota = () => {
  const c = (delta) => ({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] });
  return sse([c({ role: 'assistant', content: '' }), c({ reasoning_content: 'Thinking first.' }), { error: QUOTA }]);
};
// An earlier turn on the routed wire, with the replay state a reroute lowers.
const ROUTED_HISTORY = [
  { role: 'user', content: 'Before.' },
  { role: 'assistant', content: 'Earlier answer.', reasoningContent: 'Earlier thought.', thinkingBlocks: [{ type: 'thinking', thinking: 'Earlier thought.', signature: 'sig-earlier' }] },
];
const UNSUPPORTED = { message: 'This model is not available on the /v1/messages endpoint.', code: 400 };

// One send: `session` (optional) is pinned first as the turn does (`pinSessionWireRoute`).
const send = (model, { tools = [], history = [], session = null, opts = {} } = {}) => ({ model, tools, history, session, opts });

const scenarios = [
  // xAI: Responses over HTTP/SSE by default; Chat when its API mode says so.
  { id: 'xai-responses', provider: 'xai', config: { ...base, apiKey: 'xai-fixture' }, reply: () => ok(responsesText()), sends: [send('grok-4.3')] },
  { id: 'xai-chat-api-mode', provider: 'xai', config: { ...base, apiKey: 'xai-fixture', apiMode: 'chat' }, reply: () => ok(chatText('The result is 42.')), sends: [send('grok-4.3', { opts: { sessionId: 'sess-xai' } })] },
  // Muse Code: Responses only.
  { id: 'muse-responses', provider: 'muse-code-oauth', setup: () => cred('muse-code-oauth.json', { accessToken: 'muse-access', apiKey: 'muse-fixture', accountId: 'acct-fixture', email: 'fixture@example.invalid' }), config: { ...base }, reply: () => ok(responsesText()), sends: [send('muse-spark-1.3')] },
  // OpenRouter: Claude on Messages, GPT on Responses, the rest on Chat.
  { id: 'openrouter-messages', provider: 'openrouter', config: { ...base, apiKey: 'or-fixture' }, reply: () => ok(anthropicText()), sends: [send('anthropic/claude-sonnet-4.5')] },
  { id: 'openrouter-responses', provider: 'openrouter', config: { ...base, apiKey: 'or-fixture' }, reply: () => ok(responsesText()), sends: [send('openai/gpt-5')] },
  { id: 'openrouter-chat', provider: 'openrouter', config: { ...base, apiKey: 'or-fixture' }, reply: () => ok(chatText('The result is 42.')), sends: [send('meta-llama/llama-4-maverick')] },
  // A model switch inside one session: the pin is resolved again for the new model.
  {
    id: 'openrouter-model-switch', provider: 'openrouter', config: { ...base, apiKey: 'or-fixture' },
    reply: (rec) => ok(rec.path.endsWith('/messages') ? anthropicText() : responsesText()),
    sends: [send('anthropic/claude-sonnet-4.5', { session: { model: 'anthropic/claude-sonnet-4.5' } }), send('openai/gpt-5', { session: { model: 'openai/gpt-5', switched: true } })],
  },
  // A clear "unsupported" refusal on the routed wire: the same request once more on the next wire; the session's
  // pin moves there and its earlier turns are lowered, so the next send goes straight to the new wire.
  {
    id: 'openrouter-reroute-unsupported', provider: 'openrouter', config: { ...base, apiKey: 'or-fixture' },
    // 400, not 404: a 404 on the Messages wire first takes the Anthropic engine's one non-streaming replay.
    reply: (rec) => (rec.path.endsWith('/messages') ? refusal(400, UNSUPPORTED) : ok(rec.path.endsWith('/responses') ? responsesText() : chatText('The result is 42.'))),
    sends: [
      send('anthropic/claude-sonnet-4.5', { history: ROUTED_HISTORY, session: { model: 'anthropic/claude-sonnet-4.5' } }),
      send('anthropic/claude-sonnet-4.5', { history: ROUTED_HISTORY, session: { model: 'anthropic/claude-sonnet-4.5' } }),
    ],
  },
  // A refusal that does not say the wire is unsupported is the send's error.
  {
    id: 'openrouter-refusal-stays', provider: 'openrouter', config: { ...base, apiKey: 'or-fixture' },
    reply: () => refusal(400, { message: 'No endpoints found for anthropic/claude-sonnet-4.5.', code: 400 }),
    sends: [send('anthropic/claude-sonnet-4.5')],
  },
  // The switch happens once: the next wire refusing as well ends the send.
  {
    id: 'openrouter-reroute-once', provider: 'openrouter', config: { ...base, apiKey: 'or-fixture' },
    reply: () => refusal(405, { message: 'Method Not Allowed', code: 405 }),
    sends: [send('anthropic/claude-sonnet-4.5')],
  },
  // DeepSeek: Messages for a send carrying tools, Chat for a tool-less one; a session pinned to Messages keeps it.
  { id: 'deepseek-messages-tools', provider: 'deepseek', config: { ...base, apiKey: 'ds-fixture' }, reply: () => ok(anthropicText()), sends: [send('deepseek-v4-pro', { tools: TOOLS })] },
  { id: 'deepseek-chat-toolless', provider: 'deepseek', config: { ...base, apiKey: 'ds-fixture' }, reply: () => ok(chatText('The result is 42.')), sends: [send('deepseek-v4-pro')] },
  { id: 'deepseek-pinned-toolless', provider: 'deepseek', config: { ...base, apiKey: 'ds-fixture' }, reply: (rec) => ok(rec.path.endsWith('/messages') ? anthropicText() : chatText('The result is 42.')), sends: [send('deepseek-v4-pro', { session: { model: 'deepseek-v4-pro' } })] },
  // OpenCode Go: each brand on its one wire (cold-catalog prefixes).
  ...[
    ['opencode-go-responses', 'gpt-5.5', responsesText],
    ['opencode-go-messages', 'minimax-m3', anthropicText],
    ['opencode-go-gemini', 'gemini-3-pro', geminiText],
    ['opencode-go-chat', 'glm-5', () => chatText('The result is 42.')],
  ].map(([id, model, body]) => ({
    id, provider: 'opencode-go-oauth', setup: () => cred('opencode-go-oauth.json', { access_token: 'go-access', refresh_token: 'go-refresh', expires_at: FAR, account_id: 'acct-fixture', email: 'fixture@example.invalid' }),
    config: { ...base }, prime: true,
    // The organization's console config names the gateway; its models are the roster.
    reply: (rec) => (rec.method === 'GET'
      ? { status: 200, contentType: 'application/json', body: j({ providers: { 'opencode-go': { settings: { baseURL: 'https://opencode.ai/inference/go/openai/v1' }, models: { [model]: { name: model, limit: { context: 128000, output: 8192 } } } } } }) }
      : ok(body())),
    sends: [send(model, { opts: { sessionId: 'sess-go' } })],
  })),
  // Command Code: Claude answers on Messages even with no roster; the rest on Chat.
  // Command Code: the roster's declared endpoints pick the wire (read once, before the sends).
  ...[
    ['command-code-messages', 'claude-sonnet-4-6', anthropicText],
    ['command-code-responses', 'gpt-5.5', responsesText],
    ['command-code-chat', 'deepseek/deepseek-v4-flash', () => chatText('The result is 42.')],
  ].map(([id, model, body]) => ({
    id, provider: 'command-code-oauth', setup: () => cred('command-code-oauth.json', { apiKey: 'cc-fixture', userId: 'u1', userName: 'fixture' }),
    config: { ...base }, prime: true,
    reply: (rec) => (rec.method === 'GET'
      ? { status: 200, contentType: 'application/json', body: j({ data: [
        { id: 'claude-sonnet-4-6', supported_endpoints: ['/v1/messages'] },
        { id: 'gpt-5.5', supported_endpoints: ['/v1/chat/completions', '/v1/responses'] },
        { id: 'deepseek/deepseek-v4-flash' },
      ] }) }
      : ok(body())),
    sends: [send(model)],
  })),
  // A custom provider's additional keys.
  {
    id: 'custom-keys-switch', provider: 'custom-keys-switch', keys: ['sk-first', 'sk-second'],
    reply: (rec) => (keyOf(rec) === 'sk-first' ? refusal(429, QUOTA) : ok(chatText('from second'))),
    sends: [send('m1'), send('m1')],
  },
  { id: 'custom-keys-exhausted', provider: 'custom-keys-exhausted', keys: ['sk-a', 'sk-b', 'sk-c'], reply: () => refusal(429, QUOTA), sends: [send('m1'), send('m1')] },
  {
    id: 'custom-keys-not-quota', provider: 'custom-keys-not-quota', keys: ['sk-first', 'sk-second'],
    reply: (rec) => (keyOf(rec) === 'sk-first' ? refusal(400, { message: 'Invalid request: unknown field', type: 'invalid_request_error' }) : ok(chatText('from second'))),
    sends: [send('m1')],
  },
  {
    id: 'custom-keys-after-output', provider: 'custom-keys-after-output', keys: ['sk-first', 'sk-second'],
    reply: (rec) => (keyOf(rec) === 'sk-first' ? ok(chatTextThenQuota()) : ok(chatText('from second'))),
    sends: [send('m1')],
  },
  {
    id: 'custom-keys-reasoning-then-quota', provider: 'custom-keys-reasoning-then-quota', keys: ['sk-first', 'sk-second'],
    reply: (rec) => (keyOf(rec) === 'sk-first' ? ok(chatReasoningThenQuota()) : ok(chatText('from second'))),
    sends: [send('m1')],
  },
  // A custom model that replays its reasoning: one key; the reply's reasoning is kept, earlier turns' sent back.
  {
    id: 'custom-reasoning-replay', provider: 'custom-reasoning-replay', keys: ['sk-only'],
    config: { modelOverrides: { m1: { manual: true, reasoning: { levels: ['low', 'high'], replay: true } } } },
    reply: () => ok(chatReasoningText('Fresh thought.', 'The result is 42.')),
    sends: [send('m1', { history: REASONED_HISTORY })],
  },
  // The same with two keys: the Chat wire's reasoning goes to whichever key serves.
  {
    id: 'custom-keys-reasoning', provider: 'custom-keys-reasoning', keys: ['sk-first', 'sk-second'],
    config: { modelOverrides: { m1: { manual: true, reasoning: { levels: ['low', 'high'], replay: true } } } },
    reply: (rec) => (keyOf(rec) === 'sk-first' ? refusal(429, QUOTA) : ok(chatText('from second'))),
    sends: [send('m1', { history: REASONED_HISTORY })],
  },
  // Anthropic protocol, two keys: a turn the second key served keeps its thinking for that key alone.
  {
    id: 'custom-keys-anthropic-thinking', provider: 'custom-keys-anthropic-thinking', keys: ['sk-first', 'sk-second'],
    config: { protocol: 'anthropic', baseURL: 'https://keys.example.com/v1' },
    reply: (rec) => (keyOf(rec) === 'sk-first' ? { status: 429, contentType: 'application/json', body: j(ANTHROPIC_QUOTA) } : ok(anthropicText())),
    sends: [send('m1', {
      history: (ids, provider) => [
        { role: 'user', content: 'Before.' },
        {
          role: 'assistant', content: 'Earlier answer.',
          thinkingBlocks: [{ type: 'thinking', thinking: 'Earlier thought.', signature: 'sig-earlier' }],
          providerMetadata: { accountRouting: { provider, accountId: ids[0], sessionAccountId: ids[0] } },
        },
      ],
    })],
  },
];

// ---- run ----
const resultOf = (r) => ({
  content: r?.content ?? null,
  reasoning: r?.reasoning ?? null,
  toolCalls: (r?.toolCalls ?? []).map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
  reasoningContent: r?.reasoningContent ?? null,
  stopReason: r?.stopReason ?? null,
  usage: r?.usage ? { inputTokens: r.usage.inputTokens ?? null, outputTokens: r.usage.outputTokens ?? null } : null,
  providerMetadata: r?.providerMetadata ?? null,
  wireReroute: r?.wireReroute ?? null,
});
const errorOf = (e) => ({
  message: String(e?.message ?? e),
  status: e?.status ?? e?.httpStatus ?? null,
  code: typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : null,
  quotaExhausted: e?.quotaExhausted ?? null,
});

// A set of its own: the `providers` set is another recorder's run, with its own helper hashes.
const finalDir = join(FIXTURES_ROOT, 'provider-gateways');
const outDir = stageSet(finalDir, only ? [`${only}.json`] : null);
const recorded = [];
for (const s of scenarios) {
  if (only && s.id !== only) continue;
  s.setup?.();
  let config = s.config;
  let ids = [];
  if (s.keys) {
    const [primary, ...extra] = s.keys;
    ids = extra.map((value) => {
      const id = newProviderAccountId();
      secrets[`agent.${s.provider}.apiKey.${id}`] = value;
      return id;
    });
    await setCustomProviderKeyIds(s.provider, ids);
    config = custom(primary, s.config);
  }
  await initProviders({ [s.provider]: config });
  const provider = getProvider(s.provider);
  hub.reply = s.reply;
  // The roster read before the sends (the catalog refresh a running core makes), kept beside them.
  let primed = null;
  if (s.prime) {
    hub.records = [];
    await withinDeadline(`${s.id} listing`, provider.listModels());
    primed = hub.records.map(({ reply, ...rec }) => ({ ...rec, answer: { status: reply.status ?? 200, body: reply.body } }));
  }
  const sends = [];
  let session = null;
  for (const one of s.sends) {
    hub.records = [];
    const events = [];
    hub.events = events;
    const history = typeof one.history === 'function' ? one.history(ids, s.provider) : one.history;
    const opts = {
      ...one.opts,
      onTextDelta: (text) => events.push({ on: 'textDelta', text }),
      onToolCall: (call) => events.push({ on: 'toolCall', id: call.id, name: call.name, arguments: call.arguments }),
      onStageChange: (stage, payload) => events.push({ on: 'stageChange', stage, payload: payload ?? null }),
      // The session's liveness feed: only the reasoning kind is a delta the caller is shown (the manifest says why).
      onStreamDelta: (kind) => {
        if (kind === 'reasoning') events.push({ on: 'streamDelta', kind });
      },
    };
    let pin;
    if (one.session) {
      if (!session || one.session.switched) {
        session = { id: 'sess-1', provider: s.provider, model: one.session.model, wireRoute: null, messages: [...history] };
      }
      pin = await pinSessionWireRoute(session, provider);
      opts.session = session;
      opts.sessionId = session.id;
    }
    let outcome;
    try {
      outcome = { result: resultOf(await withinDeadline(`${s.id} ${one.model}`, provider.send([SYSTEM, ...history, USER], one.model, one.tools, opts))) };
    } catch (e) {
      if (/^recorder:/.test(e?.message)) throw e;
      outcome = { error: errorOf(e) };
    }
    hub.events = null;
    console.log(`${s.id} ${one.model}: ${hub.records.length} request(s)`);
    sends.push({
      model: one.model,
      tools: one.tools.map((t) => t.name),
      history,
      sessionId: opts.sessionId ?? null,
      ...(one.session ? { pin: pin ?? null, pinAfter: session.wireRoute ?? null } : {}),
      requests: hub.records.map(({ reply, ...rec }) => ({ ...rec, answer: { status: reply.status ?? 200, body: reply.body } })),
      events,
      ...outcome,
    });
  }
  const pool = s.keys ? readProviderAccountPool(s.provider) : null;
  writeJson(join(outDir, `${s.id}.json`), {
    id: s.id,
    provider: s.provider,
    config: config.apiKey ? { ...config, apiKey: config.apiKey } : config,
    ...(s.keys ? { keys: s.keys, keyIds: pool.accounts.map((row) => row.id), pool } : {}),
    ...(primed ? { listing: primed } : {}),
    sends,
  });
  recorded.push(s.id);
}
writeSetManifest(outDir, {
  set: 'provider-gateways',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <b6f tree>`,
  extra: {
    scenarios: recorded.sort(),
    clockStartMs: T0,
    // What the replay leaves out of a send's `events`, and why.
    replayExclusions: {
      "stageChange 'requesting' / 'streaming'": "the engine's spinner phases; in the core the turn loop raises them around the send (agent Stage::Connecting / Streaming), not the provider stream the replay reads",
      toolCall: "the folded result's toolCalls are compared instead (the core's stream carries the call as ToolCallDone, which the result holds)",
      "request header accept-encoding": "the recorder dials a plain-http loopback, so undici writes its http value; the replay writes the Rust request's head for that same scheme (node_http::head)",
      "request header x-stainless-runtime-version": "names the Node runtime the SDK runs under: the recorder's (provenance.nodeVersion, checked) where the product names its own (grok::SDK_RUNTIME_VERSION); the replay expects the product's",
      "listing requests to raw.githubusercontent.com and models.dev": "the shared model catalogs, fetched by the catalog service (ListingLookup), not by the provider under test",
      "error.code as a number": "the SDK keeps a numeric body code as a number; the core keeps every code as text, so a number is compared as its decimal text",
      "result.reasoning": "no engine of these wires returns it (null in every recording) and the core has no such result field: the reasoning shown is compared as the streamDelta events, the reasoning kept as reasoningContent",
      "error.quotaExhausted provider and model": "the core's error carries the quota kind and reset; the provider and model are the send's own",
      "onStreamDelta kinds other than 'reasoning'": "not logged by the recorder: 'transport' / 'semantic' / 'text' / 'tool' feed the session's liveness clock (the core's progress stamps), and the text and tool calls are compared as textDelta and the result's toolCalls; 'reasoning' is logged because it is the reasoning the caller is shown",
    }, provenance: recordingProvenance(RECORDER, [RECORDER, 'benchmarks/rust-core/recorders/lib/common.mjs', 'benchmarks/rust-core/recorders/lib/deterministic-world.mjs']) },
  // Refuses to write unless the loaded tree is exactly b6f10295a.
  identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146'),
});
commitStage(outDir, finalDir);
server.closeAllConnections();
server.close();
rmSync(dataDir, { recursive: true, force: true });
console.log(`recorded ${recorded.length}`);
process.exit(0);
