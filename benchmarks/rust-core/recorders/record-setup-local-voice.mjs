#!/usr/bin/env node
// Golden twin of the setup tool's local-model actions (install_local_model, start/cancel_local_
// installation, set_local_idle_ttl, search/inspect/register/details/maintain/delete) and of its
// voice actions (`set_builtin_enabled` / `install_builtin` with name "voice"). Each case runs the
// real executor (`setup-tool/executor.mjs`) over the real `createLocalProviderSettings` and
// `createLocalModelApi` methods with recording fakes for what needs the network, a config file
// or a running provider; it keeps what Node answered (the receipt or the error text) and the
// runtime calls it made. Rust `local_provider::setup_actions` and `voice::setup_action` must
// give the same argument errors and failure texts, and the same receipt members.
//
//   node benchmarks/rust-core/recorders/record-setup-local-voice.mjs --tree <dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Provider and voice state would otherwise land in the real profile.
const data = mkdtempSync(join(tmpdir(), 'mixdog-setup-lv-'));
for (const key of ['MIXDOG_DATA_DIR', 'HOME', 'USERPROFILE', 'CLAUDE_PLUGIN_DATA']) process.env[key] = data;

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const { createLocalProviderSettings } = await importFrom(tree, 'src/session-runtime/local-provider-settings.mjs');
const { cancelLocalInstallation } = await importFrom(tree, 'src/runtime/local-provider/install-progress.mjs');

const STATUS = {
  idleTtlSeconds: 3600,
  installations: [],
  models: [{ id: 'm1' }],
  installationCommandError: null,
};
const plain = (v) => (v === undefined ? { absent: true } : JSON.parse(JSON.stringify(v)));

function localFacade(calls) {
  let config = { providers: {} };
  const settings = createLocalProviderSettings({
    getConfig: () => config,
    saveConfigAndAdopt: (next) => {
      config = next;
      calls.push({ method: 'saveConfigAndAdopt', args: [plain(next.providers?.local ?? next.providers)] });
    },
    getLocalProviderStatus: () => ({ models: STATUS.models, installations: [] }),
    prepareLocalProviderModel: async (id) => calls.push({ method: 'prepareLocalProviderModel', args: [id] }),
    refreshLocalProviderCatalog: async () => {},
    cancelLocalProviderInstallation: cancelLocalInstallation,
    discardLocalProviderInstallation: () => {},
    configureLocalProviderIdleTtl: (seconds) => calls.push({ method: 'configureLocalProviderIdleTtl', args: [seconds] }),
  });
  const facade = {
    ...settings.methods,
    getToolModuleSettings: () => ({ localProvider: STATUS }),
    installBuiltinFeature: async (name) => {
      calls.push({ method: 'installBuiltinFeature', args: [name] });
      return {};
    },
  };
  return new Proxy(facade, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== 'function' || name === 'getToolModuleSettings') return value;
      return (...args) => {
        calls.push({ method: String(name), args: args.map(plain) });
        return value.apply(target, args);
      };
    },
  });
}

const VOICE_COMPONENTS = { whisper: true, model: true, ffmpeg: true };
const VOICE = {
  enabled: { status: { enabled: true, installed: true, busy: false, modelId: 'standard', info: {}, components: VOICE_COMPONENTS }, error: null },
  disabled: { status: { enabled: false, installed: true, busy: false, modelId: 'standard', info: {}, components: VOICE_COMPONENTS }, error: null },
  busy: { status: { enabled: false, installed: false, busy: true, modelId: 'standard', info: {}, components: { whisper: false, model: false, ffmpeg: false } }, error: 'Voice install is already running' },
  installFailed: { status: { enabled: false, installed: false, busy: false, modelId: 'standard', info: {}, components: { whisper: true, model: false, ffmpeg: false } }, error: 'Voice setup failed: sha256 mismatch' },
  offFailed: { status: { enabled: true, installed: true, busy: false, modelId: 'standard', info: {}, components: VOICE_COMPONENTS }, error: 'Voice OFF failed: config is locked' },
  incomplete: { status: { enabled: true, installed: false, busy: false, modelId: 'standard', info: {}, components: { whisper: true, model: false, ffmpeg: true } }, error: null },
};

async function outcome(run) {
  try {
    return { receipt: JSON.parse(await run()) };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
}

const run = async (facade, args) => {
  const executor = createSetupToolExecutor({ getApi: () => facade, getConfig: () => ({}) });
  return executor.execute(args);
};

const long = 'q'.repeat(201);
const LOCAL = [
  { action: 'install_local_model', modelId: ' m1 ' },
  { action: 'install_local_model', modelId: '  ' },
  { action: 'install_local_model' },
  { action: 'install_local_model', modelId: 12 },
  { action: 'start_local_installation', phase: 'runtime' },
  { action: 'start_local_installation', phase: ' model ', modelId: 'm1' },
  { action: 'start_local_installation', phase: 'model', modelId: 'ghost' },
  { action: 'start_local_installation', phase: 'model' },
  { action: 'start_local_installation', phase: 'runtime', modelId: 'm1' },
  { action: 'start_local_installation', phase: 'runtime', modelId: '' },
  { action: 'start_local_installation', phase: 'disk' },
  { action: 'start_local_installation' },
  { action: 'cancel_local_installation', jobId: 'nope' },
  { action: 'cancel_local_installation', jobId: ' ' },
  { action: 'cancel_local_installation' },
  { action: 'set_local_idle_ttl', idleTtlSeconds: 30 },
  { action: 'set_local_idle_ttl', idleTtlSeconds: 0 },
  { action: 'set_local_idle_ttl', idleTtlSeconds: 86400 },
  { action: 'set_local_idle_ttl', idleTtlSeconds: 5.0 },
  { action: 'set_local_idle_ttl' },
  { action: 'set_local_idle_ttl', idleTtlSeconds: 86401 },
  { action: 'set_local_idle_ttl', idleTtlSeconds: -1 },
  { action: 'set_local_idle_ttl', idleTtlSeconds: 1.5 },
  { action: 'set_local_idle_ttl', idleTtlSeconds: '30' },
  { action: 'set_local_idle_ttl', idleTtlSeconds: null },
  { action: 'search_local_models' },
  { action: 'search_local_models', query: ' ' },
  { action: 'search_local_models', query: long },
  { action: 'inspect_hf_model' },
  { action: 'inspect_hf_model', repository: 'not a repo' },
  { action: 'inspect_hf_model', repository: 'owner/name', contextWindow: 100 },
  { action: 'inspect_hf_model', repository: 'owner/name', contextWindow: 40000 },
  { action: 'inspect_hf_model', repository: 'owner/name', contextWindow: 16384.5 },
  { action: 'inspect_hf_model', repository: 'owner/name', contextWindow: null },
  { action: 'register_hf_model', previewId: 'x' },
  { action: 'register_hf_model', previewId: 'x', licenseAccepted: 'yes' },
  { action: 'register_hf_model', licenseAccepted: true },
  { action: 'register_hf_model', previewId: 'ghost', licenseAccepted: true },
  { action: 'register_hf_model', previewId: 'ghost', licenseAccepted: false },
  { action: 'local_model_details' },
  { action: 'local_model_details', modelId: 'ghost' },
  { action: 'maintain_local_model', modelId: 'ghost', operation: 'verify' },
  { action: 'maintain_local_model', modelId: 'ghost', operation: 'execute' },
  { action: 'maintain_local_model', modelId: 'ghost' },
  { action: 'maintain_local_model', operation: 'repair' },
  { action: 'delete_local_model' },
  { action: 'delete_local_model', confirmationToken: 'expired' },
];

const cases = [];
for (const args of LOCAL) {
  const calls = [];
  const result = await outcome(() => run(localFacade(calls), args));
  await new Promise((resolve) => setImmediate(resolve));
  cases.push({ kind: 'local', args, calls: plain(calls), ...result });
}

const VOICE_ARGS = [
  { action: 'set_builtin_enabled', name: 'voice', enabled: true },
  { action: 'set_builtin_enabled', name: 'voice', enabled: false },
  { action: 'install_builtin', name: 'voice' },
];
for (const [scenario, answer] of Object.entries(VOICE)) {
  for (const args of VOICE_ARGS) {
    const calls = [];
    const facade = { setVoiceEnabled: async (enabled) => (calls.push({ method: 'setVoiceEnabled', args: [enabled] }), plain(answer)) };
    cases.push({ kind: 'voice', scenario, args, answer, calls, ...(await outcome(() => run(facade, args))) });
  }
}

writeJson(join(FIXTURES_ROOT, 'services', 'setup-local-voice-twin.json'), {
  domain: 'setup-local-voice-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-local-voice.mjs',
  status: STATUS,
  cases,
});
console.log(`recorded ${cases.length} cases (${cases.filter((c) => c.error).length} errors)`);
