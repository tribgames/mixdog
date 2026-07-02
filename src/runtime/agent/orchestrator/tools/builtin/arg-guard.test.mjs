import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBuiltinArgs } from './arg-guard.mjs';

test('read: numeric-string offset/limit coerce losslessly', () => {
    const a = { path: 'x.js', offset: '850', limit: '850.0' };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.offset, 850);
    assert.equal(a.limit, 850);
});

test('read: non-integer numeric string still rejected', () => {
    const a = { path: 'x.js', offset: '3.5' };
    assert.match(validateBuiltinArgs('read', a), /must be a finite integer/);
});

test('read: non-numeric string still rejected', () => {
    const a = { path: 'x.js', offset: 'soon' };
    assert.match(validateBuiltinArgs('read', a), /must be a finite integer/);
});

test('read: top-level line/context convert to offset/limit', () => {
    const a = { path: 'x.js', line: 100, context: 10 };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.offset, 89);
    assert.equal(a.limit, 21);
    assert.equal('line' in a, false);
    assert.equal('context' in a, false);
});

test('read: line without context defaults to a single-line window', () => {
    const a = { path: 'x.js', line: 1 };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.offset, 0);
    assert.equal(a.limit, 1);
});

test('read: explicit offset/limit wins over line/context (dropped)', () => {
    const a = { path: 'x.js', line: 100, context: 10, offset: 5, limit: 20 };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.offset, 5);
    assert.equal(a.limit, 20);
    assert.equal('line' in a, false);
    assert.equal('context' in a, false);
});

test('read: path[] entry object line/context converts the same way', () => {
    const a = { path: [{ path: 'x.js', line: 50, context: 5 }] };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.path[0].offset, 44);
    assert.equal(a.path[0].limit, 11);
});

test('read: path[] entry negative numeric-string offset is rejected after coercion', () => {
    const a = { path: [{ path: 'x.js', offset: '-5' }] };
    const err = validateBuiltinArgs('read', a);
    assert.match(err, /path\[0\]\.offset/);
    assert.match(err, />= 0/);
});

test('read: path[] entry negative numeric-string limit is rejected after coercion', () => {
    const a = { path: [{ path: 'x.js', limit: '-1' }] };
    const err = validateBuiltinArgs('read', a);
    assert.match(err, /path\[0\]\.limit/);
    assert.match(err, />= 0/);
});

test('read: path[] entry valid numeric-string offset/limit still coerces and passes', () => {
    const a = { path: [{ path: 'x.js', offset: '10', limit: '5' }] };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(a.path[0].offset, 10);
    assert.equal(a.path[0].limit, 5);
});

test('read: JSON object string path is accepted as a single-entry batch', () => {
    const a = { path: '{"path":"x.js","offset":10,"limit":5}' };
    assert.equal(validateBuiltinArgs('read', a), null);
    assert.equal(Array.isArray(a.path), true);
    assert.equal(a.path[0].path, 'x.js');
    assert.equal(a.path[0].offset, 10);
});

test('shell: win32 drive path with no shell set defaults to powershell', (t) => {
    if (process.platform !== 'win32') { t.skip('win32 only'); return; }
    const a = { command: 'dir C:\\Project\\mixdog' };
    assert.equal(validateBuiltinArgs('shell', a), null);
    assert.equal(a.shell, 'powershell');
});

test('glob: missing pattern with a path defaults pattern to "*"', () => {
    const a = { path: 'src' };
    assert.equal(validateBuiltinArgs('glob', a), null);
    assert.equal(a.pattern, '*');
});

test('glob: path carrying glob magic is left for the path-magic fallback, not overridden', () => {
    const a = { path: 'src/**/*.mjs' };
    assert.equal(validateBuiltinArgs('glob', a), null);
    assert.equal('pattern' in a, false);
    assert.equal(a.path, 'src/**/*.mjs');
});

test('glob: missing pattern and path is still an error surface (guard passes through)', () => {
    const a = {};
    assert.equal(validateBuiltinArgs('glob', a), null);
    assert.equal('pattern' in a, false);
});

test('grep: output_mode with newline-concatenated debris truncates to valid enum', () => {
    const a = { pattern: 'foo', output_mode: 'content_with_context\ntrue' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(a.output_mode, 'content_with_context');
});

test('grep: trailing literal \\n artifact stripped from pattern', () => {
    const a = { pattern: 'foo bar\\n' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(a.pattern, 'foo bar');
});

test('grep: trailing concatenation artifact ">\\n" stripped from pattern', () => {
    const a = { pattern: 'foo bar">\n' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(a.pattern, 'foo bar');
});

test('grep: mid-pattern \\n is left untouched', () => {
    const a = { pattern: 'foo\\nbar' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(a.pattern, 'foo\\nbar');
});

test('grep: bare trailing ">" with no newline artifact survives untouched', () => {
    const a = { pattern: 'class="active">' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(a.pattern, 'class="active">');
});

test('grep: numeric-string -C context coerces losslessly', () => {
    const a = { pattern: 'foo', '-C': '5' };
    assert.equal(validateBuiltinArgs('grep', a), null);
    assert.equal(a['-C'], 5);
});
