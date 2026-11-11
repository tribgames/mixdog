#!/usr/bin/env node
// session/manager/provider-replay.test.mjs (4 cases): the real `stripProviderReplayMessages` over one live turn per source provider, then
// the real request lowerings of the target providers (Responses input, Anthropic messages, Gemini contents).
//   node benchmarks/rust-core/recorders/record-session-provider-replay.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-session-provider-replay',
  pure: { 'strip-keeps-messages-order-no-native-state': 'mixdog-agent/src/recovery.rs:271 strip_provider_replay_messages(&[Message]) -> Vec<Message> (pub fn; `pub mod recovery` at mixdog-agent/src/lib.rs:32; per message :253 strip_provider_replay)' },
  entry: 'session/manager/provider-replay.mjs stripProviderReplayMessages(history) (pure); the target lowerings through the real senders to the loopback endpoint: openai-oauth.mjs buildRequestBody + openai-oauth-http-sse.mjs sendViaHttpSse, anthropic.mjs AnthropicProvider.send, gemini.mjs GeminiProvider.send. lib/provider-replay.mjs createProviderReplay builds the native replay state of the scripted turns.',
  compare: 'PURE strip case: feed `input.turns` to the public strip_provider_replay_messages and compare `stripped` whole (messages, order, no native replay state). WIRE cases: send the stripped history through the Rust sender of the target provider to a loopback endpoint and compare the request as it arrived (body bytes, headers in order) in `requests`.',
  replay: "PURE: mixdog-agent/src/recovery.rs:271 strip_provider_replay_messages (pub). WIRE: the provider sends through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) with the adapters AnthropicAdapter (anthropic/adapter.rs:169), OpenAiAdapter (openai/adapter.rs:308), GoogleAdapter (google/adapter.rs:53) against a loopback endpoint.",
});
const { stripProviderReplayMessages } = await rec.P('agent/orchestrator/session/manager/provider-replay.mjs');
const { createProviderReplay } = await rec.P('agent/orchestrator/providers/lib/provider-replay.mjs');
const { buildRequestBody } = await rec.P('agent/orchestrator/providers/openai-oauth.mjs');
const { sendViaHttpSse } = await rec.P('agent/orchestrator/providers/openai-oauth-http-sse.mjs');
const { AnthropicProvider } = await rec.P('agent/orchestrator/providers/anthropic.mjs');
const { GeminiProvider } = await rec.P('agent/orchestrator/providers/gemini.mjs');
const SRC = 'src/runtime/agent/orchestrator/session/manager/provider-replay.test.mjs';

const call = (id, extra = {}) => ({ id, name: 'read', arguments: { path: 'a.txt' }, ...extra });
const result = (id) => ({ role: 'tool', toolCallId: id, content: 'file body' });
const prompt = { role: 'user', content: 'read a.txt then summarize' };
const anthropicTurn = () => {
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'anthropic-sig' };
  const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } };
  return [prompt, { role: 'assistant', content: '', toolCalls: [call('toolu_1')], thinkingBlocks: [thinking], assistantBlocks: [thinking, toolUse], providerReplay: createProviderReplay('anthropic', [thinking, toolUse]) }, result('toolu_1')];
};
const openaiTurn = () => {
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'openai-enc', summary: [] };
  const fn = { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' };
  return [prompt, { role: 'assistant', content: '', toolCalls: [call('call_1')], reasoningItems: [reasoning], reasoningContent: 'plan', providerReplay: createProviderReplay('openai-responses', [reasoning, fn]) }, result('call_1')];
};
const geminiTurn = () => [prompt, { role: 'assistant', content: '', toolCalls: [call('gem_1', { thoughtSignature: 'gemini-real-sig' })] }, result('gem_1')];

await rec.run('strip-keeps-messages-order-no-native-state', `${SRC}:55`, { turns: { anthropic: anthropicTurn(), openai: openaiTurn(), gemini: geminiTurn() } }, () => {
  const out = {};
  for (const [name, turn] of [['anthropic', anthropicTurn()], ['openai', openaiTurn()], ['gemini', geminiTurn()]]) {
    const before = JSON.stringify(turn);
    out[name] = { stripped: stripProviderReplayMessages(turn), sourceUntouched: JSON.stringify(turn) === before };
  }
  return out;
});
// The target lowerings are WIRE level: the stripped history is sent through the real sender of each target provider to the loopback endpoint and the request that arrived (body bytes,
// every header in order) is recorded in `requests`.
const TOOLS = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const sseJson = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
const toOpenAI = async (history) => {
  rec.net.reply = () => ({ status: 200, contentType: 'text/event-stream', chunks: sseJson([{ type: 'response.created', response: { id: 'r', model: 'gpt-5.5' } }, { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', output: [] } }]) });
  return sendViaHttpSse({ auth: { type: 'openai-direct', apiKey: 'k' }, body: buildRequestBody(history, 'gpt-5.5', TOOLS, {}), useModel: 'gpt-5.5' });
};
const toAnthropic = async (history) => {
  rec.net.reply = () => ({ status: 200, contentType: 'text/event-stream', chunks: sseJson([{ type: 'message_start', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]) });
  return new AnthropicProvider({ apiKey: 'fixture-key' }).send(history, 'claude-sonnet-5', TOOLS, {});
};
const toGemini = async (history) => {
  rec.net.reply = () => ({ status: 200, contentType: 'text/event-stream', chunks: [`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`] });
  return new GeminiProvider({ apiKey: 'fixture-key' }).send(history, 'gemini-3-pro', TOOLS, {});
};
await rec.run('anthropic-to-openai-plain-pair', `${SRC}:69`, { turn: anthropicTurn() }, async () => ({ sent: await toOpenAI(stripProviderReplayMessages(anthropicTurn())) }));
await rec.run('openai-to-anthropic-tool-pair', `${SRC}:83`, { turn: openaiTurn() }, async () => ({ sent: await toAnthropic(stripProviderReplayMessages(openaiTurn())) }));
await rec.run('gemini-signature-never-crosses-account', `${SRC}:100`, { gemini: geminiTurn(), anthropic: anthropicTurn() }, async () => {
  const stripped = stripProviderReplayMessages(geminiTurn());
  return {
    geminiToAnthropic: await toAnthropic(stripped),
    geminiToGemini: await toGemini(stripped),
    anthropicToGemini: await toGemini(stripProviderReplayMessages(anthropicTurn())),
  };
});
await rec.finish();
