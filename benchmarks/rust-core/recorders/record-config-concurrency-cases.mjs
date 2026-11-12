#!/usr/bin/env node
// Records Node's settings writes for the k1 UNTESTED config-concurrency.test.mjs (gaps-rest.md, mixdog-core-config).
// The test's one case runs as the test runs it: a child process with the test's module mocks and environment, its own
// script step for step (Node's real config lifecycle, settings API, `saveConfig[Async]`, `updateConfigAsync`,
// `patchSkillsDisabledAsync` and `createConfigPatch`). After every step the whole config file (`readConfig()`) is kept,
// and each direct save keeps the two configs it was given, which the replay hands to the core's save.
//
//   node benchmarks/rust-core/recorders/record-config-concurrency-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/config-concurrency-cases/{golden.json,MANIFEST.json}.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-config-concurrency-cases.mjs';
const TEST = 'src/session-runtime/config-concurrency.test.mjs';
const CASE = 'real settings writes preserve peer settings, explicit provider OFF, and the rest of the config';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);

// The test's child script with each step's file (and each direct save's inputs) recorded; its asserts are kept.
const source = `
  import assert from 'node:assert/strict';
  import childProcess from 'node:child_process';
  import { once } from 'node:events';
  import { syncBuiltinESMExports } from 'node:module';
  import { resolve } from 'node:path';
  import { mock } from 'node:test';

  const started = [];
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args) => {
    const child = spawn(...args);
    started.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const acl = await import('./src/runtime/shared/file-permissions.mjs');
  acl.disableOwnerOnlyAclSyncBridgeForTests();

  const keychain = {
    getSecret: () => null,
    hasSecret: () => false,
    setSecret: () => assert.fail('unexpected credential write'),
    deleteSecret: () => assert.fail('unexpected credential deletion'),
    invalidateSecretCache() {},
    prewarmSecrets: async () => {},
    SERVICE: 'mixdog',
  };
  mock.module('./src/lib/keychain-cjs.cjs', { defaultExport: keychain, namedExports: keychain });
  mock.module('./src/runtime/agent/orchestrator/providers/oauth-credential-probes.mjs', {
    namedExports: {
      oauthCredentialProbeState: () => 'absent',
      isOAuthProviderAvailable: (name) => !['mimo-oauth', 'cursor-oauth', 'devin-oauth', 'antigravity-oauth'].includes(name),
      hasAnthropicOAuthCredentials: () => false,
      hasOpenAIOAuthCredentials: () => false,
      hasGrokOAuthCredentials: () => false,
      hasAntigravityOAuthCredentials: () => false,
      hasCursorOAuthCredentials: () => false,
      oauthCredentialFiles: () => [],
      observeOAuthCredentialExpiry: (run) => ({ value: run(), expiresAt: Number.POSITIVE_INFINITY }),
    },
  });
  const cfgMod = await import('./src/runtime/agent/orchestrator/config.mjs');
  const sharedCfgMod = await import('./src/runtime/shared/config.mjs');
  const { createConfigLifecycle } = await import('./src/session-runtime/config-lifecycle.mjs');
  const { createSettingsApi } = await import('./src/session-runtime/settings-api.mjs');

  function runtime() {
    let config = cfgMod.loadConfig({ secrets: false });
    let secrets = false;
    let webSearchRoute = null;
    const lifecycle = createConfigLifecycle({
      getConfig: () => config,
      setConfig: next => { config = next; },
      getConfigHasSecrets: () => secrets,
      setConfigHasSecrets: next => { secrets = next; },
      getWebSearchRoute: () => webSearchRoute,
      setWebSearchRoute: next => { webSearchRoute = next; },
      getRoute: () => ({ provider: 'openai' }),
      cfgMod, sharedCfgMod,
      setConfiguredShell() {},
      normalizeSystemShellConfig: value => ({ command: value?.command || '' }),
      normalizeWebSearchRouteConfig: value => value || null,
      LAZY_SECRET_PROVIDERS: new Set(),
      clean: value => String(value || '').trim(),
      resolve,
      STANDALONE_DATA_DIR: process.env.MIXDOG_DATA_DIR,
    });
    const api = createSettingsApi({
      getConfig: () => config,
      cfgMod,
      hasOwn: Object.hasOwn,
      saveConfigAndAdopt: lifecycle.saveConfigAndAdopt,
      adoptConfig: lifecycle.adoptConfig,
      scheduleSkillsSave: lifecycle.scheduleSkillsSave,
    });
    return { api, lifecycle, config: () => config };
  }

  const steps = [];
  const read = () => sharedCfgMod.readConfig();
  const step = (name, extra = {}) => steps.push({ step: name, ...extra, file: JSON.parse(JSON.stringify(read())) });
  try {
    await sharedCfgMod.updateConfigAsync(() => ({
      agent: {
        profile: { title: 'Initial', language: 'ko' },
        compaction: { auto: true },
        autoClear: { enabled: true },
        skills: { disabled: [] },
        builtins: {},
      },
      desktop: { keepAwake: false },
      outputStyle: 'simple',
      memory: { embedding: { dtype: 'q8' } },
    }));
    step('seed');
    const a = runtime();
    const b = runtime();
    a.api.setProfile({ language: 'en' });
    await a.lifecycle.flushAllConfigSavesAsync({ requireSaved: true });
    step('a setProfile', { runtime: 'a', profile: { language: 'en' } });
    b.api.setProfile({ title: 'Updated by B' });
    await b.lifecycle.flushAllConfigSavesAsync({ requireSaved: true });
    step('b setProfile', { runtime: 'b', profile: { title: 'Updated by B' } });

    const c = runtime();
    await sharedCfgMod.updateConfigAsync(root => ({
      ...root,
      agent: {
        ...root.agent,
        compaction: { ...root.agent.compaction, auto: false },
        autoClear: { ...root.agent.autoClear, enabled: false },
      },
    }));
    step('peer compaction and autoClear off');
    await cfgMod.patchSkillsDisabledAsync(['browser-use']);
    step('peer skills disabled', { disabled: ['browser-use'] });
    c.api.setProfile({ title: 'Unrelated profile edit' });
    await c.lifecycle.flushAllConfigSavesAsync({ requireSaved: true });
    step('c setProfile', { runtime: 'c', profile: { title: 'Unrelated profile edit' } });

    const d = runtime();
    const e = runtime();
    d.api.setProfile({ language: 'ja' });
    e.api.setProfile({ title: 'Concurrent title' });
    await Promise.all([
      d.lifecycle.flushAllConfigSavesAsync({ requireSaved: true }),
      e.lifecycle.flushAllConfigSavesAsync({ requireSaved: true }),
    ]);
    step('d and e setProfile together', { runtimes: { d: { language: 'ja' }, e: { title: 'Concurrent title' } } });

    const before = cfgMod.loadConfig({ secrets: false });
    const withShell = { ...before, shell: { command: 'pwsh', args: ['-NoProfile'] } };
    await cfgMod.saveConfigAsync(withShell, { baseConfig: before });
    step('save shell', { before, after: withShell });
    const shellBaseline = cfgMod.loadConfig({ secrets: false });
    await sharedCfgMod.updateConfigAsync(root => ({
      ...root, agent: { ...root.agent, shell: { ...root.agent.shell, extra: 'peer' } },
    }));
    step('peer shell extra');
    const cleared = { ...shellBaseline, shell: { args: [] } };
    await cfgMod.saveConfigAsync(cleared, { baseConfig: shellBaseline });
    step('save cleared shell', { before: shellBaseline, after: cleared });
    assert.deepEqual(read().agent.shell, { args: [], extra: 'peer' });

    const patchBefore = { autoClear: { thresholdMs: 90000 }, compaction: { enabled: false }, providers: { openai: { enabled: true, apiKey: 'old' } } };
    const patchAfter = { autoClear: { idleMs: 90000 }, compaction: { auto: false }, providers: { openai: { enabled: true, apiKey: 'new' } } };
    const patch = cfgMod.createConfigPatch(patchBefore, patchAfter);

    const providerBaseline = cfgMod.loadConfig();
    await sharedCfgMod.updateConfigAsync(root => ({
      ...root, agent: { ...root.agent, profile: { ...root.agent.profile, language: 'ko' } },
    }));
    step('peer language ko');
    const providerOff = {
      ...providerBaseline,
      providers: { ...providerBaseline.providers, openai: { ...providerBaseline.providers.openai, enabled: false } },
    };
    cfgMod.saveConfig(providerOff, { baseConfig: providerBaseline });
    step('save provider off', { before: providerBaseline, after: providerOff });
    const full = cfgMod.loadConfig();
    const titled = { ...full, profile: { ...full.profile, title: 'After secrets load' } };
    await cfgMod.saveConfigAsync(titled);
    step('save title after secrets load', { before: full, after: titled, noBase: true });
    process.stdout.write('\\n@@RESULT@@' + JSON.stringify({ steps, patch: { before: patchBefore, after: patchAfter, changes: patch } }));
  } finally {
    await Promise.all(started.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.ref();
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }));
  }
`;

const dir = mkdtempSync(join(tmpdir(), 'mixdog-settings-concurrency-'));
let recorded;
try {
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', source], {
    cwd: tree,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR)$/i.test(key))),
      HOME: dir,
      USERPROFILE: dir,
      APPDATA: join(dir, 'appdata'),
      LOCALAPPDATA: join(dir, 'localappdata'),
      MIXDOG_HOME: dir,
      MIXDOG_DATA_DIR: join(dir, 'data'),
      MIXDOG_USER_DATA_BACKUP_ROOT: join(dir, 'backups'),
      MIXDOG_CONFIG_READ_TTL_MS: '0',
      ...Object.fromEntries(
        ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'OPENCODE_API_KEY', 'OPENROUTER_API_KEY'].map((key) => [
          key,
          'fixture-key-not-a-real-credential',
        ])
      ),
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(`child failed (${result.status}): ${result.stderr || result.stdout}`);
  recorded = JSON.parse(result.stdout.split('@@RESULT@@').pop());
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// Each step replays from the file Node left before it.
const excluded = {
  'save title after secrets load':
    'no client reaches it: saveConfig/saveConfigAsync without baseConfig (the whole-section save) has no caller in the product at ' +
    'b6f10295a (every provider-admin save and the config writers pass a baseline or a patch); only this test calls it, so the core has no such save',
};
const finalDir = join(FIXTURES_ROOT, 'config-concurrency-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's settings writes at ${NODE_COMMIT}, per step of ${RECORDER}`, test: TEST, cases: [{ case: CASE, ...recorded }] });
writeSetManifest(stage, {
  set: 'config-concurrency-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "after every step the whole config file the core leaves: setProfile through each runtime's own Settings (Config opened when Node made the runtime), peer writes through Config::update, direct saves through Config::save_agent_config with Node's two configs; the alias patch through create_config_patch, whole",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`config-concurrency-cases: 1 case, ${recorded.steps.length} step(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
