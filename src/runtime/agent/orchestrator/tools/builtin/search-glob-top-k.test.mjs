import assert from 'node:assert/strict';
import test from 'node:test';

import { _createGlobMtimeTopK } from './search-glob-tool.mjs';

function entry(path, mtime, stat = {}) {
    return { path, full: path, mtime, mtimeMs: mtime, stat };
}

test('glob mtime top-K exactly matches full ordering and preserves failed-stat walk order', () => {
    const entries = [
        entry('z-old', 1),
        entry('b-tie', 9),
        entry('failed-first', 0, null),
        entry('a-tie', 9),
        entry('newest', 12),
        entry('failed-second', 0, null),
        entry('middle', 5),
    ];
    const selector = _createGlobMtimeTopK(6);
    const completionOrder = [5, 1, 6, 2, 4, 0, 3];
    for (const index of completionOrder) selector.add(entries[index], index);

    assert.deepEqual(
        selector.values().map((item) => item.path),
        ['newest', 'a-tie', 'b-tie', 'middle', 'z-old', 'failed-first'],
    );
});

test('glob mtime top-K retains only the requested bound', () => {
    const selector = _createGlobMtimeTopK(3);
    for (let index = 0; index < 100; index += 1) {
        selector.add(entry(`file-${String(index).padStart(3, '0')}`, index), index);
    }
    assert.deepEqual(
        selector.values().map((item) => item.path),
        ['file-099', 'file-098', 'file-097'],
    );
});
