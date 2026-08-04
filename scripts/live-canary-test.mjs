#!/usr/bin/env node
/*
 * Nightly LIVE canaries — credential-gated, SKIPPED BY DEFAULT.
 *
 * The only tests in this repo that touch a real provider endpoint. They are
 * kept out of every default suite and exposed only through
 * `npm run test:live-canary`. THREE independent gates must all pass before a
 * byte leaves the host:
 *   1. MIXDOG_LIVE_CANARY=1                       (explicit opt-in)
 *   2. a non-prompting on-disk credential probe   (per provider)
 *   3. an EXPLICIT model id in the environment    (per provider)
 * Gate 3 exists so the canary never calls `listModels()`: that call writes a
 * model-catalog cache into the plugin data dir, and a canary must be
 * zero-write. Anything unmet reports `skip` with a reason and exits clean.
 *
 * Safety contract:
 *   - `tools` is ALWAYS undefined → the model is never handed a tool schema,
 *     so no side-effecting tool can be requested or executed;
 *   - no session is created, no history is written, no catalog is refreshed;
 *     MixDog tracing/telemetry is disabled BEFORE any provider module loads;
 *   - every request runs under a watchdog AbortController and is torn down in
 *     `t.after` (abort + pooled-socket close), so no request or socket can
 *     outlive its test;
 *   - NOTHING derived from credentials or model output is logged. Failures
 *     report `name/code` only (see `shape()`) — never messages, headers,
 *     tokens, prompts, or completion text, and assertions never embed content.
 *
 * Coverage:
 *   - openai-oauth over BOTH transports (WS `ws-full`, HTTP `http-sse`) pinned
 *     per test through MIXDOG_OAI_TRANSPORT, so green means each transport was
 *     proven independently rather than whichever auto happened to pick.
 *   - anthropic-oauth mid-stream abort + continuation, mirroring the Pi live
 *     abort contract (refs/pi/packages/ai/test/abort.test.ts:100): an abort
 *     after the first streamed delta terminates the request exactly once and
 *     is never promoted to success, and the next request still succeeds.
 */

// Tracing/telemetry OFF before any provider module loads. ESM hoists the
// static imports below, so only the credential probes (pure fs reads, no
// tracing) can precede this; every provider/runtime module is imported
// dynamically inside the tests, i.e. strictly after these are applied —
// `loadProvider` re-asserts them for the same reason.
function disableTracing() {
    process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
    process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
    delete process.env.MIXDOG_DEBUG_AGENT;
    delete process.env.MIXDOG_LLM_TRACE;
}
disableTracing();

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    hasAnthropicOAuthCredentials,
    hasOpenAIOAuthCredentials,
} from '../src/runtime/agent/orchestrator/providers/oauth-credential-probes.mjs';

const LIVE = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_LIVE_CANARY || ''));
const TIMEOUT_MS = Number(process.env.MIXDOG_LIVE_CANARY_TIMEOUT_MS || 180_000);
// Watchdog per REQUEST — always shorter than the test timeout so a wedged
// stream aborts (and is asserted) instead of being cancelled by the runner.
const REQUEST_TIMEOUT_MS = Math.max(15_000, Math.floor(TIMEOUT_MS / 3));
// Read-only, side-effect-free, cheap. No tool schema is ever sent with it.
const READ_ONLY_PROMPT = 'Reply with exactly one word: canary. Do not call any tools.';
const LONG_READ_ONLY_PROMPT = 'Count slowly from 1 to 40, one number per line. Do not call any tools.';

/**
 * Skip reason (string) or false (run). Requires opt-in, credentials AND an
 * explicit model id — never probes a catalog, never reveals credential data.
 */
function gate(hasCredentials, modelEnv) {
    if (!LIVE) return 'live canary disabled (set MIXDOG_LIVE_CANARY=1)';
    if (!hasCredentials()) return 'no credentials for this provider on this host';
    if (!process.env[modelEnv]) return `no explicit model id (set ${modelEnv}=<model>)`;
    return false;
}

/** Secret-safe failure detail: class + code only, never message/response text. */
function shape(error) {
    return `${error?.name || 'Error'}/${error?.code || error?.status || 'no-code'}`;
}

async function loadProvider(name) {
    disableTracing();
    const { initProviders, getProvider } = await import(
        '../src/runtime/agent/orchestrator/providers/registry.mjs'
    );
    await initProviders({ [name]: { enabled: true } });
    const provider = getProvider(name);
    assert.ok(provider, `${name} must be registered when its credential probe passes`);
    return provider;
}

/** Watchdog-bound abort controller; the caller always disposes it. */
function watchdog(label) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(Object.assign(new Error(`${label} watchdog`), { name: 'CanaryWatchdogError' }));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    return {
        signal: controller.signal,
        firedByWatchdog: () => controller.signal.reason?.name === 'CanaryWatchdogError',
        dispose: (reason = 'canary teardown') => {
            clearTimeout(timer);
            if (!controller.signal.aborted) controller.abort(new Error(reason));
        },
        abortNow: (reason) => {
            if (!controller.signal.aborted) controller.abort(reason);
        },
        aborted: () => controller.signal.aborted,
    };
}

function withEnv(key, value, fn) {
    const prior = process.env[key];
    process.env[key] = value;
    const restore = () => {
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
    };
    return Promise.resolve().then(fn).then(
        (out) => { restore(); return out; },
        (err) => { restore(); throw err; },
    );
}

async function closeOpenAiSockets() {
    try {
        const pool = await import('../src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs');
        await pool._closeAllPooledSockets?.('live-canary-end');
    } catch { /* teardown is best-effort and never logs */ }
}

/** One terminal outcome, no tool requests, non-empty text — nothing logged. */
function assertReadOnlyTerminal(response, deltaChars, label) {
    assert.ok(response, `${label}: expected one terminal response`);
    const content = typeof response.content === 'string' ? response.content : '';
    assert.ok(content.trim().length > 0, `${label}: terminal response carried no text`);
    assert.ok(
        !Array.isArray(response.toolCalls) || response.toolCalls.length === 0,
        `${label}: a tool-free canary must never come back with tool calls`,
    );
    assert.ok(deltaChars >= 0, `${label}: delta accounting broken`);
}

for (const [label, transport] of [['websocket', 'ws-full'], ['http-sse', 'http-sse']]) {
    test(`live canary — openai-oauth ${label} read-only turn`, {
        skip: gate(hasOpenAIOAuthCredentials, 'MIXDOG_LIVE_CANARY_OPENAI_MODEL'),
        timeout: TIMEOUT_MS,
    }, async (t) => {
        const model = process.env.MIXDOG_LIVE_CANARY_OPENAI_MODEL;
        const provider = await loadProvider('openai-oauth');
        const guard = watchdog(`openai-oauth ${label}`);
        t.after(async () => {
            guard.dispose();
            await closeOpenAiSockets();
        });

        let deltaChars = 0;
        const response = await withEnv('MIXDOG_OAI_TRANSPORT', transport, () => provider.send(
            [{ role: 'user', content: READ_ONLY_PROMPT }],
            model,
            undefined, // no tool schema is ever sent — no side effects possible
            {
                sessionId: `live-canary-${transport}`,
                signal: guard.signal,
                onTextDelta: (chunk) => { deltaChars += String(chunk ?? '').length; },
            },
        )).catch((err) => {
            throw new Error(`openai-oauth ${label} canary failed: ${shape(err)}`
                + (guard.firedByWatchdog() ? ' (request watchdog fired)' : ''));
        });
        assertReadOnlyTerminal(response, deltaChars, `openai-oauth ${label}`);
    });
}

test('live canary — anthropic-oauth mid-stream abort then continuation', {
    skip: gate(hasAnthropicOAuthCredentials, 'MIXDOG_LIVE_CANARY_ANTHROPIC_MODEL'),
    timeout: TIMEOUT_MS,
}, async (t) => {
    const model = process.env.MIXDOG_LIVE_CANARY_ANTHROPIC_MODEL;
    const provider = await loadProvider('anthropic-oauth');
    const abortGuard = watchdog('anthropic-oauth abort');
    const continueGuard = watchdog('anthropic-oauth continuation');
    t.after(() => {
        abortGuard.dispose();
        continueGuard.dispose();
    });

    // Pi parity (refs/pi/packages/ai/test/abort.test.ts:100): abort once the
    // stream is demonstrably live, then assert exactly one terminal outcome.
    const cancel = Object.assign(new Error('live canary abort'), { name: 'CanaryAbortError' });
    let streamedChars = 0;
    const aborting = provider.send(
        [{ role: 'user', content: LONG_READ_ONLY_PROMPT }],
        model,
        undefined,
        {
            sessionId: 'live-canary-anthropic-abort',
            signal: abortGuard.signal,
            onTextDelta: (chunk) => {
                streamedChars += String(chunk ?? '').length;
                if (streamedChars > 0) abortGuard.abortNow(cancel);
            },
        },
    );
    let promoted = null;
    let aborted = null;
    await aborting.then((value) => { promoted = value; }, (err) => { aborted = err; });
    assert.equal(promoted, null, `abort must not be promoted to success (${shape(aborted)})`);
    assert.ok(aborted, 'abort must surface a terminal error');
    assert.equal(abortGuard.aborted(), true);
    assert.equal(
        abortGuard.firedByWatchdog(),
        false,
        'the abort must come from the canary, not from the request watchdog',
    );
    assert.ok(streamedChars > 0, 'the abort must happen mid-stream, after live output');

    // Continuation: the same provider still serves a fresh read-only turn
    // after the abort (no wedged socket, no poisoned auth/pool state).
    let deltaChars = 0;
    const response = await provider.send(
        [{ role: 'user', content: READ_ONLY_PROMPT }],
        model,
        undefined,
        {
            sessionId: 'live-canary-anthropic-continue',
            signal: continueGuard.signal,
            onTextDelta: (chunk) => { deltaChars += String(chunk ?? '').length; },
        },
    ).catch((err) => {
        throw new Error(`anthropic-oauth continuation failed: ${shape(err)}`
            + (continueGuard.firedByWatchdog() ? ' (request watchdog fired)' : ''));
    });
    assertReadOnlyTerminal(response, deltaChars, 'anthropic-oauth continuation');
});
