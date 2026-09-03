import test from 'node:test';
import assert from 'node:assert/strict';
import { _collectCheapSymbols } from './symbol-index.mjs';

const names = (text, lang = 'javascript') => _collectCheapSymbols(text, lang).map((s) => s.name);

test('a `/*` inside a `//` line comment does not open a block comment', () => {
    const text = [
        'export function first() {',
        '    // without a rules/agent/*.md entry so newly-added agents work',
        '    return 1;',
        '}',
        'export function second() { return 2; }',
    ].join('\n');
    assert.deepEqual(names(text), ['first', 'second']);
});

test('a real block comment still hides declarations until it closes', () => {
    const text = [
        'function a() {}',
        '/* function hidden() {}',
        '   still hidden */ function b() {}',
        '/* inline */ function c() {} // function trailing() {}',
    ].join('\n');
    assert.deepEqual(names(text), ['a', 'b', 'c']);
});
