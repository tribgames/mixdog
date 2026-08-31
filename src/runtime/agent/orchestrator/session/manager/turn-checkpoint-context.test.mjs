import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-context-'));
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const {
    captureTurnCheckpointContextState,
    createTurnCheckpointRecorder,
    readTurnCheckpoint,
    recoverTurnCheckpoint,
    settleTurnCheckpointWrites,
} = await import('./turn-checkpoint.mjs');
const { createTurnInterruptionTracker } = await import('./turn-interruption.mjs');
const {
    recordContextUsageSnapshot,
    recordProviderContextBaseline,
    resolveCompactionPressureTokens,
    resolveWorkerCompactPolicy,
    shouldCompactForSession,
} = await import('../loop/compact-policy.mjs');
const { estimateMessagesTokens } = await import('../context-utils.mjs');

function createSession(sessionId, messages) {
    return {
        id: sessionId,
        generation: 1,
        updatedAt: 0,
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        contextWindow: 272_000,
        compactBoundaryTokens: 272_000,
        compaction: { auto: true },
        tools: [],
        messages,
    };
}

function openTurn(session, prompt) {
    const tracker = createTurnInterruptionTracker();
    const recorder = createTurnCheckpointRecorder({
        sessionId: session.id,
        generation: session.generation,
        turnToken: `tok-${session.id}`,
        startedAt: 1_000,
    });
    const flush = (contextState = null) => recorder.record({
        currentUserContent: prompt,
        turnOutgoing: session.messages,
        interruption: tracker,
        contextState,
    });
    session.activeTurnCheckpoint = {
        turnToken: `tok-${session.id}`,
        startedAt: 1_000,
    };
    flush();
    return { tracker, recorder, flush };
}

function contextDecision(session) {
    const policy = resolveWorkerCompactPolicy(session, session.tools);
    const estimate = estimateMessagesTokens(session.messages);
    const pressure = resolveCompactionPressureTokens(estimate, policy, {
        messages: session.messages,
        sessionRef: session,
    });
    return {
        estimate,
        pressure,
        policy,
        shouldCompact: shouldCompactForSession(estimate, policy, {
            messages: session.messages,
            sessionRef: session,
            pressureTokens: pressure,
        }),
    };
}

test('restart restores the durable 132K provider anchor instead of jumping to a 476K estimate', async () => {
    const prompt = 'continue the exact unfinished work';
    const hugeHistory = 'historic provider-visible context '.repeat(90_000);
    const messages = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'earlier task' },
        { role: 'assistant', content: hugeHistory },
        { role: 'user', content: prompt },
    ];
    const live = createSession('sess-132k-parity', messages);
    const turn = openTurn(live, prompt);

    assert.equal(recordProviderContextBaseline(
        live,
        live.messages,
        { promptTokens: 131_500, outputTokens: 500 },
        { boundary: 'request', sendTools: live.tools },
    ), true);
    turn.flush(captureTurnCheckpointContextState(live, live.messages, prompt));
    turn.tracker.markProviderSendStarted();
    turn.tracker.recordTextDelta('durable partial response');
    turn.flush(captureTurnCheckpointContextState(live, live.messages, prompt));
    await settleTurnCheckpointWrites(live.id);

    const checkpoint = readTurnCheckpoint(live.id);
    assert.equal(checkpoint.contextState.kind, 'provider');
    assert.equal(checkpoint.contextState.usedTokens, 132_000);

    const restarted = createSession(live.id, structuredClone(messages));
    restarted.activeTurnCheckpoint = { turnToken: `tok-${live.id}` };
    restarted.lastContextTokens = 132_000;
    const recovery = recoverTurnCheckpoint(restarted);
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.contextStateRestored, true);
    assert.equal(restarted.contextPressureBaselineSource, 'checkpoint_provider');

    const decision = contextDecision(restarted);
    assert.ok(decision.estimate > 476_000, `expected incident-scale estimate, got ${decision.estimate}`);
    assert.ok(decision.pressure >= 132_000 && decision.pressure < 133_000);
    assert.equal(decision.shouldCompact, false);
    assert.ok(restarted.messages.some((message) => (
        message.role === 'assistant'
        && String(message.content).includes('durable partial response')
    )));
});

test('mid-tool restart keeps completed history and repairs only the interrupted tail', async () => {
    const prompt = 'run one more tool';
    const completed = [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'completed request' },
        { role: 'assistant', content: 'completed answer' },
    ];
    const live = createSession('sess-mid-tool-parity', [
        ...structuredClone(completed),
        { role: 'user', content: prompt },
    ]);
    const turn = openTurn(live, prompt);
    assert.equal(recordProviderContextBaseline(
        live,
        live.messages,
        { promptTokens: 89_500, outputTokens: 500 },
        { boundary: 'request', sendTools: live.tools },
    ), true);
    turn.flush(captureTurnCheckpointContextState(live, live.messages, prompt));

    const call = { id: 'call-read', name: 'read', arguments: '{"file_path":"work.txt"}' };
    live.messages.push({ role: 'assistant', content: '', toolCalls: [call] });
    turn.tracker.recordToolCalls([call]);
    turn.tracker.markToolPhaseStarted();
    turn.flush(captureTurnCheckpointContextState(live, live.messages, prompt));
    await settleTurnCheckpointWrites(live.id);

    const restarted = createSession(live.id, [
        ...structuredClone(completed),
        { role: 'user', content: prompt },
    ]);
    restarted.activeTurnCheckpoint = { turnToken: `tok-${live.id}` };
    const recovery = recoverTurnCheckpoint(restarted);
    assert.equal(recovery.contextStateRestored, true);
    assert.deepEqual(restarted.messages.slice(0, completed.length), completed);
    assert.ok(restarted.messages.some((message) => (
        message.role === 'tool' && message.toolCallId === call.id
    )));

    const decision = contextDecision(restarted);
    assert.ok(decision.pressure >= 90_000 && decision.pressure < 95_000);
    assert.equal(decision.shouldCompact, false);
});

test('post-compact replacement and its pressure snapshot recover as one canonical record', async () => {
    const prompt = 'compact this turn';
    const live = createSession('sess-post-compact-parity', [
        { role: 'system', content: 'old system' },
        { role: 'user', content: prompt },
    ]);
    live.usageMetricsTurnId = 'turn-compact';
    live.usageMetricsEpoch = 4;
    const turn = openTurn(live, prompt);
    const compacted = [
        { role: 'system', content: 'current system' },
        { role: 'user', content: 'authoritative compact handoff' },
        { role: 'assistant', content: 'preserved recent answer' },
    ];
    live.messages.splice(0, live.messages.length, ...compacted);
    const policy = resolveWorkerCompactPolicy(live, live.tools);
    recordContextUsageSnapshot(live, policy, {
        messages: live.messages,
        usedTokens: 23_000,
        source: 'post_compact',
    });
    turn.flush(captureTurnCheckpointContextState(live, live.messages, prompt));
    await settleTurnCheckpointWrites(live.id);

    const checkpoint = readTurnCheckpoint(live.id);
    assert.equal(checkpoint.fullTranscript, true);
    assert.equal(checkpoint.contextState.kind, 'post_compact');

    const restarted = createSession(live.id, [
        { role: 'system', content: 'stale system' },
        { role: 'user', content: prompt },
    ]);
    restarted.activeTurnCheckpoint = { turnToken: `tok-${live.id}` };
    const recovery = recoverTurnCheckpoint(restarted);
    assert.equal(recovery.contextStateRestored, true);
    assert.deepEqual(restarted.messages, compacted);
    assert.equal(restarted.contextPressureBaselineSource, 'checkpoint_post_compact');
    assert.equal(restarted.contextUsageSnapshot.usedTokens, 23_000);
    assert.equal(restarted.usageMetricsTurnId, 'turn-compact');
    assert.equal(restarted.usageMetricsEpoch, 4);

    const decision = contextDecision(restarted);
    assert.equal(decision.pressure, 23_000);
    assert.equal(decision.shouldCompact, false);
});
