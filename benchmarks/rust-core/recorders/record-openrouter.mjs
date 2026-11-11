#!/usr/bin/env node
// openrouter.test.mjs (14 tests): the real OpenRouterProvider sends over a scripted loopback endpoint (the product's own fetch, redirected;
// requests recorded as the endpoint received them), plus the error-kind normalizers and the Messages usage accounting as pure calls.
// Differences from the test: no `fetchImpl` is injected (the SDK clients use the process fetch), and the alias-target case lists the models
// from a scripted /models answer instead of writing the private `_enrichedModels`.
//   node benchmarks/rust-core/recorders/record-openrouter.mjs --tree <exact export of b6f10295a>
import { sseBody, startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openrouter',
  entry: 'openrouter.mjs OpenRouterProvider({ apiKey, preconnect: false, ...config }).send/.listModels/.getCachedModelInfo, openRouterCapabilityModel; provider-error-kind.mjs providerErrorKind / normalizeGatewayErrorDetail; retry-classification.mjs isContextOverflowError; shared/llm usage-context.mjs withUsageContext / noteAbandonedUsage; lib/inclusive-usage.mjs withInclusiveUsage; anthropic-sse-turn/turn-state.mjs createAnthropicTurnState / updateTurnUsage; anthropic-turn-result.mjs buildAnthropicTurnResult. Not run: a live OpenRouter.',
  compare: 'mixdog-ai providers::compat (adapter.rs:197-224 wire selection, error.rs:278, listing) and registry hop_host.rs:151-168 pins, retry::classify.rs:250: compare `requests` (method, origin, path, header pairs, body) and `result`/`error`. The Rust gateway sends Chat for every route today (K1 gap G1): replays of the Messages/Responses cases are expected to differ until that gap is closed.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::compat::CompatAdapter (compat/adapter.rs:63) with CompatChatCodec (compat/chat/mod.rs:96) / CompatResponsesCodec (compat/responses.rs:75), body builder build_body (compat/chat/encode.rs:372), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079). Messages / Responses routes are not built (K1 G1): work for the Rust side.",
});
const P = 'agent/orchestrator/providers/';
const { OpenRouterProvider, openRouterCapabilityModel } = await rec.P(`${P}openrouter.mjs`);
const { providerErrorKind, normalizeGatewayErrorDetail } = await rec.P(`${P}provider-error-kind.mjs`);
const { isContextOverflowError } = await rec.P(`${P}retry-classification.mjs`);
const { withUsageContext, noteAbandonedUsage } = await rec.P('shared/llm/usage-context.mjs');
const { withInclusiveUsage } = await rec.P(`${P}lib/inclusive-usage.mjs`);
const { createAnthropicTurnState, updateTurnUsage } = await rec.P(`${P}anthropic-sse-turn/turn-state.mjs`);
const { buildAnthropicTurnResult } = await rec.P(`${P}anthropic-turn-result.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openrouter.test.mjs';
// Anthropic SDK environment credentials must never reach OpenRouter.
process.env.ANTHROPIC_API_KEY = 'env-anthropic-key';
process.env.ANTHROPIC_AUTH_TOKEN = 'env-anthropic-token';
delete process.env.OPENROUTER_API_KEY;

const prompt = [{ role: 'user', content: 'hi' }];
const tool = { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } };
const ok = (body) => ({ status: 200, contentType: 'text/event-stream', body });
const messagesStream = (model) => ok(sseBody([
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 14268, cache_creation_input_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 14268, cost: 0.0014608 } }, { type: 'message_stop' },
], true));
const responsesStream = (model) => ok(sseBody([{ type: 'response.completed', response: { id: 'resp_1', model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 } } }], true));
const chatStream = (model) => ok(sseBody([{ id: 'c1', model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
const respond = (request) => {
  if (request.method !== 'POST') return { status: 404, contentType: 'application/json', body: '{"error":{"message":"not scripted"}}' };
  const model = JSON.parse(request.body).model;
  if (request.path.endsWith('/messages')) return messagesStream(model);
  if (request.path.endsWith('/responses')) return responsesStream(model);
  return chatStream(model);
};
const provider = (config = {}) => new OpenRouterProvider({ apiKey: 'or-key', preconnect: false, ...config });
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};
const failedResponse = (errorType, code, message) => ok(sseBody([{ type: 'response.failed', response: { id: 'resp_f', status: 'failed', error: { code, message }, error_type: errorType } }], true));
const FAILED = { auth: () => failedResponse('authentication', 'server_error', 'Invalid credentials'), overflow: () => failedResponse('context_length_exceeded', 'invalid_prompt', 'too long') };

await rec.run('claude-messages-openrouter-key-inclusive-usage', `${SRC}:115`, { model: 'anthropic/claude-opus-4.8' }, async ({ net }) => {
  net.reply = respond;
  return { result: await provider().send(prompt, 'anthropic/claude-opus-4.8', [tool], { sessionId: 's1' }) };
});
await rec.run('routing-slug-on-wire-capabilities-from-alias-target', `${SRC}:140`, { model: '~anthropic/claude-opus-latest' }, async ({ net }) => {
  net.reply = (request) => (request.path.endsWith('/models')
    ? { status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: '~anthropic/claude-opus-latest', alias_target: { name: 'Claude Opus 5.5', slug: 'anthropic/claude-opus-5.5' }, context_length: 1000000 }, { id: 'anthropic/claude-opus-5.5', context_length: 1000000 }] }) }
    : respond(request));
  const p = provider();
  const models = await p.listModels();
  const listing = net.records.splice(0);
  const sent = await p.send(prompt, '~anthropic/claude-opus-latest', [tool], { effort: 'high' });
  return {
    listing, models, sent,
    aliasTarget: models.find((m) => m.id === '~anthropic/claude-opus-latest').aliasTarget, cachedAliasTarget: p.getCachedModelInfo('~anthropic/claude-opus-latest').aliasTarget,
    targetAliasTarget: models.find((m) => m.id === 'anthropic/claude-opus-5.5').aliasTarget,
    capabilityModels: [openRouterCapabilityModel('anthropic/claude-haiku-4.5:batch'), openRouterCapabilityModel('~anthropic/claude-opus-latest', 'anthropic/claude-opus-5.5')],
  };
});
await rec.run('401-on-messages-rereads-key', `${SRC}:166`, { rotated: 'or-rotated' }, async ({ net }) => {
  net.reply = (request, n) => (n === 1 ? { status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }) } : respond(request));
  process.env.OPENROUTER_API_KEY = 'or-rotated';
  try {
    return await attempt(provider().send(prompt, 'anthropic/claude-sonnet-5', [tool], {}));
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});
await rec.run('messages-engine-never-follows-redirect-off-origin', `${SRC}:169`, {}, async ({ net }) => {
  net.reply = () => ({ status: 307, headers: { Location: 'https://evil.example/steal' }, body: '' });
  const out = await attempt(provider().send(prompt, 'anthropic/claude-sonnet-5', [tool], {}));
  return { ...out, causeMessage: String(out.error?.cause?.message || out.error?.message) };
});
await rec.run('gpt-responses-reasoning-auto-stays-chat', `${SRC}:200`, {}, async ({ net }) => {
  net.reply = respond;
  const p = provider();
  const out = { gpt: await p.send(prompt, 'openai/gpt-6.1-sol', [tool], { effort: 'low', openRouterReasoningEffort: 'high' }) };
  out.gptRequests = net.records.splice(0);
  await p.send(prompt, '~openai/gpt-sol-latest', [tool], { openRouterReasoningEffort: 'none' });
  await p.send(prompt, 'openai/o3', [tool], {});
  await p.send(prompt, 'openrouter/auto', [tool], { effort: 'medium' });
  return out;
});
await rec.run('session-pinned-before-per-model-table-keeps-chat', `${SRC}:202`, { wireRoute: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', wire: 'chat', source: 'legacy' } }, async ({ net }) => {
  net.reply = respond;
  await provider().send(prompt, 'anthropic/claude-opus-4.8', [tool], { wireRoute: { provider: 'openrouter', model: 'anthropic/claude-opus-4.8', wire: 'chat', source: 'legacy' } });
  return {};
});
await rec.run('per-model-override-picks-wire', `${SRC}:209`, { modelWires: { 'anthropic/claude-opus-4.8': 'chat' } }, async ({ net }) => {
  net.reply = respond;
  await provider({ modelWires: { 'anthropic/claude-opus-4.8': 'chat' } }).send(prompt, 'anthropic/claude-opus-4.8', [tool], {});
  return {};
});
await rec.run('responses-error-type-decides-classification', `${SRC}:224`, {}, async ({ net }) => {
  net.reply = FAILED.auth;
  const auth = await attempt(provider().send(prompt, 'openai/gpt-6.1-sol', [tool], {}));
  const authRequests = net.records.splice(0).length;
  net.reply = FAILED.overflow;
  const overflow = await attempt(provider().send(prompt, 'openai/gpt-6.1-sol', [tool], {}));
  return { auth, authKind: providerErrorKind(auth.error), authRequests, overflow, overflowKind: providerErrorKind(overflow.error), overflowIsContextOverflow: isContextOverflowError(overflow.error), overflowRequests: net.records.length };
});
await rec.run('canonical-error-type-outranks-native-code-http', `${SRC}:239`, {}, async ({ net }) => {
  const out = [];
  for (const [model, error] of [
    ['openrouter/auto', { code: 'invalid_prompt', message: 'too long', metadata: { error_type: 'context_length_exceeded' } }],
    ['openrouter/auto', { code: 'invalid_prompt', message: 'too long', error_type: 'context_length_exceeded' }],
    ['anthropic/claude-opus-4.8', { type: 'invalid_prompt', message: 'too long', error_type: 'context_length_exceeded' }],
  ]) {
    net.reply = () => ({ status: 400, contentType: 'application/json', body: JSON.stringify({ error }) });
    const r = await attempt(provider().send(prompt, model, [tool], {}));
    out.push({ model, error, ...r, kind: providerErrorKind(r.error), isContextOverflow: isContextOverflowError(r.error) });
  }
  const direct = Object.assign(new Error('too long'), { status: 400, code: 'invalid_prompt', error: { code: 'invalid_prompt', error_type: 'context_length_exceeded' } });
  return { out, direct: { kind: providerErrorKind(direct), isContextOverflow: isContextOverflowError(direct) } };
});
await rec.run('reasoning-control-on-messages-route', `${SRC}:266`, {}, async ({ net }) => {
  const model = 'anthropic/claude-opus-4.8';
  net.reply = respond;
  const sends = [];
  const one = async (label, config, opts) => {
    net.records = [];
    await provider(config).send(prompt, model, [tool], opts);
    sends.push({ label, config, opts, requests: net.records });
  };
  await one('none disables thinking', {}, { effort: 'high', openRouterReasoningEffort: 'none' });
  await one('explicit beats turn effort', {}, { effort: 'high', openRouterReasoningEffort: 'low' });
  const configured = provider({ reasoningEffort: 'low' });
  for (const opts of [{}, { effort: 'medium' }]) {
    net.records = [];
    await configured.send(prompt, model, [tool], opts);
    sends.push({ label: 'configured reasoningEffort low', opts, requests: net.records });
  }
  return { sends };
});
await rec.run('error-type-normalization-vocabulary', `${SRC}:287`, {}, () => {
  const plain = { code: 'server_error' };
  const kind = (err) => providerErrorKind(err).kind;
  return {
    mapped: normalizeGatewayErrorDetail({ code: 'server_error', message: 'm' }, { error_type: 'provider_overloaded' }),
    unmappedIsSameObject: normalizeGatewayErrorDetail(plain, { error_type: 'unmapped' }) === plain,
    nullIsSameObject: normalizeGatewayErrorDetail(plain, null) === plain,
    kinds: [
      kind({ status: 400, error: { type: 'error', error: { type: 'invalid_request_error', error_type: 'context_length_exceeded' } } }),
      kind({ error: { code: 429, message: 'x', metadata: { error_type: 'payment_required' } } }),
      kind({ status: 500, error: { type: 'api_error', error_type: 'authentication' } }),
    ],
  };
});
await rec.run('messages-usage-cost-inclusive-input', `${SRC}:339`, {}, async () => {
  const turn = createAnthropicTurnState();
  updateTurnUsage(turn.usage, { input_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 });
  updateTurnUsage(turn.usage, { output_tokens: 4, cost: '0.25' });
  const result = buildAnthropicTurnResult({ content: 'ok', usage: turn.usage }, { provider: 'openrouter', useModel: 'anthropic/claude-sonnet-5', opts: {} });
  const blank = createAnthropicTurnState();
  updateTurnUsage(blank.usage, { input_tokens: 1, cost: '' });
  updateTurnUsage(blank.usage, { output_tokens: 1, cost: -1 });
  const identity = {};
  const failure = Object.assign(new Error('stream lost'), { partialUsage: turn.usage });
  await attempt(withUsageContext(identity, () => withInclusiveUsage(async () => { noteAbandonedUsage(turn.usage, 'anthropic/claude-sonnet-5'); throw failure; })));
  const [abandoned] = identity.abandonedUsage;
  return { turnCost: turn.usage.costUsd, resultUsage: result.usage, blank, abandoned, failureCarriesSameUsageObject: failure.partialUsage === abandoned.usage };
});
await rec.finish();
