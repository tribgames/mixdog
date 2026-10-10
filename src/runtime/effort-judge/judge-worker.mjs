// Effort-judge worker thread: a small multilingual classifier (ONNX) that
// rates how much reasoning a request needs on four levels (easy, normal,
// hard, very hard). The parent starts it on the first judged turn; it loads
// on start and stays resident while the Auto effort feature is on (the parent
// terminates the thread when it is turned off or the model is updated),
// answering `judge` messages ({ request, prev, prevRequest } for a turn, or
// { step } for a tool-result step) with calibrated probabilities.
// calibration.json holds the temperature, the input format the model was
// trained on, and `steps: 1` when it was also trained on tool-result steps.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadCompactTokenizer } from './compact-tokenizer.mjs';
import { judgeInputClean, packJudgeIds, stepJudgeText } from './judge-input.mjs';

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
    inputFormat: ['rp', 'rpq', 'rpc', 'pack'].includes(raw.inputFormat) ? raw.inputFormat : 'pr',
    maxTokens: maxTokens > 2 ? maxTokens : DEFAULT_MAX_TOKENS,
    steps: raw.steps === 1,
  };
}

// pr: previous reply tail (300 chars) then the request;
// rp: the request then the previous reply tail (1000 chars), so a long request
//     is never cut and a short approval keeps more of the reply it answers;
// rpq: rp with the previous user request's head (300) between them, so a short
//      follow-up shows the work it continues;
// rpc: rp after judge-input.mjs cleaning (code blocks, tag blocks, hashes, whitespace).
function judgeText(format, request, prev, prevRequest) {
  if (format === 'rpc') return judgeInputClean(request, prev);
  if (format === 'rpq') {
    const cps = (text, from, to) =>
      Array.from(String(text || ''))
        .slice(from, to)
        .join('');
    return `request: ${cps(request, 0, 1500)}\nprevious request: ${cps(prevRequest, 0, 300)}\nprevious reply: ${cps(prev, -1000)}`;
  }
  const req = String(request || '').slice(0, 1500);
  const reply = String(prev || '');
  return format === 'rp'
    ? `request: ${req}\nprevious reply: ${reply.slice(-1000)}`
    : `previous reply: ${reply.slice(-300)}\nrequest: ${req}`;
}

function inputIds(tokenizer, inputFormat, maxTokens, { request, prev, prevRequest, step }) {
  const { prefix, suffix } = tokenizer;
  const room = maxTokens - prefix.length - suffix.length;
  if (step) return [...prefix, ...tokenizer.encode(stepJudgeText(step)).slice(0, room), ...suffix];
  if (inputFormat === 'pack') return packJudgeIds(tokenizer, { request, prevRequest, prev }, maxTokens);
  const body = tokenizer.encode(judgeText(inputFormat, request, prev, prevRequest)).slice(0, room);
  return [...prefix, ...body, ...suffix];
}

function feeds(ort, ids) {
  return {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
  };
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
  const settings = calibration();
  // The first run allocates buffers and initialises kernels and is several
  // times slower than the rest; doing it before `ready` keeps a turn's first
  // judgment at normal speed.
  await session.run(
    feeds(ort, inputIds(tokenizer, settings.inputFormat, settings.maxTokens, { request: 'warm up', prev: '' }))
  );
  return { ort, tokenizer, session, ...settings };
}

const loaded = load();

async function judge(input) {
  const { ort, tokenizer, session, temperature: t, inputFormat, maxTokens, steps } = await loaded;
  if (input.step && !steps) throw new Error('step-unsupported');
  const out = await session.run(feeds(ort, inputIds(tokenizer, inputFormat, maxTokens, input)));
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
    parentPort.postMessage({ type: 'result', id: msg.id, probs: await judge(msg) });
  } catch (error) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: String(error?.message || error) });
  }
});
