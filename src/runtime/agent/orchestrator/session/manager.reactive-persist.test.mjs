import assert from 'node:assert/strict';
import test from 'node:test';

import {
    _applyCompactFailurePersistToSession,
    _sessionMessagesAdvancedBeyondCompactedOutgoing,
} from './manager.mjs';

const compacted = [
    { role: 'user', content: 'summary turn' },
    { role: 'user', content: 'current task' },
];

test('sessionMessagesAdvancedBeyondCompactedOutgoing: true for compacted prefix plus final assistant', () => {
    const current = [
        ...compacted,
        { role: 'assistant', content: 'done' },
    ];
    assert.equal(_sessionMessagesAdvancedBeyondCompactedOutgoing(current, compacted), true);
});

test('sessionMessagesAdvancedBeyondCompactedOutgoing: true for compacted prefix plus empty-final assistant', () => {
    const current = [
        ...compacted,
        { role: 'assistant', content: '', emptyFinal: true },
    ];
    assert.equal(_sessionMessagesAdvancedBeyondCompactedOutgoing(current, compacted), true);
});

test('sessionMessagesAdvancedBeyondCompactedOutgoing: false when transcript has not advanced', () => {
    assert.equal(_sessionMessagesAdvancedBeyondCompactedOutgoing(compacted, compacted), false);
});

test('sessionMessagesAdvancedBeyondCompactedOutgoing: false when extra message is not a final assistant', () => {
    const current = [
        ...compacted,
        { role: 'user', content: 'steering follow-up' },
    ];
    assert.equal(_sessionMessagesAdvancedBeyondCompactedOutgoing(current, compacted), false);
});

test('sessionMessagesAdvancedBeyondCompactedOutgoing: false when prefix diverges from compacted outgoing', () => {
    const current = [
        { role: 'user', content: 'different summary' },
        { role: 'user', content: 'current task' },
        { role: 'assistant', content: 'done' },
    ];
    assert.equal(_sessionMessagesAdvancedBeyondCompactedOutgoing(current, compacted), false);
});

test('applyCompactFailurePersistToSession: preserves providerState when transcript already advanced', () => {
    const priorSanitized = [
        ...compacted,
        { role: 'assistant', content: 'done' },
    ];
    const session = {
        messages: priorSanitized,
        providerState: { continuation: 'fresh' },
        compaction: { lastStage: 'compacting' },
    };
    const applied = _applyCompactFailurePersistToSession(session, {
        priorSanitized,
        sanitized: compacted,
        messagesAdvanced: true,
        error: new Error('ask failed'),
    });
    assert.equal(applied, true);
    assert.deepEqual(session.messages, priorSanitized);
    assert.deepEqual(session.providerState, { continuation: 'fresh' });
    assert.equal(session.compaction.lastStage, 'failed');
});

test('applyCompactFailurePersistToSession: clears providerState when replacing messages with compacted outgoing', () => {
    const priorSanitized = [
        { role: 'user', content: 'old long history' },
    ];
    const session = {
        messages: priorSanitized,
        providerState: { stale: true },
        compaction: { lastStage: 'compacting' },
    };
    const applied = _applyCompactFailurePersistToSession(session, {
        priorSanitized,
        sanitized: compacted,
        messagesAdvanced: false,
        error: { code: 'AGENT_CONTEXT_OVERFLOW' },
    });
    assert.equal(applied, true);
    assert.deepEqual(session.messages, compacted);
    assert.equal(session.providerState, undefined);
    assert.equal(session.compaction.lastStage, 'overflow_failed');
});

test('applyCompactFailurePersistToSession: no-op when messages unchanged and not advanced', () => {
    const session = {
        messages: compacted,
        providerState: { keep: true },
    };
    const applied = _applyCompactFailurePersistToSession(session, {
        priorSanitized: compacted,
        sanitized: compacted,
        messagesAdvanced: false,
    });
    assert.equal(applied, false);
    assert.deepEqual(session.providerState, { keep: true });
});

