#!/usr/bin/env node
// custom-reasoning.test.mjs (12 tests): the real custom-provider reasoning resolver, Chat message lowering, chat options, the real
// compat send paths (Chat and Responses, over a scripted loopback endpoint: the OpenAI SDK sends real HTTP), the Anthropic API
// request builder and the effort helpers.
//   node benchmarks/rust-core/recorders/record-custom-reasoning.mjs --tree <exact export of b6f10295a>
import { sseBody, startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  pure: {
    'snapping-table': 'mixdog-ai/src/providers/custom/reasoning.rs:121 snap_effort(Option<&[String]>, &str) (pub; `pub mod reasoning` at custom/mod.rs:39)',
    'levels-and-unknown': 'mixdog-ai/src/providers/custom/reasoning.rs:100 ReasoningRow::effort_levels and :261 canonical_level (pub)',
    'wire-values-after-snapping': 'mixdog-ai/src/providers/custom/reasoning.rs:174 resolve(&Protocol, &ReasoningRow, Option<&str>, &str) -> Resolved (pub)',
    'protocol-and-wire-format': 'mixdog-ai/src/providers/custom/reasoning.rs:149 wire_format(&ReasoningRow, &str) and :174 resolve (pub)',
    'together-and-vllm-flags': 'mixdog-ai/src/providers/custom/reasoning.rs:174 resolve (pub; Resolved carries the thinking / wire flags)',
    'replay-eligibility': 'mixdog-ai/src/providers/custom/reasoning.rs:174 resolve (pub) / ReasoningRow (:87)',
    'effort-mjs-custom-rows-authoritative': 'mixdog-ai/src/providers/custom/reasoning.rs:174 resolve and :121 snap_effort (pub)',
    'toOpenAIMessages-custom-replay': 'RUST WORK: toOpenAIMessages is the compat chat message lowering; no public Rust function lowers messages without the codec (compat/chat/encode.rs build_body is reached through CompatChatCodec::encode, a framed WireRequest)',
    'chat-options': 'RUST WORK: applyCompatProviderChatOptions has no public Rust counterpart (compat/chat/options.rs is private to the crate)',
    'anthropic-custom-vs-first-party-isolated': 'RUST WORK: buildAnthropicApiRequest has no public Rust counterpart (anthropic/body.rs is private; AnthropicCodec::encode returns a framed WireRequest)',
  },
  set: 'provider-custom-reasoning',
  entry: 'custom-reasoning.mjs (snapCustomEffort, customEffortLevels, customWireFormat, resolveCustomReasoning), openai-compat-wire.mjs toOpenAIMessages, openai-compat-options.mjs applyCompatProviderChatOptions, openai-compat-chat-send.mjs sendCompatChat and openai-compat-responses.mjs sendCompatResponses on a real OpenAICompatProvider("custom-x", { baseURL: https://custom.invalid/v1 }) built by createCustomProvider from the stored config (the model row is the catalog entry of that provider, getCachedModelInfo over the manual model override of the config), anthropic-api-request.mjs buildAnthropicApiRequest, runtime-core/effort.mjs.',
  compare: 'mixdog-ai providers::custom::reasoning (reasoning.rs:121-200, :392-444), compat chat/options.rs and compat Responses codec, anthropic body.rs: feed `input` (model row, protocol, effort, base URL, history) and compare `result` whole; for the send cases the request body is `requests[0].body`.',
  replay: "PURE: the public mixdog-ai/src/providers/custom/reasoning.rs functions named per case in `levels` (snap_effort :121, wire_format :149, resolve :174, canonical_level :261, ReasoningRow::effort_levels :100). The send cases (sendCompatChat-custom-row-and-padding, sendCompatResponses-snaps-without-promotion) are WIRE: the request that arrived is `requests`; the model row is the product's own catalog entry (createCustomProvider over the stored config's manual model override, then getCachedModelInfo), the call a turn makes; the Node test substitutes it, the recording does not. Public Rust function of the same input and output for these two cases: none in o1 (they are the wire request). Cases marked RUST WORK have no public Rust function of the same input and output.",
});
const P = 'agent/orchestrator/providers/';
const { CUSTOM_EFFORT_LEVELS, customEffortLevels, customWireFormat, resolveCustomReasoning, snapCustomEffort } = await rec.P(`${P}custom-reasoning.mjs`);
const { applyCompatProviderChatOptions } = await rec.P(`${P}openai-compat-options.mjs`);
const { createCustomProvider } = await rec.P(`${P}custom-provider.mjs`);
const { toOpenAIMessages } = await rec.P(`${P}openai-compat-wire.mjs`);
const { buildAnthropicApiRequest } = await rec.P(`${P}anthropic-api-request.mjs`);
const { setModelEffortCapabilities } = await rec.P(`${P}anthropic-effort.mjs`);
const { coerceEffortFor, effortOptionsFor } = await rec.P('agent/orchestrator/runtime-core/effort.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/custom-reasoning.test.mjs';

function row(levels, customReasoning = {}, extra = {}) {
  return {
    id: 'm1', provider: 'custom-x', hidden: false, manual: true,
    supportsReasoning: Array.isArray(levels) && levels.length > 0,
    ...(levels ? { reasoningOptions: [{ type: 'effort', values: levels }], reasoningLevels: levels } : {}),
    customReasoning: { wireFormat: 'standard', wireValues: {}, replay: false, ...customReasoning },
    ...extra,
  };
}
const resolve = (args) => resolveCustomReasoning(args);

const snapCases = [
  [['low', 'medium', 'high'], 'medium'], [['low', 'medium', 'high'], 'max'], [['low', 'medium', 'high'], 'xhigh'], [['low', 'medium', 'high'], 'ultra'],
  [['low', 'medium', 'high'], 'minimal'], [['low', 'medium', 'high'], 'none'], [['none', 'low', 'high'], 'none'], [['none', 'low', 'high'], 'medium'],
  [['none', 'low', 'high'], 'minimal'], [['none', 'high'], 'low'], [['high', 'max'], 'low'], [['high', 'max'], 'xhigh'], [['high', 'max'], 'ultra'],
  [['minimal', 'max'], 'high'], [['max'], 'max'], [['ultra'], 'max'], [['none'], 'high'], [['none'], 'none'], [[], 'high'], [null, 'high'],
  [['low', 'high'], null], [['low', 'high'], ''], [['low', 'high'], 'auto'], [['low', 'high'], 'bogus'],
];
await rec.run('snapping-table', `${SRC}:32`, { cases: snapCases, levels: CUSTOM_EFFORT_LEVELS }, () => {
  const table = snapCases.map(([supported, requested]) => ({
    supported, requested, snapped: snapCustomEffort(supported, requested),
    resolvedLevel: supported === null ? undefined : resolve({ protocol: 'openai-chat', model: row(supported), effort: requested }).level,
  }));
  // The exhaustive invariant of the test: every subset of the levels against every level.
  const exhaustive = [];
  for (let mask = 0; mask < 1 << CUSTOM_EFFORT_LEVELS.length; mask++) {
    const supported = CUSTOM_EFFORT_LEVELS.filter((_, i) => mask & (1 << i));
    exhaustive.push({ supported, snapped: CUSTOM_EFFORT_LEVELS.map((requested) => snapCustomEffort(supported, requested)) });
  }
  return { table, exhaustive };
});
await rec.run('levels-and-unknown', `${SRC}:96`, {}, () => ({
  optionsWin: customEffortLevels({ reasoningOptions: [{ type: 'effort', values: ['high', 'low'] }], reasoningLevels: ['max'] }),
  legacy: customEffortLevels({ reasoningLevels: ['max', 'ultra', 'none'] }),
  empty: customEffortLevels({ reasoningOptions: [{ type: 'effort', values: [] }] }),
  missing: customEffortLevels({}),
  noRow: resolve({ protocol: 'openai-chat', model: row(undefined), effort: 'high' }),
  unset: resolve({ protocol: 'openai-chat', model: row(['low', 'high']), effort: undefined }),
}));
await rec.run('wire-values-after-snapping', `${SRC}:97`, {}, () => {
  const model = row(['low', 'high'], { wireValues: { high: 'HIGH_WIRE', max: 'MAX_WIRE' } });
  return { max: resolve({ protocol: 'openai-chat', model, effort: 'max' }), medium: resolve({ protocol: 'openai-chat', model, effort: 'medium' }) };
});
await rec.run('protocol-and-wire-format', `${SRC}:121`, {}, () => {
  const levels = ['none', 'low', 'high'];
  const std = row(levels);
  const ds = row(levels, { wireFormat: 'deepseek', wireValues: { high: 'max' } });
  return {
    chatHigh: resolve({ protocol: 'openai-chat', model: std, effort: 'high' }),
    chatNone: resolve({ protocol: 'openai-chat', model: std, effort: 'none' }),
    dsHigh: resolve({ protocol: 'openai-chat', model: ds, effort: 'high' }),
    dsNone: resolve({ protocol: 'openai-chat', model: ds, effort: 'none' }),
    responsesLow: resolve({ protocol: 'openai-responses', model: std, effort: 'low' }),
    anthropicHigh: resolve({ protocol: 'anthropic', model: std, effort: 'high' }),
    anthropicNone: resolve({ protocol: 'anthropic', model: std, effort: 'none' }),
    dsOnResponses: resolve({ protocol: 'openai-responses', model: ds, effort: 'high' }),
    dsOnAnthropic: resolve({ protocol: 'anthropic', model: ds, effort: 'high' }),
  };
});
await rec.run('together-and-vllm-flags', `${SRC}:171`, {}, () => {
  const hybrid = row(['none', 'low', 'high']);
  const effortOnly = row(['low', 'medium', 'high']);
  const together = 'https://api.together.xyz/v1';
  const chat = (model, effort, extra = {}) => resolve({ protocol: 'openai-chat', model, effort, ...extra }).fields;
  const vllm = row(['none', 'high'], { wireFormat: 'vllm' });
  return {
    togetherFormat: customWireFormat(hybrid, together),
    otherHostFormat: customWireFormat(hybrid, 'https://llm.example.com/v1'),
    deepseekOnTogether: customWireFormat(row(['high'], { wireFormat: 'deepseek' }), together),
    hybridNone: chat(hybrid, 'none', { baseURL: together }),
    hybridHigh: chat(hybrid, 'high', { baseURL: together }),
    effortOnly: chat(effortOnly, 'medium', { baseURL: together }),
    otherHost: chat(hybrid, 'high', { baseURL: 'https://llm.example.com/v1' }),
    responsesOnTogether: resolve({ protocol: 'openai-responses', model: hybrid, effort: 'high', baseURL: together }).fields,
    vllmNone: chat(vllm, 'none'),
    vllmHigh: chat(vllm, 'high'),
    vllmAnthropic: resolve({ protocol: 'anthropic', model: vllm, effort: 'high' }).fields,
  };
});
await rec.run('replay-eligibility', `${SRC}:179`, {}, () => {
  const on = row(['none', 'high'], { wireFormat: 'deepseek', replay: true });
  const explicitFalse = row(['high'], { replay: false }, { reasoningContentField: 'reasoning_content' });
  return {
    high: resolve({ protocol: 'openai-chat', model: on, effort: 'high' }).replay,
    unset: resolve({ protocol: 'openai-chat', model: on, effort: undefined }).replay,
    none: resolve({ protocol: 'openai-chat', model: on, effort: 'none' }).replay,
    deepseekReasonerId: resolve({ protocol: 'openai-chat', model: { ...on, id: 'deepseek-reasoner' }, effort: 'high' }).replay,
    responses: resolve({ protocol: 'openai-responses', model: row(['high'], { replay: true }), effort: 'high' }).replay,
    explicitFalse: resolve({ protocol: 'openai-chat', model: explicitFalse, effort: 'high' }).replay,
  };
});
const replayHistory = [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }] },
  { role: 'tool', toolCallId: 'c1', content: 'ok' },
  { role: 'assistant', content: '', reasoningContent: '', toolCalls: [{ id: 'c2', name: 't', arguments: {} }] },
  { role: 'tool', toolCallId: 'c2', content: 'ok' },
  { role: 'assistant', content: '', reasoningContent: 'thought', toolCalls: [{ id: 'c3', name: 't', arguments: {} }] },
  { role: 'tool', toolCallId: 'c3', content: 'ok' },
  { role: 'assistant', content: 'done' },
  { role: 'assistant', content: 'done2', reasoningContent: '' },
];
await rec.run('toOpenAIMessages-custom-replay', `${SRC}:221`, { history: replayHistory }, () => ({
  customReplay: toOpenAIMessages(replayHistory, 'custom-x', { customReplay: true }),
  explicitFalseWins: toOpenAIMessages(replayHistory, 'custom-x', { customReplay: false, replaysReasoningContent: true }),
  deepseekExact: toOpenAIMessages(replayHistory, 'deepseek', { replaysReasoningContent: true }),
  xai: toOpenAIMessages(replayHistory, 'xai'),
}));
await rec.run('chat-options', `${SRC}:266`, {}, () => {
  const ds = row(['none', 'low', 'high'], { wireFormat: 'deepseek' });
  return {
    customXhigh: applyCompatProviderChatOptions({ model: 'm1' }, 'custom-x', { effort: 'xhigh' }, {}, ds),
    customMinimal: applyCompatProviderChatOptions({ model: 'm1' }, 'custom-x', { effort: 'minimal' }, {}, ds),
    customNoRow: applyCompatProviderChatOptions({ model: 'm1' }, 'custom-x', { effort: 'high' }, {}, null),
    deepseek: applyCompatProviderChatOptions({ model: 'x' }, 'deepseek', { effort: 'medium' }),
    openrouter: applyCompatProviderChatOptions({ model: 'x' }, 'openrouter', { effort: 'none' }),
  };
});

const customConfig = (protocol, reasoning) => ({ type: 'custom', name: 'Custom', protocol, baseURL: 'https://custom.invalid/v1', enabled: true, apiKey: 'fixture', preconnect: false, schemaVersion: 2, modelOverrides: { m1: { manual: true, reasoning } } });
const chatReply = () => ({ status: 200, contentType: 'text/event-stream', body: `${sseBody([{ choices: [{ index: 0, delta: { content: 'done', reasoning_content: 'r' }, finish_reason: 'stop' }] }])}data: [DONE]\n\n` });
const responsesReply = () => ({
  status: 200, contentType: 'text/event-stream',
  body: sseBody([{ type: 'response.completed', response: { id: 'resp', model: 'm1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] } }], true),
});
const toolHistory = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }] }, { role: 'tool', toolCallId: 'c1', content: 'ok' }];

// A turn on a custom provider built by the product from its stored config (createCustomProvider): the model row the send reads is the one the provider's own
// catalog entry returns (getCachedModelInfo over the config's model override), nothing is substituted.
await rec.run('sendCompatChat-custom-row-and-padding', `${SRC}:307`, { history: toolHistory, config: customConfig('openai-chat', { levels: ['none', 'high'], wireFormat: 'deepseek', replay: true }) }, async ({ net }) => {
  const provider = await createCustomProvider('custom-x', customConfig('openai-chat', { levels: ['none', 'high'], wireFormat: 'deepseek', replay: true }));
  const info = provider.getCachedModelInfo('m1');
  net.reply = chatReply;
  const on = await provider.send(toolHistory, 'm1', [], { effort: 'max' });
  const onRequests = net.records.splice(0);
  const off = await provider.send(toolHistory, 'm1', [], { effort: 'none' });
  return { info, on, onRequests, off };
});
await rec.run('sendCompatResponses-snaps-without-promotion', `${SRC}:328`, { config: customConfig('openai-responses', { levels: ['high', 'max'], wireValues: { max: 'ultra-wire' } }) }, async ({ net }) => {
  const provider = await createCustomProvider('custom-r', customConfig('openai-responses', { levels: ['high', 'max'], wireValues: { max: 'ultra-wire' } }));
  const info = provider.getCachedModelInfo('m1');
  net.reply = responsesReply;
  const ultra = await provider.send([{ role: 'user', content: 'hi' }], 'm1', [], { effort: 'ultra' });
  const ultraRequests = net.records.splice(0);
  const low = await provider.send([{ role: 'user', content: 'hi' }], 'm1', [], { effort: 'low' });
  return { info, ultra, ultraRequests, low };
});
const anthropicRequest = (name, modelInfo, effort, model = 'claude-opus-5') =>
  buildAnthropicApiRequest({ name, config: {}, messages: [{ role: 'user', content: 'hi' }], useModel: model, tools: [], opts: { effort }, fastModeLatched: false, modelInfo });
await rec.run('anthropic-custom-vs-first-party-isolated', `${SRC}:364`, {}, async () => {
  try {
    setModelEffortCapabilities([{ id: 'claude-opus-5', provider: 'custom-a', reasoningOptions: [{ type: 'effort', values: [] }] }]);
    const first = await anthropicRequest('anthropic', null, 'high');
    const noneRow = { ...row([]), id: 'claude-opus-5', provider: 'custom-a' };
    const custom = await anthropicRequest('custom-a', noneRow, 'high');
    setModelEffortCapabilities([{ id: 'claude-opus-5', reasoningOptions: [{ type: 'effort', values: ['low'] }] }]);
    const richRow = { ...row(['low', 'medium', 'xhigh'], { wireValues: { xhigh: 'x-wire' } }), id: 'claude-opus-5' };
    const rich = await anthropicRequest('custom-a', richRow, 'max');
    const disabled = await anthropicRequest('custom-a', { ...row(['none', 'low']), id: 'claude-opus-5' }, 'none');
    const other = await anthropicRequest('custom-a', { ...row(['high']), id: 'glm-x' }, 'high', 'glm-x');
    return { first, custom, rich, disabled, other };
  } finally {
    setModelEffortCapabilities([]);
  }
});
await rec.run('effort-mjs-custom-rows-authoritative', `${SRC}:395`, {}, () => ({
  customEmpty: effortOptionsFor('custom-x', { ...row([]), family: 'opus' }),
  customUnknown: effortOptionsFor('custom-x', { ...row(undefined), family: 'opus' }),
  customSorted: effortOptionsFor('custom-x', row(['high', 'low', 'ultra'])),
  lowOnHighMax: coerceEffortFor('custom-x', row(['high', 'max']), 'low'),
  xhighToHigh: coerceEffortFor('custom-x', row(['low', 'high']), 'xhigh'),
  noneUnsupported: coerceEffortFor('custom-x', row(['low', 'high']), 'none'),
  noneSupported: coerceEffortFor('custom-x', row(['none', 'high']), 'none'),
  firstPartyMinimal: coerceEffortFor('anthropic', { family: 'opus' }, 'minimal'),
  firstPartyOptions: effortOptionsFor('anthropic', { family: 'opus', reasoningLevels: [] }),
}));
await rec.finish();
