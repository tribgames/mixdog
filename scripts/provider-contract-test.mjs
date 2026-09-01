#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    OpenAICompatProvider,
    OPENAI_COMPAT_PRESETS,
    applyCompatProviderChatOptions,
    compatReportedCostUsd,
    parseToolCalls,
} from '../src/runtime/agent/orchestrator/providers/openai-compat.mjs';
import { sanitizeModelList } from '../src/runtime/agent/orchestrator/providers/model-list-sanitize.mjs';
import {
    consumeCompatChatCompletionStream,
    consumeCompatResponsesStream,
} from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import { useXaiResponsesWebSocket } from '../src/runtime/agent/orchestrator/providers/openai-compat-xai.mjs';
import {
    deepseekReplaysReasoningContent,
    toOpenAIMessages,
    toOpenAITools,
} from '../src/runtime/agent/orchestrator/providers/openai-compat-wire.mjs';
import { toOpenAIResponsesTool } from '../src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs';
import { requestAnthropicTools } from '../src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs';
import { toGeminiTools } from '../src/runtime/agent/orchestrator/providers/gemini-schema.mjs';
import { TOOL_DEFS as COMPUTER_TOOL_DEFS } from '../src/runtime/computer-bridge/tool-defs.mjs';
import { classifyError } from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import { GrokOAuthProvider } from '../src/runtime/agent/orchestrator/providers/grok-oauth.mjs';
import { sendViaWebSocket } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import {
    OpenCodeGoProvider,
    isAnthropicGoModel,
    openCodeGoEndpointForModel,
    resolveOpenCodeGoBaseURLs,
} from '../src/runtime/agent/orchestrator/providers/opencode-go.mjs';
import { uncachedInputTokensForProvider } from '../src/runtime/agent/orchestrator/session/manager/usage-metrics.mjs';
import { resolveTraceUsageInput } from '../src/runtime/agent/orchestrator/agent-trace.mjs';
import {
    billableInputTokensForProvider,
    isInclusiveProvider,
} from '../src/runtime/shared/llm/cost.mjs';
import { createProviderAuthApi } from '../src/session-runtime/provider-auth-api.mjs';
import { providerSetup } from '../src/standalone/provider-admin.mjs';
import { createProviderModels } from '../src/session-runtime/provider-models.mjs';
import { createQuickModelRows } from '../src/session-runtime/quick-model-rows.mjs';
import {
    providerModelCacheRow,
    sortProviderModels,
} from '../src/session-runtime/model-recency.mjs';
import { createProviderUsage } from '../src/session-runtime/provider-usage.mjs';
import { createUsageDashboard } from '../src/standalone/usage-dashboard.mjs';
import {
    _withLoadedProviderCtorForTest,
    _withRegisteredProviderForTest,
    providerCatalogRevision,
    refreshCatalogs,
    refreshProviderCatalogsOnStartup,
} from '../src/runtime/agent/orchestrator/providers/registry.mjs';
import { providerCachedModelMetadataSync } from '../src/runtime/agent/orchestrator/providers/provider-catalog-cache.mjs';
import { readRuntimeTunables } from '../src/session-runtime/runtime-tunables.mjs';

test('Computer Use stays one shared custom-tool contract across providers', () => {
    const tool = COMPUTER_TOOL_DEFS[0];
    const schemas = [
        toOpenAITools([tool])[0].function.parameters,
        toOpenAIResponsesTool(tool).parameters,
        requestAnthropicTools(
            [tool],
            [],
            {
                providerToolSnapshotAuthoritative: true,
                providerNativeToolPrefixCount: 0,
            },
            'anthropic',
        )[0].input_schema,
        toGeminiTools([tool]).functionDeclarations[0].parameters,
    ];
    for (const schema of schemas) {
        assert.deepEqual(schema.properties.action.enum, [
            'list', 'diagnose', 'capture', 'verify', 'act',
            'window', 'menu', 'clipboard', 'launch',
        ]);
        assert.equal(JSON.stringify(schema).includes('computer_use_preview'), false);
        assert.equal(JSON.stringify(schema).includes('computer_20250124'), false);
    }
    const anthropicInput = schemas[2].properties.input;
    assert.ok(anthropicInput.properties.actions);
    assert.deepEqual(anthropicInput.properties.actions.items.properties.type.enum, [
        'click', 'double_click', 'move', 'drag', 'scroll', 'type', 'key', 'wait',
    ]);
    assert.deepEqual(schemas[2].required, ['action']);
});

test('OpenRouter model sanitizer applies hosted filters with a nine-month default cutoff', () => {
    const previousStaleMonths = process.env.MIXDOG_MODEL_STALE_MONTHS;
    delete process.env.MIXDOG_MODEL_STALE_MONTHS;
    try {
        const releaseDate = (monthsAgo) => new Date(
            Date.now() - monthsAgo * 30.4375 * 24 * 60 * 60 * 1000,
        ).toISOString().slice(0, 10);
        const models = [
            { id: 'vendor/current-text', mode: 'chat' },
            { id: 'vendor/ten-month-text', mode: 'chat' },
            { id: 'vendor/image-model', mode: 'chat' },
            { id: 'vendor/no-tools', mode: 'chat' },
        ];
        const catalog = {
            openrouter: {
                models: {
                    'vendor/current-text': {
                        family: 'current-text',
                        release_date: releaseDate(1),
                        tool_call: true,
                        modalities: { output: ['text'] },
                    },
                    'vendor/ten-month-text': {
                        family: 'ten-month-text',
                        release_date: releaseDate(10),
                        tool_call: true,
                        modalities: { output: ['text'] },
                    },
                    'vendor/image-model': {
                        family: 'image-model',
                        release_date: releaseDate(1),
                        tool_call: true,
                        modalities: { output: ['image'] },
                    },
                    'vendor/no-tools': {
                        family: 'no-tools',
                        release_date: releaseDate(1),
                        tool_call: false,
                        modalities: { output: ['text'] },
                    },
                },
            },
        };

        assert.deepEqual(
            sanitizeModelList(models, { provider: 'openrouter', _testCatalog: catalog }).map((row) => row.id),
            ['vendor/current-text'],
        );
    } finally {
        if (previousStaleMonths === undefined) delete process.env.MIXDOG_MODEL_STALE_MONTHS;
        else process.env.MIXDOG_MODEL_STALE_MONTHS = previousStaleMonths;
    }
});
import { effortOptionsFor } from '../src/session-runtime/effort.mjs';
import {
    consumeOpenAICodexResetCredit,
    fetchOpenAICodexResetCredits,
    fetchOAuthUsageSnapshot,
} from '../src/runtime/agent/orchestrator/providers/oauth-usage.mjs';

// Usage snapshots persist to <data dir>/gateway-oauth-usage-cache.json. Without
// an isolated data dir these fixtures wrote provider rows into the developer's
// real cache, where a fake model id could later win a provider fallback lookup.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-provider-contract-'));

function stream(events) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of events) yield event;
        },
    };
}

test('startup provider catalog refresh runs once for every session runtime in the process', async () => {
    let refreshes = 0;
    class CatalogProvider {
        async _refreshModelCache() {
            refreshes += 1;
            return [{ id: 'catalog-model' }];
        }
    }
    const before = providerCatalogRevision();
    // The refresh walks REGISTERED instances (initProviders already built every
    // enabled provider); a merely loaded constructor is not a startup catalog
    // participant, so the fixture registers the instance itself.
    const requests = _withRegisteredProviderForTest('catalog-startup-test', new CatalogProvider(), () => {
        const first = refreshProviderCatalogsOnStartup();
        const second = refreshProviderCatalogsOnStartup();
        assert.equal(first, second);
        return [first, second];
    });
    await Promise.all(requests);
    assert.equal(refreshes, 1);
    assert.equal(providerCatalogRevision(), before + 1);
    await _withRegisteredProviderForTest('catalog-startup-test', new CatalogProvider(), () => refreshCatalogs());
    assert.equal(refreshes, 1);
    assert.equal(providerCatalogRevision(), before + 1);
    await _withRegisteredProviderForTest('catalog-startup-test', new CatalogProvider(), () => (
        refreshCatalogs({ force: true })
    ));
    assert.equal(refreshes, 2);
    assert.equal(providerCatalogRevision(), before + 2);
});

test('session runtimes share one provider catalog read and rebuild only their local preferences', async () => {
    let reads = 0;
    let revision = 73001;
    const provider = {
        async listModels() {
            reads += 1;
            return [{ id: `shared-${revision}`, display: 'Shared model', mode: 'chat' }];
        },
    };
    const registry = {
        getAllProviders: () => new Map([['shared-provider', provider]]),
        providerCatalogRevision: () => revision,
    };
    const factory = () => createProviderModels({
        caches: {
            providerModelsCache: { models: null, at: 0 },
            providerModelsPromise: null,
            providerModelsLoadSeq: 0,
            webSearchProviderModelsCache: { models: null, at: 0 },
        },
        modelMetaByRoute: new Map(),
        getRoute: () => ({ provider: 'shared-provider' }),
        getConfig: () => ({}),
        getReg: () => registry,
        webSearchCapableFor: () => false,
        sortProviderModelsRaw: sortProviderModels,
        providerModelCacheRowRaw: providerModelCacheRow,
        normalizeWebSearchProviderId: (value) => value,
        isWebSearchCapableProvider: () => false,
        ensureFullConfig: () => {},
        awaitKeychainPrewarm: async () => {},
        ensureProvidersReady: async () => {},
        bootProfile: () => {},
        scheduleProviderModelWarmup: () => {},
        quickHelpers: {},
    });
    const first = factory();
    const second = factory();
    const [left, right] = await Promise.all([
        first.collectProviderModels(),
        second.collectProviderModels(),
    ]);
    assert.equal(reads, 1);
    assert.equal(left[0].id, right[0].id);

    revision += 1;
    const refreshed = await second.collectProviderModels();
    assert.equal(reads, 2);
    assert.equal(refreshed[0].id, `shared-${revision}`);
});

test('quick picker read seeds a secrets-aware full catalog load', async () => {
    let keychainReads = 0;
    let listReads = 0;
    let releaseList;
    const listGate = new Promise((resolve) => { releaseList = resolve; });
    const provider = {
        async listModels() {
            listReads += 1;
            await listGate;
            return [{ id: 'full-model', display: 'Full model', mode: 'chat' }];
        },
    };
    const registry = {
        getAllProviders: () => new Map([['catalog-provider', provider]]),
        providerCatalogRevision: () => 74001,
    };
    const api = createProviderModels({
        caches: {
            providerModelsCache: { models: null, at: 0 },
            providerModelsPromise: null,
            providerModelsLoadSeq: 0,
            webSearchProviderModelsCache: { models: null, at: 0 },
        },
        modelMetaByRoute: new Map(),
        getRoute: () => ({ provider: 'catalog-provider' }),
        getConfig: () => ({ providers: { 'catalog-provider': { enabled: true } } }),
        getReg: () => registry,
        webSearchCapableFor: () => false,
        sortProviderModelsRaw: sortProviderModels,
        providerModelCacheRowRaw: providerModelCacheRow,
        normalizeWebSearchProviderId: (value) => value,
        isWebSearchCapableProvider: () => false,
        ensureFullConfig: () => {},
        awaitKeychainPrewarm: async () => { keychainReads += 1; },
        ensureProvidersReady: async () => {},
        bootProfile: () => {},
        scheduleProviderModelWarmup: () => {},
        quickHelpers: {
            quickProviderModelRows: () => [{ id: 'quick-model', provider: 'catalog-provider' }],
        },
    });

    const quick = await api.collectProviderModels({ quick: true });
    const fullPromise = api.collectProviderModels();
    assert.equal(quick[0].id, 'quick-model');
    assert.equal(keychainReads, 1);
    releaseList();
    const full = await fullPromise;
    assert.equal(listReads, 1);
    assert.equal(full[0].id, 'full-model');
});

test('first full picker load waits for startup provider catalog refresh', async () => {
    let revision = 75001;
    let refreshed = false;
    let listReads = 0;
    let releaseRefresh;
    const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
    const provider = {
        async listModels() {
            listReads += 1;
            return [{ id: refreshed ? 'fresh-model' : 'stale-model', mode: 'chat' }];
        },
    };
    const registry = {
        getAllProviders: () => new Map([['catalog-provider', provider]]),
        providerCatalogRevision: () => revision,
        refreshProviderCatalogsOnStartup: async () => {
            await refreshGate;
            refreshed = true;
            revision += 1;
        },
    };
    const api = createProviderModels({
        caches: {
            providerModelsCache: { models: null, at: 0 },
            providerModelsPromise: null,
            providerModelsLoadSeq: 0,
            webSearchProviderModelsCache: { models: null, at: 0 },
        },
        modelMetaByRoute: new Map(),
        getRoute: () => ({ provider: 'catalog-provider' }),
        getConfig: () => ({ providers: { 'catalog-provider': { enabled: true } } }),
        getReg: () => registry,
        webSearchCapableFor: () => false,
        sortProviderModelsRaw: sortProviderModels,
        providerModelCacheRowRaw: providerModelCacheRow,
        normalizeWebSearchProviderId: (value) => value,
        isWebSearchCapableProvider: () => false,
        ensureFullConfig: () => {},
        awaitKeychainPrewarm: async () => {},
        ensureProvidersReady: async () => {},
        bootProfile: () => {},
        scheduleProviderModelWarmup: () => {},
        quickHelpers: {},
    });

    const pending = api.collectProviderModels();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(listReads, 0);
    releaseRefresh();
    const full = await pending;
    assert.equal(listReads, 1);
    assert.equal(full[0].id, 'fresh-model');
});

test('quick picker rows use the last provider-native disk catalog', () => {
    const cacheFile = join(process.env.MIXDOG_DATA_DIR, 'openai-oauth-models.json');
    writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: [{
            id: 'cached-live-model',
            display: 'Cached Live Model',
            provider: 'openai-oauth',
            contextWindow: 321000,
            outputTokens: 24000,
            mode: 'chat',
        }],
    }));
    try {
        const helpers = createQuickModelRows({
            getRoute: () => ({ provider: 'openai-oauth', model: 'configured-model' }),
            getWebSearchRoute: () => null,
            displayConfig: () => ({
                providers: { 'openai-oauth': { enabled: true } },
                presets: [],
                workflowRoutes: {},
                agents: {},
            }),
            providerModelCacheRow: (provider, model) => ({ ...model, provider }),
            providerModelsFromCacheRows: (rows) => rows,
            sortProviderModels: (rows) => rows,
            modelMetaByRoute: new Map(),
            modelMetaKey: (provider, model) => `${provider}\n${model}`,
            normalizeWebSearchProviderId: (value) => value,
            normalizeWebSearchRouteConfig: (value) => value,
            isWebSearchCapableProvider: () => true,
            webSearchCapableFor: () => true,
            currentMainWebSearchModelMeta: () => null,
        });
        const rows = helpers.quickProviderModelRows();
        const cached = rows.find((row) => row.id === 'cached-live-model');
        assert.ok(cached);
        assert.equal(cached.contextWindow, 321000);
        assert.equal(cached.outputTokens, 24000);
        assert.ok(rows.some((row) => row.id === 'configured-model'));
    } finally {
        unlinkSync(cacheFile);
    }
});

test('daemon model catalog prefetch starts immediately without changing standalone exit behavior', () => {
    const previousDelay = process.env.MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS;
    const previousDaemon = process.env.MIXDOG_DAEMON_HOST;
    try {
        delete process.env.MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS;
        delete process.env.MIXDOG_DAEMON_HOST;
        assert.equal(readRuntimeTunables().providerModelWarmupDelayMs, 2000);
        process.env.MIXDOG_DAEMON_HOST = '1';
        assert.equal(readRuntimeTunables().providerModelWarmupDelayMs, 0);
    } finally {
        if (previousDelay === undefined) delete process.env.MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS;
        else process.env.MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS = previousDelay;
        if (previousDaemon === undefined) delete process.env.MIXDOG_DAEMON_HOST;
        else process.env.MIXDOG_DAEMON_HOST = previousDaemon;
    }
});

test('Grok provider cache never reports a derived context-sized output ceiling', () => {
    const cacheFile = join(process.env.MIXDOG_DATA_DIR, 'grok-oauth-models.json');
    writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: [{
            id: 'grok-output-regression',
            provider: 'grok-oauth',
            contextWindow: 500000,
            outputTokens: 500000,
            mode: 'chat',
        }],
    }));
    try {
        const meta = providerCachedModelMetadataSync('grok-oauth', 'grok-output-regression');
        assert.equal(meta.contextWindow, 500000);
        assert.equal(meta.outputTokens, null);
    } finally {
        unlinkSync(cacheFile);
    }
});

test('Grok catalog reasoningOptions replace stale hardcoded effort levels', async () => {
    const cacheFile = join(process.env.MIXDOG_DATA_DIR, 'grok-oauth-models.json');
    writeFileSync(cacheFile, JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: [{
            id: 'grok-4.6',
            provider: 'grok-oauth',
            family: 'grok',
            reasoningLevels: ['none', 'low', 'medium', 'high'],
            reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
            contextWindow: 500000,
            created: Date.now() / 1000,
            mode: 'chat',
        }],
    }));
    try {
        const models = await new GrokOAuthProvider({ preconnect: false }).listModels();
        const grok = models.find((model) => model.id === 'grok-4.6');
        assert.deepEqual(grok.reasoningLevels, ['low', 'medium', 'high', 'xhigh']);
        assert.deepEqual(
            effortOptionsFor('grok-oauth', grok),
            ['low', 'medium', 'high', 'xhigh'],
        );
        assert.deepEqual(
            effortOptionsFor('grok-oauth', {
                family: 'grok',
                reasoningLevels: ['none', 'low', 'medium', 'high'],
                reasoningOptions: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] }],
            }),
            ['low', 'medium', 'high', 'xhigh'],
        );
    } finally {
        unlinkSync(cacheFile);
    }
});

test('provider setup refresh waits for keychain readiness and bypasses stale setup state', async () => {
    const calls = [];
    const api = createProviderAuthApi({
        awaitKeychainPrewarm: async () => { calls.push('prewarm'); },
        reloadFullConfig: () => { calls.push('reload'); },
        cachedProviderSetup: async (options) => {
            calls.push(['setup', options]);
            return { generation: 2 };
        },
    });

    assert.deepEqual(await api.getProviderSetup({ refresh: true }), { generation: 2 });
    assert.deepEqual(calls, ['prewarm', 'reload', ['setup', { force: true }]]);
});

test('provider setup lists every OAuth row in order and leads the API rows with OpenCode Go, without a separate Cursor API row', async () => {
    const setup = await providerSetup({}, { detectLocal: false, checkSecrets: false });
    assert.deepEqual(setup.oauth.map((provider) => provider.id), [
        'openai-oauth',
        'anthropic-oauth',
        'grok-oauth',
        'cursor-oauth',
        'antigravity-oauth',
    ]);
    assert.equal(setup.api[0].id, 'opencode-go');
    assert.equal(setup.api[1].id, 'openrouter');
    assert.equal([...setup.oauth, ...setup.api].some((provider) => provider.id === 'cursor-api'), false);
});

test('forced provider setup waits for an in-flight snapshot and then rebuilds it', async () => {
    let releaseFirst;
    let builds = 0;
    const usage = createProviderUsage({
        caches: {
            providerSetupCache: {},
            providerSetupQuickCache: {},
            providerSetupPromise: null,
        },
        displayConfig: () => ({}),
        providerSetup: async () => {
            builds += 1;
            if (builds === 1) await new Promise((resolve) => { releaseFirst = resolve; });
            return { generation: builds };
        },
        getReg: () => new Map(),
        getConfig: () => ({}),
        getProviderSetupWarmupTimer: () => null,
        scheduleProviderSetupWarmup() {},
        isCloseRequested: () => false,
    });

    const initial = usage.cachedProviderSetup();
    await Promise.resolve();
    const refreshed = usage.cachedProviderSetup({ force: true });
    releaseFirst();

    assert.deepEqual(await initial, { generation: 1 });
    assert.deepEqual(await refreshed, { generation: 2 });
    assert.equal(builds, 2);
});

test('usage refresh falls back to quick provider setup when the secrets-aware scan fails', async () => {
    const setupCalls = [];
    const usage = createProviderUsage({
        caches: {
            providerSetupCache: {},
            providerSetupQuickCache: {},
            providerSetupPromise: null,
            usageDashboardCache: {},
            usageDashboardPromise: null,
        },
        displayConfig: () => ({}),
        providerSetup: async (_config, options) => {
            setupCalls.push(options);
            if (options.checkSecrets !== false) throw new Error('keychain unavailable');
            return { api: [], oauth: [], local: [], quick: true };
        },
        createUsageDashboard: async (_config, options) => ({
            refresh: options.refresh,
            quick: options.setup.quick,
        }),
        getReg: () => ({ getProvider: () => null }),
        getProviderSetupWarmupTimer: () => null,
        scheduleProviderSetupWarmup() {},
        isCloseRequested: () => false,
    });

    assert.deepEqual(
        await usage.getUsageDashboard({ refresh: true, refreshSetup: false }),
        { refresh: true, quick: true },
    );
    assert.deepEqual(setupCalls, [
        { detectLocal: true },
        { detectLocal: false, checkSecrets: false },
    ]);
});

test('Codex reset credits are scoped, confirmed with an idempotency key, and refreshed after use', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    let consumed = false;
    globalThis.fetch = async (url, options = {}) => {
        requests.push({ url: String(url), options });
        if (String(url).endsWith('/consume')) {
            consumed = true;
            return new Response(JSON.stringify({ code: 'reset' }), { status: 200 });
        }
        return new Response(JSON.stringify({
            available_count: consumed ? 1 : 2,
            credits: consumed ? [{
                status: 'available',
                expires_at: '2026-08-03T00:00:00Z',
                granted_at: '2026-07-26T00:00:00Z',
            }] : [{
                status: 'available',
                expires_at: '2026-08-03T00:00:00Z',
                granted_at: '2026-07-26T00:00:00Z',
            }, {
                status: 'available',
                expires_at: '2026-08-01T00:00:00Z',
                granted_at: '2026-07-25T00:00:00Z',
            }],
        }), { status: 200 });
    };
    const provider = {
        ensureAuth: async () => ({ access_token: 'token', account_id: 'account-1' }),
    };
    try {
        const credits = await fetchOpenAICodexResetCredits(provider);
        assert.equal(credits.availableCount, 2);
        assert.deepEqual(credits.availableCredits, [{
            expiresAt: Date.parse('2026-08-01T00:00:00Z'),
            grantedAt: Date.parse('2026-07-25T00:00:00Z'),
        }, {
            expiresAt: Date.parse('2026-08-03T00:00:00Z'),
            grantedAt: Date.parse('2026-07-26T00:00:00Z'),
        }]);
        assert.match(credits.offerRevision, /^v1:[a-f0-9]{64}$/);
        const idempotencyKey = '7d9ec9f4-6c23-4e66-9fc1-3715c24a9c2e';
        const result = await consumeOpenAICodexResetCredit(provider, {
            expectedOfferRevision: credits.offerRevision,
            idempotencyKey,
        });
        assert.equal(result.outcome, 'reset');
        assert.equal(result.resetCredits.availableCount, 1);
        const consumeRequest = requests.find((request) => request.url.endsWith('/consume'));
        assert.equal(consumeRequest.options.method, 'POST');
        assert.equal(consumeRequest.options.body, JSON.stringify({ redeem_request_id: idempotencyKey }));
        assert.equal(consumeRequest.options.headers['chatgpt-account-id'], 'account-1');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('a spent Codex reset credit reports the server outcome instead of a client-side offer check', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push(`${options.method || 'GET'} ${String(url)}`);
        if (String(url).endsWith('/consume')) {
            return new Response(JSON.stringify({ code: 'already_redeemed' }), { status: 200 });
        }
        return new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 });
    };
    const provider = {
        ensureAuth: async () => ({ access_token: 'token', account_id: 'account-spent' }),
    };
    try {
        const result = await consumeOpenAICodexResetCredit(provider, {
            expectedOfferRevision: `v1:${'a'.repeat(64)}`,
            idempotencyKey: '7d9ec9f4-6c23-4e66-9fc1-3715c24a9c2e',
        });
        // The credit is gone, so the stale offer can never match again: only the
        // idempotent redeem can tell the user it was already applied.
        assert.equal(result.outcome, 'alreadyRedeemed');
        assert.equal(result.resetCredits.availableCount, 0);
        assert.ok(calls.some((entry) => entry.startsWith('POST ')));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('an interrupted Codex redeem replays its idempotent request instead of losing the credit', async () => {
    const originalFetch = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = async (url) => {
        if (String(url).endsWith('/consume')) {
            posts += 1;
            if (posts === 1) {
                throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
            }
            return new Response(JSON.stringify({ code: 'reset' }), { status: 200 });
        }
        return new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 });
    };
    const provider = {
        ensureAuth: async () => ({ access_token: 'token', account_id: 'account-retry' }),
    };
    try {
        const result = await consumeOpenAICodexResetCredit(provider, {
            expectedOfferRevision: `v1:${'c'.repeat(64)}`,
            idempotencyKey: '2f1c0e6a-71a4-4a2f-93cd-1f0d4b6c7e21',
        });
        assert.equal(result.outcome, 'reset');
        assert.equal(posts, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('a completed Codex redeem returns its outcome even when the dashboard refresh fails', async () => {
    const usage = createProviderUsage({
        caches: {
            providerSetupCache: {},
            providerSetupQuickCache: {},
            providerSetupPromise: null,
            usageDashboardCache: {},
            usageDashboardPromise: null,
        },
        displayConfig: () => ({}),
        providerSetup: async () => ({ api: [], oauth: [], local: [] }),
        createUsageDashboard: async () => { throw new Error('provider sweep failed'); },
        getReg: () => ({ getProvider: () => ({}) }),
        consumeOpenAICodexResetCredit: async () => ({ outcome: 'reset', resetCredits: null }),
        getProviderSetupWarmupTimer: () => null,
        scheduleProviderSetupWarmup() {},
        isCloseRequested: () => false,
    });

    assert.deepEqual(
        await usage.consumeCodexRateLimitResetCredit({}),
        { outcome: 'reset', resetCredits: null },
        'a spent credit must never be reported as unconfirmed because a courtesy refresh failed',
    );
});

test('Codex usage uses backend-api endpoints and preserves an embedded reset credit', async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
        const requestedUrl = String(url);
        requestedUrls.push(requestedUrl);
        if (requestedUrl === 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits') {
            return new Response('', { status: 503 });
        }
        return new Response(JSON.stringify({
            plan_type: 'pro',
            rate_limit: {
                primary_window: {
                    used_percent: 48,
                    limit_window_seconds: 5 * 60 * 60,
                    reset_at: 1_800_000_000,
                },
            },
            rate_limit_reset_credits: { available_count: 1 },
        }), { status: 200 });
    };
    const provider = {
        ensureAuth: async () => ({ access_token: 'token', account_id: 'account-embedded' }),
    };
    try {
        const snapshot = await fetchOAuthUsageSnapshot(
            { provider: 'openai-oauth', model: 'embedded-reset-credit-fixture' },
            provider,
            () => {},
            { force: true },
        );
        assert.equal(snapshot.resetCredits.availableCount, 1);
        assert.match(snapshot.resetCredits.offerRevision, /^v1:[a-f0-9]{64}$/);
        assert.equal(snapshot.quotaWindows[0].label, '5H');
        assert.deepEqual(new Set(requestedUrls), new Set([
            'https://chatgpt.com/backend-api/wham/usage',
            'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
        ]));
        assert.equal(requestedUrls.length, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('Cursor account usage flows through the OAuth cache into the usage dashboard', async () => {
    const snapshot = {
        source: 'cursor-dashboard',
        balance: {
            source: 'cursor-dashboard',
            remainingUsd: 350,
            usedUsd: 50,
            limitUsd: 400,
        },
        quotaWindows: [{
            label: 'Basic',
            source: 'cursor-dashboard',
            usedPct: 10,
            resetAt: Date.now() + 30 * 24 * 60 * 60_000,
        }, {
            label: 'API',
            source: 'cursor-dashboard',
            usedPct: 12.5,
            resetAt: Date.now() + 30 * 24 * 60 * 60_000,
        }],
    };
    const dashboard = await createUsageDashboard({}, {
        refresh: true,
        setup: {
            api: [],
            oauth: [{
                id: 'cursor-oauth',
                name: 'Cursor Account Login',
                authenticated: true,
            }],
            local: [],
        },
        getProvider: () => ({
            async getUsageSnapshot() {
                return snapshot;
            },
        }),
        log: () => {},
    });
    const row = dashboard.rows.find((entry) => entry.id === 'cursor-oauth');
    assert.equal(row.status, 'ok');
    assert.equal(row.remainingUsd, 350);
    assert.equal(row.usedUsd, 50);
    assert.equal(row.limitUsd, 400);
    assert.equal(row.source, 'cursor-dashboard');
    assert.deepEqual(row.windows.map((window) => [window.label, window.usedPct]), [
        ['Basic', 10],
        ['API', 12.5],
    ]);
});

test('provider auth waits for keychain readiness before consuming a Codex reset', async () => {
    const calls = [];
    const api = createProviderAuthApi({
        awaitKeychainPrewarm: async () => { calls.push('prewarm'); },
        consumeCodexRateLimitResetCredit: async (options) => {
            calls.push(['consume', options]);
            return { outcome: 'reset' };
        },
    });
    const options = { expectedOfferRevision: 'v1:offer', idempotencyKey: 'attempt' };
    assert.deepEqual(await api.consumeCodexRateLimitResetCredit(options), { outcome: 'reset' });
    assert.deepEqual(calls, ['prewarm', ['consume', options]]);
});

test('current vendor preset defaults and OpenCode Go protocol routes are pinned', () => {
    assert.equal(OPENAI_COMPAT_PRESETS.xai.defaultModel, 'grok-4.5');
    assert.equal(OPENAI_COMPAT_PRESETS.deepseek.defaultModel, 'deepseek-v4-pro');
    assert.equal(OPENAI_COMPAT_PRESETS['opencode-go'].defaultModel, 'glm-5.2');
    assert.equal(OPENAI_COMPAT_PRESETS.openrouter.baseURL, 'https://openrouter.ai/api/v1');
    assert.equal(OPENAI_COMPAT_PRESETS.openrouter.extraHeaders['X-OpenRouter-Title'], 'mixdog');
    for (const model of ['minimax-m3', 'minimax-m2.7', 'qwen3.7-max', 'qwen3.6-plus']) {
        assert.equal(isAnthropicGoModel(model), true, model);
    }
    for (const model of ['glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'mimo-v2.5-pro']) {
        assert.equal(isAnthropicGoModel(model), false, model);
    }
    assert.deepEqual(resolveOpenCodeGoBaseURLs(), {
        openai: 'https://opencode.ai/zen/go/v1',
        anthropic: 'https://opencode.ai/zen/go',
    });
    assert.equal(
        openCodeGoEndpointForModel('minimax-m3'),
        'https://opencode.ai/zen/go/v1/messages',
    );
    assert.equal(
        openCodeGoEndpointForModel('glm-5.2'),
        'https://opencode.ai/zen/go/v1/chat/completions',
    );
});

test('provider-specific thinking fields do not leak across compat contracts', () => {
    const deepseek = applyCompatProviderChatOptions({}, 'deepseek', { effort: 'low' });
    assert.deepEqual(deepseek, {
        thinking: { type: 'enabled' },
        reasoning_effort: 'low',
    });
    // DeepSeek documents low/high/max; medium is its own alias for high.
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'deepseek', { effort: 'medium' }),
        { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    );
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'deepseek', { effort: 'xhigh' }),
        { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    );
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'deepseek', { effort: 'none' }),
        { thinking: { type: 'disabled' } },
    );
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'ollama', { effort: 'max' }),
        { reasoning_effort: 'max' },
    );
    const go = applyCompatProviderChatOptions(
        {},
        'opencode-go',
        { effort: 'high' },
        {},
        { reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] },
    );
    assert.deepEqual(go, { reasoning_effort: 'high' });
    assert.equal(go.thinking, undefined);
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'lmstudio', {}, { reasoningEffort: 'medium' }),
        { reasoning_effort: 'medium' },
    );
    assert.deepEqual(applyCompatProviderChatOptions({}, 'xai', { effort: 'none' }), {});
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'xai', { effort: 'high' }),
        { reasoning_effort: 'high' },
    );
    assert.deepEqual(
        applyCompatProviderChatOptions({}, 'xai', { effort: 'xhigh' }),
        { reasoning_effort: 'xhigh' },
    );
    assert.deepEqual(applyCompatProviderChatOptions({}, 'deepseek'), {});
});

test('OpenRouter uses its unified reasoning contract and reported cost', () => {
    assert.deepEqual(
        applyCompatProviderChatOptions({ model: 'anthropic/claude-sonnet-4.6' }, 'openrouter', { effort: 'high' }),
        {
            model: 'anthropic/claude-sonnet-4.6',
            reasoning: { enabled: true, effort: 'high' },
        },
    );
    assert.deepEqual(
        applyCompatProviderChatOptions({ model: 'google/gemini-3-pro' }, 'openrouter', { effort: 'none' }),
        {
            model: 'google/gemini-3-pro',
            reasoning: { enabled: false },
        },
    );
    assert.equal(compatReportedCostUsd('openrouter', { cost: 0.012345 }), 0.012345);
    assert.equal(compatReportedCostUsd('openrouter', { cost: -1 }), undefined);
});

test('xai ships reasoning_effort only for the model families that accept it', () => {
    // grok-3 / grok-4 / grok-4-fast answer with HTTP 400 "does not support
    // parameter reasoningEffort", so the field must not leave the client.
    for (const model of ['grok-4', 'grok-4-fast-reasoning', 'grok-4-1-fast', 'grok-3-mini']) {
        assert.deepEqual(
            applyCompatProviderChatOptions({ model }, 'xai', { effort: 'high' }),
            { model },
            `xai must omit reasoning_effort for ${model}`,
        );
    }
    assert.deepEqual(
        applyCompatProviderChatOptions({ model: 'grok-4.5' }, 'xai', { effort: 'high' }),
        { model: 'grok-4.5', reasoning_effort: 'high' },
    );
    assert.deepEqual(
        applyCompatProviderChatOptions({ model: 'grok-4.6' }, 'xai', { effort: 'xhigh' }),
        { model: 'grok-4.6', reasoning_effort: 'xhigh' },
    );
    // A non-grok id on an xAI-compatible endpoint keeps the caller's choice.
    assert.deepEqual(
        applyCompatProviderChatOptions({ model: 'custom-reasoner' }, 'xai', { effort: 'low' }),
        { model: 'custom-reasoner', reasoning_effort: 'low' },
    );
});

test('deepseek reasoning_content replay follows the model, not the provider', () => {
    // deepseek-reasoner rejects reasoning_content in the input messages (400);
    // thinking-mode models require it back once tools are in play.
    assert.equal(deepseekReplaysReasoningContent('deepseek-reasoner'), false);
    assert.equal(deepseekReplaysReasoningContent('deepseek-chat'), true);
    assert.equal(deepseekReplaysReasoningContent('deepseek-v4'), true);

    const history = [
        { role: 'user', content: 'hi' },
        {
            role: 'assistant',
            content: 'calling',
            reasoningContent: 'inner thought',
            toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'ls' } }],
        },
        { role: 'tool', toolCallId: 'c1', content: 'ok' },
    ];
    const reasonerWire = toOpenAIMessages(history, 'deepseek');
    assert.equal(reasonerWire.find((m) => m.role === 'assistant').reasoning_content, undefined);
    const thinkingWire = toOpenAIMessages(history, 'deepseek', { replaysReasoningContent: true });
    assert.equal(thinkingWire.find((m) => m.role === 'assistant').reasoning_content, 'inner thought');
    // xAI keeps replaying by provider: omitting it is the top cache-miss cause.
    const xaiWire = toOpenAIMessages(history, 'xai');
    assert.equal(xaiWire.find((m) => m.role === 'assistant').reasoning_content, 'inner thought');
});

test('OpenRouter reasoning_details round-trip on assistant tool turns', () => {
    const reasoningDetails = [
        { type: 'reasoning.text', text: 'plan', signature: 'opaque' },
        { type: 'reasoning.encrypted', data: 'ciphertext' },
    ];
    const wire = toOpenAIMessages([
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'shell', arguments: { command: 'pwd' } }],
            providerMetadata: { openrouter: { reasoning_details: reasoningDetails } },
        },
        { role: 'tool', toolCallId: 'c1', content: 'ok' },
    ], 'openrouter');
    assert.equal(wire[0].reasoning_details, reasoningDetails);
});

test('compat chat stream preserves LM Studio reasoning alias without mixing it into answer text', async () => {
    const result = await consumeCompatChatCompletionStream(stream([
        { id: 'r', model: 'local', choices: [{ delta: { reasoning: 'plan ' } }] },
        { id: 'r', model: 'local', choices: [{ delta: { reasoning: 'done', content: 'answer' } }] },
        { id: 'r', model: 'local', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
    ]), {
        label: 'lmstudio',
        parseToolCalls,
    });
    assert.equal(result.reasoningContent, 'plan done');
    assert.equal(result.content, 'answer');
});

test('compat chat stream accumulates OpenRouter reasoning_details', async () => {
    const result = await consumeCompatChatCompletionStream(stream([
        {
            id: 'or',
            model: 'anthropic/claude-sonnet-4.6',
            choices: [{
                delta: {
                    reasoning: 'plan',
                    reasoning_details: [{ type: 'reasoning.text', text: 'plan', signature: 'opaque' }],
                },
            }],
        },
        {
            id: 'or',
            model: 'anthropic/claude-sonnet-4.6',
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: 'c1',
                        type: 'function',
                        function: { name: 'shell', arguments: '{"command":"pwd"}' },
                    }],
                },
            }],
        },
        {
            id: 'or',
            model: 'anthropic/claude-sonnet-4.6',
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
        },
    ]), {
        label: 'openrouter',
        parseToolCalls,
    });
    assert.deepEqual(result.reasoningDetails, [
        { type: 'reasoning.text', text: 'plan', signature: 'opaque' },
    ]);
    assert.deepEqual(result.response.choices[0].message.reasoning_details, result.reasoningDetails);
});

test('compat API-key auth retries a TYPED 401 once; text-only and 403 never reload', async () => {
    const forbidden = Object.create(OpenAICompatProvider.prototype);
    let forbiddenCalls = 0;
    let reloads = 0;
    forbidden._doSend = async () => {
        forbiddenCalls += 1;
        throw new Error('403 forbidden');
    };
    forbidden.reloadApiKey = () => { reloads += 1; };
    await assert.rejects(() => forbidden.send([], 'm'), /403/);
    assert.equal(forbiddenCalls, 1);
    assert.equal(reloads, 0);

    // Message text is not auth evidence: a credential reload + reissue needs a
    // TYPED status.
    const textOnly = Object.create(OpenAICompatProvider.prototype);
    let textOnlyCalls = 0;
    let textOnlyReloads = 0;
    textOnly._doSend = async () => { textOnlyCalls += 1; throw new Error('401 unauthorized'); };
    textOnly.reloadApiKey = () => { textOnlyReloads += 1; };
    await assert.rejects(() => textOnly.send([], 'm'), /401 unauthorized/);
    assert.equal(textOnlyCalls, 1, 'a text-only 401 must not be reissued');
    assert.equal(textOnlyReloads, 0);

    const structuredUnauthorized = Object.create(OpenAICompatProvider.prototype);
    let structuredCalls = 0;
    let structuredReloads = 0;
    structuredUnauthorized._doSend = async () => {
        structuredCalls += 1;
        if (structuredCalls === 1) throw Object.assign(new Error('authentication rejected'), { status: 0, httpStatus: 401 });
        return { content: 'ok' };
    };
    structuredUnauthorized.reloadApiKey = () => { structuredReloads += 1; };
    assert.equal((await structuredUnauthorized.send([], 'm')).content, 'ok');
    assert.equal(structuredCalls, 2);
    assert.equal(structuredReloads, 1);

    const structuredForbidden = Object.create(OpenAICompatProvider.prototype);
    let structuredForbiddenCalls = 0;
    structuredForbidden._doSend = async () => {
        structuredForbiddenCalls += 1;
        throw Object.assign(new Error('policy denied'), { httpStatus: 403 });
    };
    structuredForbidden.reloadApiKey = () => { throw new Error('must not reload'); };
    await assert.rejects(() => structuredForbidden.send([], 'm'), /policy denied/);
    assert.equal(structuredForbiddenCalls, 1);
});

test('OpenCode Go normalizes both route families to inclusive provider usage', async () => {
    const anthropicRaw = {
        content: 'ok',
        usage: {
            inputTokens: 60,
            outputTokens: 5,
            cachedTokens: 35,
            cacheWriteTokens: 5,
            promptTokens: 100,
        },
    };
    const openaiRaw = {
        content: 'ok',
        usage: {
            inputTokens: 100,
            outputTokens: 5,
            cachedTokens: 40,
            cacheWriteTokens: 0,
            promptTokens: 100,
        },
    };
    const provider = Object.create(OpenCodeGoProvider.prototype);
    provider.anthropic = { send: async () => anthropicRaw };
    provider.openai = { send: async () => openaiRaw };
    const anthropic = await provider.send([], 'minimax-m3', [], {});
    assert.equal(OpenCodeGoProvider.inputExcludesCache, false);
    assert.equal(isInclusiveProvider('opencode-go'), true);
    assert.equal(anthropic.usage.inputTokens, 100);
    assert.equal(anthropic.usage.promptTokens, 100);
    assert.equal(uncachedInputTokensForProvider('opencode-go', anthropic.usage.inputTokens, 35, 5), 60);
    assert.equal(billableInputTokensForProvider('opencode-go', 100, 35, 5), 60);
    assert.deepEqual(resolveTraceUsageInput({
        provider: 'opencode-go',
        inputTokens: 60,
        cachedTokens: 35,
        cacheWriteTokens: 5,
        inputTokensInclusive: false,
    }), {
        uncachedInputTokens: 60,
        promptTokens: 100,
    });
    assert.equal(anthropic.usage.inputTokens, 100, 'context footprint is inclusive');

    const openai = await provider.send([], 'glm-5.2', [], {});
    assert.equal(openai, openaiRaw);
    assert.equal(uncachedInputTokensForProvider('opencode-go', openai.usage.inputTokens, 40, 0), 60);
    assert.equal(billableInputTokensForProvider('opencode-go', 100, 40, 0), 60);
    assert.deepEqual(resolveTraceUsageInput({
        provider: 'opencode-go',
        inputTokens: 100,
        cachedTokens: 40,
        cacheWriteTokens: 0,
    }), {
        uncachedInputTokens: 60,
        promptTokens: 100,
    });
    assert.equal(openai.usage.inputTokens, 100, 'context footprint remains inclusive');
});

test('OpenCode Go Anthropic delegation traces additive inner usage before inclusive outer normalization', (t) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'mixdog-opencode-go-trace-'));
    const tracePath = join(tempDir, 'agent-trace.jsonl');
    t.after(() => rmSync(tempDir, { recursive: true, force: true }));

    const openCodeGoUrl = new URL('../src/runtime/agent/orchestrator/providers/opencode-go.mjs', import.meta.url).href;
    const anthropicUrl = new URL('../src/runtime/agent/orchestrator/providers/anthropic.mjs', import.meta.url).href;
    const traceUrl = new URL('../src/runtime/agent/orchestrator/agent-trace.mjs', import.meta.url).href;
    const fixture = `
        const { OpenCodeGoProvider } = await import(${JSON.stringify(openCodeGoUrl)});
        const { AnthropicProvider } = await import(${JSON.stringify(anthropicUrl)});
        const { drainAgentTrace } = await import(${JSON.stringify(traceUrl)});

        const encoder = new TextEncoder();
        const events = [
            { type: 'message_start', message: {
                model: 'minimax-m3',
                usage: {
                    input_tokens: 60,
                    cache_read_input_tokens: 35,
                    cache_creation_input_tokens: 5,
                },
            } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
            { type: 'message_stop' },
        ];
        const chunks = events.map((event) => encoder.encode(
            'event: ' + event.type + '\\ndata: ' + JSON.stringify(event) + '\\n\\n'
        ));
        let chunkIndex = 0;
        const response = {
            ok: true,
            status: 200,
            headers: new Map(),
            body: { getReader() {
                return {
                    read() {
                        return chunkIndex < chunks.length
                            ? Promise.resolve({ done: false, value: chunks[chunkIndex++] })
                            : Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            } },
        };

        const inner = Object.create(AnthropicProvider.prototype);
        inner.name = 'opencode-go';
        inner.config = { disableBetaHeaders: true };
        inner.fastModeBetaHeaderLatched = false;
        inner.client = { messages: { create() {
            return { asResponse: async () => response };
        } } };

        const outer = Object.create(OpenCodeGoProvider.prototype);
        outer.anthropic = inner;
        outer.openai = { send() { throw new Error('wrong OpenCode Go route'); } };
        const result = await outer.send(
            [{ role: 'user', content: 'fixture' }],
            'minimax-m3',
            [],
            { sessionId: 'opencode-go-additive-trace' },
        );
        await drainAgentTrace();
        process.stdout.write(JSON.stringify(result.usage));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', fixture], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        env: {
            ...process.env,
            MIXDOG_AGENT_TRACE_DISABLE: '0',
            MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '0',
            MIXDOG_AGENT_TRACE_PATH: tracePath,
        },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);

    const outerUsage = JSON.parse(child.stdout);
    assert.deepEqual(outerUsage, {
        inputTokens: 100,
        outputTokens: 5,
        cachedTokens: 35,
        cacheWriteTokens: 5,
        promptTokens: 100,
    });
    const traceRows = readFileSync(tracePath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
    const innerUsage = traceRows.find((row) => (
        row.kind === 'usage_raw'
        && row.session_id === 'opencode-go-additive-trace'
    ));
    assert.ok(innerUsage, 'delegated Anthropic route must emit usage_raw');
    assert.equal(innerUsage.payload.provider, 'opencode-go');
    assert.equal(innerUsage.input_tokens, 60);
    assert.equal(innerUsage.cached_tokens, 35);
    assert.equal(innerUsage.cache_write_tokens, 5);
    assert.equal(innerUsage.uncached_input_tokens, 60);
    assert.equal(innerUsage.prompt_tokens, 100);
});

test('constructing Grok OAuth prewarms only through the injected seam', () => {
    let preconnectCalls = 0;
    const provider = new GrokOAuthProvider({
        preconnectFn: () => { preconnectCalls += 1; },
    });
    assert.ok(provider);
    assert.equal(preconnectCalls, 1);
});

test('Grok OAuth end-to-end HTTP Responses path is hermetic through inner compat', async (t) => {
    const priorFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        throw new Error('global fetch attempted by hermetic Grok path');
    };
    t.after(() => { globalThis.fetch = priorFetch; });

    const provider = new GrokOAuthProvider({
        preconnect: false,
        preconnectFn: () => {
            throw new Error('preconnect/undici attempted by hermetic Grok path');
        },
        responsesTransport: 'http',
    });
    provider.ensureAuth = async () => ({ access_token: 'fixture-token', user_id: 'fixture-user' });
    const ensureInner = provider._ensureInner.bind(provider);
    let capturedInner = null;
    let capturedParams = null;
    provider._ensureInner = (...args) => {
        const inner = ensureInner(...args);
        capturedInner = inner;
        inner.client = {
            responses: {
                create: async (params) => {
                    capturedParams = params;
                    return stream([
                { type: 'response.created', response: { id: 'resp_fixture', model: 'grok-4.5' } },
                { type: 'response.output_text.delta', delta: 'hermetic' },
                {
                    type: 'response.completed',
                    response: {
                        id: 'resp_fixture',
                        model: 'grok-4.5',
                        status: 'completed',
                        output: [],
                        usage: { input_tokens: 3, output_tokens: 1 },
                    },
                },
                    ]);
                },
            },
        };
        return inner;
    };

    const result = await provider.send(
        [{ role: 'user', content: 'fixture' }],
        'grok-4.5',
        [],
        { sessionId: 'hermetic-grok-contract', iteration: 2 },
    );
    assert.equal(result.content, 'hermetic');
    assert.equal(result.usage.inputTokens, 3);
    assert.equal(capturedInner.config.preconnect, false, 'Grok seam must propagate to inner compat');
    assert.equal(typeof capturedInner.config.preconnectFn, 'function');
    assert.equal(capturedInner.baseURL, 'https://cli-chat-proxy.grok.com/v1');
    assert.equal(capturedInner.config.responsesTransport, 'http');
    assert.equal(capturedInner.defaultHeaders['x-grok-conv-id'], undefined);
    assert.equal(capturedInner.defaultHeaders['x-grok-session-id'], 'hermetic-grok-contract');
    assert.match(capturedInner.defaultHeaders['x-grok-req-id'], /^[0-9a-f-]{36}$/);
    assert.equal(capturedInner.defaultHeaders['x-grok-model-override'], 'grok-4.5');
    assert.equal(capturedInner.defaultHeaders['x-grok-turn-idx'], '2');
    assert.equal(capturedInner.defaultHeaders['x-grok-user-id'], 'fixture-user');
    assert.equal(capturedParams.store, false);
    assert.deepEqual(capturedParams.include, ['reasoning.encrypted_content']);
    assert.equal(result.providerState.xaiResponses.store, false);
    assert.equal(result.providerState.xaiResponses.previousResponseId, null);
});

test('xAI Responses defaults to HTTP and keeps WebSocket behind explicit opt-in', () => {
    assert.equal(useXaiResponsesWebSocket({}, {}), false);
    assert.equal(useXaiResponsesWebSocket({}, { responsesTransport: 'http' }), false);
    assert.equal(useXaiResponsesWebSocket({}, { responsesTransport: 'websocket' }), true);
});

// Typed-evidence contract for Responses failure events: the event's OWN status
// is preserved verbatim on every compat label, and a failure that declares no
// numeric status is never coerced into a synthetic 500 (nor sniffed out of the
// message text) — it stays unclassified and is surfaced.
for (const label of ['xai:responses', 'other-compat']) {
    test(`${label}: response.failed/error preserve typed status and never synthesize one`, async () => {
        const consume = (event) => consumeCompatResponsesStream(stream([event]), {
            label,
            parseResponsesToolCalls: () => [],
            responseOutputText: () => '',
        }).then(() => null, (err) => err);

        const typed = await consume({
            type: 'response.failed',
            response: { error: { message: 'upstream exploded', status: 503, code: 'server_error' } },
        });
        assert.equal(typed.httpStatus, 503, 'the wire status is kept verbatim');
        assert.equal(typed.providerErrorCode, 'server_error');
        assert.equal(classifyError(typed), 'transient');

        const typedAuth = await consume({ type: 'error', error: { message: 'no access', status: 403 } });
        assert.equal(typedAuth.httpStatus, 403);
        assert.equal(classifyError(typedAuth), 'auth', 'a typed 403 is never coerced to a retryable 500');

        for (const untyped of [
            { type: 'response.failed', response: { error: { message: 'forbidden' } } },
            { type: 'error', message: 'forbidden' },
        ]) {
            const err = await consume(untyped);
            assert.equal(err.httpStatus, undefined, `${untyped.type}: no status may be synthesized`);
            assert.equal(classifyError(err), 'transient', 'an uncoded wire failure default-retries');
        }

        // Deterministic refusal codes on the wire event stay terminal.
        const fatal = await consume({
            type: 'response.failed',
            response: { error: { message: 'quota', code: 'insufficient_quota' } },
        });
        assert.equal(classifyError(fatal), 'permanent');
    });
}

test('Grok OAuth does not refresh/replay a 401 after visible tool dispatch', async () => {
    const provider = Object.create(GrokOAuthProvider.prototype);
    provider.config = { preconnect: false };
    let authCalls = 0;
    provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
        authCalls += 1;
        assert.equal(forceRefresh, false);
        return { access_token: 'fixture-token' };
    };
    const streamed401 = Object.assign(new Error('401 midstream'), {
        httpStatus: 401,
        emittedToolCall: true,
        unsafeToRetry: true,
    });
    let dispatched = 0;
    provider._ensureInner = () => ({
        _doSend: async (_messages, _model, _tools, opts) => {
            opts.onToolCall({ id: 'call-visible', name: 'write', arguments: { path: 'x' } });
            dispatched += 1;
            throw streamed401;
        },
    });
    await assert.rejects(() => provider.send([], 'grok-4.5', [], {
        onToolCall: () => {},
    }), (err) => err === streamed401);
    assert.equal(dispatched, 1);
    assert.equal(authCalls, 1);
});

test('xAI WS to HTTP fallback preserves completed warmup usage and cost ticks', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'auto';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    const provider = new OpenAICompatProvider('xai', {
        apiKey: 'fixture',
        preconnect: false,
        responsesTransport: 'websocket',
    });
    const warmup = {
        requestBody: { generate: false },
        usage: { inputTokens: 10, outputTokens: 1, cachedTokens: 4, promptTokens: 10, raw: { cost_in_usd_ticks: 100 } },
    };
    provider._doSendXaiResponsesWebSocket = async () => {
        const err = Object.assign(new Error('upgrade required'), { httpStatus: 426 });
        Object.defineProperty(err, '__warmup', { value: warmup });
        throw err;
    };
    provider._doSendXaiResponses = async () => ({
        content: 'fallback',
        usage: { inputTokens: 20, outputTokens: 2, cachedTokens: 5, promptTokens: 20, raw: { cost_in_usd_ticks: 200 }, costUsd: 0.00000002 },
    });
    const result = await provider._doSend([], 'grok-4.5', [], {});
    assert.equal(result.usage.inputTokens, 30);
    assert.equal(result.usage.mainInputTokens, 20);
    assert.equal(result.usage.raw.cost_in_usd_ticks, 300);
    assert.equal(result.usage.costUsd, 0.00000003);
});

test('xAI WS warmup billing exposes only main request usage as context', async () => {
    let streams = 0;
    const result = await sendViaWebSocket({
        auth: { type: 'xai', apiKey: 'fixture' },
        body: { model: 'grok-4.5', input: [{ role: 'user', content: 'main' }] },
        sendOpts: {},
        externalSignal: null,
        poolKey: 'xai-warmup-accounting',
        cacheKey: 'xai-warmup-accounting',
        iteration: 1,
        useModel: 'grok-4.5',
        traceProvider: 'xai',
        includeResponseId: true,
        warmupBody: { model: 'grok-4.5', input: [], generate: false },
        _acquireWithRetryFn: async () => ({ entry: { socket: { close() {} } }, reused: false }),
        _sendFrameFn: async () => {},
        _streamFn: async ({ state }) => {
            streams += 1;
            return state.warmup
                ? {
                    content: '',
                    model: 'grok-4.5',
                    toolCalls: [],
                    usage: { inputTokens: 10, outputTokens: 1, cachedTokens: 4, promptTokens: 10, raw: { cost_in_usd_ticks: 100 } },
                    responseId: 'warm',
                    responseItems: [],
                }
                : {
                    content: 'done',
                    model: 'grok-4.5',
                    toolCalls: [],
                    usage: { inputTokens: 20, outputTokens: 2, cachedTokens: 5, promptTokens: 20, raw: { cost_in_usd_ticks: 200 } },
                    responseId: 'main',
                    responseItems: [],
                    closeSocket: true,
                };
        },
        _agentTraceFn: () => {},
        _sendSpanTraceFn: () => {},
    });
    assert.equal(streams, 2);
    assert.equal(result.usage.inputTokens, 30);
    assert.equal(result.usage.mainInputTokens, 20);
    assert.equal(result.usage.raw.cost_in_usd_ticks, 300);
});

test('xAI safe 401 replay carries completed warmup into the retry', async () => {
    const provider = new OpenAICompatProvider('xai', { apiKey: 'fixture', preconnect: false });
    const warmup = { usage: { inputTokens: 10 } };
    let attempts = 0;
    provider.reloadApiKey = () => {};
    provider._doSend = async (_messages, _model, _tools, opts) => {
        attempts += 1;
        if (attempts === 1) {
            const err = Object.assign(new Error('401'), { httpStatus: 401 });
            Object.defineProperty(err, '__warmup', { value: warmup });
            throw err;
        }
        assert.equal(opts._carriedWarmup, warmup);
        return { content: 'retried' };
    };
    assert.equal((await provider.send([], 'grok-4.5', [], {})).content, 'retried');
    assert.equal(attempts, 2);
});

for (const status of [401, 403]) {
    test(`Grok OAuth safe ${status} replay carries completed warmup to refreshed xAI inner`, async () => {
        const provider = Object.create(GrokOAuthProvider.prototype);
        provider.config = { preconnect: false };
        const warmup = { usage: { inputTokens: 10 } };
        let authCalls = 0;
        provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
            authCalls += 1;
            return { access_token: forceRefresh ? 'fresh' : 'stale' };
        };
        provider._ensureInner = (token) => ({
            _doSend: async (_messages, _model, _tools, opts) => {
                if (token === 'stale') {
                    const err = Object.assign(new Error(String(status)), { httpStatus: status });
                    Object.defineProperty(err, '__warmup', { value: warmup });
                    throw err;
                }
                assert.equal(opts._carriedWarmup, warmup);
                return { content: 'retried' };
            },
        });
        assert.equal((await provider.send([], 'grok-4.5', [], {})).content, 'retried');
        assert.equal(authCalls, 2);
    });
}
