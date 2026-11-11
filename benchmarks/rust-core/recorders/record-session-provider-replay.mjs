#!/usr/bin/env node
// session/manager/provider-replay.test.mjs (4 cases): the real `stripProviderReplayMessages` over one live turn per source provider, then
// the real request lowerings of the target providers (Responses input, Anthropic messages, Gemini contents).
//   node benchmarks/rust-core/recorders/record-session-provider-replay.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-session-provider-replay',
  net: false,
  entry: 'session/manager/provider-replay.mjs stripProviderReplayMessages(history); openai-responses-input.mjs convertMessagesToResponsesInput(history, { replayEncryptedReasoning: true }); lib/anthropic-request-utils.mjs toAnthropicMessages(history, [{ name: "read" }], "anthropic"); gemini-schema.mjs toGeminiContents(history, "gemini-3-pro"). lib/provider-replay.mjs createProviderReplay builds the native state of the scripted turns.',
  replay: 'mixdog-core-api domain/provider.rs replay_for (:197-204), mixdog-ai providers::{openai input.rs, anthropic body.rs, google request.rs}: feed `input.turns` (messages with their native replay state) and compare `stripped` and each target lowering whole.',
});
const { stripProviderReplayMessages } = await rec.P('agent/orchestrator/session/manager/provider-replay.mjs');
const { createProviderReplay } = await rec.P('agent/orchestrator/providers/lib/provider-replay.mjs');
const { toAnthropicMessages } = await rec.P('agent/orchestrator/providers/lib/anthropic-request-utils.mjs');
const { convertMessagesToResponsesInput } = await rec.P('agent/orchestrator/providers/openai-responses-input.mjs');
const { toGeminiContents } = await rec.P('agent/orchestrator/providers/gemini-schema.mjs');
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
await rec.run('anthropic-to-openai-plain-pair', `${SRC}:69`, { turn: anthropicTurn() }, () => ({ input: convertMessagesToResponsesInput(stripProviderReplayMessages(anthropicTurn()), { replayEncryptedReasoning: true }) }));
await rec.run('openai-to-anthropic-tool-pair', `${SRC}:83`, { turn: openaiTurn() }, () => ({ messages: toAnthropicMessages(stripProviderReplayMessages(openaiTurn()), [{ name: 'read' }], 'anthropic') }));
await rec.run('gemini-signature-never-crosses-account', `${SRC}:100`, { gemini: geminiTurn(), anthropic: anthropicTurn() }, () => {
  const stripped = stripProviderReplayMessages(geminiTurn());
  return {
    geminiToAnthropic: toAnthropicMessages(stripped, [{ name: 'read' }], 'anthropic'),
    geminiToGemini: toGeminiContents(stripped, 'gemini-3-pro'),
    anthropicToGemini: toGeminiContents(stripProviderReplayMessages(anthropicTurn()), 'gemini-3-pro'),
  };
});
await rec.finish();
