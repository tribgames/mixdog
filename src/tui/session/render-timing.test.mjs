import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { registerRenderFrameSource, scheduleRenderFrameAck, yieldToRenderer } from './render-timing.mjs';

test('a headless yield settles in the next check phase without renderer timeout', async () => {
    let settled = false;
    const waiting = yieldToRenderer().then(() => { settled = true; });
    assert.equal(settled, false);
    await immediate();
    assert.equal(settled, true);
    await waiting;
});

test('a renderer waits for fresh frames and ignores a queued stale acknowledgement', async () => {
    const release = registerRenderFrameSource();
    try {
        scheduleRenderFrameAck();
        let settled = false;
        const waiting = yieldToRenderer({ frames: 2 }).then(() => { settled = true; });
        await immediate();
        assert.equal(settled, false);
        scheduleRenderFrameAck();
        await immediate();
        assert.equal(settled, false);
        scheduleRenderFrameAck();
        await waiting;
        assert.equal(settled, true);
    } finally { release(); }
});

test('closing the final renderer releases waiters, but closing another source does not', async () => {
    const first = registerRenderFrameSource(), second = registerRenderFrameSource();
    try {
        let settled = false;
        const waiting = yieldToRenderer().then(() => { settled = true; });
        first();
        await immediate();
        assert.equal(settled, false);
        second();
        await waiting;
        assert.equal(settled, true);
    } finally { first(); second(); }
});

test('a registered but stalled renderer retains the bounded hang guard', async () => {
    const release = registerRenderFrameSource();
    try { await yieldToRenderer(); } finally { release(); }
});
