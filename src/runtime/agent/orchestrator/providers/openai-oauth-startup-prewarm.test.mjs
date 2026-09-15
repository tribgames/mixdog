import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// No credential or cache file is touched here: the reservation claim is pure
// session bookkeeping and is exercised without the constructor (which is what
// would load tokens and open a connection). The data dir is still relocated
// before the import so any incidental provider-module path resolution can only
// land in a unique temp directory, never in the operator's data dir.
const dataDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'mixdog-openai-prewarm-')));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataDir;

const {
    armStartupPrewarmReservation,
    buildStartupPrewarmSendOpts,
    claimStartupPrewarmReservation,
    codexStartupPrefixHash,
    hasStartupPrewarmReservation,
    resolveStartupPrewarmTarget,
    retireStartupPrewarmRecord,
    stampStartupPrewarmReservation,
} = await import('./openai-startup-prewarm.mjs');
const { OpenAIOAuthProvider } = await import('./openai-oauth.mjs');

const WARMUP_FLAG = 'MIXDOG_OPENAI_OAUTH_WS_WARMUP';
function withPromptWarmupFlag(t, value) {
    const previous = process.env[WARMUP_FLAG];
    process.env[WARMUP_FLAG] = value;
    t.after(() => {
        if (previous === undefined) delete process.env[WARMUP_FLAG];
        else process.env[WARMUP_FLAG] = previous;
    });
}

/**
 * Pool entry whose socket only records what the reservation lifecycle does to
 * it. releaseWebSocket runs for real against this: no network, no pool state.
 */
function fakeEntry() {
    const closes = [];
    const listeners = new Map();
    return {
        closes,
        emit(event) { listeners.get(event)?.(); },
        entry: {
            socket: {
                readyState: 1,
                close: (code, reason) => closes.push(reason),
                once: (event, fn) => { listeners.set(event, fn); },
            },
        },
    };
}

test.after(() => {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
});

function providerWithReservation(poolKey, reservation) {
    const provider = Object.create(OpenAIOAuthProvider.prototype);
    provider._startupPrewarmReadyByPoolKey = new Map();
    if (reservation) provider._startupPrewarmReadyByPoolKey.set(poolKey, reservation);
    return provider;
}

function reservation(fields) {
    const timer = setTimeout(() => {}, 60_000);
    timer.unref?.();
    return { poolKey: 's1', cacheKey: 'c1', prefixHash: 'p1', entry: { socket: null }, _reservationTimer: timer, ...fields };
}

test('a matching startup reservation is claimed once and its expiry timer released', () => {
    const handle = reservation({});
    const provider = providerWithReservation('s1', handle);

    const claimed = provider._claimStartupPrewarmHandle({ poolKey: 's1', cacheKey: 'c1', prefixHash: 'p1' });
    assert.equal(claimed, handle);
    assert.equal(handle._reservationTimer, null, 'the reservation timer must not outlive the claim');
    assert.equal(provider._startupPrewarmReadyByPoolKey.size, 0, 'a reservation is single-use');

    assert.equal(provider._claimStartupPrewarmHandle({ poolKey: 's1', cacheKey: 'c1', prefixHash: 'p1' }), null);
});

test('a reservation anchored on another prefix or cache lane is dropped, never reused', () => {
    for (const mismatch of [{ prefixHash: 'p2' }, { cacheKey: 'c2' }, { poolKey: 's2' }]) {
        // entry:null keeps the drop path off the socket pool; the contract under
        // test is that a stale anchor is never handed to the turn.
        const handle = reservation({ ...mismatch, entry: null });
        const provider = providerWithReservation('s1', handle);
        assert.equal(provider._claimStartupPrewarmHandle({ poolKey: 's1', cacheKey: 'c1', prefixHash: 'p1' }), null);
        assert.equal(handle._reservationTimer, null);
        assert.equal(provider._startupPrewarmReadyByPoolKey.size, 0);
    }
});

test('a reservation without a live socket entry is not claimable', () => {
    const handle = reservation({ entry: null });
    const provider = providerWithReservation('s1', handle);
    assert.equal(provider._claimStartupPrewarmHandle({ poolKey: 's1', cacheKey: 'c1', prefixHash: 'p1' }), null);
});

test('a session without a pool key never claims a reservation', () => {
    const provider = providerWithReservation('s1', reservation({}));
    assert.equal(provider._claimStartupPrewarmHandle({ poolKey: null, cacheKey: 'c1', prefixHash: 'p1' }), null);
    assert.equal(provider._startupPrewarmReadyByPoolKey.size, 1, 'another session\'s reservation stays put');
});

test('claiming a stale reservation hands its socket back to the pool', () => {
    const socket = fakeEntry();
    const registry = new Map();
    const handle = { poolKey: 's1', cacheKey: 'c1', prefixHash: 'stale', entry: socket.entry };
    registry.set('s1', handle);

    assert.equal(claimStartupPrewarmReservation(registry, { poolKey: 's1', cacheKey: 'c1', prefixHash: 'fresh' }), null);
    assert.equal(registry.size, 0);
    assert.deepEqual(socket.closes, ['release_no_keep'], 'a stale anchor must not keep holding a socket');
});

test('a reservation is armed with an expiry that releases the socket', async () => {
    const socket = fakeEntry();
    const registry = new Map();
    const handle = { poolKey: 's1', cacheKey: 'c1', entry: socket.entry };

    armStartupPrewarmReservation(registry, 's1', handle, { idleMs: 1 });
    assert.equal(registry.get('s1'), handle);
    assert.ok(handle._reservationTimer, 'the reservation must be time-bounded');

    await new Promise((resolve) => { setTimeout(resolve, 25); });
    assert.equal(registry.size, 0, 'an unclaimed reservation expires');
    assert.equal(handle._reservationTimer, null);
    assert.deepEqual(socket.closes, ['release_no_keep']);
});

test('a reservation whose socket closes is dropped without an expiry timer left behind', () => {
    const socket = fakeEntry();
    const registry = new Map();
    const handle = { poolKey: 's1', cacheKey: 'c1', entry: socket.entry };

    armStartupPrewarmReservation(registry, 's1', handle);
    socket.emit('close');

    assert.equal(registry.size, 0);
    assert.equal(handle._reservationTimer, null);
    assert.deepEqual(socket.closes, [], 'the socket is already gone; nothing to release');
});

test('a superseding reservation releases the one it replaces', () => {
    const first = fakeEntry();
    const second = fakeEntry();
    const registry = new Map();
    const older = { poolKey: 's1', cacheKey: 'c1', entry: first.entry };
    const newer = { poolKey: 's1', cacheKey: 'c1', entry: second.entry };

    armStartupPrewarmReservation(registry, 's1', older);
    armStartupPrewarmReservation(registry, 's1', newer);

    assert.equal(registry.get('s1'), newer);
    assert.equal(older._reservationTimer, null);
    assert.deepEqual(first.closes, ['release_no_keep'], 'the replaced reservation must not leak its socket');
    assert.deepEqual(second.closes, []);
});

test('a connection-only reservation does not satisfy a prompt prewarm', () => {
    const registry = new Map();
    assert.equal(hasStartupPrewarmReservation(registry, 's1', { promptWarmup: true }), false);

    registry.set('s1', { entry: {} });
    assert.equal(hasStartupPrewarmReservation(registry, 's1', {}), true);
    assert.equal(hasStartupPrewarmReservation(registry, 's1', { promptWarmup: true }), false);

    stampStartupPrewarmReservation(registry.get('s1'), 'p1');
    assert.equal(hasStartupPrewarmReservation(registry, 's1', { promptWarmup: true }), true);
    assert.equal(registry.get('s1').prefixHash, 'p1', 'a stamped reservation carries the prefix it warmed');
});

test('an in-flight prewarm record is retired only while it is still the current one', () => {
    const inFlight = new Map();
    const first = { promptWarmup: false, task: Promise.resolve(true) };
    const second = { promptWarmup: true, task: Promise.resolve(true) };
    inFlight.set('s1', first);

    inFlight.set('s1', second);
    retireStartupPrewarmRecord(inFlight, 's1', first);
    assert.equal(inFlight.get('s1'), second, 'a settled prewarm must not evict its successor');

    retireStartupPrewarmRecord(inFlight, 's1', second);
    assert.equal(inFlight.size, 0);
});

test('prewarm targets prefer explicit request fields over the materialized session', (t) => {
    withPromptWarmupFlag(t, '1');
    const session = {
        messages: [{ role: 'system', content: 'session' }],
        tools: [{ name: 'session-tool' }],
        model: 'session-model',
    };
    const explicit = { messages: [{ role: 'system', content: 'explicit' }], tools: [], model: 'explicit-model' };

    const fromSession = resolveStartupPrewarmTarget({ sessionId: 's1', session });
    assert.equal(fromSession.poolKey, 's1');
    assert.equal(fromSession.messages, session.messages);
    assert.equal(fromSession.tools, session.tools);
    assert.equal(fromSession.model, 'session-model');
    assert.equal(fromSession.promptWarmup, true);

    const fromOpts = resolveStartupPrewarmTarget({ sessionId: 's1', session, ...explicit });
    assert.equal(fromOpts.messages, explicit.messages);
    assert.equal(fromOpts.tools, explicit.tools);
    assert.equal(fromOpts.model, 'explicit-model');
});

test('a prewarm without a prompt, a model or the warmup flag stays connection-only', (t) => {
    withPromptWarmupFlag(t, '1');
    const session = { messages: [{ role: 'system', content: 'stable' }], model: 'gpt-5.6-sol' };

    assert.equal(resolveStartupPrewarmTarget({ sessionId: 's1', model: 'gpt-5.6-sol' }).promptWarmup, false);
    assert.equal(resolveStartupPrewarmTarget({ sessionId: 's1', messages: session.messages }).promptWarmup, false);
    assert.deepEqual(resolveStartupPrewarmTarget({ sessionId: 's1' }).tools, [], 'tools default to an empty surface');

    const target = resolveStartupPrewarmTarget({ sessionId: 's1', session });
    assert.equal(target.promptWarmup, true);
    assert.equal(target.session, session);

    // Restored by the hook withPromptWarmupFlag already registered.
    delete process.env[WARMUP_FLAG];
    assert.equal(resolveStartupPrewarmTarget({ sessionId: 's1', session }).promptWarmup, false, 'the billed prewarm is opt-in');
});

test('prewarm sendOpts carry the session dispatch identity and the prewarm markers', () => {
    const session = {
        codexWireSessionId: '019fc135-f07a-7880-8767-ec3b7be1de63',
        effort: 'xhigh',
        fast: true,
        modelParameters: { top_p: 1 },
        promptCacheKey: 'mixdog-codex',
    };
    const opts = {
        sessionId: 's1',
        session,
        messages: [{ role: 'system', content: 'stable' }],
        tools: [{ name: 'read' }],
        model: 'gpt-5.6-sol',
    };
    const sendOpts = buildStartupPrewarmSendOpts(resolveStartupPrewarmTarget(opts), opts);

    assert.equal(sendOpts.messages, undefined, 'send() takes the prompt positionally');
    assert.equal(sendOpts.tools, undefined);
    assert.equal(sendOpts.model, undefined);
    assert.equal(sendOpts.sessionId, 's1');
    assert.equal(sendOpts.session, session);
    assert.equal(sendOpts._startupPrewarmOnly, true);
    assert.equal(sendOpts.requestKind, 'prewarm');
    assert.equal(sendOpts.codexRequestKind, 'prewarm');
    assert.equal(sendOpts.codexSessionId, session.codexWireSessionId);
    assert.equal(sendOpts.codexThreadId, session.codexWireSessionId);
    assert.equal(sendOpts.threadId, session.codexWireSessionId);
    assert.equal(sendOpts.effort, 'xhigh');
    assert.equal(sendOpts.fast, true);
    assert.deepEqual(sendOpts.modelParameters, { top_p: 1 });
    assert.equal(sendOpts.promptCacheKey, 'mixdog-codex');
});

test('prewarm sendOpts keep caller overrides and omit thread ids without a codex session', () => {
    const opts = {
        sessionId: 's1',
        session: { codexWireSessionId: 'session-wire', effort: 'low', fast: true, promptCacheKey: 'session-key' },
        effort: 'medium',
        promptCacheKey: 'caller-key',
        codexSessionId: 'caller-wire',
    };
    const sendOpts = buildStartupPrewarmSendOpts(resolveStartupPrewarmTarget(opts), opts);
    assert.equal(sendOpts.effort, 'medium');
    assert.equal(sendOpts.promptCacheKey, 'caller-key');
    assert.equal(sendOpts.codexSessionId, 'caller-wire');
    assert.equal(sendOpts.codexThreadId, 'caller-wire');

    const bare = { sessionId: 's1' };
    const bareSendOpts = buildStartupPrewarmSendOpts(resolveStartupPrewarmTarget(bare), bare);
    assert.equal('codexSessionId' in bareSendOpts, false, 'no wire session id means no thread pinning');
    assert.equal('codexThreadId' in bareSendOpts, false);
    assert.equal(bareSendOpts.session, null);
    assert.equal(bareSendOpts.effort, null);
    assert.equal(bareSendOpts.fast, false);
    assert.deepEqual(bareSendOpts.modelParameters, {});
});

test('the prewarm prefix hash covers the stable prefix and ignores the live transcript', () => {
    const body = {
        model: 'gpt-5.6-sol',
        instructions: 'stable instructions',
        tools: [{ type: 'function', name: 'read' }],
        input: [{ role: 'user', content: 'first question' }],
    };
    const base = codexStartupPrefixHash(body);

    assert.equal(codexStartupPrefixHash({ ...body, input: [{ role: 'user', content: 'other' }] }), base);
    assert.notEqual(codexStartupPrefixHash({ ...body, model: 'gpt-5.6-thinking' }), base);
    assert.notEqual(codexStartupPrefixHash({ ...body, instructions: 'refreshed environment' }), base);
    assert.notEqual(codexStartupPrefixHash({ ...body, tools: [] }), base);
});
