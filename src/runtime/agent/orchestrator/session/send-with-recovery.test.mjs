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
