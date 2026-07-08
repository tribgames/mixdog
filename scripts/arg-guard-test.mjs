// Regression tests for validateBuiltinArgs numeric coercion + over-max clamp:
// - integer-shaped strings ("5") coerce to numbers instead of erroring
// - over-max integers clamp to the cap instead of erroring
// - truly non-numeric / below-min input keeps the existing error
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBuiltinArgs } from '../src/runtime/agent/orchestrator/tools/builtin/arg-guard.mjs';

test('read offset/limit as numeric strings coerce to numbers', () => {
    const a = { path: 'x.mjs', offset: '5', limit: '40' };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.offset, 5);
    assert.equal(a.limit, 40);
});

test('read line/context as numeric strings coerce and window', () => {
    const a = { path: 'x.mjs', line: '100', context: '5' };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.offset, 94);
    assert.equal(a.limit, 11);
});

test('grep head_limit/offset/-C as numeric strings coerce', () => {
    const a = { pattern: 'x', head_limit: '3', offset: '10', '-C': '2' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(a.head_limit, 3);
    assert.equal(a.offset, 10);
    assert.equal(a['-C'], 2);
});

test('grep empty context strings are treated as omitted', () => {
    const a = { pattern: 'x', output_mode: 'content_with_context', '-A': '', '-B': '', '-C': '', context: '' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(Object.prototype.hasOwnProperty.call(a, '-A'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(a, '-B'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(a, '-C'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(a, 'context'), false);
});

test('list/find/glob head_limit as numeric string coerces', () => {
    const l = { path: '.', head_limit: '5' };
    assert.equal(validateBuiltinArgs('list', l), null);
    assert.equal(l.head_limit, 5);
    const f = { query: 'x', head_limit: '5' };
    assert.equal(validateBuiltinArgs('find', f), null);
    assert.equal(f.head_limit, 5);
    const g = { pattern: '*.mjs', head_limit: '5' };
    assert.equal(validateBuiltinArgs('glob', g), null);
    assert.equal(g.head_limit, 5);
});

test('over-max integer clamps to the cap instead of erroring', () => {
    // read n cap is 0..10000; a huge value clamps down instead of erroring.
    const a = { path: 'x.mjs', n: 999999999 };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.n, 10000);
});

test('over-max numeric-string clamps too', () => {
    const a = { path: 'x.mjs', n: '999999999' };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.n, 10000);
});

test('non-numeric string still errors', () => {
    assert.match(validateBuiltinArgs('read', { path: 'x.mjs', limit: 'soon' }), /must be an integer/);
    assert.match(validateBuiltinArgs('list', { path: '.', head_limit: 'soon' }), /finite integer/);
});

test('below-min (negative) still errors', () => {
    assert.match(validateBuiltinArgs('read', { path: 'x.mjs', offset: -1 }), /must be >= 0/);
    assert.match(validateBuiltinArgs('list', { path: '.', head_limit: '-2' }), /must be >= 0/);
});

test('fractional numeric string is not coerced (still errors)', () => {
    assert.match(validateBuiltinArgs('read', { path: 'x.mjs', limit: '3.5' }), /must be an integer/);
});
