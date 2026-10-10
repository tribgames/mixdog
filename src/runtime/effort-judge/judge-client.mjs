// Effort-judge client. The judge loads on the first turn that uses it (a model
// with Auto effort support) and then stays resident until the feature is
// turned off or a model update replaces its files, so users who never send
// such a turn never hold it in memory. A turn waits for a still-loading judge
// only briefly; when the model is missing, still loading, slow, or failing,
// `judgeTurn` returns a `skipped` reason and the turn keeps its default
// effort. Decisions are logged locally (lengths and probabilities only, never
// the request text).
import { Worker } from 'node:worker_threads';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { effortJudgeInstallCurrent, effortJudgeInstallStamped, installEffortJudgeModel } from './model-install.mjs';

import { onnxRuntimeSupported } from '../shared/onnx-runtime-support.mjs';

export const EFFORT_JUDGE_UNSUPPORTED = 'Auto effort is unsupported on darwin-x64 (no onnxruntime-node binding)';
const WORKER_PATH = fileURLToPath(new URL('./judge-worker.mjs', import.meta.url));
const MODEL_FILES = ['model.onnx', 'tokenizer.json'];
// The worker runs one judgment at a time, so requests are sent one by one:
// each answer's deadline starts when it is sent, and the wait for earlier
// requests is bounded separately so a burst of turns queues instead of
// timing out behind each other.
// MIXDOG_EFFORT_JUDGE_TIMEOUT_MS raises it on a host whose CPUs are shared
// with heavy work (parallel benchmark containers).
const WARM_TIMEOUT_MS =
  Number(process.env.MIXDOG_EFFORT_JUDGE_TIMEOUT_MS) > 0 ? Number(process.env.MIXDOG_EFFORT_JUDGE_TIMEOUT_MS) : 400;
const QUEUE_WAIT_MS = 1000;
let queueTail = Promise.resolve();
// A turn that arrives while the judge is still loading (its first use, or the
// first turn after a model update) waits at most this long; loading takes about 2 s on a desktop CPU.
// MIXDOG_EFFORT_JUDGE_COLD_WAIT_MS raises it where a cold load is certain and
// a slower first turn is acceptable (one-shot headless runs on a busy host).
const COLD_WAIT_MS =
  Number(process.env.MIXDOG_EFFORT_JUDGE_COLD_WAIT_MS) > 0
    ? Number(process.env.MIXDOG_EFFORT_JUDGE_COLD_WAIT_MS)
    : 3000;

let worker = null;
let workerDir = '';
let ready = false;
let lastLoadError = '';
let lastLoadErrorAt = 0;
// After a failed load the judge is not retried (and turns do not wait on it)
// for this long, so a broken model cannot add the cold wait to every turn.
const LOAD_RETRY_MS = 60_000;
let msgId = 0;
const pending = new Map();
let readyWaiters = [];

function notifyReady(value) {
  const waiters = readyWaiters;
  readyWaiters = [];
  for (const wake of waiters) wake(value);
}

function waitReady(ms) {
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    const wake = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      readyWaiters = readyWaiters.filter((entry) => entry !== wake);
      resolve(false);
    }, ms);
    readyWaiters.push(wake);
  });
}

export function effortJudgeModelDir() {
  return process.env.MIXDOG_EFFORT_JUDGE_DIR || join(resolvePluginData(), 'models', 'effort-judge');
}

// A release install is usable once stamped (model-install.mjs removes the
// stamp before replacing files); an explicit MIXDOG_EFFORT_JUDGE_DIR is used as
// it is. Unstamped leftovers (hand-copied packs) never load.
export function effortJudgeAvailable(dir = effortJudgeModelDir()) {
  if (!onnxRuntimeSupported()) return false;
  if (!MODEL_FILES.every((file) => existsSync(join(dir, file)))) return false;
  return Boolean(process.env.MIXDOG_EFFORT_JUDGE_DIR) || effortJudgeInstallStamped(dir);
}

/** True while a download or update of the judge model is in flight. */
export function effortJudgeInstalling() {
  return installing !== null;
}

// Whether the installed model was also trained on tool-result steps
// (calibration.json `steps: 1`). Read once per model directory.
const stepSupport = new Map();
export function effortJudgeSupportsSteps(dir = effortJudgeModelDir()) {
  if (!stepSupport.has(dir)) {
    let steps = false;
    try {
      steps = JSON.parse(readFileSync(join(dir, 'calibration.json'), 'utf8')).steps === 1;
    } catch {
      /* not installed */
    }
    stepSupport.set(dir, steps);
  }
  return stepSupport.get(dir);
}

function settle(id, fn) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  fn(entry);
}

function ensureWorker(dir) {
  if (worker && workerDir === dir) return worker;
  if (worker) void worker.terminate().catch(() => {});
  const created = new Worker(WORKER_PATH, { workerData: { dir } });
  created.unref();
  worker = created;
  workerDir = dir;
  ready = false;
  created.on('message', (msg) => {
    if (msg.type === 'ready') {
      ready = true;
      lastLoadError = '';
      notifyReady(true);
    } else if (msg.type === 'load-error') {
      lastLoadError = msg.message;
      lastLoadErrorAt = Date.now();
      notifyReady(false);
    } else if (msg.type === 'result') {
      settle(msg.id, (entry) => entry.resolve(msg.probs));
    } else if (msg.type === 'error') {
      settle(msg.id, (entry) => entry.reject(new Error(msg.message)));
    }
  });
  const retire = () => {
    if (worker === created) {
      worker = null;
      ready = false;
      notifyReady(false);
    }
    for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(new Error('effort judge exited')));
  };
  created.on('error', (error) => {
    lastLoadError = String(error?.message || error);
    lastLoadErrorAt = Date.now();
    retire();
  });
  created.on('exit', retire);
  return created;
}

function request(target, { request: text, prev, prevRequest, step }) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => settle(id, (entry) => entry.reject(new Error('timeout'))), WARM_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    // The worker formats the text the way its model was trained.
    target.postMessage({
      action: 'judge',
      id,
      // The worker keeps only the request head (1500 code points), the previous
      // reply tail (1000) and the previous request head (600); clip so a long
      // agent brief is not copied whole across the thread boundary.
      request: String(text || '').slice(0, 3000),
      prev: String(prev || '').slice(-2000),
      prevRequest: String(prevRequest || '').slice(0, 1200),
      ...(step ? { step } : {}),
    });
  });
}

// One install at a time (the settings install and the boot refresh can overlap).
let installing = null;
let refreshChecked = false;

/**
 * Installs or updates the judge model from the release the bundled manifest
 * names; files that already match are kept. A worker running on replaced
 * files is stopped so the next judged turn loads the new model. An explicit
 * MIXDOG_EFFORT_JUDGE_DIR (benchmarks, experiments) is used as it is.
 */
export function installEffortJudge() {
  if (!onnxRuntimeSupported()) return Promise.reject(new Error(EFFORT_JUDGE_UNSUPPORTED));
  installing ??= (async () => {
    const dir = effortJudgeModelDir();
    if (process.env.MIXDOG_EFFORT_JUDGE_DIR || (effortJudgeAvailable(dir) && effortJudgeInstallCurrent(dir))) {
      if (!effortJudgeAvailable(dir))
        throw new Error(`The Auto reasoning model is not installed (expected in ${dir}).`);
      return;
    }
    await installEffortJudgeModel(dir);
    if (worker) await shutdownEffortJudge();
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/**
 * Download a missing model or bring an outdated install up to date in the
 * background. Runs on the first judged turn of the process, never at runtime
 * creation, so booting touches no network.
 */
export function refreshEffortJudge() {
  if (!onnxRuntimeSupported()) return;
  installEffortJudge().catch((error) => {
    // An older complete install still works.
    process.stderr.write(`[effort-judge] model update failed: ${error?.message || error}\n`);
  });
}

export function effortJudgeReady() {
  return ready;
}

/** What the settings card shows about the judge. */
export function effortJudgeInfo(dir = effortJudgeModelDir()) {
  let modelBytes = 0;
  try {
    modelBytes = statSync(join(dir, 'model.onnx')).size;
  } catch {
    /* not installed */
  }
  // The installed model names its backbone in calibration.json; older packs predate the field.
  let backbone = 'mmBERT-small';
  try {
    backbone = JSON.parse(readFileSync(join(dir, 'calibration.json'), 'utf8')).backbone || backbone;
  } catch {
    /* not installed */
  }
  return { model: backbone, quantization: '4-bit', engine: 'ONNX Runtime', device: 'CPU', modelBytes, ready };
}

/**
 * Probabilities over the four levels (easy, normal, hard, very hard) for this
 * turn ({ request, prev, prevRequest }) or tool-result step ({ step }), or
 * `{ skipped }` when the judge cannot answer in time. A judge that is still
 * loading gets a short grace period; a crashed one is restarted here.
 */
export async function judgeTurn(input) {
  if (!onnxRuntimeSupported()) return { skipped: 'unsupported' };
  const dir = effortJudgeModelDir();
  if (!refreshChecked) {
    refreshChecked = true;
    if (!process.env.MIXDOG_EFFORT_JUDGE_DIR && !(effortJudgeAvailable(dir) && effortJudgeInstallCurrent(dir))) {
      refreshEffortJudge();
    }
  }
  if (installing) return { skipped: 'installing' };
  if (!effortJudgeAvailable(dir)) return { skipped: 'model-missing' };
  if (!worker && lastLoadError && Date.now() - lastLoadErrorAt < LOAD_RETRY_MS) {
    return { skipped: `load-error: ${lastLoadError}` };
  }
  const target = ensureWorker(dir);
  if (!ready && !(await waitReady(COLD_WAIT_MS))) {
    return { skipped: lastLoadError ? `load-error: ${lastLoadError}` : 'warming' };
  }
  const queuedAt = Date.now();
  const run = queueTail.then(async () => {
    if (worker !== target || !ready) return { skipped: 'effort judge exited' };
    if (Date.now() - queuedAt > QUEUE_WAIT_MS) return { skipped: 'busy' };
    const startedAt = Date.now();
    try {
      return { probs: await request(target, input), ms: Date.now() - startedAt };
    } catch (error) {
      return { skipped: String(error?.message || error) };
    }
  });
  queueTail = run;
  return run;
}

// MIXDOG_EFFORT_DECISIONS_LOG redirects the log, e.g. for benchmark runs whose
// data directory is discarded when the run ends.
export function recordEffortDecision(entry) {
  try {
    const file =
      process.env.MIXDOG_EFFORT_DECISIONS_LOG || join(resolvePluginData(), 'effort-judge', 'decisions.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    /* the log is diagnostic only */
  }
}

export async function shutdownEffortJudge() {
  const current = worker;
  worker = null;
  ready = false;
  notifyReady(false);
  if (current) await current.terminate().catch(() => {});
}
