#!/usr/bin/env node
// opencode-go-gemini.test.mjs (4 cases): the real OpenCodeGoProvider sends a Gemini model over a scripted generateContent endpoint
// (fetch redirected; the request is recorded as it arrived), plus the Chat content/cache_control lowering and the Mistral/Groq tool_choice.
//   node benchmarks/rust-core/recorders/record-opencode-go-gemini.mjs --tree <exact export of b6f10295a>
import { sseBody, startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-opencode-go-gemini',
  entry: 'opencode-go.mjs OpenCodeGoProvider({ apiKey, preconnect: false [, baseURL] }).resolveWireRoute / .send over a loopback endpoint (no fetchImpl injected: the product\'s own fetch); openai-compat-wire.mjs toOpenAIMessages; compat-request-policy.mjs applyCompatToolChoice.',
  compare: 'mixdog-ai providers::compat (profile.rs Wire::Gemini, adapter.rs, chat/options.rs:243-246, encode.rs): compare `result`, the request sent (method, origin, path, every header, body) and the pure lowerings.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::compat::CompatAdapter (compat/adapter.rs:63) with CompatChatCodec (compat/chat/mod.rs:96) / CompatResponsesCodec (compat/responses.rs:75), body builder build_body (compat/chat/encode.rs:372), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079). The Gemini wire for OpenCode Go does not exist on the send path (K1 G1): work for the Rust side.",
});
const P = 'agent/orchestrator/providers/';
const { OpenCodeGoProvider } = await rec.P(`${P}opencode-go.mjs`);
const { applyCompatToolChoice } = await rec.P(`${P}compat-request-policy.mjs`);
const { toOpenAIMessages } = await rec.P(`${P}openai-compat-wire.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/opencode-go-gemini.test.mjs';
const geminiReply = (usage) => () => ({
  status: 200,
  contentType: 'text/event-stream',
  body: sseBody([{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], ...(usage ? { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 } } : {}) }]),
});

await rec.run('gemini-to-generateContent-with-go-key', `${SRC}:9`, { model: 'gemini-4-argon-contributor' }, async ({ net }) => {
  net.reply = geminiReply(true);
  const provider = new OpenCodeGoProvider({ apiKey: 'go-key', preconnect: false });
  const route = await provider.resolveWireRoute('gemini-4-argon-contributor', { agent: true });
  const result = await provider.send([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], 'gemini-4-argon-contributor', [], { sessionId: 's1' });
  return { route, result };
});
await rec.run('org-config-chat-base-ignored', `${SRC}:45`, { baseURL: 'https://opencode.ai/inference/go/openai/v1' }, async ({ net }) => {
  net.reply = geminiReply(false);
  const provider = new OpenCodeGoProvider({ apiKey: 'tok', preconnect: false, baseURL: 'https://opencode.ai/inference/go/openai/v1' });
  return { result: await provider.send([{ role: 'user', content: 'hi' }], 'gemini-4-argon', [], { sessionId: 's1' }) };
});
const content = [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }];
await rec.run('chat-content-cache-control', `${SRC}:62`, { content }, () => ({
  openrouter: toOpenAIMessages([{ role: 'user', content }], 'openrouter', { cacheControl: true }),
  deepseek: toOpenAIMessages([{ role: 'user', content }], 'deepseek', {}),
}));
await rec.run('mistral-groq-tool-choice', `${SRC}:70`, { hosts: ['https://api.mistral.ai/v1', 'https://api.groq.com/openai/v1'] }, () =>
  Object.fromEntries(['https://api.mistral.ai/v1', 'https://api.groq.com/openai/v1'].map((baseURL) => [baseURL, applyCompatToolChoice({ tools: [{}] }, { toolChoice: 'required', parallelToolCalls: false }, { provider: 'custom-x', baseURL, wire: 'chat' })])));
await rec.finish();
