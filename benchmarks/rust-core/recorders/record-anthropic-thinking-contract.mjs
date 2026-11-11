#!/usr/bin/env node
// anthropic-thinking-contract.test.mjs (2 cases): the real `applyAnthropicEffortToBody` (adaptive-only models reject a manual budget)
// and the real OAuth request-body builder for Mythos 5.1 with an empty model catalog.
//   node benchmarks/rust-core/recorders/record-anthropic-thinking-contract.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-anthropic-thinking-contract',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/anthropic-effort.mjs applyAnthropicEffortToBody(body, { model, opts, maxTokens, clampThinkingBudgetTokens }) and anthropic-oauth.mjs _buildRequestBodyForCacheSmoke(history, model, [], { effort }) after setModelEffortCapabilities([]). Not run: a send.',
  compare: 'mixdog-core run_host/builder_env.rs (adaptive-only generation floor, :197-224) and mixdog-ai providers::anthropic body.rs (:670-684): the refusal text per model id and the whole request `body` per model/effort.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::anthropic::AnthropicAdapter (anthropic/adapter.rs:169) and AnthropicCodec (anthropic/codec.rs:148), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079), built by mixdog_ai::registry DefaultProviderBuilder::build (registry/builder.rs:1295). The adaptive-only floor (`manual_thinking`, `adaptive_thinking`, effort levels per model id with an empty catalog) is mixdog_core::run_host::builder_env::CatalogCaps::new(..).caps(model) (run_host/builder_env.rs:184, pub; module `pub mod run_host` lib.rs:1): replay `caps(model)` for the floor per model id; the refusal of a manual budget and the request body are produced by the codec (anthropic/body.rs:656, :690 inside AnthropicCodec, reached through the adapter above).",
});
const { applyAnthropicEffortToBody, setModelEffortCapabilities } = await rec.P('agent/orchestrator/providers/anthropic-effort.mjs');
const { clampAnthropicThinkingBudget } = await rec.P('agent/orchestrator/providers/lib/anthropic-request-utils.mjs');
const { _buildRequestBodyForCacheSmoke } = await rec.P('agent/orchestrator/providers/anthropic-oauth.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/anthropic-thinking-contract.test.mjs';

for (const model of ['claude-fable-5-1', 'claude-fable-5.1-20260901', 'claude-mythos-5-1', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5']) {
  const opts = { thinkingBudgetTokens: 4096, effort: 'high' };
  await rec.run(`adaptive-only-rejects-manual-budget:${model}`, `${SRC}:7`, { model, opts, maxTokens: 128000 }, () => {
    const body = { model };
    let error = null;
    try {
      applyAnthropicEffortToBody(body, { model, opts, maxTokens: 128000, clampThinkingBudgetTokens: clampAnthropicThinkingBudget });
    } catch (e) {
      error = e;
    }
    return { threw: error, bodyAfter: body };
  });
}
for (const model of ['claude-mythos-5-1', 'claude-mythos-5.1-20260901']) {
  for (const effort of ['low', 'high', 'xhigh', 'max']) {
    await rec.run(`mythos-adaptive-no-catalog:${model}:${effort}`, `${SRC}:32`, { model, effort, history: [{ role: 'user', content: 'Hello.' }] }, () => {
      setModelEffortCapabilities([]);
      return { body: _buildRequestBodyForCacheSmoke([{ role: 'user', content: 'Hello.' }], model, [], { effort }) };
    });
  }
}
await rec.finish();
