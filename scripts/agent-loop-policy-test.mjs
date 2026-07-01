#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolvePublicAgentMaxLoopIterations,
    resolveSessionMaxLoopIterations,
    LEAD_MAX_LOOP_ITERATIONS,
} from '../src/runtime/agent/orchestrator/agent-runtime/agent-loop-policy.mjs';

test('public heavy-worker gets conservative default loop cap', () => {
    assert.equal(resolvePublicAgentMaxLoopIterations('heavy-worker', 'read-write'), 12);
});

test('read-only public roles get tighter cap', () => {
    assert.equal(resolvePublicAgentMaxLoopIterations('reviewer', 'read'), 10);
});

test('hidden internal roles do not inherit public caps', () => {
    assert.equal(resolvePublicAgentMaxLoopIterations('cycle1-agent', 'read'), null);
});

test('agent owner session resolves role cap when maxLoopIterations unset', () => {
    const cap = resolveSessionMaxLoopIterations({
        owner: 'agent',
        agent: 'heavy-worker',
        permission: 'read-write',
        maxLoopIterations: null,
    });
    assert.equal(cap, 12);
});

test('lead session keeps high ceiling when unset', () => {
    assert.equal(resolveSessionMaxLoopIterations({ owner: 'user', agent: null }), LEAD_MAX_LOOP_ITERATIONS);
});

test('explicit maxLoopIterations wins', () => {
    assert.equal(
        resolveSessionMaxLoopIterations({ owner: 'agent', agent: 'heavy-worker', maxLoopIterations: 4 }, 4),
        4,
    );
});
