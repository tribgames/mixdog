import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyAlignment } from '../../../../scripts/perf/transcript-baseline.mjs';
import { findTranscriptAlignment } from './transcript-alignment.ts';
import { adoptTranscriptIdentity } from './transcript-identity.ts';

test('optimized alignment preserves exhaustive ranking across duplicate ids, windows and history rewrites', () => {
    let seed = 1729;
    const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
    const row = () => ({
        kind: ['assistant', 'user', 'tool', 'statusdone'][random(4)],
        id: [undefined, null, 'a', 'b', 1, '1'][random(6)],
        name: ['read', 'shell'][random(2)],
        text: ['', 'a', 'ab', 'z'][random(4)], status: ['done', 'failed'][random(2)],
    });
    for (let run = 0; run < 4000; run++) {
        const previous = Array.from({ length: random(24) }, row);
        let incoming = run % 2 ? previous.slice(random(previous.length + 1)).map(item => ({ ...item }))
            : Array.from({ length: random(24) }, row);
        if (run % 3 === 0) incoming = incoming.map(item => ({ ...item, id: `new-${random(4)}` }));
        assert.deepEqual(findTranscriptAlignment(previous, incoming), legacyAlignment(previous, incoming));
    }
});

test('a repeated tail window retains the displayed row ids across source namespaces', () => {
    const previous = Array.from({ length: 2000 }, (_, index) => ({
        kind: 'statusdone', id: `old-${index}`, status: 'done',
    }));
    const incoming = previous.slice(-500).map((item, index) => ({ ...item, id: `disk-${index}` }));
    const result = adoptTranscriptIdentity({ items: previous, tail: null }, incoming, null);
    assert.equal(result.offset, 1500);
    assert.deepEqual(result.items.map(item => item.id), previous.slice(-500).map(item => item.id));
});
