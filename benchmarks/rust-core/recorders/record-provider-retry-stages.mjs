#!/usr/bin/env node
// The display-only `reconnecting` stage each provider's own retry ladder raises before a retry wait (`emitProviderRetryStage`,
// retry-executor.mjs:346), or does not: one send per provider route through its real class against the loopback endpoint, the first
// attempt refused as retryable and the second as not, so the send ends after exactly one retry wait. The Anthropic API (anthropic-api-transport.mjs:200)
// and the OpenAI-compatible Responses and Chat Completions sends (compat-request-policy.mjs:13, via openai-compat-xai-send.mjs:154 and
// openai-compat-chat-send.mjs:222) raise it and write their retry line; Vertex AI's Gemini models run the Gemini ladder by connection
// (runGeminiStreamAttempts, vertex-ai.mjs:382) with no `onRetry`, so their stream retry raises none. The Gemini API's own ladder is
// recorded in provider-gemini-send-retry.
//   node benchmarks/rust-core/recorders/record-provider-retry-stages.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-retry-stages',
  exclusions: [
    '`requesting and streaming stages` is not compared: the core raises them from its run loop around the whole send (mixdog-agent/src/send.rs:460, `RunEvent::Stage`), not from the provider send this set replays (ModelBroker::send); the set pins the retry ladder\'s `reconnecting` stage, compared whole and in order',
  ],
  entry: 'anthropic.mjs AnthropicProvider({ apiKey }), openai-compat.mjs OpenAICompatProvider(\'xai\', { apiKey, apiMode?, preconnect: false }) and vertex-ai.mjs VertexAIProvider({ authMode: \'api-key\', apiKey }) .send(history, model, [], { onStageChange }) against the loopback endpoint; the stages it raises (`onStageChange`) and the lines it writes to stderr are recorded beside its error. Not run: a live endpoint.',
  compare: 'Serve each case\'s replies from a loopback endpoint to the Rust send of the same provider (ModelBroker::send over the adapter DefaultProviderBuilder builds), take the recorded clock steps on the paused clock, and compare the requests as they arrived, the error, the stages and the stderr lines.',
  replay: 'Rust entry (pub): mixdog_ai::registry DefaultProviderBuilder::build("anthropic" | "xai" | "vertex-ai") and mixdog_ai::broker::ModelBroker::send (broker/send.rs), whose `reconnecting` stage each adapter declares (ProviderAdapter::send_stages).',
});
const P = 'agent/orchestrator/providers/';
const { AnthropicProvider } = await rec.P(`${P}anthropic.mjs`);
const { OpenAICompatProvider } = await rec.P(`${P}openai-compat.mjs`);
const { VertexAIProvider } = await rec.P(`${P}vertex-ai.mjs`);
const HISTORY = [{ role: 'user', content: 'hi' }];

// One send: the k-th request that arrives is answered by `replies[k]`; every retry wait is one clock step, taken once the product armed it.
const send = async ({ net, clock }, provider, model, replies) => {
  net.reply = (_record, n) => replies[n - 1];
  const stages = [];
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    const outcome = provider
      .send(HISTORY, model, [], { onStageChange: (stage, payload) => stages.push(payload === undefined ? { stage } : { stage, payload }) })
      .then((result) => ({ result }), (error) => ({ error }));
    const done = await clock.followRetries(outcome, { what: 'the retry ladder', causes: () => { const n = net.records.length; return () => net.records.length > n; } });
    return { ...done, stages, stderr };
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
  await rec.run(id, source, input, (ctx) => send(ctx, make(), model, replies));
}
await rec.finish();
