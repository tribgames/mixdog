#!/usr/bin/env node
// context-settings.test.mjs (4 tests): the real local-provider context settings (persist / validate / reset, corrupt-file fallback, the
// request-queue gate that makes an apply wait for inference, and the agent-minimum for a legacy registration) over the data directory of the
// recording (the files the product writes are recorded: path relative to the data dir, bytes).
//   node benchmarks/rust-core/recorders/record-local-context-settings.mjs --tree <exact export of b6f10295a>
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-local-context-settings',
  net: false,
  entry: 'src/runtime/local-provider/context-settings.mjs localContextSettings / saveLocalContext, catalog.mjs LOCAL_PROVIDER_MANIFEST / localProviderCatalogStatus({ dataDir }), server.mjs runLocalProviderRequest / setLocalProviderContext(modelId, tokens, { dataDir }). The queue gate is a promise the recorder resolves (no timer); after 1 ms of virtual time (due timers run, microtasks drained) the apply has not run.',
  compare: 'mixdog-services local_provider context.rs:94-106, request_queue.rs:124-144 and gguf.rs (agent minimum): compare the settings rows and thrown errors whole, the context files written (`files`: an object keyed by the path relative to the case data dir (directory-walk order, not a claim), value the file text) and, for the gate case, the ordered `steps`.',
  replay: "Rust entry (pub, on o1): mixdog_services::local_provider local_context_settings (context.rs:48), save_local_context (context.rs:75), Catalog::status (catalog.rs:224), RequestQueue::run (request_queue.rs:124), download_verified_asset (assets.rs:324); the local provider adapter is mixdog_ai::providers::local::adapter() (local/mod.rs:109).",
});
const SRC = 'src/runtime/local-provider/context-settings.test.mjs';
const { localContextSettings, saveLocalContext } = await rec.P('local-provider/context-settings.mjs');
const { LOCAL_PROVIDER_MANIFEST, localProviderCatalogStatus } = await rec.P('local-provider/catalog.mjs');
const { runLocalProviderRequest, setLocalProviderContext } = await rec.P('local-provider/server.mjs');
const entry = LOCAL_PROVIDER_MANIFEST.models[0];
// The recorder's own file steps (case directories, reading back the files written, writing the corrupt file a case feeds) run through `rec.own`: a
// failure of them stops the recording, it is never a case's answer.
const caseDir = (name) => rec.own(`creating the case directory ${name}`, () => {
  const dir = join(rec.dataDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
});
const filesOf = (dir) => rec.own(`reading the files under ${dir}`, () => {
  const out = {};
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out[relative(dir, p).split('\\').join('/')] = readFileSync(p, 'utf8'); } };
  walk(dir);
  return out;
});
const attempt = (fn) => {
  try {
    return { result: fn() };
  } catch (error) {
    return { error };
  }
};

await rec.run('persist-validate-reset', `${SRC}:10`, { entry: { id: entry.id, contextWindow: entry.contextWindow, maxContextWindow: entry.maxContextWindow } }, () => {
  const dataDir = caseDir('ctx-persist');
  const out = { initial: localContextSettings(entry, dataDir), saved: [] };
  for (const tokens of [16384, 32768, entry.maxContextWindow]) {
    saveLocalContext(entry, tokens, dataDir);
    const model = localProviderCatalogStatus({ dataDir }).models.find((row) => row.id === entry.id);
    out.saved.push({ tokens, model });
  }
  out.invalid = [0, 511, 8192, 16383, 1.5, '16384', undefined, NaN, Infinity, entry.maxContextWindow + 1].map((value) => ({ value, ...attempt(() => saveLocalContext(entry, value, dataDir)) }));
  out.otherModel = localContextSettings({ ...entry, id: 'another-model' }, dataDir);
  out.filesAfterSaves = filesOf(dataDir);
  saveLocalContext(entry, null, dataDir);
  out.afterReset = localContextSettings(entry, dataDir);
  out.filesAfterReset = filesOf(dataDir);
  return out;
});
await rec.run('corrupt-or-out-of-range-file-falls-back', `${SRC}:33`, {}, () => {
  const dataDir = caseDir('ctx-corrupt');
  saveLocalContext(entry, 16384, dataDir);
  const ctxDir = join(dataDir, 'local-provider', 'context');
  const file = rec.own('finding the context file', () => join(ctxDir, readdirSync(ctxDir)[0]));
  const rows = [];
  for (const contents of ['{not json', 'null', JSON.stringify({ tokens: entry.maxContextWindow + 1 }), JSON.stringify({ tokens: 8192 })]) {
    rec.own('writing the context file', () => writeFileSync(file, contents));
    const settings = localContextSettings(entry, dataDir);
    rows.push({ contents, settings, defaultContextWindow: entry.contextWindow });
  }
  return { rows };
});
// Every step that decides the order is an input (`input.steps`) and an event of the recorded ordered list `steps`, the gate release included.
const APPLY_STEPS = ['start an inference request that holds the request slot behind a gate', 'call setLocalProviderContext(entry.id, 16384)', 'advance the virtual clock 1 ms', 'read the configured context window (the change must not have applied)', 'release the gate', 'await the inference and the change', 'read the runtime context window', 'call setLocalProviderContext("missing", 16384)'];
await rec.run('apply-waits-for-inference-then-exposes-capacity', `${SRC}:55`, { steps: APPLY_STEPS }, async () => {
  const dataDir = caseDir('ctx-queue');
  const steps = [];
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  steps.push({ event: 'inference-started' });
  const inference = runLocalProviderRequest(async (signal) => { await gate; steps.push({ event: 'inference-ran', inferenceSignalAborted: signal.aborted }); });
  steps.push({ event: 'change-requested', tokens: 16384 });
  const change = setLocalProviderContext(entry.id, 16384, { dataDir });
  await rec.clock.advance(1, { what: 'one millisecond while the inference holds the slot' });
  steps.push({ event: 'read-configured', settings: localContextSettings(entry, dataDir) });
  steps.push({ event: 'gate-released' });
  finish();
  await Promise.all([inference, change]);
  steps.push({ event: 'read-runtime', settings: localContextSettings(entry, dataDir) });
  steps.push({ event: 'change-requested', model: 'missing', tokens: 16384 });
  const missing = await setLocalProviderContext('missing', 16384, { dataDir }).then(() => undefined, (error) => error);
  return { steps, unknownModel: missing, files: filesOf(dataDir) };
});
await rec.run('below-agent-minimum-runs-at-gguf-minimum', `${SRC}:80`, {}, () => {
  const dataDir = caseDir('ctx-legacy');
  const legacy = { id: 'legacy-model', contextWindow: 8192, maxContextWindow: 131072 };
  const small = { id: 'small-model', contextWindow: 4096, maxContextWindow: 4096 };
  return { legacy: localContextSettings(legacy, dataDir), small: localContextSettings(small, dataDir) };
});
await rec.finish();
