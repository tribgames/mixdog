import assert from 'node:assert/strict';
import test from 'node:test';

import { freshContextCompactMessages, SUMMARY_PREFIX } from './compact.mjs';
import { runFreshContextCompact } from './loop/fresh-context.mjs';
import { compactHandoffRows } from '../../../memory/lib/compact-handoff.mjs';
import { renderEntryLines } from '../../../memory/lib/recall-format.mjs';

test('fresh Compact persists one verbatim Memory handoff without rebuilding a duplicate dump', async () => {
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
    const digest = [
        '[2026-08-31 12:00] a: AUTHORITATIVE_MEMORY_STATE',
        '[2026-08-31 11:59] a: DUPLICATE_STATE',
    ].join('\n');
    const sessionId = 'sess-recall-verbatim';
    const result = await runFreshContextCompact({
        sessionRef: {
            id: sessionId,
            cwd: 'C:\\Project\\mixdog',
            contextWindow: 100_000,
            compactBoundaryTokens: 100_000,
        },
        messages,
        compactBudgetTokens: 30_000,
        compactPolicy: {
            contextWindow: 100_000,
            boundaryTokens: 100_000,
            reserveTokens: 0,
            keepTokens: 10_000,
            preserveRecentTokens: 10_000,
        },
        sessionId,
        executeMemorySearch: async (args) => {
            if (args.action === 'ingest_session') {
                assert.equal(args.fullTranscript, true);
                assert.equal(args.embedWait, false);
                assert.equal(args.messages.length, 14);
                return 'ingest_session: considered=14 inserted=14';
            }
            assert.equal(args.compactHandoff, true);
            assert.equal(args.preserveLatestUserTurns, 0);
            return digest;
        },
    });

    const summary = result.messages.find((message) => (
        message.role === 'user'
        && typeof message.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX)
    ));
    assert.ok(summary);
    assert.ok(summary.content.includes(
        `memory_session=${sessionId} order=newest_first\n${digest}`,
    ));
    assert.doesNotMatch(summary.content, /source=legacy-fasttrack|query_sha=/);
    assert.equal(summary.content.split('AUTHORITATIVE_MEMORY_STATE').length - 1, 1);
    assert.equal(summary.content.split('DUPLICATE_STATE').length - 1, 1);
    assert.equal(summary.content.includes('LOCAL_ONLY_OLD_HISTORY'), false);
});

test('fresh Compact waits for ingest before browsing the complete session handoff', async () => {
    const order = [];
    const result = await runFreshContextCompact({
        sessionRef: {
            id: 'sess-ingest-barrier',
            cwd: 'C:\\Project\\mixdog',
            contextWindow: 100_000,
            compactBoundaryTokens: 100_000,
        },
        messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'current request' },
        ],
        compactBudgetTokens: 50_000,
        compactPolicy: {
            contextWindow: 100_000,
            boundaryTokens: 100_000,
            reserveTokens: 0,
            keepTokens: 10_000,
            preserveRecentTokens: 10_000,
        },
        sessionId: 'sess-ingest-barrier',
        executeMemorySearch: async (args) => {
            if (args.action === 'ingest_session') {
                order.push('ingest-start');
                await new Promise((resolve) => setTimeout(resolve, 5));
                order.push('ingest-end');
                return 'ingest_session: considered=3 inserted=3';
            }
            order.push('search');
            return '[2026-08-31 12:00] a: STORED_BEFORE_SEARCH';
        },
    });
    assert.deepEqual(order, ['ingest-start', 'ingest-end', 'search']);
    assert.ok(result.messages.some((message) => (
        typeof message.content === 'string'
        && message.content.includes('STORED_BEFORE_SEARCH')
    )));
});

test('pre-send active turn reaches the Memory fresh builder as a continuation', async () => {
    const result = await runFreshContextCompact({
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
            keepTokens: 10_000,
            preserveRecentTokens: 10_000,
        },
        sessionId: 'sess-active-turn',
        activeTurn: true,
        executeMemorySearch: async (args) => (
            args.action === 'ingest_session'
                ? 'ingest_session: considered=4 inserted=4'
                : 'The mobile inspection completed and only interpretation remains.'
        ),
    });

    assert.match(String(result.messages.at(-1)?.content), /already in progress/i);
    assert.equal(result.diagnostics.activeTurnContinuation, true);
});

test('repeated compact rebuilds from the same session transcript instead of nesting the prior handoff', async () => {
    const sessionId = 'sess-repeat-full-rebuild';
    const stored = [];
    const seen = new Set();
    let nextId = 1;
    let searchCount = 0;
    const executeMemorySearch = async (args) => {
        assert.equal(args.sessionId, sessionId);
        if (args.action === 'ingest_session') {
            for (const message of args.messages) {
                const key = `${message.role}\u0000${message.content}`;
                if (seen.has(key)) continue;
                seen.add(key);
                stored.push({
                    id: nextId,
                    ts: nextId * 1000,
                    session_id: sessionId,
                    source_turn: nextId,
                    role: message.role,
                    content: message.content,
                    is_root: 0,
                    chunk_root: null,
                });
                nextId += 1;
            }
            return `ingest_session: considered=${args.messages.length} inserted=${stored.length}`;
        }
        searchCount += 1;
        return renderEntryLines(
            compactHandoffRows(stored, {
                preserveLatestUserTurns: args.preserveLatestUserTurns,
            }),
            { pendingMarks: false, recencyOrder: true },
        );
    };
    const compactPolicy = {
        contextWindow: 100_000,
        boundaryTokens: 100_000,
        reserveTokens: 0,
        keepTokens: 10_000,
        preserveRecentTokens: 10_000,
    };
    const original = [{ role: 'system', content: 'system' }];
    for (let turn = 1; turn <= 7; turn += 1) {
        original.push(
            { role: 'user', content: `request-${turn}` },
            { role: 'assistant', content: `answer-${turn}` },
        );
    }
    const first = await runFreshContextCompact({
        sessionRef: { id: sessionId, cwd: 'C:\\Project\\mixdog', contextWindow: 100_000 },
        messages: original,
        compactBudgetTokens: 50_000,
        compactPolicy,
        sessionId,
        executeMemorySearch,
    });
    const second = await runFreshContextCompact({
        sessionRef: { id: sessionId, cwd: 'C:\\Project\\mixdog', contextWindow: 100_000 },
        messages: [
            ...first.messages,
            { role: 'user', content: 'follow-up request' },
            { role: 'assistant', content: 'follow-up answer' },
            { role: 'user', content: 'current request' },
        ],
        compactBudgetTokens: 50_000,
        compactPolicy,
        sessionId,
        executeMemorySearch,
    });
    const secondSummary = second.messages.find((message) => (
        typeof message.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX)
    ));
    assert.equal(searchCount, 2);
    assert.ok(secondSummary?.content.includes('request-1'));
    assert.ok(secondSummary?.content.includes('answer-1'));
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
    const volatileTail = result.messages[summaryIndex + 2];
    assert.equal(volatileTail?.role, 'user');
    assert.ok(String(volatileTail.content).startsWith(goalReminder));
    assert.ok(String(volatileTail.content).endsWith('<system-reminder>\n# Current Time\n2026-09-01\n</system-reminder>\n\nLATEST_REAL_USER_INSTRUCTION'));
    assert.equal(String(volatileTail.content).includes('STALE_GOAL_STATE'), false);
    assert.equal((String(volatileTail.content).match(/<goal_state>/g) || []).length, 1);
    assert.equal(String(result.messages[summaryIndex].content).includes('CURRENT_GOAL_STATE'), false);
    assert.equal(result.messages.some((message) => message?.role === 'tool'), false);
    assert.equal(result.messages.some((message) => Array.isArray(message?.toolCalls)), false);
    assert.equal(JSON.stringify(result.messages).includes('OLD_PROVIDER_REPLAY'), false);
    assert.equal(result.diagnostics.retainedAssistantToolMessages, 0);
    assert.equal(result.diagnostics.retainedProviderReplayMessages, 0);
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
        handoffText: 'The mobile emulation tool call completed and inspection should continue.',
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
    assert.equal(result.messages.some((message) => message?.role === 'tool'), false);
    assert.equal(result.messages.some((message) => Array.isArray(message?.toolCalls)), false);
    assert.equal(result.diagnostics.activeTurnContinuation, true);
    assert.equal(result.diagnostics.tailMessages, 2);
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

test('263k-class tool-heavy transcript compacts without carrying any completed tool execution', () => {
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
    });

    assert.ok(result.diagnostics.baseTokens > 200_000);
    assert.ok(result.diagnostics.finalTokens < 136_000);
    assert.ok(result.messages.some((message) => (
        typeof message?.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX)
        && message.content.includes(handoffText)
    )));
    assert.equal(result.messages.at(-1)?.content, 'LATEST_AFTER_127_TOOLS');
    assert.equal(result.messages.some((message) => message?.role === 'tool'), false);
    assert.equal(result.messages.some((message) => Array.isArray(message?.toolCalls)), false);
    assert.equal(JSON.stringify(result.messages).includes('providerReplay'), false);
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
            keepTokens: 4_000,
            preserveRecentTokens: 4_000,
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
        sessionRef: {
            id: 'sess-agent-fresh',
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

test('oversized Memory handoff is summarized in full before entering the fresh layout', async () => {
    let providerCalls = 0;
    const provider = {
        name: 'fake',
        async send() {
            providerCalls += 1;
            return { content: GENERATED_HANDOFF, usage: { inputTokens: 10, outputTokens: 5 } };
        },
    };
    const executeMemorySearch = async (args) => {
        if (args.action === 'ingest_session') return 'ingest_session: inserted=3';
        return `[full memory] ${'complete history line\n'.repeat(20_000)}`;
    };
    const result = await runFreshContextCompact({
        sessionRef: {
            id: 'sess-memory-compressed',
            cwd: 'C:\\Project\\mixdog',
            contextWindow: 24_000,
        },
        messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'old request' },
            { role: 'assistant', content: 'old answer' },
            { role: 'user', content: 'LATEST_MEMORY_REQUEST' },
        ],
        compactBudgetTokens: 12_000,
        compactPolicy: { reserveTokens: 0, contextWindow: 24_000, handoffTimeoutMs: 5_000 },
        sessionId: 'sess-memory-compressed',
        executeMemorySearch,
        provider,
        model: 'fake-model',
        sendOpts: {},
    });
    assert.ok(providerCalls > 0);
    assert.equal(result.handoffSource, 'memory-compressed');
    assert.equal(result.messages.at(-1)?.content, 'LATEST_MEMORY_REQUEST');
    assert.ok(result.messages.some((message) => (
        typeof message?.content === 'string' && message.content.includes('one Compact path')
    )));
});
