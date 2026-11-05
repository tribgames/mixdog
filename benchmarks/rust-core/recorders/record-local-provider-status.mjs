#!/usr/bin/env node
// Golden of the real `localProviderStatus()` value and of the `localProvider` member of
// `getToolModuleSettings()` built from it, for the protocol's `ToolModuleSettings` (WP-PROTO).
// The tool-modules twin feeds stub status objects, so it cannot show the real shape: this
// recorder drives the product's own catalog, hardware probe, model state, installation tracker
// and server-process code with fake data only (temp data dir, fake GPU output, fake spawn).
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-local-provider-status.mjs --tree <dir>
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const { localProviderStatus } = await importFrom(tree, 'src/runtime/local-provider/managed-runtime.mjs');
const { createHardwareProbe } = await importFrom(tree, 'src/runtime/local-provider/hardware.mjs');
const state = await importFrom(tree, 'src/runtime/local-provider/model-state.mjs');
const { trackLocalInstallation, cancelLocalInstallation } = await importFrom(tree, 'src/runtime/local-provider/install-progress.mjs');
const { createLocalServerProcess } = await importFrom(tree, 'src/runtime/local-provider/server-process.mjs');
const { createBuiltinToolSettings } = await importFrom(tree, 'src/session-runtime/settings-builtin-tools-api.mjs');
const { createRuntimeFeatureGates } = await importFrom(tree, 'src/session-runtime/runtime-feature-gates.mjs');
const helpers = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');

const NVIDIA = [
  '0, GPU-aaaaaaaa-0000-0000-0000-000000000001, Fake RTX 4090, 24564, 20000',
  '1, GPU-aaaaaaaa-0000-0000-0000-000000000002, Fake RTX 3060, 12288, 12000',
].join('\n');

async function hardware(platform, arch, queries) {
  const probe = createHardwareProbe({ platform, arch, now: () => 1_700_000_000_000, ...queries });
  await probe.refresh({ force: true });
  return probe.status();
}

const nvidia = await hardware('linux', 'x64', { queryFn: async () => NVIDIA });
const apple = await hardware('darwin', 'arm64', {
  appleQueryFn: async () => ({ name: 'Fake Apple M3', totalBytes: 17179869184, wiredLimitMb: 0 }),
});
const noGpu = await hardware('linux', 'x64', { queryFn: async () => { throw new Error('nvidia-smi not found'); } });
const unsupported = await hardware('freebsd', 'x64', {});

const cases = [];
const record = (name, dataDir, hw, platform, arch, extra = {}) => {
  cases.push({ name, hardware: hw, platform, arch, status: localProviderStatus({ dataDir, hardware: hw, platform, arch }), ...extra });
};
const fresh = () => mkdtempSync(join(tmpdir(), 'mixdog-lp-'));

record('fresh-nvidia', fresh(), nvidia, 'linux', 'x64');
record('fresh-apple', fresh(), apple, 'darwin', 'arm64');
record('no-gpu', fresh(), noGpu, 'linux', 'x64');
record('unsupported-platform', fresh(), unsupported, 'freebsd', 'x64');

// Model state: a loaded model, then each inference outcome and a verification.
const modelId = cases[0].status.models[0].id;
const dir = fresh();
state.recordLocalModelLoad(modelId, { chat_template_caps: { supports_tools: true, supports_tool_calls: true } }, 1234.6);
record('loaded', dir, nvidia, 'linux', 'x64');
const running = state.beginLocalInference(modelId, performance.now() - 5);
record('inference-running', dir, nvidia, 'linux', 'x64');
running.progress('text');
running.finish({ usage: { outputTokens: 40, inputTokens: 100 } }, null);
record('inference-complete', dir, nvidia, 'linux', 'x64');
state.beginLocalInference(modelId, performance.now()).finish(null, new Error('boom'));
record('inference-failed', dir, nvidia, 'linux', 'x64');
state.recordLocalModelVerification(modelId, { valid: true, sizeBytes: 123, sha256: 'a'.repeat(64) });
record('verified', dir, nvidia, 'linux', 'x64');
state.recordLocalModelLoad(modelId, { chat_template_caps: { supports_tools: false } }, null);
record('tools-denied-no-load-time', dir, nvidia, 'linux', 'x64');
state.recordLocalModelLoad(modelId, {}, 10);
record('tools-unknown', dir, nvidia, 'linux', 'x64');

// Installation jobs in every state.
const jobs = fresh();
let release;
const held = new Promise((resolve) => { release = resolve; });
const never = trackLocalInstallation(jobs, { phase: 'runtime' }, (progress) => { progress({ stage: 'downloading', percent: 12.4 }); return held; });
const failing = trackLocalInstallation(jobs, { phase: 'model', modelId: 'fake-failed' }, async () => { throw new Error('download failed'); }).catch(() => {});
await failing;
const pausing = trackLocalInstallation(jobs, { phase: 'model', modelId: 'fake-paused' }, (_p, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
const pausedJob = cases.length;
record('installing-cancelling-not-yet', jobs, nvidia, 'linux', 'x64');
const pausingJob = cases[pausedJob].status.installations.find((job) => job.modelId === 'fake-paused');
await new Promise((resolve) => setTimeout(resolve, 10)); // the operation attaches its abort listener on a microtask
cancelLocalInstallation(pausingJob.jobId, jobs);
await pausing.catch(() => {});
await trackLocalInstallation(jobs, { phase: 'model', modelId: 'fake-done' }, async () => 'ok');
record('installations-mixed', jobs, nvidia, 'linux', 'x64');
release();
await never;

// A server that exited unexpectedly: lastExit, lastError, loadTimeMs.
const children = [];
const manager = createLocalServerProcess({
  portFn: async () => 54321,
  fetchFn: async () => new Response('ok'),
  pollMs: 1,
  stopTimeoutMs: 20,
  spawnFn() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; };
    children.push(child);
    return child;
  },
});
const spec = { key: 'fake-model-path', modelId: 'fake-model', executable: 'not-executed', cwd: '.', args: (port, key) => ['--port', String(port), '--api-key', key], gpu: nvidia.gpu };
const serverStates = {};
await manager.ensure(spec);
serverStates.running = manager.status();
children[0].stderr.emit('data', 'GPU failure');
children[0].emit('exit', 7, null);
serverStates.crashed = manager.status();
await manager.ensure(spec);
await manager.stop();
serverStates.stopped = manager.status();

// The full read, as the desktop receives it.
let config = { providers: { openai: { apiKey: 'sk-fake' } } };
const gates = createRuntimeFeatureGates({ getConfig: () => config, getToolProfile: () => 'interactive' });
const api = createBuiltinToolSettings(
  {
    getConfig: () => config,
    saveConfigAndAdopt: (next) => { config = structuredClone(next); },
    setRecapEnabledInConfig: helpers.setRecapEnabledInConfig,
    setMemoryToolsEnabledInConfig: helpers.setMemoryToolsEnabledInConfig,
    setModuleEnabledInConfig: helpers.setModuleEnabledInConfig,
    prepareBuiltinFeature: async () => {},
    getLocalProviderStatus: () => localProviderStatus({ dataDir: jobs, hardware: nvidia, platform: 'linux', arch: 'x64' }),
    stopLocalProviderServer: async () => {},
    syncLocalProviderRegistry: async () => {},
    invalidateContextStatusCache: () => {},
    invalidatePreSessionToolSurface: () => {},
    ...gates,
  },
  { status: () => ({ installationCommandError: 'install failed' }) }
);
const toolModuleSettings = api.getToolModuleSettings();

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'local-provider-status.json'), {
  domain: 'local-provider-status',
  recorder: 'benchmarks/rust-core/recorders/record-local-provider-status.mjs',
  note: 'jobId is a random uuid and updatedAt a wall clock; consumers must not compare them.',
  cases,
  serverStates,
  toolModuleSettings,
});
console.log(`recorded ${cases.length} local-provider statuses`);
