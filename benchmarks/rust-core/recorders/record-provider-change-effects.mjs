#!/usr/bin/env node
// Which persisted changes re-initialize the providers: the REAL `applyConfigChange` of
// session-runtime/config-lifecycle.mjs (real snapshot, diff and retry) over the REAL shared config
// module on a temp data dir (config edits, keychain saves and deletes with their change markers),
// feeding the real `createConfigChangeEffects` (config-change-effects.mjs). Only the effects'
// collaborators are recording stubs. Rust `mixdog_core_domains::domains::ai_account::provider_changes`
// (one subscriber on `Config::changes()`) must run the same effects for the same steps.
//
//   node benchmarks/rust-core/recorders/record-provider-change-effects.mjs [--tree <dir>]
//
// Output: native/core/fixtures/provider-change-effects/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, recordingProvenance, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'provider-change-effects');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-provider-change-effects.mjs';
// Before any Mixdog module: the config file, its change marker and the secrets all live here.
// MIXDOG_HOME too: the config module copies every write into <home>/backups.
process.env.MIXDOG_HOME = mkdtempSync(join(tmpdir(), 'provider-change-home-'));
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'provider-change-rec-'));
const at = (path) => importFrom(tree, path);
const shared = await at('src/runtime/shared/config.mjs');
const { createConfigLifecycle } = await at('src/session-runtime/config-lifecycle.mjs');
const { createConfigChangeEffects } = await at('src/session-runtime/config-change-effects.mjs');
const { diffConfig, applyConfigPatch } = await at('src/runtime/shared/config-patch.mjs');

const settle = (ms = 40) => new Promise((done) => setTimeout(done, ms));

function setIn(root, path, value) {
  let node = root;
  for (const key of path.slice(0, -1)) node = node[key] ??= {};
  node[path.at(-1)] = value;
}

function build({ failFirstReinit = false, retryMs = 1000 } = {}) {
  const calls = [];
  const pending = [];
  let reinits = 0;
  const effects = createConfigChangeEffects({
    invalidateContextStatusCache() {},
    releaseAdmissionCooldowns: () => calls.push('releaseAdmissionCooldowns'),
    reinitProviders: () => {
      calls.push('reinitProviders');
      reinits += 1;
      if (failFirstReinit && reinits === 1) return Promise.reject(new Error('registry refused'));
      return Promise.resolve();
    },
    reconcileMcp: () => calls.push('reconcileMcp'),
    announceSettingsChange: () => calls.push('announceSettingsChange'),
  });
  const cfgMod = {
    loadConfig: () => structuredClone(shared.readConfig().agent ?? {}),
    createConfigPatch: diffConfig,
    saveConfigPatch() {},
    saveConfigPatchAsync: async () => {},
    patchSkillsDisabled() {},
    patchSkillsDisabledAsync: async () => {},
  };
  const sharedCfgMod = {
    readConfig: shared.readConfig,
    secretChangeTokens: shared.secretChangeTokens,
    updateConfigAsync: shared.updateConfigAsync,
    pendingConfigWrites: async () => {},
  };
  let current = cfgMod.loadConfig();
  const lifecycle = createConfigLifecycle({
    getConfig: () => current,
    setConfig: (next) => {
      current = next;
    },
    getWebSearchRoute: () => null,
    setWebSearchRoute() {},
    getConfigHasSecrets: () => false,
    setConfigHasSecrets() {},
    getRoute: () => ({ provider: 'demo' }),
    getSession: () => null,
    cfgMod,
    sharedCfgMod,
    setConfiguredShell() {},
    normalizeSystemShellConfig: () => ({ command: '' }),
    normalizeWebSearchRouteConfig: (value) => value || null,
    outputStyleStatus: () => ({}),
    clean: (value) => String(value || '').trim(),
    resolve,
    STANDALONE_DATA_DIR: process.cwd(),
    onConfigChanged: (change, config) => {
      const outcome = effects(change, config);
      pending.push(outcome);
      return outcome;
    },
    effectRetryDelaysMs: [retryMs],
  });
  return { calls, pending, lifecycle };
}

// ---- the steps: data only (op, target, and the Rust replay reads the same fields) -----------------
await shared.updateConfigAsync(() => ({ agent: { providers: { openai: { enabled: false } }, theme: 'old' } }));
const STEPS = [
  { name: 'nothing changed', op: 'none' },
  { name: 'a provider is switched on', op: 'agent', path: ['providers', 'openai', 'enabled'], value: true },
  { name: 'the same content written again', op: 'agent', path: ['providers', 'openai', 'enabled'], value: true },
  { name: 'a developer option', op: 'agent', path: ['developer', 'cursorOAuth'], value: true },
  { name: 'a setting that is no provider', op: 'agent', path: ['theme'], value: 'new' },
  { name: 'an MCP server', op: 'agent', path: ['mcpServers', 'docs', 'command'], value: 'docs-server' },
  { name: 'a provider key is saved', op: 'secret', account: 'agent.openai.apiKey' },
  { name: 'the same key is saved again', op: 'secret', account: 'agent.openai.apiKey' },
  { name: 'a custom provider extra key', op: 'secret', account: 'agent.custom-1.apiKey.k1' },
  { name: 'a usage session key is no provider key', op: 'secret', account: 'agent.openai.usageSessionKey' },
  { name: 'an MCP sign-in', op: 'secret', account: 'mcp-oauth.abc' },
  { name: 'a provider key is deleted', op: 'delete', account: 'agent.openai.apiKey' },
  { name: 'a deletion again', op: 'delete', account: 'agent.openai.apiKey' },
  { name: 'the plugin registry announces a change', op: 'announce', key: 'plugins' },
];
const run = build();
const steps = [];
for (const step of STEPS) {
  run.calls.length = 0;
  if (step.op === 'agent') await shared.updateConfigAsync((root) => { setIn(root.agent ??= {}, step.path, step.value); return root; });
  if (step.op === 'secret') await shared.saveSecretAsync(step.account, `value-of-${step.account}`);
  if (step.op === 'delete') await shared.deleteSecretAsync(step.account);
  if (step.op === 'announce') shared.announceStoredStateChange(step.key);
  const change = run.lifecycle.applyConfigChange();
  await Promise.all(run.pending.splice(0));
  await settle();
  steps.push({ ...step, change: { providers: change.providers, mcp: change.mcp, settings: change.settings }, calls: [...run.calls] });
}

// A re-init that fails is retried after the backoff, with the cooldown released again each time.
const retry = build({ failFirstReinit: true, retryMs: 60 });
await shared.updateConfigAsync((root) => { setIn(root.agent, ['providers', 'openai', 'enabled'], false); return root; });
retry.lifecycle.applyConfigChange();
await Promise.all(retry.pending.splice(0));
const firstAttempt = [...retry.calls];
await settle(400);
const retried = { firstAttempt, afterBackoff: [...retry.calls], retryMs: 60 };

writeJson(join(stage, 'golden.json'), { steps, retried });
writeSetManifest(stage, { set: 'provider-change-effects', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree, extra: recordingProvenance(recorder, ['benchmarks/rust-core/recorders/lib/common.mjs']) });
commitStage(stage, finalDir);
