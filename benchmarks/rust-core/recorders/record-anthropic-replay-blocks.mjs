#!/usr/bin/env node
// anthropic-replay-blocks.test.mjs (9 cases): the real replay-block reducers over scripted block lists. The case that asserts the
// removal reporter (`onDrop` kinds) is recorded too; the Rust port has no reporter (K1 gaps-providers row 28), so a replay compares
// `blocks` and notes `drops`.
//   node benchmarks/rust-core/recorders/record-anthropic-replay-blocks.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-anthropic-replay-blocks',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/lib/anthropic-replay-blocks.mjs sanitizeAnthropicReplayBlocks(blocks, onDrop), sanitizeAnthropicReplayEntries([[index, block]]), sanitizeAnthropicThinkingRun(blocks).',
  compare: 'mixdog-ai providers::anthropic decoder (decoder.rs:259-313 replay reduction): feed `input` and compare `result.blocks` whole; `result.drops` (the removal kinds, in order) has no Rust counterpart.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::anthropic::AnthropicAdapter (anthropic/adapter.rs:169) and AnthropicCodec (anthropic/codec.rs:148), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079), built by mixdog_ai::registry DefaultProviderBuilder::build (registry/builder.rs:1295).",
});
const { sanitizeAnthropicReplayBlocks, sanitizeAnthropicReplayEntries, sanitizeAnthropicThinkingRun } = await rec.P('agent/orchestrator/providers/lib/anthropic-replay-blocks.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/lib/anthropic-replay-blocks.test.mjs';
const thinking = (signature) => ({ type: 'thinking', thinking: '', signature });
const text = (value) => ({ type: 'text', text: value });
const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } };
const reduce = (blocks) => {
  const drops = [];
  return { blocks: sanitizeAnthropicReplayBlocks(blocks, (kind) => drops.push(kind)), drops };
};
const lists = [
  ['empty-text-dropped', 14, [text(''), text('answer'), toolUse]],
  ['separator-keeps-runs-apart', 19, [thinking('sig-a'), text(''), thinking('sig-b'), text('answer'), toolUse]],
  ['back-to-back-thinking-kept', 30, [thinking('sig-a'), thinking('sig-b'), text('answer')]],
  ['real-text-keeps-both-runs', 35, [thinking('sig-a'), text('mid'), thinking('sig-b'), text('answer')]],
  ['redacted-thinking-run-rule', 40, [thinking('sig-a'), text(''), { type: 'redacted_thinking', data: 'opaque' }, text('answer')]],
  ['removals-reported', 48, [thinking('sig-a'), text(''), thinking('sig-b')]],
];
for (const [id, line, blocks] of lists) await rec.run(id, `${SRC}:${line}`, blocks, () => reduce(blocks));
const entries = [[4, toolUse], [0, thinking('sig-a')], [3, text('answer')], [1, text('')], [2, thinking('sig-b')]];
await rec.run('entries-in-block-order', `${SRC}:54`, entries, () => ({ blocks: sanitizeAnthropicReplayEntries(entries) }));
const run = [thinking('sig-a'), text(''), thinking('sig-b'), toolUse];
await rec.run('flattened-thinking-projection', `${SRC}:65`, run, () => ({ blocks: sanitizeAnthropicThinkingRun(run) }));
const again = [thinking('sig-a'), text(''), thinking('sig-b')];
await rec.run('idempotent', `${SRC}:71`, again, () => {
  const once = sanitizeAnthropicReplayBlocks(again);
  return { once, twice: sanitizeAnthropicReplayBlocks(once) };
});
await rec.finish();
