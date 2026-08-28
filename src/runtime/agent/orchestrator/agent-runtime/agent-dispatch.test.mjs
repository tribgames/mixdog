import assert from 'node:assert/strict';
import test from 'node:test';
import {
    bindAgentDispatchHostCallbacks,
    buildAgentDispatchAskSessionArgs,
    makeAgentDispatch,
    resolveAgentDispatchLiveCallbacks,
} from './agent-dispatch.mjs';

const preparedSession = Object.freeze({
    id: 'sess_host_adapt',
    agent: 'worker',
    owner: 'agent',
    model: 'test-model',
    provider: 'test',
});

function noopAdmission() {
    return {
        async acquire() {
            return { release: async () => {} };
        },
        async runWithLease(_lease, task) {
            return await task();
        },
    };
}

function lifecycleDispatch({ askSession, brief = true }) {
    const events = [];
    const session = {
        id: 'sess_lifecycle',
        agent: 'worker',
        owner: 'agent',
        model: 'test-model',
        provider: 'test',
        status: 'idle',
        closed: false,
        tools: [],
        messages: [],
    };
    const dispatch = makeAgentDispatch({
        agent: 'worker',
        preset: { provider: 'test', model: 'test-model' },
        config: { presets: [] },
        brief,
        resourceAdmission: noopAdmission(),
        prepareAgentSession: () => ({ session }),
        getSession: () => session,
        updateSessionStatus: async (_id, status) => {
            events.push(['status', status]);
            if (session.closed) return false;
            session.status = status;
            return true;
        },
        closeSession: (_id, reason) => {
            events.push(['close', reason, session.status]);
            session.closed = true;
            session.closeReason = reason;
            return true;
        },
        askSession: async (...args) => {
            events.push(['ask']);
            return await askSession(session, ...args);
        },
    });
    return { dispatch, events, session };
}

test('dispatch live callbacks stay suppressed without a live-text request', () => {
    const onToolCall = () => {};
    const onToolResult = () => {};
    const onStageChange = () => {};
    const onSessionStart = () => {};
    const onAssistantMessageCommitted = () => {};
    const onReasoningDelta = () => {};
    const resolved = resolveAgentDispatchLiveCallbacks({
        onToolCall,
        onToolResult,
        onStageChange,
        onSessionStart,
        onAssistantMessageCommitted,
        onReasoningDelta,
    }, {});
    assert.equal(resolved.liveProjection, false);
    assert.equal(resolved.callbacks.onToolCall, onToolCall);
    assert.equal(resolved.callbacks.onStageChange, onStageChange);
    assert.equal(resolved.callbacks.onSessionStart, onSessionStart);
    assert.equal(resolved.callbacks.onAssistantMessageCommitted, onAssistantMessageCommitted);
    assert.equal(resolved.callbacks.onReasoningDelta, onReasoningDelta);
    assert.equal(resolved.callbacks.onTextDelta, undefined);
});

test('per-call live-text callbacks win and request liveProjection', () => {
    const factoryDelta = () => {};
    const callDelta = () => {};
    const callReset = async () => true;
    const resolved = resolveAgentDispatchLiveCallbacks({
        onTextDelta: factoryDelta,
        onToolCall: () => {},
    }, {
        onTextDelta: callDelta,
        onTextReset: callReset,
    });
    assert.equal(resolved.liveProjection, true);
    assert.equal(resolved.callbacks.onTextDelta, callDelta);
    assert.equal(resolved.callbacks.onTextReset, callReset);
});

test('explicit liveProjection requests streaming even without text callbacks', () => {
    assert.equal(resolveAgentDispatchLiveCallbacks({ liveProjection: true }, {}).liveProjection, true);
    assert.equal(resolveAgentDispatchLiveCallbacks({}, { liveProjection: true }).liveProjection, true);
    assert.equal(resolveAgentDispatchLiveCallbacks({
        onAssistantText: () => {},
    }, {}).liveProjection, true);
});

test('askSession args wrap host callbacks with the prepared session', async () => {
    const events = [];
    const compactEvents = [];
    const host = {
        onToolCall(session, iteration, calls) { events.push(['tool', session, iteration, calls]); },
        onTextDelta(session, chunk) { events.push(['delta', session, chunk]); },
        onTextReset(session, detail) { events.push(['reset', session, detail]); return detail?.chars === 3; },
        onSessionStart(session) { events.push(['start', session]); },
        onStageChange(session, stage, detail) { events.push(['stage', session, stage, detail]); },
        onAssistantText(session, text) { events.push(['asst', session, text]); },
        onAssistantMessageCommitted(session) { events.push(['commit', session]); },
        onToolResult(session, message) { events.push(['result', session, message]); },
        onReasoningDelta(session, chunk) { events.push(['reason', session, chunk]); },
    };
    const { onToolCall: positional, askOpts } = buildAgentDispatchAskSessionArgs({
        interactiveSessionSurface: true,
        liveProjection: false,
        onToolCall: host.onToolCall,
    }, {
        onTextDelta: host.onTextDelta,
        onTextReset: host.onTextReset,
        onSessionStart: host.onSessionStart,
        onStageChange: host.onStageChange,
        onAssistantText: host.onAssistantText,
        onAssistantMessageCommitted: host.onAssistantMessageCommitted,
        onToolResult: host.onToolResult,
        onReasoningDelta: host.onReasoningDelta,
        interactiveSessionSurface: true,
    }, {
        onCompactEvent: (event) => compactEvents.push(event),
        interactiveSessionSurface: true,
    }, preparedSession);

    assert.equal(askOpts.liveProjection, true);
    assert.notEqual(askOpts.onTextDelta, host.onTextDelta);
    assert.equal(Object.hasOwn(askOpts, 'interactiveSessionSurface'), false);
    assert.equal(Object.hasOwn(askOpts, 'onToolCall'), false);

    askOpts.onSessionStart({ sessionId: 'ignored' });
    askOpts.onStageChange('streaming', { message: 'hi' });
    askOpts.onReasoningDelta('think');
    askOpts.onTextDelta('hello');
    assert.equal(await askOpts.onTextReset({ chars: 3 }), true);
    assert.equal(await askOpts.onTextReset({ chars: 99 }), false);
    askOpts.onAssistantText('hello');
    askOpts.onAssistantMessageCommitted({ role: 'assistant', content: 'hello' });
    positional(1, [{ id: 'c1', name: 'read' }]);
    askOpts.onToolResult({ role: 'tool', toolCallId: 'c1' });
    askOpts.onCompactEvent({ status: 'ok' });

    assert.deepEqual(events, [
        ['start', preparedSession],
        ['stage', preparedSession, 'streaming', { message: 'hi' }],
        ['reason', preparedSession, 'think'],
        ['delta', preparedSession, 'hello'],
        ['reset', preparedSession, { chars: 3 }],
        ['reset', preparedSession, { chars: 99 }],
        ['asst', preparedSession, 'hello'],
        ['commit', preparedSession],
        ['tool', preparedSession, 1, [{ id: 'c1', name: 'read' }]],
        ['result', preparedSession, { role: 'tool', toolCallId: 'c1' }],
    ]);
    assert.equal(compactEvents.length, 1);
});

test('silent dispatch askOpts keep liveProjection false', () => {
    const { onToolCall, askOpts } = buildAgentDispatchAskSessionArgs({}, { prompt: 'hello' }, {}, preparedSession);
    assert.equal(onToolCall, null);
    assert.equal(askOpts.liveProjection, false);
    assert.equal(askOpts.onTextDelta, undefined);
    assert.equal(askOpts.onSessionStart, undefined);
    assert.equal(Object.hasOwn(askOpts, 'interactiveSessionSurface'), false);
});

test('text-reset binding preserves the exact host acknowledgement', async () => {
    const boundTrue = bindAgentDispatchHostCallbacks({
        onTextReset: () => true,
    }, preparedSession);
    const boundFalse = bindAgentDispatchHostCallbacks({
        onTextReset: () => false,
    }, preparedSession);
    const boundTruthy = bindAgentDispatchHostCallbacks({
        onTextReset: () => 'yes',
    }, preparedSession);
    assert.equal(await boundTrue.onTextReset({ chars: 1 }), true);
    assert.equal(await boundFalse.onTextReset({ chars: 1 }), false);
    assert.equal(await boundTruthy.onTextReset({ chars: 1 }), 'yes');
});

test('makeAgentDispatch prepends the prepared session onto host-shaped callbacks', async () => {
    const events = [];
    const session = {
        id: 'sess_make_dispatch_adapt',
        agent: 'worker',
        owner: 'agent',
        model: 'test-model',
        provider: 'test',
        tools: [],
    };
    let capturedAskOpts = null;
    let capturedOnToolCall = null;
    const dispatch = makeAgentDispatch({
        agent: 'worker',
        preset: { provider: 'test', model: 'test-model' },
        config: { presets: [] },
        brief: false,
        resourceAdmission: noopAdmission(),
        prepareAgentSession: () => ({ session }),
        updateSessionStatus: async () => {},
        closeSession: () => {},
        getSession: () => session,
        askSession: async (_id, _prompt, _ctx, onToolCall, _cwd, _prefetch, askOpts) => {
            capturedAskOpts = askOpts;
            capturedOnToolCall = onToolCall;
            askOpts.onSessionStart({ sessionId: session.id, agent: 'worker' });
            askOpts.onStageChange('streaming', { transport: 'test' });
            askOpts.onReasoningDelta('think');
            askOpts.onTextDelta('PARTIAL');
            const acked = await askOpts.onTextReset({ chars: 3 });
            const rejected = await askOpts.onTextReset({ chars: 99 });
            events.push(['ack', acked, rejected]);
            askOpts.onAssistantText('PARTIAL');
            askOpts.onAssistantMessageCommitted({ role: 'assistant', content: 'PARTIAL' });
            await onToolCall(2, [{ id: 'c1', name: 'read' }]);
            askOpts.onToolResult({ role: 'tool', toolCallId: 'c1' });
            return { content: 'DONE' };
        },
        onSessionStart(received) { events.push(['start', received]); },
        onStageChange(received, stage, detail) { events.push(['stage', received, stage, detail]); },
        onReasoningDelta(received, chunk) { events.push(['reason', received, chunk]); },
        onTextDelta(received, chunk) { events.push(['delta', received, chunk]); },
        onTextReset(received, detail) {
            events.push(['reset', received, detail]);
            return detail?.chars === 3;
        },
        onAssistantText(received, text) { events.push(['asst', received, text]); },
        onAssistantMessageCommitted(received) { events.push(['commit', received]); },
        onToolCall(received, iteration, calls) { events.push(['tool', received, iteration, calls]); },
        onToolResult(received, message) { events.push(['result', received, message]); },
    });

    const text = await dispatch({ prompt: 'Reply exactly DONE' });
    assert.equal(text, 'DONE');
    assert.equal(capturedAskOpts.liveProjection, true);
    assert.equal(Object.hasOwn(session, 'interactiveSessionSurface'), false);
    assert.equal(Object.hasOwn(session, 'liveProjection'), false);
    assert.notEqual(capturedAskOpts.onTextDelta, dispatch);
    assert.equal(typeof capturedOnToolCall, 'function');
    assert.deepEqual(events, [
        ['start', session],
        ['stage', session, 'streaming', { transport: 'test' }],
        ['reason', session, 'think'],
        ['delta', session, 'PARTIAL'],
        ['reset', session, { chars: 3 }],
        ['reset', session, { chars: 99 }],
        ['ack', true, false],
        ['asst', session, 'PARTIAL'],
        ['commit', session],
        ['tool', session, 2, [{ id: 'c1', name: 'read' }]],
        ['result', session, { role: 'tool', toolCallId: 'c1' }],
    ]);
});

test('makeAgentDispatch silent path does not request live projection', async () => {
    const session = { id: 'sess_silent', agent: 'worker', owner: 'agent', tools: [] };
    let capturedAskOpts = null;
    const dispatch = makeAgentDispatch({
        agent: 'worker',
        preset: { provider: 'test', model: 'test-model' },
        config: { presets: [] },
        brief: false,
        resourceAdmission: noopAdmission(),
        prepareAgentSession: () => ({ session }),
        updateSessionStatus: async () => {},
        closeSession: () => {},
        getSession: () => session,
        askSession: async (_id, _prompt, _ctx, onToolCall, _cwd, _prefetch, askOpts) => {
            capturedAskOpts = askOpts;
            assert.equal(onToolCall, null);
            return { content: 'ok' };
        },
    });
    assert.equal(await dispatch({ prompt: 'hello' }), 'ok');
    assert.equal(capturedAskOpts.liveProjection, false);
    assert.equal(capturedAskOpts.onTextDelta, undefined);
    assert.equal(capturedAskOpts.onSessionStart, undefined);
    assert.equal(Object.hasOwn(session, 'interactiveSessionSurface'), false);
});

test('successful dispatch publishes idle before done tombstoning and preserves brief trimming', async () => {
    const raw = 'S'.repeat((12 * 1024) + 32);
    const { dispatch, events, session } = lifecycleDispatch({
        askSession: async () => ({ content: raw }),
    });

    const text = await dispatch({ prompt: 'hello' });

    assert.notEqual(text, raw);
    assert.equal(text.startsWith('S'.repeat(12 * 1024)), true);
    assert.match(text, /\[TRUNCATED — full answer was/);
    assert.deepEqual(events, [
        ['status', 'running'],
        ['ask'],
        ['status', 'idle'],
        ['close', 'ephemeral-done', 'idle'],
    ]);
    assert.equal(session.status, 'idle');
    assert.equal(session.closed, true);
    assert.equal(session.closeReason, 'ephemeral-done');
});

test('partial-salvage dispatch publishes idle before done tombstoning and preserves trimming', async () => {
    const partial = 'P'.repeat((12 * 1024) + 32);
    const { dispatch, events, session } = lifecycleDispatch({
        askSession: async (activeSession) => {
            activeSession.messages.push({ role: 'assistant', content: partial });
            const error = new Error('deadline');
            error.salvagePartial = true;
            throw error;
        },
    });

    const text = await dispatch({ prompt: 'hello' });

    assert.notEqual(text, partial);
    assert.equal(text.startsWith('P'.repeat(12 * 1024)), true);
    assert.match(text, /\[TRUNCATED — full answer was/);
    assert.deepEqual(events, [
        ['status', 'running'],
        ['ask'],
        ['status', 'idle'],
        ['close', 'ephemeral-done', 'idle'],
    ]);
    assert.equal(session.status, 'idle');
    assert.equal(session.closed, true);
    assert.equal(session.closeReason, 'ephemeral-done');
});

test('failed dispatch publishes error before error tombstoning and propagates the original error', async () => {
    const failure = new Error('provider failed');
    const { dispatch, events, session } = lifecycleDispatch({
        askSession: async () => {
            throw failure;
        },
    });

    await assert.rejects(
        dispatch({ prompt: 'hello' }),
        (error) => error === failure,
    );

    assert.deepEqual(events, [
        ['status', 'running'],
        ['ask'],
        ['status', 'error'],
        ['close', 'ephemeral-error', 'error'],
    ]);
    assert.equal(session.status, 'error');
    assert.equal(session.closed, true);
    assert.equal(session.closeReason, 'ephemeral-error');
});
