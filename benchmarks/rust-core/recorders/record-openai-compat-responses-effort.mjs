#!/usr/bin/env node
// openai-compat-responses-effort.test.mjs (8 tests; 9 rows with the model loop): the real custom-route effort configuration
// (`effortConfigurationMode`, `prepareTurnEffortConfiguration`, `stepEffortConfiguration`) and the real compat Responses sender over a
// scripted SDK endpoint: the provider's `client.responses.create(params, options)` records each request (body, headers option) and answers
// with one `response.completed` (or the scripted rejection), as the test's fixture does.
//   node benchmarks/rust-core/recorders/record-openai-compat-responses-effort.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-compat-responses-effort',
  net: false,
  entry: 'effort-configuration.mjs effortConfigurationMode / prepareTurnEffortConfiguration / stepEffortConfiguration, openai-compat-responses.mjs sendCompatResponses over an OpenAICompatProvider-prototype instance with a scripted `client.responses.create` and the scripted model row (getCachedModelInfo) and customConfig.protocol as inputs. Not run: the SDK transport.',
  compare: 'mixdog-ai providers::custom::reasoning (reasoning.rs:121-200, :149 opt-out) and the compat Responses codec / openai effort_retry.rs:22: feed each row\'s `input` (turn efforts, levels, protocol, rejection) and compare `result` (modes, snapshots) and every `requests[*]` (body incl. reasoning, configuration_update items, prompt_cache_key, headers) in order.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::custom::normalize_request_body (custom/mod.rs:126) / CustomRequestConfig (custom/mod.rs:67) on top of CompatAdapter (compat/adapter.rs:63), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const P = 'agent/orchestrator/providers/';
const { effortConfigurationMode, prepareTurnEffortConfiguration, stepEffortConfiguration } = await rec.P(`${P}effort-configuration.mjs`);
const { sendCompatResponses } = await rec.P(`${P}openai-compat-responses.mjs`);
const { OpenAICompatProvider } = await rec.P(`${P}openai-compat.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openai-compat-responses-effort.test.mjs';
const LEVELS = ['low', 'medium', 'high'];
const rowFor = (id, levels = LEVELS) => ({ id, reasoningLevels: levels, customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' }, replay: false } });
function fixture(name, model, { protocol = 'openai-responses', levels, reject, config = {} } = {}) {
  const requests = [];
  const row = rowFor(model, levels);
  const provider = Object.assign(Object.create(OpenAICompatProvider.prototype), {
    name, config: { preconnect: false, ...config }, customConfig: { protocol }, nativePdf: false, getCachedModelInfo: (id) => (id === model ? row : null),
    client: { responses: { create: async (params, options) => {
      requests.push({ body: structuredClone(params), headers: options?.headers ?? null });
      const error = reject?.(requests.length);
      if (error) throw error;
      return (async function* () {
        yield { type: 'response.completed', response: { id: `resp-${requests.length}`, model: params.model, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } };
      })();
    } } },
  });
  return { provider, requests };
}
const SESSION = { sessionId: 'sess-1', promptCacheKey: 'mixdog-custom-g', providerCacheKey: 'mixdog-custom-g' };
const newSession = (provider, model) => ({ provider: provider.name, model, effort: 'low', messages: [{ role: 'system', content: 'Stable.' }] });
function appendTurn(session, provider, effort) {
  session.effort = effort;
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  session.messages.push({ role: 'user', content: `Question at ${effort}`, ...(snapshot ? { meta: { effortConfiguration: snapshot } } : {}) });
  return { ...SESSION, effort, effortConfiguration: snapshot };
}
const updatesOf = (body) => body.input.filter((item) => item.type === 'configuration_update');
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};

await rec.run('mode-resolution-by-model-and-options', `${SRC}:75`, {}, () => {
  const responses = { protocol: 'openai-responses' };
  return {
    responses: ['gpt-6-sol', 'gpt-6.1-sol', 'openai/gpt-6.1-sol', 'vendor/openai/gpt-7', 'OpenAI/GPT-6.2-luna', 'openai/gpt-5.6-sol', 'gpt-5.5', 'openai/o4-mini', 'gpt-6-sol/other'].map((m) => [m, effortConfigurationMode('custom-g', m, responses)]),
    chat: effortConfigurationMode('custom-g', 'openai/gpt-6.1-sol', { protocol: 'openai-chat' }),
    noConfig: effortConfigurationMode('custom-g', 'openai/gpt-6.1-sol'),
    builtinGateway: effortConfigurationMode('opencode-go', 'gpt-6.1-sol', responses),
    options: [{ modelParameters: { mode: 'pro' } }, { multiAgent: true }, { thinkingBudgetTokens: 1024 }, { effortConfigurationEnabled: false }].map((opts) => [opts, effortConfigurationMode('custom-g', 'openai/gpt-6.1-sol', { ...responses, ...opts })]),
  };
});
await rec.run('turn-preparation-mode', `${SRC}:95`, {}, () => {
  const mode = (model, options) => {
    const { provider } = fixture('custom-g', model, options);
    return prepareTurnEffortConfiguration(newSession(provider, model), provider)?.mode ?? null;
  };
  return { gpt6Responses: mode('openai/gpt-6.1-sol'), gpt6Chat: mode('openai/gpt-6.1-sol', { protocol: 'openai-chat' }), gpt5: mode('openai/gpt-5.6-sol'), noLevels: mode('openai/gpt-6.1-sol', { levels: [] }) };
});
for (const model of ['gpt-6-sol', 'openai/gpt-6.1-sol']) {
  await rec.run(`pins-top-level-effort-keeps-prefix-and-cache-key:${model}`, `${SRC}:108`, { model, efforts: ['low', 'high', 'medium', 'medium', 'low'] }, async () => {
    const { provider, requests } = fixture('custom-g', model);
    const session = newSession(provider, model);
    const turns = [];
    for (const effort of ['low', 'high', 'medium', 'medium', 'low']) {
      const opts = appendTurn(session, provider, effort);
      await sendCompatResponses(provider, session.messages, model, [], opts);
      turns.push({ effort, effortConfiguration: opts.effortConfiguration, request: requests.at(-1) });
      session.messages.push({ role: 'assistant', content: `Answer at ${effort}` });
    }
    return { turns };
  });
}
await rec.run('none-level-sent-as-update', `${SRC}:140`, { levels: ['none', 'low', 'high'] }, async () => {
  const model = 'openai/gpt-6.1-sol';
  const { provider, requests } = fixture('custom-g', model, { levels: ['none', 'low', 'high'] });
  const session = newSession(provider, model);
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'low'));
  session.messages.push({ role: 'assistant', content: 'Answer at low' });
  const opts = appendTurn(session, provider, 'none');
  await sendCompatResponses(provider, session.messages, model, [], opts);
  return { effortConfiguration: opts.effortConfiguration, step: stepEffortConfiguration(opts.effortConfiguration, provider.name, model, 'none'), requests };
});
await rec.run('step-effort-after-whole-tool-batch', `${SRC}:158`, {}, async () => {
  const model = 'openai/gpt-6.1-sol';
  const { provider, requests } = fixture('custom-g', model);
  const session = newSession(provider, model);
  const opts = appendTurn(session, provider, 'low');
  session.messages.push(
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }, { id: 'c2', name: 't', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: 'one' },
    { role: 'tool', toolCallId: 'c2', content: 'two', meta: { effortConfiguration: stepEffortConfiguration(opts.effortConfiguration, provider.name, model, 'high') } }
  );
  await sendCompatResponses(provider, session.messages, model, [], opts);
  session.messages.push({ role: 'assistant', content: 'done' });
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'high'));
  return { messages: session.messages, requests };
});
await rec.run('rejecting-model-replayed-once-with-per-request-effort', `${SRC}:197`, { model: 'openai/gpt-6.2-reject', rejectOnRequest: 2 }, async () => {
  const model = 'openai/gpt-6.2-reject';
  const rejection = Object.assign(new Error('400 Unsupported input item type: configuration_update'), { status: 400 });
  const { provider, requests } = fixture('custom-g', model, { reject: (n) => (n === 2 ? rejection : null) });
  const session = newSession(provider, model);
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'low'));
  session.messages.push({ role: 'assistant', content: 'a' });
  const result = await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'high'));
  const modeAfter = effortConfigurationMode('custom-g', model, { protocol: 'openai-responses' });
  const session2 = newSession(provider, model);
  const nextMode = appendTurn(session2, provider, 'low').effortConfiguration.mode;
  const other = fixture('custom-g', 'openai/gpt-6.3-other', { reject: () => Object.assign(new Error('400 bad tool schema'), { status: 400 }) });
  const otherOut = await attempt(sendCompatResponses(other.provider, [{ role: 'user', content: 'hi' }], 'openai/gpt-6.3-other', [], SESSION));
  return { result, requests, modeAfter, nextMode, other: otherOut, otherRequests: other.requests.length };
});
await rec.run('custom-session-identity-key-headers-hook', `${SRC}:232`, {}, async () => {
  const model = 'openai/gpt-6.1-sol';
  const messages = [{ role: 'user', content: 'hi' }];
  const { provider, requests } = fixture('custom-g', model);
  const send = (opts, p = provider) => sendCompatResponses(p, messages, model, [], opts);
  const long = 'x'.repeat(100);
  const sends = [];
  for (const [label, opts] of [
    ['no session', { effort: 'low' }], ['promptCacheKey', { effort: 'high', promptCacheKey: 'pk' }], ['providerCacheKey', { effort: 'high', providerCacheKey: 'pk' }], ['session.promptCacheKey', { effort: 'high', session: { promptCacheKey: 'pk' } }], ['sessionId', { effort: 'high', sessionId: 'pk' }],
    ['session wins, shared scope', { ...SESSION, promptCacheScope: 'shared' }], ['long session id', { sessionId: long }], ['long session id medium', { sessionId: long, effort: 'medium' }], ['caller session-id header', { ...SESSION, requestHeaders: { 'session-id': 'caller' } }],
  ]) {
    await send(opts);
    sends.push({ label, opts, request: requests.at(-1) });
  }
  const gateway = fixture('opencode-go', model, { config: { responsesPromptCacheKey: true } });
  await send(SESSION, gateway.provider);
  const hooked = fixture('custom-g', model, { config: { responsesParamsHook(params) { params.prompt_cache_key = 'hook'; } } });
  await send(SESSION, hooked.provider);
  return { sends, gateway: gateway.requests.at(-1), hooked: hooked.requests[0] };
});
await rec.run('pre-gpt6-and-builtin-gateways-keep-per-request-shape', `${SRC}:268`, {}, async () => {
  const model = 'openai/gpt-5.6-sol';
  const { provider, requests } = fixture('custom-g', model);
  const session = newSession(provider, model);
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'low'));
  session.messages.push({ role: 'assistant', content: 'a' });
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'high'));
  const gateway = fixture('opencode-go', 'gpt-6.1-sol');
  const gatewaySession = newSession(provider, 'gpt-6.1-sol');
  const first = appendTurn(gatewaySession, provider, 'low');
  gatewaySession.messages.push({ role: 'assistant', content: 'a' });
  const second = appendTurn(gatewaySession, provider, 'high');
  await sendCompatResponses(gateway.provider, gatewaySession.messages, 'gpt-6.1-sol', [], { ...first, ...second });
  return { requests, gateway: gateway.requests[0] };
});
await rec.finish();
