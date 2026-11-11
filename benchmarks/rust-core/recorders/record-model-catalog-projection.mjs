#!/usr/bin/env node
// model-catalog-projection.test.mjs (7 tests): the real models.dev / LiteLLM catalog projections and the model-list sanitizer over a
// scripted catalog. The test derives its release dates from wall-clock now; the recorder derives them from the virtual clock
// (RECENT = first of the clock's month, OLD = two years earlier), so the recorded sanitizer verdict is the same on every run.
//   node benchmarks/rust-core/recorders/record-model-catalog-projection.mjs --tree <exact export of b6f10295a>
import { T0, startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  pure: {
    'sanitizer-*': 'mixdog-ai/src/catalog/sanitize.rs sanitize_model_list (pub, re-exported at catalog/mod.rs:70) with SanitizeContext (mod.rs:69)',
    '*': 'RUST WORK: project_models_dev (catalog/lookup/projection.rs:158) and project_litellm (:98) exist and match, but `mod lookup` is private (catalog/mod.rs:12) and only seed_display_name / seed_roster are re-exported (mod.rs:33-34): add `pub use lookup::{project_models_dev, project_litellm};` to catalog/mod.rs. Looked for a public path: catalog::ModelsDev / ModelsDevSource (mod.rs:35, :38) load and cache the catalog but do not expose the projection as a function',
  },
  set: 'provider-model-catalog-projection',
  net: false,
  entry: 'model-catalog-projection.mjs projectModelsDevCatalog(catalog) / projectLitellmCatalog(catalog) and model-list-sanitize.mjs sanitizeModelList(models, { provider, _testCatalog }). Not run: a catalog fetch.',
  compare: 'mixdog-ai catalog::lookup projection (projection.rs:98, :158): feed `input.source` (the published payload) and compare the projected `result` whole, key presence included; the sanitizer verdict (`survivors`) is the same with the full and the projected catalog.',
  replay: "PURE. Projection cases: Rust work - mixdog-ai/src/catalog/lookup/projection.rs:158 project_models_dev and :98 project_litellm have the recorded input and output but are not public (`mod lookup`, catalog/mod.rs:12; make them reachable with `pub use lookup::{project_models_dev, project_litellm}` in catalog/mod.rs). Sanitizer case: mixdog-ai/src/catalog/sanitize.rs sanitize_model_list (pub, catalog/mod.rs:70).",
});
const { projectLitellmCatalog, projectModelsDevCatalog } = await rec.P('agent/orchestrator/providers/model-catalog-projection.mjs');
const { sanitizeModelList } = await rec.P('agent/orchestrator/providers/model-list-sanitize.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/model-catalog-projection.test.mjs';
const isoDay = (date) => date.toISOString().slice(0, 10);
const NOW = new Date(T0);
const RECENT = isoDay(new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)));
const OLD = isoDay(new Date(Date.UTC(NOW.getUTCFullYear() - 2, NOW.getUTCMonth(), 1)));
const modelsDevFixture = () => ({
  anthropic: {
    id: 'anthropic', name: 'Anthropic', doc: 'https://docs.anthropic.com', env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-opus-9-1': {
        id: 'claude-opus-9-1', name: 'Claude Opus 9.1', description: 'Prose no lookup reads. '.repeat(24), family: 'claude-opus', release_date: RECENT, last_updated: RECENT,
        knowledge: '2026-01', open_weights: false, temperature: true, structured_output: true, attachment: true, tool_call: true, reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], interleaved: { field: 'thinking' }, modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200000, output: 64000 }, cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      'claude-opus-8-0': {
        id: 'claude-opus-8-0', name: 'Claude Opus 8', description: 'Superseded by the row above. '.repeat(24), family: 'claude-opus', release_date: OLD, knowledge: '2024-01',
        tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 200000, output: 32000 }, cost: { input: 15, output: 75 },
      },
    },
  },
});

await rec.run('keeps-every-field-a-lookup-reads', `${SRC}:61`, { source: modelsDevFixture() }, () => ({ projected: projectModelsDevCatalog(modelsDevFixture()).anthropic.models['claude-opus-9-1'] }));
await rec.run('drops-unread-payload', `${SRC}:79`, { source: modelsDevFixture() }, () => {
  const row = projectModelsDevCatalog(modelsDevFixture()).anthropic.models['claude-opus-9-1'];
  return { row, present: Object.fromEntries(['description', 'knowledge', 'open_weights', 'temperature', 'structured_output', 'attachment', 'last_updated'].map((f) => [f, f in row])) };
});
await rec.run('explicit-tool-call-false-survives', `${SRC}:94`, {}, () => {
  const source = modelsDevFixture();
  source.anthropic.models['claude-opus-8-0'].tool_call = false;
  return { row: projectModelsDevCatalog(source).anthropic.models['claude-opus-8-0'] };
});
await rec.run('cost-less-row-stays-cost-less', `${SRC}:102`, {}, () => {
  const source = modelsDevFixture();
  delete source.anthropic.models['claude-opus-8-0'].cost;
  const row = projectModelsDevCatalog(source).anthropic.models['claude-opus-8-0'];
  return { row, hasCost: 'cost' in row };
});
await rec.run('sanitizer-same-verdict-on-projection', `${SRC}:110`, { clockStartMs: T0 }, () => {
  const source = modelsDevFixture();
  const models = [{ id: 'claude-opus-9-1', mode: 'chat', contextWindow: 200000, outputTokens: 64000 }, { id: 'claude-opus-8-0', mode: 'chat', contextWindow: 200000, outputTokens: 32000 }];
  const full = sanitizeModelList(models, { provider: 'anthropic', _testCatalog: source });
  const projected = sanitizeModelList(models, { provider: 'anthropic', _testCatalog: projectModelsDevCatalog(source) });
  return { models, full, projected, survivors: projected.map((row) => row.id) };
});
const litellm = {
  'anthropic/claude-opus-9-1': {
    litellm_provider: 'anthropic', mode: 'chat', max_input_tokens: 200000, max_tokens: 200000, max_output_tokens: 64000, input_cost_per_token: 5e-6, output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 0.5e-6, cache_creation_input_token_cost: 6.25e-6, supports_vision: true, supports_function_calling: true, supports_prompt_caching: true, supports_reasoning: true,
    reasoning_content_field: 'thinking', reasoning_options: [{ type: 'effort', values: ['high'] }],
    deprecation_date: '2027-01-01', input_cost_per_pixel: 0.001, supported_regions: ['us-east-1', 'eu-west-1'], supports_audio_input: false,
  },
};
await rec.run('litellm-keeps-every-field-a-lookup-reads', `${SRC}:137`, { source: litellm }, () => {
  const row = projectLitellmCatalog(litellm)['anthropic/claude-opus-9-1'];
  return { row, present: Object.fromEntries(['deprecation_date', 'input_cost_per_pixel', 'supported_regions', 'supports_audio_input'].map((f) => [f, f in row])) };
});
await rec.run('tolerates-published-shapes', `${SRC}:178`, {}, () => ({
  modelsDevBroken: projectModelsDevCatalog({ broken: null }),
  modelsDevNoModels: projectModelsDevCatalog({ noModels: { name: 'x' } }),
  litellmBroken: projectLitellmCatalog({ broken: null }),
  modelsDevNull: projectModelsDevCatalog(null),
  litellmUndefinedIsUndefined: projectLitellmCatalog(undefined) === undefined,
}));
await rec.finish({ clockStartMs: T0 });
