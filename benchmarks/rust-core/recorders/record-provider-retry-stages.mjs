#!/usr/bin/env node
// The display-only `reconnecting` stage each provider's own retry ladder raises before a retry wait (`emitProviderRetryStage`,
// retry-executor.mjs:346), or does not: one send per provider route through its real class against the loopback endpoint, the first
// attempt refused as retryable and the second as not, so the send ends after exactly one retry wait. The Anthropic API (anthropic-api-transport.mjs:200)
// and the OpenAI-compatible Responses and Chat Completions sends (compat-request-policy.mjs:13, via openai-compat-xai-send.mjs:154 and
// openai-compat-chat-send.mjs:222) raise it and write their retry line; Vertex AI's Gemini models run the Gemini ladder by connection
// (runGeminiStreamAttempts, vertex-ai.mjs:382) with no `onRetry`, so their stream retry raises none. The Gemini API's own ladder is
// recorded in provider-gemini-send-retry.
//   node benchmarks/rust-core/recorders/record-provider-retry-stages.mjs --tree <exact export of b6f10295a>
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-retry-stages',
  exclusions: [
    '`draws` is not compared: the recorder\'s count of its own seeded `Math.random` stream before the send and during it (`Math.random` wrapped right after `startRecording`), not an output of the product; the replay reads it to find the retry jitter sample among the SDK clients\' draws, and the sample is compared through the recorded wait',
    '`attemptRequests` is not compared: the recorder\'s own list of which arrivals were attempts of the send (the others are token grants, session exchanges and catalog reads it answered itself), not an output of the product; the replay reads it to take each retry wait once the attempt before it failed',
    '`requesting and streaming stages` is not compared: the core raises them from its run loop around the whole send (mixdog-agent/src/send.rs:460, `RunEvent::Stage`), not from the provider send this set replays (ModelBroker::send); the set pins the retry ladder\'s `reconnecting` stage, compared whole and in order',
  ],
  entry: 'anthropic.mjs AnthropicProvider({ apiKey }), openai-compat.mjs OpenAICompatProvider(\'xai\', { apiKey, apiMode?, preconnect: false }), vertex-ai.mjs VertexAIProvider({ authMode: \'api-key\', apiKey } or { authMode: \'adc\', projectId, location } over the ADC file), and over the credentials files the case input names: anthropic-oauth.mjs AnthropicOAuthProvider({}), openrouter.mjs OpenRouterProvider({ apiKey, preconnect: false }) (Messages wire), grok-oauth.mjs GrokOAuthProvider({}), antigravity-oauth.mjs AntigravityOAuthProvider({}) and devin.mjs DevinOAuthProvider({}) and opencode-go.mjs OpenCodeGoProvider({ apiKey }) (the Gemini wire, routed by the models.dev catalog the case\'s input names, written to the data directory and warmed from disk) .send(history, model, [], { onStageChange }) against the loopback endpoint; the stages it raises (`onStageChange`) and the lines it writes to stderr are recorded beside its error. Not run: a live endpoint.',
  compare: 'Serve each case\'s replies from a loopback endpoint to the Rust send of the same provider (ModelBroker::send over the adapter DefaultProviderBuilder builds), take the recorded clock steps on the paused clock, and compare the requests as they arrived, the error, the stages and the stderr lines.',
  replay: 'Rust entry (pub): mixdog_ai::registry DefaultProviderBuilder::build("anthropic" | "xai" | "vertex-ai" | "anthropic-oauth" | "openrouter" | "grok-oauth" | "antigravity-oauth" | "devin-oauth") and mixdog_ai::broker::ModelBroker::send (broker/send.rs), whose `reconnecting` stage each adapter declares (ProviderAdapter::send_stages).',
});
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
];
for (const [id, source, input, make, model, replies, aux, options] of routes) {
  await rec.run(id, source, input, async (ctx) => {
    caseStart = randomDrawn;
    uuidStart = uuidDrawn;
    for (const [file, doc] of Object.entries(input.credentials)) rec.write(file, JSON.stringify(doc));
    if (input.adcFile) process.env.GOOGLE_APPLICATION_CREDENTIALS = join(rec.dataDir, input.adcFile);
    if (input.modelsDev) {
      rec.write('modelsdev-catalog.json', JSON.stringify({ fetchedAt: 1, data: input.modelsDev }));
      await warmCatalogFromDisk({ background: true });
    }
    return send(ctx, make(), model, replies, aux, options);
  });
}
await rec.finish();
