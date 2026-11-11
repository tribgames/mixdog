#!/usr/bin/env node
// deepseek-replay.test.mjs (2 cases): the real compat chat stream collector over a scripted chunk list, and the real DeepSeek
// provider driven by the real `agentLoop` over a scripted Chat endpoint (a tool call with empty reasoning_content, then a text
// turn): the two requests it sent, the committed message, the result and the replayed messages.
//   node benchmarks/rust-core/recorders/record-deepseek-replay.mjs --tree <exact export of b6f10295a>
import { sseBody, startRecording, stream } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-deepseek-replay',
  entry: 'openai-compat-stream.mjs consumeCompatChatCompletionStream(chunks, { label, parseToolCalls, knownToolNames }); OpenAICompatProvider("deepseek", { apiKey, preconnect: false }) driven by session/agent-loop.mjs agentLoop over a loopback Chat endpoint (the OpenAI SDK sends real HTTP); openai-compat-wire.mjs toOpenAIMessages. Not run: a live endpoint.',
  compare: 'mixdog-ai providers::compat chat decode (decode.rs:286-292, :530-537) and encode: feed `input.chunks` / the `requests[*].reply` SSE and compare `result` (reasoningContent and whether reasoning_content is present), the second request body (assistant message reasoning_content "") and the replayed messages.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::compat::CompatAdapter (compat/adapter.rs:63) with CompatChatCodec (compat/chat/mod.rs:96) / CompatResponsesCodec (compat/responses.rs:75), body builder build_body (compat/chat/encode.rs:372), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const P = 'agent/orchestrator/providers/';
const { OpenAICompatProvider, parseToolCalls } = await rec.P(`${P}openai-compat.mjs`);
const { consumeCompatChatCompletionStream } = await rec.P(`${P}openai-compat-stream.mjs`);
const { toOpenAIMessages } = await rec.P(`${P}openai-compat-wire.mjs`);
const { agentLoop } = await rec.P('agent/orchestrator/session/agent-loop.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/deepseek-replay.test.mjs';

for (const reasoning of ['', null]) {
  const input = [{ choices: [{ delta: { content: 'answer', ...(reasoning !== null ? { reasoning_content: reasoning } : {}) }, finish_reason: 'stop' }] }];
  await rec.run(`empty-vs-absent-reasoning:${reasoning === null ? 'absent' : 'empty'}`, `${SRC}:12`, { chunks: input }, async () => {
    const result = await consumeCompatChatCompletionStream(stream(input), { label: 'fixture', parseToolCalls, knownToolNames: new Set() });
    return { result, messageHasReasoningContent: Object.hasOwn(result.response.choices[0].message, 'reasoning_content') };
  });
}

const first = [{ model: 'deepseek-v4-pro', choices: [{ delta: { role: 'assistant', reasoning_content: '', tool_calls: [{ index: 0, id: 'call_empty', type: 'function', function: { name: 'missing_fixture_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }];
const second = [{ model: 'deepseek-v4-pro', choices: [{ delta: { content: 'done', reasoning_content: '' }, finish_reason: 'stop' }] }];
await rec.run('empty-reasoning-through-tool-history', `${SRC}:32`, { replies: [first, second] }, async ({ net }) => {
  const provider = new OpenAICompatProvider('deepseek', { apiKey: 'fixture', preconnect: false });
  net.reply = (_req, n) => ({ status: 200, contentType: 'text/event-stream', body: `${sseBody(n === 1 ? first : second)}data: [DONE]\n\n` });
  const history = [{ role: 'user', content: 'Check.' }];
  const committed = [];
  const result = await agentLoop(provider, history, 'deepseek-v4-pro', [], null, process.cwd(), {
    session: { id: 'empty-reasoning-fixture', owner: 'agent', agent: 'worker', contextWindow: 200000, rawContextWindow: 200000, compaction: { auto: false } },
    onAssistantMessageCommitted: (message) => committed.push(message),
  });
  const persisted = JSON.parse(JSON.stringify([...history, { role: 'assistant', content: result.content, reasoningContent: result.reasoningContent }]));
  return {
    result,
    committed,
    committedHasReasoningContent: Object.hasOwn(committed[0], 'reasoningContent'),
    replayDeepseek: toOpenAIMessages(persisted, 'deepseek', { replaysReasoningContent: true }),
    replayOpenrouter: toOpenAIMessages(persisted, 'openrouter'),
  };
});
await rec.finish();
