#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const PROCESS_RESTART_MESSAGE = '[Request interrupted by process restart]';

async function waitFor(predicate, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return predicate();
}

async function runCrashChild() {
    process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
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
            opts.onTextDelta?.('completed iteration');
            return {
                content: 'completed iteration',
                toolCalls: [{
                    id: 'crash_read',
                    name: 'read',
                    arguments: { path: join(ROOT, 'package.json'), offset: 0, limit: 1 },
                }],
                stopReason: 'tool_use',
            };
        }
        opts.onTextDelta?.('partial after completed tool');
        const poll = setInterval(() => {
            const checkpoint = readTurnCheckpoint(session.id);
            if (!String(checkpoint?.interruption?.partialAssistantContent || '')
                .includes('partial after completed tool')) return;
            // askSession starts pending-spool hydration in parallel. Kill only
            // after that unrelated atomic critical section has released its
            // lock, so this test isolates turn-checkpoint crash recovery.
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
    // Let pending-messages.mjs finish its one-shot startup sweep before the
    // first ask starts asynchronous hydration against the same spool lock.
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
    test('force-killed turns restore completed iterations and the streaming partial', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-turn-checkpoint-crash-'));
        process.env.MIXDOG_DATA_DIR = dataDir;
        process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
        const child = fork(SELF, ['--crash-child'], {
            cwd: ROOT,
            env: {
                ...process.env,
                MIXDOG_DATA_DIR: dataDir,
                MIXDOG_AGENT_TRACE_DISABLE: '1',
            },
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        const ready = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('checkpoint child timed out')), 15_000);
            child.once('error', reject);
            child.on('message', (message) => {
                if (message?.type !== 'checkpoint-ready') return;
                clearTimeout(timer);
                resolve(message);
            });
        });
        const checkpointPath = join(dataDir, 'turn-checkpoints', `${ready.sessionId}.json`);
        assert.equal(existsSync(checkpointPath), true);
        const checkpointBeforeKill = JSON.parse(readFileSync(checkpointPath, 'utf8'));
        assert.match(checkpointBeforeKill.interruption.partialAssistantContent, /partial after completed tool/);

        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exited;

        const { initProviders, getProvider } = await import(
            '../src/runtime/agent/orchestrator/providers/registry.mjs'
        );
        await initProviders({ gemini: { enabled: true, apiKey: 'test-only' } });
        const {
            askSession,
            getSession,
            resumeSession,
        } = await import('../src/runtime/agent/orchestrator/session/manager.mjs');
        const { readStoredSessionTranscript } = await import(
            '../src/runtime/agent/orchestrator/session/store-summary-reader.mjs'
        );
        // Desktop restores every visible background pane through a startup
        // peek. That peek must commit crash recovery before any click/resume.
        const peeked = await readStoredSessionTranscript(ready.sessionId);
        assert.ok(peeked);
        const peekedText = JSON.stringify(peeked.items);
        assert.match(peekedText, /completed iteration/);
        assert.match(peekedText, /partial after completed tool/);
        assert.match(peekedText, /Request interrupted by process restart/);
        assert.equal(existsSync(checkpointPath), false);

        const resumed = await resumeSession(ready.sessionId, 'readonly');
        assert.ok(resumed);
        assert.equal(resumed.messages.some((message) => (
            message.role === 'assistant' && message.content === 'completed iteration'
        )), true);
        assert.equal(resumed.messages.some((message) => (
            message.role === 'tool' && message.toolCallId === 'crash_read'
        )), true);
        assert.equal(resumed.messages.some((message) => (
            message.role === 'assistant' && message.content === 'partial after completed tool'
        )), true);
        assert.equal(resumed.messages.at(-1)?.content, PROCESS_RESTART_MESSAGE);

        await new Promise((resolve) => setImmediate(resolve));
        getProvider('gemini').send = async () => ({
            content: 'continued normally',
            stopReason: 'STOP',
        });
        await askSession(ready.sessionId, 'continue after restart', null, null, ROOT);
        assert.equal(getSession(ready.sessionId).messages.at(-1)?.content, 'continued normally');
        assert.equal(await waitFor(() => !existsSync(checkpointPath)), true);
    });

    test('closed live agent checkpoints project user, assistant, and tool rows read-only', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-live-agent-checkpoint-'));
        const previousDataDir = process.env.MIXDOG_DATA_DIR;
        process.env.MIXDOG_DATA_DIR = dataDir;
        const sessionId = 'agent_live_checkpoint';
        const sessionPath = join(dataDir, 'sessions', `${sessionId}.json`);
        const checkpointPath = join(dataDir, 'turn-checkpoints', `${sessionId}.json`);
        mkdirSync(dirname(sessionPath), { recursive: true });
        mkdirSync(dirname(checkpointPath), { recursive: true });
        const session = {
            id: sessionId,
            owner: 'agent',
            ownerSessionId: 'lead_owner',
            agent: 'heavy-worker',
            agentTag: 'live-checkpoint',
            closed: true,
            status: 'closed',
            generation: 5,
            updatedAt: 100,
            activeTurnCheckpoint: {
                version: 1,
                turnToken: 'live-turn',
                startedAt: 90,
            },
            provider: 'openai',
            model: 'gpt-test',
            contextWindow: 100_000,
            rawContextWindow: 120_000,
            compactBoundaryTokens: 80_000,
            autoCompactTokenLimit: 60_000,
            messages: [
                { role: 'system', content: 'system' },
                { role: 'user', content: 'Inspect the checkout' },
            ],
        };
        const checkpoint = {
            version: 1,
            sessionId,
            generation: 4,
            turnToken: 'live-turn',
            currentUserContent: 'Inspect the checkout',
            updatedAt: 200,
            turnMessages: [
                { role: 'user', content: 'Inspect the checkout' },
                {
                    role: 'assistant',
                    content: 'Reading the implementation',
                    toolCalls: [{
                        id: 'read_live',
                        name: 'read',
                        arguments: { path: 'src/index.ts' },
                    }],
                },
                {
                    role: 'tool',
                    toolCallId: 'read_live',
                    name: 'read',
                    content: 'export const ready = true;',
                },
                { role: 'assistant', content: 'The implementation is ready.' },
            ],
        };
        writeFileSync(sessionPath, JSON.stringify(session));
        writeFileSync(checkpointPath, JSON.stringify(checkpoint));
        try {
            const { readStoredSessionTranscript } = await import(
                '../src/runtime/agent/orchestrator/session/store-summary-reader.mjs'
            );
            const transcript = await readStoredSessionTranscript(sessionId);
            const text = JSON.stringify(transcript?.items || []);
            assert.equal(transcript?.readOnlyDetachedAgent, true);
            assert.ok(Number(transcript?.stats?.currentEstimatedContextTokens) > 0,
                'a cold visible pane receives transcript-derived context usage before focus');
            assert.equal(transcript?.stats?.currentContextSource, 'estimated');
            assert.equal(transcript?.contextWindow, 100_000);
            assert.equal(transcript?.rawContextWindow, 120_000);
            assert.equal(transcript?.displayContextWindow, 80_000);
            assert.equal(transcript?.autoCompactTokenLimit, 60_000);
            assert.match(text, /Reading the implementation/);
            assert.match(text, /read_live|src\/index\.ts/);
            assert.match(text, /implementation is ready/);
            assert.equal(existsSync(checkpointPath), true,
                'live projection must not consume the owner checkpoint');
            assert.deepEqual(JSON.parse(readFileSync(sessionPath, 'utf8')), session,
                'live projection must not mutate the detached durable session');
            writeFileSync(checkpointPath, JSON.stringify({
                ...checkpoint,
                turnToken: 'wrong-turn',
                updatedAt: 300,
            }));
            const stale = await readStoredSessionTranscript(sessionId);
            assert.doesNotMatch(JSON.stringify(stale?.items || []), /Reading the implementation/,
                'a generation handoff with a different turn token must remain rejected');
        } finally {
            if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
            else process.env.MIXDOG_DATA_DIR = previousDataDir;
            rmSync(dataDir, { recursive: true, force: true });
        }
    });
}
