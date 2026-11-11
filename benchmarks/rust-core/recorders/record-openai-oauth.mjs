#!/usr/bin/env node
// openai-oauth.test.mjs (11 tests): the real OpenAI OAuth Responses request builder (`buildRequestBody`), history lowering
// (`_convertMessagesToResponsesInputForTest`), custom-tool-wire parser and the HTTP/SSE decoder (`sendViaHttpSse`) over scripted SSE
// frames. The HTTP endpoint is the product's `fetchFn` injection point: a scripted function that records the request (url, header names
// in order, body) and answers with the scripted frames framed as the test frames them.
//   node benchmarks/rust-core/recorders/record-openai-oauth.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-oauth',
  net: false,
  entry: 'openai-oauth.mjs buildRequestBody / _convertMessagesToResponsesInputForTest, openai-oauth-http-sse.mjs sendViaHttpSse({ auth, body, useModel, opts, cacheKey, fetchFn, onToolCall }), custom-tool-wire.mjs customToolCallFromResponseItem, tools/patch-tool-defs.mjs PATCH_TOOL_DEFS and tools/builtin BUILTIN_TOOLS as tool inputs. Not run: a live endpoint.',
  replay: 'mixdog-ai providers::openai input.rs:270-346,440-470,534-582, decoder.rs:789,1144-1179 and codec.rs:89-98: feed `input` (history/tools/opts, or `frames` for the HTTP/SSE cases) and compare `result`/`error` and the request body / headers recorded in `request` whole. K1 notes: the env kill switches MIXDOG_OAI_DISABLE_REASONING_REPLAY and MIXDOG_OAI_STATELESS_HTTP are Node-only (gaps G11).',
});
const P = 'agent/orchestrator/providers/';
const { buildRequestBody, _convertMessagesToResponsesInputForTest } = await rec.P(`${P}openai-oauth.mjs`);
const { sendViaHttpSse } = await rec.P(`${P}openai-oauth-http-sse.mjs`);
const { customToolCallFromResponseItem } = await rec.P(`${P}custom-tool-wire.mjs`);
const { PATCH_TOOL_DEFS } = await rec.P('agent/orchestrator/tools/patch-tool-defs.mjs');
const { BUILTIN_TOOLS } = await rec.P('agent/orchestrator/tools/builtin/builtin-tools.mjs');
const SRC = 'scripts/provider-toolcall/openai-oauth.test.mjs';

// The HTTP/SSE answer: each event framed `event: <type>\ndata: <json>\n\n`, delivered whole.
const httpSseResponse = (events) => {
  const chunks = events.map((e) => new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
  let i = 0;
  return { status: 200, ok: true, headers: new Map(), body: { getReader: () => ({ read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), cancel: () => Promise.resolve(), releaseLock() {} }) } };
};
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};
const sse = (args, events, onToolCall) => {
  const request = [];
  const out = attempt(sendViaHttpSse({ ...args, onToolCall, fetchFn: async (url, init) => (request.push({ url, headers: Object.entries(init.headers ?? {}), body: init.body ?? null }), httpSseResponse(events)) }));
  return out.then((o) => ({ ...o, request }));
};

const nativePairHistory = [
  { role: 'assistant', content: '', toolCalls: [{ id: 'native-pair', name: 'load_tool', arguments: {}, nativeType: 'tool_search_call' }] },
  { role: 'tool', toolCallId: 'native-pair', content: 'Loaded', nativeToolSearch: { provider: 'openai', toolReferences: ['read'], openaiTools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }] } },
];
await rec.run('native-provider-tag-switch-keeps-tool-search-paired', `${SRC}:13`, { history: nativePairHistory }, () => {
  const history = structuredClone(nativePairHistory);
  const oauth = _convertMessagesToResponsesInputForTest(history, { nativeToolSearchProvider: 'openai-oauth' });
  history[1].nativeToolSearch.provider = 'openai-oauth';
  const direct = _convertMessagesToResponsesInputForTest(history, { nativeToolSearchProvider: 'openai' });
  return { oauth, direct };
});
const auth = { type: 'openai-direct', apiKey: 'k' };
await rec.run('http-sse-max-output-cutoff-with-call-in-flight', `${SRC}:48`, {}, () => sse({ auth, body: { model: 'gpt', tools: [] }, useModel: 'gpt' }, [
  { type: 'response.created', response: { id: 'r', model: 'gpt' } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', name: 'read', call_id: 'fc_1' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fi_1', delta: '{"path":' },
  { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
]));
await rec.run('http-sse-completed-call-then-cutoff-is-clean-length', `${SRC}:76`, {}, () => sse({ auth, body: { model: 'gpt', tools: [] }, useModel: 'gpt' }, [
  { type: 'response.created', response: { id: 'r', model: 'gpt' } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', name: 'read', call_id: 'fc_1' } },
  { type: 'response.function_call_arguments.done', item_id: 'fi_1', arguments: '{"path":"a"}' },
  { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_1', call_id: 'fc_1', name: 'read', arguments: '{"path":"a"}' } },
  { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
]));
await rec.run('request-mixed-custom-patch-function-shell-batch', `${SRC}:100`, { tools: ['PATCH_TOOL_DEFS[0]', 'BUILTIN_TOOLS shell'] }, () => {
  const shellTool = BUILTIN_TOOLS.find((tool) => tool.name === 'shell');
  const body = buildRequestBody([{ role: 'user', content: 'patch then verify' }], 'gpt-5.6-sol', [PATCH_TOOL_DEFS[0], shellTool], {});
  const shell = body.tools.find((tool) => tool.name === 'shell');
  return { body, shellDescriptionMentionsVerificationOrPowerShell: /verification|PowerShell:/i.test(shell.description) };
});
const encrypted = { type: 'reasoning', id: 'rs_replay_1', encrypted_content: 'opaque-reasoning', summary: [] };
const replayHistory = [
  { role: 'user', content: 'inspect it' },
  { role: 'assistant', content: '', reasoningItems: [encrypted], toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }] },
  { role: 'tool', toolCallId: 'call_1', content: 'contents' },
];
await rec.run('reasoning-replay-default-on-and-kill-switch', `${SRC}:117`, { history: replayHistory }, () => {
  const out = {
    defaultInput: _convertMessagesToResponsesInputForTest(replayHistory),
    replayInput: _convertMessagesToResponsesInputForTest(replayHistory, { replayEncryptedReasoning: true }),
    defaultBody: buildRequestBody(replayHistory, 'gpt-5.6-sol', [], {}),
  };
  process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY = '1';
  try {
    out.killedBody = buildRequestBody(replayHistory, 'gpt-5.6-sol', [], { replayEncryptedReasoning: true });
  } finally {
    delete process.env.MIXDOG_OAI_DISABLE_REASONING_REPLAY;
  }
  return out;
});
const standardHistory = [{ role: 'system', content: 'stable instructions' }, { role: 'system', content: 'session environment', cacheTier: 'env' }, { role: 'user', content: 'hello' }];
await rec.run('always-standard-responses-payload', `${SRC}:175`, { history: standardHistory }, () => ({
  body: buildRequestBody(standardHistory, 'gpt-5.6-sol', [{ name: 'read', description: 'read a file', inputSchema: { type: 'object' } }], { turnId: '019fc135-f07a-7880-8767-ec3b7be1de64' }),
}));
await rec.run('http-sse-stateless-omits-anchor-headers', `${SRC}:199`, { opts: { statelessConversation: true }, cacheKey: 'stable-cache-key' }, async () => {
  const o = await sse({ auth: { access_token: 'token', account_id: 'account' }, body: { model: 'gpt-5.6-sol', tools: [] }, opts: { statelessConversation: true }, cacheKey: 'stable-cache-key', useModel: 'gpt-5.6-sol' }, [
    { type: 'response.created', response: { id: 'r', model: 'gpt-5.6-sol' } }, { type: 'response.completed', response: { id: 'r', model: 'gpt-5.6-sol', output: [] } },
  ]);
  return o;
});
const rawPatch = '*** Begin Patch\n*** Add File: mixed.txt\n+ok\n*** End Patch\n';
await rec.run('http-sse-mixed-custom-function-call-order', `${SRC}:220`, { rawPatch }, async () => {
  const emitted = [];
  const out = await sse({ auth, body: { model: 'gpt', tools: [{ name: 'apply_patch' }, { name: 'shell' }] }, useModel: 'gpt' }, [
    { type: 'response.created', response: { id: 'r', model: 'gpt' } },
    { type: 'response.output_item.added', item: { type: 'custom_tool_call', id: 'ci_1', call_id: 'cp_1', name: 'apply_patch' } },
    { type: 'response.custom_tool_call_input.delta', item_id: 'ci_1', delta: rawPatch },
    { type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'ci_1', call_id: 'cp_1', name: 'apply_patch', input: rawPatch } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fi_1', call_id: 'fs_1', name: 'shell' } },
    { type: 'response.function_call_arguments.done', item_id: 'fi_1', arguments: '{"command":"npm test"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'fi_1', call_id: 'fs_1', name: 'shell', arguments: '{"command":"npm test"}' } },
    { type: 'response.completed', response: { id: 'r', model: 'gpt', output: [] } },
  ], (call) => emitted.push(call));
  return { ...out, emitted };
});
const loadTool = { name: 'load_tool', description: 'load tools', inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } } } };
const loadHistory = [
  { role: 'system', content: 'sys' }, { role: 'user', content: 'load a tool' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_load_1', name: 'tool_search', arguments: { names: ['read'] }, nativeType: 'tool_search_call' }] },
  { role: 'tool', toolCallId: 'call_load_1', content: 'Loaded deferred tools: read', nativeToolSearch: { provider: 'openai-oauth', toolReferences: ['read'], openaiTools: [{ type: 'function', name: 'read', description: 'read', defer_loading: true, parameters: { type: 'object', properties: {} } }] } },
];
await rec.run('load-tool-native-tool-search-history', `${SRC}:266`, { history: loadHistory, tools: [loadTool], model: 'gpt-5.5' }, () => ({ body: buildRequestBody(loadHistory, 'gpt-5.5', [loadTool], {}) }));
await rec.run('custom-tool-call-item-to-canonical-call', `${SRC}:344`, {}, () => ({
  call: customToolCallFromResponseItem({ type: 'custom_tool_call', call_id: 'ctc_1', name: 'apply_patch', input: '*** patch ***' }),
  functionCall: customToolCallFromResponseItem({ type: 'function_call' }),
  nullItem: customToolCallFromResponseItem(null),
}));
await rec.finish();
