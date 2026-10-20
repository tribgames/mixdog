// A Lead route another process persisted reaches this runtime only through the
// debounced config-change notification. A conditional backfill must not adopt
// its own model in that window (adoptRoute re-reads the config from disk first),
// and must not overwrite the file when the other write lands even later: its
// Lead keys are written only if `default` is still unset when the patch is
// applied under the config file lock, and the file's route then replaces it.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { createConfigLifecycle } from './config-lifecycle.mjs';
import { createModelRouteApi } from './model-route-api.mjs';
import { applyConfigPatch, diffConfig } from '../runtime/shared/config-patch.mjs';

// The Lead route as the stored config holds it: `default` names a preset.
const leadOf = (config) => {
  const preset = (config.presets || []).find((entry) => entry.id === config.default);
  return preset ? { provider: preset.provider, model: preset.model } : { provider: '', model: '' };
};

function writeExternalLead(disk) {
  disk.agent.default = 'workflow-lead';
  disk.agent.presets = [{ id: 'workflow-lead', provider: 'openai', model: 'gpt-external' }];
}

function runtime({ route, beforeWrite = () => {} }) {
  const state = { config: { builtins: {}, providers: {}, skills: { disabled: [] } }, route };
  // The file as another process left it; this runtime holds no copy of it yet.
  const disk = { agent: structuredClone(state.config) };
  const persisted = [];
  const cfgMod = {
    loadConfig: () => structuredClone(disk.agent),
    createConfigPatch: diffConfig,
    saveConfigPatch: (changes) => {
      persisted.push(changes);
      disk.agent = applyConfigPatch(disk.agent, changes);
    },
    saveConfigPatchAsync: async (changes) => {
      // Another process can land its write right up to the moment this one takes the lock.
      beforeWrite(disk);
      persisted.push(changes);
      disk.agent = applyConfigPatch(disk.agent, changes);
    },
    patchSkillsDisabled() {},
    patchSkillsDisabledAsync: async () => {},
  };
  const resolveRoute = (config, requested) => {
    if (requested.model === 'workflow-lead' || !Object.keys(requested).length) return leadOf(config);
    return { ...state.route, ...requested };
  };
  // No subscribeConfigChange: the notification never arrives in these tests.
  const lifecycle = createConfigLifecycle({
    getConfig: () => state.config,
    setConfig: (next) => {
      state.config = next;
    },
    getWebSearchRoute: () => null,
    setWebSearchRoute() {},
    getConfigHasSecrets: () => false,
    setConfigHasSecrets() {},
    getRoute: () => state.route,
    setRouteState: (next) => {
      state.route = next;
    },
    resolveRoute,
    cfgMod,
    sharedCfgMod: {},
    setConfiguredShell() {},
    normalizeSystemShellConfig: () => ({ command: '' }),
    normalizeWebSearchRouteConfig: (value) => value || null,
    outputStyleStatus: () => ({}),
    LAZY_SECRET_PROVIDERS: new Set(),
    clean: (value) => String(value || '').trim(),
    resolve,
    STANDALONE_DATA_DIR: process.cwd(),
  });
  const api = createModelRouteApi({
    getConfig: () => state.config,
    getConfigHasSecrets: () => false,
    getRoute: () => state.route,
    setRouteState: (next) => {
      state.route = next;
    },
    getSession: () => null,
    getSessionGeneration: () => 0,
    setSession() {},
    getWebSearchRouteState: () => null,
    setWebSearchRouteState() {},
    cfgMod,
    resolveRoute,
    lookupModelMeta: async (_provider, model) => ({ id: model, fastCapable: true }),
    ensureProvidersReady: async () => {},
    awaitKeychainPrewarm: async () => {},
    ensureFullConfig: () => state.config,
    reloadFullConfig: lifecycle.reloadFullConfig,
    confirmLeadFill: lifecycle.confirmLeadFill,
    adoptConfig: lifecycle.adoptConfig,
    persistLeadRoute: (leadRoute, { onlyIfAbsent = false } = {}) => {
      lifecycle.saveConfigAndAdopt(
        {
          ...state.config,
          default: 'workflow-lead',
          presets: [{ id: 'workflow-lead', provider: leadRoute.provider, model: leadRoute.model }],
        },
        { leadFill: onlyIfAbsent }
      );
      return leadRoute;
    },
    saveConfigAndAdopt: lifecycle.saveConfigAndAdopt,
    refreshRouteEffort: async () => {},
    refreshStatuslineUsageSnapshot() {},
    scheduleStatuslineUsageRefresh() {},
    invalidateContextStatusCache() {},
    invalidateProviderCaches() {},
    invalidatePreSessionToolSurface() {},
    createCurrentSession: async () => {},
    statusRoutes: {},
    mgr: {},
  });
  return { api, state, disk, persisted };
}

const FILL = { provider: 'anthropic', model: 'claude-fill' };
// What the desktop backfill sends: a Main-model write, applied only while empty.
const BACKFILL = { onlyIfEmpty: true, keepMainModel: false };

test('a Lead route persisted by another process before its notification is the winner of a backfill', async () => {
  const h = runtime({ route: { provider: '', model: '' } });
  // The other process writes Lead B; this runtime has not been told.
  writeExternalLead(h.disk);
  assert.equal(h.state.route.model, '');
  const answer = await h.api.setRoute(FILL, BACKFILL);
  assert.equal(answer.model, 'gpt-external', 'the answer is the winning Lead route');
  assert.equal(h.state.route.model, 'gpt-external', 'the runtime follows it');
  assert.equal(leadOf(h.state.config).model, 'gpt-external', 'the config was adopted from disk');
  assert.equal(h.persisted.length, 0, 'nothing of the backfill was written');
});

test('a Lead route landing after the re-read but before the debounced persist stays on disk and is followed', async () => {
  let landed = false;
  const h = runtime({
    route: { provider: '', model: '' },
    // Lands once the fill is adopted and queued: after the re-read, before its write.
    beforeWrite: (disk) => {
      if (landed) return;
      landed = true;
      writeExternalLead(disk);
    },
  });
  const answer = await h.api.setRoute(FILL, BACKFILL);
  assert.equal(landed, true);
  // The fill's Lead keys were skipped under the write: the file keeps the other Lead route.
  assert.equal(leadOf(h.disk.agent).model, 'gpt-external');
  assert.equal(h.disk.agent.default, 'workflow-lead');
  // The runtime followed it, and the answer is the winner.
  assert.equal(answer.model, 'gpt-external');
  assert.equal(h.state.route.model, 'gpt-external');
  assert.equal(leadOf(h.state.config).model, 'gpt-external');
});

test('a fill nobody raced is written to the file and stays the route', async () => {
  const h = runtime({ route: { provider: '', model: '' } });
  const answer = await h.api.setRoute(FILL, BACKFILL);
  assert.equal(answer.model, 'claude-fill');
  assert.equal(leadOf(h.disk.agent).model, 'claude-fill');
  assert.equal(h.state.route.model, 'claude-fill');
});
