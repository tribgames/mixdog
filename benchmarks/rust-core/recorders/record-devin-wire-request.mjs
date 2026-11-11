#!/usr/bin/env node
// devin-wire-request.test.mjs (16 tests): the real Devin chat-request builder (`buildDevinChatRequest`) over scripted conversations. Each
// scenario records the request the product built, the exact bytes it puts on the wire (`encodeDevinMessage('GetChatMessageRequest')`
// as hex) and that request decoded back (the strict codec's view, as the server sees it), plus `activeTail` and the compactable size.
// The identity/schema helpers are recorded as pure functions. 64-bit values in the decoded `wire` are written "<digits>n".
//   node benchmarks/rust-core/recorders/record-devin-wire-request.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  pure: {
    'assistant-source-and-uuid': 'mixdog-ai/src/providers/devin/request.rs:63 deterministic_uuid(&str) -> String (pub; `pub mod request` at devin/mod.rs:17)',
    'foreign-tool-call-ids-normalized': 'mixdog-ai/src/providers/devin/request.rs:78 normalize_tool_call_id(&str) and :148 wire_tool_call_ids (pub)',
    'responses-origin-composite-ids': 'mixdog-ai/src/providers/devin/request.rs:78 normalize_tool_call_id and :148 wire_tool_call_ids (pub)',
    'composite-result-pairs-plain-responses-call': 'mixdog-ai/src/providers/devin/request.rs:148 wire_tool_call_ids (pub)',
    'opaque-composite-id-never-collapses': 'mixdog-ai/src/providers/devin/request.rs:148 wire_tool_call_ids (pub)',
    'unanswered-call-and-orphan-result': 'mixdog-ai/src/providers/devin/request.rs:258 paired_transcript(Vec<Message>) (pub)',
    'misplaced-result-pulled-forward': 'mixdog-ai/src/providers/devin/request.rs:258 paired_transcript (pub)',
    'tool-schema-draft-upgrade-google-projection': 'RUST WORK: the draft upgrade / Google projection of tool schemas is not a public Devin function (looked in devin/request.rs and devin/schema.rs; google::schema is a separate public module with a different signature)',
    '*': 'mixdog-ai/src/providers/devin/request.rs:483 build_chat_request(&ModelRequest, &ChatParams) -> ChatRequest (pub); the framed, compressed WireRequest is DevinCodec::encode (devin/mod.rs:88), a different result: compare the ChatRequest before framing (ChatRequest::encode, devin/schema.rs:227)',
  },
  set: 'provider-devin-wire-request',
  net: false,
  entry: 'devin-wire-request.mjs buildDevinChatRequest(messages, { model, modelRow, metadata, cascadeId, executionId, ...options }) -> { request, activeTail }, devinHistoryBytes, devinDeterministicUuid, normalizeDevinToolCallId, responsesCallComponent; devin-wire-identity.mjs devinModelClass / isDevinGeminiModel / devinDemotedThinking; devin-wire-schema.mjs devinToolWireSchema / devinGoogleToolSchema; devin-wire-protobuf.mjs for the bytes. Not run: a send.',
  compare: 'mixdog-ai providers::devin request.rs (:78-91, :258) and connect/pb.rs: feed each scenario\'s `input.messages` + `input.options` (+ metadata/ids) and compare `result.hex` (the exact request bytes) and `result.activeTail`; `result.wire` is the decoded form for diagnosis; pure rows compare `result` whole.',
  replay: "PURE: mixdog-ai/src/providers/devin/request.rs (`pub mod request`, devin/mod.rs:17): build_chat_request :483 returns the ChatRequest (the builder result Node records); deterministic_uuid :63, normalize_tool_call_id :78, wire_tool_call_ids :148, paired_transcript :258; per case see `levels`. DevinCodec::encode returns a framed, compressed WireRequest and is NOT the recorded value. The tool-schema draft-upgrade case is Rust work.",
});
const P = 'agent/orchestrator/providers/';
const { DEVIN_ENUMS, decodeDevinMessage, encodeDevinMessage } = await rec.P(`${P}devin-wire-protobuf.mjs`);
const { DEVIN_ASSISTANT_SOURCE, DEVIN_REPLAY_ITEM_TYPE, buildDevinChatRequest, devinDeterministicUuid, devinHistoryBytes, normalizeDevinToolCallId, responsesCallComponent } = await rec.P(`${P}devin-wire-request.mjs`);
const { devinDemotedThinking, devinModelClass, isDevinGeminiModel } = await rec.P(`${P}devin-wire-identity.mjs`);
const { devinGoogleToolSchema, devinToolWireSchema } = await rec.P(`${P}devin-wire-schema.mjs`);
const { createProviderReplay } = await rec.P(`${P}lib/provider-replay.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/devin-wire-request.test.mjs';
const PNG = Buffer.from('fake-png').toString('base64');
const visionRow = { id: 'm-vision', supportsVision: true, supportsParallelToolCalls: true, maxOutputTokens: 8000 };
const textRow = { id: 'm-text', supportsVision: false, supportsParallelToolCalls: false, maxOutputTokens: 4000 };
const devinReplay = (model, extra = {}) => createProviderReplay('devin-oauth', [{ type: DEVIN_REPLAY_ITEM_TYPE, model, ...extra }]);
// Options as the test passes them (modelRow by its name so the input is data, not a reference).
const ROWS = { text: textRow, vision: visionRow };
function build(messages, options = {}) {
  const { modelRow, ...rest } = options;
  const { request, activeTail } = buildDevinChatRequest(messages, { model: 'm-text', modelRow: ROWS[modelRow ?? 'text'], metadata: { apiKey: 'k', userJwt: 'j' }, cascadeId: 'cascade-1', executionId: 'exec-1', ...rest });
  const bytes = encodeDevinMessage('GetChatMessageRequest', request);
  return { activeTail, historyBytes: devinHistoryBytes(request, activeTail), hex: Buffer.from(bytes).toString('hex'), wire: decodeDevinMessage('GetChatMessageRequest', bytes) };
}
const scenario = (id, line, messages, options = {}) => rec.run(id, `${SRC}:${line}`, { messages, options }, () => build(messages, options));
const scenarios = (id, line, list) => rec.run(id, `${SRC}:${line}`, { scenarios: list }, () => list.map(({ label, messages, options = {} }) => ({ label, ...build(messages, options) })));

await scenarios('request-envelope-matches-native-cli', 49, [
  { label: 'system+user maxOutputTokens 100000', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'x' }], options: { maxOutputTokens: 100_000 } },
  { label: 'model default max tokens', messages: [{ role: 'user', content: 'x' }] },
  { label: 'parallel tool calls allowed (vision row)', messages: [{ role: 'user', content: 'x' }], options: { model: 'm-vision', modelRow: 'vision' } },
]);
await rec.run('assistant-source-and-uuid', `${SRC}:80`, {}, () => ({ assistantSource: DEVIN_ASSISTANT_SOURCE, enums: DEVIN_ENUMS.ChatMessageSource, uuids: ['cascade-1\u00000\u0000user', 'cascade-1\u00001\u0000assistant', 'cascade-1\u00002\u0000tool\u0000call_1'].map((seed) => ({ seed, uuid: devinDeterministicUuid(seed) })) }));
await scenario('multi-turn-history-lowering', 80, [
  { role: 'system', content: 'You are Mixdog.' }, { role: 'system', content: [{ type: 'text', text: 'Be brief.' }] },
  { role: 'user', content: [{ type: 'text', text: 'read ' }, { type: 'text', text: 'a.ts' }] },
  { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.ts' } }] },
  { role: 'tool', toolCallId: 'call_1', content: 'contents' }, { role: 'developer', content: 'note' }, { role: 'user', content: 'thanks' },
]);
const longId = `toolu_${'x'.repeat(60)}`;
await rec.run('foreign-tool-call-ids-normalized', `${SRC}:121`, {}, () => ({
  ...build([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', toolCalls: [{ id: longId, name: 'read', arguments: { path: 'a' } }, { id: 'call_A|first', name: 'read', arguments: { path: 'b' } }, { id: 'call_A|second', name: 'read', arguments: { path: 'c' } }, { id: 'call_A_first', name: 'read', arguments: { path: 'd' } }] },
    { role: 'tool', toolCallId: longId, content: 'A' }, { role: 'tool', toolCallId: 'call_A|first', content: 'B' }, { role: 'tool', toolCallId: 'call_A|second', content: 'C' }, { role: 'tool', toolCallId: 'call_A_first', content: 'D' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_A|second', name: 'read', arguments: {} }] }, { role: 'tool', toolCallId: 'call_A|second', content: 'E' },
  ]),
  normalized: normalizeDevinToolCallId('a.b:c'),
}));
const responsesTurn = (owner) => [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', providerReplay: createProviderReplay(owner, [{ type: 'function_call', call_id: 'call_a', id: 'item_b' }]), toolCalls: [{ id: 'call_a|item_b', name: 'read', arguments: {} }, { id: 'call_c', name: 'read', arguments: {} }, { id: '|item_only', name: 'read', arguments: {} }] },
  { role: 'tool', toolCallId: 'call_a|item_b', content: 'A' }, { role: 'tool', toolCallId: 'call_c', content: 'C' }, { role: 'tool', toolCallId: '|item_only', content: 'I' },
];
await rec.run('responses-origin-composite-ids', `${SRC}:163`, {}, () => ({
  scenarios: [...['openai-responses', 'xai-responses', 'compat-responses:opencode-go'].map((owner) => ({ label: owner, ...build(responsesTurn(owner)) })),
    { label: 'bare call_id result', ...build([{ role: 'user', content: 'go' }, { role: 'assistant', content: '', providerReplay: createProviderReplay('openai-responses', [{ type: 'function_call' }]), toolCalls: [{ id: 'call_x|fc_1', name: 'read', arguments: {} }] }, { role: 'tool', toolCallId: 'call_x', content: 'X' }]) },
    { label: 'anthropic origin keeps every segment', ...build([{ role: 'user', content: 'go' }, { role: 'assistant', content: '', providerReplay: createProviderReplay('anthropic', [{ type: 'tool_use' }]), toolCalls: [{ id: 'call_a|item_b', name: 'read', arguments: {} }] }, { role: 'tool', toolCallId: 'call_a|item_b', content: 'A' }]) }],
  component: [responsesCallComponent('call_a|item_b'), responsesCallComponent('|item_b')],
}));
await scenario('composite-result-pairs-plain-responses-call', 230, [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', providerReplay: createProviderReplay('openai-responses', [{ type: 'function_call' }]), toolCalls: [{ id: 'call_A', name: 'read', arguments: {} }] },
  { role: 'tool', toolCallId: 'call_A|fc_9', content: 'A' }, { role: 'user', content: 'next' },
  { role: 'assistant', content: '', providerReplay: createProviderReplay('anthropic', [{ type: 'tool_use' }]), toolCalls: [{ id: 'tok|1', name: 'read', arguments: {} }, { id: 'tok|2', name: 'read', arguments: {} }] },
  { role: 'tool', toolCallId: 'tok|2', content: 'two' }, { role: 'tool', toolCallId: 'tok|1', content: 'one' },
]);
await scenario('opaque-composite-id-never-collapses', 259, [
  { role: 'user', content: 'go' },
  { role: 'assistant', content: '', providerReplay: createProviderReplay('openai-responses', [{ type: 'function_call' }]), toolCalls: [{ id: 'call_A', name: 'read', arguments: {} }] },
  { role: 'tool', toolCallId: 'call_A', content: 'first' }, { role: 'user', content: 'again' },
  { role: 'assistant', content: '', providerReplay: devinReplay('m-text'), toolCalls: [{ id: 'call_A|opaque', name: 'read', arguments: {} }] },
  { role: 'tool', toolCallId: 'call_A|opaque', content: 'second' }, { role: 'user', content: 'more' },
  { role: 'assistant', content: '', providerReplay: createProviderReplay('anthropic', [{ type: 'tool_use' }]), toolCalls: [{ id: 'call_A|other', name: 'read', arguments: {} }] },
  { role: 'tool', toolCallId: 'call_A|other', content: 'third' },
]);
const turn = (extra) => [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'answer', ...extra }, { role: 'user', content: 'q2' }];
const demoted = [
  ['compat reasoningContent', { reasoningContent: 'compat reasoning' }],
  ['anthropic thinking replay', { providerReplay: createProviderReplay('anthropic', [{ type: 'thinking', thinking: 'first', signature: 'anthropic-sig' }, { type: 'redacted_thinking', data: 'x' }, { type: 'thinking', thinking: 'second', signature: 'sig-2' }, { type: 'text', text: 'answer' }]) }],
  ['gemini thought replay', { providerReplay: createProviderReplay('gemini', [{ thought: true, text: 'gemini thought', thoughtSignature: 'g-sig' }, { text: 'answer' }]) }],
  ['openai reasoning replay', { providerReplay: createProviderReplay('openai-responses', [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }], encrypted_content: 'enc' }]) }],
  ['blank reasoningContent', { reasoningContent: '   ' }],
];
const standalone = [
  ['thinkingBlocks', { thinkingBlocks: [{ type: 'thinking', thinking: 'trace', signature: 's' }] }],
  ['assistantBlocks', { assistantBlocks: [{ type: 'thinking', thinking: 'a1', signature: 's1' }, { type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'a2', signature: 's2' }] }],
  ['reasoningItems', { reasoningItems: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'rs' }], encrypted_content: 'e' }] }],
  ['one trace many representations', { reasoningContent: 'same trace', thinkingBlocks: [{ type: 'thinking', thinking: 'same trace', signature: 's' }], assistantBlocks: [{ type: 'thinking', thinking: 'same trace', signature: 's' }] }],
  ['redacted blocks with thinkingBlocks fallback', { assistantBlocks: [{ type: 'redacted_thinking', data: 'x' }], thinkingBlocks: [{ type: 'thinking', thinking: 'fallback' }] }],
  ['ordered blocks win over partial reasoningContent', { reasoningContent: 'first', thinkingBlocks: [{ type: 'thinking', thinking: 'first' }, { type: 'thinking', thinking: 'second' }] }],
];
await scenarios('foreign-reasoning-demoted', 296, [
  ...[...demoted, ...standalone].map(([label, extra]) => ({ label, messages: turn(extra), options: { model: 'gpt-y' } })),
  { label: 'claude model plain reasoningContent', messages: turn({ reasoningContent: 'plain  ' }), options: { model: 'claude-x' } },
]);
const sameId = `devin_${'y'.repeat(50)}`;
await scenario('same-model-turn-keeps-tool-call-ids', 397, [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: sameId, name: 'read', arguments: {} }], providerReplay: devinReplay('m-text', { messageId: 'bot-1' }) }, { role: 'tool', toolCallId: sameId, content: 'A' }]);
await scenario('unanswered-call-and-orphan-result', 421, [
  { role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] }, { role: 'user', content: 'continue' },
  { role: 'tool', toolCallId: 'ghost', toolName: 'grep', content: 'late', isError: true }, { role: 'tool', toolCallId: 'blank', toolName: 'grep', content: '  ' },
]);
await scenario('misplaced-result-pulled-forward', 446, [
  { role: 'user', content: 'go' }, { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x', arguments: {} }, { id: 'b', name: 'x', arguments: {} }] },
  { role: 'tool', toolCallId: 'a', content: 'A' }, { role: 'tool', toolCallId: 'ghost', content: 'orphan inside the window' }, { role: 'user', content: 'meanwhile' },
  { role: 'tool', toolCallId: 'b', content: 'B late' }, { role: 'tool', toolCallId: 'a', content: 'A again' },
  { role: 'assistant', content: 'bye', stopReason: 'aborted', toolCalls: [{ id: 'z', name: 'x', arguments: {} }] }, { role: 'user', content: 'next' },
]);
const history = [
  { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1', providerReplay: devinReplay('claude-x', { messageId: 'bot-1', thinking: 'native reasoning', signature: 'sig-1' }) },
  { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2', providerReplay: devinReplay('gpt-y', { messageId: 'bot-2', thinking: 'other', signature: 'sig-2' }) },
  { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3', providerReplay: createProviderReplay('gemini', [{ thought: true }]) }, { role: 'user', content: 'q4' },
];
await scenarios('native-thinking-same-model-demoted-otherwise', 478, [
  { label: 'claude-x', messages: history, options: { model: 'claude-x' } },
  { label: 'claude-x typed signature', messages: [history[0], { ...history[1], providerReplay: devinReplay('claude-x', { thinking: 't', signature: 'sig-1', signatureType: 'anthropic' }) }, history[2]], options: { model: 'claude-x' } },
  { label: 'gpt-y', messages: history, options: { model: 'gpt-y' } },
  { label: 'gemini-3-pro', messages: history, options: { model: 'gemini-3-pro' } },
  { label: 'swe-1-6', messages: history, options: { model: 'swe-1-6' } },
  { label: 'trailing demoted block trimmed', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', providerReplay: devinReplay('gpt-y', { thinking: 'trailing  \n' }) }, { role: 'user', content: 'q2' }], options: { model: 'claude-x' } },
]);
const classes = ['claude-sonnet-4-5', 'anthropic/claude-opus-4', 'gemini-3-pro-high', 'gemma-3-27b', 'gpt-5-codex', 'o3', 'o3-high', 'gpt-oss-120b', 'kimi-k2-thinking', 'k3', 'glm-4.6', 'qwen3-coder', 'deepseek-r1-distill-qwen-32b', 'deepseek-v3', 'minimax-m2', 'grok-4', 'swe-1-6', 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW'];
await rec.run('model-classes-and-demotion-wrappers', `${SRC}:524`, { classes }, () => ({
  classes: classes.map((id) => [id, devinModelClass(id)]),
  gemini: [['adaptive', 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW'], ['gemini-2.5-flash', 'x'], ['claude-x', 'claude-x']].map(([a, b]) => [a, b, isDevinGeminiModel(a, b)]),
  demoted: [['minimax-m2', '<thinking>\nr\n</thinking>'], ['kimi-k2', 'r'], ['claude-x', 'r '], ['claude-x', '']].map(([model, text]) => [model, text, devinDemotedThinking(model, text)]),
}));
const imageMessages = [
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: PNG, mimeType: 'image/png' }] },
  { role: 'assistant', content: '', toolCalls: [{ id: 's1', name: 'shot', arguments: {} }] },
  { role: 'tool', toolCallId: 's1', content: [{ type: 'image', data: PNG, mimeType: 'image/jpeg' }] },
];
await scenarios('images-only-for-vision-models', 555, [
  { label: 'vision model', messages: imageMessages, options: { model: 'm-vision', modelRow: 'vision' } },
  { label: 'text model', messages: imageMessages },
]);
const schema = { type: 'object', properties: { path: { type: 'string' }, limit: { type: ['number', 'null'] } }, required: ['path'] };
const tools = [{ name: 'read', description: 'Read a file', inputSchema: schema }];
await scenarios('tool-schemas-json-strings', 579, [
  { label: 'plain', messages: [{ role: 'user', content: 'x' }], options: { tools } },
  { label: 'strict', messages: [{ role: 'user', content: 'x' }], options: { tools: [{ ...tools[0], strict: true }] } },
  { label: 'gemini model', messages: [{ role: 'user', content: 'x' }], options: { tools, model: 'gemini-3-pro' } },
  { label: 'routed to a gemini chatModelUid', messages: [{ role: 'user', content: 'x' }], options: { tools, model: 'adaptive', chatModelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW' } },
]);
const nullable = { type: 'object', properties: { a: { type: 'string', nullable: true, format: 'uri', minLength: 2 }, b: { type: ['number', 'null'], minimum: 0, maximum: 9 }, c: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'C' } }, required: ['a'], additionalProperties: false };
const unions = { type: 'object', properties: { mode: { anyOf: [{ const: 'fast' }, { const: 'slow' }] }, level: { oneOf: [{ const: 1 }, { const: 2 }] }, mixed: { anyOf: [{ const: 'x' }, { const: null }] }, bare: { enum: ['p', 'q'] }, nums: { enum: [1, 2, 3] } } };
const shapes = { type: 'object', properties: { multi: { type: ['string', 'array', 'null'], items: { type: 'string' }, maxLength: 4, minItems: 2 }, any: {}, flag: true, never: false, map: { type: 'object', additionalProperties: { type: 'string' }, patternProperties: { '^x': { type: 'number' } } } } };
const refs = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', definitions: { Pt: { type: 'object', properties: { x: { type: 'number' } } } }, properties: { p: { $ref: '#/definitions/Pt', description: 'point' }, t: { type: 'array', items: [{ type: 'string' }] } } };
await rec.run('tool-schema-draft-upgrade-google-projection', `${SRC}:656`, { schemas: { nullable, unions, shapes, refs } }, () => {
  const out = {};
  for (const [name, s] of Object.entries({ nullable, unions, shapes, refs })) {
    const wire = devinToolWireSchema(s);
    out[name] = { wire, google: devinGoogleToolSchema(wire), googleJson: JSON.stringify(devinGoogleToolSchema(wire)) };
  }
  return out;
});
const big = 'h'.repeat(1000);
await rec.run('active-turn-excluded-from-compactable-size', `${SRC}:692`, { note: 'message contents are generated: big = 1000 x h, user text = 5000 x u, orphan result = 614400 x o', big: 1000, userText: 5000, orphanResult: 614400 }, () => ({
  scenarios: [
    { label: 'orphan result then big user', ...build([{ role: 'tool', toolCallId: 'x', content: big }, { role: 'user', content: 'u'.repeat(5000) }]) },
    { label: 'split user messages', ...build([{ role: 'user', content: big }, { role: 'user', content: 'u' }, { role: 'developer', content: 'd' }]) },
    { label: 'after tool', ...build([{ role: 'user', content: 'small' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 't', arguments: {} }] }, { role: 'tool', toolCallId: 'c', content: big }]) },
    { label: 'orphan synthetic note stays compactable', ...build([{ role: 'user', content: 'small' }, { role: 'tool', toolCallId: 'gone', toolName: 'read', content: 'o'.repeat(600 * 1024) }]) },
  ],
}));
await rec.finish();
