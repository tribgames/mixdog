import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SUMMARY_PREFIX,
    freshContextCompactMessages,
} from '../src/runtime/agent/orchestrator/session/compact.mjs';
import { resolveWorkerCompactPolicy } from '../src/runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import { normalizeCompactionConfig } from '../src/session-runtime/config-helpers.mjs';

test('Compact policy has no type selector', () => {
    for (const session of [
        { contextWindow: 100_000, compaction: {} },
        { owner: 'agent', contextWindow: 100_000, compaction: {} },
    ]) {
        const policy = resolveWorkerCompactPolicy(session, []);
        assert.equal(Object.hasOwn(policy, 'type'), false);
        assert.equal(Object.hasOwn(policy, 'compactType'), false);
        assert.equal(Object.hasOwn(policy, 'semantic'), false);
        assert.equal(Object.hasOwn(policy, 'recallFastTrack'), false);
    }
});

test('legacy Compact type settings migrate away', () => {
    const normalized = normalizeCompactionConfig({
        auto: true,
        type: 'semantic',
        compactType: 'recall-fasttrack',
        compact_type: 'type2',
        semantic: 'auto',
        prune: true,
        tailTurns: 5,
    });
    assert.deepEqual(normalized, { auto: true });
});

test('fresh layout keeps only protected prefix, handoff, ack, and latest real user', () => {
    const result = freshContextCompactMessages([
        { role: 'system', content: 'BP1' },
        { role: 'system', content: 'BP2' },
        { role: 'user', content: 'old request' },
        {
            role: 'assistant',
            content: 'old execution',
            toolCalls: [{ id: 'call-1', name: 'read', arguments: '{}' }],
            providerReplay: { items: [{ type: 'reasoning' }] },
        },
        { role: 'tool', toolCallId: 'call-1', content: 'old tool output' },
        { role: 'user', content: 'LATEST_REAL_USER' },
        { role: 'user', content: '[Request interrupted]' },
    ], 40_000, {
        force: true,
        handoffText: 'FULL_HANDOFF',
    });
    assert.deepEqual(result.messages.slice(0, 2).map((message) => message.content), ['BP1', 'BP2']);
    assert.equal(result.messages.at(-1)?.content, 'LATEST_REAL_USER');
    assert.equal(result.messages.filter((message) => message?.role === 'tool').length, 0);
    assert.equal(JSON.stringify(result.messages).includes('providerReplay'), false);
    assert.equal(result.messages.filter((message) => (
        typeof message?.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
    )).length, 1);
});

test('fresh layout preserves Reference paths without bodies', () => {
    const result = freshContextCompactMessages([
        { role: 'system', content: 'rules' },
        {
            role: 'user',
            content: 'Reference files:\n\n### C:\\Project\\refs\\one.md\n```\nBODY_TO_DROP\n```',
        },
        { role: 'assistant', content: '.' },
        { role: 'user', content: 'latest' },
    ], 40_000, {
        force: true,
        handoffText: 'HANDOFF',
    });
    const encoded = JSON.stringify(result.messages);
    assert.ok(encoded.includes('C:\\\\Project\\\\refs\\\\one.md'));
    assert.equal(encoded.includes('BODY_TO_DROP'), false);
});

test('fresh layout rejects a handoff it cannot retain completely', () => {
    assert.throws(
        () => freshContextCompactMessages([
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'latest' },
        ], 8_000, {
            force: true,
            handoffText: 'history '.repeat(20_000),
        }),
        /complete handoff exceeds the compact budget/,
    );
});
