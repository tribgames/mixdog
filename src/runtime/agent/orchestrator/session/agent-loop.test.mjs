import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop, shouldSuppressAgentMidTurnText } from './agent-loop.mjs';

function agentSession(extra = {}) {
    return {
        id: 'agent-live-projection-test',
        owner: 'agent',
        agent: 'worker',
        contextWindow: 200_000,
        rawContextWindow: 200_000,
        compaction: { auto: false },
        ...extra,
    };
}

test('Agent mid-turn text stays suppressed unless live projection is explicit', () => {
    const session = agentSession();
    assert.equal(shouldSuppressAgentMidTurnText(session, {}), true);
    assert.equal(shouldSuppressAgentMidTurnText(session, { liveProjection: false }), true);
    assert.equal(shouldSuppressAgentMidTurnText(session, { onTextDelta: () => {} }), true);
    assert.equal(shouldSuppressAgentMidTurnText(session, { liveProjection: true }), false);
    assert.equal(shouldSuppressAgentMidTurnText(agentSession({ interactiveSessionSurface: true }), {}), false);
    assert.equal(shouldSuppressAgentMidTurnText({ owner: 'cli' }, {}), false);
});

test('silent Agent dispatch does not hand onTextDelta to the provider', async () => {
    const session = agentSession();
    let providerSawTextDelta = false;
    const deltas = [];
    const provider = {
        async send(_messages, _model, _tools, sendOpts) {
            providerSawTextDelta = typeof sendOpts?.onTextDelta === 'function';
            sendOpts?.onTextDelta?.('secret-preamble');
            return { content: 'final', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    const result = await agentLoop(
        provider,
        [{ role: 'user', content: 'go' }],
        'fake-model',
        [],
        null,
        process.cwd(),
        {
            session,
            sessionId: session.id,
            onTextDelta: (chunk) => deltas.push(chunk),
        },
    );
    assert.equal(result.content, 'final');
    assert.equal(providerSawTextDelta, false);
    assert.deepEqual(deltas, []);
    assert.equal(Object.hasOwn(session, 'interactiveSessionSurface'), false);
    assert.equal(Object.hasOwn(session, 'liveProjection'), false);
});

test('explicit liveProjection permits provider onTextDelta without persisting a session flag', async () => {
    const session = agentSession();
    const deltas = [];
    let providerSawTextDelta = false;
    const provider = {
        async send(_messages, _model, _tools, sendOpts) {
            providerSawTextDelta = typeof sendOpts?.onTextDelta === 'function';
            sendOpts?.onTextDelta?.('live-chunk');
            return { content: 'final', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    const result = await agentLoop(
        provider,
        [{ role: 'user', content: 'go' }],
        'fake-model',
        [],
        null,
        process.cwd(),
        {
            session,
            sessionId: session.id,
            liveProjection: true,
            onTextDelta: (chunk) => deltas.push(chunk),
        },
    );
    assert.equal(result.content, 'final');
    assert.equal(providerSawTextDelta, true);
    assert.deepEqual(deltas, ['live-chunk']);
    assert.equal(session.interactiveSessionSurface, undefined);
    assert.equal(session.liveProjection, undefined);
});

test('live Agent tool-call turns keep preamble text and surface buffered assistant text', async () => {
    const session = agentSession();
    const assistantTexts = [];
    const committed = [];
    const toolResults = [];
    let sends = 0;
    const provider = {
        async send(_messages, _model, _tools, sendOpts) {
            sends += 1;
            if (sends === 1) {
                sendOpts?.onTextDelta?.('Now let me look');
                return {
                    content: 'Now let me look',
                    toolCalls: [{ id: 'c1', name: 'definitely_missing_live_proj_tool', arguments: {} }],
                };
            }
            return { content: 'final-answer', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    const result = await agentLoop(
        provider,
        [{ role: 'user', content: 'inspect' }],
        'fake-model',
        [],
        null,
        process.cwd(),
        {
            session,
            sessionId: session.id,
            liveProjection: true,
            onAssistantText: (text) => assistantTexts.push(text),
            onAssistantMessageCommitted: (message) => committed.push(message),
            onToolResult: (message) => toolResults.push(message),
        },
    );
    assert.equal(result.content, 'final-answer');
    assert.equal(sends, 2);
    assert.deepEqual(assistantTexts, ['Now let me look']);
    assert.equal(committed[0]?.content, 'Now let me look');
    assert.equal(committed[0]?.toolCalls?.[0]?.name, 'definitely_missing_live_proj_tool');
    assert.ok(toolResults.length >= 1);
    assert.equal(toolResults[0]?.toolCallId, 'c1');
    assert.equal(session.interactiveSessionSurface, undefined);
});

test('suppressed Agent tool-call turns blank preamble history and skip buffered text', async () => {
    const session = agentSession();
    const assistantTexts = [];
    const committed = [];
    let sends = 0;
    const provider = {
        async send() {
            sends += 1;
            if (sends === 1) {
                return {
                    content: 'Now let me look',
                    toolCalls: [{ id: 'c1', name: 'definitely_missing_silent_proj_tool', arguments: {} }],
                };
            }
            return { content: 'final-answer', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    const result = await agentLoop(
        provider,
        [{ role: 'user', content: 'inspect' }],
        'fake-model',
        [],
        null,
        process.cwd(),
        {
            session,
            sessionId: session.id,
            onAssistantText: (text) => assistantTexts.push(text),
            onAssistantMessageCommitted: (message) => committed.push(message),
        },
    );
    assert.equal(result.content, 'final-answer');
    assert.deepEqual(assistantTexts, []);
    assert.equal(committed[0]?.content, '');
    assert.equal(committed[0]?.toolCalls?.[0]?.name, 'definitely_missing_silent_proj_tool');
});

test('successive Browser snapshots keep the already-sent provider prefix unchanged', async () => {
    const session = agentSession({ owner: 'cli', agent: 'lead' });
    const messages = [
        { role: 'user', content: 'browse' },
        {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'browser-old', name: 'browser', arguments: { action: 'snapshot' } }],
        },
        {
            role: 'tool',
            toolCallId: 'browser-old',
            content: 'UNTRUSTED PAGE CONTENT\nSnapshot: p1-s1\nold state',
        },
    ];
    const sent = [];
    let sends = 0;
    const provider = {
        async send(providerMessages) {
            sends += 1;
            sent.push(providerMessages);
            if (sends === 1) {
                return {
                    content: '',
                    toolCalls: [{ id: 'browser-new', name: 'browser', arguments: { action: 'snapshot' } }],
                };
            }
            return { content: 'done', toolCalls: [], stopReason: 'end_turn' };
        },
    };
    const result = await agentLoop(
        provider,
        messages,
        'fake-model',
        [],
        null,
        process.cwd(),
        {
            session,
            sessionId: session.id,
            onToolResult(message) {
                if (message.toolCallId !== 'browser-new') return;
                message.content = 'UNTRUSTED PAGE CONTENT\nSnapshot: p1-s2\nnew state';
            },
        },
    );
    assert.equal(result.content, 'done');
    assert.equal(sends, 2);
    assert.equal(sent[0][2].content.includes('old state'), true);
    assert.equal(sent[1][2].content.includes('old state'), true);
});
