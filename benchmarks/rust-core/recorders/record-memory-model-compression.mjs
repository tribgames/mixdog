#!/usr/bin/env node
// The model-cache compression after an embedding model's first load, from Node's embedding worker
// (src/runtime/memory/lib/embedding-worker.mjs:438 → embedding-model-cache-compression.mjs:23), run for real in a worker
// thread as embedding-provider.mjs starts it, loading a real model (the tiny graph and tokenizer of
// lib/tiny-embedding-model/, written by lib/tiny-embedding-model.py; recorded into the golden as `modelFiles`, base64)
// with the real onnxruntime on the CPU.
// The one seam is `execFile` (lib/compact-seam.mjs): each call is reported in order with the worker's messages and
// answered without running anything. Cases, each a fresh worker over a fresh cache:
//   1. the load succeeds and compact.exe succeeds; then the model is disposed and loaded again;
//   2. the load succeeds and compact.exe fails;
//   3. the graph is damaged, so the load fails.
// Recorded per case: each request's reply and, in order, the compression calls (command, arguments with the model
// directory as `<modelDir>`, options) and the step they came in. A compression comes only after a load; the recorder
// waits for its call (with a deadline) where the worker reported the load, and a later load or a failed one is
// complete when its reply comes.
//
//   node benchmarks/rust-core/recorders/record-memory-model-compression.mjs --tree <dir>
import { Worker } from 'node:worker_threads';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { begin, finish, within } from './lib/mc-record.mjs';

const ctx = begin();
const SCRATCH = process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:/mixdog-build/tmp/w23/rec';
const MODEL_ID = 'Xenova/multilingual-e5-small';
const MODEL_FILES = fileURLToPath(new URL('./lib/tiny-embedding-model', import.meta.url));
const modelFiles = Object.fromEntries(
  ['tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'].map((file) => [file, readFileSync(join(MODEL_FILES, file)).toString('base64')])
);
const SEAM = pathToFileURL(fileURLToPath(new URL('./lib/compact-seam.mjs', import.meta.url))).href;

async function runCase(name, { compact, damaged, steps }) {
  const dataDir = mkdtempSync(join(SCRATCH, 'compress-'));
  const modelDir = resolve(dataDir, 'memory-models', ...MODEL_ID.split('/'));
  cpSync(MODEL_FILES, modelDir, { recursive: true });
  if (damaged) writeFileSync(join(modelDir, 'onnx', 'model_quantized.onnx'), 'not a graph');
  const worker = new Worker(join(ctx.tree, 'src/runtime/memory/lib/embedding-worker.mjs'), {
    env: { ...process.env, MIXDOG_DATA_DIR: dataDir, MIXDOG_MEMORY_EMBED_DEVICE: 'cpu', MIXDOG_SEAM_COMPACT: compact },
    execArgv: ['--import', SEAM],
    workerData: { dtype: 'q8' },
  });
  const calls = [];
  const replies = new Map();
  const waiting = new Map();
  let step = null;
  let loaded = 0;
  let onLoad = null;
  let onCall = null;
  worker.on('message', (msg) => {
    if (msg?.type === 'seam') {
      // The load's CPU-affinity PowerShell calls (they name the worker's pid) are not this set's subject.
      if (msg.command !== 'compact.exe') return;
      calls.push({
        step,
        command: msg.command,
        args: msg.args.map((a) => String(a).replaceAll(modelDir, '<modelDir>')),
        options: msg.options,
      });
      onCall?.();
    } else if (msg?.type === 'profile' && msg.record?.phase === 'load') {
      loaded += 1;
      onLoad?.();
    } else if (msg?.id != null && (msg.type === 'result' || msg.type === 'error')) {
      replies.set(msg.id, msg);
      waiting.get(msg.id)?.();
    }
  });
  let nextId = 0;
  const outcomes = [];
  for (const action of steps) {
    const id = ++nextId;
    step = `${action} #${outcomes.length + 1}`;
    const loadsBefore = loaded;
    const compactsBefore = calls.filter((c) => c.command === 'compact.exe').length;
    worker.postMessage({ id, action });
    await within(`${name}: ${step}`, new Promise((done) => (replies.has(id) ? done() : waiting.set(id, done))));
    const reply = replies.get(id);
    // A load that ran reports itself before its reply; its compression call, if one comes, follows the load.
    if (loaded > loadsBefore && compactsBefore === 0 && action === 'warmup' && reply.type === 'result') {
      await within(`${name}: the compression call`, new Promise((done) => (calls.some((c) => c.command === 'compact.exe') ? done() : (onCall = done))));
    }
    outcomes.push({ step, reply: { type: reply.type, ...(reply.type === 'error' ? { message: reply.message } : { dims: reply.dims }) }, loaded: loaded > loadsBefore });
  }
  await worker.terminate();
  return { name, compact, damaged, outcomes, calls, sep };
}

const cases = [
  await runCase('the first load compresses the model cache, once', { compact: 'ok', damaged: false, steps: ['warmup', 'dispose', 'warmup'] }),
  await runCase('a failed compression leaves the load succeeded', { compact: 'fail', damaged: false, steps: ['warmup'] }),
  await runCase('a failed load compresses nothing', { compact: 'ok', damaged: true, steps: ['warmup'] }),
];

finish(ctx, {
  url: import.meta.url,
  set: 'memory-model-compression',
  flags: '',
  golden: { modelId: MODEL_ID, modelFiles, cases },
  extra: {
    entry: 'src/runtime/memory/lib/embedding-worker.mjs in a worker thread (as embedding-provider.mjs starts it), its warmup/dispose requests',
    replay: 'native/core/crates/mixdog-services/src/memory/tests/model_compression.rs',
    exclusions:
      "execFile is a seam (lib/compact-seam.mjs): nothing runs; only compact.exe calls are recorded (the load's CPU-affinity PowerShell calls are not this set's subject); the worker's log lines are not recorded. The replay compares each warmup's reply type and dims (an error by its type: the message is onnxruntime's own text), and every compression call's step, command and arguments; the options' 120 s limit is the Rust run's own deadline, not a spawn argument, and is not compared; the Rust provider has no dispose (its one load serves every later warmup), so the dispose step has no counterpart",
    normalised: 'the model directory in arguments is written <modelDir>',
  },
});
process.exit(0);
