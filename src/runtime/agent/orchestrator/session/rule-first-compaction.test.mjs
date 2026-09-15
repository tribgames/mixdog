import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFreshContextCompact } from './loop/fresh-context.mjs';
import { currentContextEstimateTokens, resolveWorkerCompactPolicy } from './loop/compact-policy.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { runSessionCompaction } from './manager/compaction-runner.mjs';
import { agentLoop } from './agent-loop.mjs';
import { SUMMARY_PREFIX } from './compact.mjs';

const summary = [
    '## Goal', '- continue the approved task',
    '## Constraints & Preferences', '- preserve the latest request',
    '## Progress', '### Done', '- prior dialogue reviewed',
    '### In Progress', '- current task', '### Blocked', '- (none)',
    '## Key Decisions', '- tool outcomes stay separate',
    '## Next Steps', '- continue',
    '## Critical Context', '- prior dialogue is summarized here',
    '## Relevant Files', '- (none)',
].join('\n');

function fixture() {
    return {
        provider: 'rule-test', model: 'rule-test-model', contextWindow: 40_000,
        compaction: {},
        messages: [
            { role: 'system', content: 'SYSTEM_RULES' },
            { role: 'user', content: 'OLD_REQUEST' },
            { role: 'assistant', content: 'OLD_ANSWER' },
            { role: 'user', content: 'LATEST_REQUEST' },
        ],
    };
}

function compact(session, options = {}) {
    return runFreshContextCompact({
        config: {}, sessionRef: session, messages: session.messages,
        compactBudgetTokens: 10_000, compactPolicy: { contextWindow: session.contextWindow, reserveTokens: 0 },
        ...options,
    });
}

test('main and agent sessions use the same 100% default, including old derived buffer telemetry', () => {
    for (const owner of [undefined, 'agent']) {
        for (const compaction of [
            {},
            { bufferTokens: 0, bufferRatio: 0 },
            { bufferTokens: 4_000, bufferRatio: 0.1, boundaryTokens: 40_000, triggerTokens: 36_000 },
        ]) {
            const policy = resolveWorkerCompactPolicy({ owner, contextWindow: 40_000, compaction }, []);
            assert.equal(policy.triggerTokens, 40_000);
            assert.equal(policy.bufferTokens, 0);
        }
    }
});

test('ordinary Compact preserves all dialogue without resolving or calling an AI provider', async () => {
    const session = fixture();
    session.messages.splice(3, 0, { role: 'user', content: '[mixdog-runtime] obsolete notification' });
    const original = structuredClone(session);
    const result = await compact(session, {
        initProvidersFn: async () => assert.fail('rule-only compaction must not initialize providers'),
        getProviderFn: () => assert.fail('rule-only compaction must not resolve providers'),
    });
    assert.deepEqual(result.messages, original.messages.filter(m => !m.content.startsWith('[mixdog-runtime]')));
    assert.deepEqual(session, original);
    assert.equal(result.handoffSource, 'rules');
    assert.equal(result.usage, null);
    assert.equal(result.summaryProvider, null);
    assert.equal(result.diagnostics.pipeline.conversationThresholdTokens, 10_000);
    assert.equal(result.diagnostics.pipeline.summaryTriggered, false);
    const repeat = await compact({ ...session, messages: result.messages });
    assert.deepEqual(repeat.messages, result.messages);
});

test('AI is called only above the conversation threshold and never receives the latest request or system rules', async () => {
    const session = fixture();
    const sourceTokens = estimateMessagesTokens(session.messages.slice(1, 3));
    let calls = 0;
    const provider = { name: session.provider, async send(messages) {
        calls += 1;
        const prompt = messages[1].content;
        assert.match(prompt, /OLD_REQUEST/);
        assert.match(prompt, /OLD_ANSWER/);
        assert.doesNotMatch(prompt, /LATEST_REQUEST|SYSTEM_RULES/);
        return { content: summary, usage: { inputTokens: 20, outputTokens: 10 } };
    } };
    session.compaction.conversationThresholdTokens = sourceTokens;
    const exact = await compact(session, { provider });
    assert.equal(calls, 0);
    assert.equal(exact.diagnostics.pipeline.conversationTokens, sourceTokens);
    session.compaction.conversationThresholdTokens = sourceTokens - 1;
    const exceeded = await compact(session, { provider });
    assert.equal(calls, 1);
    assert.equal(exceeded.diagnostics.pipeline.summaryTriggered, true);
    assert.equal(exceeded.messages.at(-1).content, 'LATEST_REQUEST');
    assert.equal(exceeded.messages[0].content, 'SYSTEM_RULES');
    assert.equal(exceeded.messages.filter(m => m.meta?.source === 'compact-summary').length, 1);
    assert.equal(exceeded.usage.outputTokens, 10);
});

test('tool pressure alone uses rules and preserves an exact recoverable archive, without AI', async t => {
    const previous = process.env.MIXDOG_DATA_DIR;
    const root = mkdtempSync(join(tmpdir(), 'mixdog-rule-first-'));
    process.env.MIXDOG_DATA_DIR = root;
    t.after(() => {
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    });
    const session = fixture();
    const output = 'FAILED_PARTIAL_RESULT\n'.repeat(12_000);
    session.messages.splice(3, 0,
        { role: 'assistant', content: 'READ_ATTEMPT', toolCalls: [{ id: 'read-1', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'read-1', content: output },
        { role: 'user', meta: 'skill', content: '<skill>\n<name>guide</name>\nCOMPLETE_SKILL_BODY\n</skill>' },
    );
    const before = structuredClone(session.messages);
    assert.ok(estimateMessagesTokens(before) > 40_000);
    const result = await compact(session, {
        sessionId: 'tool-pressure-only',
        provider: { name: session.provider, async send() { assert.fail('tool pressure must not trigger AI'); } },
    });
    assert.equal(result.diagnostics.pipeline.summaryTriggered, false);
    assert.ok(result.messages.some(m => m.content === 'OLD_REQUEST'));
    assert.ok(result.messages.some(m => m.content === 'OLD_ANSWER'));
    assert.ok(result.messages.some(m => m.content?.includes?.('COMPLETE_SKILL_BODY')));
    const recovery = result.messages.find(m => m.meta?.source === 'compact-execution-recovery');
    const path = recovery.content.match(/available at (.+?) \(sha256:/)[1];
    const archived = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(archived.messages.find(m => m.toolCallId === 'read-1').content, output);
    assert.deepEqual(session.messages, before);
    assert.deepEqual(result.messages.filter(m => m.role === 'tool').map(m => m.toolCallId),
        result.messages.flatMap(m => (m.toolCalls || []).map(call => call.id)));
});

test('a previous summary is retained verbatim on rule-only passes', async () => {
    const session = fixture();
    const previous = { role: 'user', meta: { source: 'compact-summary' },
        content: `${SUMMARY_PREFIX}\nmessages=2 sha256=previous\n\n${summary}` };
    session.messages.splice(1, 0, previous, { role: 'assistant', content: '.' });
    const result = await compact(session);
    assert.deepEqual(result.messages.find(m => m.meta?.source === 'compact-summary'), previous);
    assert.ok(result.messages.some(m => m.content === 'OLD_ANSWER'));
    const repeat = await compact({ ...session, messages: result.messages });
    assert.deepEqual(repeat.messages, result.messages);
});

test('large dialogue triggers one cumulative AI summary, then returns to rule-only compaction', async () => {
    const session = fixture();
    session.messages[2].content = 'Older discussion facts. '.repeat(9_000);
    assert.ok(estimateMessagesTokens(session.messages.slice(1, 3)) > 10_000);
    let calls = 0;
    const provider = { name: session.provider, async send() { calls += 1; return { content: summary }; } };
    const first = await compact(session, { provider });
    assert.ok(calls >= 1);
    const firstCalls = calls;
    const second = await compact({ ...session, messages: first.messages }, { provider });
    assert.equal(calls, firstCalls);
    assert.equal(second.diagnostics.pipeline.summaryTriggered, false);
    assert.deepEqual(second.messages, first.messages);
});

test('a pre-send threshold check without compaction does not emit PostCompact', async () => {
    const session = fixture();
    let before = 0;
    let after = 0;
    const result = await runPreSendCompactPass({
        sessionRef: session, messages: session.messages, requestTools: [], opts: {
            preCompactHook: async () => before++,
            postCompactHook: async () => after++,
        },
    });
    assert.equal(result.compactChanged, false);
    assert.equal(before, 0);
    assert.equal(after, 0);
});

test('a rule-only manual no-op preserves the provider continuation and reports no AI usage', async () => {
    const session = fixture();
    session.providerState = { previousResponse: 'keep-unchanged-prefix' };
    const before = structuredClone(session.messages);
    const result = await runSessionCompaction(session, { config: {}, mode: 'manual' });
    assert.equal(result.changed, false);
    assert.equal(result.usage, null);
    assert.deepEqual(session.messages, before);
    assert.deepEqual(session.providerState, { previousResponse: 'keep-unchanged-prefix' });
    assert.equal(session.compaction.lastSummaryProvider, null);
    assert.equal(session.compaction.lastSummaryModel, null);
});

test('mandatory dialogue above an explicit trigger reaches the provider instead of recompacting in a loop', { timeout: 5_000 }, async t => {
    const session = fixture();
    session.autoCompactTokenLimit = 4_000;
    session.messages.splice(3, 0, { role: 'user', content: '[mixdog-runtime] REMOVE_THIS_OBSOLETE_NOTIFICATION' });
    session.messages.at(-1).content = 'Preserved latest instruction. '.repeat(2_000);
    const policy = resolveWorkerCompactPolicy(session, []);
    assert.ok(currentContextEstimateTokens(estimateMessagesTokens(session.messages), policy) > 4_000);
    let mainCalls = 0;
    let compactHooks = 0;
    const provider = { name: session.provider, async send(messages, _model, _tools, opts) {
        assert.notEqual(opts.sessionId, `${session.id}:compact`, 'latest request alone cannot trigger AI');
        assert.equal(messages.some(m => m.content?.includes?.('REMOVE_THIS_OBSOLETE_NOTIFICATION')), false);
        mainCalls += 1;
        return { content: 'Finished.', usage: { inputTokens: 8_000, outputTokens: 2 } };
    } };
    await agentLoop(provider, session.messages, session.model, [], async () => assert.fail('no tools expected'),
        process.cwd(), {
            session,
            signal: t.signal,
            postCompactHook: async () => {
                compactHooks += 1;
                assert.ok(compactHooks <= 1, 'only one compact pass is allowed before the provider send');
            },
        });
    assert.equal(mainCalls, 1);
    assert.equal(compactHooks, 1);
});
