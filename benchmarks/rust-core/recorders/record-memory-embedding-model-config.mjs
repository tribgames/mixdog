#!/usr/bin/env node
// Node's embedding model profiles (src/runtime/memory/lib/embedding-model-config.test.mjs, 4 cases) from the real
// embedding-model-config.mjs: for each known model and an unknown one, every dtype request, the graph file, pooling,
// output name, dims, device, and the query/document input preparation; plus the environment-driven defaults.
//
//   node benchmarks/rust-core/recorders/record-memory-embedding-model-config.mjs --tree <dir>
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const m = await importFrom(ctx.tree, 'src/runtime/memory/lib/embedding-model-config.mjs');
const E5 = 'Xenova/multilingual-e5-small';
const GRANITE = 'ibm-granite/granite-embedding-97m-multilingual-r2';
const MODELS = [E5, GRANITE, 'Xenova/bge-m3', 'custom/embedding', '', ' Xenova/bge-m3 ', null];
const DTYPES = ['', 'q8', 'q4', 'fp16', 'fp32', 'Q8', ' fp16 ', 'int8', null, undefined];

const env = (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const label = (v) => (v === undefined ? { absent: true } : v);

const defaults = [];
for (const patch of [{}, { MIXDOG_EMBED_MODEL: GRANITE }, { MIXDOG_EMBED_MODEL: ' ' }, { MIXDOG_EMBED_MODEL: 'custom/x' }, { MIXDOG_EMBED_DTYPE: 'q4' }, { MIXDOG_EMBED_MODEL: 'Xenova/bge-m3', MIXDOG_EMBED_DTYPE: 'fp16' }]) {
  const set = { MIXDOG_EMBED_MODEL: undefined, MIXDOG_EMBED_DTYPE: undefined, ...patch };
  defaults.push({
    env: Object.fromEntries(Object.entries(patch)),
    modelId: await capture(() => env(set, () => m.getConfiguredEmbeddingModelId())),
    dims: await capture(() => env(set, () => m.getKnownEmbeddingDims())),
    dtype: await capture(() => env(set, () => m.getDefaultEmbeddingDtype())),
    device: await capture(() => env(set, () => m.getDefaultEmbeddingDevice())),
    graphFile: await capture(() => env(set, () => m.getEmbeddingModelGraphFile(undefined, undefined))),
    pooling: await capture(() => env(set, () => m.getEmbeddingPooling())),
  });
}
const perModel = [];
for (const model of MODELS) {
  const row = { model, dims: await capture(() => m.getKnownEmbeddingDims(model)), pooling: await capture(() => m.getEmbeddingPooling(model)), outputName: await capture(() => m.getEmbeddingOutputName(model)), device: await capture(() => m.getDefaultEmbeddingDevice(model)), dtypes: [] };
  for (const dtype of DTYPES) {
    row.dtypes.push({ dtype: label(dtype), normalized: await capture(() => m.normalizeEmbeddingDtype(model, dtype)), graphFile: await capture(() => m.getEmbeddingModelGraphFile(model, dtype)) });
  }
  perModel.push(row);
}
const TEXT = 'Windows 음성 런타임의 메모리 사용량';
const inputs = [];
for (const model of [E5, GRANITE, 'Xenova/bge-m3', 'custom/embedding']) {
  for (const type of ['query', 'QUERY', ' Query ', 'passage', 'document', '', null, undefined, 'other']) {
    for (const text of [TEXT, '', '  spaced  ', null]) {
      inputs.push({ model, inputType: label(type), text, type: await capture(() => m.normalizeEmbeddingInputType(type)), prepared: await capture(() => m.prepareEmbeddingInput(text, type, model)) });
    }
  }
}
const defaultInput = [await capture(() => m.prepareEmbeddingInput(TEXT)), await capture(() => m.prepareEmbeddingInput(TEXT, 'query'))];

finish(ctx, {
  url: import.meta.url,
  set: 'memory-embedding-model-config',
  golden: {
    domain: 'memory-embedding-model-config',
    source: 'src/runtime/memory/lib/embedding-model-config.test.mjs',
    cases: [
      { name: 'multilingual E5-small is the fixed production default', defaults, e5: perModel[0] },
      { name: 'multilingual E5-small applies asymmetric retrieval prefixes', inputs: inputs.filter((i) => i.model === E5), defaultModelInput: defaultInput },
      { name: 'Granite fallback keeps its official CLS pooling contract', granite: perModel[1], inputs: inputs.filter((i) => i.model === GRANITE) },
      { name: 'graph file names follow the transformers.js dtype suffixes', bgeM3: perModel[2], custom: perModel[3] },
      { name: 'every other model and dtype shape', perModel: perModel.slice(4), inputs: inputs.filter((i) => ['Xenova/bge-m3', 'custom/embedding'].includes(i.model)) },
    ],
  },
  extra: {
    entry: { runs: 'every export of embedding-model-config.mjs, with MIXDOG_EMBED_MODEL / MIXDOG_EMBED_DTYPE set per probe (restored after)', notRun: 'the model load and the worker that uses these answers' },
    replay: 'mixdog-services memory: mem/embed/config.rs (DEFAULT_MODEL_ID, known_dims, normalize_dtype, graph_file, pooling, prepare_input, profile, identity; the daemon takes the model from compose.rs:241 / tool_modules/host.rs); every answer is compared exactly, none is skipped. The `defaults` list (case 1, the six env settings of MIXDOG_EMBED_MODEL / MIXDOG_EMBED_DTYPE: configured model id, dims, default dtype, default device, graph file, pooling) has NO Rust counterpart: Rust reads neither variable (grep of native/core/crates finds only DEFAULT_MODEL_ID). Those five of six env settings are work for the Rust side (an env override, or a decision that the core ignores it); only the unset row (default model) maps today',
    exclusions: 'the final case holds probes the test file does not run; no environment-driven answer is left out of the recording (list for the Rust side: see replay)',
    normalised: { 'undefined arguments': 'written as {"absent":true}' },
  },
});
process.exit(0);
