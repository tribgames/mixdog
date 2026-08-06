// Regression: a stream that ends WITHOUT its terminal frame must stay
// retryable. Two historical gaps are covered:
//   1. A WS close before response.created carried no HTTP status and no errno,
//      so classifyError said 'unknown' and no loop-level replay ran — a pooled
//      socket retired by the server (close 1000) killed the whole turn.
//   2. Once ANY text was relayed, classifyError flipped to 'permanent', so the
//      exposed-text retraction path (onTextReset) could never be reached for a
//      close/truncation — only for a stall.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyError,
    classifyMidstreamError,
    canFallbackNonStreaming,
    isNonTerminalStreamClose,
    MIDSTREAM_RETRY_POLICY,
} from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';

// The transport backoff ladder is read at module load, so the override must be
// set BEFORE the recovery/loop modules are imported — hence dynamic imports.
process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS = '0,0';
const { sendWithRecovery } = await import('../src/runtime/agent/orchestrator/session/send-with-recovery.mjs');
const { agentLoop } = await import('../src/runtime/agent/orchestrator/session/agent-loop.mjs');

const wsPolicy = { mode: 'ws', ...MIDSTREAM_RETRY_POLICY.ws };

function closeErr(code, extra = {}) {
    return Object.assign(
        new Error(`OpenAI OAuth WS closed before response.completed (code=${code})`),
        { wsCloseCode: code, ...extra },
    );
}

test('non-terminal stream close is recognized only without a terminal frame', () => {
    assert.equal(isNonTerminalStreamClose(closeErr(1000)), true);
    assert.equal(isNonTerminalStreamClose(closeErr(1005)), true);
    assert.equal(isNonTerminalStreamClose(closeErr(1006)), true);
    assert.equal(isNonTerminalStreamClose(closeErr(1000, { sawCompleted: true })), false);
    assert.equal(isNonTerminalStreamClose(closeErr(4001)), false);
    assert.equal(isNonTerminalStreamClose(new Error('plain')), false);
});

test('classifyError treats an unexposed close-before-completed as transient', () => {
    assert.equal(classifyError(closeErr(1000)), 'transient');
    assert.equal(classifyError(closeErr(1006)), 'transient');
    // Exposure still fails closed: replaying would duplicate rendered output.
    assert.equal(classifyError(closeErr(1000, { liveTextEmitted: true })), 'permanent');
    // A completed turn is never a transport symptom.
    assert.equal(classifyError(closeErr(1000, { sawCompleted: true })), 'unknown');
});

test('mid-stream WS classifier retries nominal closes before response.created', () => {
    const preCreated = { attemptIndex: 0, sawResponseCreated: false };
    assert.equal(classifyMidstreamError(closeErr(1000), preCreated, wsPolicy), 'ws_1000');
    assert.equal(classifyMidstreamError(closeErr(1005), preCreated, wsPolicy), 'ws_1005');
    assert.equal(classifyMidstreamError(closeErr(1006), preCreated, wsPolicy), 'ws_1006');
    // After response.created the same nominal close is still a continuation.
    assert.equal(
        classifyMidstreamError(closeErr(1000), { attemptIndex: 0, sawResponseCreated: true }, wsPolicy),
        'ws_1000',
    );
    // A completed turn stays terminal.
    assert.equal(
        classifyMidstreamError(
            closeErr(1000, { sawCompleted: true }),
            { attemptIndex: 0, sawResponseCreated: true, sawCompleted: true },
            wsPolicy,
        ),
        null,
    );
});

async function recoveryFor(sendErr) {
    const resets = [];
    const stages = [];
    const opts = {
        onTextDelta: () => {},
        onTextReset: (detail) => { resets.push(detail); return true; },
        onStageChange: (stage, detail) => { stages.push({ stage, detail }); },
    };
    const ctx = {
        provider: { send: async () => { throw sendErr; } },
        messages: [{ role: 'user', content: 'hi' }],
        model: 'test-model',
        sendTools: [],
        tools: [],
        opts,
        sessionId: 'sess_stream_close_test',
        sessionRef: null,
        nextIteration: 1,
        contextOverflowRetryUsed: false,
        transportRetriesUsed: 0,
        signal: null,
    };
    const result = await sendWithRecovery(ctx);
    return { result, resets, stages };
}

test('exposed text on a close-before-completed is retracted and replayed', async () => {
    const err = closeErr(1006, {
        liveTextEmitted: true,
        unsafeToRetry: true,
        partialContent: 'partial answer',
    });
    const { result, resets, stages } = await recoveryFor(err);
    assert.equal(result.action, 'retry_transport');
    assert.equal(resets.length, 1);
    assert.equal(resets[0].chars, 'partial answer'.length);
    // The wait must be explained to the caller, not rendered as a frozen turn.
    const reconnect = stages.filter((entry) => entry.stage === 'reconnecting');
    assert.equal(reconnect.length, 1);
    assert.equal(reconnect[0].detail.attempt, 1);
    assert.match(reconnect[0].detail.message, /^Reconnecting\.\.\. 1\/\d+$/);
});

test('exposed text on a truncated stream is retracted and replayed', async () => {
    const err = Object.assign(new Error('SSE stream truncated: message_start without message_stop'), {
        name: 'TruncatedStreamError',
        code: 'TRUNCATED_STREAM',
        truncatedStream: true,
        liveTextEmitted: true,
        unsafeToRetry: true,
        partialContent: 'half a sentence',
    });
    const { result, resets, stages } = await recoveryFor(err);
    assert.equal(result.action, 'retry_transport');
    assert.equal(resets.length, 1);
    assert.equal(stages.filter((entry) => entry.stage === 'reconnecting').length, 1);
});

test('an unexposed close reports reconnect progress before the replay wait', async () => {
    const { result, resets, stages } = await recoveryFor(closeErr(1000));
    assert.equal(result.action, 'retry_transport');
    assert.equal(resets.length, 0, 'nothing was exposed, so nothing is retracted');
    const reconnect = stages.filter((entry) => entry.stage === 'reconnecting');
    assert.equal(reconnect.length, 1);
    assert.equal(reconnect[0].detail.attempt, 1);
    assert.ok(Number.isFinite(reconnect[0].detail.waitMs));
});

test('a dispatched tool call still blocks the replay', async () => {
    const err = closeErr(1006, {
        emittedToolCall: true,
        unsafeToRetry: true,
        partialContent: 'text before the tool',
    });
    await assert.rejects(() => recoveryFor(err), (thrown) => thrown === err);
});

// A completed send ends the outage the replay budget was covering, so the next
// request starts from a full budget again (codex resets retries per sampling
// request, cc's withRetry is per request, opencode schedules per stream call).
// Before the fix the budget was per ASK: one early blip left every later
// iteration of a long turn with zero replays.
test('the transport replay budget resets after a successful send', async () => {
    const responses = [
        closeErr(1006),
        closeErr(1000),
        { content: 'mid-turn progress', endTurn: false },
        closeErr(1006),
        closeErr(1000),
        { content: 'final answer' },
    ];
    let index = 0;
    const provider = {
        async send() {
            const next = responses[index++];
            if (next instanceof Error) throw next;
            return { usage: { inputTokens: 1, outputTokens: 1 }, ...next };
        },
    };
    const result = await agentLoop(
        provider,
        [{ role: 'user', content: 'hi' }],
        'fake-model',
        [{ name: 'list', annotations: { readOnlyHint: true } }],
        undefined,
        process.cwd(),
        { session: { owner: 'agent', agent: 'heavy-worker' } },
    );
    assert.equal(result.content, 'final answer');
    assert.equal(index, responses.length, 'every queued send was consumed');
});

// Provider-side last resort (openai-compat / gemini): re-issue the dead stream
// as a non-streaming request. Deliberately narrower than cc — only a stream
// that exposed nothing qualifies, because MixDog dispatches tools eagerly.
test('non-streaming fallback clears only unexposed, non-terminal failures', () => {
    const truncated = Object.assign(new Error('EOF'), {
        code: 'TRUNCATED_STREAM',
        truncatedStream: true,
    });
    assert.equal(canFallbackNonStreaming(closeErr(1006)), true);
    assert.equal(canFallbackNonStreaming(truncated), true);
    assert.equal(canFallbackNonStreaming(Object.assign(new Error('stall'), {
        code: 'ESTREAMSTALL',
        streamStalled: true,
    })), true);

    // Exposure / dispatch / completion / cancellation all fail closed.
    assert.equal(canFallbackNonStreaming(closeErr(1006, { liveTextEmitted: true })), false);
    assert.equal(canFallbackNonStreaming(closeErr(1006, { emittedToolCall: true })), false);
    assert.equal(canFallbackNonStreaming(closeErr(1000, { sawCompleted: true })), false);
    assert.equal(canFallbackNonStreaming(Object.assign(new Error('cancel'), { name: 'AbortError' })), false);
    assert.equal(canFallbackNonStreaming(Object.assign(new Error('bad request'), { httpStatus: 400 })), false);
    // An already-aborted turn is never re-issued.
    const aborted = AbortSignal.abort();
    assert.equal(canFallbackNonStreaming(closeErr(1006), { signal: aborted }), false);
});
