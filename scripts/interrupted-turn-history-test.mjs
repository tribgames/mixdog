#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-interrupted-turn-'));
process.env.MIXDOG_DATA_DIR = DATA_DIR;
// Keep intentional apply_patch failures out of the real diagnostic sinks.
process.env.MIXDOG_TOOL_FAILURE_LOG_PATH = join(DATA_DIR, 'tool-failures.jsonl');
process.env.MIXDOG_PATCH_REPLAY_CAPTURE = '0';
const { compactedOutgoingPromptRetained } = await import(
    '../src/runtime/agent/orchestrator/session/manager/message-sanitize.mjs'
);

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const USER_INTERRUPTION_MESSAGE = '[Request interrupted by user]';
const TOOL_USE_INTERRUPTION_MESSAGE = '[Request interrupted by user for tool use]';
const PROCESS_RESTART_MESSAGE = '[Request interrupted by process restart]';
const INTERRUPTED_TOOL_RESULT = 'Cancelled';

test('unchanged failed-turn snapshot reports an already-retained queued prompt', () => {
    const messages = [{ role: 'user', content: 'queued prompt already in preflight session' }];
    assert.equal(compactedOutgoingPromptRetained(messages, messages), true);
    assert.equal(compactedOutgoingPromptRetained([], messages), false);
});

// Display filtering hides model-only control rows, but the process-restart
// marker stays model-visible while the TUI maps it to a Cancelled status row.
test('transcript display hides user cancel rows and shows process-restart as cancelled', async () => {
    const { isInternalTranscriptDisplayText } = await import(
        '../src/runtime/shared/tool-execution-contract.mjs'
    );
    const { restoreTranscriptItems } = await import(
        '../src/tui/engine/session-api-ext.mjs'
    );
    assert.equal(isInternalTranscriptDisplayText(USER_INTERRUPTION_MESSAGE), true);
    assert.equal(isInternalTranscriptDisplayText(TOOL_USE_INTERRUPTION_MESSAGE), true);
    assert.equal(isInternalTranscriptDisplayText(PROCESS_RESTART_MESSAGE), false);
    const items = restoreTranscriptItems([
        { role: 'user', content: 'do the work' },
        { role: 'assistant', content: 'partial progress' },
        { role: 'user', content: USER_INTERRUPTION_MESSAGE },
        { role: 'user', content: PROCESS_RESTART_MESSAGE },
    ], { sessionId: 'interrupt_display' });
    assert.deepEqual(
        items.filter((item) => item.kind === 'user').map((item) => item.text),
        ['do the work'],
    );
    assert.deepEqual(
        items.filter((item) => item.kind === 'turndone').map((item) => ({
            status: item.status,
            elapsedMs: item.elapsedMs,
        })),
        [{ status: 'cancelled', elapsedMs: 0 }],
    );
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function waitForAbort(opts) {
    return new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

test('interrupted turns keep Claude Code-compatible model history boundaries', { concurrency: false }, async (t) => {
    const { initProviders, getProvider } = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
    await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
    const provider = getProvider('gemini');
    const {
        abortSessionTurn,
        askSession,
        closeSession,
        createSession,
        getSession,
        resumeSession,
    } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
    const { saveSessionAsync } = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const { enqueuePendingMessage } = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

    const createTestSession = (tools = []) => createSession({
        provider: 'gemini',
        model: 'gemini-test',
        tools,
        cwd: process.cwd(),
        skipAgentRules: true,
        skipSkills: true,
        compaction: { auto: false },
    });
    const expectInterrupted = async (promise) => {
        await assert.rejects(promise, (error) => error?.name === 'SessionClosedError');
    };

    await t.test('before response: rewinds the provisional user turn', async () => {
        const session = createTestSession();
        const baselineMessages = session.messages.slice();
        const baselineSessionStart = session.sessionStartMetaInjected === true;
        const entered = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            entered.resolve();
            return waitForAbort(opts);
        };

        const asking = askSession(session.id, 'cancel before response', null, null, process.cwd());
        await entered.promise;
        assert.equal(abortSessionTurn(session.id, 'user-cancel'), true);
        await expectInterrupted(asking);

        const persisted = getSession(session.id);
        assert.deepEqual(persisted.messages, baselineMessages);
        assert.equal(persisted.sessionStartMetaInjected === true, baselineSessionStart);
        assert.equal(persisted.liveTurnMessages, null);
    });

    await t.test('released queued IDs keep their spool copy after cancellation rewinds the prompt', async () => {
        const session = createTestSession();
        enqueuePendingMessage(session.id, 'queued prompt must replay');
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 30));
        const entered = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            entered.resolve();
            return waitForAbort(opts);
        };
        const asking = askSession(session.id, '', null, null, process.cwd());
        await entered.promise;
        abortSessionTurn(session.id, 'user-cancel');
        await expectInterrupted(asking);
        await new Promise((resolve) => setTimeout(resolve, 30));
        const spool = JSON.parse(readFileSync(join(DATA_DIR, 'session-pending-messages.json'), 'utf8'));
        assert.equal(spool.sessions[session.id]?.length, 1);
        assert.equal(spool.sessions[session.id][0].message, 'queued prompt must replay');
    });

    await t.test('streaming: preserves a partial response without a newline', async () => {
        const session = createTestSession();
        const streamed = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            opts.onTextDelta?.('partial without newline');
            streamed.resolve();
            return waitForAbort(opts);
        };

        const asking = askSession(
            session.id,
            'stream a partial response',
            null,
            null,
            process.cwd(),
            null,
            { onTextDelta: () => {} },
        );
        await streamed.promise;
        abortSessionTurn(session.id, 'user-cancel');
        await expectInterrupted(asking);

        const persisted = getSession(session.id);
        const partial = persisted.messages.find((message) => (
            message.role === 'assistant' && message.content === 'partial without newline'
        ));
        assert.deepEqual(partial, {
            role: 'assistant',
            content: 'partial without newline',
        });
        assert.equal(persisted.messages.at(-1)?.content, USER_INTERRUPTION_MESSAGE);
        assert.equal(persisted.liveTurnMessages, null);
    });

    await t.test('queued interrupt: preserves progress without a synthetic marker', async () => {
        const session = createTestSession();
        const streamed = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            opts.onTextDelta?.('partial before queued redirect');
            streamed.resolve();
            return waitForAbort(opts);
        };

        const asking = askSession(
            session.id,
            'active request',
            null,
            null,
            process.cwd(),
            null,
            { onTextDelta: () => {} },
        );
        await streamed.promise;
        abortSessionTurn(session.id, 'interrupt');
        await expectInterrupted(asking);

        const persisted = getSession(session.id);
        assert.deepEqual(persisted.messages.at(-1), {
            role: 'assistant',
            content: 'partial before queued redirect',
        });
        assert.equal(persisted.messages.some((message) => (
            message.content === USER_INTERRUPTION_MESSAGE
            || message.content === TOOL_USE_INTERRUPTION_MESSAGE
        )), false);
    });

    // Full-parallel dispatch: every streamed tool call starts executing
    // immediately except the ordered mutation (apply_patch). Only a call that
    // never started closes with the streaming interruption result.
    await t.test('streaming tool use: closes an unstarted call with an error result', async () => {
        const session = createTestSession();
        const observed = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            opts.onToolCall?.({
                id: 'streaming_patch',
                name: 'apply_patch',
                arguments: { patch: '*** Begin Patch\n*** End Patch' },
            });
            observed.resolve();
            return waitForAbort(opts);
        };

        const asking = askSession(session.id, 'prepare a patch call', null, null, process.cwd());
        await observed.promise;
        abortSessionTurn(session.id, 'user-cancel');
        await expectInterrupted(asking);

        const persisted = getSession(session.id);
        assert.equal(persisted.messages.some((message) => (
            message.role === 'assistant'
            && message.toolCalls?.some((call) => call.id === 'streaming_patch')
        )), true);
        assert.deepEqual(
            persisted.messages.find((message) => (
                message.role === 'tool' && message.toolCallId === 'streaming_patch'
            )),
            {
                role: 'tool',
                content: INTERRUPTED_TOOL_RESULT,
                toolCallId: 'streaming_patch',
                toolKind: 'error',
            },
        );
        assert.equal(persisted.messages.at(-1)?.content, USER_INTERRUPTION_MESSAGE);
    });

    await t.test('streamed eager tool: preserves a result completed before the provider response', async () => {
        const session = createTestSession('readonly');
        const eagerCompleted = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            opts.onToolCall?.({
                id: 'eager_read',
                name: 'read',
                arguments: { path: PACKAGE_PATH, offset: 0, limit: 1 },
            });
            return waitForAbort(opts);
        };
        const asking = askSession(
            session.id,
            'run an eager read',
            null,
            null,
            process.cwd(),
            null,
            {
                onToolResult: (message) => {
                    if (message?.__earlyNotify !== true) return;
                    eagerCompleted.resolve();
                    abortSessionTurn(session.id, 'user-cancel');
                },
            },
        );
        await eagerCompleted.promise;
        await expectInterrupted(asking);

        const persisted = getSession(session.id);
        const assistant = persisted.messages.find((message) => (
            message.role === 'assistant'
            && message.toolCalls?.some((call) => call.id === 'eager_read')
        ));
        const result = persisted.messages.find((message) => (
            message.role === 'tool' && message.toolCallId === 'eager_read'
        ));
        assert.ok(assistant, 'streamed tool_use is retained before send() returns');
        assert.ok(result, 'completed eager result is retained');
        assert.notEqual(result.content, INTERRUPTED_TOOL_RESULT);
        assert.equal(persisted.messages.at(-1)?.content, USER_INTERRUPTION_MESSAGE);
    });

    let toolSession;
    await t.test('tool execution: keeps completed results and closes unfinished calls', async () => {
        toolSession = createTestSession();
        provider.send = async () => ({
            content: 'checking both slices',
            toolCalls: [
                { id: 'read_one', name: 'read', arguments: { path: PACKAGE_PATH, offset: 0, limit: 1 } },
                // Deterministically unfinished under full-parallel dispatch:
                // the sleep outlives the abort triggered by read_one's result.
                { id: 'slow_shell', name: 'shell', arguments: { command: 'node -e "setTimeout(function () {}, 8000)"' } },
            ],
            stopReason: 'tool_use',
        });
        const asking = askSession(
            toolSession.id,
            'read two slices',
            null,
            null,
            process.cwd(),
            null,
            {
                onToolResult: (message) => {
                    if (message?.toolCallId === 'read_one') abortSessionTurn(toolSession.id, 'user-cancel');
                },
            },
        );
        await expectInterrupted(asking);

        const persisted = getSession(toolSession.id);
        const results = persisted.messages.filter((message) => message.role === 'tool');
        assert.equal(results.length, 2);
        const readResult = results.find((message) => message.toolCallId === 'read_one');
        const shellResult = results.find((message) => message.toolCallId === 'slow_shell');
        assert.ok(readResult, 'completed read result is retained');
        assert.notEqual(readResult.content, INTERRUPTED_TOOL_RESULT);
        assert.deepEqual(
            { content: shellResult?.content, kind: shellResult?.toolKind },
            { content: INTERRUPTED_TOOL_RESULT, kind: 'error' },
        );
        assert.equal(persisted.messages.at(-1)?.content, TOOL_USE_INTERRUPTION_MESSAGE);
    });

    await t.test('recovery: the next model request receives the closed tool trajectory', async () => {
        let capturedMessages = null;
        provider.send = async (messages, _model, _tools, opts) => {
            capturedMessages = JSON.parse(JSON.stringify(messages));
            opts.onTextDelta?.('recovered');
            return { content: 'recovered', stopReason: 'STOP' };
        };
        const result = await askSession(toolSession.id, 'continue after interrupt', null, null, process.cwd());
        assert.equal(result.content, 'recovered');
        assert.equal(capturedMessages.some((message) => (
            message.role === 'tool'
            && message.toolCallId === 'slow_shell'
            && message.content === INTERRUPTED_TOOL_RESULT
        )), true);
        assert.equal(capturedMessages.some((message) => message.content === TOOL_USE_INTERRUPTION_MESSAGE), true);
    });

    let chainedSession;
    await t.test('later iteration: preserves completed tool history, steering, and the current partial', async () => {
        chainedSession = createTestSession();
        let sendCount = 0;
        const secondStream = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            sendCount += 1;
            if (sendCount === 1) {
                opts.onTextDelta?.('first iteration preamble');
                return {
                    content: 'first iteration preamble',
                    toolCalls: [
                        { id: 'chain_read', name: 'read', arguments: { path: PACKAGE_PATH, offset: 0, limit: 1 } },
                    ],
                    stopReason: 'tool_use',
                };
            }
            opts.onTextDelta?.('later partial');
            secondStream.resolve();
            return waitForAbort(opts);
        };
        let steeringDrained = false;
        const asking = askSession(
            chainedSession.id,
            'run a chained turn',
            null,
            null,
            process.cwd(),
            null,
            {
                onTextDelta: () => {},
                drainSteering: () => {
                    if (steeringDrained) return [];
                    steeringDrained = true;
                    return [{ content: 'queued redirect', text: 'queued redirect', count: 1 }];
                },
            },
        );
        await secondStream.promise;
        abortSessionTurn(chainedSession.id, 'user-cancel');
        await expectInterrupted(asking);

        const persisted = getSession(chainedSession.id);
        assert.equal(persisted.messages.some((message) => (
            message.role === 'tool' && message.toolCallId === 'chain_read'
        )), true);
        assert.equal(persisted.messages.some((message) => (
            message.role === 'user'
            && message.content === 'queued redirect'
            && message.meta?.source === 'steering'
        )), true);
        assert.equal(persisted.messages.some((message) => (
            message.role === 'assistant'
            && message.content === 'later partial'
        )), true);
        assert.equal(persisted.messages.at(-1)?.content, USER_INTERRUPTION_MESSAGE);
    });

    await t.test('recovery and disk: partial/steering history survives the next send and storage flush', async () => {
        let capturedMessages = null;
        provider.send = async (messages) => {
            capturedMessages = JSON.parse(JSON.stringify(messages));
            return { content: 'chain recovered', stopReason: 'STOP' };
        };
        await askSession(chainedSession.id, 'finish the chain', null, null, process.cwd());
        assert.equal(capturedMessages.some((message) => (
            message.role === 'assistant'
            && message.content === 'later partial'
        )), true);
        assert.equal(capturedMessages.some((message) => (
            message.role === 'user' && message.content === 'queued redirect'
        )), true);

        const latestSession = getSession(chainedSession.id);
        await saveSessionAsync(latestSession, { expectedGeneration: latestSession.generation });
        const diskSession = JSON.parse(readFileSync(
            join(DATA_DIR, 'sessions', `${chainedSession.id}.json`),
            'utf8',
        ));
        assert.equal(diskSession.messages.some((message) => (
            message.role === 'assistant' && message.content === 'later partial'
        )), true);
        assert.equal(diskSession.messages.some((message) => message.content === USER_INTERRUPTION_MESSAGE), true);
        assert.equal(Object.hasOwn(diskSession, 'liveTurnMessages'), false);
    });

    // Explicit no-tool stream stall (NOT a user cancel, NOT a success): the
    // loop rethrows the failure, and the text already streamed to the UI must
    // still land in history. Anthropic's StreamStalledError carries neither
    // liveTextEmitted nor unsafeToRetry, so this exercises the stall's own
    // partialContent gate at the askSession level, not just agentLoop.
    await t.test('stream stall: partial text is persisted while the turn still fails', async () => {
        const session = createTestSession();
        const stalled = Object.assign(new Error('Anthropic OAuth SSE stalled'), {
            name: 'StreamStalledError',
            code: 'ESTREAMSTALL',
            streamStalled: true,
            pendingToolUse: false,
            emittedToolCall: false,
            partialContent: 'stalled summary so far',
        });
        let sendCount = 0;
        provider.send = async (_messages, _model, _tools, opts) => {
            sendCount += 1;
            opts.onTextDelta?.('stalled summary so far');
            throw stalled;
        };

        await assert.rejects(
            askSession(session.id, 'summarize the work', null, null, process.cwd(), null, { onTextDelta: () => {} }),
            (error) => error === stalled,
        );
        assert.equal(sendCount, 1, 'a stalled live-text send must not be replayed');

        const persisted = getSession(session.id);
        assert.equal(persisted.messages.some((message) => (
            message.role === 'assistant' && message.content === 'stalled summary so far'
        )), true, 'streamed partial is committed by the error persistence path');
        assert.equal(persisted.messages.some((message) => (
            message.content === USER_INTERRUPTION_MESSAGE
            || message.content === TOOL_USE_INTERRUPTION_MESSAGE
        )), false, 'a provider stall is not a user interruption');
        assert.equal(persisted.liveTurnMessages, null);

        let recoveredMessages = null;
        provider.send = async (messages) => {
            recoveredMessages = JSON.parse(JSON.stringify(messages));
            return { content: 'recovered after stall', stopReason: 'STOP' };
        };
        const recovered = await askSession(session.id, 'continue after the stall', null, null, process.cwd());
        assert.equal(recovered.content, 'recovered after stall');
        assert.equal(recoveredMessages.some((message) => (
            message.role === 'assistant' && message.content === 'stalled summary so far'
        )), true, 'the persisted partial is replayed to the model on the next turn');
    });

    await t.test('detach close: completed iterations and the current partial survive disk and resume', async () => {
        const session = createTestSession('readonly');
        const originalGeneration = session.generation;
        const secondStream = deferred();
        let sendCount = 0;
        provider.send = async (_messages, _model, _tools, opts) => {
            sendCount += 1;
            if (sendCount === 1) {
                opts.onTextDelta?.('completed before detach');
                return {
                    content: 'completed before detach',
                    toolCalls: [
                        { id: 'detach_read', name: 'read', arguments: { path: PACKAGE_PATH, offset: 0, limit: 1 } },
                    ],
                    stopReason: 'tool_use',
                };
            }
            opts.onTextDelta?.('partial at detach');
            secondStream.resolve();
            return waitForAbort(opts);
        };

        const asking = askSession(
            session.id,
            'run until detached',
            null,
            null,
            process.cwd(),
            null,
            { onTextDelta: () => {} },
        );
        await secondStream.promise;
        assert.equal(closeSession(session.id, 'cli-react-exit', { tombstone: false }), true);
        await expectInterrupted(asking);
        await new Promise((resolve) => setImmediate(resolve));

        const diskPath = join(DATA_DIR, 'sessions', `${session.id}.json`);
        const detached = JSON.parse(readFileSync(diskPath, 'utf8'));
        assert.equal(detached.generation, originalGeneration + 1);
        assert.equal(detached.closed, false);
        assert.equal(Object.hasOwn(detached, 'liveTurnMessages'), false);
        assert.equal(detached.messages.some((message) => (
            message.role === 'assistant' && message.content === 'completed before detach'
        )), true);
        assert.equal(detached.messages.some((message) => (
            message.role === 'tool' && message.toolCallId === 'detach_read'
        )), true);
        assert.equal(detached.messages.some((message) => (
            message.role === 'assistant' && message.content === 'partial at detach'
        )), true);

        const resumed = await resumeSession(session.id, 'readonly');
        assert.ok(resumed);
        let resumedMessages = null;
        provider.send = async (messages) => {
            resumedMessages = JSON.parse(JSON.stringify(messages));
            return { content: 'resumed after detach', stopReason: 'STOP' };
        };
        await askSession(session.id, 'continue after detach', null, null, process.cwd());
        assert.equal(resumedMessages.some((message) => (
            message.role === 'assistant' && message.content === 'completed before detach'
        )), true);
        assert.equal(resumedMessages.some((message) => (
            message.role === 'tool' && message.toolCallId === 'detach_read'
        )), true);
        assert.equal(resumedMessages.some((message) => (
            message.role === 'assistant' && message.content === 'partial at detach'
        )), true);
    });
});

// Codex `has_pending_input` (core/src/session/turn.rs:304-318) evaluated through
// the REAL manager queue: an `agent type=send` that lands while the terminal
// sample is in flight must be folded into this turn BEFORE the unresolved-
// tool-failure stop hook, and must not be replayed by the post-loop drain.
test('a send queued during the terminal sample is folded in before the stop hook', { concurrency: false }, async () => {
    const { initProviders, getProvider } = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
    await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
    const provider = getProvider('gemini');
    const { askSession, closeSession, createSession, getSession } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
    const { enqueuePendingMessage, drainPendingMessages } = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

    const session = createSession({
        provider: 'gemini',
        model: 'gemini-test',
        tools: [],
        cwd: process.cwd(),
        skipAgentRules: true,
        skipSkills: true,
        compaction: { auto: false },
    });
    const sends = [];
    let turn = 0;
    provider.send = async (messages) => {
        sends.push(JSON.parse(JSON.stringify(messages)));
        turn += 1;
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (turn === 1) {
            return {
                usage,
                content: '',
                stopReason: 'tool_use',
                toolCalls: [{ id: 'call-patch', name: 'apply_patch', arguments: { patch: 'this is not a diff', base_path: tmpdir() } }],
            };
        }
        if (turn === 2) {
            // Queued WHILE this terminal sample is in flight (real manager path).
            enqueuePendingMessage(session.id, 'also handle the second file');
            return { usage, content: 'apply_patch failed - retrying now.', stopReason: 'end_turn' };
        }
        if (turn === 3) return { usage, content: 'read the second file too', stopReason: 'end_turn' };
        return { usage, content: 'done; patch stays unresolved', stopReason: 'end_turn' };
    };

    const result = await askSession(session.id, 'patch the file', null, null, process.cwd());

    // 1 tool turn + terminal sample + queued-input resume + one stop-hook turn.
    assert.equal(sends.length, 4);
    assert.equal(result.content, 'done; patch stays unresolved');
    const finalSend = sends[3];
    const queuedIndex = finalSend.findIndex((m) => m.role === 'user'
        && String(m.content ?? '').includes('also handle the second file'));
    const hookIndex = finalSend.findIndex((m) => m?.meta?.source === 'tool-failure-stop-hook');
    assert.ok(queuedIndex >= 0, 'queued send reached the model inside this turn');
    assert.ok(hookIndex > queuedIndex, 'real steering is consumed before the synthetic continuation');
    // Folded exactly once — never replayed as a post-loop follow-up turn.
    const stored = getSession(session.id).messages
        .filter((m) => m.role === 'user' && String(m.content ?? '').includes('also handle the second file'));
    assert.equal(stored.length, 1);
    assert.deepEqual(drainPendingMessages(session.id), []);
    assert.ok((getSession(session.id).deliveredPendingMessageIds || []).length >= 1);
    closeSession(session.id, 'pending-stop-hook-test');
});

// Durability of the terminal-sample claim. The drain consumes the not-yet-
// flushed persist buffer, so a turn that FAILS after claiming the entry must
// restore it (memory + spool) — and a turn that succeeds must remove it once.
async function runTerminalEnqueueTurn({ failResumedTurn }) {
    const { initProviders, getProvider } = await import('../src/runtime/agent/orchestrator/providers/registry.mjs');
    await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
    const provider = getProvider('gemini');
    const { askSession, closeSession, createSession } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
    const { abortSessionTurn } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
    const pending = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');

    const session = createSession({
        provider: 'gemini',
        model: 'gemini-test',
        tools: [],
        cwd: process.cwd(),
        skipAgentRules: true,
        skipSkills: true,
        compaction: { auto: false },
    });
    const spoolRows = () => {
        try {
            const store = JSON.parse(readFileSync(join(DATA_DIR, 'session-pending-messages.json'), 'utf8'));
            return store.sessions?.[session.id] || [];
        } catch { return []; }
    };
    let turn = 0;
    provider.send = async (_messages, _model, _tools, opts) => {
        turn += 1;
        if (turn === 1) {
            // Queued DURING the terminal sample, before the buffered persist
            // flush (setImmediate) can reach disk.
            pending.enqueuePendingMessage(session.id, 'queued during the terminal sample');
            assert.deepEqual(spoolRows(), [], 'enqueue must still be pre-flush at claim time');
            return { usage: { inputTokens: 1, outputTokens: 1 }, content: 'looking into it', stopReason: 'end_turn' };
        }
        if (failResumedTurn) {
            // Cancel the resumed provider call (no lifecycle epoch change): the
            // turn fails with nothing preserved and releases its claimed entries.
            setImmediate(() => abortSessionTurn(session.id, 'user-cancel'));
            return waitForAbort(opts);
        }
        return { usage: { inputTokens: 1, outputTokens: 1 }, content: 'handled the queued input', stopReason: 'end_turn' };
    };

    const asking = askSession(session.id, 'start the work', null, null, process.cwd());
    if (failResumedTurn) await assert.rejects(asking, (error) => error?.name === 'SessionClosedError');
    else await asking;
    assert.equal(turn, 2, 'the queued input resumed sampling exactly once');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    // Restart: drop this process's in-memory state, keep the durable spool.
    pending._dropPendingMessageState(session.id, { clearPersisted: false });
    const hydrated = await pending.hydratePendingMessages(session.id);
    const replayed = pending.drainPendingMessages(session.id);
    try { closeSession(session.id, 'pending-durability-test-cleanup'); } catch { /* already closed */ }
    return { hydrated, replayed, spoolRows: spoolRows() };
}

test('a claimed terminal-sample enqueue survives a failed resumed turn and replays exactly once', { concurrency: false }, async () => {
    const { hydrated, replayed } = await runTerminalEnqueueTurn({ failResumedTurn: true });
    assert.equal(hydrated, 1);
    assert.deepEqual(replayed.map((entry) => entry.text), ['queued during the terminal sample']);
});

test('a delivered terminal-sample enqueue is removed durably and never replays', { concurrency: false }, async () => {
    const { hydrated, replayed, spoolRows } = await runTerminalEnqueueTurn({ failResumedTurn: false });
    assert.equal(hydrated, 0);
    assert.deepEqual(replayed, []);
    assert.deepEqual(spoolRows, []);
});

// ---- pending-state lifecycle authority -----------------------------------
// The session record is the only tombstone authority: `closed` refuses new
// pending state and `generation` (moved only by close/detach) invalidates an
// in-flight hydration. No tombstone cache, no count-based eviction.

async function lifecycleHarness() {
    const { closeSession, createSession, resumeSession } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
    const pending = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');
    const newSession = () => createSession({
        provider: 'gemini',
        model: 'gemini-test',
        tools: [],
        cwd: process.cwd(),
        skipAgentRules: true,
        skipSkills: true,
        compaction: { auto: false },
    });
    const spoolRows = (id) => {
        try {
            const store = JSON.parse(readFileSync(join(DATA_DIR, 'session-pending-messages.json'), 'utf8'));
            return store.sessions?.[id] || [];
        } catch { return []; }
    };
    return { closeSession, createSession, resumeSession, pending, newSession, spoolRows };
}

test('hydration revalidates across the beforePublish boundary and never publishes into a tombstoned session', { concurrency: false }, async () => {
    const { closeSession, pending, newSession } = await lifecycleHarness();
    const session = newSession();
    pending.enqueuePendingMessage(session.id, 'queued before the close');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    // Cold memory (restart-like), durable row present.
    pending._dropPendingMessageState(session.id, { clearPersisted: false });

    let closedDuringHydration = false;
    const hydrated = await pending.hydratePendingMessages(session.id, {
        beforePublish: async () => {
            closeSession(session.id, 'tombstone-during-hydration');
            closedDuringHydration = true;
        },
    });

    assert.equal(closedDuringHydration, true);
    assert.equal(hydrated, 0, 'publish aborted after the async boundary');
    assert.deepEqual(pending.drainPendingMessages(session.id), [], 'nothing was published into memory');
});

test('a completion landing after close cannot recreate pending state or clear the tombstone', { concurrency: false }, async () => {
    const { closeSession, pending, newSession, spoolRows } = await lifecycleHarness();
    const session = newSession();
    closeSession(session.id, 'late-enqueue-test');

    assert.equal(pending.enqueuePendingMessage(session.id, 'late provider completion'), 0);
    assert.deepEqual(pending.drainPendingMessages(session.id), []);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(spoolRows(session.id), [], 'no spool row recreated for a tombstoned session');
    assert.equal(await pending.hydratePendingMessages(session.id), 0, 'tombstone still refuses hydration');
});

test('an old claim release after close never resurrects deleted input, whatever the close churn', { concurrency: false }, async () => {
    const { closeSession, pending, newSession, spoolRows } = await lifecycleHarness();
    const session = newSession();
    pending.enqueuePendingMessage(session.id, 'claimed then closed');
    const claimed = pending.drainPendingMessages(session.id);
    assert.equal(claimed.length, 1);
    closeSession(session.id, 'claim-release-test');
    // 600 unrelated close cleanups: the old design evicted its tombstone marker
    // at 500 and let this stale release resurrect the input. There is no such
    // cache/cap any more — the session record answers every time.
    for (let index = 0; index < 600; index += 1) {
        pending._dropPendingMessageState(`sess_churn_${index}`, { clearPersisted: true });
    }

    pending.releasePendingMessages(session.id, claimed);

    assert.deepEqual(pending.drainPendingMessages(session.id), [], 'no memory resurrection');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(spoolRows(session.id), [], 'no spool resurrection');
});

test('detach stays writable: queued input survives and an explicit resume delivers it', { concurrency: false }, async () => {
    const { closeSession, resumeSession, pending, newSession } = await lifecycleHarness();
    const session = newSession();
    // tombstone:false = detach (generation bump, durable spool preserved).
    closeSession(session.id, 'detach-reopen-test', { tombstone: false });

    assert.equal(pending.enqueuePendingMessage(session.id, 'queued after detach'), 1);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    pending._dropPendingMessageState(session.id, { clearPersisted: false });

    const resumed = await resumeSession(session.id, 'full');
    assert.ok(resumed, 'detached session reopens');
    assert.equal(await pending.hydratePendingMessages(session.id), 1);
    assert.deepEqual(
        pending.drainPendingMessages(session.id).map((entry) => entry.text),
        ['queued after detach'],
    );
    closeSession(session.id, 'detach-reopen-cleanup');
});

test('a stale OPEN live snapshot can never mask the durable tombstone', { concurrency: false }, async () => {
    const { closeSession, pending, newSession, spoolRows } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    pending.enqueuePendingMessage(session.id, 'queued before the close');
    const claimed = pending.drainPendingMessages(session.id);
    assert.equal(claimed.length, 1);
    closeSession(session.id, 'stale-live-tombstone-test');

    // Plant the counterexample: a stale, still-OPEN in-memory snapshot whose
    // generation outranks the tombstone (the shape a dropped save leaves).
    const diskGeneration = store.readSessionLifecycleFromDisk(session.id)?.generation ?? 0;
    store.setLiveSession({ ...session, closed: false, generation: diskGeneration + 5 });
    assert.notEqual(store.loadSession(session.id)?.closed, true, 'live fallback is stale/open');
    assert.equal(store.readSessionLifecycleFromDisk(session.id)?.closed, true, 'disk holds the tombstone');

    assert.equal(pending.enqueuePendingMessage(session.id, 'late enqueue'), 0, 'enqueue obeys disk');
    assert.equal(pending.enqueueRemotePendingMessage(session.id, 'late remote'), 0, 'remote obeys disk');
    pending.releasePendingMessages(session.id, claimed);
    assert.deepEqual(pending.drainPendingMessages(session.id), [], 'no memory resurrection');
    assert.equal(await pending.hydratePendingMessages(session.id), 0, 'no publish into a tombstoned session');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(spoolRows(session.id), [], 'no spool resurrection');
});

test('a remote submit after close is refused before any spool mutation', { concurrency: false }, async () => {
    const { closeSession, pending, newSession, spoolRows } = await lifecycleHarness();
    const closedSession = newSession();
    closeSession(closedSession.id, 'remote-enqueue-test');
    assert.equal(pending.enqueueRemotePendingMessage(closedSession.id, 'remote submit after close'), 0);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(spoolRows(closedSession.id), []);

    // Control: an open session still accepts the same cross-surface submit.
    const openSession = newSession();
    assert.equal(pending.enqueueRemotePendingMessage(openSession.id, 'remote submit while open'), 1);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.equal(spoolRows(openSession.id).length, 1);
    closeSession(openSession.id, 'remote-enqueue-cleanup');
});

test('a generation-0 claim release after an explicit reopen at generation 1 never recreates the row', { concurrency: false }, async () => {
    const { closeSession, resumeSession, pending, newSession, spoolRows } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    pending.enqueuePendingMessage(session.id, 'claimed at generation 0');
    const claimed = pending.drainPendingMessages(session.id);
    assert.equal(claimed.length, 1, 'claim taken under the pre-reopen epoch');
    const claimGeneration = store.readSessionLifecycleFromDisk(session.id)?.generation ?? 0;

    // Explicit reopen: detach bumps the durable generation, resume adopts it.
    closeSession(session.id, 'generation-reopen-test', { tombstone: false });
    const resumed = await resumeSession(session.id, 'full');
    assert.ok(resumed);
    const reopenedGeneration = store.readSessionLifecycleFromDisk(session.id)?.generation ?? 0;
    assert.ok(reopenedGeneration > claimGeneration, 'reopen advanced the durable generation');

    pending.releasePendingMessages(session.id, claimed);

    assert.deepEqual(pending.drainPendingMessages(session.id), [], 'stale-epoch release restores nothing');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(spoolRows(session.id), [], 'no durable row recreated for the new epoch');
    closeSession(session.id, 'generation-reopen-cleanup');
});

test('an unreadable or foreign durable record fails closed while true absence stays writable', { concurrency: false }, async () => {
    const { pending, newSession } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    const recordPath = join(DATA_DIR, 'sessions', `${session.id}.json`);
    pending.enqueuePendingMessage(session.id, 'queued while readable');
    const claimed = pending.drainPendingMessages(session.id);
    assert.equal(claimed.length, 1);

    // Malformed record (half-written file): unreadable, NOT absent.
    writeFileSync(recordPath, '{ "generation": 0, "clo');
    assert.equal(store.readSessionLifecycleStateFromDisk(session.id).state, 'unreadable');
    assert.equal(store.readSessionLifecycleFromDisk(session.id), null);
    assert.equal(pending.enqueuePendingMessage(session.id, 'after corruption'), 0);
    assert.equal(pending.enqueueRemotePendingMessage(session.id, 'remote after corruption'), 0);
    pending.releasePendingMessages(session.id, claimed);
    assert.deepEqual(pending.drainPendingMessages(session.id), [], 'no restore against an unreadable record');
    assert.equal(await pending.hydratePendingMessages(session.id), 0);

    // Foreign record (valid JSON owned by another id) is equally fail-closed.
    writeFileSync(recordPath, JSON.stringify({ id: 'sess_some_other_owner', generation: 0, closed: false }));
    assert.equal(store.readSessionLifecycleStateFromDisk(session.id).state, 'unreadable');
    assert.equal(pending.enqueuePendingMessage(session.id, 'after foreign record'), 0);

    // True absence (never saved) stays writable — the ordinary fresh-session path.
    const neverSaved = 'sess_never_saved_control';
    assert.equal(store.readSessionLifecycleStateFromDisk(neverSaved).state, 'absent');
    assert.equal(pending.enqueuePendingMessage(neverSaved, 'never-saved input'), 1);
    assert.deepEqual(
        pending.drainPendingMessages(neverSaved).map((entry) => entry.text),
        ['never-saved input'],
    );
});

test('an old release judges itself by its own token after a newer claim and ack replaced the map state', { concurrency: false }, async () => {
    const { closeSession, resumeSession, pending, newSession, spoolRows } = await lifecycleHarness();
    const session = newSession();
    pending.enqueuePendingMessage(session.id, 'A claimed at generation 0');
    const claimedA = pending.drainPendingMessages(session.id);
    assert.equal(claimedA.length, 1);

    closeSession(session.id, 'token-per-entry-detach', { tombstone: false });
    assert.ok(await resumeSession(session.id, 'full'));

    // A NEWER claim + ack replaces / removes this session's claim-map state.
    pending.enqueuePendingMessage(session.id, 'B claimed at generation 1');
    const claimedB = pending.drainPendingMessages(session.id);
    assert.equal(claimedB.length, 1);
    await pending.acknowledgePendingMessages(session.id, claimedB);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });

    // The stale generation-0 release must NOT fall back to "open" map state.
    pending.releasePendingMessages(session.id, claimedA);

    assert.deepEqual(pending.drainPendingMessages(session.id), []);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(spoolRows(session.id), []);
    closeSession(session.id, 'token-per-entry-cleanup');
});

test('a close between the enqueue check and the publish rejects the input on the local and remote paths', { concurrency: false }, async () => {
    const { closeSession, pending, newSession, spoolRows } = await lifecycleHarness();

    // Local: close lands between the check and the in-memory publish.
    const local = newSession();
    pending._setPendingTestHooks({
        'enqueue:beforePublish': ({ sessionId }) => {
            if (sessionId === local.id) closeSession(local.id, 'race-local-enqueue');
        },
    });
    let localAccepted;
    try { localAccepted = pending.enqueuePendingMessage(local.id, 'raced local input'); }
    finally { pending._setPendingTestHooks(null); }
    assert.equal(localAccepted, 0);
    assert.deepEqual(pending.drainPendingMessages(local.id), []);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(spoolRows(local.id), []);

    // Remote: close lands INSIDE the durable commit window.
    const remote = newSession();
    const bystander = newSession();
    pending.enqueuePendingMessage(bystander.id, 'other owner row');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    const bystanderBefore = spoolRows(bystander.id).length;
    assert.equal(bystanderBefore, 1);

    pending._setPendingTestHooks({
        'persist:beforeCommit': ({ sessionId }) => {
            if (sessionId === remote.id) closeSession(remote.id, 'race-remote-commit');
        },
    });
    try {
        pending.enqueueRemotePendingMessage(remote.id, 'raced remote input');
        await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    } finally { pending._setPendingTestHooks(null); }

    assert.deepEqual(spoolRows(remote.id), [], 'old-generation remote input dropped at the commit');
    assert.equal(spoolRows(bystander.id).length, bystanderBefore, 'the other session was untouched');
    closeSession(bystander.id, 'race-remote-cleanup');
});

test('a generation move during multi-step hydrate cleanup stops before the next mutation', { concurrency: false }, async () => {
    const { closeSession, pending, newSession, spoolRows } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    pending.enqueuePendingMessage(session.id, 'delivered in an earlier turn');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    const rows = spoolRows(session.id);
    assert.equal(rows.length, 1);

    // Ledger marks it delivered → hydrate takes the alreadyDelivered cleanup path.
    const live = store.loadSession(session.id);
    pending.recordPendingMessageDelivery(live, rows);
    await store.saveSessionAsync(live, { expectedGeneration: live.generation });
    pending._dropPendingMessageState(session.id, { clearPersisted: false });

    let hookFired = 0;
    pending._setPendingTestHooks({
        'hydrate:betweenCleanups': ({ sessionId }) => {
            if (sessionId !== session.id || hookFired > 0) return;
            hookFired += 1;
            closeSession(session.id, 'hydrate-cleanup-race', { tombstone: false });
        },
    });
    let hydrated;
    try { hydrated = await pending.hydratePendingMessages(session.id); }
    finally { pending._setPendingTestHooks(null); }

    assert.equal(hookFired, 1, 'the cleanup boundary was exercised');
    assert.equal(hydrated, 0, 'no publish after the generation moved');
    const after = store.loadSession(session.id);
    assert.ok(
        (after?.deliveredPendingMessageIds || []).includes(rows[0].id),
        'ledger prune (the next mutation) never ran for the new generation',
    );
});

// ---- lifecycle identity + immutable epoch tokens -------------------------

// Cross-process detach/reopen: move the DURABLE generation without running
// this process's close cleanup, so in-memory entries survive the move exactly
// as they would when another process owned the transition.
function bumpDiskGeneration(id, delta = 1) {
    const recordPath = join(DATA_DIR, 'sessions', `${id}.json`);
    let record;
    try { record = JSON.parse(readFileSync(recordPath, 'utf8')); }
    catch { record = { id, closed: false, generation: 0 }; }
    record.id = id;
    record.generation = (Number(record.generation) || 0) + delta;
    writeFileSync(recordPath, JSON.stringify(record));
    return record.generation;
}

test('the bounded lifecycle scan never reports state before the top-level id is known', async () => {
    const { scanTopLevelLifecycle, LIFECYCLE_SCAN_CONFLICT } = await import(
        '../src/runtime/agent/orchestrator/session/lifecycle-scan.mjs'
    );

    // Property order regression: lifecycle fields FIRST, foreign id after.
    assert.deepEqual(
        scanTopLevelLifecycle('{"closed":false,"generation":0,"id":"sess_other","messages":[]}'),
        { closed: false, generation: 0, id: 'sess_other' },
    );
    // Identity-first order keeps the cheap early finish.
    assert.deepEqual(
        scanTopLevelLifecycle('{"id":"sess_a","closed":true,"generation":4,"messages":[{"content":"{\\"closed\\":false,\\"id\\":\\"sess_spoof\\"}"}]}'),
        { id: 'sess_a', closed: true, generation: 4 },
    );
    // Truncation after the identity is an AUTHORITATIVE rejection: there is no
    // lenient re-parse left behind it.
    assert.equal(
        scanTopLevelLifecycle('{"closed":false,"generation":0,"id":"sess_other","messages":['),
        LIFECYCLE_SCAN_CONFLICT,
    );
    // A non-string id is never positively confirmed.
    assert.equal(scanTopLevelLifecycle('{"closed":false,"generation":0,"id":7}'), LIFECYCLE_SCAN_CONFLICT);
});

test('separator faults, trailing bytes and any-order duplicates are one authoritative rejection', async () => {
    const { scanTopLevelLifecycle, LIFECYCLE_SCAN_CONFLICT } = await import(
        '../src/runtime/agent/orchestrator/session/lifecycle-scan.mjs'
    );
    for (const raw of [
        '{"id":"sess_a" "closed":true,"generation":2}',                  // missing comma
        '{"id":"sess_a","closed":true,"generation":2,}',                 // trailing comma
        '{"id":"sess_a","closed":true "generation":2}',                  // missing comma, later pair
        '{"id":"sess_a","closed":true,"generation":2}{"id":"sess_b"}',   // concatenated documents
        '{"id":"sess_a","closed":true,"generation":2} trailing-bytes',   // trailing garbage
        '["id","sess_a"]',                                               // non-object root
        '{"id":7,"id":"sess_a","closed":false,"generation":0}',          // NON-STRING FIRST duplicate id
        '{"id":"sess_a","id":7,"closed":false,"generation":0}',          // non-string second duplicate id
        '{"id":null,"id":"sess_a"}',                                     // null-first duplicate id
        '{"generation":0,"generation":1,"id":"sess_a"}',                 // duplicate generation
        '{"closed":false,"id":"sess_a","closed":true}',                  // duplicate closed, interleaved
        '{"id":"sess_a","closed":"true"}',                               // wrong-typed closed
        '{"id":"sess_a","generation":"2"}',                              // wrong-typed generation
        // ANY duplicate top-level key, not just the lifecycle three: the
        // barriers reserialize the whole record and the sweep acts on these.
        '{"id":"sess_a","status":"idle","status":"closed"}',             // duplicate status
        '{"id":"sess_a","updatedAt":1,"updatedAt":2}',                   // duplicate updatedAt
        '{"id":"sess_a","messages":[],"messages":[{"role":"user","content":"x"}]}', // duplicate messages
        '{"id":"sess_a","owner":"user","owner":"agent"}',                // duplicate owner
    ]) {
        assert.equal(scanTopLevelLifecycle(raw), LIFECYCLE_SCAN_CONFLICT, raw);
    }
    // Nested duplicates stay compatible: a duplicate key inside message
    // content is DATA (skipped by bracket depth, reserialized verbatim) and
    // can never move an ownership/lifecycle/sweep decision.
    assert.deepEqual(
        scanTopLevelLifecycle('{"id":"sess_a","messages":[{"content":"{\\"id\\":\\"sess_b\\",\\"id\\":\\"sess_c\\"}"}],"closed":false,"generation":3}'),
        { id: 'sess_a', closed: false, generation: 3 },
    );
    assert.deepEqual(
        scanTopLevelLifecycle('{"id":"sess_a","messages":[{"role":"user","status":"a","status":"b"}],"closed":false,"generation":1}'),
        { id: 'sess_a', closed: false, generation: 1 },
        'a duplicate key one level down is message data, not a top-level conflict',
    );
});

test('a foreign record whose id follows the lifecycle fields is refused', { concurrency: false }, async () => {
    const { pending, newSession } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    const recordPath = join(DATA_DIR, 'sessions', `${session.id}.json`);

    writeFileSync(recordPath, '{"closed":false,"generation":0,"id":"sess_some_other_owner"}');
    assert.equal(store.readSessionLifecycleStateFromDisk(session.id).state, 'unreadable');
    assert.equal(store.readSessionLifecycleFromDisk(session.id), null);
    assert.equal(pending.enqueuePendingMessage(session.id, 'input for a foreign record'), 0);
    assert.equal(pending.enqueueRemotePendingMessage(session.id, 'remote input for a foreign record'), 0);
    assert.deepEqual(pending.drainPendingMessages(session.id), []);
});

test('a normalized generation-0 entry surviving a generation-1 detach is rejected, not restamped', { concurrency: false }, async () => {
    const { pending, newSession, spoolRows } = await lifecycleHarness();
    const session = newSession();
    assert.equal(pending.enqueuePendingMessage(session.id, 'queued at generation 0'), 1);
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.equal(spoolRows(session.id).length, 1);

    // Another process detaches/reopens: generation 0 → 1, memory untouched.
    bumpDiskGeneration(session.id);

    // The drain normalizes (and re-clones) the entry — the token must survive
    // that and disqualify it instead of being restamped as generation 1.
    const drained = pending.drainPendingMessages(session.id);
    assert.deepEqual(drained, [], 'old-epoch entry rejected by the drain');

    // Nothing was claimed, so a release cannot legitimize or restore it.
    pending.releasePendingMessages(session.id, [{ id: 'unknown', content: 'queued at generation 0' }]);
    assert.deepEqual(pending.drainPendingMessages(session.id), [], 'no restore into the new epoch');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(
        spoolRows(session.id).map((row) => row.message),
        ['queued at generation 0'],
        'the durable row is left exactly as the previous epoch wrote it',
    );
});

test('a generation move while an ack waits for the spool lock leaves the reopened row untouched', { concurrency: false }, async () => {
    const { pending, newSession, spoolRows } = await lifecycleHarness();
    const session = newSession();
    pending.enqueuePendingMessage(session.id, 'delivered then reopened');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    const claimed = pending.drainPendingMessages(session.id);
    assert.equal(claimed.length, 1, 'claimed under the pre-move epoch');
    assert.equal(spoolRows(session.id).length, 1);

    let hookFired = 0;
    pending._setPendingTestHooks({
        'ack:beforeCommit': ({ sessionId }) => {
            if (sessionId !== session.id || hookFired > 0) return;
            hookFired += 1;
            bumpDiskGeneration(session.id);
        },
    });
    let acked;
    try { acked = await pending.acknowledgePendingMessages(session.id, claimed); }
    finally { pending._setPendingTestHooks(null); }

    assert.equal(hookFired, 1, 'the in-lock revalidation point was exercised');
    assert.equal(acked, false, 'ack refused: the rows belong to the reopened owner');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    assert.deepEqual(
        spoolRows(session.id).map((row) => row.message),
        ['delivered then reopened'],
        'no row deleted after the generation moved',
    );
});

// Plant a durable spool row exactly as ANOTHER process's cross-surface submit
// would leave it (no local queue/claim state in this process).
function writeSpoolRow(sessionId, row) {
    const spoolPath = join(DATA_DIR, 'session-pending-messages.json');
    let store;
    try { store = JSON.parse(readFileSync(spoolPath, 'utf8')); }
    catch { store = { version: 1, updatedAt: Date.now(), sessions: {}, sessionTouchedAt: {} }; }
    if (!store.sessions || typeof store.sessions !== 'object') store.sessions = {};
    if (!store.sessionTouchedAt || typeof store.sessionTouchedAt !== 'object') store.sessionTouchedAt = {};
    store.sessions[sessionId] = [row];
    store.sessionTouchedAt[sessionId] = Date.now();
    store.updatedAt = Date.now();
    writeFileSync(spoolPath, JSON.stringify(store));
}

test('a duplicate top-level id is an ownership conflict even when one copy matches', { concurrency: false }, async () => {
    const { scanTopLevelLifecycle, LIFECYCLE_SCAN_CONFLICT } = await import(
        '../src/runtime/agent/orchestrator/session/lifecycle-scan.mjs'
    );
    const { pending, newSession } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    const recordPath = join(DATA_DIR, 'sessions', `${session.id}.json`);

    // Both orders: a matching id first, and a matching id last (JSON.parse
    // last-wins would have accepted exactly one of them).
    assert.equal(
        scanTopLevelLifecycle('{"id":"sess_a","closed":false,"generation":0,"id":"sess_b"}'),
        LIFECYCLE_SCAN_CONFLICT,
    );
    assert.equal(
        scanTopLevelLifecycle('{"id":"sess_b","closed":false,"generation":0,"id":"sess_a"}'),
        LIFECYCLE_SCAN_CONFLICT,
    );
    assert.equal(
        scanTopLevelLifecycle('{"id":"sess_a","closed":false,"closed":true,"generation":0}'),
        LIFECYCLE_SCAN_CONFLICT,
    );

    for (const record of [
        `{"id":${JSON.stringify(session.id)},"closed":false,"generation":0,"id":"sess_some_other_owner"}`,
        `{"id":"sess_some_other_owner","closed":false,"generation":0,"id":${JSON.stringify(session.id)}}`,
    ]) {
        writeFileSync(recordPath, record);
        assert.equal(store.readSessionLifecycleStateFromDisk(session.id).state, 'unreadable', record);
        assert.equal(store.readSessionLifecycleFromDisk(session.id), null, record);
        assert.equal(pending.enqueuePendingMessage(session.id, 'input for an ambiguous record'), 0, record);
        assert.equal(pending.enqueueRemotePendingMessage(session.id, 'remote input'), 0, record);
    }
});

test('a durable record without an exact matching identity is unreadable, never open', { concurrency: false }, async () => {
    const { pending, newSession } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    const recordPath = join(DATA_DIR, 'sessions', `${session.id}.json`);

    for (const record of [
        '{"closed":false,"generation":0}',                       // identity missing
        '{"id":"","closed":false,"generation":0}',               // identity empty
        '{"id":7,"closed":false,"generation":0}',                // identity non-string
        '{"id":null,"closed":false,"generation":0}',             // identity null
        '{"id":"sess_some_other_owner","closed":false,"generation":0}', // foreign
    ]) {
        writeFileSync(recordPath, record);
        assert.equal(store.readSessionLifecycleStateFromDisk(session.id).state, 'unreadable', record);
        assert.equal(store.readSessionLifecycleFromDisk(session.id), null, record);
        assert.equal(pending.enqueuePendingMessage(session.id, 'input for an unowned record'), 0, record);
    }

    // Compatibility is preserved for TRUE absence only.
    const neverSaved = 'sess_never_saved_identity_control';
    assert.equal(store.readSessionLifecycleStateFromDisk(neverSaved).state, 'absent');
    assert.equal(pending.enqueuePendingMessage(neverSaved, 'never-saved input'), 1);
    assert.deepEqual(
        pending.drainPendingMessages(neverSaved).map((entry) => entry.text),
        ['never-saved input'],
    );
});

test('a tombstoned session neither receives nor loses foreign spool input', { concurrency: false }, async () => {
    const { closeSession, pending, newSession, spoolRows } = await lifecycleHarness();

    // Control: an OPEN owner takes the foreign row and removes it.
    const open = newSession();
    writeSpoolRow(open.id, { id: 'foreign_row_open', message: 'foreign submit for an open owner', enqueuedAt: Date.now() });
    assert.deepEqual(
        pending.drainForeignUserInjections(open.id),
        [{ text: 'foreign submit for an open owner', id: 'foreign_row_open' }],
    );
    assert.deepEqual(spoolRows(open.id), [], 'the open owner consumed the row');
    closeSession(open.id, 'foreign-drain-open-cleanup');

    // Tombstoned owner: the row (planted by a submit that raced the close)
    // must be neither delivered nor deleted.
    const closed = newSession();
    closeSession(closed.id, 'foreign-drain-tombstone-test');
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    writeSpoolRow(closed.id, { id: 'foreign_row_closed', message: 'foreign submit after the tombstone', enqueuedAt: Date.now() });

    assert.deepEqual(pending.drainForeignUserInjections(closed.id), [], 'tombstoned session receives nothing');
    assert.deepEqual(
        spoolRows(closed.id).map((row) => row.message),
        ['foreign submit after the tombstone'],
        'and removes nothing from the spool',
    );
    // The refusal is not a one-shot mtime artifact: it holds on re-poll.
    assert.deepEqual(pending.drainForeignUserInjections(closed.id), []);
    assert.equal(spoolRows(closed.id).length, 1);
});

test('a late save is refused by an ambiguous record instead of reopening it at generation 0', { concurrency: false }, async () => {
    const { newSession } = await lifecycleHarness();
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const session = newSession();
    const recordPath = join(DATA_DIR, 'sessions', `${session.id}.json`);
    // Let the create-time save land first, so the only write left to judge is
    // the late one below.
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Ambiguous tombstone: JSON.parse last-wins reads `closed:false,
    // generation:0` — i.e. "open, never closed" — and would let the late write
    // rename straight over the tombstone.
    const ambiguous = `{"id":${JSON.stringify(session.id)},"closed":true,"generation":9,"closed":false,"generation":0,"messages":[],"tools":[]}`;
    writeFileSync(recordPath, ambiguous);

    const late = {
        ...session,
        messages: [{ role: 'user', content: 'late write from the previous owner' }],
        updatedAt: Date.now(),
    };
    store.saveSession(late, { expectedGeneration: 0, sync: true });

    assert.equal(readFileSync(recordPath, 'utf8'), ambiguous, 'the ambiguous record was never overwritten');
    assert.equal(store.readSessionLifecycleStateFromDisk(session.id).state, 'unreadable');
});

test('the sweep never deletes, closes or repairs an ambiguous record', { concurrency: false }, async () => {
    const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
    const sessionsDir = join(DATA_DIR, 'sessions');
    const matured = Date.now() - 60 * 60 * 1000;
    // Same shape in every case: a MATURE tombstone the sweep would delete if it
    // resolved the record leniently (last-wins / stale summary row).
    const ambiguous = {
        sess_ambiguous_sweep_dup: `{"id":"sess_ambiguous_sweep_dup","closed":true,"generation":1,"closed":true,"updatedAt":${matured},"messages":[],"tools":[]}`,
        sess_ambiguous_sweep_comma: `{"id":"sess_ambiguous_sweep_comma","closed":true,"generation":1,"updatedAt":${matured},"messages":[],}`,
        sess_ambiguous_sweep_tail: `{"id":"sess_ambiguous_sweep_tail","closed":true,"generation":1,"updatedAt":${matured},"messages":[]} {"closed":false}`,
    };
    const controlId = 'sess_control_mature_tombstone';
    const control = `{"id":"${controlId}","closed":true,"generation":1,"updatedAt":${matured},"messages":[],"tools":[]}`;
    for (const [id, raw] of Object.entries(ambiguous)) writeFileSync(join(sessionsDir, `${id}.json`), raw);
    writeFileSync(join(sessionsDir, `${controlId}.json`), control);

    const underTest = new Set([...Object.keys(ambiguous), controlId]);
    store.sweepStaleSessions({
        ttlMs: 1,
        sweepIdle: true,
        sweepTombstones: true,
        tombstoneMaxAgeMs: 1,
        retainOpenSessions: false,
        // Every unrelated session of this suite stays untouched; only the
        // records under test are sweep candidates.
        isSessionLive: (id) => !underTest.has(id),
    });

    assert.equal(existsSync(join(sessionsDir, `${controlId}.json`)), false, 'control: a readable mature tombstone IS swept');
    for (const [id, raw] of Object.entries(ambiguous)) {
        const path = join(sessionsDir, `${id}.json`);
        assert.equal(existsSync(path), true, `${id} survived the sweep`);
        assert.equal(readFileSync(path, 'utf8'), raw, `${id} was not mutated by the sweep`);
    }
});

test('a generation move refusing a foreign drain leaves the spool pollable without another spool write', { concurrency: false }, async () => {
    const { pending, newSession, spoolRows } = await lifecycleHarness();
    const session = newSession();
    await pending._settlePendingMessageWrites({ timeoutMs: 5000 });
    writeSpoolRow(session.id, {
        id: 'foreign_row_generation_move',
        message: 'foreign submit racing a reopen',
        enqueuedAt: Date.now(),
    });
    const spoolPath = join(DATA_DIR, 'session-pending-messages.json');
    const beforeBytes = readFileSync(spoolPath, 'utf8');

    // Another process detaches/reopens exactly inside the spool lock, after
    // this drain captured its epoch token.
    let hookFired = 0;
    pending._setPendingTestHooks({
        'foreignDrain:beforeCommit': ({ sessionId }) => {
            if (sessionId !== session.id || hookFired > 0) return;
            hookFired += 1;
            bumpDiskGeneration(session.id);
        },
    });
    let refused;
    try { refused = pending.drainForeignUserInjections(session.id); }
    finally { pending._setPendingTestHooks(null); }

    assert.equal(hookFired, 1, 'the in-lock revalidation point was exercised');
    assert.deepEqual(refused, [], 'nothing is delivered across the generation move');
    assert.equal(readFileSync(spoolPath, 'utf8'), beforeBytes, 'the refused drain mutated nothing');

    // The refusal must not have armed the mtime memo: the reopened owner polls
    // the SAME unchanged spool file and still sees the row.
    assert.deepEqual(
        pending.drainForeignUserInjections(session.id),
        [{ text: 'foreign submit racing a reopen', id: 'foreign_row_generation_move' }],
        'pollable immediately after reopen, with no intervening spool write',
    );
    assert.deepEqual(spoolRows(session.id), [], 'and the row is consumed exactly once');
});
