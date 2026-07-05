#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveSessionMaxLoopIterations,
    LEAD_MAX_LOOP_ITERATIONS,
} from '../src/runtime/agent/orchestrator/agent-runtime/agent-loop-policy.mjs';

// No low per-agent caps: every public/delegated agent shares the single high
// runaway guard (LEAD_MAX_LOOP_ITERATIONS) unless a session pins its own value.
test('agent owner session falls through to the shared runaway guard when unset', () => {
    const cap = resolveSessionMaxLoopIterations({
        owner: 'agent',
        agent: 'heavy-worker',
        permission: 'read-write',
        maxLoopIterations: null,
    });
    assert.equal(cap, LEAD_MAX_LOOP_ITERATIONS);
});

test('lead session keeps the same shared ceiling when unset', () => {
    assert.equal(resolveSessionMaxLoopIterations({ owner: 'user', agent: null }), LEAD_MAX_LOOP_ITERATIONS);
});

test('a session-pinned maxLoopIterations is honored', () => {
    assert.equal(
        resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'heavy-worker', maxLoopIterations: 4 }),
        4,
    );
});

test('explicit override wins over everything', () => {
    assert.equal(
        resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'heavy-worker', maxLoopIterations: 4 }, 50),
        50,
    );
});
