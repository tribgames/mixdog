#!/usr/bin/env node
// Golden twin of the scalar setup actions (`set_system_shell`, `set_auto_update`,
// `set_ai_session_titles`, `set_quota_auto_resume`, `set_heartbeat_enabled`,
// `set_heartbeat_interval`, `set_reactions_enabled`, `set_profile`, `set_developer_option`): the
// receipt (or refusal text) the real `createSetupToolExecutor` answers over the real settings
// facades (`settings-system-api`, `settings-builtin-tools-api`, `settings-developer-api`,
// `settings-profile-api`) and the real quota-resume store, for deterministic agent configs.
//
//   node benchmarks/rust-core/recorders/record-setup-settings.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every user directory points at a fresh temp dir before any Mixdog module is imported.
const sandbox = mkdtempSync(join(tmpdir(), 'setup-settings-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}
delete process.env.MIXDOG_SHELL;

const { FIXTURES_ROOT, importFrom, parseArgs, resolveTree, writeJson } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const { createSetupToolExecutor } = await importFrom(tree, 'src/session-runtime/setup-tool/executor.mjs');
const { createBuiltinToolSettings } = await importFrom(tree, 'src/session-runtime/settings-builtin-tools-api.mjs');
const { createSystemSettings } = await importFrom(tree, 'src/session-runtime/settings-system-api.mjs');
const { createDeveloperSettings } = await importFrom(tree, 'src/session-runtime/settings-developer-api.mjs');
const { createProfileSettings } = await importFrom(tree, 'src/session-runtime/settings-profile-api.mjs');
const { createRuntimeFeatureGates } = await importFrom(tree, 'src/session-runtime/runtime-feature-gates.mjs');
const profileModule = await importFrom(tree, 'src/runtime/shared/profile-config.cjs');
const cfgMod = profileModule.default ?? profileModule;
const helpers = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
const quota = await importFrom(tree, 'src/runtime/shared/quota-resume-store.mjs');
const sharedConfig = await importFrom(tree, 'src/runtime/shared/config.mjs');

let seed = 0x5e7a11c3;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

function randomConfig() {
  const config = { providers: { openai: { apiKey: 'sk-fake' } }, other: { keep: true } };
  if (chance(0.5)) config.heartbeat = pick([true, false, 'yes', 1]);
  if (chance(0.5)) config.heartbeatIntervalMinutes = pick([30, 60, 120, 240, 45, '60', null]);
  if (chance(0.5)) config.reactions = pick([true, false, 0, null]);
  if (chance(0.5)) config.aiSessionTitles = pick([true, false, 0, null]);
  if (chance(0.5)) config.shell = pick([{}, { command: 'pwsh' }, { command: ' bash ' }, { command: 3 }, null, { command: 'pwsh', note: 1 }]);
  // An absent `developer` would make Node read this machine's config file (a default parameter).
  config.developer = pick([{}, { allowAllActions: true }, { cursorOAuth: false, bogus: 'x' }, { mimoOAuth: true, devinOAuth: true }, 'x']);
  if (chance(0.6)) config.profile = pick([{}, { title: 'Kim', language: 'ko', experienceLevel: 'expert' }, { name: ' Lee ', lang: 'ja' }, { language: 'xx', experienceLevel: 'Vibe Coder' }, 'x', null]);
  if (chance(0.5)) config.update = pick([{}, { auto: true }, { auto: false }, { auto: 'yes', other: 1 }]);
  return config;
}

const ACTIONS = [
  ...['pwsh', 'auto', ' AUTO ', '  bash ', '', '"pwsh.exe"', 'zsh', '   '].map((command) => ({ action: 'set_system_shell', command })),
  ...[true, false].map((enabled) => ({ action: 'set_auto_update', enabled })),
  ...[true, false].map((enabled) => ({ action: 'set_ai_session_titles', enabled })),
  ...[true, false].map((enabled) => ({ action: 'set_heartbeat_enabled', enabled })),
  ...[30, 60, 120, 240].map((minutes) => ({ action: 'set_heartbeat_interval', minutes })),
  ...[true, false].map((enabled) => ({ action: 'set_reactions_enabled', enabled })),
  { action: 'set_profile', profile: {} },
  { action: 'set_profile', profile: { title: ' Dr. Who ' } },
  { action: 'set_profile', profile: { title: 'N'.repeat(70) } },
  { action: 'set_profile', profile: { language: 'ko' } },
  { action: 'set_profile', profile: { language: 'system' } },
  { action: 'set_profile', profile: { language: 'xx' } },
  { action: 'set_profile', profile: { language: ' ko ' } },
  { action: 'set_profile', profile: { experienceLevel: 'expert' } },
  { action: 'set_profile', profile: { experienceLevel: '' } },
  { action: 'set_profile', profile: { experienceLevel: 'Expert' } },
  { action: 'set_profile', profile: { title: 'Kim', language: 'en', experienceLevel: 'junior' } },
  { action: 'set_profile', profile: { title: '😀'.repeat(40), language: 'ja' } },
  ...['allowAllActions', 'antigravityOAuth', 'cursorOAuth', 'devinOAuth', 'mimoOAuth', 'nope'].flatMap((name) => [
    { action: 'set_developer_option', name, enabled: true },
    { action: 'set_developer_option', name, enabled: true, riskAccepted: true },
    { action: 'set_developer_option', name, enabled: true, riskAccepted: false },
    { action: 'set_developer_option', name, enabled: false },
  ]),
];

async function run(config, args) {
  let current = structuredClone(config);
  const save = (next) => { current = structuredClone(next); };
  const gates = createRuntimeFeatureGates({ getConfig: () => current, getToolProfile: () => 'interactive' });
  const builtin = createBuiltinToolSettings(
    {
      getConfig: () => current,
      saveConfigAndAdopt: save,
      setRecapEnabledInConfig: helpers.setRecapEnabledInConfig,
      setMemoryToolsEnabledInConfig: helpers.setMemoryToolsEnabledInConfig,
      setModuleEnabledInConfig: helpers.setModuleEnabledInConfig,
      prepareBuiltinFeature: async () => {},
      stopLocalProviderServer: async () => {},
      syncLocalProviderRegistry: async () => {},
      invalidateContextStatusCache: () => {},
      invalidatePreSessionToolSurface: () => {},
      ...gates,
    },
    { status: () => ({ installationCommandError: null }) }
  );
  const system = createSystemSettings({
    getConfig: () => current,
    saveConfigAndAdopt: save,
    normalizeSystemShellConfig: helpers.normalizeSystemShellConfig,
    normalizeSystemShellCommand: helpers.normalizeSystemShellCommand,
    setConfiguredShell: () => {},
    autoUpdateEnabled: () => current?.update?.auto !== false,
    getUpdateCheckState: () => ({ currentVersion: '1.0.0', latestVersion: null, updateAvailable: false, lastCheckedAt: null }),
    localPackageVersion: () => '1.0.0',
  });
  const developer = createDeveloperSettings({ getConfig: () => current, saveConfigAndAdopt: save, syncDeveloperOption: async () => {} });
  const profile = createProfileSettings({
    getConfig: () => current,
    saveConfigAndAdopt: save,
    hasOwn: Object.hasOwn,
    cfgMod,
    summarizeWorkflowRoutes: () => ({}),
    ONBOARDING_VERSION: 1,
  });
  // The runtime facade the executor reads: the real factories spread into one object, as the
  // runtime assembles them, and the session object's quota auto-resume setter (`quota-resume.mjs`).
  const rt = {
    ...system,
    setAiSessionTitles: builtin.setAiSessionTitles,
    getSessionTitleSettings: builtin.getSessionTitleSettings,
    ...developer,
    ...profile,
    setQuotaAutoResume: (enabled) => {
      if (typeof enabled !== 'boolean') throw new TypeError('quota auto resume must be boolean');
      return quota.setQuotaAutoResumeEnabled(enabled);
    },
  };
  const id = 'sess_human';
  const record = { id, sourceType: 'lead' };
  const executor = createSetupToolExecutor({
    getApi: () => rt,
    getConfig: () => current,
    getSessionId: () => id,
    getCallerSession: (sid) => (sid === id ? record : null),
    notifySessionUi: () => false,
    flushSettings: async () => {},
  });
  try {
    return { ok: true, answer: JSON.parse(await executor.execute(structuredClone(args), { callerSessionId: id })) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

const entries = [];
for (let i = 0; i < 12; i += 1) {
  const config = randomConfig();
  for (const args of ACTIONS) entries.push({ config, args, result: await run(config, args) });
}

// The quota auto-resume setting lives in the config file's `quotaResume` section and turning it
// off drops every pending resume: recorded against the real store, from a clean data dir.
const quotaEntries = [];
const dataDir = process.env.MIXDOG_DATA_DIR;
for (const stored of [undefined, { autoResume: true }, { autoResume: false }, { other: 1 }]) {
  for (const pending of [false, true]) {
    for (const enabled of [true, false]) {
      rmSync(join(dataDir, quota.QUOTA_RESUME_FILE), { force: true });
      quota.reloadQuotaResumeStore();
      sharedConfig.updateSection('quotaResume', () => structuredClone(stored ?? {}));
      if (pending) {
        quota.scheduleQuotaResumeEntry({ sessionId: 'sess_a', turnKey: 't1', provider: 'openai', resetAt: Date.now() + 3_600_000 });
      }
      const result = await run({}, { action: 'set_quota_auto_resume', enabled });
      quotaEntries.push({
        stored: stored ?? null,
        pending,
        args: { action: 'set_quota_auto_resume', enabled },
        result,
        section: sharedConfig.readSection('quotaResume'),
        entries: quota.listQuotaResumeEntries().length,
      });
    }
  }
}

writeJson(join(FIXTURES_ROOT, 'desktop', 'settings', 'setup-settings-twin.json'), {
  domain: 'setup-settings-twin',
  recorder: 'benchmarks/rust-core/recorders/record-setup-settings.mjs',
  platform: process.platform,
  entries,
  quota: quotaEntries,
});
console.log(`recorded ${entries.length} scalar setup calls and ${quotaEntries.length} quota calls`);