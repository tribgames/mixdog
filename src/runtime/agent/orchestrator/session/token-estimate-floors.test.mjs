import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyTokenFloors } from '../../../../../scripts/perf/transcript-baseline.mjs';
import { denseTokenFloor, structuredTokenFloor } from './token-estimate-floors.mjs';

test('allocation-free token floors exactly preserve the former meter across mixed text', () => {
    const atoms = ['hello ', '한글', '😀', '\ud800', '\r\n', '\n', '\u2028', '\u00a0',
        '\ufeff', '{}', '[1,2]', '"x":', 'abcdef12 ', 'A'.repeat(64), '\t', '\v', '\\', '<|=>'];
    let state = 314159;
    const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const samples = ['', 'a\nb\nc', '{"x":1}\n{"x":2}\n{"x":3}', 'a'.repeat(16), 'a'.repeat(63)];
    for (let index = 0; index < 2000; index++) {
        samples.push(Array.from({ length: random() % 100 }, () => atoms[random() % atoms.length]).join(''));
    }
    for (const value of samples) {
        assert.equal(Math.max(denseTokenFloor(value), structuredTokenFloor(value)),
            legacyTokenFloors(value), JSON.stringify(value));
    }
});
