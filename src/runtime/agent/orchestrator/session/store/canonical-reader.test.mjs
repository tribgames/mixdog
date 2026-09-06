import assert from 'node:assert/strict';
import test from 'node:test';
import { createCanonicalSessionReader, CANONICAL_RECORD_UNREADABLE } from './canonical-reader.mjs';

test('cached authority reads current content and rejects tampering rather than serving stale ownership', () => {
    let raw = '{"id":"mine","closed":false,"generation":1,"messages":[]}';
    let reads = 0;
    const read = createCanonicalSessionReader({ readText: () => { reads++; return raw; } });
    assert.equal(read('record', true).id, 'mine');
    assert.equal(read('record', true).generation, 1);
    assert.equal(reads, 2);
    raw = raw.replace('mine', 'them'); // identical length, different authority
    assert.equal(read('record', true).id, 'them');
    for (const invalid of ['{"id":"mine","id":"them"}', '{"id":"mine","messages":[],"messages":[]}',
        '{"id":"mine","closed":false,"clo\\u0073ed":true}', '{"id":"mine"} trailing', '{"id":"mine",']) {
        raw = invalid;
        assert.equal(read('record', true), CANONICAL_RECORD_UNREADABLE);
    }
    raw = '{"id":"mine","closed":true,"generation":2}';
    assert.deepEqual(read('record', true), { id: 'mine', closed: true, generation: 2 });
});

test('full lifecycle documents stay privately owned and cannot mutate cached authority', () => {
    const read = createCanonicalSessionReader({
        readText: () => '{"id":"mine","messages":[{"content":"original"}],"generation":1}',
    });
    read('record', true);
    const first = read('record');
    first.doc.messages[0].content = 'changed';
    first.doc.id = 'them';
    assert.equal(read('record').doc.messages[0].content, 'original');
    assert.equal(read('record', true).id, 'mine');
});

test('read failures discard authority and cache storage obeys both limits', () => {
    let code;
    const read = createCanonicalSessionReader({
        maxEntries: 2, maxTextChars: 60,
        readText: id => {
            if (code) throw Object.assign(new Error(code), { code });
            return JSON.stringify({ id });
        },
    });
    for (let index = 0; index < 20; index++) read(`record-${index}`, true);
    assert.ok(read.stats().entries <= 2);
    assert.ok(read.stats().retainedChars <= 60);
    code = 'EACCES';
    assert.equal(read('record-19', true), CANONICAL_RECORD_UNREADABLE);
    code = 'ENOENT';
    assert.equal(read('record-18', true), null);
    read.clear();
    assert.deepEqual(read.stats(), { entries: 0, retainedChars: 0 });
});
