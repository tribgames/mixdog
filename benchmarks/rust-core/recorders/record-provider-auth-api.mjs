#!/usr/bin/env node
// provider-auth-api.test.mjs (11 tests): the real `createProviderAuthApi` (session-runtime/provider-auth-api.mjs) with its collaborators
// scripted: the provider admin service, the admission scheduler, the provider registry and the OAuth usage fetcher are replaced by
// recording stubs through a loader hook (the equivalent of the test's `mock.module`), and the host callbacks (reload, apply, keychain
// prewarm, cache invalidate / warm, catalog refresh, setup snapshot) are recording functions. Every case records the ordered call log
// (collaborator effects in the order they happened) and the API's return values.
//   node benchmarks/rust-core/recorders/record-provider-auth-api.mjs --tree <exact export of b6f10295a>
import { register } from 'node:module';
import { setImmediate } from 'node:timers/promises';
// Waits for an effect the API starts in the background (no fixed number of turns): polls once per event-loop turn until `predicate`, failing after 5 s.
const until = async (predicate, what) => {
  const end = process.hrtime.bigint() + 5_000_000_000n;
  while (!predicate()) {
    if (process.hrtime.bigint() > end) throw new Error(`recorder: ${what} did not happen within 5 s`);
    await setImmediate();
  }
};
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-auth-api',
  net: false,
  entry: 'src/session-runtime/provider-auth-api.mjs createProviderAuthApi(deps) over stubbed ./services/provider-admin.mjs, providers/admission-scheduler.mjs, providers/registry.mjs, providers/oauth-usage.mjs (loader hook; the stubs record every call into `calls`). The test flushes with timers/promises setImmediate (polled per event-loop turn up to a 5 s deadline, never a fixed number of turns), as the recorder does; no timer is waited on.',
  compare: 'mixdog-core-domains ai_account/provider_changes.rs:128,229 and ai_admin/account_actions.rs:121-164: perform the same API call against the Rust domain with recording collaborators and compare `calls` (ordered effects) and `result`. K1 gaps G8: the catalog refresh after a key save is OPEN in the core (dec:828), so the first case is expected to differ.',
  replay: "Rust entry (pub, on o1): mixdog_core_domains ai_admin AccountActions (account_actions.rs:61, constructors new/over :113/:117) and ai_account spawn_provider_changes (provider_changes.rs:96) with LiveProviderEffects (provider_changes.rs:71). The catalog refresh after a key save is OPEN (K1 G8, dec:828): work for the Rust side.",
});
const NAMES = ['keychainIssueFor', 'beginOAuthProviderLogin', 'forgetProviderAuth', 'loginOAuthProvider', 'renderProviderStatus', 'saveOpenAIUsageSessionKey', 'saveProviderApiKey', 'saveCustomProvider', 'saveCustomProviderKey', 'removeCustomProvider', 'updateCustomProviderModel', 'saveModelPreferences', 'testCustomProvider', 'checkCustomProviderKeyEnv', 'discoverCustomProviderModels', 'listProviderAccounts', 'materializeProviderAccounts', 'updateProviderAccounts'];
const STUBS = { 'services/provider-admin.mjs': NAMES, 'agent/orchestrator/providers/admission-scheduler.mjs': ['resetProviderAdmissionCooldowns'], 'agent/orchestrator/providers/registry.mjs': ['getProvider'], 'agent/orchestrator/providers/oauth-usage.mjs': ['fetchOAuthUsageSnapshot'] };
const hooks = `const STUBS = ${JSON.stringify(STUBS)};
export async function load(url, context, next) {
  for (const [suffix, names] of Object.entries(STUBS)) {
    if (url.endsWith('/' + suffix) && (url.includes('/src/session-runtime/') || url.includes('/src/runtime/'))) {
      return { format: 'module', shortCircuit: true, source: names.map((n) => 'export const ' + n + ' = (...a) => globalThis.__stubs[' + JSON.stringify(suffix) + '].' + n + '(...a);').join('\\n') };
    }
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

const calls = [];
let pendingCallback = null;
const admin = {
  keychainIssueFor: () => null,
  beginOAuthProviderLogin: async (_cfg, providerId, options) => { calls.push(['beginOAuth', providerId, options]); pendingCallback = Promise.withResolvers(); return { url: 'https://login', waitForCallback: pendingCallback.promise, completeCode: async (code) => { calls.push(['completeCode', code]); return true; } }; },
  forgetProviderAuth: (_cfg, providerId, accountId) => calls.push(['forget', providerId, accountId]) && 'forgot',
  loginOAuthProvider: async (_cfg, providerId) => calls.push(['loginOAuth', providerId]) && 'logged-in',
  renderProviderStatus: (config) => ['status', config],
  saveOpenAIUsageSessionKey: (_cfg, secret) => calls.push(['saveUsageKey', secret]) && 'saved-usage',
  saveProviderApiKey: (_cfg, providerId, secret, options) => calls.push(options === undefined ? ['saveKey', providerId, secret] : ['saveKey', providerId, secret, options]) && 'saved-key',
  saveCustomProvider: async (_cfg, input) => calls.push(['saveCustom', input]) && { id: 'custom-1' },
  saveCustomProviderKey: async (_cfg, id, secret) => calls.push(['saveCustomKey', id, secret]) && { id },
  removeCustomProvider: (_cfg, id) => calls.push(['removeCustom', id]) && { provider: id },
  updateCustomProviderModel: async (_cfg, id, modelId, patch) => calls.push(['updateCustomModel', id, modelId, patch]) && { id },
  saveModelPreferences: (_cfg, provider, changes) => calls.push(['modelPreferences', provider, changes]) && { provider, changed: changes.length, customCatalogChanged: provider.startsWith('custom-') },
  testCustomProvider: async (_cfg, input) => calls.push(['testCustom', input]) && { ok: true },
  checkCustomProviderKeyEnv: (name) => ({ found: name === 'SET_VAR' }),
  discoverCustomProviderModels: async (_cfg, input) => calls.push(['discoverCustom', input]) && { models: [] },
  listProviderAccounts: (providerId) => ({ providerId, accounts: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }, { id: 'a5' }], selectedId: 'a1' }),
  materializeProviderAccounts: async (providerId) => admin.listProviderAccounts(providerId),
  updateProviderAccounts: (providerId, change) => { calls.push(['updateAccounts', providerId, change]); return { selectedId: change.selectedId ?? 'a1' }; },
};
const providers = { oauth: { forAccount: (id) => ({ account: id }) }, plain: {} };
globalThis.__stubs = {
  'services/provider-admin.mjs': admin,
  'agent/orchestrator/providers/admission-scheduler.mjs': { resetProviderAdmissionCooldowns: () => calls.push(['resetCooldowns']) },
  'agent/orchestrator/providers/registry.mjs': { getProvider: (id) => providers[id] },
  'agent/orchestrator/providers/oauth-usage.mjs': { fetchOAuthUsageSnapshot: async (target, provider, _onUpdate, options) => { calls.push(['usage', target, provider, options]); return null; } },
};
const { createProviderAuthApi } = await rec.load('src/session-runtime/provider-auth-api.mjs');
const SRC = 'src/session-runtime/provider-auth-api.test.mjs';

function fixture(overrides = {}) {
  calls.length = 0;
  return createProviderAuthApi({
    cfgMod: { listPresets: (config) => ['presets', config] }, getConfig: () => ({}), saveConfigAndAdopt: () => {}, displayConfig: () => ({ display: true }),
    reloadFullConfig: () => calls.push(['reload']), applyConfigChange: () => calls.push(['apply']), awaitKeychainPrewarm: async () => calls.push(['keychain']),
    invalidateProviderCaches: () => calls.push(['invalidate']), warmProviderModelCache: () => calls.push(['warm']), refreshProviderCatalogs: async (options) => calls.push(['refreshCatalogs', options]),
    cachedProviderSetup: async (options) => { calls.push(['setup', options]); if (options.quick) return { providers: 'quick' }; return { providers: options.force ? 'forced' : 'full' }; },
    getUsageDashboard: async (options) => ['dashboard', options], consumeCodexRateLimitResetCredit: async (options) => ['reset', options], collectProviderModels: async (options) => ['models', options],
    ...overrides,
  });
}
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};
const run = (id, line, input, fn) => rec.run(id, `${SRC}:${line}`, input, async () => { const out = await fn(); return { ...out, calls: structuredClone(calls) }; });

await run('save-api-key-reload-cooldowns-catalogs-then-caches', 110, { op: 'saveProviderApiKey', args: ['oauth', 'sk-1'] }, async () => {
  const api = fixture();
  const result = await api.saveProviderApiKey('oauth', 'sk-1');
  await until(() => calls.filter(([name]) => name === 'warm').length >= 2, 'the catalog refresh settled');
  return { result };
});
await run('vertex-credentials-forward-location-and-project', 117, { op: 'saveProviderApiKey', args: ['vertex-ai', '{"type":"service_account"}', { location: 'us-east5', projectId: 'override-project' }] }, async () => {
  const api = fixture();
  return { result: await api.saveProviderApiKey('vertex-ai', '{"type":"service_account"}', { location: 'us-east5', projectId: 'override-project' }) };
});
await run('authenticate-saves-secret-or-runs-oauth-login', 124, { ops: [['authenticateProvider', 'oauth', '  '], ['authenticateProvider', 'oauth', 'sk-2'], ['forgetProviderAuth', 'oauth', 'a1']] }, async () => {
  const api = fixture();
  const login = await api.authenticateProvider('oauth', '  ');
  const afterLogin = structuredClone(calls);
  const saved = await api.authenticateProvider('oauth', 'sk-2');
  const forgot = await api.forgetProviderAuth('oauth', 'a1');
  return { login, afterLogin, saved, forgot };
});
await run('custom-provider-save-remove-refresh-like-credentials', 131, {}, async () => {
  const removed = [];
  const api = fixture({ onCustomProviderRemoved: (id) => removed.push(id) });
  const out = {};
  out.save = await api.saveCustomProvider({ name: 'x' });
  await until(() => calls.filter(([name]) => name === 'warm').length >= 2, 'the catalog refresh settled');
  out.afterSave = structuredClone(calls);
  calls.length = 0;
  await api.removeCustomProvider('custom-1');
  out.removed = removed;
  out.afterRemove = structuredClone(calls);
  calls.length = 0;
  out.updateModel = await api.updateCustomProviderModel('custom-1', 'm', { hidden: null });
  out.afterUpdateModel = structuredClone(calls);
  calls.length = 0;
  api.setModelPreferences('openai', [{ model: 'm', favorite: true }]);
  out.afterBuiltinPrefs = structuredClone(calls);
  calls.length = 0;
  api.setModelPreferences('custom-1', [{ model: 'm', hidden: true }]);
  out.afterCustomPrefs = structuredClone(calls);
  calls.length = 0;
  out.test = await api.testCustomProvider({ a: 1 });
  out.env = api.checkCustomProviderKeyEnv('SET_VAR');
  out.discover = await api.discoverCustomProviderModels({ b: 2 });
  out.reloadedByReadOnlyOps = calls.some(([name]) => name === 'reload');
  return out;
});
await run('usage-only-credentials-skip-admission-cooldowns', 172, { op: 'saveOpenAIUsageSessionKey', args: ['usage-1'] }, async () => ({ result: await fixture().saveOpenAIUsageSessionKey('usage-1') }));
await run('begin-oauth-login-wraps-callback-and-code-completion', 180, { op: 'beginOAuthProviderLogin', args: ['oauth', { openBrowser: false }] }, async () => {
  const api = fixture();
  const login = await api.beginOAuthProviderLogin('oauth', { openBrowser: false });
  const out = { url: login.url, afterBegin: structuredClone(calls) };
  calls.length = 0;
  pendingCallback.resolve(true);
  out.callback = await login.waitForCallback;
  await until(() => calls.filter(([name]) => name === 'warm').length >= 2, 'the catalog refresh settled');
  out.afterCallback = structuredClone(calls);
  calls.length = 0;
  out.code = await login.completeCode('1234');
  await until(() => calls.filter(([name]) => name === 'warm').length >= 2, 'the catalog refresh settled');
  out.afterCode = structuredClone(calls);
  return out;
});
await run('account-roster-paints-immediately-one-usage-sweep', 197, { providers: ['oauth', 'plain'] }, async () => {
  const api = fixture();
  const pool = api.getProviderAccounts('oauth');
  const out = { accountCount: pool.accounts.length, immediately: structuredClone(calls) };
  await until(() => calls.filter(([name]) => name === 'usage').length >= 5, 'the five usage sweeps');
  
  out.usageCalls = calls.filter(([name]) => name === 'usage');
  calls.length = 0;
  api.getProviderAccounts('plain');
  // Negative check: once the keychain step ran, 1 ms of virtual time (due timers run, microtasks drained) shows no sweep follows.
  await until(() => calls.some(([name]) => name === 'keychain'), 'the plain roster reached the keychain step');
  await rec.clock.advance(1);
  out.plainCalls = structuredClone(calls);
  return out;
});
await run('switching-selected-account-releases-cooldowns-prefetches-usage', 215, { ops: [{ selectedId: 'a2' }, { remove: 'a3' }] }, async () => {
  const api = fixture();
  const out = { switched: await api.updateProviderAccounts('oauth', { selectedId: 'a2' }), afterSwitch: structuredClone(calls) };
  calls.length = 0;
  await api.updateProviderAccounts('oauth', { remove: 'a3' });
  out.afterRemoveTouchedCooldownsOrUsage = calls.some(([name]) => name === 'resetCooldowns' || name === 'usage');
  return out;
});
await run('provider-setup-quick-snapshot-then-forced', 234, {}, async () => {
  const api = fixture({ isKeychainPrewarmReady: () => false });
  const out = { quick: await api.getProviderSetup(), firstCall: calls[0] };
  await until(() => calls.at(-1)?.[0] === 'setup' && Object.keys(calls.at(-1)[1]).length === 0, 'the authoritative setup');
  out.lastCallAfterPrewarm = calls.at(-1);
  calls.length = 0;
  out.forced = await api.getProviderSetup({ force: true });
  out.afterForce = structuredClone(calls);
  return out;
});
await run('catalog-preset-dashboard-reset-credit-surfaces', 247, {}, async () => {
  const api = fixture();
  const out = { list: api.listProviders(), presets: api.listPresets(), dashboard: await api.getUsageDashboard({ a: 1 }), models: await api.listProviderModels({ refresh: true }), reset: await api.consumeCodexRateLimitResetCredit({ b: 2 }) };
  out.missingReset = await attempt(fixture({ consumeCodexRateLimitResetCredit: undefined }).consumeCodexRateLimitResetCredit());
  return out;
});
await rec.finish();
