// Exercise production orchestration with injected, non-network dependencies.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as immediate } from 'node:timers/promises';

const directory = mkdtempSync(join(tmpdir(), 'mixdog-cold-reconnect-'));
process.env.MIXDOG_RUNTIME_ROOT = directory;
process.env.MIXDOG_DATA_DIR = directory;
process.env.MIXDOG_DISABLE_MCP = '0';
const started = performance.now();
const { createProviderModels } = await import('../../src/session-runtime/provider-models.mjs');
const { createProviderAuthApi } = await import('../../src/session-runtime/provider-auth-api.mjs');
const { createMcpGlue } = await import('../../src/session-runtime/mcp-glue.mjs');
const importMs = performance.now() - started;
let catalogCalls = 0, revision = 987654;
const registry = {
    providerCatalogRevision: () => revision,
    getAllProviders: () => new Map([['openai', {
        listModels: async () => {
            catalogCalls++;
            await immediate();
            return [{ id: 'synthetic-model', name: 'Synthetic model', contextWindow: 128000 }];
        },
    }]]),
};
const createModels = () => createProviderModels({
    caches: { providerModelsCache: { models: null }, providerModelsLoadSeq: 0,
        webSearchProviderModelsCache: { models: null } },
    modelMetaByRoute: new Map(), getRoute: () => ({ provider: 'openai' }),
    getConfig: () => ({}), getReg: () => registry, webSearchCapableFor: () => false,
    sortProviderModelsRaw: rows => rows,
    providerModelCacheRowRaw: (provider, row) => ({ ...row, provider }),
    normalizeWebSearchProviderId: value => value, isWebSearchCapableProvider: () => false,
    ensureFullConfig() {}, awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {}, bootProfile() {}, scheduleProviderModelWarmup() {},
    quickHelpers: { quickProviderModelRows: () => [{ id: 'quick' }] },
});
const sessions = Array.from({ length: 8 }, createModels);
let start = performance.now();
const cold = await Promise.all(sessions.map(api => api.collectProviderModels()));
const catalogColdMs = performance.now() - start;
assert.ok(cold.every(rows => rows.length === 1));
assert.equal(catalogCalls, 1);
start = performance.now();
await Promise.all(sessions.map(api => api.collectProviderModels()));
const catalogWarmMs = performance.now() - start;
assert.equal(catalogCalls, 1);
revision++;
await Promise.all(sessions.map(api => api.collectProviderModels()));
assert.equal(catalogCalls, 2);

let releaseSecrets, ready = false;
const secrets = new Promise(resolve => { releaseSecrets = resolve; });
const auth = createProviderAuthApi({
    awaitKeychainPrewarm: () => secrets,
    isKeychainPrewarmReady: () => ready,
    hasProviderSetupCached: () => ready,
    cachedProviderSetup: async options => ({ source: options.quick ? 'quick' : 'authoritative' }),
});
start = performance.now();
const quickAuth = await auth.getProviderSetup();
const pendingAuthMs = performance.now() - start;
assert.equal(quickAuth.pendingSecrets, true);
assert.equal(quickAuth.source, 'quick');
ready = true;
releaseSecrets();
await immediate();
assert.equal((await auth.getProviderSetup()).source, 'authoritative');

let releaseConnect;
let active = 0, maxActive = 0, config = { mcpServers: { first: { command: 'synthetic' } } };
const connected = [];
const gate = new Promise(resolve => { releaseConnect = resolve; });
const state = { mcpConnectGeneration: 0, mcpConnectInFlight: null, mcpFailures: [] };
const mcp = createMcpGlue({
    state, getConfig: () => config, getCurrentCwd: () => directory,
    mcpClient: {
        resolveMcpTransportKind: () => 'stdio', getMcpServerStatus: () => [],
        resolveMcpStartupTimeoutMs: () => 10000, disconnectAll: async () => {},
        connectMcpServers: async servers => {
            maxActive = Math.max(maxActive, ++active);
            await gate;
            connected.push(Object.keys(servers));
            active--;
        },
    },
});
const initial = mcp.connectConfiguredMcp();
start = performance.now();
await mcp.awaitInitialMcpConnect(15);
const mcpBoundedWaitMs = performance.now() - start;
assert.equal(active, 1);
const obsolete = mcp.connectConfiguredMcp({ reset: true });
config = { mcpServers: { latest: { command: 'synthetic' } } };
const latest = mcp.connectConfiguredMcp({ reset: true });
releaseConnect();
await Promise.all([initial, obsolete, latest]);
assert.equal(maxActive, 1);
assert.deepEqual(connected, [['first'], ['latest']]);
assert.equal(state.mcpConnectInFlight, null);
const report = { directory, importMs, catalogColdMs, catalogWarmMs, pendingAuthMs,
    catalogCallsForEightSessionsBeforeAndAfterInvalidation: catalogCalls, mcpBoundedWaitMs,
    maxConcurrentMcpConnections: maxActive, connected,
    limits: 'Injected model lists, keychain and MCP: validates orchestration, not external network/keychain latency.' };
writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
