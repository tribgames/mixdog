#!/usr/bin/env node
// model-recency.test.mjs (4 tests): the real `providerModelCacheRow(provider, row, isHidden)` (the model-picker cache row) over scripted
// catalog rows.
//   node benchmarks/rust-core/recorders/record-model-recency.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-model-recency',
  net: false,
  entry: 'src/session-runtime/model-recency.mjs providerModelCacheRow(provider, { id: "m", ...row }, () => false). The visibility callback is `() => false` as in the test.',
  replay: 'mixdog-ai service::admin_models provider_model_cache_row (admin_models.rs:306): feed `input` and compare the whole `result` row (absent keys stay absent; undefined is dropped by JSON).',
});
const { providerModelCacheRow } = await rec.load('src/session-runtime/model-recency.mjs');
const SRC = 'src/session-runtime/model-recency.test.mjs';
const row = (provider, model) => providerModelCacheRow(provider, { id: 'm', ...model }, () => false);
const windows = (provider, model) => ({ row: row(provider, model) });
const cases = [
  ['window-range-default', 11, [['anthropic-oauth', { contextWindow: 1_000_000 }], ['gemini', { contextWindow: 1_048_576 }]]],
  ['window-left-as-stated', 24, [['grok-oauth', { contextWindow: 256_000 }], ['openai-oauth', { contextWindow: 272_000, maxContextWindow: 872_000 }], ['mixdog-local', { contextWindow: 1_000_000 }], ['fixture', {}]]],
];
for (const [id, line, inputs] of cases) await rec.run(id, `${SRC}:${line}`, inputs, () => inputs.map(([provider, model]) => ({ provider, ...windows(provider, model) })));
const customReasoning = { wireFormat: 'deepseek', wireValues: { high: 'max' }, replay: true };
const customRow = { id: 'm', name: 'Model', hidden: false, manual: true, supportsReasoning: false, reasoningLevels: [], customReasoning, reasoningContentField: 'reasoning_content' };
await rec.run('custom-row-effective-fields', `${SRC}:46`, { provider: 'custom-1', row: customRow }, () => ({
  row: providerModelCacheRow('custom-1', customRow, () => false),
  hiddenOnly: providerModelCacheRow('custom-1', { id: 'm', hidden: true }, () => false),
}));
await rec.run('first-party-row-unchanged-by-custom-fields', `${SRC}:69`, {}, () => ({
  row: providerModelCacheRow('openai', { id: 'm', name: 'M', hidden: true, manual: true }, () => false),
  bare: providerModelCacheRow('openai', { id: 'm' }, () => false),
}));
await rec.finish();
