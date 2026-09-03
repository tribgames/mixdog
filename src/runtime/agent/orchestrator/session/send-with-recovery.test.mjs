// Retry visibility for replayed sends. A stalled stream is retried as a fresh
// request; without these guarantees the replay reports plain
// 'requesting'/'streaming' and the whole retry window renders as ordinary
// thinking, which is exactly how a ~20-minute stall passed for normal work.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// Trace writes resolve the data dir at import time; keep them in a temp root.
const root = mkdtempSync(join(tmpdir(), 'mixdog-send-recovery-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS = '0,0,0';
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const { sendWithRecovery, TRANSPORT_RETRY_MAX } = await import('./send-with-recovery.mjs');

function recordingOpts(extra = {}) {
    const stages = [];
    return {
        stages,
        opts: {
            onStageChange: (stage, detail) => {
                stages.push({ stage, attempt: detail?.attempt ?? null, message: detail?.message ?? null });
            },
            ...extra,
        },
    };
}

function providerEmitting(script) {
    return {
        send: async (_messages, _model, _tools, sendOpts) => {
            await script(sendOpts);
            return { content: 'ok' };
        },
    };
}

function cursorStreamAbort() {
    const error = new Error('Cursor stream was aborted');
    error.code = 'stream_aborted';
    error.cursorCode = 'stream_aborted';
    return error;
}

function committedToolHistory() {
    return [
        {
            role: 'assistant',
            tool_calls: [{
                id: 'call-complete',
                type: 'function',
                function: { name: 'read', arguments: '{"file_path":"done.txt"}' },
            }],
        },
        { role: 'tool', tool_call_id: 'call-complete', content: 'done' },
    ];
}

const baseCtx = {
    messages: [],
    model: 'test-model',
    sendTools: [],
    tools: [],
    sessionId: 'sess-retry-visibility',
    nextIteration: 1,
};

test('a replayed send reports reconnect progress instead of a plain request', async () => {
    const { stages, opts } = recordingOpts();
    const provider = providerEmitting((sendOpts) => sendOpts.onStageChange('requesting'));

    const result = await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 2 });

    assert.equal(result.action, 'proceed');
    assert.deepEqual(stages.map((entry) => entry.stage), ['reconnecting']);
    assert.equal(stages[0].attempt, 2);
    assert.equal(stages[0].message, `Reconnecting... 2/${TRANSPORT_RETRY_MAX}`);
});

test('the replacement stream ends the reconnect display on its first visible delta', async () => {
    const deltas = [];
    const { stages, opts } = recordingOpts({ onStreamDelta: (kind) => { deltas.push(kind); } });
    const provider = providerEmitting((sendOpts) => {
        sendOpts.onStageChange('requesting');
        sendOpts.onStreamDelta('text');
        sendOpts.onStageChange('streaming');
    });

    await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 1 });

    assert.deepEqual(stages.map((entry) => entry.stage), ['reconnecting', 'streaming', 'streaming']);
    // The caller's own delta observer still runs underneath the wrapper.
    assert.deepEqual(deltas, ['text']);
});

test('transport-level acknowledgements alone do not end the reconnect display', async () => {
    const { stages, opts } = recordingOpts();
    const provider = providerEmitting((sendOpts) => {
        sendOpts.onStageChange('requesting');
        // Connection/ack progress is not visible model output.
        sendOpts.onStreamDelta('transport');
        sendOpts.onStageChange('streaming');
    });

    await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 3 });

    assert.deepEqual(stages.map((entry) => entry.stage), ['reconnecting', 'reconnecting']);
});

test('a first attempt keeps its own stages and restores the caller callbacks', async () => {
    const { stages, opts } = recordingOpts({ onStreamDelta: () => {} });
    const originalStage = opts.onStageChange;
    const originalDelta = opts.onStreamDelta;
    const provider = providerEmitting((sendOpts) => {
        sendOpts.onStageChange('requesting');
        sendOpts.onStreamDelta('text');
        sendOpts.onStageChange('streaming');
    });

    await sendWithRecovery({ ...baseCtx, provider, opts, transportRetriesUsed: 0 });

    assert.deepEqual(stages.map((entry) => entry.stage), ['requesting', 'streaming']);
    assert.equal(opts.onStageChange, originalStage);
    assert.equal(opts.onStreamDelta, originalDelta);
});

test('a Cursor abort after committed tool history retries the empty continuation', async () => {
    const messages = committedToolHistory();
    const attempts = [];
    const { opts } = recordingOpts();
    const provider = {
        send: async (attemptMessages) => {
            attempts.push(attemptMessages);
            throw cursorStreamAbort();
        },
    };

    const result = await sendWithRecovery({
        ...baseCtx,
        provider,
        opts,
        messages,
        recoveryMessages: messages,
        transportRetriesUsed: 0,
    });

    assert.equal(result.action, 'retry_transport');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0], messages);
});

test('a Cursor abort retries a reasoning-only continuation after committed tool history', async () => {
    const messages = committedToolHistory();
    const abort = cursorStreamAbort();
    abort.emittedReasoning = true;
    const { opts } = recordingOpts();
    const provider = {
        send: async () => {
            throw abort;
        },
    };

    const result = await sendWithRecovery({
        ...baseCtx,
        provider,
        opts,
        messages,
        recoveryMessages: messages,
        transportRetriesUsed: 0,
    });

    assert.equal(result.action, 'retry_transport');
});

test('a Cursor abort retries visible text only after the owner retracts it', async () => {
    const abort = cursorStreamAbort();
    abort.partialContent = 'partial answer';
    abort.liveTextEmitted = true;
    const resets = [];
    const { opts } = recordingOpts({
        onTextDelta: () => {},
        onTextReset: async (detail) => {
            resets.push(detail);
            return true;
        },
    });
    const provider = {
        send: async (_messages, _model, _tools, sendOpts) => {
            sendOpts.onTextDelta(abort.partialContent);
            throw abort;
        },
    };

    const result = await sendWithRecovery({
        ...baseCtx,
        provider,
        opts,
        transportRetriesUsed: 0,
    });

    assert.equal(result.action, 'retry_transport');
    assert.deepEqual(resets, [{
        chars: abort.partialContent.length,
        reasoning: false,
        reason: 'loop-transport-retraction',
    }]);
});

test('a Cursor abort does not retry visible text when the owner rejects retraction', async () => {
    const abort = cursorStreamAbort();
    abort.partialContent = 'partial answer';
    abort.liveTextEmitted = true;
    let resetAttempts = 0;
    const { opts } = recordingOpts({
        onTextDelta: () => {},
        onTextReset: async () => {
            resetAttempts += 1;
            return false;
        },
    });
    const provider = {
        send: async (_messages, _model, _tools, sendOpts) => {
            sendOpts.onTextDelta(abort.partialContent);
            throw abort;
        },
    };

    await assert.rejects(
        sendWithRecovery({
            ...baseCtx,
            provider,
            opts,
            transportRetriesUsed: 0,
        }),
        (error) => error === abort,
    );
    assert.equal(resetAttempts, 1);
});

test('a Cursor abort does not replay a tool dispatched by the failing send', async () => {
    const abort = cursorStreamAbort();
    const { opts } = recordingOpts({ onToolCall: () => {} });
    const provider = {
        send: async (_messages, _model, _tools, sendOpts) => {
            sendOpts.onToolCall({ id: 'call-side-effect', name: 'shell', arguments: '{}' });
            throw abort;
        },
    };

    await assert.rejects(
        sendWithRecovery({
            ...baseCtx,
            provider,
            opts,
            transportRetriesUsed: 0,
        }),
        (error) => error === abort,
    );
});
