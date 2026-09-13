import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCompactionRoute, runFreshContextCompact } from './loop/fresh-context.mjs';
import { compactTargetBudget, currentContextEstimateTokens, resolveWorkerCompactPolicy } from './loop/compact-policy.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';
import { freshContextCompactMessages } from './compact.mjs';
import { runSessionCompaction } from './manager/compaction-runner.mjs';
import { inheritanceCompactionPlan } from '../../../../session-runtime/inheritance-fit.mjs';

const summary = [
    '## Goal', '- continue the task',
    '## Constraints & Preferences', '- keep source records',
    '## Progress', '### Done', '- old work completed',
    '### In Progress', '- current task', '### Blocked', '- (none)',
    '## Key Decisions', '- preserve the original record',
    '## Next Steps', '- continue',
    '## Critical Context', '- retained fact',
    '## Relevant Files', '- working.mjs',
].join('\n');

function fixture() {
    const session = {
        id: 'rolling-fixture', provider: 'fixture-main', model: 'main-model',
        contextWindow: 100_000, tools: [],
        messages: [
            { role: 'system', content: 'immutable system rules' },
            { role: 'user', content: 'older request' },
            { role: 'assistant', content: 'older answer' },
            { role: 'user', content: 'latest request' },
        ],
    };
    const provider = { name: session.provider, async send() { return { content: summary }; } };
    return { session, provider };
}

test('the 25% target includes request overhead and leaves existing trigger settings intact', () => {
    for (const provider of ['anthropic-oauth', 'openai-oauth', 'grok-oauth']) {
        const session = {
            provider, contextWindow: 500_000, compaction: { reservedTokens: 2_000 },
        };
        const policy = resolveWorkerCompactPolicy(session, [
            { name: 'read', description: 'Read a file.', inputSchema: { type: 'object' } },
        ]);
        assert.equal(policy.compactTargetTokens, 125_000);
        assert.equal(policy.triggerTokens, 498_000);
        const budget = compactTargetBudget(policy);
        const messageRoom = budget - policy.reserveTokens;
        assert.ok(messageRoom > 0);
        assert.ok(currentContextEstimateTokens(messageRoom, policy) <= 125_000);
        assert.ok(currentContextEstimateTokens(messageRoom, policy) >= 124_990);
        const inheritance = inheritanceCompactionPlan(session);
        assert.equal(inheritance.budgetTokens, compactTargetBudget({
            ...resolveWorkerCompactPolicy(session, []), force: true,
        }));
    }
});

test('only an enabled explicit maintenance route overrides the conversation model', async () => {
    const { session, provider } = fixture();
    const config = {
        builtins: { memory: { installed: true } },
        agents: { maintainer: { provider: 'fixture-maintenance', model: 'maintenance-model' } },
    };
    const maintenance = { name: 'fixture-maintenance', getCachedModelInfo: () => ({ contextWindow: 16_000 }), async send() {} };
    let initialized = 0;
    const resolve = (cfg) => resolveCompactionRoute({
        sessionRef: session, provider, config: cfg,
        initProvidersFn: async () => { initialized += 1; },
        getProviderFn: name => name === maintenance.name ? maintenance : provider,
    });
    const selected = await resolve(config);
    assert.equal(selected.provider, maintenance);
    assert.equal(selected.model, 'maintenance-model');
    assert.equal(initialized, 1);
    for (const disabled of [
        {},
        { default: { provider: 'unrelated', model: 'unrelated' } },
        { ...config, disabledAgents: ['maintainer'] },
        { ...config, memoryTools: { enabled: false } },
        { ...config, recap: { enabled: false } },
        { ...config, providers: { 'fixture-maintenance': { enabled: false } } },
    ]) {
        const selected = await resolve(disabled);
        assert.equal(selected.provider, provider);
        assert.equal(selected.model, session.model);
    }
    assert.equal(initialized, 1);
});

test('maintenance summarization is isolated from the main request and its provider credentials', async () => {
    const { session, provider } = fixture();
    session.messages.splice(3, 0, ...Array.from({ length: 80 }, (_, i) => ({
        role: 'assistant', content: `MAINTENANCE_SOURCE_${i}`.padEnd(1600, '.'),
    })));
    const original = structuredClone(session);
    let sent = 0;
    const maintenance = {
        name: 'fixture-maintenance',
        getCachedModelInfo: () => ({ contextWindow: 16_000 }),
        async send(messages, model, tools, opts) {
            sent += 1;
            assert.equal(model, 'maintenance-model');
            assert.equal(tools, undefined);
            assert.deepEqual(messages.map(m => m.role), ['system', 'user']);
            assert.ok(estimateMessagesTokens(messages) < 16_000);
            assert.notEqual(opts.session, session);
            assert.equal(opts.session.provider, this.name);
            assert.equal(opts.session.id, `${session.id}:compact`);
            assert.equal(opts.sessionId, `${session.id}:compact`);
            for (const key of ['apiKey', 'baseUrl', 'providerState', 'onTextDelta', 'onUsageDelta']) {
                assert.equal(opts[key], undefined, key);
            }
            return { content: summary };
        },
    };
    const result = await runFreshContextCompact({
        sessionRef: session, messages: session.messages, provider,
        compactBudgetTokens: 25_000, compactPolicy: { contextWindow: 100_000 },
        config: {
            builtins: { memory: { installed: true } },
            agents: { maintainer: { provider: maintenance.name, model: 'maintenance-model' } },
        },
        initProvidersFn: async () => {},
        getProviderFn: () => maintenance,
        sendOpts: { session, apiKey: 'main-only', baseUrl: 'https://main.invalid', providerState: { prior: 'request' }, onTextDelta() {} },
        executeMemorySearch: async () => { assert.fail('Memory must not participate'); },
    });
    assert.ok(sent > 1, 'the smaller maintenance context must split the large conversation');
    assert.equal(result.summaryProvider, maintenance.name);
    assert.equal(result.summaryModel, 'maintenance-model');
    assert.deepEqual(session, original);
});

test('a maintenance provider error is not retried through another provider', async () => {
    const { session, provider } = fixture();
    const denial = new Error('provider permission denied');
    let mainCalls = 0;
    provider.send = async () => { mainCalls += 1; return { content: summary }; };
    await assert.rejects(runFreshContextCompact({
        sessionRef: session, messages: session.messages, provider, compactBudgetTokens: 25_000,
        config: {
            builtins: { memory: { installed: true } },
            agents: { maintainer: { provider: 'maintenance', model: 'maintenance-model' } },
        },
        initProvidersFn: async () => {},
        getProviderFn: () => ({ name: 'maintenance', async send() { throw denial; } }),
    }), error => error === denial);
    assert.equal(mainCalls, 0);
});

test('cancellation after a late summary response does not publish a replacement', async () => {
    const { session, provider } = fixture();
    const original = structuredClone(session);
    const controller = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    provider.send = async () => {
        controller.abort(reason);
        return { content: summary };
    };
    await assert.rejects(runFreshContextCompact({
        config: {}, sessionRef: session, messages: session.messages, provider,
        signal: controller.signal, compactBudgetTokens: 25_000,
    }), error => error === reason);
    assert.deepEqual(session, original);
});

test('manual summary failure preserves the original session and provider continuation', async () => {
    const { session, provider } = fixture();
    const originalMessages = session.messages;
    const original = structuredClone(originalMessages);
    session.providerState = { previousResponse: 'keep-on-failure' };
    provider.send = async () => { throw new Error('summary unavailable'); };
    const result = await runSessionCompaction(session, { config: {}, provider, mode: 'manual' });
    assert.equal(result.changed, false);
    assert.match(result.error, /summary unavailable/);
    assert.equal(session.messages, originalMessages);
    assert.deepEqual(session.messages, original);
    assert.deepEqual(session.providerState, { previousResponse: 'keep-on-failure' });
});

test('the target is soft for mandatory context, but the full context window is a hard bound', () => {
    const messages = [
        { role: 'system', content: 'mandatory instruction '.repeat(500) },
        { role: 'user', content: 'latest request stays verbatim' },
    ];
    const result = freshContextCompactMessages(messages, 1_000, {
        force: true, maxBudgetTokens: 20_000, handoffText: summary,
    });
    assert.equal(result.messages[0].content, messages[0].content);
    assert.equal(result.messages.at(-1).content, messages.at(-1).content);
    assert.equal(result.diagnostics.targetExceeded, true);
    assert.ok(estimateMessagesTokens(result.messages) < 20_000);
    assert.throws(() => freshContextCompactMessages(messages, 1_000, {
        force: true, maxBudgetTokens: 2_000, handoffText: summary,
    }), /exceeds compact budget/);
});

test('an oversized legacy summary is carried forward in complete bounded fragments', async () => {
    const { session, provider } = fixture();
    session.contextWindow = 6_000;
    const markers = Array.from({ length: 20 }, (_, i) => `LEGACY_FACT_${i}_END`);
    session.messages.splice(1, 2, {
        role: 'user', meta: { source: 'compact-summary' },
        content: markers.map(marker => marker.padEnd(1600, '.')).join(''),
    });
    const original = structuredClone(session.messages);
    const prompts = [];
    provider.send = async (messages) => {
        assert.ok(estimateMessagesTokens(messages) < session.contextWindow);
        prompts.push(messages[1].content);
        return { content: summary };
    };
    const result = await runFreshContextCompact({
        config: {}, sessionRef: session, messages: session.messages, provider,
        compactBudgetTokens: 1_500,
    });
    assert.ok(prompts.length > 1);
    for (const marker of markers) {
        assert.ok(prompts.some(prompt => prompt.includes(marker)), `missing legacy source: ${marker}`);
    }
    assert.equal(result.messages.filter(m => m.meta?.source === 'compact-summary').length, 1);
    assert.equal(result.messages.at(-1).content, 'latest request');
    assert.deepEqual(session.messages, original);
});
