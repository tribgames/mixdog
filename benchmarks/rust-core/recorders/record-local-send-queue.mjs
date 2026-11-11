#!/usr/bin/env node
// mixdog-local.mjs (b6f10295a): the part of `MixdogLocalProvider.send` around the inner send — the request queue every
// instance shares (local-provider/server.mjs `runLocalProviderRequest`, request-queue.mjs), the inference measurement
// (`beginLocalInference`, model-state.mjs: queue wait, first response, duration, tokens per second, failure) — and
// `getCachedModelInfo` (mixdog-local.mjs:91), the installed model's row at every moment.
// The inner OpenAI-compatible send is scripted (as mixdog-local.test.mjs does) with `{ advance, progress, snapshot, hold,
// fail, result }` steps, and `ensureServer` is injected (mixdog-local.test.mjs does so too): what is recorded is the queue and
// the measurement around them. Time is virtual: `performance.now` (the measurement's clock) moves only by an `advance` step
// or the case's own `elapse`, and `new Date()` is the shared fixed instant.
//   node benchmarks/rust-core/recorders/record-local-send-queue.mjs --tree <export of b6f10295a with node_modules>
process.env.TZ = 'UTC';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { RecorderError } from './lib/recorder-error.mjs';
import { openSet, FIXED_NOW } from './lib/case-set.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'bench-local-send-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const set = openSet('local-send-queue', import.meta.url, { clock: false });
mock.timers.enable({ apis: ['Date'], now: FIXED_NOW });
const P = 'src/runtime/agent/orchestrator/providers/';
const { MixdogLocalProvider } = await set.load(`${P}mixdog-local.mjs`);
const { OpenAICompatProvider } = await set.load(`${P}openai-compat.mjs`);
const { localModelState } = await set.load('src/runtime/local-provider/model-state.mjs');
const { registerLocalModel } = await set.load('src/runtime/local-provider/registered-models.mjs');

// The measurement's clock.
let virtualNow = 0;
Object.defineProperty(performance, 'now', { configurable: true, value: () => virtualNow });

/** Runs `steps` as the inner send: what the scripted provider does between the queue slot and the answer. */
function scripted(model, gates, record) {
  return async (_messages, _model, _tools, opts) => {
    for (const step of record.steps) {
      if ('advance' in step) virtualNow += step.advance;
      else if ('progress' in step) opts.onStreamDelta(step.progress);
      else if ('snapshot' in step) record.snapshots[step.snapshot] = localModelState(model).inference;
      else if ('hold' in step) { record.reached.push(`${record.name} holds`); await gates[step.hold].promise; }
      else if ('fail' in step) throw new Error(step.fail);
      else if ('result' in step) return { content: 'ok', usage: step.result };
      else throw new RecorderError(`bad step ${JSON.stringify(step)}`);
    }
    throw new RecorderError('a script ends in a result or a failure');
  };
}

const original = OpenAICompatProvider.prototype.send;
const sendWith = async (provider, model) => {
  try { return { returned: await provider.send([{ role: 'user', content: 'hi' }], model, [], {}) }; } catch (error) { return { threw: String(error.message) }; }
};
/** One send of `steps`, alone in the queue. */
async function alone(model, steps, elapse = 0) {
  const record = { name: 'only', steps, snapshots: {}, reached: [] };
  OpenAICompatProvider.prototype.send = scripted(model, {}, record);
  try {
    const outcome = await sendWith(new MixdogLocalProvider({}, { ensureServer: async () => ({ baseURL: 'http://127.0.0.1:12345/v1', apiKey: 'k' }) }), model);
    virtualNow += elapse;
    return { model, steps, outcome, snapshots: record.snapshots, inference: localModelState(model).inference };
  } finally {
    OpenAICompatProvider.prototype.send = original;
  }
}

try {
  await set.run('a streamed send is measured: first response, duration, tokens per second', () => alone('local-streamed', [
    { advance: 120 }, { snapshot: 'atSend' }, { progress: 'transport' }, { advance: 80 }, { progress: 'text' }, { advance: 400 }, { result: { inputTokens: 20, outputTokens: 11 } },
  ]));
  await set.run('a failed send is measured as failed and its error is rethrown', () => alone('local-failed', [
    { advance: 50 }, { progress: 'text' }, { advance: 25 }, { fail: 'boom' },
  ]));
  await set.run('a send that shows no output has no first response and no speed', () => alone('local-silent', [
    { advance: 10 }, { progress: 'transport' }, { advance: 5 }, { result: { inputTokens: 3, outputTokens: 1 } },
  ]));
  await set.run('a second send waits for the first, and its queue wait is measured', async () => {
    const model = 'local-queued';
    const gates = { a: Promise.withResolvers() };
    const first = { name: 'A', steps: [{ progress: 'text' }, { hold: 'a' }, { advance: 50 }, { result: { inputTokens: 2, outputTokens: 5 } }], snapshots: {}, reached: [] };
    const second = { name: 'B', steps: [{ snapshot: 'atSend' }, { advance: 20 }, { progress: 'text' }, { advance: 30 }, { result: { inputTokens: 4, outputTokens: 9 } }], snapshots: {}, reached: [] };
    const reached = [];
    const shared = { ensureServer: async () => ({ baseURL: 'http://127.0.0.1:12345/v1', apiKey: 'k' }) };
    let turn = 0;
    OpenAICompatProvider.prototype.send = function send(...args) {
      const record = turn++ === 0 ? first : second;
      record.reached = reached;
      return scripted(model, gates, record)(...args);
    };
    try {
      const a = sendWith(new MixdogLocalProvider({}, shared), model);
      const b = sendWith(new MixdogLocalProvider({}, shared), model);
      await new Promise(setImmediate);
      const reachedWhileHeld = [...reached];
      const duringHold = localModelState(model).inference;
      virtualNow += 700;
      gates.a.resolve();
      const outcomes = [await a, await b];
      return { model, scripts: [first.steps, second.steps], elapsedWhileHeld: 700, reachedWhileHeld, duringHold, outcomes, secondSaw: second.snapshots, inference: localModelState(model).inference };
    } finally {
      OpenAICompatProvider.prototype.send = original;
    }
  });

  // getCachedModelInfo: `installedLocalProviderModels().find(entry => entry.id === model) || null`, read from disk on every call.
  await set.run('the cached model info is the installed model\'s row at every moment', async () => {
    const modelRoot = join(dataDir, 'local-provider', 'models');
    mkdirSync(modelRoot, { recursive: true });
    const entry = (letter, extra = {}) => {
      const id = `hf-${letter.repeat(24)}`;
      return { id, filename: `${id}.gguf`, remoteFilename: 'model.gguf', repository: 'test/model', revision: 'b'.repeat(40), name: `Registered ${letter}`, source: 'https://huggingface.co/test/model', url: `https://huggingface.co/test/model/resolve/${'b'.repeat(40)}/model.gguf`, size: 1024, sha256: 'c'.repeat(64), contextWindow: 8192, estimatedVramBytes: 1024 ** 3, minimumVramBytes: 1024 ** 3, ...extra };
    };
    const first = entry('a'); const second = entry('d', { name: 'Registered d', contextWindow: 32768, maxContextWindow: 65536 }); const absent = entry('e');
    const provider = new MixdogLocalProvider({});
    const ids = [first.id, second.id, absent.id, 'not-registered'];
    const moment = async (name) => ({ name, listed: await provider.listModels(), cached: Object.fromEntries(ids.map((id) => [id, provider.getCachedModelInfo(id)])) });
    const moments = [await moment('nothing is registered')];
    for (const model of [first, second, absent]) registerLocalModel(model, dataDir);
    moments.push(await moment('registered, none downloaded'));
    for (const model of [first, second]) writeFileSync(join(modelRoot, model.filename), Buffer.alloc(model.size, 1));
    moments.push(await moment('two downloaded'));
    unlinkSync(join(modelRoot, first.filename));
    moments.push(await moment('one removed'));
    return { registered: [first, second, absent], ids, moments };
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

await set.finish({
  entry: { runs: 'MixdogLocalProvider.send (mixdog-local.mjs:46) over the real runLocalProviderRequest queue (local-provider/server.mjs, request-queue.mjs) and the real beginLocalInference (model-state.mjs:32); getCachedModelInfo (mixdog-local.mjs:91) over the real installedLocalProviderModels', notRun: 'the inner OpenAI-compatible send is scripted and ensureServer is injected, as mixdog-local.test.mjs does: no server starts, no request is sent' },
  replay: {
    entry: 'mixdog-services local_provider tests: RegisteredAdapter (mixdog-ai providers/local) over the real LocalProvider (ManagedRuntime) with the same scripts as a scripted wire, on a paused clock; compare the measured state whole (the `at` stamp and the failure text excepted) and what reached the wire while the first send held the slot',
    declaredExclusions: [
      { keys: ['at'], reason: 'the wall-clock stamp of a finished inference (new Date().toISOString(), the recorded fixed instant); Rust stamps the real time, so the replay checks it is an ISO-8601 instant' },
      { case: 'a failed send is measured as failed and its error is rethrown', keys: ['error', 'threw'], reason: 'the text is the scripted error of Node (boom); the Rust failure is a transport fault of the scripted wire with its own text, which the replay compares to the error the send returned, and is limited to 1024 characters' },
    ],
    inputs: { clock: 'performance.now is virtual (advance steps only); the Rust replay runs on a paused tokio clock and advances it by the same amounts', ensureServer: 'injected: a fixed endpoint, no server start' },
  },
});
process.exit(0);
