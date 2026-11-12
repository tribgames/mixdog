#!/usr/bin/env node
// The display-only `reconnecting` stage each provider's own retry ladder raises before a retry wait (`emitProviderRetryStage`,
// retry-executor.mjs:346), or does not: one send per provider route through its real class against the loopback endpoint, the first
// attempt refused as retryable and the second as not, so the send ends after exactly one retry wait. The Anthropic API (anthropic-api-transport.mjs:200)
// and the OpenAI-compatible Responses and Chat Completions sends (compat-request-policy.mjs:13, via openai-compat-xai-send.mjs:154 and
// openai-compat-chat-send.mjs:222) raise it and write their retry line; Vertex AI's Gemini models run the Gemini ladder by connection
// (runGeminiStreamAttempts, vertex-ai.mjs:382) with no `onRetry`, so their stream retry raises none. The Gemini API's own ladder is
// recorded in provider-gemini-send-retry.
// The product is b6f10295a with three fixes of Node bugs applied (each also built into Rust): node-patches/node-fix-scrub-carried-credential.patch
// (the refusal text is scrubbed of the credential the request carried, not only of token shapes), node-patches/node-fix-scrub-echoed-credential.patch
// (the same for an Anthropic stream's error event, a Gemini or Antigravity refusal, a Cursor end-frame error and token exchange, a Grok refresh refusal)
// and node-patches/node-fix-cursor-end-frame-error.patch (a Connect end frame carrying an error reaches the bridge as that error, not as the
// `aborted` its own cancel raises).
//   node benchmarks/rust-core/recorders/record-provider-retry-stages.mjs --tree <export of b6f10295a with the patches applied and node_modules> --patch benchmarks/rust-core/recorders/node-patches/node-fix-scrub-carried-credential.patch,benchmarks/rust-core/recorders/node-patches/node-fix-scrub-echoed-credential.patch,benchmarks/rust-core/recorders/node-patches/node-fix-cursor-end-frame-error.patch [--only <case>]
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { startH2World } from './lib/h2-world.mjs';
import { startRecording } from './lib/provider-case-recorder.mjs';

// A keep-alive socket of the loopback endpoint carries every request of the recording process, and each request adds a `close`
// listener to it: the eleventh makes Node write a `MaxListenersExceededWarning` to stderr, which lands in whichever case sends it
// (the count of requests before a case decides which). The warning is the recording process's, not the product's output.
EventEmitter.defaultMaxListeners = 0;
const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-retry-stages',
  exclusions: [
    '`draws` is not compared: the recorder\'s count of its own seeded `Math.random` stream before the send and during it (`Math.random` wrapped right after `startRecording`), not an output of the product; the replay reads it to find the retry jitter sample among the SDK clients\' draws, and the sample is compared through the recorded wait',
    '`attemptRequests` is not compared: the recorder\'s own list of which arrivals were attempts of the send (the others are token grants, session exchanges and catalog reads it answered itself), not an output of the product; the replay reads it to take each retry wait once the attempt before it failed',
    'The Cursor case\'s HTTP/2 streams are recorded by the world\'s h2c hub (lib/h2-world.mjs): `:authority` is written as the host and `:scheme` as the scheme of the origin the product addressed (the loopback address and clear text are the world\'s), the pseudo-headers in the order :method, :scheme, :authority, :path (the client library\'s choice, not the product\'s), and the body of the Run stream is its first Connect frame (later frames - heartbeats - are not part of the arrival). Replay side: the Rust h2 client (reqwest) adds `accept: */*` to every request and the `content-length` of a whole body, and `node:http2` adds no header of its own, so the replay\'s h2 listener leaves those two headers out of the arrival',
    'no `MaxListenersExceededWarning` is recorded: every request of the recording process adds a `close` listener to the loopback endpoint\'s shared keep-alive socket, and Node warns on the eleventh (the recorder sets `EventEmitter.defaultMaxListeners = 0`); the warning is the recording process\'s, which the number of cases before a send decides, and no product output',
    '`streaming stages` is not compared: the core raises `streaming` from its run loop when a stream opens (mixdog-agent/src/send.rs, `RunEvent::Stage(Stage::Streaming)`), not from the provider send this set replays (ModelBroker::send); the set pins the retry ladder\'s `reconnecting` stage and the provider\'s own `requesting` stage (raised where Node\'s send raises it: SendIdentity::raise_stage / SendStages), compared whole and in order',
  ],
  entry: 'anthropic.mjs AnthropicProvider({ apiKey }), openai-compat.mjs OpenAICompatProvider(\'xai\', { apiKey, apiMode?, preconnect: false }), vertex-ai.mjs VertexAIProvider({ authMode: \'api-key\', apiKey } or { authMode: \'adc\', projectId, location } over the ADC file), and over the credentials files the case input names: anthropic-oauth.mjs AnthropicOAuthProvider({}), openrouter.mjs OpenRouterProvider({ apiKey, preconnect: false }) (Messages wire), grok-oauth.mjs GrokOAuthProvider({}), antigravity-oauth.mjs AntigravityOAuthProvider({}) and devin.mjs DevinOAuthProvider({}) and cursor.mjs CursorOAuthProvider({}) (over node:http2, against the world\'s h2c hub) and opencode-go.mjs OpenCodeGoProvider({ apiKey }) (the Gemini wire, routed by the models.dev catalog the case\'s input names, written to the data directory and warmed from disk) .send(history, model, [], { onStageChange }) against the loopback endpoint; the stages it raises (`onStageChange`) and the lines it writes to stderr are recorded beside its error. Not run: a live endpoint.',
  compare: 'Serve each case\'s replies from a loopback endpoint to the Rust send of the same provider (ModelBroker::send over the adapter DefaultProviderBuilder builds), take the recorded clock steps on the paused clock, and compare the requests as they arrived, the error, the stages and the stderr lines.',
  replay: 'Rust entry (pub): mixdog_ai::registry DefaultProviderBuilder::build("anthropic" | "xai" | "vertex-ai" | "anthropic-oauth" | "openrouter" | "grok-oauth" | "antigravity-oauth" | "devin-oauth") and mixdog_ai::broker::ModelBroker::send (broker/send.rs), whose `reconnecting` stage each adapter declares (ProviderAdapter::send_stages).',
});
// Cursor sends over `node:http2` (cursor-wire-transport.mjs:4): its streams reach the world's h2c hub (lib/h2-world.mjs), which must be
// in place before the first product module loads.
await startH2World(rec);
// The one client version Cursor sends, from the environment: no install-script read (`warmCursorClientVersion`) is part of the send.
process.env.MIXDOG_CURSOR_CLIENT_VERSION = 'cli-2026.11.01-0123456';
// The recorder's own count of the `Math.random` stream (the seeded one `startRecording` installed), kept with each case so the replay
// finds the jitter sample among the SDK clients' draws without assuming how many each provider makes.
const seededRandom = Math.random;
let randomDrawn = 0;
// The same for the world's `crypto.randomUUID` (one hash sequence of its own, lib/deterministic-world.mjs): the ids the providers put on
// the wire (Grok's `x-grok-req-id`, Devin's cascade) are its draws.
const seededUuid = crypto.randomUUID;
let uuidDrawn = 0;
const countedUuid = () => {
  uuidDrawn += 1;
  return seededUuid();
};
crypto.randomUUID = countedUuid;
Object.defineProperty(globalThis.crypto, 'randomUUID', { value: countedUuid, configurable: true });
syncBuiltinESMExports();
// `randomDrawn` / `uuidDrawn` when the running case began (before its provider is built).
let caseStart = 0;
let uuidStart = 0;
Math.random = () => {
  randomDrawn += 1;
  return seededRandom();
};
const P = 'agent/orchestrator/providers/';
const { AnthropicProvider } = await rec.P(`${P}anthropic.mjs`);
const { OpenAICompatProvider } = await rec.P(`${P}openai-compat.mjs`);
const { VertexAIProvider } = await rec.P(`${P}vertex-ai.mjs`);
const HISTORY = [{ role: 'user', content: 'hi' }];

// One send: the k-th request that arrives is answered by `replies[k]`; every retry wait is one clock step, taken once the product armed it.
// `aux(record)`: the answer of a request that is no attempt of the send (a token grant, a session exchange, a catalog read), or
// undefined for an attempt; the attempts are answered in order by `replies`.
const send = async ({ net, clock }, provider, model, replies, aux = () => undefined, options = {}) => {
  let attempt = 0;
  // The positions (among the arrivals) of the requests that are attempts of the send.
  const attemptRequests = [];
  net.reply = (record) => {
    const auxiliary = aux(record);
    if (auxiliary !== undefined) return auxiliary;
    attemptRequests.push(net.records.length - 1);
    return replies[attempt++];
  };
  const firstDraw = caseStart;
  const stages = [];
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    const outcome = provider
      .send(HISTORY, model, [], { ...options, onStageChange: (stage, payload) => stages.push(payload === undefined ? { stage } : { stage, payload }) })
      .then((result) => ({ result }), (error) => ({ error }));
    const done = await clock.followRetries(outcome, { what: 'the retry ladder', causes: () => { const n = net.records.length; return () => net.records.length > n; } });
    return { ...done, stages, stderr, attemptRequests, draws: { first: firstDraw, count: randomDrawn - firstDraw, uuidFirst: uuidStart, uuidCount: uuidDrawn - uuidStart } };
  } finally {
    process.stderr.write = write;
  }
};

const json = (status, body, headers) => ({ status, contentType: 'application/json', ...(headers ? { headers } : {}), body: JSON.stringify(body) });
const ADVICE = { 'retry-after': '2' };
const anthropicError = (type, message) => ({ type: 'error', error: { type, message } });
const openaiError = (type, message) => ({ error: { message, type } });
// A 200 answer whose stream is one `error` event.
const sse = (body) => ({ status: 200, contentType: 'text/event-stream', chunks: [`event: error\ndata: ${JSON.stringify(body)}\n\n`] });
const cases = [
  [
    'anthropic-api-key-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/anthropic-api-transport.mjs:200',
    { provider: 'anthropic' },
    () => new AnthropicProvider({ apiKey: 'fixture-key' }),
    'claude',
    [json(503, anthropicError('overloaded_error', 'busy'), ADVICE), json(400, anthropicError('invalid_request_error', 'bad field'))],
  ],
  [
    'anthropic-api-key-redacts-an-opaque-credential-in-a-400',
    'src/runtime/agent/orchestrator/providers/anthropic-api-transport.mjs:109',
    { provider: 'anthropic' },
    () => new AnthropicProvider({ apiKey: 'fixture-key' }),
    'claude',
    // A refusal that echoes the key it was sent inside ordinary message text (no bearer prefix, no token shape, no secret field): only the credential the request carried names it. The error text and the error's parsed body carry it redacted.
    [json(400, anthropicError('invalid_request_error', 'the credential fixture-key was refused for this model'))],
  ],
  [
    'anthropic-api-key-redacts-an-opaque-credential-in-a-429',
    'src/runtime/agent/orchestrator/providers/anthropic-api-transport.mjs:109',
    { provider: 'anthropic' },
    () => new AnthropicProvider({ apiKey: 'fixture-key' }),
    'claude',
    // A rate-limit refusal echoing the key is retried, so the retry line the ladder writes (it quotes the refusal's message) is recorded too.
    [json(429, anthropicError('rate_limit_error', 'the credential fixture-key is over its limit'), { 'retry-after': '30' }), json(400, anthropicError('invalid_request_error', 'bad field'))],
  ],
  [
    'anthropic-api-key-redacts-an-opaque-credential-in-a-stream-error',
    'src/runtime/agent/orchestrator/providers/anthropic-sse.mjs:100',
    { provider: 'anthropic' },
    () => new AnthropicProvider({ apiKey: 'fixture-key' }),
    'claude',
    // An error event of the stream that echoes the key the request carried inside ordinary message text: the error text carries it redacted.
    [sse(anthropicError('invalid_request_error', 'the credential fixture-key was refused for this model'))],
  ],
  [
    'anthropic-api-key-reissues-a-dropped-stream-and-raises-the-stage-again',
    'src/runtime/agent/orchestrator/providers/anthropic.mjs:300',
    { provider: 'anthropic' },
    () => new AnthropicProvider({ apiKey: 'fixture-key' }),
    'claude',
    // The stream's first answer opens and ends before it shows anything or its message_stop: the stream is issued again, and each issue of it raises the stage; the second answer is refused as not retryable.
    [
      { status: 200, contentType: 'text/event-stream', chunks: [`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`] },
      json(400, anthropicError('invalid_request_error', 'bad field')),
    ],
  ],
  [
    'anthropic-api-key-falls-back-to-a-non-streaming-request',
    'src/runtime/agent/orchestrator/providers/anthropic-api-recovery.mjs:46',
    { provider: 'anthropic' },
    () => new AnthropicProvider({ apiKey: 'fixture-key' }),
    'claude',
    // A gateway that refuses the streaming endpoint with a 404: one non-streaming request, which raises the stage with its transport named; it is refused as not retryable.
    [json(404, anthropicError('not_found_error', 'no such route')), json(400, anthropicError('invalid_request_error', 'bad field'))],
  ],
  [
    'xai-chat-raises-the-stage-again-after-a-key-reload',
    'src/runtime/agent/orchestrator/providers/openai-compat.mjs:171',
    { provider: 'xai' },
    () => new OpenAICompatProvider('xai', { apiKey: 'fixture-key', apiMode: 'chat', preconnect: false }),
    'grok-4',
    // A 401 re-reads the provider's key and runs the whole send again: its ladder raises the stage anew.
    [json(401, openaiError('invalid_request_error', 'bad key')), json(400, openaiError('invalid_request_error', 'bad field'))],
  ],
  [
    'xai-responses-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/openai-compat-xai-send.mjs:154',
    { provider: 'xai' },
    () => new OpenAICompatProvider('xai', { apiKey: 'fixture-key', preconnect: false }),
    'grok-4',
    [json(503, openaiError('server_error', 'busy'), ADVICE), json(400, openaiError('invalid_request_error', 'bad field'))],
  ],
  [
    'xai-chat-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/openai-compat-chat-send.mjs:222',
    { provider: 'xai' },
    () => new OpenAICompatProvider('xai', { apiKey: 'fixture-key', apiMode: 'chat', preconnect: false }),
    'grok-4',
    [json(503, openaiError('server_error', 'busy'), ADVICE), json(400, openaiError('invalid_request_error', 'bad field'))],
  ],
  [
    'vertex-gemini-retries-its-stream-without-the-stage',
    'src/runtime/agent/orchestrator/providers/vertex-ai.mjs:382',
    { provider: 'vertex-ai' },
    () => new VertexAIProvider({ authMode: 'api-key', apiKey: 'fixture-key' }),
    'gemini-2.5-pro',
    [
      { status: 200, contentType: 'text/event-stream', chunks: [`data: ${JSON.stringify({ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } })}\n\n`] },
      json(400, { error: { code: 400, message: 'bad field', status: 'INVALID_ARGUMENT' } }),
    ],
  ],
];
for (const [id, source, input, make, model, replies] of cases) {
  await rec.run(id, source, input, (ctx) => {
    caseStart = randomDrawn;
    uuidStart = uuidDrawn;
    return send(ctx, make(), model, replies);
  });
}

// The routes whose account is a credentials file of the data directory (or a gateway over one): the file each case's input names is
// written before its provider is built, and the replay writes the same document into its own home.
const FAR = 4_000_000_000_000;
const OAUTH = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: FAR, account_id: 'acct-fixture', email: 'fixture@example.invalid' };
const ADC = { type: 'authorized_user', client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: 'fixture-refresh-token' };
const { AnthropicOAuthProvider } = await rec.P(`${P}anthropic-oauth.mjs`);
const { OpenRouterProvider } = await rec.P(`${P}openrouter.mjs`);
const { GrokOAuthProvider } = await rec.P(`${P}grok-oauth.mjs`);
const { AntigravityOAuthProvider } = await rec.P(`${P}antigravity-oauth.mjs`);
const { GeminiProvider } = await rec.P(`${P}gemini.mjs`);
const { DevinOAuthProvider } = await rec.P(`${P}devin.mjs`);
const { OpenCodeGoProvider } = await rec.P(`${P}opencode-go.mjs`);
const { warmCatalogFromDisk } = await rec.P(`${P}model-catalog.mjs`);
// The models.dev catalog the Go gateway routes by (`openCodeGoCatalogWire`, opencode-go.mjs:41, read through `getModelsDevRowSync`, which is
// null until the catalog's disk copy is warm): the one Gemini-package row. It is the case's recorded input; the replay writes the same file.
const MODELS_DEV = { 'opencode-go': { id: 'opencode-go', name: 'OpenCode Go', models: { 'gemini-fixture': { id: 'gemini-fixture', name: 'Gemini Fixture', npm: '@ai-sdk/google', limit: { context: 1000000, output: 65536 } } } } };
const devinPb = await rec.raw(`${P}devin-wire-protobuf.mjs`);
const geminiError = (code, status, message) => ({ error: { code, message, status } });
const tokenGrant = (() => {
  let grants = 0;
  return (record) => (/oauth2\.googleapis/.test(record.origin ?? '') ? json(200, { access_token: `fixture-token-${++grants}`, expires_in: 3600, token_type: 'Bearer' }) : undefined);
})();
const proto = (type, message) => ({ status: 200, contentType: 'application/proto', body: devinPb.encodeDevinMessage(type, message) });
const devinSession = (record) => {
  if (record.path.endsWith('/GetUserJwt')) return proto('GetUserJwtResponse', { userJwt: 'fixture-user-jwt' });
  if (record.path.endsWith('/GetCliModelConfigs')) {
    return proto('GetCliModelConfigsResponse', {
      clientModelConfigs: [{ label: 'Devin Fixture', modelUid: 'devin-fixture', maxTokens: 200000, modelInfo: { maxTokens: 200000, modelUid: 'devin-fixture', displayOption: 8, modelFeatures: { supportsToolCalls: true, supportsThinking: true } } }],
    });
  }
  return undefined;
};
// Cursor: the model listing it resolves the send's model from (a unary call over h2), the token exchange every in-place retry makes
// first, and the Run stream.
const { CursorOAuthProvider } = await rec.P(`${P}cursor.mjs`);
const cursorPb = await rec.raw(`${P}cursor-wire-protobuf.mjs`);
const CURSOR_MODELS = Buffer.from(cursorPb.encodeMessage('AvailableModelsResponse', { useModelParameters: true, models: [{ name: 'fixture-model', clientDisplayName: 'Fixture Model', supportsAgent: true, contextTokenLimit: 200000 }] }));
// A refusal at the HTTP level, with no body: the run's failure then ends the stream (`finish`, cursor-wire-transport.mjs:181) with the status
// error. (A Connect end frame carrying an error is the `cursor-end-frame-error` case below, recorded from the patched tree.)
const cursorRefusal = (status, headers) => ({ status, contentType: 'application/proto', ...(headers ? { headers } : {}), body: '' });
// A Connect end frame carrying the server's error, the whole answer of a run (cursor-wire-stream-bridge.mjs:157). Node closes such a stream
// through `close(error)`; the node-fix-cursor-end-frame-error.patch keeps its own cancel from replacing that error.
const cursorTransport = await rec.raw(`${P}cursor-wire-transport.mjs`);
const cursorEndFrameError = (code, message) => ({ status: 200, contentType: 'application/connect+proto', body: cursorTransport.connectFrame(Buffer.from(JSON.stringify({ error: { code, message } })), cursorTransport.END_STREAM_FLAG) });
const cursorAux = (() => {
  let exchanges = 0;
  return (record) => {
    if (record.path === '/aiserver.v1.AiService/AvailableModels') return { status: 200, contentType: 'application/proto', body: CURSOR_MODELS };
    if (record.path === '/auth/exchange_user_api_key') return json(200, { accessToken: `fixture-exchanged-token-${++exchanges}`, refreshToken: 'fixture-refresh-token-2' });
    return undefined;
  };
})();
const cursorRoute = [
    'cursor-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/cursor-wire-stream-bridge.mjs:119',
    { provider: 'cursor-oauth', credentials: { 'cursor-oauth.json': { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: FAR } }, env: { MIXDOG_CURSOR_CLIENT_VERSION: process.env.MIXDOG_CURSOR_CLIENT_VERSION } },
    () => new CursorOAuthProvider({}),
    'fixture-model',
    // The first run is refused as retryable with advice, the second as not.
    [cursorRefusal(503, ADVICE), cursorRefusal(400)],
    cursorAux,
    { sessionId: 'fixture-session' },
];
const cursorEndFrameRoute = [
    'cursor-end-frame-error-surfaces-the-server-error',
    'src/runtime/agent/orchestrator/providers/cursor-wire-stream-bridge.mjs:157',
    cursorRoute[2],
    () => new CursorOAuthProvider({}),
    'fixture-model',
    // The first run ends with a retryable error in its Connect end frame, the second with one that is not: the send waits once and fails with the server's error.
    [cursorEndFrameError('unavailable', 'the run is busy'), cursorEndFrameError('invalid_argument', 'the model is not available')],
    cursorAux,
    { sessionId: 'fixture-session' },
];
const cursorTooLargeRoute = [
    'cursor-oversized-request-is-terminal',
    'src/runtime/agent/orchestrator/providers/cursor-wire-transport.mjs:368',
    cursorRoute[2],
    () => new CursorOAuthProvider({}),
    'fixture-model',
    // A resource_exhausted whose text names the tool catalog as too large is a 413 `request_too_large`, not a throttle: no retry follows, nothing was shown.
    [cursorEndFrameError('resource_exhausted', 'The tool catalog is too large')],
    cursorAux,
    { sessionId: 'fixture-session' },
];
const anthropicOauthInput = { provider: 'anthropic-oauth', credentials: { 'anthropic-oauth-credentials.json': { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: FAR, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } } } };
// The subscription's token endpoint (a forced refresh after a revoked-token 403).
const anthropicTokenGrant = (record) => (record.path === '/v1/oauth/token' ? json(200, { access_token: 'fixture-refreshed-token', refresh_token: 'fixture-refresh-token-2', expires_in: 3600, token_type: 'Bearer' }) : undefined);
const routes = [
  [
    'anthropic-oauth-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/anthropic-oauth-request.mjs:140',
    { provider: 'anthropic-oauth', credentials: { 'anthropic-oauth-credentials.json': { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: FAR, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } } } },
    () => new AnthropicOAuthProvider({}),
    'claude-sonnet-4-6',
    [json(503, anthropicError('overloaded_error', 'busy'), ADVICE), json(400, anthropicError('invalid_request_error', 'bad field'))],
  ],
  [
    'gateway-messages-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/anthropic-api-transport.mjs:200',
    { provider: 'openrouter', credentials: {} },
    () => new OpenRouterProvider({ apiKey: 'fixture-key', preconnect: false }),
    'anthropic/claude-sonnet-5',
    [json(503, anthropicError('overloaded_error', 'busy'), ADVICE), json(400, anthropicError('invalid_request_error', 'bad field'))],
    // The gateway's roster and catalog reads are no attempt.
    (record) => (record.method === 'GET' ? json(200, { data: [] }) : undefined),
    // The output ceiling the gateway would take from the shared catalog (`config.modelMaxOutputTokens`, wire-gateway.mjs:114), which the
    // replay world does not carry, named by the caller instead (`gatewayMessagesOpts` keeps a caller's own).
    { modelMaxOutputTokens: 65536 },
  ],
  [
    'grok-oauth-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/compat-request-policy.mjs:13',
    { provider: 'grok-oauth', credentials: { 'grok-oauth.json': OAUTH } },
    () => new GrokOAuthProvider({}),
    'grok-4',
    [json(503, openaiError('server_error', 'busy'), ADVICE), json(400, openaiError('invalid_request_error', 'bad field'))],
  ],
  [
    'antigravity-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/antigravity-transport.mjs:185',
    { provider: 'antigravity-oauth', credentials: { 'antigravity-oauth.json': { ...OAUTH, project_id: 'fixture-project' } } },
    () => new AntigravityOAuthProvider({}),
    'gemini-3-pro',
    [json(503, geminiError(503, 'UNAVAILABLE', 'overloaded'), ADVICE), json(400, geminiError(400, 'INVALID_ARGUMENT', 'bad field'))],
    // The client version the product asks the updater's manifest for.
    (record) => (record.method === 'GET' ? json(200, { object: 'list', data: [] }) : undefined),
  ],
  [
    'anthropic-oauth-redacts-an-echoed-credential',
    'src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs:860',
    { provider: 'anthropic-oauth', credentials: { 'anthropic-oauth-credentials.json': { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: FAR, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } } } },
    () => new AnthropicOAuthProvider({}),
    'claude-sonnet-4-6',
    // A refusal that echoes the credential it was sent (a bearer token, an Anthropic token and a JSON secret field): the error text and the stderr line carry them redacted.
    [json(400, anthropicError('invalid_request_error', 'rejected Bearer fixture-access-token and sk-ant-echo-1 {"refresh_token":"fixture-refresh-token"}'))],
  ],
  [
    'anthropic-oauth-redacts-an-echoed-credential-in-a-429',
    'src/runtime/agent/orchestrator/providers/anthropic-oauth-request/initial-status.mjs:90',
    { provider: 'anthropic-oauth', credentials: { 'anthropic-oauth-credentials.json': { claudeAiOauth: { accessToken: 'fixture-access-token', refreshToken: 'fixture-refresh-token', expiresAt: FAR, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max' } } } },
    () => new AnthropicOAuthProvider({}),
    'claude-sonnet-4-6',
    // A quota refusal (subscription window headers) whose body echoes the credential it was sent: the quota error carries the scrubbed body.
    [json(429, anthropicError('rate_limit_error', 'limit for Bearer fixture-access-token and sk-ant-echo-1 {"refresh_token":"fixture-refresh-token"}'), { 'retry-after': '30', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' })],
  ],
  [
    'anthropic-oauth-redacts-an-opaque-credential-in-a-400',
    'src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs:860',
    anthropicOauthInput,
    () => new AnthropicOAuthProvider({}),
    'claude-sonnet-4-6',
    // A refusal that echoes the access token it was sent inside ordinary message text (no bearer prefix, no token shape, no secret field): only the credential the request carried names it. The error text and the stderr line carry it redacted.
    [json(400, anthropicError('invalid_request_error', 'the credential fixture-access-token was refused for this model'))],
  ],
  [
    'anthropic-oauth-redacts-an-opaque-credential-in-a-429',
    'src/runtime/agent/orchestrator/providers/anthropic-oauth-request/initial-status.mjs:90',
    anthropicOauthInput,
    () => new AnthropicOAuthProvider({}),
    'claude-sonnet-4-6',
    [json(429, anthropicError('rate_limit_error', 'the credential fixture-access-token is over its limit'), { 'retry-after': '30', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' })],
  ],
  [
    'anthropic-oauth-refreshes-a-revoked-token-403',
    'src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs:800',
    anthropicOauthInput,
    () => new AnthropicOAuthProvider({}),
    'claude-sonnet-4-6',
    // Anthropic's exact revoked-token 403 body: one forced refresh and one replay with the new token, which is refused as not retryable.
    [json(403, anthropicError('permission_error', 'OAuth token has been revoked. Please obtain a new token or refresh your existing token.')), json(400, anthropicError('invalid_request_error', 'bad field'))],
    anthropicTokenGrant,
  ],
  [
    'anthropic-oauth-a-policy-403-is-terminal',
    'src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs:800',
    anthropicOauthInput,
    () => new AnthropicOAuthProvider({}),
    'claude-sonnet-4-6',
    // Any other 403 is a permission/policy refusal: no refresh, no replay. The token grant is scripted, and must not be asked.
    [json(403, anthropicError('permission_error', 'This organization is not allowed to use this model'))],
    anthropicTokenGrant,
  ],
  [
    'gemini-redacts-an-opaque-credential-in-a-400',
    'src/runtime/agent/orchestrator/providers/gemini.mjs:194',
    { provider: 'gemini', credentials: {} },
    () => new GeminiProvider({ apiKey: 'fixture-key', preconnect: false }),
    'gemini-2.5-pro',
    // A refusal that echoes the key it was sent inside ordinary message text: the error text carries it redacted.
    [json(400, geminiError(400, 'INVALID_ARGUMENT', 'the credential fixture-key was refused for this model'))],
  ],
  [
    'antigravity-redacts-an-opaque-credential-in-a-400',
    'src/runtime/agent/orchestrator/providers/antigravity-transport.mjs:55',
    { provider: 'antigravity-oauth', credentials: { 'antigravity-oauth.json': { ...OAUTH, project_id: 'fixture-project' } } },
    () => new AntigravityOAuthProvider({}),
    'gemini-3-pro',
    [json(400, geminiError(400, 'INVALID_ARGUMENT', 'the credential fixture-access-token was refused for this model'))],
    (record) => (record.method === 'GET' ? json(200, { object: 'list', data: [] }) : undefined),
  ],
  [
    'grok-oauth-redacts-an-opaque-credential-in-a-failed-refresh',
    'src/runtime/agent/orchestrator/providers/grok-oauth-tokens.mjs:335',
    // The access token has expired and the token endpoint is the one the file names, so the send begins with a refresh.
    { provider: 'grok-oauth', credentials: { 'grok-oauth.json': { ...OAUTH, expires_at: 1, token_endpoint: 'https://auth.x.ai/oauth2/token' } } },
    () => new GrokOAuthProvider({}),
    'grok-4',
    [],
    // The refresh is refused as a terminal grant error whose text echoes the refresh token it carried.
    (record) => (record.path === '/oauth2/token' ? json(400, { error: 'invalid_grant', error_description: 'the credential fixture-refresh-token was refused for this account' }) : undefined),
  ],
  [
    'opencode-go-gemini-raises-the-ladder-stage',
    'src/runtime/agent/orchestrator/providers/opencode-go-gemini.mjs:141',
    { provider: 'opencode-go-oauth', credentials: { 'opencode-go-oauth.json': { ...OAUTH, access_token: 'fixture-key' } }, modelsDev: MODELS_DEV },
    () => new OpenCodeGoProvider({ apiKey: 'fixture-key', preconnect: false }),
    'gemini-fixture',
    [json(503, geminiError(503, 'UNAVAILABLE', 'overloaded'), ADVICE), json(400, geminiError(400, 'INVALID_ARGUMENT', 'bad field'))],
    undefined,
    { sessionId: 'fixture-session' },
  ],
  [
    'vertex-claude-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/vertex-ai.mjs:516',
    { provider: 'vertex-ai', credentials: { 'adc.json': ADC }, adcFile: 'adc.json' },
    () => new VertexAIProvider({ authMode: 'adc', projectId: 'fixture-project', location: 'global' }),
    'claude-sonnet-4-6',
    [json(503, anthropicError('overloaded_error', 'busy'), ADVICE), json(400, anthropicError('invalid_request_error', 'bad field'))],
    tokenGrant,
  ],
  [
    'vertex-maas-raises-the-stage',
    'src/runtime/agent/orchestrator/providers/vertex-ai-maas.mjs:130',
    { provider: 'vertex-ai', credentials: { 'adc.json': ADC }, adcFile: 'adc.json' },
    () => new VertexAIProvider({ authMode: 'adc', projectId: 'fixture-project', location: 'global' }),
    'zai-org/glm-5-maas',
    [json(503, openaiError('server_error', 'busy'), ADVICE), json(400, openaiError('invalid_request_error', 'bad field'))],
    tokenGrant,
  ],
  [
    'devin-surfaces-the-first-failure',
    'src/runtime/agent/orchestrator/providers/devin.mjs:383',
    { provider: 'devin-oauth', credentials: { 'devin-oauth.json': { access_token: 'fixture-access-token', expires_at: FAR } } },
    () => new DevinOAuthProvider({}),
    'devin-fixture',
    [json(503, { code: 'unavailable', message: 'busy' }, ADVICE)],
    devinSession,
  ],
  // Last: its h2c streams and token exchanges leave the shared keep-alive sockets of the `fetch` endpoint as the cases before it left them.
  cursorRoute,
  cursorEndFrameRoute,
  cursorTooLargeRoute,
  [
    'cursor-end-frame-error-redacts-an-opaque-credential',
    'src/runtime/agent/orchestrator/providers/cursor-wire.mjs:465',
    cursorRoute[2],
    () => new CursorOAuthProvider({}),
    'fixture-model',
    // The server's error in the Connect end frame echoes the token the run was opened with, inside ordinary message text.
    [cursorEndFrameError('invalid_argument', 'the credential fixture-access-token was refused for this model')],
    cursorAux,
    { sessionId: 'fixture-session' },
  ],
  [
    'cursor-token-exchange-redacts-an-opaque-credential',
    'src/runtime/agent/orchestrator/providers/cursor-auth.mjs:221',
    // The access token has expired, so the send begins with an exchange of the refresh token, which the server refuses with text echoing it.
    { ...cursorRoute[2], credentials: { 'cursor-oauth.json': { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: 1 } } },
    () => new CursorOAuthProvider({}),
    'fixture-model',
    [],
    (record) => (record.path === '/auth/exchange_user_api_key' ? json(400, { error: 'the credential fixture-refresh-token was refused' }) : cursorAux(record)),
    { sessionId: 'fixture-session' },
  ],
];
// The refusal cases of the Gemini API, Antigravity and Grok go after the Cursor ones: Cursor's h2c streams leave the shared sockets as the cases before them left them.
const AFTER_CURSOR = /^(gemini|antigravity|grok-oauth)-redacts|^grok-oauth-redacts/;
const ordered = [...routes.filter(([id]) => !AFTER_CURSOR.test(id)), ...routes.filter(([id]) => AFTER_CURSOR.test(id))];
for (const [id, source, input, make, model, replies, aux, options] of ordered) {
  await rec.run(id, source, input, async (ctx) => {
    caseStart = randomDrawn;
    uuidStart = uuidDrawn;
    for (const [file, doc] of Object.entries(input.credentials)) rec.write(file, JSON.stringify(doc));
    for (const [name, value] of Object.entries(input.env ?? {})) process.env[name] = value;
    // The model listing is process state of the Cursor runtime: each Cursor case starts with none, as a replay's fresh process does.
    if (input.provider === 'cursor-oauth') (await rec.raw(`${P}cursor-wire-models.mjs`)).clearModelCache();
    // The updater's manifest is read once per process and kept: each Antigravity case starts without it, as a replay's fresh process does.
    if (input.provider === 'antigravity-oauth') (await rec.raw(`${P}antigravity-oauth-tokens.mjs`))._resetAntigravityVersionForTest();
    if (input.adcFile) process.env.GOOGLE_APPLICATION_CREDENTIALS = join(rec.dataDir, input.adcFile);
    if (input.modelsDev) {
      rec.write('modelsdev-catalog.json', JSON.stringify({ fetchedAt: 1, data: input.modelsDev }));
      await warmCatalogFromDisk({ background: true });
    }
    return send(ctx, make(), model, replies, aux, options);
  });
}
await rec.finish();
