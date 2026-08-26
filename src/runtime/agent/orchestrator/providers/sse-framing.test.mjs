import assert from 'node:assert/strict';
import test from 'node:test';

import {
    frameAndParseSse,
    frameSseRegion,
    parseSseFrames,
    splitSseRegion,
} from './lib/sse-framing.mjs';
import { createStreamJsonPool, frameProviderSseChunk } from './stream-json-pool.mjs';
import { parseSSEStream } from './anthropic-sse.mjs';

// Reference implementation: the exact line loop the Anthropic reader used
// before whole-chunk framing. Parity against it is the semantics contract.
function legacyFrame(text, currentEvent = '') {
    const frames = [];
    let name = currentEvent;
    const lines = text.split('\n');
    lines.pop();
    for (const line of lines) {
        if (line.startsWith(':')) continue;
        if (line === '') continue;
        if (line.startsWith('event: ')) {
            name = line.slice(7).trim();
            continue;
        }
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        frames.push({ name, data });
    }
    return { frames, currentEvent: name };
}

const FIXTURE = [
    ': ping\n\n',
    'event: message_start\ndata: {"type":"message_start","message":{"model":"m"}}\n\n',
    ':ping\n\n',
    'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0}\r\n\r\n',
    'data: {"type":"anonymous"}\n\n',
    'data: \n\n',
    'id: 7\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

test('framer matches the legacy line loop, including keepalives and CRLF', () => {
    const region = splitSseRegion(FIXTURE);
    assert.equal(region.rest, '');
    assert.deepEqual(frameSseRegion(region.region, ''), legacyFrame(FIXTURE, ''));
});

test('framer matches the legacy loop for every chunk boundary', () => {
    for (let cut = 0; cut <= FIXTURE.length; cut += 1) {
        let buffer = '';
        let carry = '';
        const framed = [];
        for (const piece of [FIXTURE.slice(0, cut), FIXTURE.slice(cut)]) {
            buffer += piece;
            const { region, rest } = splitSseRegion(buffer);
            buffer = rest;
            if (!region) continue;
            const result = frameSseRegion(region, carry);
            carry = result.currentEvent;
            framed.push(...result.frames);
        }
        assert.equal(buffer, '', `residual buffer at cut ${cut}`);
        assert.deepEqual(framed, legacyFrame(FIXTURE, '').frames, `frames at cut ${cut}`);
        assert.equal(carry, legacyFrame(FIXTURE, '').currentEvent, `carry at cut ${cut}`);
    }
});

test('splitSseRegion keeps the trailing partial record buffered', () => {
    assert.deepEqual(splitSseRegion('data: {"a":1}\npart'), {
        region: 'data: {"a":1}\n',
        rest: 'part',
    });
    assert.deepEqual(splitSseRegion('no newline yet'), { region: '', rest: 'no newline yet' });
});

test('a malformed record is isolated, never discarding its batch', () => {
    const events = parseSseFrames([
        { name: 'a', data: '{"ok":1}' },
        { name: 'b', data: '{oops' },
        { name: 'c', data: '{"ok":2}' },
    ]);
    assert.deepEqual(events[0], { name: 'a', value: { ok: 1 } });
    assert.equal(events[1].value, undefined);
    assert.equal(events[1].error.name, 'SyntaxError');
    assert.deepEqual(events[2], { name: 'c', value: { ok: 2 } });
});

// --- pool routing ---

// Deterministic stand-in for the stream worker: replies only when the test
// flushes it, so routing and ordering are observable without timing races.
class FakeWorker {
    constructor() {
        FakeWorker.spawnAttempts += 1;
        if (FakeWorker.spawnLimit !== null && FakeWorker.instances.length >= FakeWorker.spawnLimit) {
            throw new Error('EAGAIN: cannot spawn worker thread');
        }
        this.handlers = new Map();
        this.posted = [];
        this.held = [];
        FakeWorker.instances.push(this);
    }

    on(event, handler) {
        const list = this.handlers.get(event) || [];
        list.push(handler);
        this.handlers.set(event, list);
    }

    emit(event, payload) {
        for (const handler of this.handlers.get(event) || []) handler(payload);
    }

    postMessage(message) {
        this.posted.push(message);
        this.held.push(message);
    }

    reply(message) {
        if (message.kind === 'sse') {
            const framed = frameAndParseSse(String(message.text || ''), String(message.event || ''));
            queueMicrotask(() => this.emit('message', {
                id: message.id,
                ok: true,
                kind: 'sse',
                events: framed.events,
                event: framed.currentEvent,
            }));
            return;
        }
        // Batch protocol (Gemini/OpenAI payload lists) — mirrors the worker.
        let reply;
        try {
            reply = { id: message.id, ok: true, values: message.payloads.map((p) => JSON.parse(String(p))) };
        } catch (error) {
            reply = { id: message.id, ok: false, error: { name: error.name, message: error.message } };
        }
        queueMicrotask(() => this.emit('message', reply));
    }

    /** Reply to held messages; with `filter`, only to the matching ones. */
    flush(filter) {
        const send = [];
        const keep = [];
        for (const message of this.held) {
            if (!filter || filter(message)) send.push(message);
            else keep.push(message);
        }
        this.held = keep;
        for (const message of send) this.reply(message);
    }

    terminate() { return Promise.resolve(); }
    unref() {}
    ref() {}
}
FakeWorker.instances = [];
FakeWorker.spawnLimit = null;
FakeWorker.spawnAttempts = 0;

function sseText(events) {
    return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

test('small chunks are framed inline and synchronously (no per-event microtask)', () => {
    const pool = createStreamJsonPool({ maxWorkers: 1, minBatchBytes: 64 * 1024, WorkerImpl: FakeWorker });
    const text = sseText([{ type: 'a', i: 1 }, { type: 'b', i: 2 }, { type: 'c', i: 3 }]);
    const framed = pool.frameSse(text, { streamKey: 'inline' });
    assert.equal(typeof framed?.then, 'undefined');
    assert.deepEqual(framed.events.map((event) => event.value.type), ['a', 'b', 'c']);
    assert.equal(pool.snapshot().inlineChunks, 1);
    assert.equal(pool.snapshot().offloadedChunks, 0);
    assert.equal(pool.snapshot().workers, 0);
});

test('large chunks are offloaded and settle in per-stream submission order', async () => {
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({ maxWorkers: 1, minBatchBytes: 256, WorkerImpl: FakeWorker });
    const large = sseText(Array.from({ length: 40 }, (_, i) => ({ type: 'big', i })));
    const small = sseText([{ type: 'small', i: 0 }]);
    assert.ok(Buffer.byteLength(large) >= 256);
    assert.ok(Buffer.byteLength(small) < 256);

    const settled = [];
    const first = Promise.resolve(pool.frameSse(large, { streamKey: 's1' }))
        .then((value) => { settled.push(['first', value.events.length]); return value; });
    const worker = FakeWorker.instances.at(-1);
    assert.equal(worker.posted.length, 1);
    assert.equal(worker.posted[0].kind, 'sse');

    const second = Promise.resolve(pool.frameSse(small, { streamKey: 's1' }))
        .then((value) => { settled.push(['second', value.events.length]); return value; });

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(settled, [], 'inline chunk must not overtake the offloaded one');
    worker.flush();
    await Promise.all([first, second]);
    assert.deepEqual(settled, [['first', 40], ['second', 1]]);
    assert.equal(pool.snapshot().offloadedChunks, 1);
    assert.equal(pool.snapshot().pendingBytes, 0);
    await pool.close();
});

test('worker loss and pool close fall back to inline framing instead of failing the stream', async () => {
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({ maxWorkers: 1, minBatchBytes: 128, WorkerImpl: FakeWorker });
    const large = sseText(Array.from({ length: 20 }, (_, i) => ({ type: 'big', i })));

    const pending = pool.frameSse(large, { streamKey: 'dead' });
    const worker = FakeWorker.instances.at(-1);
    worker.emit('error', new Error('worker died'));
    const recovered = await pending;
    assert.equal(recovered.events.length, 20);
    assert.equal(pool.snapshot().fallbackBatches, 1);
    assert.equal(pool.snapshot().pendingBytes, 0);

    await pool.close();
    const afterClose = pool.frameSse(large, { streamKey: 'dead' });
    assert.equal(typeof afterClose?.then, 'undefined');
    assert.equal(afterClose.events.length, 20);
});

test('active stream tails and owner affinity survive thousands of other live streams', async () => {
    // Regression: the metadata bound used to evict the OLDEST entry, which is
    // by definition an ACTIVE stream — s0 lost its tail and its affinity while
    // chunk 1 was still in flight, so chunk 2 settled first (Reviewer repro).
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({
        maxWorkers: 2,
        minBatchBytes: 64,
        maxPendingBytes: 64 * 1024 * 1024,
        WorkerImpl: FakeWorker,
    });
    const chunkOne = sseText([{ type: 's0-1', pad: 'a'.repeat(120) }]);
    const chunkTwo = sseText([{ type: 's0-2' }]); // below the threshold → inline route
    const filler = sseText([{ type: 'filler', pad: 'f'.repeat(120) }]);
    assert.ok(Buffer.byteLength(chunkTwo) < 64);

    const settled = [];
    const first = Promise.resolve(pool.frameSse(chunkOne, { ownerKey: 'owner-0', streamKey: 's0' }))
        .then((value) => { settled.push('s0#1'); return value; });

    const others = [];
    const otherStreams = 4600; // past the former 4,096-entry hard bound
    for (let index = 1; index <= otherStreams; index += 1) {
        others.push(Promise.resolve(pool.frameSse(filler, {
            ownerKey: `owner-${index}`,
            streamKey: `s${index}`,
        })));
    }
    const second = Promise.resolve(pool.frameSse(chunkTwo, { ownerKey: 'owner-0', streamKey: 's0' }))
        .then((value) => { settled.push('s0#2'); return value; });

    // Every live stream still owns its ordering slot and its affinity.
    assert.equal(pool.snapshot().orderedStreams, otherStreams + 1);
    assert.equal(pool.snapshot().ownerAffinities, otherStreams + 1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(settled, [], 'chunk 2 must not settle while chunk 1 is in flight');
    for (const worker of FakeWorker.instances) worker.flush();
    await Promise.all([first, second, ...others]);
    assert.deepEqual(settled, ['s0#1', 's0#2']);

    // Settled streams release their slots; idle affinity entries are still
    // pruned once the soft cap is reached, so the bound keeps working.
    assert.equal(pool.snapshot().orderedStreams, 0);
    for (let index = 0; index < 8; index += 1) {
        const late = Promise.resolve(pool.frameSse(filler, {
            ownerKey: `late-owner-${index}`,
            streamKey: `late-${index}`,
        }));
        for (const worker of FakeWorker.instances) worker.flush();
        await late;
    }
    assert.ok(pool.snapshot().ownerAffinities <= 4096, 'idle affinity metadata stays bounded');
    await pool.close();
});

test('an open transport retains owner affinity while waiting between chunks', async () => {
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({
        maxWorkers: 2,
        minBatchBytes: 64,
        maxIdleOwnerAffinities: 4,
        WorkerImpl: FakeWorker,
    });
    const chunk = sseText([{ type: 'chunk', pad: 'x'.repeat(120) }]);
    const pre = Promise.resolve(pool.frameSse(chunk, { ownerKey: 'pre-owner', streamKey: 'pre' }));
    const workerA = FakeWorker.instances[0];

    assert.equal(pool.retainStream('open-stream', 'open-owner'), true);
    const first = Promise.resolve(pool.frameSse(chunk, {
        ownerKey: 'open-owner',
        streamKey: 'open-stream',
    }));
    const workerB = FakeWorker.instances[1];
    assert.notEqual(workerA, workerB);

    workerA.flush();
    workerB.flush();
    await Promise.all([pre, first]);
    assert.equal(pool.snapshot().retainedStreams, 1);

    for (let index = 0; index < 8; index += 1) {
        const other = Promise.resolve(pool.frameSse(chunk, {
            ownerKey: `idle-owner-${index}`,
            streamKey: `idle-stream-${index}`,
        }));
        for (const worker of FakeWorker.instances) worker.flush();
        await other;
    }
    assert.ok(pool.snapshot().ownerAffinities <= 4);

    const second = Promise.resolve(pool.frameSse(chunk, {
        ownerKey: 'open-owner',
        streamKey: 'open-stream',
    }));
    assert.equal(workerB.posted.at(-1)?.text, chunk, 'open stream stayed on its original worker');
    workerB.flush();
    await second;

    pool.releaseStream('open-stream');
    assert.equal(pool.snapshot().retainedStreams, 0);
    await pool.close();
});

test('a queued chunk keeps its owner affinity through a prune burst (no migration)', async () => {
    // Regression: the affinity hold used to start at postMessage time, so an
    // owner was "idle" between its settled chunk and its next queued chunk —
    // any new-owner insert in that instant (drainWaiting bursts included)
    // pruned it and the next chunk migrated to another worker.
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({
        maxWorkers: 2,
        minBatchBytes: 64,
        maxPendingBytes: 64 * 1024 * 1024,
        WorkerImpl: FakeWorker,
    });
    const pre = sseText([{ type: 'pre', pad: 'p'.repeat(120) }]);
    const chunkOne = sseText([{ type: 's0-1', pad: 'a'.repeat(120) }]);
    const chunkTwo = sseText([{ type: 's0-2' }]); // inline route, still queued
    const chunkThree = sseText([{ type: 's0-3', pad: 'c'.repeat(120) }]);
    const filler = sseText([{ type: 'filler', pad: 'f'.repeat(120) }]);
    const pending = [];

    // Another owner creates worker A, so s0 is affine to worker B.
    pending.push(Promise.resolve(pool.frameSse(pre, { ownerKey: 'pre-owner', streamKey: 'pre' })));
    const workerA = FakeWorker.instances[0];
    const first = Promise.resolve(pool.frameSse(chunkOne, { ownerKey: 'owner-0', streamKey: 's0' }));
    const workerB = FakeWorker.instances[1];
    assert.notEqual(workerA, workerB);
    assert.ok(workerB.posted.some((message) => message.text === chunkOne), 's0 starts on worker B');

    for (let index = 1; index <= 4600; index += 1) {
        pending.push(Promise.resolve(pool.frameSse(filler, {
            ownerKey: `owner-${index}`,
            streamKey: `s${index}`,
        })));
    }

    const settled = [];
    const second = Promise.resolve(pool.frameSse(chunkTwo, { ownerKey: 'owner-0', streamKey: 's0' }))
        .then((value) => { settled.push('s0#2'); return value; });
    const third = Promise.resolve(pool.frameSse(chunkThree, { ownerKey: 'owner-0', streamKey: 's0' }))
        .then((value) => { settled.push('s0#3'); return value; });
    pending.push(first.then((value) => { settled.push('s0#1'); return value; }));
    // Brand-new owners inserted in the instant AFTER chunk 1 settles and
    // BEFORE the queued chunk 3 is posted: the exact prune window.
    pending.push(first.then(() => {
        for (let index = 0; index < 600; index += 1) {
            pending.push(Promise.resolve(pool.frameSse(filler, {
                ownerKey: `burst-${index}`,
                streamKey: `burst-${index}`,
            })));
        }
    }));

    workerA.flush(); // worker A drains: thousands of owners go idle
    workerB.flush((message) => message.text === chunkOne); // settle s0 chunk 1 only
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.ok(
        workerB.posted.some((message) => message.text === chunkThree),
        'queued chunk 3 stayed on the affine worker B',
    );
    assert.equal(
        workerA.posted.some((message) => message.text === chunkThree),
        false,
        'chunk 3 must not migrate to the least-loaded worker A',
    );
    assert.deepEqual(settled, ['s0#1', 's0#2']);

    for (const worker of FakeWorker.instances) worker.flush();
    await Promise.all([...pending, second, third]);
    assert.deepEqual(settled, ['s0#1', 's0#2', 's0#3']);
    assert.equal(pool.snapshot().pendingBytes, 0);
    await pool.close();
});

test('idle affinity metadata is pruned on settlement, with no new owner arriving', async () => {
    // Regression: pruning ran only on insertion, so 4,601 settled owners stayed
    // in the map until some unrelated owner happened to show up.
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({
        maxWorkers: 2,
        minBatchBytes: 64,
        maxPendingBytes: 64 * 1024 * 1024,
        WorkerImpl: FakeWorker,
    });
    const chunk = sseText([{ type: 'chunk', pad: 'z'.repeat(120) }]);
    const pending = [];
    for (let index = 0; index < 4601; index += 1) {
        pending.push(Promise.resolve(pool.frameSse(chunk, {
            ownerKey: `owner-${index}`,
            streamKey: `s${index}`,
        })));
    }
    assert.equal(pool.snapshot().ownerAffinities, 4601, 'live owners are never evicted');

    for (const worker of FakeWorker.instances) worker.flush();
    await Promise.all(pending);
    const after = pool.snapshot();
    assert.ok(after.ownerAffinities <= 4096, `settled owners pruned (${after.ownerAffinities})`);
    assert.equal(after.orderedStreams, 0);
    assert.equal(after.pendingBytes, 0);
    await pool.close();
});

test('a failed spawn settles that task inline instead of queueing it on a busy worker', async () => {
    FakeWorker.instances.length = 0;
    FakeWorker.spawnLimit = 1;
    try {
        const pool = createStreamJsonPool({ maxWorkers: 4, minBatchBytes: 64, WorkerImpl: FakeWorker });
        const large = sseText(Array.from({ length: 8 }, (_, index) => ({ type: 'big', index })));

        const held = Promise.resolve(pool.frameSse(large, { ownerKey: 'owner-a', streamKey: 'sa' }));
        const workerA = FakeWorker.instances[0];
        assert.equal(workerA.posted.length, 1);

        // Worker A is busy, so this task wants its own worker and the spawn
        // fails: it must settle inline right now, not queue behind worker A.
        const inlined = await pool.frameSse(large, { ownerKey: 'owner-b', streamKey: 'sb' });
        assert.equal(inlined.events.length, 8);
        assert.equal(workerA.posted.length, 1, 'failed-spawn task was not queued onto worker A');
        assert.equal(pool.snapshot().workers, 1);

        const alsoInlined = await pool.frameSse(large, { ownerKey: 'owner-c', streamKey: 'sc' });
        assert.equal(alsoInlined.events.length, 8);
        assert.equal(workerA.posted.length, 1, 'the failure latch never serializes offload work');

        workerA.flush();
        assert.equal((await held).events.length, 8);

        // A healthy IDLE worker is still reused: only queueing behind a busy
        // worker the task deliberately avoided is refused.
        const reused = Promise.resolve(pool.frameSse(large, { ownerKey: 'owner-d', streamKey: 'sd' }));
        assert.equal(workerA.posted.length, 2, 'an idle healthy worker is still reused');
        workerA.flush();
        assert.equal((await reused).events.length, 8);
        await pool.close();
    } finally {
        FakeWorker.spawnLimit = null;
    }
});

test('a throwing WorkerImpl falls back to inline work without failing the stream', async () => {
    class ExplodingWorker {
        constructor() { throw new Error('EAGAIN: cannot spawn worker thread'); }
    }
    const pool = createStreamJsonPool({ maxWorkers: 2, minBatchBytes: 64, WorkerImpl: ExplodingWorker });
    const large = sseText(Array.from({ length: 8 }, (_, index) => ({ type: 'big', index })));

    const framed = await pool.frameSse(large, { ownerKey: 'owner-x', streamKey: 'sx' });
    assert.equal(framed.events.length, 8);
    assert.deepEqual(framed.events[0].value, { type: 'big', index: 0 });
    assert.equal(framed.currentEvent, 'big');
    assert.equal(pool.snapshot().workers, 0);
    assert.ok(pool.snapshot().spawnFailures >= 1);

    // Batch tasks keep their exact contract on the same fallback path.
    const payload = JSON.stringify({ pad: 'y'.repeat(256) });
    assert.deepEqual(await pool.parseBatch([payload]), [JSON.parse(payload)]);
    await assert.rejects(pool.parseBatch([payload, '{"broken"']), (error) => error instanceof SyntaxError);

    // Abort semantics are untouched by the fallback.
    const controller = new AbortController();
    controller.abort(new Error('canceled by caller'));
    await assert.rejects(
        pool.parseBatch([payload], { signal: controller.signal }),
        /canceled by caller/,
    );

    // Repeated failures latch instead of re-throwing a constructor per chunk.
    assert.equal(pool.snapshot().workerSpawnDisabled, true);
    assert.equal(pool.snapshot().spawnFailures, 3);
    const stillFramed = await pool.frameSse(large, { ownerKey: 'owner-x', streamKey: 'sx' });
    assert.equal(stillFramed.events.length, 8);
    assert.equal(pool.snapshot().spawnFailures, 3, 'latched: no further spawn attempts');
});

test('a WorkerImpl that fails listener wiring also degrades to inline work', async () => {
    let terminated = 0;
    class HalfBrokenWorker {
        on() { throw new Error('listener wiring failed'); }
        unref() {}
        ref() {}
        postMessage() { throw new Error('unreachable'); }
        terminate() { terminated += 1; return Promise.resolve(); }
    }
    const pool = createStreamJsonPool({ maxWorkers: 1, minBatchBytes: 64, WorkerImpl: HalfBrokenWorker });
    const large = sseText(Array.from({ length: 6 }, (_, index) => ({ type: 'big', index })));
    const framed = await pool.frameSse(large, { ownerKey: 'owner-y', streamKey: 'sy' });
    assert.equal(framed.events.length, 6);
    assert.equal(terminated, 1, 'a half-built worker is terminated, not leaked');
    assert.equal(pool.snapshot().workers, 0);
    assert.ok(pool.snapshot().spawnFailures >= 1);
});

test('oversized chunks stay inline so pending worker memory stays bounded', () => {
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({
        maxWorkers: 1,
        minBatchBytes: 16,
        maxPendingBytes: 1, // clamped up to the 1 MiB floor by the pool
        WorkerImpl: FakeWorker,
    });
    const oversized = sseText([{ type: 'big', text: 'x'.repeat(1024 * 1024 + 4096) }]);
    assert.ok(Buffer.byteLength(oversized) > pool.snapshot().maxPendingBytes);
    const framed = pool.frameSse(oversized, { streamKey: 'huge' });
    assert.equal(typeof framed?.then, 'undefined');
    assert.equal(framed.events.length, 1);
    assert.equal(pool.snapshot().pendingBytes, 0);
    assert.equal(FakeWorker.instances.length, 0);
});

test('offloaded JSON batches keep their resolve/reject contract', async () => {
    FakeWorker.instances.length = 0;
    const pool = createStreamJsonPool({ maxWorkers: 1, minBatchBytes: 64, WorkerImpl: FakeWorker });
    const payload = JSON.stringify({ pad: 'y'.repeat(256) });

    const good = pool.parseBatch([payload, payload]);
    const bad = pool.parseBatch([payload, '{"broken"']);
    const worker = FakeWorker.instances.at(-1);
    worker.flush();
    assert.deepEqual(await good, [JSON.parse(payload), JSON.parse(payload)]);
    await assert.rejects(bad, (error) => error instanceof SyntaxError);
    assert.equal(pool.snapshot().pendingBytes, 0);
    await pool.close();
});

// --- Anthropic reader parity ---

function rawResponse(chunks) {
    const encoder = new TextEncoder();
    const encoded = chunks.map((chunk) => encoder.encode(chunk));
    let index = 0;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        return index < encoded.length
                            ? Promise.resolve({ done: false, value: encoded[index++] })
                            : Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}

function freshState() {
    return {
        attemptIndex: 0,
        sawMessageStart: false,
        sawCompleted: false,
        emittedToolCall: false,
        partialToolCall: false,
        emittedThinking: false,
        emittedText: false,
    };
}

const TURN_EVENTS = [
    { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 11 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hello ' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"a.txt"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
];

function turnText() {
    return TURN_EVENTS
        .map((event, index) => (index % 3 === 0 ? ': ping\n\n' : '')
            + `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('');
}

async function runTurn(chunks) {
    const state = freshState();
    const textDeltas = [];
    const toolCalls = [];
    const deltaKinds = [];
    const result = await parseSSEStream(
        rawResponse(chunks),
        null,
        () => {},
        (kind) => deltaKinds.push(kind),
        (call) => toolCalls.push({ call, sawCompleted: state.sawCompleted }),
        state,
        (text) => textDeltas.push(text),
    );
    return { result, state, textDeltas, toolCalls, deltaKinds };
}

test('a whole-chunk batch keeps text, reasoning and eager tool dispatch intact', async () => {
    const batched = await runTurn([turnText()]);
    assert.equal(batched.result.content, 'hello world');
    assert.equal(batched.result.model, 'claude-test');
    assert.equal(batched.result.stopReason, 'tool_use');
    assert.deepEqual(batched.textDeltas, ['hello ', 'world']);
    assert.equal(batched.result.toolCalls.length, 1);
    assert.deepEqual(batched.result.toolCalls[0], {
        id: 'toolu_1',
        name: 'read',
        arguments: { path: 'a.txt' },
    });
    // Eager dispatch: the call fires while the batch is still being replayed,
    // before the terminal frame of the same chunk is handled.
    assert.equal(batched.toolCalls[0].sawCompleted, false);
    assert.equal(batched.state.emittedToolCall, true);
    assert.equal(batched.state.emittedThinking, true);
    assert.deepEqual(batched.result.thinkingBlocks, [{ type: 'thinking', thinking: 'plan', signature: '' }]);
    assert.equal(batched.result.usage.inputTokens, 11);
    assert.equal(batched.result.usage.outputTokens, 5);
    assert.ok(batched.deltaKinds.includes('transport'));
    assert.ok(batched.deltaKinds.includes('text'));
});

test('chunk boundaries do not change the parsed turn', async () => {
    const text = turnText();
    const batched = await runTurn([text]);
    const byteWise = await runTurn(Array.from(text, (character) => character));
    const halved = await runTurn([text.slice(0, 137), text.slice(137)]);
    for (const variant of [byteWise, halved]) {
        assert.equal(variant.result.content, batched.result.content);
        assert.deepEqual(variant.result.toolCalls, batched.result.toolCalls);
        assert.deepEqual(variant.textDeltas, batched.textDeltas);
        assert.deepEqual(variant.result.thinkingBlocks, batched.result.thinkingBlocks);
        assert.equal(variant.state.sawCompleted, true);
    }
});

test('a malformed record is skipped while its batch mates still stream', async () => {
    const events = [
        { type: 'message_start', message: { model: 'm' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ];
    const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
        + 'event: content_block_delta\ndata: {"type":"content_block_delta",\n\n'
        + `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'kept' } })}\n\n`
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const run = await runTurn([text]);
    assert.equal(run.result.content, 'kept');
    assert.equal(run.state.sawCompleted, true);
});

test('a named error frame split across chunks still throws the typed SSE error', async () => {
    await assert.rejects(
        runTurn([
            'event: message_start\ndata: {"type":"message_start","message":{"model":"m"}}\n\nevent: error\n',
            'data: {"type":"overloaded_error","message":"boom"}\n\n',
        ]),
        (error) => {
            assert.equal(error.code, 'EANTHROPIC_SSE_ERROR');
            assert.equal(error.providerErrorType, 'overloaded_error');
            assert.equal(error.httpStatus, 503);
            return true;
        },
    );
});

test('an oversized chunk round-trips through the real stream worker', async () => {
    const filler = 'x'.repeat(48 * 1024);
    const events = [
        { type: 'message_start', message: { model: 'm' } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: filler } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
    ];
    const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    assert.ok(Buffer.byteLength(text) > 32 * 1024);
    const framed = frameProviderSseChunk(text, { streamKey: 'real-worker' });
    const resolved = typeof framed?.then === 'function' ? await framed : framed;
    assert.equal(resolved.events.length, events.length);
    assert.equal(resolved.events[2].value.delta.text.length, filler.length);

    const run = await runTurn([text]);
    assert.equal(run.result.content.length, filler.length);
    assert.equal(run.result.stopReason, 'end_turn');
    assert.equal(run.state.sawCompleted, true);
});
