#!/usr/bin/env node
// Node's embedding model file cache (src/runtime/memory/lib/embedding-model-files.test.mjs, 2 cases) from the real
// `ensureModelGraph` and `ensureModelFile` over a real cache directory. The Hugging Face Hub is a scripted `fetch`
// (the service boundary) that records every request (URL, init) in order and answers a scripted status and body.
// Per step: the returned path (relative to the cache), the requests, and every file left in the cache (path, bytes hex).
//
//   node benchmarks/rust-core/recorders/record-memory-embedding-model-files.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { begin, capture, finish, importFrom } from './lib/mc-record.mjs';

const ctx = begin();
const { ensureModelFile, ensureModelGraph } = await importFrom(ctx.tree, 'src/runtime/memory/lib/embedding-model-files.mjs');
const { getEmbeddingModelGraphFile } = await importFrom(ctx.tree, 'src/runtime/memory/lib/embedding-model-config.mjs');
const realFetch = globalThis.fetch;

function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(dir, full).split(sep).join('/').replace(`.${process.pid}.part`, '.<pid>.part'), bytesHex: readFileSync(full).toString('hex') });
    }
  };
  walk(dir);
  return out;
}

// `hub`: url tail -> { status, body } ; unknown -> 404.
async function session(setup, steps, hub) {
  const cacheDir = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-embedding-')));
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const tail = String(url).replace('https://huggingface.co/', '');
    requests.push({ url: String(url), init });
    const answer = hub[tail] ?? { status: 404, body: 'not found' };
    return new Response(answer.body, { status: answer.status });
  };
  const out = { setup: setup.map(({ path, bytesHex }) => ({ path, bytesHex })), steps: [] };
  try {
    for (const { path, bytesHex } of setup) {
      mkdirSync(dirname(join(cacheDir, path)), { recursive: true });
      writeFileSync(join(cacheDir, path), Buffer.from(bytesHex, 'hex'));
    }
    for (const step of steps) {
      if (step.write) {
        mkdirSync(dirname(join(cacheDir, step.write.path)), { recursive: true });
        writeFileSync(join(cacheDir, step.write.path), Buffer.from(step.write.bytesHex, 'hex'));
      }
      const before = requests.length;
      const rel = (path) => relative(cacheDir, path).split(sep).join('/');
      // `worker`: the embedding worker's own sequence (embedding-worker.mjs:286-287 loadTokenizer, :303-307 createExtractor):
      // tokenizer.json, tokenizer_config.json, then the graph its config names; the three paths in that order.
      const answer = step.call === 'worker'
        ? await capture(async () => [
          rel(await ensureModelFile(cacheDir, step.model, 'tokenizer.json')),
          rel(await ensureModelFile(cacheDir, step.model, 'tokenizer_config.json')),
          rel(await ensureModelGraph(cacheDir, step.model, getEmbeddingModelGraphFile(step.model, step.dtype ?? undefined))),
        ])
        : await capture(async () => rel(await (step.call === 'graph' ? ensureModelGraph : ensureModelFile)(cacheDir, step.model, step.file)));
      out.steps.push({ ...step, ...answer, requests: requests.slice(before), cacheAfter: files(cacheDir) });
    }
  } finally {
    globalThis.fetch = realFetch;
    rmSync(cacheDir, { recursive: true, force: true });
  }
  return out;
}
const hex = (text) => Buffer.from(text).toString('hex');
const nul = (n) => Buffer.alloc(n).toString('hex');
const GRAPH = 'org/model/onnx/model.onnx';

const graphCase = await session(
  [{ path: GRAPH, bytesHex: hex('graph') }],
  [
    { call: 'graph', model: 'org/model', file: 'onnx/model.onnx', write: { path: `${GRAPH}_data`, bytesHex: '' } },
    { call: 'graph', model: 'org/model', file: 'onnx/model.onnx', write: { path: `${GRAPH}_data`, bytesHex: nul(64) } },
    { call: 'graph', model: 'org/model', file: 'onnx/model.onnx' },
  ],
  { 'org/model/resolve/main/onnx/model.onnx_data': { status: 200, body: 'weights' } },
);
const fileCase = await session(
  [],
  [
    { call: 'file', model: 'org/model', file: 'tokenizer_config.json', write: { path: 'org/model/tokenizer_config.json', bytesHex: '' } },
    { call: 'file', model: 'org/model', file: 'tokenizer_config.json', write: { path: 'org/model/tokenizer_config.json', bytesHex: nul(48) } },
    { call: 'file', model: 'org/model', file: 'tokenizer_config.json', write: { path: 'org/model/tokenizer_config.json', bytesHex: hex('{"model_max') } },
    { call: 'file', model: 'org/model', file: 'tokenizer_config.json' },
  ],
  { 'org/model/resolve/main/tokenizer_config.json': { status: 200, body: '{"model_max_length":256}' } },
);
const further = [
  await session([], [{ call: 'graph', model: 'org/model', file: 'onnx/model.onnx' }], {
    'org/model/resolve/main/onnx/model.onnx_data': { status: 200, body: 'weights' }, 'org/model/resolve/main/onnx/model.onnx': { status: 200, body: 'graph' } }),
  await session([], [{ call: 'graph', model: 'org/model', file: 'onnx/model.onnx' }], { 'org/model/resolve/main/onnx/model.onnx': { status: 200, body: 'graph' } }),
  await session([], [{ call: 'graph', model: 'org/model', file: 'onnx/model.onnx' }], {}),
  await session([], [{ call: 'file', model: 'org/model', file: 'config.json' }], { 'org/model/resolve/main/config.json': { status: 503, body: 'busy' } }),
  await session([{ path: 'org/model/config.json', bytesHex: hex('not json') }, { path: 'org/model/vocab.txt', bytesHex: hex('exact text') }],
    [{ call: 'file', model: 'org/model', file: 'config.json' }, { call: 'file', model: 'org/model', file: 'vocab.txt' }],
    { 'org/model/resolve/main/config.json': { status: 200, body: '{}' } }),
  await session([{ path: GRAPH, bytesHex: hex('graph') }], [{ call: 'graph', model: 'org/model', file: 'onnx/model.onnx' }], {}),
];
// The worker's whole install over one hub: a cold cache, a cache with a damaged tokenizer config and the weights missing,
// a healthy cache, and a hub that fails the tokenizer.
const fullHub = {
  'org/model/resolve/main/tokenizer.json': { status: 200, body: '{"model":{}}' },
  'org/model/resolve/main/tokenizer_config.json': { status: 200, body: '{"model_max_length":256}' },
  'org/model/resolve/main/onnx/model.onnx_data': { status: 200, body: 'weights' },
  'org/model/resolve/main/onnx/model.onnx': { status: 200, body: 'graph' },
};
const worker = { call: 'worker', model: 'org/model', dtype: null };
const install = [
  await session([], [worker], fullHub),
  await session([{ path: 'org/model/tokenizer.json', bytesHex: hex('{"model":{}}') }, { path: 'org/model/tokenizer_config.json', bytesHex: nul(16) }, { path: GRAPH, bytesHex: hex('graph') }, { path: `${GRAPH}_data`, bytesHex: '' }], [worker], fullHub),
  await session([{ path: 'org/model/tokenizer.json', bytesHex: hex('{"model":{}}') }, { path: 'org/model/tokenizer_config.json', bytesHex: hex('{"model_max_length":256}') }, { path: GRAPH, bytesHex: hex('graph') }, { path: `${GRAPH}_data`, bytesHex: hex('weights') }], [worker], fullHub),
  await session([], [worker], { 'org/model/resolve/main/tokenizer.json': { status: 503, body: 'busy' } }),
];

finish(ctx, {
  url: import.meta.url,
  set: 'memory-embedding-model-files',
  golden: {
    domain: 'memory-embedding-model-files',
    source: 'src/runtime/memory/lib/embedding-model-files.test.mjs',
    cases: [
      { name: 'an intact cached graph with empty or NUL external weights fetches only the weights', session: graphCase },
      { name: 'empty, NUL-filled or unparsable cached model files are fetched again', session: fileCase },
      { name: 'further shapes (beyond the test file): cold graph, 404 weights, 404 graph, 503, exact-text file, healthy cache', sessions: further },
      { name: "the embedding worker's install (beyond the test file): cold, damaged, healthy, failing hub", sessions: install },
    ],
  },
  extra: {
    entry: { runs: 'ensureModelFile and ensureModelGraph (embedding-model-files.mjs) over a real temp cache directory, with the real atomic-file/file-has-data helpers', notRun: 'the Hugging Face Hub: globalThis.fetch is a scripted endpoint (status and body per URL), recorded with every request' },
    replay: "mixdog-services memory/embed/install.rs (pub): ensure_model_file / ensure_model_graph for the test file's steps, and install (what EmbeddingProvider::install runs) for the worker's sequence of case 4. A replay (memory/replays/model_files.rs) serves the recorded hub answers from a local server and compares every request as it arrives (url, method, headers, body) in order, the result or error, and the files left in the cache",
    exclusions: 'request init is recorded as passed (null: Node passes none, so no header is sent)',
    normalised: { 'temp cache dir': 'paths are relative to the cache dir', 'partial file name': 'process id in "<file>.<pid>.part" written as <pid> (no partial remains after a step)' },
  },
});
process.exit(0);
