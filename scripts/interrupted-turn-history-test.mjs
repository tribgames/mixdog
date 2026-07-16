#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { compactedOutgoingPromptRetained } from '../src/runtime/agent/orchestrator/session/manager/message-sanitize.mjs';

process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-interrupted-turn-'));
process.env.MIXDOG_DATA_DIR = DATA_DIR;

const PACKAGE_PATH = fileURLToPath(new URL('../package.json', import.meta.url));
const USER_INTERRUPTION_MESSAGE = '[Request interrupted by user]';
const TOOL_USE_INTERRUPTION_MESSAGE = '[Request interrupted by user for tool use]';
const STREAMING_INTERRUPTED_TOOL_RESULT = 'Interrupted by user';
const TOOL_USE_REJECT_RESULT = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

test('unchanged failed-turn snapshot reports an already-retained queued prompt', () => {
    const messages = [{ role: 'user', content: 'queued prompt already in preflight session' }];
    assert.equal(compactedOutgoingPromptRetained(messages, messages), true);
    assert.equal(compactedOutgoingPromptRetained([], messages), false);
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
        createSession,
        getSession,
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

    await t.test('streaming tool use: closes an unstarted call with an error result', async () => {
        const session = createTestSession();
        const observed = deferred();
        provider.send = async (_messages, _model, _tools, opts) => {
            opts.onToolCall?.({
                id: 'streaming_shell',
                name: 'shell',
                arguments: { command: 'echo not-started' },
            });
            observed.resolve();
            return waitForAbort(opts);
        };

        const asking = askSession(session.id, 'prepare a shell call', null, null, process.cwd());
        await observed.promise;
        abortSessionTurn(session.id, 'user-cancel');
        await expectInterrupted(asking);

        const persisted = getSession(session.id);
        assert.equal(persisted.messages.some((message) => (
            message.role === 'assistant'
            && message.toolCalls?.some((call) => call.id === 'streaming_shell')
        )), true);
        assert.deepEqual(
            persisted.messages.find((message) => (
                message.role === 'tool' && message.toolCallId === 'streaming_shell'
            )),
            {
                role: 'tool',
                content: STREAMING_INTERRUPTED_TOOL_RESULT,
                toolCallId: 'streaming_shell',
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
        assert.notEqual(result.content, STREAMING_INTERRUPTED_TOOL_RESULT);
        assert.equal(persisted.messages.at(-1)?.content, USER_INTERRUPTION_MESSAGE);
    });

    let toolSession;
    await t.test('tool execution: keeps completed results and closes unfinished calls', async () => {
        toolSession = createTestSession();
        provider.send = async () => ({
            content: 'checking both slices',
            toolCalls: [
                { id: 'read_one', name: 'read', arguments: { path: PACKAGE_PATH, offset: 0, limit: 1 } },
                { id: 'read_two', name: 'read', arguments: { path: PACKAGE_PATH, offset: 1, limit: 1 } },
            ],
            stopReason: 'tool_use',
        });
        let toolResults = 0;
        const asking = askSession(
            toolSession.id,
            'read two slices',
            null,
            null,
            process.cwd(),
            null,
            {
                onToolResult: () => {
                    toolResults += 1;
                    if (toolResults === 1) abortSessionTurn(toolSession.id, 'user-cancel');
                },
            },
        );
        await expectInterrupted(asking);

        const persisted = getSession(toolSession.id);
        const results = persisted.messages.filter((message) => message.role === 'tool');
        assert.equal(results.length, 2);
        assert.equal(results[0].toolCallId, 'read_one');
        assert.notEqual(results[0].content, TOOL_USE_REJECT_RESULT);
        assert.deepEqual(
            { id: results[1].toolCallId, content: results[1].content, kind: results[1].toolKind },
            { id: 'read_two', content: TOOL_USE_REJECT_RESULT, kind: 'error' },
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
            && message.toolCallId === 'read_two'
            && message.content === TOOL_USE_REJECT_RESULT
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
});
