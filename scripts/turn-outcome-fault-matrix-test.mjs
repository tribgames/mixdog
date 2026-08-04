#!/usr/bin/env node
// Turn-outcome FAULT MATRIX — model-based checks over externally observable
// turn outcomes only (askSession result/rejection, persisted history, tool
// results, disk state). No runtime internals are imported beyond the public
// session-manager / store seams the existing tests already use, so this suite
// stays valid while the turn internals are still moving.
//
// Invariants asserted for every row:
//   I1 exactly one terminal outcome per turn (one resolve OR one rejection,
//      and at most one interruption marker in history)
//   I2 at-most-once tool execution (duplicated/out-of-order tool frames must
//      not run the side effect twice)
//   I3 no partial-success promotion (a failed/aborted turn never returns a
//      success value, and its partial never becomes a completed answer)
//   I4 UI/history parity (what the delta stream exposed is what history keeps)
//   I5 durable replay (persisted outcome survives disk + the next request)
//
// Fault rows: duplicate/out-of-order terminal frames, stream close before
// terminal, abort during a provider retry, partial text, partial/complete tool
// calls, retry/fallback replacement, process kill/restart. Atomic-save fault
// injection is intentionally NOT here — it is owned by the store scope (see
// the persistence note below the tool rows).
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import {
    existsSync,
    mkdtempSync,
    readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const PACKAGE_PATH = join(ROOT, 'package.json');
const USER_INTERRUPTION_MESSAGE = '[Request interrupted by user]';
const TOOL_USE_INTERRUPTION_MESSAGE = '[Request interrupted by user for tool use]';
const PROCESS_RESTART_MESSAGE = '[Request interrupted by process restart]';
const INTERRUPTION_MARKERS = new Set([
    USER_INTERRUPTION_MESSAGE,
    TOOL_USE_INTERRUPTION_MESSAGE,
    PROCESS_RESTART_MESSAGE,
]);

process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

function waitForAbort(opts) {
    return new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) { reject(signal.reason); return; }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

// Count how many messages carry an exact content string — the duplication
// probe behind I1/I2/I3 (a replayed frame shows up as a second copy).
function countContent(messages, content) {
    return (messages || []).filter((message) => message?.content === content).length;
}

function countToolResults(messages, toolCallId) {
    return (messages || []).filter((message) => (
        message?.role === 'tool' && message.toolCallId === toolCallId
    )).length;
}

function countInterruptionMarkers(messages) {
    return (messages || []).filter((message) => INTERRUPTION_MARKERS.has(message?.content)).length;
}

// Minimal UI model: deltas append, an acknowledged reset retracts the last N
// exposed characters. Parity (I4) compares this against persisted history.
function uiTextModel() {
    let text = '';
    return {
        delta: (chunk) => { text += String(chunk ?? ''); },
        reset: (chars) => {
            const count = Math.max(0, Number(chars) || 0);
            text = text.slice(0, Math.max(0, text.length - count));
            return true;
        },
        value: () => text,
    };
}

// ── Force-kill child (row: process kill/restart) ─────────────────────────────
// Same shape as scripts/turn-checkpoint-crash-test.mjs: stream one completed
// tool iteration, park in a second iteration with a streamed partial, signal
// the parent once the checkpoint is on disk, then get SIGKILLed.
async function runCrashChild() {
    const { initProviders, getProvider } = await import(
        '../src/runtime/agent/orchestrator/providers/registry.mjs'
    );
    await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
    const provider = getProvider('gemini');
    const { askSession, createSession } = await import(
        '../src/runtime/agent/orchestrator/session/manager.mjs'
    );
    const { readTurnCheckpoint } = await import(
        '../src/runtime/agent/orchestrator/session/manager/turn-checkpoint.mjs'
    );
    let sendCount = 0;
    provider.send = async (_messages, _model, _tools, opts) => {
        sendCount += 1;
        if (sendCount === 1) {
            opts.onTextDelta?.('kill iteration one');
            return {
                content: 'kill iteration one',
                toolCalls: [{
                    id: 'kill_read',
                    name: 'read',
                    arguments: { path: PACKAGE_PATH, offset: 0, limit: 1 },
                }],
                stopReason: 'tool_use',
            };
        }
        opts.onTextDelta?.('kill partial two');
        const poll = setInterval(() => {
            const checkpoint = readTurnCheckpoint(session.id);
            if (!String(checkpoint?.interruption?.partialAssistantContent || '')
                .includes('kill partial two')) return;
            // Do not kill while the unrelated pending-spool critical section
            // holds its lock (mirrors the checkpoint crash anchor).
            if (existsSync(join(
                process.env.MIXDOG_DATA_DIR,
                'session-pending-messages.json.lock',
            ))) return;
            clearInterval(poll);
            process.send?.({ type: 'checkpoint-ready', sessionId: session.id });
        }, 20);
        return new Promise(() => {});
    };
    const session = createSession({
        provider: 'gemini',
        model: 'gemini-test',
        tools: 'readonly',
        cwd: ROOT,
        skipAgentRules: true,
        skipSkills: true,
        compaction: { auto: false },
    });
    await new Promise((resolve) => setImmediate(resolve));
    void askSession(
        session.id,
        'survive a force-killed process',
        null,
        null,
        ROOT,
        null,
        { onTextDelta: () => {} },
    );
}

if (process.argv.includes('--crash-child')) {
    await runCrashChild();
} else {
    const test = (await import('node:test')).default;
    const DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-turn-outcome-matrix-'));
    process.env.MIXDOG_DATA_DIR = DATA_DIR;

    test('turn-outcome fault matrix', { concurrency: false }, async (t) => {
        const { initProviders, getProvider } = await import(
            '../src/runtime/agent/orchestrator/providers/registry.mjs'
        );
        await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
        const provider = getProvider('gemini');
        const {
            abortSessionTurn,
            askSession,
            createSession,
            getSession,
            resumeSession,
        } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
        const { saveSession } = await import(
            '../src/runtime/agent/orchestrator/session/store.mjs'
        );

        const createTestSession = (tools = []) => createSession({
            provider: 'gemini',
            model: 'gemini-test',
            tools,
            cwd: ROOT,
            skipAgentRules: true,
            skipSkills: true,
            compaction: { auto: false },
        });
        const expectInterrupted = async (promise) => {
            await assert.rejects(promise, (error) => error?.name === 'SessionClosedError');
        };

        // ── Row: duplicate + out-of-order tool frames ───────────────────────
        // The same tool call arrives twice as an eager frame AND once more in
        // the terminal response. Exactly one execution, one result, one answer.
        await t.test('duplicate/out-of-order tool frames run the side effect at most once', async () => {
            const session = createTestSession();
            const marker = join(DATA_DIR, 'at-most-once-marker.txt');
            const markerJs = marker.replace(/\\/g, '/');
            const call = {
                id: 'dup_shell',
                name: 'shell',
                arguments: { command: `node -e "require('fs').appendFileSync('${markerJs}','x')"` },
            };
            const ui = uiTextModel();
            let sendCount = 0;
            provider.send = async (_messages, _model, _tools, opts) => {
                sendCount += 1;
                if (sendCount === 1) {
                    opts.onTextDelta?.('running the probe');
                    // Duplicate eager frame, then the terminal frame repeats it.
                    opts.onToolCall?.({ ...call });
                    opts.onToolCall?.({ ...call });
                    return {
                        content: 'running the probe',
                        toolCalls: [{ ...call }],
                        stopReason: 'tool_use',
                    };
                }
                opts.onTextDelta?.('probe complete');
                return { content: 'probe complete', stopReason: 'STOP' };
            };

            const result = await askSession(
                session.id,
                'run the duplicated probe',
                null,
                null,
                ROOT,
                null,
                { onTextDelta: ui.delta },
            );
            // I1: one terminal success.
            assert.equal(result.content, 'probe complete');
            const persisted = getSession(session.id);
            // I2: the side effect ran exactly once despite three frames.
            assert.equal(readFileSync(marker, 'utf8'), 'x');
            assert.equal(countToolResults(persisted.messages, 'dup_shell'), 1);
            // I1/I3: no duplicated assistant turns, no interruption marker.
            assert.equal(countContent(persisted.messages, 'probe complete'), 1);
            assert.equal(countContent(persisted.messages, 'running the probe'), 1);
            assert.equal(countInterruptionMarkers(persisted.messages), 0);
            // I4: every exposed delta is in history, once.
            assert.equal(ui.value(), 'running the probeprobe complete');
            assert.equal(persisted.liveTurnMessages, null);
        });

        // ── Row: stream close before terminal (partial text) ────────────────
        await t.test('stream close before terminal fails the turn and keeps one partial', async () => {
            const session = createTestSession();
            const truncated = Object.assign(
                new Error('stream truncated: message_start without message_stop'),
                {
                    name: 'TruncatedStreamError',
                    code: 'TRUNCATED_STREAM',
                    truncatedStream: true,
                    pendingToolUse: false,
                    partialContent: 'truncated summary',
                },
            );
            const ui = uiTextModel();
            let sendCount = 0;
            provider.send = async (_messages, _model, _tools, opts) => {
                sendCount += 1;
                opts.onTextDelta?.('truncated summary');
                throw truncated;
            };

            // I1/I3: one terminal FAILURE — never a success value.
            await assert.rejects(
                askSession(session.id, 'summarize', null, null, ROOT, null, { onTextDelta: ui.delta }),
                (error) => error === truncated,
            );
            assert.equal(sendCount, 1, 'a stream that already exposed text must not be replayed');

            const persisted = getSession(session.id);
            // I4: exposed text is preserved exactly once.
            assert.equal(countContent(persisted.messages, 'truncated summary'), 1);
            assert.equal(ui.value(), 'truncated summary');
            // A transport truncation is not a user interruption.
            assert.equal(countInterruptionMarkers(persisted.messages), 0);
            assert.equal(persisted.liveTurnMessages, null);

            // I5: the persisted partial replays to the model on the next turn.
            let replayed = null;
            provider.send = async (messages) => {
                replayed = JSON.parse(JSON.stringify(messages));
                return { content: 'recovered after truncation', stopReason: 'STOP' };
            };
            const recovered = await askSession(session.id, 'continue', null, null, ROOT);
            assert.equal(recovered.content, 'recovered after truncation');
            assert.equal(replayed.some((message) => (
                message.role === 'assistant' && message.content === 'truncated summary'
            )), true);
            // I5 (disk): a normal, non-destructive sync save promotes the same
            // outcome to the canonical file. Atomic-save FAULT injection is
            // deliberately NOT done here — it belongs to the store scope, which
            // owns tmp/rename/orphan semantics.
            saveSession(session, { sync: true });
            const stored = JSON.parse(readFileSync(
                join(DATA_DIR, 'sessions', `${session.id}.json`),
                'utf8',
            ));
            assert.equal(countContent(stored.messages, 'truncated summary'), 1);
            assert.equal(countInterruptionMarkers(stored.messages), 0);
        });

        // ── Row: exposed-text failure WITH owner retraction (loop-level) ────
        // Same fault shape as the row above (stream death after relayed text,
        // zero dispatched tools), but the ask owner supplies onTextReset. The
        // loop retracts the exposed characters and earns ONE fresh-request
        // replay instead of failing the turn (live case: make-mips-interpreter
        // died with 31 exposed chars + a pending never-dispatched tool input).
        await t.test('acked text retraction replays an exposed stall once', async () => {
            const session = createTestSession();
            const stalled = Object.assign(
                new Error('stream stalled mid-answer'),
                {
                    name: 'StreamStalledError',
                    code: 'ESTREAMSTALL',
                    streamStalled: true,
                    pendingToolUse: true,
                    partialContent: 'partial answer',
                    // Provider-stamped verdict, exactly as the live failure
                    // carried it (make-mips-interpreter): unsafeToRetry makes
                    // classifyError read terminal — retraction must not gate
                    // on that verdict, because retraction removes the very
                    // exposure that made it unsafe.
                    liveTextEmitted: true,
                    emittedText: true,
                    partialToolCall: true,
                    unsafeToRetry: true,
                    partialHasThinking: true,
                    streamOutcome: {
                        version: 1, provider: 'anthropic', transport: 'sse',
                        terminalObserved: false, continuation: true, declaredContinuation: false,
                        textEmitted: true, textObservedChars: 14, reasoningEmitted: false,
                        toolCallsStarted: true, toolCallsComplete: 0, toolCallsDispatched: 0,
                        dispatchAmbiguous: false, pendingToolInput: true, userAbort: false,
                        stallObserved: true, truncatedStream: false, visibleOutput: true,
                        observedOutput: true, sideEffectDispatched: false,
                        replayUnsafe: true, replaySafe: false, successEligible: false,
                    },
                },
            );
            const ui = uiTextModel();
            let sendCount = 0;
            provider.send = async (_messages, _model, _tools, opts) => {
                sendCount += 1;
                if (sendCount === 1) {
                    opts.onTextDelta?.('partial answer');
                    throw stalled;
                }
                opts.onTextDelta?.('clean final answer');
                return { content: 'clean final answer', stopReason: 'STOP' };
            };

            const result = await askSession(session.id, 'answer', null, null, ROOT, null, {
                onTextDelta: ui.delta,
                onTextReset: (detail) => ui.reset(detail?.chars),
            });
            // I1: one terminal success from the replay.
            assert.equal(result.content, 'clean final answer');
            assert.equal(sendCount, 2, 'acked retraction earns exactly one fresh-request replay');
            const persisted = getSession(session.id);
            // I3/I4: the retracted partial is gone everywhere; the replay's
            // answer is kept exactly once and UI equals history.
            assert.equal(ui.value(), 'clean final answer');
            assert.equal(countContent(persisted.messages, 'partial answer'), 0);
            assert.equal(countContent(persisted.messages, 'clean final answer'), 1);
            assert.equal(countInterruptionMarkers(persisted.messages), 0);
            assert.equal(persisted.liveTurnMessages, null);
        });

        // ── Row: retry/fallback replacement (success) ───────────────────────
        // The provider retracts its exposed draft through the onTextReset seam
        // and replays. History must carry the replacement only.
        await t.test('acknowledged retry replacement leaves one answer, not both attempts', async () => {
            const session = createTestSession();
            const ui = uiTextModel();
            let resetSeen = false;
            provider.send = async (_messages, _model, _tools, opts) => {
                opts.onTextDelta?.('draft answer');
                assert.equal(typeof opts.onTextReset, 'function', 'reset seam must reach the provider');
                resetSeen = await opts.onTextReset({ chars: 'draft answer'.length, reason: 'test-fallback' }) === true;
                assert.equal(resetSeen, true, 'acknowledged reset must be honored');
                opts.onTextDelta?.('final answer');
                return { content: 'final answer', stopReason: 'STOP' };
            };

            const result = await askSession(
                session.id,
                'answer after a fallback',
                null,
                null,
                ROOT,
                null,
                { onTextDelta: ui.delta, onTextReset: (detail) => ui.reset(detail?.chars) },
            );
            // I1: one terminal success carrying the replacement.
            assert.equal(result.content, 'final answer');
            const persisted = getSession(session.id);
            // I3: the retracted draft is never promoted alongside it.
            assert.equal(countContent(persisted.messages, 'final answer'), 1);
            assert.equal(persisted.messages.some((message) => (
                typeof message?.content === 'string' && message.content.includes('draft answer')
            )), false);
            // I4: the UI model (deltas + retraction) equals history.
            assert.equal(ui.value(), 'final answer');
        });

        // ── Row: abort during a provider retry ──────────────────────────────
        await t.test('abort during a retry yields one terminal and no duplicated fragments', async () => {
            const session = createTestSession();
            const ui = uiTextModel();
            const retried = deferred();
            let sendCount = 0;
            provider.send = async (_messages, _model, _tools, opts) => {
                sendCount += 1;
                opts.onTextDelta?.('draft attempt');
                await opts.onTextReset?.({ chars: 'draft attempt'.length, reason: 'test-retry' });
                opts.onTextDelta?.('retry attempt');
                retried.resolve();
                return waitForAbort(opts);
            };

            const asking = askSession(
                session.id,
                'abort while retrying',
                null,
                null,
                ROOT,
                null,
                { onTextDelta: ui.delta, onTextReset: (detail) => ui.reset(detail?.chars) },
            );
            await retried.promise;
            assert.equal(abortSessionTurn(session.id, 'user-cancel'), true);
            // I1/I3: exactly one terminal, and it is a cancellation — not a success.
            await expectInterrupted(asking);
            assert.equal(sendCount, 1, 'an aborted retry must not start another attempt');

            const persisted = getSession(session.id);
            const transcript = persisted.messages
                .map((message) => (typeof message?.content === 'string' ? message.content : ''))
                .join('\u0000');
            // Each exposed fragment survives at most once (no attempt doubling).
            assert.equal(transcript.split('retry attempt').length - 1, 1);
            assert.ok(transcript.split('draft attempt').length - 1 <= 1);
            // I4 UI/history parity across the retraction. The UI model applied
            // the acknowledged reset, so it currently shows only the surviving
            // attempt; history must (a) contain everything the UI still shows,
            // (b) contain nothing that was never exposed, and (c) never expose
            // a fragment twice. `exposedEver` is every byte the UI ever saw.
            const uiVisible = ui.value();
            const exposedEver = ['draft attempt', 'retry attempt'];
            assert.equal(uiVisible, 'retry attempt');
            const partial = persisted.messages.find((message) => (
                message.role === 'assistant'
                && typeof message.content === 'string'
                && message.content.includes(uiVisible)
            ));
            assert.ok(partial, 'history must keep the text the UI still shows');
            // (b) nothing beyond the exposed fragments survived: removing each
            // exposed fragment once leaves an empty string.
            let residue = partial.content;
            for (const fragment of exposedEver) residue = residue.replace(fragment, '');
            assert.equal(residue.trim(), '', 'history must not carry text the UI never exposed');
            // (c) no fragment is duplicated inside the preserved partial.
            for (const fragment of exposedEver) {
                assert.ok(
                    partial.content.split(fragment).length - 1 <= 1,
                    `exposed fragment duplicated in history: ${fragment}`,
                );
            }
            // I1: exactly one interruption marker closes the turn.
            assert.equal(countInterruptionMarkers(persisted.messages), 1);
            assert.equal(persisted.messages.at(-1)?.content, USER_INTERRUPTION_MESSAGE);
            assert.equal(persisted.liveTurnMessages, null);
        });

        // ── Row: partial vs complete tool calls under abort ─────────────────
        let toolSession;
        await t.test('completed tool results survive; an unfinished call is closed once', async () => {
            toolSession = createTestSession();
            provider.send = async () => ({
                content: 'checking both slices',
                toolCalls: [
                    { id: 'done_read', name: 'read', arguments: { path: PACKAGE_PATH, offset: 0, limit: 1 } },
                    { id: 'slow_shell', name: 'shell', arguments: { command: 'node -e "setTimeout(function () {}, 8000)"' } },
                ],
                stopReason: 'tool_use',
            });
            const asking = askSession(
                toolSession.id,
                'read two slices',
                null,
                null,
                ROOT,
                null,
                {
                    onToolResult: (message) => {
                        if (message?.toolCallId === 'done_read') abortSessionTurn(toolSession.id, 'user-cancel');
                    },
                },
            );
            await expectInterrupted(asking);

            const persisted = getSession(toolSession.id);
            // I2: one result per call id — no re-dispatch, no duplicate close.
            assert.equal(countToolResults(persisted.messages, 'done_read'), 1);
            assert.equal(countToolResults(persisted.messages, 'slow_shell'), 1);
            const unfinished = persisted.messages.find((message) => (
                message.role === 'tool' && message.toolCallId === 'slow_shell'
            ));
            // I3: the unfinished call is an error result, never a success.
            assert.equal(unfinished.toolKind, 'error');
            assert.equal(countInterruptionMarkers(persisted.messages), 1);
            assert.equal(persisted.messages.at(-1)?.content, TOOL_USE_INTERRUPTION_MESSAGE);
        });

        await t.test('the closed trajectory replays to the next request', async () => {
            let replayed = null;
            provider.send = async (messages) => {
                replayed = JSON.parse(JSON.stringify(messages));
                return { content: 'resumed after tool close', stopReason: 'STOP' };
            };
            const result = await askSession(toolSession.id, 'continue', null, null, ROOT);
            // I5: durable replay of both the completed and the closed call.
            assert.equal(result.content, 'resumed after tool close');
            assert.equal(replayed.filter((message) => (
                message.role === 'tool' && message.toolCallId === 'slow_shell'
            )).length, 1);
            assert.equal(replayed.filter((message) => (
                message.role === 'tool' && message.toolCallId === 'done_read'
            )).length, 1);
        });

        // ── Persistence faults: OUT OF SCOPE for this file ───────────────────
        // Atomic-save fault injection (tmp/rename failure, orphan scratch
        // files, generation-guarded drops) is owned by the store scope. Doing
        // it here would require deleting or replacing a valid canonical
        // session file on disk, which is destructive and cannot assert the
        // real store invariants (no orphan tmp, atomic promotion) from the
        // turn-outcome seam. This file therefore covers persistence only
        // through NON-DESTRUCTIVE writes: the durable-replay assertions in the
        // truncation row above and in the kill/restart row below.

        // ── Row: process kill / restart ─────────────────────────────────────
        await t.test('a force-killed turn recovers with one terminal marker and replays', async () => {
            const child = fork(SELF, ['--crash-child'], {
                cwd: ROOT,
                env: {
                    ...process.env,
                    MIXDOG_DATA_DIR: DATA_DIR,
                    MIXDOG_AGENT_TRACE_DISABLE: '1',
                },
                stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
            });
            // The child must NEVER outlive this subtest: every exit path
            // (ready, timeout, spawn error, assertion failure) goes through
            // killAndWait, and the recorded exit is asserted to be the signal
            // we sent — proving the recovery below really followed a SIGKILL
            // and not a graceful shutdown that could have flushed state.
            const exited = new Promise((resolve) => {
                child.once('exit', (code, signal) => resolve({ code, signal }));
            });
            const killAndWait = async () => {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
                return exited;
            };
            let ready;
            try {
                ready = await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('kill child timed out')), 20_000);
                    child.once('error', (err) => { clearTimeout(timer); reject(err); });
                    child.on('message', (message) => {
                        if (message?.type !== 'checkpoint-ready') return;
                        clearTimeout(timer);
                        resolve(message);
                    });
                });
            } catch (err) {
                await killAndWait();
                throw err;
            }
            const killOutcome = await killAndWait();
            assert.equal(killOutcome.signal, 'SIGKILL', 'the child must die by the signal we sent');
            assert.equal(killOutcome.code, null, 'a signalled kill reports no exit code');

            const resumed = await resumeSession(ready.sessionId, 'readonly');
            assert.ok(resumed);
            // I1: exactly one terminal marker closes the killed turn.
            assert.equal(countInterruptionMarkers(resumed.messages), 1);
            assert.equal(resumed.messages.at(-1)?.content, PROCESS_RESTART_MESSAGE);
            // I2/I4: the completed iteration, its single tool result and the
            // streamed partial each survive exactly once.
            assert.equal(countContent(resumed.messages, 'kill iteration one'), 1);
            assert.equal(countToolResults(resumed.messages, 'kill_read'), 1);
            assert.equal(countContent(resumed.messages, 'kill partial two'), 1);

            // I5: the recovered history is what the next request replays.
            await new Promise((resolve) => setImmediate(resolve));
            let replayed = null;
            getProvider('gemini').send = async (messages) => {
                replayed = JSON.parse(JSON.stringify(messages));
                return { content: 'continued after restart', stopReason: 'STOP' };
            };
            const result = await askSession(ready.sessionId, 'continue after restart', null, null, ROOT);
            assert.equal(result.content, 'continued after restart');
            assert.equal(countContent(replayed, 'kill partial two'), 1);
            assert.equal(replayed.filter((message) => (
                message.role === 'tool' && message.toolCallId === 'kill_read'
            )).length, 1);
        });
    });
}
