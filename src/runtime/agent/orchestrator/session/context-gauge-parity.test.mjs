import assert from 'node:assert/strict';
import test from 'node:test';

import { createContextStatus } from '../../../../session-runtime/context-status.mjs';
import { sessionContextSnapshotProjection } from '../../../../tui/session/session-api-ext.mjs';
import { estimateMessagesTokens } from './context-utils.mjs';
import {
    recordContextUsageSnapshot,
    recordProviderContextBaseline,
    resolveWorkerCompactPolicy,
    shouldCompactForSession,
} from './loop/compact-policy.mjs';
import { _sessionForDisk } from './store/serialize.mjs';

// One session state must produce ONE context number on every surface that
// shows it: the live gauge, the same session read back from disk, the stats
// every UI subscribes to, and the numerator auto-compaction decides on.
// Divergence here is what users see as a gauge that contradicts itself and a
// compaction that fires with the window three quarters empty.

function imagePart() {
    return {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(400) },
    };
}

function sessionWith(messages, extra = {}) {
    return {
        id: 'sess_context_parity',
        provider: 'anthropic-oauth',
        model: 'claude-opus-5',
        contextWindow: 500_000,
        compactBoundaryTokens: 500_000,
        compaction: { auto: true },
        tools: [],
        messages,
        ...extra,
    };
}

function statusOf(session) {
    return createContextStatus({
        getSession: () => session,
        getRoute: () => ({
            provider: session.provider,
            model: session.model,
            contextWindow: session.contextWindow,
        }),
        getCurrentCwd: () => 'C:\\Project\\mixdog',
        getMode: () => 'full',
    }).contextStatus();
}

/** Exactly what a cold reader (desktop pane, session.read on an unloaded
 *  session, history load) sees: the disk projection, parsed back. */
function afterDiskRoundTrip(session) {
    return JSON.parse(JSON.stringify(_sessionForDisk(session)));
}

function anchorTo(session, messages, promptTokens, outputTokens = 500) {
    recordProviderContextBaseline(session, messages, {
        inputTokens: promptTokens,
        outputTokens,
        cachedTokens: 0,
        cacheWriteTokens: 0,
    }, { boundary: 'complete', sendTools: session.tools });
    session.lastContextTokens = promptTokens;
    session.lastContextTokensUpdatedAt = Date.now();
    session.lastContextTokensStaleAfterCompact = false;
}

test('one transcript reports one number before and after the disk round-trip', () => {
    const messages = [
        { role: 'system', content: 'operating rules '.repeat(200) },
        { role: 'user', content: [imagePart(), { type: 'text', text: 'describe this '.repeat(200) }] },
        { role: 'assistant', content: 'a considered answer '.repeat(600) },
    ];
    const session = sessionWith(messages);
    anchorTo(session, messages, 120_000);

    const live = statusOf(session);
    const cold = statusOf(afterDiskRoundTrip(session));

    assert.equal(live.usedSource, 'provider');
    assert.equal(cold.usedSource, 'provider');
    assert.equal(cold.usedTokens, live.usedTokens);
    assert.equal(cold.usedTokens, 120_500);
});

test('the published stats every surface subscribes to carry the gauge number', () => {
    const messages = [
        { role: 'user', content: 'question '.repeat(300) },
        { role: 'assistant', content: 'answer '.repeat(300) },
    ];
    const session = sessionWith(messages);
    anchorTo(session, messages, 64_000);

    const status = statusOf(session);
    const projection = sessionContextSnapshotProjection(session, status);

    assert.equal(projection.stats.currentEstimatedContextTokens, status.usedTokens);
    assert.equal(projection.stats.currentContextSource, status.usedSource);
    assert.equal(projection.autoCompactTokenLimit, status.compaction.triggerTokens);
});

test('a mid-turn snapshot never reports a multiple of the prompt the provider measured', () => {
    // The turn started on a long transcript, compaction replaced the working
    // array, and `session.messages` still holds the pre-turn copy until commit.
    const preTurnHistory = [
        { role: 'system', content: 'rules '.repeat(100) },
        { role: 'user', content: 'a long finished conversation '.repeat(9_000) },
    ];
    const workingTranscript = [
        { role: 'system', content: 'rules '.repeat(100) },
        { role: 'user', content: 'compacted summary '.repeat(200) },
    ];
    const session = sessionWith(preTurnHistory, {
        contextWindow: 50_000,
        compactBoundaryTokens: 50_000,
        liveTurnMessages: workingTranscript,
        activeTurnCheckpoint: { version: 1, turnToken: 'tok' },
    });
    anchorTo(session, workingTranscript, 30_000);

    const cold = statusOf(afterDiskRoundTrip(session));

    assert.ok(
        estimateMessagesTokens(preTurnHistory) > 50_000,
        'fixture must be large enough that the old estimate would exceed the window',
    );
    assert.equal(cold.usedSource, 'provider_resume');
    assert.ok(cold.usedTokens <= 50_000, `cold gauge exceeded the window: ${cold.usedTokens}`);
    assert.ok(
        Math.abs(cold.usedTokens - 30_500) <= 1_000,
        `cold gauge drifted from the measured prompt: ${cold.usedTokens}`,
    );
});

test('a settled session keeps its measured reading however long it sat idle', () => {
    const messages = [
        { role: 'system', content: 'rules '.repeat(50) },
        { role: 'user', content: 'question '.repeat(500) },
    ];
    const session = sessionWith(messages);
    // The provider measured this prompt as the request went out...
    recordProviderContextBaseline(session, messages, {
        inputTokens: 88_000,
        outputTokens: 900,
        cachedTokens: 0,
        cacheWriteTokens: 0,
    }, { boundary: 'request', sendTools: [] });
    session.lastContextTokens = 88_000;
    session.lastContextTokensUpdatedAt = Date.now();
    // ...and the turn then appended the answer that same reading already billed.
    messages.push({ role: 'assistant', content: 'answer '.repeat(300) });
    // Two hours pass before the pane is opened again. The session did nothing
    // in between, so its measurement is still the best evidence there is.
    const settledAt = Date.now() - 2 * 60 * 60 * 1000;
    session.contextPressureBaselineUpdatedAt = settledAt;
    session.lastContextTokensUpdatedAt = settledAt;
    session.updatedAt = settledAt;

    const status = statusOf(session);
    assert.equal(status.usedSource, 'provider');
    assert.equal(status.usedTokens, 88_900);

    // A session that kept WORKING for half an hour past its last reading is the
    // case the staleness rule exists for: usage recording is not keeping up, so
    // the anchor stops being evidence.
    const working = {
        ...session,
        updatedAt: settledAt + 45 * 60 * 1000,
        messages: [...messages, { role: 'user', content: 'work that never reached a request' }],
    };
    assert.equal(statusOf(working).usedSource, 'estimated');
});

test('an estimate never reports itself as a provider reading', () => {
    const messages = [
        { role: 'user', content: 'unmeasured conversation '.repeat(400) },
        { role: 'assistant', content: 'unmeasured reply '.repeat(400) },
    ];
    const fresh = sessionWith(messages);
    assert.equal(statusOf(fresh).usedSource, 'estimated');

    const compacted = sessionWith(messages);
    anchorTo(compacted, messages, 90_000);
    compacted.compaction = { ...compacted.compaction, lastChangedAt: Date.now() + 1 };
    compacted.lastContextTokensStaleAfterCompact = true;
    recordContextUsageSnapshot(compacted, resolveWorkerCompactPolicy(compacted, []), {
        messages,
        usedTokens: 12_000,
        source: 'post_compact',
    });

    const status = statusOf(compacted);
    assert.equal(status.usedSource, 'post_compact');
    assert.equal(status.usedTokens, 12_000);
});

test('compaction and the gauge decide on the same number, and never on a contradicted estimate', () => {
    const messages = [
        { role: 'system', content: 'rules '.repeat(50) },
        { role: 'user', content: 'work '.repeat(12_000) },
    ];
    const session = sessionWith(messages, {
        contextWindow: 20_000,
        compactBoundaryTokens: 20_000,
    });
    anchorTo(session, messages, 5_000);
    const policy = resolveWorkerCompactPolicy(session, []);

    // Anchored: the gauge is the provider's prompt and nothing compacts.
    assert.equal(statusOf(session).usedTokens, 5_500);
    assert.equal(
        shouldCompactForSession(estimateMessagesTokens(messages), policy, { messages, sessionRef: session }),
        false,
    );

    // An in-place rewrite of an already-measured message (offload placeholder
    // swap) breaks the anchor, so the gauge falls back to the local estimate.
    messages[1] = { role: 'user', content: `${'work '.repeat(12_000)} [output offloaded]` };
    const drifted = statusOf(session);
    assert.equal(drifted.usedSource, 'estimated');
    assert.ok(drifted.usedTokens > 20_000, `fixture estimate must exceed the trigger: ${drifted.usedTokens}`);

    // Nothing was appended since the provider measured 5,000 tokens, so that
    // reading — not the estimate that contradicts it — decides.
    assert.equal(
        shouldCompactForSession(estimateMessagesTokens(messages), policy, { messages, sessionRef: session }),
        false,
    );

    // Real growth after the reading is the estimate's job again.
    messages.push({ role: 'user', content: 'newly appended tool output '.repeat(4_000) });
    assert.equal(
        shouldCompactForSession(estimateMessagesTokens(messages), policy, { messages, sessionRef: session }),
        true,
    );
});
