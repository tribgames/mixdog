#!/usr/bin/env node
// gemini-history-signatures.test.mjs (5 cases): the real `toGeminiContents` (Gemini REST) and `buildAntigravityRequest` over
// the same histories; the recorded contents are what a Rust request builder must produce.
//   node benchmarks/rust-core/recorders/record-gemini-history-signatures.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-gemini-history-signatures',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/gemini-schema.mjs toGeminiContents(history, model) and antigravity-request.mjs buildAntigravityRequest(history, model, [], {}, "fixture").request.contents, plus lib/provider-replay.mjs createProviderReplay for the native-replay cases. Not run: any send, network or cache.',
  compare: 'mixdog-ai providers::google request builder (request.rs history lowering, signature repair at request.rs:302-327): feed `input.history` (and `input.providerReplay`) and compare `result` (the `contents` / model parts) whole; the history after the call equals `input.history` (the call does not mutate it).',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::google::GoogleAdapter (google/adapter.rs:53), GoogleCodec (google/codec.rs:63) and build_request (google/request.rs:446), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const P = 'agent/orchestrator/providers/';
const { toGeminiContents } = await rec.P(`${P}gemini-schema.mjs`);
const { buildAntigravityRequest } = await rec.P(`${P}antigravity-request.mjs`);
const { createProviderReplay } = await rec.P(`${P}lib/provider-replay.mjs`);

const foreignHistory = () => [
  { role: 'user', content: 'Read both files.' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'read', arguments: { path: 'a' } }, { id: 'call_b', name: 'read', arguments: { path: 'b' } }] },
  { role: 'tool', toolCallId: 'call_a', content: 'a' },
  { role: 'tool', toolCallId: 'call_b', content: 'b' },
];
const agy = (history, model) => buildAntigravityRequest(history, model, [], {}, 'fixture').request.contents;
const NEW_TURN = { role: 'user', content: 'New turn.' };
const SRC = 'src/runtime/agent/orchestrator/providers/gemini-history-signatures.test.mjs';

await rec.run('first-foreign-call-repaired', `${SRC}:23`, { history: foreignHistory() }, () => {
  const history = foreignHistory();
  const contents = { gemini: toGeminiContents(history, 'gemini-3.1-pro'), antigravity: agy(history, 'gemini-3.1-pro-high') };
  return { contents, historyAfter: history };
});
await rec.run('native-signatures-unchanged', `${SRC}:43`, { history: foreignHistory() }, () => {
  const history = foreignHistory();
  const parts = [{ functionCall: { name: 'read', args: { path: 'a' } }, thoughtSignature: 'native-signature' }, { functionCall: { name: 'read', args: { path: 'b' } } }];
  history[1].providerReplay = createProviderReplay('gemini', parts);
  const camel = toGeminiContents(history, 'gemini-3.1-pro').find((c) => c.role === 'model').parts;
  const snake = structuredClone(parts);
  snake[0].thought_signature = snake[0].thoughtSignature;
  delete snake[0].thoughtSignature;
  history[1].providerReplay = createProviderReplay('gemini', snake);
  const snakeOut = toGeminiContents(history, 'gemini-3.1-pro').find((c) => c.role === 'model').parts;
  return { replayParts: parts, camelOut: camel, snakeParts: snake, snakeOut };
});
await rec.run('earlier-turns-and-non-gemini-untouched', `${SRC}:62`, { history: foreignHistory(), newTurn: NEW_TURN }, () => {
  const history = foreignHistory();
  return {
    claudeModel: toGeminiContents(history, 'claude-opus-4-6-thinking'),
    geminiNewTurn: toGeminiContents([...history, NEW_TURN], 'gemini-3.1-pro'),
    antigravityNewTurn: agy([...history, NEW_TURN], 'gemini-3.1-pro-high'),
  };
});
await rec.run('any-gemini-id', `${SRC}:79`, { models: ['gemini-2.5-pro', 'gemini-4-argon', 'models/gemini-12-future'] }, () =>
  Object.fromEntries(['gemini-2.5-pro', 'gemini-4-argon', 'models/gemini-12-future'].map((m) => [m, toGeminiContents(foreignHistory(), m)]))
);
await rec.run('sequential-steps-signed', `${SRC}:89`, {}, () => {
  const history = foreignHistory();
  history.push({ role: 'assistant', content: '', toolCalls: [{ id: 'call_c', name: 'read', arguments: { path: 'c' } }] }, { role: 'tool', toolCallId: 'call_c', content: 'c' });
  return { history, contents: toGeminiContents(history, 'gemini-3.1-pro') };
});
await rec.finish();
