// Focused coverage for the append/coalesced turn-checkpoint journal that
// replaced the 150ms full growing-turn snapshot:
//   * prompt durability still lands synchronously on the first flush,
//   * replay reproduces the exact full-snapshot object (messages + partial
//     text/reasoning + tool pairing) at bounded write cost,
//   * crash-torn tails, stale journals, wholesale transcript rewrites,
//     cancellation and clear all keep latest-wins recovery semantics.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    appendFileSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// MIXDOG_DATA_DIR must be set before the modules resolve the checkpoint dir.
const root = mkdtempSync(join(tmpdir(), 'mixdog-turn-journal-'));
process.env.MIXDOG_DATA_DIR = root;
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const {
    clearTurnCheckpoint,
    createTurnCheckpointRecorder,
    projectTurnCheckpointMessages,
    readTurnCheckpoint,
    recoverTurnCheckpoint,
    settleTurnCheckpointWrites,
    turnMessagesForCheckpoint,
} = await import('./turn-checkpoint.mjs');
const {
    _setJournalOpGateForTest,
    turnCheckpointPath,
    turnJournalPath,
} = await import('./turn-checkpoint-journal.mjs');
const {
    createTurnInterruptionTracker,
    finalizeTurnInterruptionSnapshot,
} = await import('./turn-interruption.mjs');
const {
    recordProviderContextBaseline,
    resolveCompactionPressureTokens,
    resolveWorkerCompactPolicy,
    shouldCompactForSession,
} = await import('../loop/compact-policy.mjs');
const { estimateMessagesTokens } = await import('../context-utils.mjs');

function startTurn(sessionId, prompt = 'do the thing') {
    const tracker = createTurnInterruptionTracker();
    const outgoing = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: prompt },
    ];
    const recorder = createTurnCheckpointRecorder({
        sessionId,
        generation: 3,
        turnToken: `tok-${sessionId}`,
        startedAt: 1000,
    });
    const flush = () => recorder.record({
        currentUserContent: prompt,
        turnOutgoing: outgoing,
        interruption: tracker,
    });
    return { tracker, outgoing, recorder, flush, prompt };
}

/**
 * Hold every async journal operation in the write lane so reset/clear/stop/
 * overflow can be driven while a write is GENUINELY in flight (entry.writing
 * is true and its bytes are not on disk) instead of after settlement.
 */
function holdJournalWrites() {
    let open = () => {};
    const gate = new Promise((resolve) => { open = resolve; });
    let released = false;
    _setJournalOpGateForTest(() => gate);
    return {
        release() {
            if (released) return;
            released = true;
            _setJournalOpGateForTest(null);
            open();
        },
    };
}

test('first flush anchors the prompt synchronously', () => {
    const sessionId = 'sess-anchor';
    const turn = startTurn(sessionId);
    assert.equal(turn.flush(), true);
    // No await: the header is the crash-durability anchor and must be on disk
    // before the provider call returns control.
    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.turnToken, `tok-${sessionId}`);
    assert.equal(checkpoint.generation, 3);
    assert.deepEqual(checkpoint.turnMessages, [{ role: 'user', content: 'do the thing' }]);
});

test('journal replay reproduces the full snapshot at bounded cost', async () => {
    const sessionId = 'sess-replay';
    const turn = startTurn(sessionId);
    turn.flush();
    const headerBytes = statSync(turnCheckpointPath(sessionId)).size;
    const body = 'x'.repeat(2000);
    for (let i = 0; i < 40; i += 1) {
        turn.tracker.recordTextDelta(`chunk-${i} `);
        const call = { id: `call-${i}`, name: 'shell', arguments: '{}' };
        turn.outgoing.push({ role: 'assistant', content: `${body}${i}`, toolCalls: [call] });
        turn.tracker.recordToolCalls([call]);
        turn.outgoing.push({ role: 'tool', content: body, toolCallId: call.id });
        turn.flush();
    }
    await settleTurnCheckpointWrites(sessionId);

    // The header is written exactly once per turn — it still holds only the
    // opening prompt, so the growing turn never rewrites it.
    assert.equal(statSync(turnCheckpointPath(sessionId)).size, headerBytes);
    const checkpoint = readTurnCheckpoint(sessionId);
    assert.deepEqual(
        checkpoint.turnMessages,
        turnMessagesForCheckpoint(turn.outgoing, turn.prompt),
    );
    assert.deepEqual(checkpoint.interruption, turn.tracker.snapshot());

    // Bounded cost: total bytes written stay proportional to the turn payload
    // instead of flushes x turn size (the old writer re-serialized everything
    // on every flush, ~40x this volume for the same turn).
    const payloadBytes = Buffer.byteLength(JSON.stringify(checkpoint.turnMessages));
    const journalBytes = statSync(turnJournalPath(sessionId)).size;
    assert.ok(
        journalBytes < payloadBytes * 2,
        `journal ${journalBytes} bytes should stay near payload ${payloadBytes} bytes`,
    );
});

test('crash recovery matches the live finalize path (text reset, tool pairing)', async () => {
    const sessionId = 'sess-recover';
    const prompt = 'run the tool';
    const turn = startTurn(sessionId, prompt);
    turn.flush();
    turn.tracker.markProviderSendStarted();
    turn.tracker.recordTextDelta('partial answer');
    turn.tracker.recordReasoningDelta('thinking');
    turn.flush();
    // A UI-acknowledged reset tombstones the tail; a crash cannot complete the
    // replacement, so the same visible bytes must survive.
    turn.tracker.tombstoneText(7);
    turn.flush();
    const call = { id: 'call-a', name: 'read', arguments: '{}' };
    turn.tracker.recordToolCalls([call]);
    turn.outgoing.push({ role: 'assistant', content: '', toolCalls: [call] });
    turn.tracker.markToolPhaseStarted();
    turn.tracker.recordToolResult({ toolCallId: 'call-a', content: 'early', __earlyNotify: true });
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.deepEqual(checkpoint.interruption, turn.tracker.snapshot());
    assert.equal(checkpoint.interruption.partialAssistantContent, 'partial answer');

    const session = {
        id: sessionId,
        generation: 3,
        updatedAt: 0,
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        contextWindow: 272_000,
        compactBoundaryTokens: 272_000,
        compaction: { auto: true },
        tools: [],
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: prompt }],
        activeTurnCheckpoint: { turnToken: `tok-${sessionId}` },
        _providerPrefixGuardState: { messageHashes: ['stale'], requestPrefixHash: 'stale' },
        contextPressureBaselineTokens: 300_000,
        contextPressureBaselineOutputTokens: 0,
        contextPressureBaselineMessageCount: 2,
        contextPressureBaselinePrefixSignature: 'stale-prefix',
        contextPressureBaselineProvider: 'openai-oauth',
        contextPressureBaselineModel: 'gpt-5.6-sol',
        contextPressureBaselineToolSignature: 'stale-tools',
        contextPressureBaselineBoundary: 'complete',
        contextPressureBaselineUpdatedAt: Date.now(),
        lastContextTokensStaleAfterCompact: false,
    };
    const staleBaselineUpdatedAt = session.contextPressureBaselineUpdatedAt;
    const recovery = recoverTurnCheckpoint(session);
    assert.equal(recovery.recovered, true);
    // A recovered (rewritten) transcript must never keep the mid-turn provider
    // prefix snapshot: a stale one flags every following send as
    // history_shrink ("Session state changed unexpectedly.").
    assert.equal(Object.prototype.hasOwnProperty.call(session, '_providerPrefixGuardState'), false);
    // Keep the saved reading so a matching durable prefix can still use it.
    // This deliberately stale signature must instead be rejected by pressure
    // resolution without mutating the persisted provider snapshot.
    assert.equal(session.contextPressureBaselineTokens, 300_000);
    assert.equal(session.contextPressureBaselineMessageCount, 2);
    assert.equal(session.contextPressureBaselinePrefixSignature, 'stale-prefix');
    assert.equal(session.contextPressureBaselineToolSignature, 'stale-tools');
    assert.equal(session.contextPressureBaselineUpdatedAt, staleBaselineUpdatedAt);
    assert.equal(session.lastContextTokensStaleAfterCompact, false);
    const expected = finalizeTurnInterruptionSnapshot({
        turnOutgoing: checkpoint.turnMessages,
        currentUserContent: checkpoint.currentUserContent,
        snapshot: turn.tracker.snapshot(),
        abortReason: 'process-crash',
    });
    assert.deepEqual(session.messages, [{ role: 'system', content: 'sys' }, ...expected.messages]);
    assert.equal(session.messages.at(-1).content, '[Request interrupted by process restart]');
    // Every observed call is paired with a result in the recovered transcript.
    assert.ok(session.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call-a'));
    const policy = resolveWorkerCompactPolicy(session, session.tools);
    const messageTokensEst = estimateMessagesTokens(session.messages);
    const pressureTokens = resolveCompactionPressureTokens(messageTokensEst, policy, {
        messages: session.messages,
        sessionRef: session,
    });
    assert.ok(pressureTokens < policy.triggerTokens);
    assert.equal(
        shouldCompactForSession(messageTokensEst, policy, {
            messages: session.messages,
            sessionRef: session,
            pressureTokens,
        }),
        false,
    );
});

test('crash recovery preserves a provider baseline for a matching durable prefix', async () => {
    const sessionId = 'sess-baseline-prefix';
    const prompt = 'resume from provider baseline';
    const turn = startTurn(sessionId, prompt);
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);

    const session = {
        id: sessionId,
        generation: 3,
        updatedAt: 0,
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        contextWindow: 272_000,
        compactBoundaryTokens: 272_000,
        compaction: { auto: true },
        tools: [],
        messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: prompt }],
        activeTurnCheckpoint: { turnToken: `tok-${sessionId}` },
    };
    assert.equal(recordProviderContextBaseline(
        session,
        session.messages.slice(0, 1),
        { promptTokens: 210_000, outputTokens: 1_200 },
        { sendTools: session.tools },
    ), true);
    const baselineUpdatedAt = session.contextPressureBaselineUpdatedAt;

    const recovery = recoverTurnCheckpoint(session);
    assert.equal(recovery.recovered, true);
    assert.equal(session.contextPressureBaselineTokens, 211_200);
    assert.equal(session.contextPressureBaselineMessageCount, 1);
    assert.equal(session.contextPressureBaselineUpdatedAt, baselineUpdatedAt);
    assert.equal(session.lastContextTokensStaleAfterCompact, false);

    const policy = resolveWorkerCompactPolicy(session, session.tools);
    const messageTokensEst = estimateMessagesTokens(session.messages);
    const pressureTokens = resolveCompactionPressureTokens(messageTokensEst, policy, {
        messages: session.messages,
        sessionRef: session,
    });
    assert.ok(pressureTokens > 211_200);
    assert.ok(pressureTokens < policy.triggerTokens);
    assert.equal(
        shouldCompactForSession(messageTokensEst, policy, {
            messages: session.messages,
            sessionRef: session,
            pressureTokens,
        }),
        false,
    );
});

test('a crash-torn trailing record is discarded and the durable prefix survives', async () => {
    const sessionId = 'sess-torn';
    const turn = startTurn(sessionId);
    turn.flush();
    turn.tracker.recordTextDelta('durable text');
    turn.outgoing.push({ role: 'assistant', content: 'committed' });
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);
    appendFileSync(turnJournalPath(sessionId), '{"t":"m","i":2,"m":{"role":"tool","con');

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.turnMessages.length, 2);
    assert.equal(checkpoint.turnMessages[1].content, 'committed');
    assert.equal(checkpoint.interruption.partialAssistantContent, 'durable text');
});

test('a journal from another turn never replays onto a new header', async () => {
    const sessionId = 'sess-stale';
    const turn = startTurn(sessionId);
    turn.flush();
    turn.tracker.recordTextDelta('old turn text');
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);
    const header = JSON.parse(readFileSync(turnCheckpointPath(sessionId), 'utf8'));
    writeFileSync(
        turnCheckpointPath(sessionId),
        JSON.stringify({ ...header, turnToken: 'other-token' }),
        'utf8',
    );

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.turnToken, 'other-token');
    assert.equal(checkpoint.interruption.partialAssistantContent, '');
});

test('rewritten and truncated transcripts replay latest-wins', async () => {
    const sessionId = 'sess-rewrite';
    const turn = startTurn(sessionId);
    turn.flush();
    turn.outgoing.push({ role: 'assistant', content: 'first' }, { role: 'assistant', content: 'second' });
    turn.flush();
    // Wholesale replacement (image-strip splice / pre-send compaction).
    turn.outgoing.splice(
        0,
        turn.outgoing.length,
        { role: 'system', content: 'sys' },
        { role: 'user', content: turn.prompt },
        { role: 'assistant', content: 'rewritten' },
    );
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.deepEqual(checkpoint.turnMessages, [
        { role: 'user', content: turn.prompt },
        { role: 'assistant', content: 'rewritten' },
    ]);
});

test('compaction that removes the opening prompt checkpoints the full replacement', async () => {
    const sessionId = 'sess-full-compaction';
    const turn = startTurn(sessionId);
    turn.flush();
    const compacted = [
        { role: 'user', content: '[context compacted]' },
        { role: 'assistant', content: 'durable compact summary' },
    ];
    turn.outgoing.splice(0, turn.outgoing.length, ...compacted);
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.fullTranscript, true);
    assert.deepEqual(checkpoint.turnMessages, compacted);

    const stored = {
        id: sessionId,
        generation: 3,
        updatedAt: 0,
        messages: [
            { role: 'system', content: 'stale system' },
            { role: 'user', content: turn.prompt },
        ],
        activeTurnCheckpoint: { turnToken: `tok-${sessionId}` },
    };
    assert.deepEqual(projectTurnCheckpointMessages(stored, checkpoint), compacted);

    const recovered = structuredClone(stored);
    const recovery = recoverTurnCheckpoint(recovered);
    assert.equal(recovery.recovered, true);
    assert.deepEqual(recovered.messages, compacted);
});

test('clear is token-guarded and removes header + journal', async () => {
    const sessionId = 'sess-clear';
    const turn = startTurn(sessionId);
    turn.flush();
    turn.tracker.recordTextDelta('x');
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);

    assert.equal(clearTurnCheckpoint(sessionId, 'someone-elses-token'), false);
    assert.ok(existsSync(turnCheckpointPath(sessionId)));
    assert.equal(clearTurnCheckpoint(sessionId, `tok-${sessionId}`), true);
    assert.equal(existsSync(turnCheckpointPath(sessionId)), false);
    assert.equal(existsSync(turnJournalPath(sessionId)), false);
    assert.equal(readTurnCheckpoint(sessionId), null);
});

// ── In-flight write races (regressions) ─────────────────────────────────────

test('a new turn fences an older IN-FLIGHT append (no stale turn under a new token)', async () => {
    const sessionId = 'sess-fence';
    const first = startTurn(sessionId, 'first prompt');
    first.flush();
    const hold = holdJournalWrites();
    let during;
    let second;
    try {
        first.outgoing.push({ role: 'assistant', content: 'STALE_OLD_TURN' });
        first.tracker.recordTextDelta('STALE_OLD_TURN partial');
        first.flush(); // genuinely in flight: accepted, not on disk
        first.recorder.stop();

        second = createTurnCheckpointRecorder({
            sessionId,
            generation: 3,
            turnToken: 'tok-second',
            startedAt: 2000,
        });
        const secondOutgoing = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'second prompt' },
        ];
        assert.equal(second.record({
            currentUserContent: 'second prompt',
            turnOutgoing: secondOutgoing,
            interruption: createTurnInterruptionTracker(),
        }), true);
        // Interim window: header is the new turn, the journal is still the old
        // one. Replay must reject it rather than merge an old turn.
        during = readTurnCheckpoint(sessionId);
    } finally {
        hold.release();
    }
    assert.equal(during.turnToken, 'tok-second');
    assert.ok(!JSON.stringify(during).includes('STALE_OLD_TURN'));

    await settleTurnCheckpointWrites(sessionId);
    const after = readTurnCheckpoint(sessionId);
    assert.equal(after.turnToken, 'tok-second');
    assert.ok(!JSON.stringify(after).includes('STALE_OLD_TURN'), 'old turn replayed under the new token');
    assert.deepEqual(after.turnMessages, [{ role: 'user', content: 'second prompt' }]);
    const journal = readFileSync(turnJournalPath(sessionId), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(journal[0]).turnToken, 'tok-second');
    assert.ok(!journal.some((line) => line.includes('STALE_OLD_TURN')));
});

test('overflow never writes ahead of an older IN-FLIGHT append (latest-wins holds)', async () => {
    const sessionId = 'sess-overflow';
    const turn = startTurn(sessionId);
    turn.flush();
    const headBytes = statSync(turnJournalPath(sessionId)).size;
    const hold = holdJournalWrites();
    try {
        turn.outgoing.push({ role: 'assistant', content: 'OLD_IN_FLIGHT' });
        turn.flush(); // in flight
        // >4MB of NEWER records queue behind it and cross the overflow ceiling.
        const filler = 'y'.repeat(512 * 1024);
        for (let i = 0; i < 9; i += 1) {
            turn.outgoing[2] = { role: 'assistant', content: `${filler}-${i}` };
            turn.flush();
        }
        turn.outgoing[2] = { role: 'assistant', content: 'NEWEST' };
        turn.flush();
        // Nothing may reach disk while an older write is outstanding.
        assert.equal(
            statSync(turnJournalPath(sessionId)).size,
            headBytes,
            'overflow drain overtook an in-flight append',
        );
    } finally {
        hold.release();
    }
    await settleTurnCheckpointWrites(sessionId);
    const checkpoint = readTurnCheckpoint(sessionId);
    assert.deepEqual(checkpoint.turnMessages[1], { role: 'assistant', content: 'NEWEST' });
});

test('explicit process exit flushes in-flight AND queued deltas in order', () => {
    const sessionId = 'sess-exit';
    const source = `
const checkpoint = await import(${JSON.stringify(new URL('./turn-checkpoint.mjs', import.meta.url).href)});
const journal = await import(${JSON.stringify(new URL('./turn-checkpoint-journal.mjs', import.meta.url).href)});
const interruption = await import(${JSON.stringify(new URL('./turn-interruption.mjs', import.meta.url).href)});
const sessionId = ${JSON.stringify(sessionId)};
const prompt = 'exit prompt';
const tracker = interruption.createTurnInterruptionTracker();
const outgoing = [{ role: 'system', content: 'sys' }, { role: 'user', content: prompt }];
const recorder = checkpoint.createTurnCheckpointRecorder({ sessionId, generation: 3, turnToken: 'tok-exit', startedAt: 1000 });
const flush = () => recorder.record({ currentUserContent: prompt, turnOutgoing: outgoing, interruption: tracker });
flush();
// Never resolves: the next append stays in flight, the one after it queues.
journal._setJournalOpGateForTest(() => new Promise(() => {}));
tracker.recordTextDelta('IN_FLIGHT ');
outgoing.push({ role: 'assistant', content: 'IN_FLIGHT_MESSAGE' });
flush();
tracker.recordTextDelta('QUEUED');
outgoing.push({ role: 'tool', content: 'QUEUED_MESSAGE', toolCallId: 'call-q' });
flush();
process.exit(0);
`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
        encoding: 'utf8',
        env: { ...process.env, MIXDOG_DATA_DIR: root },
    });
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.turnMessages.length, 3, 'exit persisted only the journal head');
    assert.equal(checkpoint.turnMessages[1].content, 'IN_FLIGHT_MESSAGE');
    assert.equal(checkpoint.turnMessages[2].content, 'QUEUED_MESSAGE');
    assert.equal(checkpoint.interruption.partialAssistantContent, 'IN_FLIGHT QUEUED');
});

test('clear while a write is IN FLIGHT drops the header now and the journal after', async () => {
    const sessionId = 'sess-clear-race';
    const turn = startTurn(sessionId);
    turn.flush();
    const hold = holdJournalWrites();
    try {
        turn.outgoing.push({ role: 'assistant', content: 'inflight' });
        turn.flush();
        assert.equal(clearTurnCheckpoint(sessionId, `tok-${sessionId}`), true);
        // The header is the recovery gate; it must be gone immediately.
        assert.equal(existsSync(turnCheckpointPath(sessionId)), false);
        assert.equal(readTurnCheckpoint(sessionId), null);
    } finally {
        hold.release();
    }
    await settleTurnCheckpointWrites(sessionId);
    assert.equal(existsSync(turnJournalPath(sessionId)), false, 'in-flight append resurrected the journal');
    assert.equal(readTurnCheckpoint(sessionId), null);
});

test('stop while a write is IN FLIGHT keeps that write and drops only queued deltas', async () => {
    const sessionId = 'sess-stop-race';
    const turn = startTurn(sessionId);
    turn.flush();
    const hold = holdJournalWrites();
    try {
        turn.outgoing.push({ role: 'assistant', content: 'inflight-kept' });
        turn.flush(); // in flight
        turn.outgoing.push({ role: 'assistant', content: 'queued-dropped' });
        turn.flush(); // queued
        turn.recorder.stop();
        assert.equal(turn.flush(), false);
    } finally {
        hold.release();
    }
    await settleTurnCheckpointWrites(sessionId);
    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.turnMessages.length, 2);
    assert.equal(checkpoint.turnMessages[1].content, 'inflight-kept');
    assert.ok(!JSON.stringify(checkpoint).includes('queued-dropped'));
});

test('replay skips a duplicated re-flushed record and stops at a real gap', async () => {
    const sessionId = 'sess-seq';
    const turn = startTurn(sessionId);
    turn.flush();
    turn.outgoing.push({ role: 'assistant', content: 'first' });
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);
    const lines = readFileSync(turnJournalPath(sessionId), 'utf8').trim().split('\n');
    // Exit-handler style duplicate of the last accepted record, then a record
    // from beyond the durable prefix.
    appendFileSync(turnJournalPath(sessionId), `${lines[lines.length - 1]}\n`);
    appendFileSync(
        turnJournalPath(sessionId),
        `${JSON.stringify({ t: 'm', i: 2, m: { role: 'assistant', content: 'after-gap' }, s: 99 })}\n`,
    );

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.turnMessages.length, 2);
    assert.equal(checkpoint.turnMessages[1].content, 'first');
    assert.ok(!JSON.stringify(checkpoint).includes('after-gap'));
});

test('stop retires further flushes without dropping the durable prefix', async () => {
    const sessionId = 'sess-stop';
    const turn = startTurn(sessionId);
    turn.flush();
    turn.tracker.recordTextDelta('durable');
    turn.flush();
    await settleTurnCheckpointWrites(sessionId);

    turn.tracker.recordTextDelta('-late');
    turn.recorder.stop();
    assert.equal(turn.flush(), false);
    await settleTurnCheckpointWrites(sessionId);

    const checkpoint = readTurnCheckpoint(sessionId);
    assert.equal(checkpoint.interruption.partialAssistantContent, 'durable');
    assert.deepEqual(checkpoint.turnMessages, [{ role: 'user', content: 'do the thing' }]);
});
