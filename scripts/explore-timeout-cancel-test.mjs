#!/usr/bin/env node
// Regression test for explore-tool wall-clock timeout + cancellation cleanup:
//   - the default hard timeout is 60s (was 10min) and the
//     MIXDOG_EXPLORE_HARD_TIMEOUT_MS override (including 0 = disabled) is kept;
//   - a parent cancellation aborts every child compute AbortSignal immediately;
//   - the wall-clock hard timeout aborts the compute AbortSignal (not just the
//     race), so wedged compute tears down instead of running detached;
//   - a canceled/timed-out compute purges its poisoned cache entry so a later
//     call never awaits a dead promise and empties into "no tool output".
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
    EXPLORE_COMPUTE_HARD_TIMEOUT_MS,
    runExploreComputeWithAbort,
    runExploreCached,
    runExplore,
    exploreStaggerDelay,
    awaitExploreProviderReadyOrCancel,
    ensureExploreProviderReady,
    __exploreResultCacheForTest,
} from '../src/standalone/explore-tool.mjs';

const MODULE_URL = new URL('../src/standalone/explore-tool.mjs', import.meta.url).href;

// A compute stub that rejects the moment its AbortSignal fires (mirrors a real
// child dispatch tearing down on abort), and handles the already-aborted case.
function abortAwareCompute(record) {
    return (signal) => new Promise((_resolve, reject) => {
        record?.(signal);
        if (signal.aborted) { reject(signal.reason || new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(signal.reason || new Error('aborted')), { once: true });
    });
}

function readHardTimeoutWithEnv(value) {
    const code = `import(${JSON.stringify(MODULE_URL)}).then((m) => process.stdout.write(String(m.EXPLORE_COMPUTE_HARD_TIMEOUT_MS)))`;
    return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, MIXDOG_EXPLORE_HARD_TIMEOUT_MS: value },
        encoding: 'utf8',
    }).trim();
}

// The production hard-timeout timer is unref()'d (must never keep the host
// process alive). In an otherwise-idle test that relies on that timer firing,
// hold a ref'd timer so the event loop stays alive until the assertion settles.
function keepEventLoopAlive(ms = 5_000) {
    const t = setTimeout(() => {}, ms);
    return () => clearTimeout(t);
}

test('default explore hard timeout is 60 seconds', () => {
    // Only meaningful when the override is unset (the CI/default environment).
    if (process.env.MIXDOG_EXPLORE_HARD_TIMEOUT_MS == null) {
        assert.equal(EXPLORE_COMPUTE_HARD_TIMEOUT_MS, 60_000);
    }
});

test('MIXDOG_EXPLORE_HARD_TIMEOUT_MS override is preserved (including 0 = disabled)', () => {
    assert.equal(readHardTimeoutWithEnv('1234'), '1234');
    assert.equal(readHardTimeoutWithEnv('0'), '0');
    assert.equal(readHardTimeoutWithEnv('90000'), '90000');
});

test('hard timeout aborts the compute AbortSignal', async () => {
    const release = keepEventLoopAlive();
    try {
        let received = null;
        const p = runExploreComputeWithAbort((signal) => {
            received = signal;
            return new Promise(() => {}); // never settles on its own
        }, null, 25);
        await assert.rejects(p, /timed out/);
        assert.ok(received, 'compute received a signal');
        assert.equal(received.aborted, true);
    } finally {
        release();
    }
});

test('parent cancellation aborts every child compute immediately', async () => {
    const parent = new AbortController();
    const seen = [];
    const p1 = runExploreComputeWithAbort(abortAwareCompute((s) => seen.push(s)), parent.signal, 10_000);
    const p2 = runExploreComputeWithAbort(abortAwareCompute((s) => seen.push(s)), parent.signal, 10_000);
    parent.abort(new Error('user pressed ESC'));
    await assert.rejects(p1);
    await assert.rejects(p2);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => s.aborted), 'both child signals aborted');
});

test('an already-aborted parent signal aborts the compute up front', async () => {
    const parent = new AbortController();
    parent.abort(new Error('already canceled'));
    let received = null;
    const p = runExploreComputeWithAbort(abortAwareCompute((s) => { received = s; }), parent.signal, 10_000);
    await assert.rejects(p);
    assert.ok(received.aborted, 'compute signal was already aborted');
});

test('a canceled compute purges its poisoned cache entry', async () => {
    // Force the result cache on so the in-flight promise is stored.
    process.env.MIXDOG_EXPLORE_RESULT_CACHE = '1';
    const cache = __exploreResultCacheForTest();
    cache.clear();
    const key = 'explore-cancel-poison-key';
    const parent = new AbortController();
    const promise = runExploreCached(key, abortAwareCompute(), parent.signal);
    // Pending promise cached while the compute is in flight.
    assert.equal(cache.has(key), true);
    parent.abort(new Error('cancel'));
    await assert.rejects(promise);
    // The poisoned pending entry must be gone so a later call recomputes fresh
    // instead of awaiting the dead promise.
    assert.equal(cache.has(key), false);
});

test('a wedged never-resolving shared compute is purged by its real hard-timeout timer and recomputed', async () => {
    process.env.MIXDOG_EXPLORE_RESULT_CACHE = '1';
    const cache = __exploreResultCacheForTest();
    cache.clear();
    const key = 'shared-hard-timeout-wedged';
    const seen = [];
    let calls = 0;
    const neverResolves = (signal) => { calls += 1; seen.push(signal); return new Promise(() => {}); };
    const release = keepEventLoopAlive();
    try {
        await assert.rejects(runExploreCached(key, neverResolves, null, 25), /timed out/);
        assert.equal(seen[0].aborted, true, 'the timer aborted the actual wedged compute');
        assert.equal(cache.has(key), false, 'timed-out pending entry was purged');
        assert.equal(await runExploreCached(key, () => { calls += 1; return Promise.resolve('fresh'); }, null, 100), 'fresh');
        assert.equal(calls, 2, 'a later caller recomputes rather than reusing the rejected promise');
    } finally {
        release();
    }
});

// A compute whose settlement the test controls, recording the AbortSignal it
// received so shared-compute teardown can be asserted.
function deferredCompute() {
    const handle = { signal: null, resolve: null, reject: null };
    handle.fn = (signal) => new Promise((resolve, reject) => {
        handle.signal = signal;
        handle.resolve = resolve;
        handle.reject = reject;
    });
    return handle;
}

test('parent cancellation rejects immediately even for a non-cooperative compute', async () => {
    // The compute IGNORES its AbortSignal (never settles on abort). Cancellation
    // must still reject the returned promise right away — not hang until the
    // wall-clock hard timeout.
    const parent = new AbortController();
    const p = runExploreComputeWithAbort(() => new Promise(() => {}), parent.signal, 10_000);
    const t0 = Date.now();
    parent.abort(new Error('user pressed ESC'));
    await assert.rejects(p);
    assert.ok(Date.now() - t0 < 500, 'rejected promptly, not after the hard timeout');
});

test('never-resolving compute is torn down by the hard timeout (real cleanup)', async () => {
    const release = keepEventLoopAlive();
    try {
        let received = null;
        const p = runExploreComputeWithAbort((signal) => {
            received = signal;
            return new Promise(() => {}); // never resolves, never observes abort
        }, null, 30);
        await assert.rejects(p, /timed out/);
        assert.equal(received.aborted, true, 'compute signal aborted on timeout');
    } finally {
        release();
    }
});

test('owner cancellation does not abort an unaffected later subscriber', async () => {
    process.env.MIXDOG_EXPLORE_RESULT_CACHE = '1';
    const cache = __exploreResultCacheForTest();
    cache.clear();
    const key = 'shared-owner-cancel';
    const dc = deferredCompute();
    const owner = new AbortController();
    const later = new AbortController();
    const ownerP = runExploreCached(key, dc.fn, owner.signal); // starts shared compute
    const laterP = runExploreCached(key, dc.fn, later.signal); // subscribes to the same compute
    owner.abort(new Error('owner ESC'));
    await assert.rejects(ownerP);
    // The shared compute must keep running for the still-active later subscriber.
    assert.equal(dc.signal.aborted, false, 'shared compute not aborted by owner cancel');
    assert.equal(cache.has(key), true);
    dc.resolve('src/x.mjs:1 — shared hit');
    assert.match(String(await laterP), /src\/x\.mjs:1/);
});

test('later subscriber cancellation releases itself without aborting the shared compute', async () => {
    process.env.MIXDOG_EXPLORE_RESULT_CACHE = '1';
    const cache = __exploreResultCacheForTest();
    cache.clear();
    const key = 'shared-later-cancel';
    const dc = deferredCompute();
    const owner = new AbortController();
    const later = new AbortController();
    const ownerP = runExploreCached(key, dc.fn, owner.signal);
    const laterP = runExploreCached(key, dc.fn, later.signal);
    later.abort(new Error('later ESC'));
    await assert.rejects(laterP);
    assert.equal(dc.signal.aborted, false, 'owner still waiting; compute alive');
    assert.equal(cache.has(key), true);
    dc.resolve('src/y.mjs:2 — owner result');
    assert.match(String(await ownerP), /src\/y\.mjs:2/);
});

test('all subscribers canceling aborts the shared compute and purges the cache', async () => {
    process.env.MIXDOG_EXPLORE_RESULT_CACHE = '1';
    const cache = __exploreResultCacheForTest();
    cache.clear();
    const key = 'shared-all-cancel';
    const dc = deferredCompute();
    const a = new AbortController();
    const b = new AbortController();
    const pa = runExploreCached(key, dc.fn, a.signal);
    const pb = runExploreCached(key, dc.fn, b.signal);
    a.abort(new Error('a ESC'));
    await assert.rejects(pa);
    assert.equal(cache.has(key), true, 'b still subscribed; compute retained');
    assert.equal(dc.signal.aborted, false);
    b.abort(new Error('b ESC'));
    await assert.rejects(pb);
    assert.equal(dc.signal.aborted, true, 'last subscriber gone; shared compute torn down');
    assert.equal(cache.has(key), false, 'purged so a future call recomputes');
});

test('a failed shared compute is purged so future calls recompute', async () => {
    process.env.MIXDOG_EXPLORE_RESULT_CACHE = '1';
    const cache = __exploreResultCacheForTest();
    cache.clear();
    const key = 'shared-recompute';
    let calls = 0;
    const compute = () => { calls += 1; return Promise.reject(new Error(`owner fail ${calls}`)); };
    await assert.rejects(runExploreCached(key, compute, null));
    assert.equal(cache.has(key), false);
    await assert.rejects(runExploreCached(key, compute, null));
    assert.equal(calls, 2, 'recomputed rather than deduping on the dead promise');
});

test('stagger delay is canceled before dispatch when the signal aborts', async () => {
    const ctrl = new AbortController();
    let dispatched = false;
    const p = exploreStaggerDelay(10_000, ctrl.signal).then(() => { dispatched = true; return 'DISPATCHED'; });
    ctrl.abort(new Error('cancel during stagger'));
    await assert.rejects(p);
    assert.equal(dispatched, false, 'child dispatch skipped after the stagger was canceled');
});

test('runtime-core forwards the caller signal into runExplore (plumbing)', () => {
    const src = readFileSync(new URL('../src/session-runtime/runtime-core.mjs', import.meta.url), 'utf8');
    const at = src.indexOf("name === 'explore'");
    assert.ok(at >= 0, 'explore branch present in runtime-core');
    const branch = src.slice(at, at + 1000);
    assert.match(branch, /return await runExplore\(/);
    assert.match(branch, /signal:\s*callerCtx\?\.signal\s*\|\|\s*session\?\.controller\?\.signal/);
});

test('runExplore short-circuits an already-canceled call without dispatching', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('canceled up front'));
    const res = await runExplore({ query: 'anything at all' }, { signal: ctrl.signal });
    assert.equal(res.isError, true);
    assert.match(res.content?.[0]?.text || '', /cancel/i);
});

test('explore provider warmup is canceled immediately when the caller aborts mid-init', async () => {
    const ctrl = new AbortController();
    const ready = new Promise(() => {}); // warmup wedged (never resolves)
    const t0 = Date.now();
    const p = awaitExploreProviderReadyOrCancel(ready, ctrl.signal);
    ctrl.abort(new Error('ESC during warmup'));
    const canceled = await p;
    assert.equal(canceled, true, 'reported canceled without waiting for warmup');
    assert.ok(Date.now() - t0 < 500, 'returned promptly, did not block on warmup');
});

test('explore provider warmup aborts the real pending initializer work', async () => {
    const ctrl = new AbortController();
    let initializerAborted = false;
    const pendingInit = (_providers, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
            initializerAborted = true;
            reject(signal.reason);
        }, { once: true });
    });
    const ready = ensureExploreProviderReady({ providers: { fake: { enabled: true } } }, { provider: 'fake' }, ctrl.signal, pendingInit);
    const waited = awaitExploreProviderReadyOrCancel(ready, ctrl.signal);
    ctrl.abort(new Error('ESC during provider init'));
    assert.equal(await waited, true);
    assert.equal(initializerAborted, true, 'AbortSignal reached the pending initializer');
});

test('explore provider warmup resolves to not-canceled when the caller stays active', async () => {
    const canceled = await awaitExploreProviderReadyOrCancel(Promise.resolve(), new AbortController().signal);
    assert.equal(canceled, false, 'ready to dispatch');
});

test('explore provider warmup short-circuits an already-aborted caller before awaiting init', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('already canceled'));
    let awaited = false;
    const ready = Promise.resolve().then(() => { awaited = true; });
    const canceled = await awaitExploreProviderReadyOrCancel(ready, ctrl.signal);
    assert.equal(canceled, true, 'canceled without blocking on the warmup promise');
});

test('explore provider warmup propagates a genuine init failure (not a cancel)', async () => {
    const ctrl = new AbortController(); // never aborted
    const ready = Promise.reject(new Error('provider init failed'));
    await assert.rejects(awaitExploreProviderReadyOrCancel(ready, ctrl.signal), /init failed/);
});

test('a retired shared compute success write is identity-guarded (no stale overwrite)', async () => {
    process.env.MIXDOG_EXPLORE_RESULT_CACHE = '1';
    const cache = __exploreResultCacheForTest();
    cache.clear();
    const key = 'identity-guard-success';
    const dc = deferredCompute();
    const p = runExploreCached(key, dc.fn, null);
    p.catch(() => {});
    // The compute executor runs on a microtask; let it install dc.resolve.
    await new Promise((r) => setTimeout(r, 0));
    const oldEntry = cache.get(key);
    assert.ok(oldEntry?.promise, 'pending entry stored');
    assert.equal(typeof dc.resolve, 'function', 'compute executor ran');
    // Simulate the entry having been retired + replaced by a fresh one (e.g. a
    // TTL eviction/recompute) WITHOUT touching the old in-flight compute.
    const freshEntry = { ts: Date.now(), value: undefined, sentinel: true };
    cache.set(key, freshEntry);
    // The OLD compute now resolves successfully — its success handler must NOT
    // overwrite the fresh entry (identity guard on every eventual write).
    dc.resolve('src/stale.mjs:1 — retired winner');
    await p;
    await new Promise((r) => setTimeout(r, 0)); // flush the success microtask
    assert.equal(cache.get(key), freshEntry, 'retired success write was identity-guarded');
});
