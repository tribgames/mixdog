#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeAgentDispatchAbortSignal } from '../src/runtime/agent/orchestrator/agent-runtime/agent-dispatch.mjs';

test('explore cancellation survives an active idle watchdog composite link', () => {
    const factory = new AbortController();
    const explore = new AbortController();
    const idleWatchdog = new AbortController();
    const linked = composeAgentDispatchAbortSignal([
        factory.signal,
        explore.signal,
        idleWatchdog.signal,
    ]);
    const reason = new Error('explore ESC');
    explore.abort(reason);
    assert.equal(linked.signal.aborted, true);
    assert.equal(linked.signal.reason, reason, 'per-call explore reason reaches the one session link');
    assert.equal(idleWatchdog.signal.aborted, false, 'watchdog remains independently active');
    linked.dispose();
});

test('an already-aborted parent reason is retained before the askSession controller swap', () => {
    const factory = new AbortController();
    const reason = new Error('factory canceled first');
    factory.abort(reason);
    const linked = composeAgentDispatchAbortSignal([factory.signal, new AbortController().signal]);
    assert.equal(linked.signal.aborted, true);
    assert.equal(linked.signal.reason, reason);
    linked.dispose();
});
