import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freshContextCompactMessages, SUMMARY_PREFIX } from './compact.mjs';
import { runFreshContextCompact } from './loop/fresh-context.mjs';

test('fresh Compact summarizes the live conversation without calling Memory', async () => {
    const messages = [{ role: 'system', content: 'system' }];
    for (let index = 0; index < 7; index += 1) {
        messages.push(
            { role: 'user', content: `request-${index}` },
            {
                role: 'assistant',
                content: index === 0
                    ? 'LOCAL_ONLY_OLD_HISTORY DUPLICATE_STATE'
                    : `answer-${index}`,
            },
        );
    }
    let summaryInput = '';
    const sessionId = 'sess-recall-verbatim';
    const result = await runFreshContextCompact({
        config: {},
        model: 'fake-model',
        provider: { name: 'fake', async send(input) {
            summaryInput = input[1].content;
            return { content: GENERATED_HANDOFF };
        } },
        sessionRef: {
            id: sessionId,
            cwd: 'C:\\Project\\mixdog',
            compaction: { conversationThresholdTokens: 1 },
            contextWindow: 100_000,
            compactBoundaryTokens: 100_000,
        },
        messages,
        compactBudgetTokens: 30_000,
        compactPolicy: {
            contextWindow: 100_000,
            boundaryTokens: 100_000,
            reserveTokens: 0,
        },
        sessionId,
        executeMemorySearch: async () => { assert.fail('compaction must not read or write Memory'); },
    });

    const summary = result.messages.find((message) => (
        message.role === 'user'
        && typeof message.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX)
    ));
    assert.ok(summary);
    assert.match(summaryInput, /LOCAL_ONLY_OLD_HISTORY/);
    assert.match(summary.content, /one Compact path/);
    assert.doesNotMatch(summary.content, /memory_session=/);
});

test('fresh Compact excludes skill bodies and tool output from the conversation summary request', async () => {
    let summaryInput = '';
    const result = await runFreshContextCompact({
        config: {},
        model: 'fake-model',
        provider: { name: 'fake', async send(input) {
            summaryInput = input[1].content;
            return { content: GENERATED_HANDOFF };
        } },
        sessionRef: {
            id: 'sess-ingest-barrier',
            cwd: 'C:\\Project\\mixdog',
            compaction: { conversationThresholdTokens: 1 },
            contextWindow: 100_000,
            compactBoundaryTokens: 100_000,
        },
        messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', meta: 'skill', content: '<skill>\n<name>demo</name>\nSKILL_BODY_ONLY\n</skill>' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'read-source', name: 'read', arguments: '{}' }] },
            { role: 'tool', toolCallId: 'read-source', content: 'TOOL_OUTPUT_ONLY' },
            { role: 'user', content: 'current request' },
        ],
        compactBudgetTokens: 50_000,
        compactPolicy: {
            contextWindow: 100_000,
            boundaryTokens: 100_000,
            reserveTokens: 0,
        },
        sessionId: 'sess-ingest-barrier',
    });
    assert.match(summaryInput, /old request/);
    assert.doesNotMatch(summaryInput, /SKILL_BODY_ONLY|TOOL_OUTPUT_ONLY/);
    assert.equal(result.messages.find(m => m.toolCallId === 'read-source')?.content, 'TOOL_OUTPUT_ONLY');
});

test('pre-send active turn reaches the fresh builder as a continuation', async () => {
    const result = await runFreshContextCompact({
        config: {},
        model: 'fake-model',
        provider: { name: 'fake', async send() { return { content: GENERATED_HANDOFF }; } },
        sessionRef: {
            id: 'sess-active-turn',
            cwd: 'C:\\Project\\mixdog',
            contextWindow: 100_000,
            compactBoundaryTokens: 100_000,
        },
        messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'inspect the mobile page' },
            {
                role: 'assistant',
                content: 'starting mobile inspection',
                toolCalls: [{ id: 'browser-call', name: 'browser', arguments: '{}' }],
            },
            { role: 'tool', toolCallId: 'browser-call', content: 'mobile inspection completed' },
        ],
        compactBudgetTokens: 50_000,
        compactPolicy: {
            contextWindow: 100_000,
            boundaryTokens: 100_000,
            reserveTokens: 0,
        },
        sessionId: 'sess-active-turn',
        activeTurn: true,
    });

    assert.match(String(result.messages.at(-1)?.content), /already in progress/i);
    assert.equal(result.diagnostics.activeTurnContinuation, true);
});

test('repeated compact replaces one cumulative summary and does not replay older raw history', async () => {
    const sessionId = 'sess-repeat-full-rebuild';
    const prompts = [];
    const provider = {
        name: 'fake',
        async send(input) {
            prompts.push(input[1].content);
            return { content: GENERATED_HANDOFF.replace('one Compact path', `CUMULATIVE_REVISION_${prompts.length}`) };
        },
    };
    const compactPolicy = {
        contextWindow: 100_000,
        boundaryTokens: 100_000,
        reserveTokens: 0,
    };
    const original = [{ role: 'system', content: 'system' }];
    for (let turn = 1; turn <= 7; turn += 1) {
        original.push(
            { role: 'user', content: `request-${turn}` },
            { role: 'assistant', content: `answer-${turn}` },
        );
    }
    const first = await runFreshContextCompact({
        config: {},
        provider,
        model: 'fake-model',
        sessionRef: { id: sessionId, cwd: 'C:\\Project\\mixdog', contextWindow: 100_000,
            compaction: { conversationThresholdTokens: 1 } },
        messages: original,
        compactBudgetTokens: 50_000,
        compactPolicy,
        sessionId,
    });
    const second = await runFreshContextCompact({
        config: {},
        provider,
        model: 'fake-model',
        sessionRef: { id: sessionId, cwd: 'C:\\Project\\mixdog', contextWindow: 100_000,
            compaction: { conversationThresholdTokens: 1 } },
        messages: [
            ...JSON.parse(JSON.stringify(first.messages)),
            { role: 'user', content: 'follow-up request' },
            { role: 'assistant', content: 'follow-up answer' },
            { role: 'user', content: 'current request' },
        ],
        compactBudgetTokens: 50_000,
        compactPolicy,
        sessionId,
    });
    const secondSummary = second.messages.find((message) => (
        typeof message.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX)
    ));
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /request-1/);
    assert.match(prompts[1], /CUMULATIVE_REVISION_1/);
    assert.match(prompts[1], /follow-up request/);
    assert.doesNotMatch(prompts[1], /request-1|answer-1/);
    assert.match(secondSummary.content, /CUMULATIVE_REVISION_2/);
    assert.doesNotMatch(secondSummary.content, /CUMULATIVE_REVISION_1/);
    assert.equal(second.messages.filter(m => m.meta?.source === 'compact-summary').length, 1);
    assert.equal(secondSummary?.content.split(SUMMARY_PREFIX).length - 1, 1);
});

test('fresh layout keeps session injection and stable summary before the volatile Goal/latest-user tail', () => {
    const sessionPrefix = [
        { role: 'system', content: 'BP1 tool policy' },
        { role: 'system', content: 'BP2 profile and skills' },
        { role: 'system', content: 'BP3 workflow and memory', cacheTier: 'tier3' },
        { role: 'system', content: 'session environment', cacheTier: 'env' },
        { role: 'user', content: '<system-reminder>\n# SessionStart Hook Context\nstable hook context\n</system-reminder>' },
        { role: 'assistant', content: '.' },
    ];
    const latestInstruction = '<system-reminder>\n<goal_state>\nSTALE_GOAL_STATE\n</goal_state>\n</system-reminder>\n\n<system-reminder>\n# Current Time\n2026-09-01\n</system-reminder>\n\nLATEST_REAL_USER_INSTRUCTION';
    const messages = [
        ...sessionPrefix,
        { role: 'user', content: 'older request' },
        {
            role: 'assistant',
            content: 'old assistant execution',
            toolCalls: [{ id: 'old-call', name: 'read', arguments: '{}' }],
            providerReplay: { items: [{ type: 'reasoning', encrypted_content: 'OLD_PROVIDER_REPLAY' }] },
        },
        { role: 'tool', toolCallId: 'old-call', content: 'OLD_TOOL_RESULT' },
        { role: 'assistant', content: 'old final answer' },
        { role: 'user', content: latestInstruction },
        {
            role: 'user',
            content: 'background task\nTask_id: task-1\nstatus: completed\nsurface: shell',
        },
        { role: 'user', content: '[mixdog-runtime] Empty response (1/2). Return final text.' },
        { role: 'user', content: '[Request interrupted]' },
    ];
    const goalReminder = '<system-reminder>\n<goal_state>\nCURRENT_GOAL_STATE\n</goal_state>\n</system-reminder>';
    const result = freshContextCompactMessages(messages, 40_000, {
        force: true,
        handoffText: 'FULL_CUMULATIVE_SESSION_SUMMARY',
        latestUserPrefix: goalReminder,
    });

    assert.deepEqual(result.messages.slice(0, sessionPrefix.length), sessionPrefix);
    const summaryIndex = result.messages.findIndex((message) => (
        typeof message?.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
    ));
    assert.equal(summaryIndex, sessionPrefix.length);
    assert.equal(result.messages[summaryIndex + 1]?.role, 'assistant');
    assert.equal(result.messages[summaryIndex + 1]?.content, '.');
    const volatileTail = result.messages.at(-1);
    assert.equal(volatileTail?.role, 'user');
    assert.ok(String(volatileTail.content).startsWith(goalReminder));
    assert.ok(String(volatileTail.content).endsWith('<system-reminder>\n# Current Time\n2026-09-01\n</system-reminder>\n\nLATEST_REAL_USER_INSTRUCTION'));
    assert.equal(String(volatileTail.content).includes('STALE_GOAL_STATE'), false);
    assert.equal((String(volatileTail.content).match(/<goal_state>/g) || []).length, 1);
    assert.equal(String(result.messages[summaryIndex].content).includes('CURRENT_GOAL_STATE'), false);
    assert.equal(result.messages.some((message) => message?.content === 'OLD_TOOL_RESULT'), true);
    assert.equal(result.diagnostics.retainedAssistantToolMessages, 1);
    assert.equal(result.diagnostics.retainedProviderReplayMessages, 1);
});

test('mid-turn Compact resumes completed progress instead of replaying the latest request as unanswered', () => {
    const result = freshContextCompactMessages([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'older request' },
        { role: 'assistant', content: 'older answer' },
        { role: 'user', content: '모바일뷰로도 볼 수 있나?' },
        {
            role: 'assistant',
            content: '모바일 viewport로 전환해 확인하겠습니다.',
            toolCalls: [
                { id: 'goal-call', name: 'goal', arguments: '{"action":"resume"}' },
                { id: 'browser-call', name: 'browser', arguments: '{"action":"emulate"}' },
            ],
        },
        { role: 'tool', toolCallId: 'goal-call', content: 'goal resumed' },
        { role: 'tool', toolCallId: 'browser-call', content: '390x844 mobile emulation completed' },
    ], 40_000, {
        force: true,
        handoffText: 'The user requested mobile inspection; tool execution is absent from this Memory handoff.',
        activeTurn: true,
    });

    const latestRequest = result.messages.find((message) => (
        message?.role === 'user' && message.content === '모바일뷰로도 볼 수 있나?'
    ));
    const continuation = result.messages.at(-1);
    assert.ok(latestRequest);
    assert.equal(continuation?.role, 'user');
    assert.match(String(continuation?.content), /already in progress/i);
    assert.match(String(continuation?.content), /without repeating/i);
    assert.equal(result.messages.find(message => message.toolCallId === 'browser-call')?.content, '390x844 mobile emulation completed');
    assert.equal(result.diagnostics.activeTurnContinuation, true);
});

test('out-of-loop Compact does not fabricate an active continuation from completed history', () => {
    const result = freshContextCompactMessages([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'completed request' },
        { role: 'assistant', content: 'completed answer' },
    ], 40_000, {
        force: true,
        handoffText: 'The request and answer are complete.',
    });

    assert.equal(result.messages.some((message) => (
        typeof message?.content === 'string'
        && message.content.includes('<active-turn-continuation>')
    )), false);
    assert.equal(result.diagnostics.activeTurnContinuation, false);
});

test('mid-turn continuation survives repeated Compact once and clears for a new real user request', () => {
    const first = freshContextCompactMessages([
        { role: 'system', content: 'system' },
        { role: 'user', content: 'inspect the mobile page' },
        {
            role: 'assistant',
            content: 'starting the inspection',
            toolCalls: [{ id: 'browser-call', name: 'browser', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'browser-call', content: 'inspection completed' },
    ], 40_000, {
        force: true,
        handoffText: 'The inspection completed and only interpretation remains.',
        activeTurn: true,
    });
    const second = freshContextCompactMessages(first.messages, 40_000, {
        force: true,
        handoffText: 'The inspection completed and only interpretation remains.',
        activeTurn: true,
    });
    const continuationCount = second.messages.filter((message) => (
        typeof message?.content === 'string'
        && message.content.includes('<active-turn-continuation>')
    )).length;
    assert.equal(continuationCount, 1);
    assert.equal(second.messages.filter((message) => (
        message?.role === 'user' && message.content === 'inspect the mobile page'
    )).length, 1);
    assert.equal(second.diagnostics.activeTurnContinuation, true);

    const nextTurn = freshContextCompactMessages([
        ...second.messages,
        { role: 'user', content: 'show me the final result' },
    ], 40_000, {
        force: true,
        handoffText: 'The prior mobile inspection is complete.',
        activeTurn: true,
    });
    assert.equal(nextTurn.messages.at(-1)?.content, 'show me the final result');
    assert.equal(nextTurn.diagnostics.activeTurnContinuation, false);
});

test('263k-class tool-heavy transcript retains bounded recent execution and archives overflow', (t) => {
    const previousDataDir = process.env.MIXDOG_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-heavy-compact-'));
    process.env.MIXDOG_DATA_DIR = dataDir;
    t.after(() => {
        if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previousDataDir;
        rmSync(dataDir, { recursive: true, force: true });
    });
    const messages = [
        { role: 'system', content: 'session rules' },
        { role: 'user', content: 'initial tool-heavy request' },
    ];
    const payload = 'large completed tool result '.repeat(320);
    for (let index = 0; index < 127; index += 1) {
        const id = `tool-heavy-${index}`;
        messages.push(
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id, name: 'read', arguments: `{"index":${index}}` }],
                providerReplay: { items: [{ type: 'reasoning', encrypted_content: `replay-${index}` }] },
            },
            { role: 'tool', toolCallId: id, content: `${payload}${index}` },
        );
    }
    messages.push(
        { role: 'assistant', content: 'all completed tools were processed' },
        { role: 'user', content: 'LATEST_AFTER_127_TOOLS' },
    );
    const handoffText = `FULL_SESSION_SUMMARY ${'covered context '.repeat(4_000)}`.trim();
    const result = freshContextCompactMessages(messages, 136_000, {
        force: true,
        handoffText,
        handoffTokenCap: 136_000,
        sessionId: 'test-compact-heavy-execution',
        contextWindow: 500_000,
    });

    assert.ok(result.diagnostics.baseTokens > 200_000);
    assert.ok(result.diagnostics.finalTokens < 136_000);
    assert.ok(result.messages.some((message) => (
        typeof message?.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX)
        && message.content.includes(handoffText)
    )));
    assert.equal(result.messages.at(-1)?.content, 'LATEST_AFTER_127_TOOLS');
    assert.ok(result.messages.some(message => message.toolCallId === 'tool-heavy-126'));
    assert.ok(result.diagnostics.toolHistoryTokens <= 25_000);
    assert.ok(result.diagnostics.omittedToolGroups > 0);
});

test('the deterministic builder fails closed instead of truncating an oversized complete handoff', () => {
    const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'old request' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'current request' },
    ];
    assert.throws(
        () => freshContextCompactMessages(messages, 12_000, {
            force: true,
            handoffText: `[old episode] ${'context '.repeat(20_000)}`,
            handoffTokenCap: 50_000,
        }),
        /complete handoff exceeds the compact budget/,
    );
});

test('Reference files retain only a stable path manifest after Compact', () => {
    const result = freshContextCompactMessages([
        { role: 'system', content: 'system' },
        {
            role: 'user',
            content: 'Reference files:\n\n### C:\\Project\\refs\\design.md\n```\nVERY_LARGE_REFERENCE_BODY\n```',
        },
        { role: 'assistant', content: '.' },
        { role: 'user', content: 'older request' },
        { role: 'assistant', content: 'older answer' },
        { role: 'user', content: 'latest request' },
    ], 40_000, {
        force: true,
        handoffText: 'FULL_SESSION_HANDOFF',
    });
    const encoded = JSON.stringify(result.messages);
    assert.ok(encoded.includes('C:\\\\Project\\\\refs\\\\design.md'));
    assert.equal(encoded.includes('VERY_LARGE_REFERENCE_BODY'), false);
    assert.equal(result.messages.at(-1)?.content, 'latest request');
});

const GENERATED_HANDOFF = [
    '## Goal',
    '- continue the task',
    '',
    '## Constraints & Preferences',
    '- preserve context',
    '',
    '## Progress',
    '### Done',
    '- inspected prior work',
    '### In Progress',
    '- implementing',
    '### Blocked',
    '- (none)',
    '',
    '## Key Decisions',
    '- one Compact path',
    '',
    '## Next Steps',
    '1. verify',
    '',
    '## Critical Context',
    '- full coverage',
    '',
    '## Relevant Files',
    '- src/example.mjs',
].join('\n');

test('Agent sessions use the same fresh layout with a session-local handoff', async () => {
    let providerCalls = 0;
    const provider = {
        name: 'fake',
        async send() {
            providerCalls += 1;
            return {
                content: GENERATED_HANDOFF,
                usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 0, cacheWriteTokens: 0 },
            };
        },
    };
    const result = await runFreshContextCompact({
        config: {},
        sessionRef: {
            id: 'sess-agent-fresh',
            compaction: { conversationThresholdTokens: 1 },
            owner: 'agent',
            provider: 'fake',
            model: 'fake-model',
            contextWindow: 100_000,
        },
        messages: [
            { role: 'system', content: 'agent rules' },
            { role: 'user', content: 'older agent request' },
            { role: 'assistant', content: 'older agent answer' },
            { role: 'user', content: 'LATEST_AGENT_REQUEST' },
        ],
        compactBudgetTokens: 40_000,
        compactPolicy: { reserveTokens: 0, contextWindow: 100_000, handoffTimeoutMs: 5_000 },
        sessionId: 'sess-agent-fresh',
        provider,
        model: 'fake-model',
        sendOpts: {},
    });
    assert.equal(providerCalls, 1);
    assert.equal(result.handoffSource, 'session-local');
    assert.equal(result.messages.at(-1)?.content, 'LATEST_AGENT_REQUEST');
    assert.equal(result.messages.some((message) => message?.role === 'tool'), false);
    assert.ok(result.messages.some((message) => (
        typeof message?.content === 'string' && message.content.includes('one Compact path')
    )));
});

test('large conversation input is batched completely within the summary model window', async () => {
    let providerCalls = 0;
    const prompts = [];
    const provider = {
        name: 'fake',
        async send(input) {
            providerCalls += 1;
            prompts.push(input[1].content);
            return { content: GENERATED_HANDOFF, usage: { inputTokens: 10, outputTokens: 5 } };
        },
    };
    const result = await runFreshContextCompact({
        config: {},
        sessionRef: {
            id: 'sess-memory-compressed',
            provider: 'fake',
            model: 'fake-model',
            cwd: 'C:\\Project\\mixdog',
            contextWindow: 24_000,
        },
        messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old answer' },
            ...Array.from({ length: 60 }, (_, i) => ({
                role: 'assistant', content: `SOURCE_MARKER_${i}_END`.padEnd(1600, '.'),
            })),
            { role: 'user', content: 'LATEST_MEMORY_REQUEST' },
        ],
        compactBudgetTokens: 12_000,
        compactPolicy: { reserveTokens: 0, contextWindow: 24_000, handoffTimeoutMs: 5_000 },
        sessionId: 'sess-memory-compressed',
        provider,
        model: 'fake-model',
        sendOpts: {},
    });
    assert.ok(providerCalls > 1);
    for (let i = 0; i < 60; i += 1) {
        assert.ok(prompts.some(prompt => prompt.includes(`SOURCE_MARKER_${i}_END`)), `source fragment ${i} was omitted`);
    }
    assert.equal(result.usage.inputTokens, providerCalls * 10);
    assert.equal(result.handoffSource, 'session-local');
    assert.equal(result.messages.at(-1)?.content, 'LATEST_MEMORY_REQUEST');
    assert.ok(result.messages.some((message) => (
        typeof message?.content === 'string' && message.content.includes('one Compact path')
    )));
});
