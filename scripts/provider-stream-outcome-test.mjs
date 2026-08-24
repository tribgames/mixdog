// provider-stream-outcome-test.mjs — canonical provider stream outcome /
// safety contract (src/runtime/agent/orchestrator/providers/lib/stream-outcome.mjs)
// and its consumers: retry classification, mid-stream classifiers, transport
// fallback, withRetry, and send-with-recovery.
//
// Contract under test:
//   - terminal observed vs continuation are distinguished and mutually exclusive
//   - partial text/reasoning observed is distinguished from VISIBLE (relayed) output
//   - partial vs complete vs dispatched tool calls are distinguished
//   - success requires an EXPLICIT terminal stream event
//   - the only replay deny is visible output / dispatched-or-ambiguous tool
//     calls; every other retry decision is the typed one (retry-classifier)
//   - compatibility aliases (liveTextEmitted / emittedText / emittedToolCall /
//     toolCallEmitted / partialToolCall / emittedThinking / pendingToolUse /
//     unsafeToRetry) keep working, INCLUDING the provider-specific legacy-flag
//     gap class (Anthropic errors that carry only partialContent).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    readStreamOutcome,
    stampStreamOutcome,
    isReplaySafe,
    isReplayUnsafe,
    canPromoteToSuccess,
    hasObservedOutput,
    hasDispatchedToolCalls,
    STREAM_TRANSPORTS,
} from '../src/runtime/agent/orchestrator/providers/lib/stream-outcome.mjs';
import {
    classifyError,
    classifyMidstreamError,
    shouldFallbackTransport,
    withRetry,
    retryAfterMsFromError,
    shouldDropPreviousResponseId,
    classifyHandshakeError,
    isContextOverflowError,
    createStallRetryBudget,
    isProviderRecoveryExhausted,
    markProviderRecoveryExhausted,
    resetStallRetryBudget,
    resolveStallRetryBudget,
} from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import { parseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-sse.mjs';
import { consumeGeminiRestStreamResponse } from '../src/runtime/agent/orchestrator/providers/gemini-stream.mjs';
import { stampAnthropicStreamOutcome } from '../src/runtime/agent/orchestrator/providers/anthropic-sse.mjs';
import { consumeCompatChatCompletionStream } from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import { consumeCompatResponsesStream } from '../src/runtime/agent/orchestrator/providers/openai-compat-stream.mjs';
import { AnthropicProvider } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { AnthropicOAuthProvider } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';
import { ProviderAdmissionScheduler } from '../src/runtime/agent/orchestrator/providers/admission-scheduler.mjs';
import { sendViaHttpSse } from '../src/runtime/agent/orchestrator/providers/openai-oauth-http-sse.mjs';
import { sendWithRecovery } from '../src/runtime/agent/orchestrator/session/send-with-recovery.mjs';

const WS_POLICY = { mode: 'ws', transientCloseRetries: 5, defaultRetries: 5 };
const SSE_POLICY = { mode: 'sse', defaultRetries: 3, perClassifierGate: false };

const err = (message, props = {}) => Object.assign(new Error(message), props);

test('transport recovery budget is shared across one logical send', () => {
    const opts = {};
    const first = resolveStallRetryBudget(opts);
    const second = resolveStallRetryBudget(opts);
    assert.equal(second, first);

    let now = 1_000;
    const budget = createStallRetryBudget(100, () => now);
    assert.equal(budget.allowStallRetry(), true);
    now = 1_101;
    assert.equal(budget.allowStallRetry(), false);
});

// ── Transport fixtures: the EXACT record each transport stamps ──────────────
// openai-ws-stream.mjs finish(), openai-oauth-http-sse.mjs catch,
// anthropic-sse.mjs _attachStallPartial / truncated guard.
function wsError(overrides = {}) {
    const e = err('WS stream: semantic idle');
    stampStreamOutcome(e, {
        transport: STREAM_TRANSPORTS.WS,
        provider: 'openai-responses',
        terminalObserved: false,
        continuation: true,
        textEmitted: false,
        textObservedChars: 0,
        reasoningEmitted: false,
        toolCallsStarted: false,
        toolCallsComplete: 0,
        toolCallsDispatched: 0,
        pendingToolInput: false,
        stallObserved: true,
        ...overrides,
    });
    return e;
}
function httpSseError(overrides = {}) {
    const e = err('OpenAI OAuth HTTP fallback stream failed');
    stampStreamOutcome(e, {
        transport: STREAM_TRANSPORTS.HTTP_SSE,
        provider: 'openai-responses',
        terminalObserved: false,
        continuation: true,
        ...overrides,
    });
    return e;
}

test('schema: an error with no exposure evidence stays replayable (typed rules decide)', () => {
    const o = readStreamOutcome(err('boom'));
    assert.equal(o.version, 1);
    assert.equal(o.terminalObserved, false);
    assert.equal(o.continuation, false);
    assert.equal(o.replayUnsafe, false, 'no positive exposure evidence');
    assert.equal(o.replaySafe, true, 'replay permission is not the retry decision');
    assert.equal(o.successEligible, false, 'no terminal event was observed');
    assert.equal(o.observedOutput, false);
    assert.equal(o.transport, 'unknown');
    assert.equal(isReplaySafe(err('boom')), true);
});

test('schema: terminal clears continuation for stall signals', () => {
    const o = readStreamOutcome(err('done', { sawCompleted: true, streamStalled: true }));
    assert.equal(o.terminalObserved, true);
    assert.equal(o.continuation, false);
    assert.equal(o.successEligible, true);
});

test('schema: a terminal frame declaring end_turn=false stays a continuation', () => {
    const o = readStreamOutcome(err('sample', { sawCompleted: true, endTurn: false }));
    assert.equal(o.terminalObserved, true, 'the sample frame WAS terminal');
    assert.equal(o.continuation, true, 'but the same user turn continues');
    assert.equal(o.declaredContinuation, true);
    assert.equal(o.successEligible, false, 'a declared continuation is never a finished turn');
    // Explicit marker form (non-Responses transports).
    const marked = readStreamOutcome({ sawCompleted: true, continuationDeclared: true });
    assert.equal(marked.continuation, true);
    assert.equal(marked.successEligible, false);
});

test('schema: terminal with pending tool input is never success-eligible', () => {
    const o = readStreamOutcome(err('done', { sawCompleted: true, pendingToolUse: true }));
    assert.equal(o.terminalObserved, true);
    assert.equal(o.pendingToolInput, true);
    assert.equal(o.successEligible, false);
    assert.equal(canPromoteToSuccess(err('x', { sawCompleted: true, pendingToolUse: true })), false);
});

test('schema: observed (buffered) text is distinguished from visible text', () => {
    const o = readStreamOutcome(err('stalled', { streamStalled: true, partialContent: 'half a sentence' }));
    assert.equal(o.textObservedChars, 'half a sentence'.length);
    assert.equal(o.textEmitted, false);
    assert.equal(o.visibleOutput, false);
    assert.equal(o.observedOutput, true, 'buffered text is observed output (persistence must keep it)');
    assert.equal(o.continuation, true);
    assert.equal(o.replayUnsafe, false, 'never-relayed text is not a visibility boundary');
    assert.equal(o.replaySafe, true, 'nothing was shown, so a replay duplicates nothing');
});

test('schema: visible text / reasoning / dispatched tools are replay boundaries', () => {
    assert.equal(isReplaySafe(err('a', { liveTextEmitted: true })), false);
    assert.equal(isReplaySafe(err('b', { emittedText: true })), false);
    assert.equal(isReplaySafe(err('c', { emittedThinking: true })), false);
    assert.equal(isReplaySafe(err('d', { emittedReasoning: true })), false);
    assert.equal(isReplaySafe(err('e', { partialReasoningEmitted: true })), false);
    assert.equal(isReplaySafe(err('f', { emittedToolCall: true })), false);
    assert.equal(isReplaySafe(err('g', { toolCallEmitted: true })), false);
    assert.equal(isReplaySafe(err('k', { unsafeToRetry: true })), false);
    assert.equal(isReplaySafe(err('l', { partialToolCalls: [{ id: '1', name: 'x' }] })), false);
    // A tool input that merely STARTED was never dispatched: re-requesting it
    // is idempotent.
    assert.equal(isReplaySafe(err('h', { partialToolCall: true })), true);
    assert.equal(isReplaySafe(err('i', { startedToolCall: true })), true);
    assert.equal(isReplaySafe(err('j', { partialToolCallStarted: true })), true);
});

test('schema: complete tool calls without a dispatch report fail closed to dispatched', () => {
    const o = readStreamOutcome(err('stalled', {
        streamStalled: true,
        partialToolCalls: [{ id: '1', name: 'write' }, { id: '2', name: 'bash' }],
    }));
    assert.equal(o.toolCallsComplete, 2);
    assert.equal(o.toolCallsDispatched, 2);
    assert.equal(o.dispatchAmbiguous, true);
    assert.equal(o.sideEffectDispatched, true);
    assert.equal(hasDispatchedToolCalls(o), true);
    assert.equal(o.replaySafe, false);
});

test('schema: pending tool input alone stays replay-safe (truncated stream is idempotent)', () => {
    const o = readStreamOutcome(err('truncated', {
        truncatedStream: true, code: 'TRUNCATED_STREAM', pendingToolUse: true,
    }));
    assert.equal(o.truncatedStream, true);
    assert.equal(o.continuation, true);
    assert.equal(o.pendingToolInput, true);
    assert.equal(o.toolCallsDispatched, 0);
    assert.equal(o.replayUnsafe, false);
    assert.equal(isReplayUnsafe(o), false);
    assert.equal(classifyError(err('truncated', {
        truncatedStream: true, code: 'TRUNCATED_STREAM', pendingToolUse: true,
    })), 'transient');
    assert.equal(o.replaySafe, true, 'nothing was dispatched: the replay is idempotent');
});

test('schema: dispatchAmbiguous survives canonical round-trips', () => {
    const first = err('stalled', {
        streamStalled: true,
        partialToolCalls: [{ id: '1', name: 'bash' }],
    });
    const o1 = stampStreamOutcome(first, { transport: STREAM_TRANSPORTS.SSE });
    assert.equal(o1.dispatchAmbiguous, true);
    assert.equal(o1.toolCallsDispatched, 1);
    // Re-read the stamped record: a reported dispatch count must not erase the
    // ambiguity that produced it.
    const o2 = readStreamOutcome(first);
    assert.equal(o2.dispatchAmbiguous, true);
    assert.equal(o2.replayUnsafe, true);
    // Carry the record onto another error (transport fallback / rethrow path).
    const carried = err('wrapped', { streamOutcome: o2 });
    const o3 = readStreamOutcome(carried);
    assert.equal(o3.dispatchAmbiguous, true);
    assert.equal(o3.replaySafe, false);
    const o4 = stampStreamOutcome(err('rewrapped'), o3);
    assert.equal(o4.dispatchAmbiguous, true);
    assert.equal(o4.replaySafe, false);
});

test('compat: stamping writes every historical alias without clearing set ones', () => {
    const e = err('stall');
    const o = stampStreamOutcome(e, {
        textEmitted: true,
        reasoningEmitted: true,
        toolCallsComplete: 1,
        toolCallsDispatched: 1,
        pendingToolInput: true,
        truncatedStream: true,
    });
    assert.equal(e.liveTextEmitted, true);
    assert.equal(e.emittedText, true);
    assert.equal(e.emittedThinking, true);
    assert.equal(e.emittedToolCall, true);
    assert.equal(e.toolCallEmitted, true);
    assert.equal(e.partialToolCall, true);
    assert.equal(e.pendingToolUse, true);
    assert.equal(e.truncatedStream, true);
    assert.equal(e.unsafeToRetry, true);
    assert.equal(e.streamOutcome.version, 1);
    assert.equal(o.replaySafe, false);
    // Re-stamping a cleaner view never downgrades an already-set boundary.
    stampStreamOutcome(e, { textEmitted: false, toolCallsDispatched: 0 });
    assert.equal(e.liveTextEmitted, true);
    assert.equal(e.emittedToolCall, true);
    assert.equal(e.streamOutcome.replaySafe, false);
});

// ── Consumers: retry classification / mid-stream / transport fallback ───────

test('classifyError: a record-only error (no legacy flags) is permanent', () => {
    const e = wsError({ textEmitted: true });
    delete e.liveTextEmitted; delete e.emittedText; delete e.unsafeToRetry;
    assert.equal(classifyError(e), 'permanent');
});

test('classifyError: clean continuation keeps its transport classification', () => {
    const e = wsError({ stallObserved: true });
    e.code = 'ECONNRESET';
    assert.equal(classifyError(e), 'transient');
});

test('midstream WS: terminal observed and unsafe outcomes are terminal (null)', () => {
    assert.equal(classifyMidstreamError(err('x', { wsCloseCode: 1006 }),
        { attemptIndex: 0, sawResponseCreated: true, sawCompleted: true }, WS_POLICY), null);
    assert.equal(classifyMidstreamError(err('x', { wsCloseCode: 1006 }),
        { attemptIndex: 0, sawResponseCreated: true, emittedText: true }, WS_POLICY), null);
    assert.equal(classifyMidstreamError(err('x', { wsCloseCode: 1006 }),
        { attemptIndex: 0, sawResponseCreated: true, emittedToolCall: true }, WS_POLICY), null);
    assert.equal(classifyMidstreamError(err('x', { wsCloseCode: 1006 }),
        { attemptIndex: 0, sawResponseCreated: true, emittedReasoning: true }, WS_POLICY), null);
    // Record-only (legacy flags absent) still denies.
    const recordOnly = wsError({ textEmitted: true });
    delete recordOnly.liveTextEmitted; delete recordOnly.emittedText; delete recordOnly.unsafeToRetry;
    recordOnly.wsCloseCode = 1006;
    assert.equal(classifyMidstreamError(recordOnly,
        { attemptIndex: 0, sawResponseCreated: true }, WS_POLICY), null);
});

test('midstream WS: clean pre-output failures still classify + retry', () => {
    assert.equal(classifyMidstreamError(err('x', { wsCloseCode: 1006 }),
        { attemptIndex: 0, sawResponseCreated: true }, WS_POLICY), 'ws_1006');
    assert.equal(classifyMidstreamError(err('x', { name: 'StreamStalledError' }),
        { attemptIndex: 0, sawResponseCreated: true }, WS_POLICY), 'stream_stalled');
    assert.equal(classifyMidstreamError(err('x', { firstByteTimeout: true }),
        { attemptIndex: 0 }, WS_POLICY), 'first_byte_timeout');
    // A tool input that started but never completed was never dispatched.
    assert.equal(classifyMidstreamError(err('x', { wsCloseCode: 1006 }),
        { attemptIndex: 0, sawResponseCreated: true, partialToolCall: true }, WS_POLICY), 'ws_1006');
});

test('midstream SSE: outcome gate mirrors the WS gate', () => {
    assert.equal(classifyMidstreamError(err('x', { httpStatus: 503 }),
        { attemptIndex: 0, sawCompleted: true }, SSE_POLICY), null);
    assert.equal(classifyMidstreamError(err('x', { httpStatus: 503 }),
        { attemptIndex: 0, emittedThinking: true }, SSE_POLICY), null);
    assert.equal(classifyMidstreamError(err('x', { httpStatus: 503 }),
        { attemptIndex: 0, emittedToolCall: true }, SSE_POLICY), null);
    assert.equal(classifyMidstreamError(err('x', { httpStatus: 503 }),
        { attemptIndex: 0 }, SSE_POLICY), 'http_503');
    // Stall after a dispatched tool: terminal, never a mid-stream replay.
    const stalled = err('stalled', { streamStalled: true, partialToolCalls: [{ id: '1', name: 'bash' }] });
    assert.equal(classifyMidstreamError(stalled, { attemptIndex: 0 }, SSE_POLICY), null);
});

test('transport fallback: replay-unsafe outcomes never switch transport', () => {
    assert.equal(shouldFallbackTransport(wsError({ wsCloseCode: 1006 })), false,
        'a stalled WS record with no status/errno/classifier is not fallback-eligible');
    const clean = wsError();
    clean.retryClassifier = 'ws_1006';
    assert.equal(shouldFallbackTransport(clean), true);
    const visible = wsError({ textEmitted: true });
    visible.retryClassifier = 'ws_1006';
    assert.equal(shouldFallbackTransport(visible), false);
    const dispatched = wsError({ toolCallsComplete: 1, toolCallsDispatched: 1 });
    dispatched.retryClassifier = 'stream_stalled';
    assert.equal(shouldFallbackTransport(dispatched), false);
    const recordOnly = httpSseError({ reasoningEmitted: true });
    delete recordOnly.emittedThinking; delete recordOnly.unsafeToRetry;
    recordOnly.httpStatus = 503;
    assert.equal(shouldFallbackTransport(recordOnly), false,
        'reasoning exposure denies fallback even with a retryable status');
});

test('withRetry: never replays a request whose outcome is not replay-safe', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => {
        calls += 1;
        // Retryable status + dispatched tool call: the outcome contract wins.
        const e = httpSseError({ toolCallsComplete: 1, toolCallsDispatched: 1 });
        e.httpStatus = 503;
        delete e.emittedToolCall; delete e.toolCallEmitted; delete e.unsafeToRetry;
        throw e;
    }, { maxAttempts: 3, backoffMs: [0, 0, 0] }));
    assert.equal(calls, 1);
});

test('withRetry: a clean transient continuation still retries', async () => {
    let calls = 0;
    const retries = [];
    const out = await withRetry(async () => {
        calls += 1;
        if (calls < 2) {
            const e = httpSseError();
            e.httpStatus = 503;
            throw e;
        }
        return 'ok';
    }, {
        maxAttempts: 3,
        backoffMs: [0, 0, 0],
        onRetry: (info) => retries.push(info),
    });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].maxAttempts, 3);
});

test('withRetry: retry exhaustion is provider-terminal, while a one-shot failure is not', async () => {
    let exhaustedCalls = 0;
    const exhausted = await withRetry(async () => {
        exhaustedCalls += 1;
        throw err('connection reset', { code: 'ECONNRESET' });
    }, {
        maxAttempts: 3,
        backoffMs: [0, 0, 0],
        recoveryOwner: 'test-provider',
    }).then(() => null, (error) => error);
    assert.equal(exhaustedCalls, 3);
    assert.equal(isProviderRecoveryExhausted(exhausted), true);
    assert.equal(exhausted.providerRecoveryOwner, 'test-provider');
    assert.equal(exhausted.providerRecoveryAttempts, 3);

    let oneShotCalls = 0;
    const oneShot = await withRetry(async () => {
        oneShotCalls += 1;
        throw err('connection reset', { code: 'ECONNRESET' });
    }, {
        maxAttempts: 1,
        backoffMs: [0],
    }).then(() => null, (error) => error);
    assert.equal(oneShotCalls, 1);
    assert.equal(isProviderRecoveryExhausted(oneShot), false);
});

test('withRetry: a nested provider-terminal failure is never retried again', async () => {
    let calls = 0;
    const terminal = markProviderRecoveryExhausted(
        err('provider retries spent', { code: 'ECONNRESET' }),
        { owner: 'inner-provider', attempts: 5 },
    );
    const thrown = await withRetry(async () => {
        calls += 1;
        throw terminal;
    }, {
        maxAttempts: 4,
        backoffMs: [0, 0, 0, 0],
    }).then(() => null, (error) => error);
    assert.equal(thrown, terminal);
    assert.equal(calls, 1);
});

test('withRetry: a typed transient failure retries; an untyped one does not', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
        calls += 1;
        if (calls === 1) throw err('socket hang up', { code: 'ECONNRESET' });
        return 'ok';
    }, { maxAttempts: 4, backoffMs: [0, 0, 0, 0] });
    assert.equal(out, 'ok');
    assert.equal(calls, 2, 'a known transient errno is retried, as in Codex');

    // Untyped / unknown failure: no status, no errno, no record — an error,
    // never a blanket retry.
    let unknownCalls = 0;
    await assert.rejects(withRetry(async () => {
        unknownCalls += 1;
        throw err('something went sideways');
    }, { maxAttempts: 4, backoffMs: [0, 0, 0, 0] }));
    assert.equal(unknownCalls, 1);
    assert.equal(classifyError(err('something went sideways')), 'unknown');
});

test('transport fallback: typed transport failures switch, untyped ones do not', () => {
    assert.equal(shouldFallbackTransport(err('socket hang up', { code: 'ECONNRESET' })), true);
    assert.equal(shouldFallbackTransport(err('something went sideways')), false);
});

// ── Anthropic SSE transport: real parser, real truncation ───────────────────

const encoder = new TextEncoder();
const frame = (e) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
function eofResponse(events) {
    const chunks = events.map(frame);
    let i = 0;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
                        return Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}
function delayedResponse(steps) {
    let i = 0;
    return {
        body: {
            getReader() {
                return {
                    async read() {
                        const step = steps[i++] ?? { done: true };
                        if (step.delayMs > 0) {
                            await new Promise((resolve) => setTimeout(resolve, step.delayMs));
                        }
                        if (step.done) return { done: true, value: undefined };
                        return { done: false, value: step.value };
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}
const anthropicState = () => ({
    attemptIndex: 0,
    sawMessageStart: false,
    sawCompleted: false,
    emittedToolCall: false,
    partialToolCall: false,
    emittedThinking: false,
    emittedText: false,
    userAbort: false,
    watchdogAbort: null,
    firstMessageTimeoutMs: 5000,
    semanticIdleTimeoutMs: 5000,
    transportIdleWatchdogEnabled: true,
});

test('anthropic SSE: comment and named ping keepalives refresh transport activity', async () => {
    const state = {
        ...anthropicState(),
        firstMessageTimeoutMs: 200,
        transportIdleTimeoutMs: 25,
    };
    const response = delayedResponse([
        { value: frame({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } }) },
        { delayMs: 15, value: encoder.encode(': ping\n\n') },
        { delayMs: 15, value: frame({ type: 'ping' }) },
        { delayMs: 15, value: frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) },
        { value: frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }) },
        { value: frame({ type: 'content_block_stop', index: 0 }) },
        { value: frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }) },
        { value: frame({ type: 'message_stop' }) },
        { done: true },
    ]);
    const activity = [];
    const result = await parseSSEStream(
        response, null, () => {}, (kind) => activity.push(kind), () => {}, state, () => {},
    );
    assert.equal(result.content, 'done');
    assert.ok(activity.filter((kind) => kind === 'transport').length >= 4);
});

test('anthropic SSE: actual transport silence still raises a stall', async () => {
    const state = {
        ...anthropicState(),
        firstMessageTimeoutMs: 200,
        transportIdleTimeoutMs: 15,
    };
    const response = delayedResponse([
        { value: frame({ type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } }) },
        { delayMs: 40, done: true },
    ]);
    const thrown = await parseSSEStream(
        response, null, () => {}, () => {}, () => {}, state, () => {},
    ).then(() => null, (error) => error);
    assert.equal(thrown?.code, 'ESTREAMSTALL');
    assert.equal(thrown?.streamOutcome?.stallObserved, true);
});

test('anthropic SSE: truncation after visible text is a continuation, never replayable', async () => {
    const state = anthropicState();
    const response = eofResponse([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } },
    ]);
    let seen = '';
    const thrown = await parseSSEStream(
        response, null, () => {}, () => {}, () => {}, state, (t) => { seen += t; },
    ).then(() => null, (e) => e);
    assert.ok(thrown, 'truncated stream must throw');
    assert.equal(seen, 'partial answer');
    assert.equal(thrown.code, 'TRUNCATED_STREAM');
    const o = thrown.streamOutcome;
    assert.ok(o, 'transport must stamp the canonical record');
    assert.equal(o.transport, STREAM_TRANSPORTS.SSE);
    assert.equal(o.terminalObserved, false);
    assert.equal(o.continuation, true);
    assert.equal(o.truncatedStream, true);
    assert.equal(o.textEmitted, true);
    assert.equal(o.observedOutput, true);
    assert.equal(o.successEligible, false);
    assert.equal(o.replaySafe, false);
    assert.equal(classifyError(thrown), 'permanent');
    assert.equal(shouldFallbackTransport(thrown), false);
    // Compatibility aliases the legacy readers still consult.
    assert.equal(thrown.liveTextEmitted, true);
    assert.equal(thrown.unsafeToRetry, true);
});

test('anthropic SSE: truncation with only a pending tool input stays retryable', async () => {
    const state = anthropicState();
    const response = eofResponse([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
    ]);
    const thrown = await parseSSEStream(
        response, null, () => {}, () => {}, () => {}, state, () => {},
    ).then(() => null, (e) => e);
    assert.ok(thrown);
    const o = thrown.streamOutcome;
    assert.equal(o.pendingToolInput, true);
    assert.equal(o.toolCallsDispatched, 0);
    assert.equal(o.toolCallsComplete, 0);
    assert.equal(o.terminalObserved, false);
    assert.equal(o.replaySafe, true, 'a tool input that never completed was never dispatched');
    assert.equal(classifyError(thrown), 'transient');
});

// ── Anthropic SSE: a TERMINAL frame while tool input is still in flight ─────
// message_stop / a tool_use stop_reason must not finish a turn whose tool
// arguments never completed: no success, no partial-success promotion, zero
// dispatch for the incomplete call.

async function parseFrames(events, { onToolCall = () => {}, onTextDelta = () => {} } = {}) {
    const state = anthropicState();
    const outcome = await parseSSEStream(
        // (response, signal, abortStream, onStreamDelta, onToolCall, state, onTextDelta)
        eofResponse(events), null, () => {}, () => {}, onToolCall, state, onTextDelta,
    ).then((result) => ({ result, state }), (error) => ({ error, state }));
    return outcome;
}

test('anthropic SSE: message_stop with an incomplete CLIENT tool input is a truncated failure', async () => {
    const dispatched = [];
    const { result, error, state } = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_pending', name: 'read' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ], { onToolCall: (c) => dispatched.push(c) });

    assert.equal(result, undefined, 'no partial-success promotion');
    assert.equal(error?.name, 'TruncatedStreamError');
    assert.equal(error.code, 'TRUNCATED_STREAM');
    assert.equal(error.pendingToolUse, true);
    assert.match(error.message, /terminal frame with incomplete tool input/);
    assert.equal(dispatched.length, 0, 'an incomplete tool call must never dispatch');
    assert.equal(state.sawCompleted, false, 'a terminal frame does not complete this turn');
    const o = error.streamOutcome;
    assert.equal(o.terminalObserved, false);
    assert.equal(o.continuation, true);
    assert.equal(o.pendingToolInput, true);
    assert.equal(o.toolCallsComplete, 0);
    assert.equal(o.toolCallsDispatched, 0);
    assert.equal(o.sideEffectDispatched, false);
    assert.equal(o.successEligible, false);
    assert.equal(o.replayUnsafe, false, 'nothing was dispatched: re-requesting stays idempotent');
    assert.equal(o.replaySafe, true);
    assert.equal(classifyError(error), 'transient');
});

test('anthropic SSE: message_stop with an incomplete NATIVE server-tool input is a truncated failure', async () => {
    const dispatched = [];
    const { result, error, state } = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
        { type: 'message_stop' },
    ], { onToolCall: (c) => dispatched.push(c) });

    assert.equal(result, undefined);
    assert.equal(error?.code, 'TRUNCATED_STREAM');
    assert.equal(error.pendingToolUse, true);
    assert.equal(dispatched.length, 0);
    assert.equal(state.sawCompleted, false);
    assert.equal(error.streamOutcome.pendingToolInput, true);
    assert.equal(error.streamOutcome.successEligible, false);
});

test('anthropic SSE: completed tools and plain terminals keep succeeding', async () => {
    const dispatched = [];
    const { result, error, state } = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_ok', name: 'read' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ], { onToolCall: (c) => dispatched.push(c) });
    assert.equal(error, undefined, 'a completed tool call still finishes the turn');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, 'toolu_ok');
    assert.equal(dispatched.length, 1);
    assert.equal(state.sawCompleted, true);
    assert.equal(canPromoteToSuccess({ sawCompleted: true }), true);

    const textTurn = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ]);
    assert.equal(textTurn.error, undefined);
    assert.equal(textTurn.result.content, 'done');
    assert.equal(textTurn.state.sawCompleted, true);

    // A completed NATIVE server-tool block also stays a normal terminal turn.
    const nativeTurn = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ]);
    assert.equal(nativeTurn.error, undefined);
    assert.equal(nativeTurn.state.sawCompleted, true);
    assert.equal(nativeTurn.result.assistantBlocks?.length, 1);
});

test('anthropic SSE: a terminal message_delta stop_reason truncates IMMEDIATELY', async () => {
    // Frames after the terminal stop_reason must never be consumed: the turn is
    // already truncated (tool input incomplete), so late text/tool frames can
    // neither reach the UI nor dispatch.
    const events = [
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_p', name: 'read' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
        // Late frames — must not be pulled/processed.
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"late"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_stop' },
    ];
    let delivered = 0;
    const chunks = events.map((e) => encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    const response = {
        body: {
            getReader() {
                return {
                    read() {
                        if (delivered < chunks.length) return Promise.resolve({ done: false, value: chunks[delivered++] });
                        return Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
    const dispatched = [];
    const state = anthropicState();
    const thrown = await parseSSEStream(
        response, null, () => {}, () => {}, (c) => dispatched.push(c), state, () => {},
    ).then(() => null, (e) => e);

    assert.ok(thrown, 'a terminal stop_reason with in-flight tool input must fail');
    assert.equal(thrown.code, 'TRUNCATED_STREAM');
    assert.equal(thrown.pendingToolUse, true);
    assert.equal(dispatched.length, 0);
    assert.equal(state.sawCompleted, false);
    assert.equal(delivered, 4, 'the parser stopped at the terminal frame, before the late frames');
    assert.equal(thrown.streamOutcome.replaySafe, true, 'nothing dispatched: replay stays idempotent');
});

test('anthropic SSE: truncation preserves completed ordered native assistantBlocks', async () => {
    const { error } = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'searching' } },
        { type: 'content_block_stop', index: 0 },
        {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } },
        { type: 'content_block_stop', index: 1 },
        {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        },
        { type: 'content_block_stop', index: 2 },
        // A client tool_use whose input never completes cuts the turn off.
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_p', name: 'read' } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
        { type: 'message_stop' },
    ]);

    assert.equal(error?.code, 'TRUNCATED_STREAM');
    assert.equal(error.pendingToolUse, true);
    const blocks = error.partialAssistantBlocks;
    assert.ok(Array.isArray(blocks), 'completed native blocks must survive truncation');
    assert.deepEqual(blocks.map((b) => b.type), ['text', 'server_tool_use', 'web_search_tool_result']);
    assert.equal(blocks[1].input.query, 'x');
    assert.equal(error.partialContent, 'searching');
    assert.equal(error.streamOutcome.pendingToolInput, true);
    assert.equal(error.streamOutcome.successEligible, false);
});

test('anthropic wrappers: neither round-trip downgrades the parser pending-input verdict', async () => {
    for (const provider of ['anthropic', 'anthropic-oauth']) {
        const { error } = await parseFrames([
            { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_p', name: 'read' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
            { type: 'message_stop' },
        ]);
        assert.equal(error.streamOutcome.replaySafe, true);

        // The wrapper's coarse midState says "a tool block started" — the parser
        // already knows it never completed and was never dispatched.
        const midState = {
            sawMessageStart: true,
            sawCompleted: false,
            partialToolCall: true,
            emittedToolCall: false,
            emittedThinking: false,
            emittedText: false,
        };
        const merged = stampAnthropicStreamOutcome(error, midState, { provider });
        assert.equal(merged.pendingToolInput, true);
        assert.equal(merged.toolCallsDispatched, 0);
        assert.equal(merged.toolCallsStarted, false, `${provider}: coarse partialToolCall must not override`);
        assert.equal(merged.replaySafe, true, `${provider}: incomplete undispatched input stays replay-safe`);
        assert.equal(error.unsafeToRetry, undefined);

        // Genuinely new exposure evidence IS merged.
        const exposed = stampAnthropicStreamOutcome(error, { ...midState, emittedText: true }, { provider });
        assert.equal(exposed.textEmitted, true);
        assert.equal(exposed.replaySafe, false);
    }
});

// ── OpenAI-compatible Chat streaming: reasoning exposure blocks any replay ──

function compatChatStream(chunks, failure) {
    return {
        [Symbol.asyncIterator]() {
            let i = 0;
            return {
                async next() {
                    if (i < chunks.length) return { value: chunks[i++], done: false };
                    if (failure) throw failure;
                    return { value: undefined, done: true };
                },
                async return() { return { value: undefined, done: true }; },
            };
        },
    };
}

test('compat chat: a reasoning delta then a transport failure is never re-issued', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => {
        calls += 1;
        const stream = compatChatStream(
            [{ id: 'c1', model: 'local', choices: [{ delta: { reasoning_content: 'thinking hard' } }] }],
            err('socket hang up', { code: 'ECONNRESET' }),
        );
        return consumeCompatChatCompletionStream(stream, {
            label: 'compat-test',
            parseToolCalls: () => [],
            semanticIdleTimeoutMs: 5000,
        });
    }, { maxAttempts: 3, backoffMs: [0, 0, 0] }), (thrown) => {
        const o = thrown.streamOutcome;
        assert.ok(o, 'every compat reject must carry the canonical record');
        assert.equal(o.reasoningEmitted, true);
        assert.equal(o.visibleOutput, true);
        assert.equal(o.replayUnsafe, true);
        assert.equal(o.replaySafe, false);
        assert.equal(o.terminalObserved, false);
        assert.equal(o.continuation, true);
        assert.equal(thrown.emittedThinking, true);
        assert.equal(thrown.unsafeToRetry, true);
        return true;
    });
    assert.equal(calls, 1, 'exposed reasoning must not be duplicated by a retry/reset');
});

test('compat chat: a pre-output failure stays replay-safe and stamped', async () => {
    const thrown = await consumeCompatChatCompletionStream(
        compatChatStream([], err('boom', { httpStatus: 503 })),
        { label: 'compat-test', parseToolCalls: () => [], semanticIdleTimeoutMs: 5000 },
    ).then(() => null, (e) => e);
    assert.ok(thrown.streamOutcome, 'pre-output rejects are stamped too');
    assert.equal(thrown.streamOutcome.observedOutput, false);
    assert.equal(thrown.streamOutcome.replayUnsafe, false);
    assert.equal(thrown.streamOutcome.replaySafe, true);
});

// ── OpenAI-compatible RESPONSES streaming (distinct consumer from Chat) ─────

function compatResponsesStream(events, failure) {
    return compatChatStream(events, failure);
}
const RESPONSES_DEPS = {
    label: 'xai-responses-test',
    parseResponsesToolCalls: () => [],
    responseOutputText: (r) => r?.output_text || '',
    semanticIdleTimeoutMs: 5000,
};

test('compat responses: a reasoning delta then a failure is never re-issued', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => {
        calls += 1;
        return consumeCompatResponsesStream(
            compatResponsesStream(
                [
                    { type: 'response.created', response: { id: 'r1', model: 'grok-test' } },
                    { type: 'response.reasoning_summary_text.delta', delta: 'weighing options' },
                ],
                err('socket hang up', { code: 'ECONNRESET' }),
            ),
            RESPONSES_DEPS,
        );
    }, { maxAttempts: 3, backoffMs: [0, 0, 0] }), (thrown) => {
        const o = thrown.streamOutcome;
        assert.ok(o, 'every Responses reject must carry the canonical record');
        assert.equal(o.reasoningEmitted, true, 'reasoning is latched at delta time');
        assert.equal(o.visibleOutput, true);
        assert.equal(o.terminalObserved, false);
        assert.equal(o.continuation, true);
        assert.equal(o.replayUnsafe, true);
        assert.equal(o.replaySafe, false);
        assert.equal(thrown.emittedThinking, true);
        assert.equal(thrown.unsafeToRetry, true);
        return true;
    });
    assert.equal(calls, 1, 'exposed reasoning must not be duplicated by a retry/reset');
});

test('compat responses: a pre-output failure stays stamped and replay-safe', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
        calls += 1;
        if (calls === 1) {
            return consumeCompatResponsesStream(
                compatResponsesStream([], err('upstream unavailable', { httpStatus: 503 })),
                RESPONSES_DEPS,
            );
        }
        return 'recovered';
    }, { maxAttempts: 3, backoffMs: [0, 0, 0] });
    assert.equal(out, 'recovered');
    assert.equal(calls, 2, 'a pre-output Responses failure may still be retried');

    const thrown = await consumeCompatResponsesStream(
        compatResponsesStream([], err('upstream unavailable', { httpStatus: 503 })),
        RESPONSES_DEPS,
    ).then(() => null, (e) => e);
    assert.equal(thrown.streamOutcome.observedOutput, false);
    assert.equal(thrown.streamOutcome.replayUnsafe, false);
    assert.equal(thrown.streamOutcome.replaySafe, true);
});

test('compat responses: truncation after visible text is stamped non-replayable', async () => {
    const relayed = [];
    const thrown = await consumeCompatResponsesStream(
        compatResponsesStream([
            { type: 'response.created', response: { id: 'r1', model: 'grok-test' } },
            { type: 'response.output_text.delta', delta: 'visible answer' },
        ]),
        { ...RESPONSES_DEPS, onTextDelta: (t) => relayed.push(t) },
    ).then(() => null, (e) => e);
    assert.ok(thrown, 'no response.completed is never a success');
    assert.equal(relayed.join(''), 'visible answer');
    assert.equal(thrown.streamOutcome.textEmitted, true);
    assert.equal(thrown.streamOutcome.successEligible, false);
    assert.equal(thrown.streamOutcome.replaySafe, false);
    assert.equal(shouldFallbackTransport(thrown), false);
});

// ── Anthropic PROVIDER WRAPPERS: the real catch paths, not the helper ───────

const PENDING_INPUT_FRAMES = [
    { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_p', name: 'read' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
    { type: 'message_stop' },
];

test('anthropic OAuth wrapper: the real catch keeps the parser pending-input verdict', async () => {
    const oauth = Object.create(AnthropicOAuthProvider.prototype);
    oauth.credentials = { accessToken: 'fixture', expiresAt: Date.now() + 60_000 };
    oauth.config = {};
    oauth.fastModeBetaHeaderLatched = false;
    oauth.ensureAuth = async () => oauth.credentials;
    oauth.scrubTokens = (text) => text;
    let attempts = 0;
    const dispatched = [];
    const thrown = await oauth.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6', [], {
        onToolCall: (c) => dispatched.push(c),
        _doRequestFn: async () => {
            attempts += 1;
            return {
                response: { status: 200, ok: true, headers: new Map(), ...eofResponse(PENDING_INPUT_FRAMES) },
                controller: { abort() {} },
                cancelHandler: null,
            };
        },
    }).then(() => null, (e) => e);

    assert.ok(thrown, 'an incomplete tool input never completes the turn');
    assert.equal(thrown.code, 'TRUNCATED_STREAM');
    assert.equal(dispatched.length, 0);
    assert.ok(attempts > 1, 'an undispatched incomplete input is idempotent, so the wrapper may retry');
    // The wrapper must NOT have written coarse aliases over the parser verdict.
    assert.equal(thrown.partialToolCall, undefined);
    assert.equal(thrown.unsafeToRetry, undefined);
    assert.equal(thrown.emittedToolCall, undefined);
    assert.equal(thrown.streamOutcome.pendingToolInput, true);
    assert.equal(thrown.streamOutcome.toolCallsStarted, false);
    assert.equal(thrown.streamOutcome.replaySafe, true);
    assert.equal(thrown.streamOutcome.successEligible, false);
});

test('anthropic API-key wrapper: the real catch keeps the parser pending-input verdict', async () => {
    const provider = Object.create(AnthropicProvider.prototype);
    provider.name = 'anthropic';
    provider.config = {};
    provider.apiKey = 'fixture';
    provider.fastModeBetaHeaderLatched = false;
    let attempts = 0;
    const dispatched = [];
    provider.client = {
        messages: {
            create: () => ({
                asResponse: async () => {
                    attempts += 1;
                    return { status: 200, ok: true, headers: new Map(), ...eofResponse(PENDING_INPUT_FRAMES) };
                },
            }),
        },
    };
    const thrown = await provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6', [], {
        onToolCall: (c) => dispatched.push(c),
    }).then(() => null, (e) => e);

    assert.ok(thrown);
    assert.equal(thrown.code, 'TRUNCATED_STREAM');
    assert.equal(dispatched.length, 0);
    assert.ok(attempts > 1);
    assert.equal(thrown.partialToolCall, undefined);
    assert.equal(thrown.unsafeToRetry, undefined);
    assert.equal(thrown.streamOutcome.pendingToolInput, true);
    assert.equal(thrown.streamOutcome.replaySafe, true);
});

test('anthropic API-key 401: reloads once, but never after exposed output', async () => {
    const clean = Object.create(AnthropicProvider.prototype);
    let cleanCalls = 0;
    let cleanReloads = 0;
    clean._doSend = async () => {
        cleanCalls += 1;
        if (cleanCalls === 1) {
            throw err('Anthropic API 401: invalid key', {
                status: 401, httpStatus: 401, initialResponseError: true,
            });
        }
        return 'ok';
    };
    clean.reloadApiKey = () => { cleanReloads += 1; };
    assert.equal(await clean.send([], 'claude', [], {}), 'ok');
    assert.equal(cleanCalls, 2);
    assert.equal(cleanReloads, 1);

    // A 401 raised after reasoning was exposed would re-issue a turn the user
    // already saw output from.
    const exposed = Object.create(AnthropicProvider.prototype);
    let exposedCalls = 0;
    let exposedReloads = 0;
    const exposed401 = err('unauthorized (mid-stream)', { status: 401, emittedThinking: true });
    exposed._doSend = async () => { exposedCalls += 1; throw exposed401; };
    exposed.reloadApiKey = () => { exposedReloads += 1; };
    await assert.rejects(exposed.send([], 'claude', [], {}), (e) => e === exposed401);
    assert.equal(exposedCalls, 1);
    assert.equal(exposedReloads, 0);

    // Same for a 401 raised after a tool call was dispatched.
    const dispatched = Object.create(AnthropicProvider.prototype);
    let dispatchedCalls = 0;
    let dispatchedReloads = 0;
    const dispatched401 = err('401 after tool dispatch', { status: 401, emittedToolCall: true });
    dispatched._doSend = async () => { dispatchedCalls += 1; throw dispatched401; };
    dispatched.reloadApiKey = () => { dispatchedReloads += 1; };
    await assert.rejects(dispatched.send([], 'claude', [], {}), (e) => e === dispatched401);
    assert.equal(dispatchedCalls, 1);
    assert.equal(dispatchedReloads, 0);
});

// ── OpenAI OAuth HTTP: the initial POST retry loop is a replay gate ─────────

test('http/sse: the initial POST retry loop stamps and gates each reissue', async () => {
    let fetches = 0;
    const completedFrames = [
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test' } },
        { type: 'response.output_text.delta', delta: 'ok' },
        {
            type: 'response.completed',
            response: { id: 'resp_1', model: 'gpt-test', status: 'completed', output: [], usage: {} },
        },
    ];
    const result = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt-test', input: [] },
        opts: { _firstServerEventTimeoutMs: 5000, _semanticIdleTimeoutMs: 5000 },
        useModel: 'gpt-test',
        _sleepFn: async () => {},
        fetchFn: async () => {
            fetches += 1;
            if (fetches <= 2) {
                return { ok: false, status: 503, headers: new Map(), async arrayBuffer() { return new ArrayBuffer(0); }, async text() { return 'overloaded'; } };
            }
            return sseResponse(completedFrames);
        },
    });
    assert.equal(result.content, 'ok');
    assert.equal(fetches, 3, 'typed 5xx responses with no exposure are reissued');

    // A transport failure that carries output evidence can never be reissued.
    let exposedFetches = 0;
    const exposed = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt-test', input: [] },
        opts: {},
        useModel: 'gpt-test',
        _sleepFn: async () => {},
        fetchFn: async () => {
            exposedFetches += 1;
            throw err('connection reset after relayed output', {
                code: 'ECONNRESET', liveTextEmitted: true, unsafeToRetry: true,
            });
        },
    }).then(() => null, (e) => e);
    assert.ok(exposed);
    assert.equal(exposedFetches, 1, 'output evidence stops the POST retry loop');
    assert.equal(readStreamOutcome(exposed).replaySafe, false);
});

// ── Anthropic legacy-flag gap class: only partialContent is attached ────────

test('legacy gap: an Anthropic stall carrying ONLY partialContent is still observed output', () => {
    // Historical shape: no liveTextEmitted, no unsafeToRetry, no streamOutcome.
    const legacy = err('Anthropic OAuth SSE stream timed out after 60000ms of inactivity', {
        streamStalled: true,
        partialContent: 'streamed summary the user already saw',
        pendingToolUse: false,
    });
    const o = readStreamOutcome(legacy);
    assert.equal(o.stallObserved, true);
    assert.equal(o.terminalObserved, false);
    assert.equal(o.continuation, true);
    assert.equal(o.observedOutput, true, 'ask-session persistence gate must fire');
    assert.equal(hasObservedOutput(legacy), true);
    assert.equal(o.successEligible, false, 'a stall is never promoted to success');
});

test('legacy gap: an Anthropic stall with complete tool calls is not replayable', () => {
    const legacy = err('Anthropic OAuth SSE stalled', {
        streamStalled: true,
        partialContent: '',
        partialToolCalls: [{ id: 'toolu_1', name: 'bash', arguments: '{}' }],
    });
    const o = readStreamOutcome(legacy);
    assert.equal(o.toolCallsComplete, 1);
    assert.equal(o.sideEffectDispatched, true);
    assert.equal(o.replaySafe, false);
    assert.equal(classifyError(legacy), 'permanent');
});

// ── OpenAI Responses HTTP/SSE: real transport, EOF without a terminal frame ─

function sseResponse(events) {
    const chunks = events.map((e) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
    let i = 0;
    return {
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
            getReader() {
                return {
                    read() {
                        if (i < chunks.length) return Promise.resolve({ done: false, value: chunks[i++] });
                        return Promise.resolve({ done: true, value: undefined });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}
async function runHttpSse(events, extra = {}) {
    return sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'test-key' },
        body: { model: 'gpt-test', input: [] },
        opts: { _firstServerEventTimeoutMs: 5000, _semanticIdleTimeoutMs: 5000 },
        useModel: 'gpt-test',
        poolKey: 'sess-test',
        iteration: 1,
        fetchFn: async () => sseResponse(events),
        ...extra,
    }).then((r) => ({ result: r }), (e) => ({ error: e }));
}

test('http/sse: EOF with streamed TEXT and no terminal frame always throws, stamped', async () => {
    let relayed = '';
    const { result, error } = await runHttpSse([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test' } },
        { type: 'response.output_text.delta', delta: 'visible answer' },
    ], { onTextDelta: (t) => { relayed += t; } });
    assert.equal(result, undefined, 'a stream without response.completed is never a success');
    assert.match(error.message, /ended before response\.completed/);
    assert.equal(relayed, 'visible answer');
    const o = error.streamOutcome;
    assert.ok(o, 'every post-loop reject must carry the canonical stamp');
    assert.equal(o.transport, STREAM_TRANSPORTS.HTTP_SSE);
    assert.equal(o.terminalObserved, false);
    assert.equal(o.continuation, true);
    assert.equal(o.textEmitted, true);
    assert.equal(o.observedOutput, true);
    assert.equal(o.successEligible, false);
    assert.equal(o.replayUnsafe, true);
    assert.equal(o.replaySafe, false);
    assert.equal(error.partialContent, 'visible answer');
    assert.equal(error.liveTextEmitted, true);
    assert.equal(error.unsafeToRetry, true);
    assert.equal(classifyError(error), 'permanent');
    assert.equal(shouldFallbackTransport(error), false);
});

test('http/sse: EOF with a DISPATCHED tool call and no terminal frame always throws', async () => {
    const dispatched = [];
    const { result, error } = await runHttpSse([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test' } },
        {
            type: 'response.output_item.added',
            item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell' },
        },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"command":"ls"}' },
    ], { onToolCall: (c) => dispatched.push(c) });
    assert.equal(result, undefined);
    assert.equal(dispatched.length, 1, 'the tool was already dispatched');
    const o = error.streamOutcome;
    assert.equal(o.terminalObserved, false);
    assert.equal(o.continuation, true);
    assert.equal(o.toolCallsComplete, 1);
    assert.equal(o.toolCallsDispatched, 1);
    assert.equal(o.sideEffectDispatched, true);
    assert.equal(o.successEligible, false);
    assert.equal(o.replaySafe, false);
    assert.equal(error.emittedToolCall, true);
    assert.equal(error.unsafeToRetry, true);
    assert.equal(shouldFallbackTransport(error), false, 'a dispatched tool blocks transport fallback');
});

test('http/sse: a reasoning delta is an immediate no-replay boundary', async () => {
    const { error } = await runHttpSse([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test' } },
        { type: 'response.reasoning_summary_text.delta', delta: 'thinking about it' },
    ]);
    const o = error.streamOutcome;
    assert.equal(o.reasoningEmitted, true, 'tracked at delta time, not at completion');
    assert.equal(o.visibleOutput, true);
    assert.equal(o.replayUnsafe, true);
    assert.equal(o.replaySafe, false);
    assert.equal(error.emittedThinking, true);
    assert.equal(error.unsafeToRetry, true);
    assert.equal(classifyError(error), 'permanent');
    assert.equal(shouldFallbackTransport(error), false);
});

test('http/sse: a clean pre-output EOF stays replay-safe and stamped', async () => {
    const { error } = await runHttpSse([
        { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test' } },
    ]);
    const o = error.streamOutcome;
    assert.ok(o);
    assert.equal(o.continuation, true);
    assert.equal(o.observedOutput, false);
    assert.equal(o.replayUnsafe, false);
    assert.equal(o.replaySafe, true, 'nothing was exposed: the turn may be re-issued');
});

// ── send-with-recovery: outcome-driven branches ────────────────────────────

function recoveryCtx(sendErr) {
    return {
        provider: { send: async () => { throw sendErr; } },
        messages: [], model: 'test-model', sendTools: [], tools: [],
        opts: {}, sessionId: 'sess-test', sessionRef: null,
        nextIteration: 1, contextOverflowRetryUsed: false,
    };
}

test('send-with-recovery: no-tool stall with partial text stays an explicit failure', async () => {
    const e = err('stalled', { streamStalled: true, partialContent: 'half written summary' });
    await assert.rejects(sendWithRecovery(recoveryCtx(e)), (thrown) => thrown === e);
});

test('send-with-recovery: a spent stall window never blocks the bounded transport replay', async () => {
    const e = err('reset', { code: 'ECONNRESET' });
    const spent = { allowStallRetry: () => false };

    // The surviving bound is the replay COUNT, not a window already spent
    // detecting the stall that the replay exists to recover from.
    const capped = recoveryCtx(e);
    capped.opts._stallRetryBudget = spent;
    capped.transportRetriesUsed = 99;
    await assert.rejects(sendWithRecovery(capped), (thrown) => thrown === e);

    // A fresh request opens a new window instead of inheriting the spent one.
    const opts = { _stallRetryBudget: spent };
    const fresh = resetStallRetryBudget(opts);
    assert.notEqual(fresh, spent);
    assert.equal(opts._stallRetryBudget, fresh);
    assert.equal(fresh.allowStallRetry(), true);
});

test('send-with-recovery: provider-terminal exhaustion never gains a fresh loop replay', async () => {
    const terminal = markProviderRecoveryExhausted(
        err('provider retries spent', { code: 'ECONNRESET' }),
        { owner: 'test-provider', attempts: 3 },
    );
    await assert.rejects(
        sendWithRecovery(recoveryCtx(terminal)),
        (thrown) => thrown === terminal,
    );
});

test('send-with-recovery: stall with COMPLETE tool calls recovers as a tool turn', async () => {
    const e = err('stalled', {
        streamStalled: true,
        pendingToolUse: false,
        partialContent: 'thinking out loud',
        partialToolCalls: [{ id: 'call_1', name: 'read', arguments: '{}' }],
    });
    const out = await sendWithRecovery(recoveryCtx(e));
    assert.equal(out.action, 'proceed');
    assert.equal(out.response.stopReason, 'tool_use');
    assert.equal(out.response.toolCalls.length, 1);
    assert.equal(out.response.partialToolRecovery, true);
});

test('send-with-recovery: stall with a PENDING tool input never becomes a response', async () => {
    const e = err('stalled', {
        streamStalled: true,
        pendingToolUse: true,
        partialContent: 'x',
        partialToolCalls: [{ id: 'call_1', name: 'write', arguments: '{"pa' }],
    });
    await assert.rejects(sendWithRecovery(recoveryCtx(e)), (thrown) => thrown === e);
});

test('send-with-recovery: terminal output-limit incomplete is the only success promotion', async () => {
    const ok = err('incomplete', {
        providerIncomplete: true,
        code: 'PROVIDER_INCOMPLETE',
        finishReason: 'MAX_TOKENS',
        partialContent: 'truncated but terminal',
        rawUsage: { promptTokenCount: 5, candidatesTokenCount: 7 },
    });
    const out = await sendWithRecovery(recoveryCtx(ok));
    assert.equal(out.action, 'proceed');
    assert.equal(out.response.truncated, true);
    assert.equal(out.response.content, 'truncated but terminal');

    // Same shape + tool exposure (legacy flags absent, record inferred) must NOT
    // be promoted: a dispatched tool makes the turn non-idempotent.
    const withTool = err('incomplete', {
        providerIncomplete: true,
        code: 'PROVIDER_INCOMPLETE',
        finishReason: 'MAX_TOKENS',
        partialContent: 'truncated with a tool',
        partialToolCalls: [{ id: 'call_1', name: 'bash', arguments: '{}' }],
    });
    await assert.rejects(sendWithRecovery(recoveryCtx(withTool)), (thrown) => thrown === withTool);
});

// ── Reactive context-overflow retry requires canonical replay PERMISSION ────

const OVERFLOW_MESSAGE = 'prompt is too long: 300000 tokens > 200000 maximum';
function overflowCtx(sendErr) {
    return {
        ...recoveryCtx(sendErr),
        sessionRef: { contextWindow: 200_000 },
    };
}

test('context overflow: a request-level refusal may compact-and-retry', async () => {
    const e = err(OVERFLOW_MESSAGE, { httpStatus: 400, initialResponseError: true });
    const outcome = readStreamOutcome(e);
    assert.equal(outcome.replaySafe, true);
    const out = await sendWithRecovery(overflowCtx(e));
    assert.equal(out.action, 'retry');
});

test('context overflow: a refusal with no exposure evidence still compacts and retries', async () => {
    const e = err(OVERFLOW_MESSAGE);
    assert.equal(readStreamOutcome(e).replaySafe, true);
    assert.equal((await sendWithRecovery(overflowCtx(e))).action, 'retry');
});

test('context overflow: visible output / reasoning / ambiguous tools never retry', async () => {
    const visible = err(OVERFLOW_MESSAGE, { httpStatus: 400, liveTextEmitted: true });
    await assert.rejects(sendWithRecovery(overflowCtx(visible)));

    const reasoning = err(OVERFLOW_MESSAGE, { httpStatus: 400, emittedThinking: true });
    await assert.rejects(sendWithRecovery(overflowCtx(reasoning)));

    const ambiguous = err(OVERFLOW_MESSAGE, {
        httpStatus: 400,
        partialToolCalls: [{ id: 'call_1', name: 'shell', arguments: {} }],
    });
    assert.equal(readStreamOutcome(ambiguous).dispatchAmbiguous, true);
    await assert.rejects(sendWithRecovery(overflowCtx(ambiguous)));

    const buffered = err(OVERFLOW_MESSAGE, { httpStatus: 400, partialContent: 'streamed text' });
    assert.equal(readStreamOutcome(buffered).replaySafe, true, 'buffered text was never shown');
    assert.equal((await sendWithRecovery(overflowCtx(buffered))).action, 'retry');
});

// ── Typed-evidence classification: no status/transience/auth from text ──────

test('classifyError: server MESSAGE TEXT never synthesizes a status or transience', () => {
    for (const text of [
        'Our servers are currently overloaded. Please try again later.',
        'service unavailable',
        'an error occurred while processing your request (please include the request id)',
        'rate limit exceeded',
        'unauthorized: invalid api key',
        'forbidden: policy violation',
    ]) {
        const e = err(text);
        assert.equal(classifyError(e), 'unknown', `"${text}" carries no typed evidence`);
        assert.equal(e.httpStatus, undefined, 'no status may be written onto the error');
    }
    // The same conditions, typed, classify exactly as before.
    assert.equal(classifyError(err('overloaded', { httpStatus: 503 })), 'transient');
    assert.equal(classifyError(err('slow', { httpStatus: 408 })), 'transient');
    assert.equal(classifyError(err('rate limited', { httpStatus: 429 })), 'permanent');
    assert.equal(classifyError(err('nope', { httpStatus: 401 })), 'auth');
    assert.equal(classifyError(err('reset', { code: 'ECONNRESET' })), 'transient');
    // A bare fetch failure with no status and no errno is a transport
    // symptom: the EXACT runtime message ('fetch failed' / 'Failed to
    // fetch' / "Couldn't fetch" / 'Load failed') classifies transient so a
    // network blip retries instead of failing the turn (observed live).
    // Free-form server text above still never synthesizes transience.
    assert.equal(classifyError(err('fetch failed', { name: 'TypeError' })), 'transient');
    assert.equal(classifyError(err("Couldn't fetch")), 'transient');
    assert.equal(classifyError(err("Couldn't fetch", { httpStatus: 400 })), 'permanent',
        'a real HTTP status still outranks the bare-fetch message');
    assert.equal(
        classifyError(err('fetch failed', { name: 'TypeError', cause: { code: 'ECONNRESET' } })),
        'transient',
    );
});

test('transport fallback: only typed transient statuses/codes may switch transports', () => {
    const withStatus = (status) => err('handshake', { httpStatus: status, retryClassifier: '' });
    assert.equal(shouldFallbackTransport(withStatus(503)), true);
    assert.equal(shouldFallbackTransport(withStatus(408)), true);
    assert.equal(shouldFallbackTransport(withStatus(426)), true, 'explicit upgrade switch');
    assert.equal(shouldFallbackTransport(withStatus(401)), false);
    assert.equal(shouldFallbackTransport(withStatus(403)), false);
    assert.equal(shouldFallbackTransport(withStatus(404)), false);
    assert.equal(shouldFallbackTransport(withStatus(418)), false);
    assert.equal(shouldFallbackTransport(withStatus(429)), false);
    assert.equal(shouldFallbackTransport(err('reset', { code: 'ECONNRESET' })), true);
    assert.equal(shouldFallbackTransport(err('ws gone', { retryClassifier: 'ws_1006' })), true);
    // Message-only symptoms are not evidence.
    for (const text of [
        'opening handshake has timed out',
        'socket hang up',
        'acquire timed out',
        'no meaningful output',
    ]) {
        assert.equal(shouldFallbackTransport(err(text)), false, `"${text}" is text, not evidence`);
    }
});

// ── Anthropic: an EMPTY thinking block is not visible reasoning ─────────────

test('anthropic SSE: a signature-only thinking block is not exposed reasoning', async () => {
    const { error } = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
    ]);
    assert.equal(error?.code, 'TRUNCATED_STREAM');
    const o = error.streamOutcome;
    assert.equal(o.reasoningEmitted, false, 'nothing was shown to the user');
    assert.equal(o.visibleOutput, false);
    assert.equal(o.replaySafe, true);
    assert.equal(classifyError(error), 'transient');
    // The block itself is still preserved for persistence/round-trip.
    assert.equal(error.partialHasThinking, true);
    assert.equal(error.partialThinkingBlocks?.length, 1);

    // Real thinking TEXT is exposure and denies the replay.
    const exposed = await parseFrames([
        { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing options' } },
    ]);
    assert.equal(exposed.error.streamOutcome.reasoningEmitted, true);
    assert.equal(exposed.error.streamOutcome.replaySafe, false);
    assert.equal(classifyError(exposed.error), 'permanent');
});

// ── Gemini: buffered stream text is not visible output ──────────────────────

function geminiRestResponse(chunks) {
    const bytes = encoder.encode(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''));
    let sent = false;
    return {
        body: {
            getReader() {
                return {
                    read() {
                        if (sent) return Promise.resolve({ done: true, value: undefined });
                        sent = true;
                        return Promise.resolve({ done: false, value: bytes });
                    },
                    cancel() { return Promise.resolve(); },
                    releaseLock() {},
                };
            },
        },
    };
}
const GEMINI_TEXT_CHUNK = { candidates: [{ content: { parts: [{ text: 'half an answer' }] } }] };

test('gemini REST: text with no live sink is buffered, not visible (replay stays safe)', async () => {
    const thrown = await consumeGeminiRestStreamResponse(geminiRestResponse([GEMINI_TEXT_CHUNK]), {
        signal: null,
        onStreamDelta: () => {},
        onTextDelta: null,
        textLeakGuard: null,
        label: 'gemini buffered',
    }).then(() => null, (e) => e);
    assert.ok(thrown, 'a stream with no finishReason is truncated, never a success');
    assert.equal(thrown.liveTextEmitted, undefined, 'nothing was relayed');
    assert.equal(thrown.unsafeToRetry, undefined);
    const o = readStreamOutcome(thrown);
    assert.equal(o.visibleOutput, false);
    assert.equal(o.replaySafe, true);
    assert.equal(classifyError(thrown), 'transient');

    // The same stream WITH a live sink relayed the text: replay is denied.
    let relayed = '';
    const exposed = await consumeGeminiRestStreamResponse(geminiRestResponse([GEMINI_TEXT_CHUNK]), {
        signal: null,
        onStreamDelta: () => {},
        onTextDelta: (t) => { relayed += t; },
        textLeakGuard: null,
        label: 'gemini relayed',
    }).then(() => null, (e) => e);
    assert.equal(relayed, 'half an answer');
    assert.equal(exposed.liveTextEmitted, true);
    assert.equal(exposed.unsafeToRetry, true);
    assert.equal(readStreamOutcome(exposed).replaySafe, false);
    assert.equal(exposed.partialContent, 'half an answer', 'partial persistence intact');
});

// ── OpenAI HTTP/SSE: pre-response retries are typed-transient only ──────────

test('http/sse: an untyped pre-response failure throws immediately; a typed one retries', async () => {
    let unknownFetches = 0;
    const unknown = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt-test', input: [] },
        opts: {},
        useModel: 'gpt-test',
        _sleepFn: async () => {},
        fetchFn: async () => {
            unknownFetches += 1;
            throw err('something went sideways');
        },
    }).then(() => null, (e) => e);
    assert.ok(unknown);
    assert.equal(unknownFetches, 1, 'unknown transport failures are surfaced, not re-issued');

    let typedFetches = 0;
    const result = await sendViaHttpSse({
        auth: { type: 'openai-direct', apiKey: 'k' },
        body: { model: 'gpt-test', input: [] },
        opts: { _firstServerEventTimeoutMs: 5000, _semanticIdleTimeoutMs: 5000 },
        useModel: 'gpt-test',
        _sleepFn: async () => {},
        fetchFn: async () => {
            typedFetches += 1;
            if (typedFetches === 1) throw err('socket hang up', { code: 'ECONNRESET' });
            return sseResponse([
                { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test' } },
                { type: 'response.output_text.delta', delta: 'ok' },
                {
                    type: 'response.completed',
                    response: { id: 'resp_1', model: 'gpt-test', status: 'completed', output: [], usage: {} },
                },
            ]);
        },
    });
    assert.equal(result.content, 'ok');
    assert.equal(typedFetches, 2, 'a typed transient errno may re-issue the POST');
});

// ── response.failed: typed buckets + codex-parity default-retry ─────────────

test('midstream WS: response.failed picks buckets from typed codes and default-retries the rest', () => {
    const state = () => ({ attemptIndex: 0, sawResponseCreated: true });
    const failedWith = (payload) => err('WS response.failed', { responseFailed: payload });

    // Explicit code / type fields (retryable disconnect buckets).
    assert.equal(
        classifyMidstreamError(failedWith({ response: { error: { code: 'stream_disconnected' } } }), state(), WS_POLICY),
        'response_failed_disconnected',
    );
    assert.equal(
        classifyMidstreamError(failedWith({ error: { type: 'network_error' } }), state(), WS_POLICY),
        'response_failed_network',
    );
    assert.equal(
        classifyMidstreamError(failedWith({ error: { code: 'auth_context_expired' } }), state(), WS_POLICY),
        'response_failed_auth_expired',
    );
    // A typed 5xx on the failure payload is transient too.
    assert.equal(
        classifyMidstreamError(failedWith({ response: { error: { status: 503, code: 'server_error' } } }), state(), WS_POLICY),
        'http_503',
    );

    // Free text never selects a SPECIFIC bucket — but an unrecognized (or
    // absent) code is a server-side fault and takes the bounded default
    // retry, exactly like codex's catch-all ApiError::Retryable.
    for (const payload of [
        { response: { error: { message: 'stream_disconnected while reading the response' } } },
        { error: { message: 'upstream network_error after 3s' } },
        { response: { error: { code: 'server_error', message: 'auth context expired' } } },
        { body: 'network_error', detail: { note: 'stream_disconnected' } },
    ]) {
        assert.equal(
            classifyMidstreamError(failedWith(payload), state(), WS_POLICY), 'response_failed_retryable',
            'an unrecognized wire failure is retried under the bounded budget',
        );
    }

    // Deterministic refusals stay terminal: fatal codes and typed 4xx.
    for (const payload of [
        { response: { error: { code: 'insufficient_quota' } } },
        { response: { error: { code: 'invalid_prompt' } } },
        { error: { type: 'cyber_policy' } },
        { response: { error: { status: 400, message: 'bad request' } } },
    ]) {
        assert.equal(
            classifyMidstreamError(failedWith(payload), state(), WS_POLICY), null,
            'fatal refusal codes / typed 4xx are never replayed',
        );
    }

    // classifyError follows the same contract for the loop-level ladder.
    assert.equal(classifyError(failedWith({ response: { error: { code: 'server_error' } } })), 'transient');
    assert.equal(classifyError(failedWith({ response: { error: { message: 'no code at all' } } })), 'transient');
    assert.equal(classifyError(failedWith({ response: { error: { code: 'insufficient_quota' } } })), 'permanent');
});

// ── Anthropic SSE error events: typed type/status only ──────────────────────

test('anthropic SSE: error events take their status from the typed error type only', async () => {
    for (const [type, status, kind] of [
        ['overloaded_error', 503, 'transient'],
        ['rate_limit_error', 429, 'permanent'],
        ['authentication_error', 401, 'auth'],
        ['permission_error', 403, 'auth'],
        ['not_found_error', 404, 'permanent'],
        ['invalid_request_error', 400, 'permanent'],
    ]) {
        const { error } = await parseFrames([
            { type: 'error', error: { type, message: 'server said so' } },
        ]);
        assert.equal(error?.name, 'AnthropicSseError');
        assert.equal(error.httpStatus, status, `${type} → ${status}`);
        assert.equal(classifyError(error), kind);
    }

    // An explicit numeric status on the payload wins and is preserved.
    const numeric = await parseFrames([
        { type: 'error', error: { type: 'unmapped_error', status: 502, message: 'bad gateway' } },
    ]);
    assert.equal(numeric.error.httpStatus, 502);
    assert.equal(classifyError(numeric.error), 'transient');

    // Message text is never mined for a status — no status is synthesized.
    // As provider wire error events, unmapped types now DEFAULT-RETRY
    // (transient) under the shared wire-error contract instead of failing
    // the turn as 'unknown'.
    for (const message of [
        'Overloaded, please try again later',
        'rate limit exceeded; quota will reset',
        'authentication failed: unauthorized',
        'forbidden by policy',
        'model not found',
    ]) {
        const { error } = await parseFrames([{ type: 'error', error: { type: 'error', message } }]);
        assert.equal(error.httpStatus, undefined, `"${message}" must not synthesize a status`);
        assert.equal(error.status, undefined);
        assert.equal(classifyError(error), 'transient');
    }
});

// ── Provider retry gaps vs refs (codex / grok-build / Gemini / undici) ──────

test('classifyError: Cloudflare origin-TLS 525/526 are permanent', () => {
    assert.equal(classifyError(err('origin tls', { httpStatus: 525 })), 'permanent');
    assert.equal(classifyError(err('invalid cert', { httpStatus: 526 })), 'permanent');
    assert.equal(classifyHandshakeError(err('origin tls', { httpStatus: 525 })), null);
    assert.equal(shouldFallbackTransport(err('origin tls', { httpStatus: 525 })), false);
    assert.equal(classifyError(err('overloaded', { httpStatus: 529 })), 'transient');
});

test('classifyError: undici/TLS transport codes are transient', () => {
    for (const code of [
        'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT', 'EPROTO',
    ]) {
        assert.equal(classifyError(err('transport', { code })), 'transient', code);
        assert.equal(shouldFallbackTransport(err('transport', { code })), true, code);
    }
    assert.equal(classifyHandshakeError(err('socket', { code: 'UND_ERR_SOCKET' })), 'network');
});

test('classifyError: Gemini gRPC UNAVAILABLE/DEADLINE/ABORTED/INTERNAL retry without HTTP', () => {
    assert.equal(classifyError(err('unavailable', { geminiStatus: 'UNAVAILABLE' })), 'transient');
    assert.equal(classifyError(err('deadline', { status: 'DEADLINE_EXCEEDED' })), 'transient');
    assert.equal(classifyError(err('aborted', { code: 'ABORTED' })), 'transient');
    assert.equal(classifyError(err('internal', { error: { status: 'INTERNAL' } })), 'transient');
    assert.equal(classifyError(err('quota', { code: 'RESOURCE_EXHAUSTED' })), 'unknown');
    assert.equal(classifyError(err('quota', { geminiStatus: 'RESOURCE_EXHAUSTED' })), 'transient');
});

test('withRetry: Gemini 429 RESOURCE_EXHAUSTED without Retry-After is retried', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
        calls += 1;
        if (calls === 1) {
            throw err('RESOURCE_EXHAUSTED', {
                httpStatus: 429,
                status: 429,
                code: 'RESOURCE_EXHAUSTED',
                geminiStatus: 'RESOURCE_EXHAUSTED',
            });
        }
        return 'ok';
    }, { maxAttempts: 3, backoffMs: [0, 0, 0] });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
});

test('retryAfterMsFromError: typed rate_limit_exceeded parses try-again delay', () => {
    const openai = err('Rate limit reached. Please try again in 11.054s.', {
        responseFailed: { response: { error: { code: 'rate_limit_exceeded', message: 'Please try again in 11.054s.' } } },
    });
    assert.equal(retryAfterMsFromError(openai), 11054);
    const azure = err('Rate limit exceeded. Try again in 35 seconds.', {
        providerErrorCode: 'rate_limit_exceeded',
        responseFailed: { error: { code: 'rate_limit_exceeded', message: 'Try again in 35 seconds.' } },
    });
    assert.equal(retryAfterMsFromError(azure), 35_000);
    const millis = err('try again in 28ms', {
        code: 'rate_limit_exceeded',
        responseFailed: { error: { code: 'rate_limit_exceeded', message: 'Please try again in 28ms.' } },
    });
    assert.equal(retryAfterMsFromError(millis), 28);
    assert.equal(
        retryAfterMsFromError(err('Please try again in 11.054s.')),
        null,
        'untyped message text never yields a delay',
    );
});

test('retryAfterMsFromError: anthropic-ratelimit-unified-reset is honored and capped', () => {
    const resetUnix = Math.floor(Date.now() / 1000) + 12;
    const headers = { get: (name) => String(name).toLowerCase() === 'anthropic-ratelimit-unified-reset' ? String(resetUnix) : null };
    const delay = retryAfterMsFromError(err('rate limited', { httpStatus: 429, headers }));
    assert.ok(delay >= 10_000 && delay <= 12_000, `expected ~12s, got ${delay}`);
    const far = Math.floor(Date.now() / 1000) + 3600;
    const farHeaders = { get: (name) => String(name).toLowerCase() === 'anthropic-ratelimit-unified-reset' ? String(far) : null };
    assert.equal(retryAfterMsFromError(err('rate limited', { httpStatus: 429, headers: farHeaders })), 300_000);
});

test('provider admission does not cache long subscription quota windows', async () => {
    const scheduler = new ProviderAdmissionScheduler();
    const key = 'anthropic-oauth:test-account';
    let calls = 0;
    await assert.rejects(
        scheduler.run(key, async () => {
            calls += 1;
            throw err('Fable quota exhausted', { httpStatus: 429, retryAfterMs: 214_641_000 });
        }),
        /Fable quota exhausted/,
    );
    const result = await scheduler.run(key, async () => {
        calls += 1;
        return 'opus-ok';
    });
    assert.equal(result, 'opus-ok');
    assert.equal(calls, 2);
    assert.equal(scheduler.applyExternalCooldown(key, Date.now() + 214_641_000), false);
});

test('previous_response_not_found: typed 400 is transient and midstream-retryable', () => {
    const wire = err('Previous response was not found', {
        httpStatus: 400,
        providerErrorCode: 'previous_response_not_found',
        responseFailed: { error: { code: 'previous_response_not_found' } },
    });
    assert.equal(shouldDropPreviousResponseId(wire), true);
    assert.equal(classifyError(wire), 'transient');
    assert.equal(
        classifyMidstreamError(wire, { attemptIndex: 0, sawResponseCreated: true }, WS_POLICY),
        'previous_response_not_found',
    );
    const sdk = err('Previous response was not found', {
        httpStatus: 400,
        code: 'previous_response_not_found',
    });
    assert.equal(shouldDropPreviousResponseId(sdk), true);
    assert.equal(classifyError(sdk), 'transient');
});

test('classifyError: SDK timeout names, 425, HTTP/2, and WS connection-limit', () => {
    assert.equal(classifyError(err('timed out', { name: 'APIConnectionTimeoutError' })), 'transient');
    assert.equal(classifyError(err('connect', { name: 'ConnectTimeoutError' })), 'transient');
    assert.equal(classifyError(err('too early', { httpStatus: 425 })), 'transient');
    assert.equal(classifyError(err('h2', { code: 'ERR_HTTP2_STREAM_ERROR' })), 'transient');
    assert.equal(classifyError(err('destroyed', { code: 'UND_ERR_DESTROYED' })), 'transient');
    assert.equal(shouldFallbackTransport(err('h2', { code: 'ERR_HTTP2_SESSION_ERROR' })), true);
    const limit = err('connection limit', {
        httpStatus: 400,
        providerErrorCode: 'websocket_connection_limit_reached',
        responseFailed: { error: { code: 'websocket_connection_limit_reached' } },
    });
    assert.equal(classifyError(limit), 'transient');
    assert.equal(
        classifyMidstreamError(limit, { attemptIndex: 0, sawResponseCreated: true }, WS_POLICY),
        'websocket_connection_limit',
    );
    const eventLimit = err('Responses websocket connection limit reached (60 minutes).', {
        payload: {
            type: 'invalid_request_error',
            code: 'websocket_connection_limit_reached',
        },
    });
    assert.equal(
        classifyMidstreamError(eventLimit, { attemptIndex: 0, sawResponseCreated: false }, WS_POLICY),
        'websocket_connection_limit',
    );
});

test('isContextOverflowError: typed 413 and request_too_large/context codes', () => {
    assert.equal(isContextOverflowError(err('too big', { httpStatus: 413 })), true);
    assert.equal(isContextOverflowError(err('too big', {
        providerErrorCode: 'request_too_large',
        responseFailed: { error: { type: 'request_too_large' } },
    })), true);
    assert.equal(isContextOverflowError(err('too big', { code: 'context_length_exceeded' })), true);
    assert.equal(isContextOverflowError(err('bad json', { httpStatus: 400 })), false);
});
