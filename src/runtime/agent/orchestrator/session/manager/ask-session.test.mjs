import assert from 'node:assert/strict';
import test from 'node:test';
import {
    acknowledgeAskTextReset,
    emitAskSessionStart,
    resolveAskLiveProjection,
} from './ask-session.mjs';

test('askSession liveProjection is an explicit send-opt, not inferred from wrappers', () => {
    assert.equal(resolveAskLiveProjection({}), false);
    assert.equal(resolveAskLiveProjection({ onTextDelta: () => {} }), false);
    assert.equal(resolveAskLiveProjection({ onAssistantText: () => {} }), false);
    assert.equal(resolveAskLiveProjection({ onTextReset: () => true }), false);
    assert.equal(resolveAskLiveProjection({ liveProjection: true }), true);
    assert.equal(resolveAskLiveProjection({ liveProjection: false, onTextDelta: () => {} }), false);
});

test('in-flight session start is best-effort and does not throw', () => {
    const seen = [];
    emitAskSessionStart({
        onSessionStart: (detail) => seen.push(detail),
    }, { sessionId: 's1', agent: 'worker' });
    emitAskSessionStart({
        onSessionStart: () => { throw new Error('host boom'); },
    }, { sessionId: 's2' });
    emitAskSessionStart({}, { sessionId: 's3' });
    assert.deepEqual(seen, [{ sessionId: 's1', agent: 'worker' }]);
});

test('text-reset ack stays fail-closed: only === true retracts', async () => {
    const acks = [];
    assert.equal(await acknowledgeAskTextReset({}, { chars: 4 }, () => acks.push('none')), false);
    assert.equal(await acknowledgeAskTextReset({
        onTextReset: () => false,
    }, { chars: 4 }, () => acks.push('false')), false);
    assert.equal(await acknowledgeAskTextReset({
        onTextReset: () => { throw new Error('viewer failed'); },
    }, { chars: 4 }, () => acks.push('throw')), false);
    assert.equal(await acknowledgeAskTextReset({
        onTextReset: async () => 'yes',
    }, { chars: 4 }, () => acks.push('truthy')), false);
    assert.equal(await acknowledgeAskTextReset({
        onTextReset: async () => true,
    }, { chars: 7 }, (detail) => acks.push(detail.chars)), true);
    assert.deepEqual(acks, [7]);
});
