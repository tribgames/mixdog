import assert from 'node:assert/strict';
import test from 'node:test';

import { SUMMARY_PREFIX } from './compact.mjs';
import { runRecallFastTrackCompact } from './loop/recall-fasttrack.mjs';

test('recall compact persists one verbatim Memory handoff without rebuilding a duplicate dump', async () => {
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
    const result = await runRecallFastTrackCompact({
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
            assert.equal(args.compactHandoff, true);
            assert.equal(args.limit, 30);
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
        `recall_session=${sessionId} order=newest_first\n${digest}`,
    ));
    assert.equal(summary.content.split('AUTHORITATIVE_MEMORY_STATE').length - 1, 1);
    assert.equal(summary.content.split('DUPLICATE_STATE').length - 1, 1);
    assert.equal(summary.content.includes('LOCAL_ONLY_OLD_HISTORY'), false);
});
