#!/usr/bin/env node
// Golden twin of the scalar settings of the agent config: heartbeat, reactions, AI session
// titles, prompt-cache warming, bot order, system shell, developer options, recap and the
// starter-guide save (`settings-system-api.mjs`, `settings-builtin-tools-api.mjs`,
// `settings-developer-api.mjs`, `settings-profile-api.mjs`). 120 deterministic (fake) agent
// configs; each entry holds the reads on the config and, per setter, the config Node saved, the
// effect calls and the value or error text. `platform` and `shellEnv` are recorded because the
// system-shell rule depends on them.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs \
//        benchmarks/rust-core/recorders/record-config-settings.mjs --tree <dir>
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const cli = parseArgs();
const tree = resolveTree(cli);
// The Node commit the fixture is recorded from; the manifest names it only when the tree is exactly this commit.
const NODE_COMMIT = execFileSync('git', ['rev-parse', 'b6f10295a^{commit}'], { cwd: tree, encoding: 'utf8' }).trim();
const outDir = cli.get('out') ?? join(FIXTURES_ROOT, 'config-settings');
const { createBuiltinToolSettings } = await importFrom(tree, 'src/session-runtime/settings-builtin-tools-api.mjs');
const { createSystemSettings } = await importFrom(tree, 'src/session-runtime/settings-system-api.mjs');
const { createDeveloperSettings } = await importFrom(tree, 'src/session-runtime/settings-developer-api.mjs');
const { createProfileSettings } = await importFrom(tree, 'src/session-runtime/settings-profile-api.mjs');
const { createRuntimeFeatureGates } = await importFrom(tree, 'src/session-runtime/runtime-feature-gates.mjs');
const profileModule = await importFrom(tree, 'src/runtime/shared/profile-config.cjs');
const cfgMod = profileModule.default ?? profileModule;
const helpers = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs');
const cfgReal = await importFrom(tree, 'src/runtime/agent/orchestrator/config.mjs');
const { withGrandfatheredBuiltins } = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/builtin-features.mjs');

// Node's own config file (config.mjs persistence) in a directory of this run; every save goes through the saveConfigAndAdopt of
// config-lifecycle.mjs, so the file is what the runtime would have stored.
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
const cfgDir = mkdtempSync(join(tmpdir(), 'settings-config-'));
process.env.MIXDOG_DATA_DIR = cfgDir;
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(cfgDir, 'backups');
const cfgFile = join(cfgDir, 'mixdog-config.json');

let seed = 0x3e771a95;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;

const DEV_IDS = ['allowAllActions', 'antigravityOAuth', 'cursorOAuth', 'devinOAuth', 'mimoOAuth'];
const IDS = ['a', ' b ', 'c', 'a', 'd'.repeat(128), 'e'.repeat(129), '', '  '];

function randomConfig() {
  const config = { providers: { openai: { apiKey: 'sk-fake' } }, other: { keep: true } };
  if (chance(0.5)) config.heartbeat = pick([true, false, 'yes', 1]);
  if (chance(0.5)) config.heartbeatIntervalMinutes = pick([30, 60, 120, 240, 45, '60', null]);
  if (chance(0.5)) config.reactions = pick([true, false, 0, null]);
  if (chance(0.5)) config.aiSessionTitles = pick([true, false, 0, null]);
  if (chance(0.5)) config.promptCacheWarming = pick([true, false, 'on']);
  if (chance(0.5)) config.botOrder = pick([[], ['x', 'y'], [' x ', 'x', 7, ''], 'x', ['z']]);
  if (chance(0.5)) config.shell = pick([{}, { command: 'pwsh' }, { command: ' bash ' }, { command: 3 }, null, { command: 'pwsh', note: 1 }]);
  // An absent `developer` would make Node read this machine's config file (a default parameter),
  // so the corpus always sets it.
  config.developer = pick([{}, { allowAllActions: true }, { cursorOAuth: false, bogus: 'x' }, { mimoOAuth: true, devinOAuth: true }, 'x']);
  if (chance(0.5)) config.profile = pick([{}, { title: 'Kim', language: 'ko', experienceLevel: 'expert' }, { name: ' Lee ', lang: 'ja' }, { language: 'xx', experienceLevel: 'Vibe Coder' }, 'x', null]);
  if (chance(0.3)) config.update = pick([{}, { auto: true }, { auto: 'yes', other: 1 }]);
  if (chance(0.4)) config.recap = pick([{ enabled: false }, { enabled: true }, {}]);
  if (chance(0.5)) {
    config.onboarding = pick([
      {},
      { completed: true },
      { starterGuide: { closed: true, welcomed: false, visited: ['provider', 'bogus'] } },
      { starterGuide: 'x' },
      { starterGuide: { visited: ['remote', 'project'] } },
    ]);
  }
  return config;
}

const valid = () => ({ closed: chance(0.5), welcomed: chance(0.5), visited: pick([[], ['provider'], ['remote', 'project'], ['provider', 'provider']]) });
const GUIDES = () => pick([valid(), valid(), 'x', null, { closed: true }, { ...valid(), extra: 1 }, { ...valid(), closed: 'yes' }, { ...valid(), visited: ['bogus'] }, { ...valid(), visited: Array(11).fill('provider') }]);

const entries = [];
for (let i = 0; i < 120; i += 1) {
  const config = randomConfig();
  const shellEnv = i % 3 === 0 ? 'pwsh' : i % 3 === 1 ? '  ' : null;
  if (shellEnv === null) delete process.env.MIXDOG_SHELL;
  else process.env.MIXDOG_SHELL = shellEnv;
  const run = async (call) => {
    writeFileSync(cfgFile, JSON.stringify({ agent: structuredClone(config), defaultsVersion: 2 }));
    // adoptConfig / saveConfigAndAdopt of config-lifecycle.mjs: the runtime keeps the adopted config in memory; the file takes the
    // patch against the previous baseline plus the seeds (seedChanges: builtins, where the changes do not carry it).
    let current = withGrandfatheredBuiltins(structuredClone(config));
    let baseline = structuredClone(current);
    let saved = null;
    const calls = [];
    const save = (next) => {
      current = withGrandfatheredBuiltins(next);
      const changes = cfgReal.createConfigPatch(baseline, current);
      baseline = structuredClone(current);
      if (!changes.length) return current;
      const seeds = ['builtins']
        .filter((key) => current[key] !== undefined && !changes.some((change) => change.path[0] === key))
        .map((key) => ({ path: [key], value: structuredClone(current[key]), ifAbsent: true }));
      cfgReal.saveConfigPatch([...changes, ...seeds]);
      saved = JSON.parse(readFileSync(cfgFile, 'utf8')).agent ?? {};
      return current;
    };
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
      setConfiguredShell: (command) => calls.push(['setShell', command]),
      autoUpdateEnabled: () => false,
      getUpdateCheckState: () => ({ currentVersion: '1.0.0', latestVersion: null, updateAvailable: false, lastCheckedAt: null }),
      localPackageVersion: () => '1.0.0',
    });
    const developer = createDeveloperSettings({
      getConfig: () => current,
      saveConfigAndAdopt: save,
      syncDeveloperOption: async (id) => { calls.push(['syncDeveloper', id]); },
    });
    const profile = createProfileSettings({
      getConfig: () => current,
      saveConfigAndAdopt: save,
      hasOwn: Object.hasOwn,
      cfgMod,
      summarizeWorkflowRoutes: () => ({}),
      ONBOARDING_VERSION: 1,
    });
    const result = await Promise.resolve()
      .then(() => call({ builtin, system, developer, profile }))
      .then((value) => ({ value }), (error) => ({ error: String(error?.message ?? error) }));
    return { saved, calls, ...result };
  };

  const reads = {
    heartbeat: (await run((a) => a.system.getHeartbeatSettings())).value,
    reactions: (await run((a) => a.system.getReactionSettings())).value,
    titles: (await run((a) => a.builtin.getSessionTitleSettings())).value,
    cacheWarming: (await run((a) => a.builtin.getCacheWarmingSettings())).value,
    botOrder: (await run((a) => a.builtin.getBotOrder())).value,
    shell: (await run((a) => a.system.getSystemShell())).value,
    developer: (await run((a) => a.developer.getDeveloperSettings())).value,
    recap: (await run((a) => a.builtin.getRecapSettings())).value,
    profile: (await run((a) => a.profile.getProfile())).value,
  };
  const guide = GUIDES();
  const setters = [
    ['setHeartbeatEnabled', [pick([true, false, 'yes', null])], (a, x) => a.system.setHeartbeatEnabled(x[0])],
    ['setHeartbeatInterval', [pick([30, 60, 120, 240, 45, '60', null])], (a, x) => a.system.setHeartbeatInterval(x[0])],
    ['setReactionsEnabled', [pick([true, false, 'yes', null])], (a, x) => a.system.setReactionsEnabled(x[0])],
    ['setAiSessionTitles', [pick([true, false, 0, null])], (a, x) => a.builtin.setAiSessionTitles(x[0])],
    ['setCacheWarmingEnabled', [pick([true, false, 'on', null])], (a, x) => a.builtin.setCacheWarmingEnabled(x[0])],
    ['setBotOrder', [pick([[], ['x', ' y ', 'x'], IDS.slice(0, 3), IDS, 'x', [7], null])], (a, x) => a.builtin.setBotOrder(x[0])],
    ['setSystemShell', [pick(['pwsh', 'auto', ' AUTO ', '"pwsh.exe"', "'C:\\Program Files\\PowerShell\\7\\pwsh.exe'", 'bash', '', '"', { command: 'powershell' }, { command: 'zsh' }, {}, null])], (a, x) => a.system.setSystemShell(x[0])],
    ['setDeveloperOption', [pick([...DEV_IDS, 'nope', 7]), pick([true, false, 'x', null])], (a, x) => a.developer.setDeveloperOption(x[0], x[1])],
    ['setAutoUpdate', [pick([true, false, 'yes', null])], (a, x) => a.system.setAutoUpdate(x[0])],
    ['setProfile', [pick([
      {}, { title: ' Dr. Who ' }, { name: 'N'.repeat(70) }, { title: null, name: 'fallback' }, { language: 'ko' }, { lang: 'xx' }, { language: ' en ' },
      { experienceLevel: ' Vibe_Coder ' }, { experienceLevel: 'EXPERT' }, { experienceLevel: 'a  b' }, { experienceLevel: null }, { title: 7, language: null, experienceLevel: 'junior' },
      { title: '😀'.repeat(40) },
    ])], (a, x) => a.profile.setProfile(x[0])],
    ['saveStarterGuideState', [guide], (a, x) => a.profile.saveStarterGuideState(x[0])],
  ];
  const results = [];
  for (const [method, args, call] of setters) {
    const out = await run((a) => call(a, args));
    if (method === 'saveStarterGuideState' && out.value) out.value = out.value.starterGuide;
    results.push({ method, args, ...out });
  }
  entries.push({ config, shellEnv, reads, setters: results });
}
delete process.env.MIXDOG_SHELL;
rmSync(cfgDir, { recursive: true, force: true });

const stage = stageSet(outDir);
writeJson(join(stage, 'config-settings-twin.json'), {
  domain: 'config-settings-twin',
  recorder: 'benchmarks/rust-core/recorders/record-config-settings.mjs',
  platform: process.platform,
  entries,
});
writeSetManifest(stage, {
  set: 'config-settings',
  recorder: 'benchmarks/rust-core/recorders/record-config-settings.mjs',
  command: 'node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-config-settings.mjs --tree <tree>',
  identityTree: tree,
  identityRef: NODE_COMMIT,
});
commitStage(stage, outDir);
console.log(`recorded ${entries.length} settings configs`);
