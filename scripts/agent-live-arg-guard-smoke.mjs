// Standalone regression smoke for validateBuiltinArgs guard behavior.
// Mirrors arg-guard-test.mjs style; runs with `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';

test('smoke: valid read args pass and numeric strings coerce', () => {
    const a = { path: 'x.mjs', offset: '2', limit: '10' };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.offset, 2);
    assert.equal(a.limit, 10);
});

test('smoke: non-numeric arg still errors', () => {
    assert.match(validateBuiltinArgs('read', { path: 'x.mjs', limit: 'nope' }), /must be an integer/);
});

test('smoke: below-min arg still errors', () => {
    assert.match(validateBuiltinArgs('read', { path: 'x.mjs', offset: -1 }), /must be >= 0/);
});
