import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCursorStreamTuning } from './cursor-wire-guards.mjs';
import { __cursorWireInternals } from './cursor-wire.mjs';
import {
    classifyError,
    isCursorTransientTransportError,
    isProviderRecoveryExhausted,
} from './retry-classifier.mjs';

function cursorStreamAbort() {
    const error = new Error('Cursor stream was aborted');
    error.code = 'stream_aborted';
    error.cursorCode = 'stream_aborted';
    return error;
}

function fakeBridge() {
    let alive = true;
    let closeHandler = null;
    return {
        get alive() { return alive; },
        write() {},
        close(error = null) {
            if (!alive) return;
            alive = false;
            closeHandler?.(error);
        },
        onData() {},
        onClose(handler) {
            closeHandler = handler;
        },
    };
}

test('Cursor transport aborts are structurally transient before output exposure', () => {
    const abort = cursorStreamAbort();
    assert.equal(isCursorTransientTransportError(abort), true);
    assert.equal(classifyError(abort), 'transient');

    const reasoningAbort = cursorStreamAbort();
    reasoningAbort.emittedReasoning = true;
    assert.equal(isCursorTransientTransportError(reasoningAbort), true);
    assert.equal(classifyError(reasoningAbort), 'permanent');

    const refusal = cursorStreamAbort();
    refusal.status = 400;
    refusal.httpStatus = 400;
    assert.equal(isCursorTransientTransportError(refusal), false);
    assert.equal(classifyError(refusal), 'permanent');
});

test('Cursor in-place retry exhaustion is owned by the provider', async () => {
    const bridges = [fakeBridge()];
    const tuning = resolveCursorStreamTuning();
    const response = __cursorWireInternals.createStreamResponse({
        bridge: bridges[0],
        heartbeat: null,
        conversation: { checkpoint: null },
        tools: [],
        cloudRule: undefined,
        model: 'cursor-test',
        key: 'cursor-retry-exhaustion',
        restart: () => {
            const bridge = fakeBridge();
            bridges.push(bridge);
            return { bridge, heartbeat: null };
        },
    });
    const body = response.text();

    for (let attempt = 0; attempt <= tuning.maxRetries; attempt += 1) {
        bridges[attempt].close(cursorStreamAbort());
    }

    await assert.rejects(body, (error) => {
        assert.equal(isProviderRecoveryExhausted(error), true);
        assert.equal(error.providerRecoveryOwner, 'cursor-wire');
        assert.equal(error.providerRecoveryAttempts, tuning.maxRetries + 1);
        return true;
    });
    assert.equal(bridges.length, tuning.maxRetries + 1);
});
