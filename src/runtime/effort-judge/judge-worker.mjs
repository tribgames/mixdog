// Effort-judge worker thread: a small multilingual classifier (ONNX) that
// rates how much reasoning a request needs on four levels (easy, normal,
// hard, very hard). Loads on start and stays resident while the Auto effort
// feature is on (the parent terminates the thread when it is turned off),
// answering `judge` messages ({ request, prev }) with calibrated
// probabilities. calibration.json holds the temperature and the input format
// the model was trained on.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadCompactTokenizer } from './compact-tokenizer.mjs';

const require = createRequire(import.meta.url);
const MODEL_DIR = workerData.dir;
// Input token budget (bos + text + eos) the model was trained with;
// calibration.json `maxTokens` overrides it.
const DEFAULT_MAX_TOKENS = 256;

// Same onnxruntime-node build the embedding worker resolves through
// transformers, so the app ships one native binary.
function loadOrt() {
  try {
    return createRequire(require.resolve('@huggingface/transformers'))('onnxruntime-node');
  } catch {
    return require('onnxruntime-node');
  }
}

function calibration() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(join(MODEL_DIR, 'calibration.json'), 'utf8'));
  } catch {
    /* defaults below */
  }
  const value = Number(raw.temperature);
  const maxTokens = Number(raw.maxTokens);
  return {
    temperature: value > 0 ? value : 1,
    inputFormat: raw.inputFormat === 'rp' ? 'rp' : 'pr',
    maxTokens: maxTokens > 2 ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}

// pr: previous reply tail (300 chars) then the request;
// rp: the request then the previous reply tail (1000 chars), so a long request
//     is never cut and a short approval keeps more of the reply it answers.
function judgeText(format, request, prev) {
  const req = String(request || '').slice(0, 1500);
  const reply = String(prev || '');
  return format === 'rp'
    ? `request: ${req}\nprevious reply: ${reply.slice(-1000)}`
    : `previous reply: ${reply.slice(-300)}\nrequest: ${req}`;
}

async function load() {
  const ort = loadOrt();
  // The checkpoint was trained on <bos> text <eos>: the tokenizer's template
  // supplies the ids around the encoded text.
  const tokenizer = loadCompactTokenizer(MODEL_DIR);
  const session = await ort.InferenceSession.create(join(MODEL_DIR, 'model.onnx'), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    // One judgment runs at a time; 4 threads halve the long-input tail
    // (p95 ~280 -> ~110 ms measured) for a ~0.1 s burst per turn.
    intraOpNumThreads: 4,
  });
  return { ort, tokenizer, session, ...calibration() };
}

const loaded = load();

async function judge(request, prev) {
  const { ort, tokenizer, session, temperature: t, inputFormat, maxTokens } = await loaded;
  const text = judgeText(inputFormat, request, prev);
  const { prefix, suffix } = tokenizer;
  const body = tokenizer.encode(text).slice(0, maxTokens - prefix.length - suffix.length);
  const ids = [...prefix, ...body, ...suffix];
  const out = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
  });
  const logits = Array.from(out.logits.data, (value) => value / t);
  const top = Math.max(...logits);
  const exp = logits.map((value) => Math.exp(value - top));
  const sum = exp.reduce((a, b) => a + b, 0);
  return exp.map((value) => value / sum);
}

loaded.then(
  () => parentPort.postMessage({ type: 'ready' }),
  (error) => {
    parentPort.postMessage({ type: 'load-error', message: String(error?.message || error) });
    process.exit(1);
  }
);

parentPort.on('message', async (msg) => {
  if (msg?.action !== 'judge') return;
  try {
    parentPort.postMessage({ type: 'result', id: msg.id, probs: await judge(msg.request, msg.prev) });
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(error?.message || error) });
  }
});
