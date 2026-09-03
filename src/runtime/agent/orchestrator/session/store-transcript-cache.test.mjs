import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    createStoredTranscriptCache,
    nextProjectionStamp,
} from './store-transcript-cache.mjs';

const stat = (mtimeMs, size) => ({ mtimeMs, size });
const text = (value) => () => value;

test('identical content shares one projection; changed content or sidecar re-parses', async () => {
    const cache = createStoredTranscriptCache();
    let produced = 0;
    const produce = () => { produced += 1; return { items: [produced] }; };
    const base = { key: 'a|512', fingerprint: 'absent', fileStat: stat(1, 10), now: 5 };
    const first = await cache.read({ ...base, loadText: text('{"id":"a"}'), produce });
    const again = await cache.read({ ...base, loadText: text('{"id":"a"}'), produce });
    assert.equal(first.hit, false);
    assert.equal(again.hit, true);
    assert.equal(again.read, true);
    assert.equal(again.value, first.value);
    const changed = await cache.read({ ...base, loadText: text('{"id":"a","x":1}'), produce });
    assert.equal(changed.hit, false);
    assert.notEqual(changed.value, first.value);
    const sidecar = await cache.read({
        ...base, fingerprint: 'present:1:9', loadText: text('{"id":"a","x":1}'), produce,
    });
    assert.equal(sidecar.hit, false);
    assert.equal(produced, 3);
});

test('a settled file whose stat still matches is trusted without reading its body', async () => {
    const cache = createStoredTranscriptCache();
    const produce = () => ({ items: [] });
    let loads = 0;
    const loadText = () => { loads += 1; return 'body'; };
    const first = await cache.read({
        key: 'c', fingerprint: 'absent', fileStat: stat(1_000, 4), now: 1_500, loadText, produce,
    });
    assert.equal(first.hit, false);
    // Too fresh: a same-stamp rewrite is still possible, so the body is compared.
    const fresh = await cache.read({
        key: 'c', fingerprint: 'absent', fileStat: stat(1_000, 4), now: 2_000, loadText, produce,
    });
    assert.equal(fresh.hit, true);
    assert.equal(fresh.read, true);
    const settled = await cache.read({
        key: 'c', fingerprint: 'absent', fileStat: stat(1_000, 4), now: 10_000, loadText, produce,
    });
    assert.equal(settled.hit, true);
    assert.equal(settled.read, false);
    assert.equal(loads, 2);
    // A different stat always reads, and a different sidecar never trusts stat.
    const moved = await cache.read({
        key: 'c', fingerprint: 'absent', fileStat: stat(1_001, 4), now: 10_000, loadText, produce,
    });
    assert.equal(moved.read, true);
    const sidecar = await cache.read({
        key: 'c', fingerprint: 'present:1:1', fileStat: stat(1_001, 4), now: 10_000, loadText, produce,
    });
    assert.equal(sidecar.hit, false);
});

test('concurrent readers of the same content wait for one parse', async () => {
    const cache = createStoredTranscriptCache();
    let produced = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const produce = async () => { produced += 1; await gate; return { items: [] }; };
    const base = { key: 'b|512', fingerprint: 'absent', fileStat: stat(1, 4), now: 5, loadText: text('same'), produce };
    const reads = Promise.all([cache.read(base), cache.read(base)]);
    release();
    const [left, right] = await reads;
    assert.equal(produced, 1);
    assert.equal(left.value, right.value);
    assert.equal(right.hit, true);
});

test('the cache stays within its entry and text budgets', async () => {
    const cache = createStoredTranscriptCache({ maxEntries: 2, maxTextChars: 10 });
    const produce = () => ({ items: [] });
    const base = { fingerprint: '', fileStat: stat(1, 4), now: 5, produce };
    await cache.read({ ...base, key: '1', loadText: text('aaaa') });
    await cache.read({ ...base, key: '2', loadText: text('bbbb') });
    await cache.read({ ...base, key: '3', loadText: text('cccc') });
    assert.equal(cache.stats().entries, 2);
    assert.ok(cache.stats().retainedChars <= 10);
    const oversized = await cache.read({ ...base, key: '4', loadText: text('x'.repeat(11)) });
    assert.equal(oversized.hit, false);
    assert.equal((await cache.read({ ...base, key: '4', loadText: text('x'.repeat(11)) })).hit, false);
});

test('a stored transcript read is served from cache until the record changes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-cache-'));
    const previous = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = dataDir;
    try {
        mkdirSync(join(dataDir, 'sessions'));
        const id = `sess_cache_${process.pid}_${Date.now()}`;
        const write = (messages) => writeFileSync(
            join(dataDir, 'sessions', `${id}.json`),
            JSON.stringify({ id, closed: true, generation: 1, messages }),
        );
        write([{ role: 'user', content: 'first' }]);
        const {
            readStoredSessionTranscript,
            clearStoredTranscriptCache,
        } = await import('./store-summary-reader.mjs');
        clearStoredTranscriptCache();
        const traces = [];
        const trace = (entry) => traces.push(entry);
        const first = await readStoredSessionTranscript(id, { transcriptItemLimit: 512, trace });
        const second = await readStoredSessionTranscript(id, { transcriptItemLimit: 512, trace });
        assert.equal(second, first);
        assert.match(String(first.projectionStamp), /^\d+:[a-z0-9]+:\d+$/);
        assert.deepEqual(traces.map((entry) => entry.hit), [false, true]);
        write([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }]);
        const third = await readStoredSessionTranscript(id, { transcriptItemLimit: 512, trace });
        assert.notEqual(third, first);
        assert.notEqual(third.projectionStamp, first.projectionStamp);
        assert.equal(third.items.length, 2);
        assert.equal(traces.at(-1).hit, false);
    } finally {
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(dataDir, { recursive: true, force: true });
    }
});

test('projection stamps are unique within a process', () => {
    assert.notEqual(nextProjectionStamp(), nextProjectionStamp());
});
