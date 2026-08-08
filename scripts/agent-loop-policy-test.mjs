#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EXPLORE_MAX_LOOP_ITERATIONS,
    resolveSessionMaxLoopIterations,
    LEAD_MAX_LOOP_ITERATIONS,
} from '../src/runtime/agent/orchestrator/agent-runtime/agent-loop-policy.mjs';

// General agents share the high runaway guard unless a session pins a value.
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

test('explorer is capped at five tool turns across direct and headless session shapes', () => {
    assert.equal(EXPLORE_MAX_LOOP_ITERATIONS, 5);
    assert.equal(resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'explorer' }), 5);
    assert.equal(resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'explore' }), 5);
    assert.equal(resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'explorer', maxLoopIterations: 200 }), 5);
    assert.equal(resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'explorer' }, 200), 5);
    assert.equal(resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'explorer', maxLoopIterations: 1 }), 1);
});
