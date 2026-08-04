// Mixed patch-batch ordering insurance: apply_patch is a serial barrier while
// side effects run in parallel inside each surrounding segment. A failed patch
// skips only later side effects; shell-only batches retain full parallelism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEagerDispatcher } from '../src/runtime/agent/orchestrator/session/eager-dispatch.mjs';
import { processToolBatch } from '../src/runtime/agent/orchestrator/session/tool-batch.mjs';
import { resolveSessionCwd, stateFilePath } from '../src/runtime/agent/orchestrator/tools/shell-state.mjs';

const TEST_TOOLS = [
    { name: 'read', annotations: { readOnlyHint: true } },
    { name: 'shell', annotations: { readOnlyHint: false } },
    { name: 'apply_patch', annotations: { readOnlyHint: false } },
];

function makeDispatcher(started, executeToolFn = async () => 'ok') {
    return createEagerDispatcher({
        tools: TEST_TOOLS,
        cwd: process.cwd(),
        sessionId: null,
        sessionRef: null,
        signal: undefined,
        opts: {},
        crossTurnCalls: new Map(),
        getIterations: () => 1,
        getNextIteration: () => 1,
        repeatFailLimit: 3,
        executeToolFn: async (...args) => {
            started.push(args[0]);
            return executeToolFn(...args);
        },
    });
}

async function runBatch(calls, executeToolFn, { sessionId = null, cwd = process.cwd() } = {}) {
    const results = [];
    const dispatcher = createEagerDispatcher({
        tools: TEST_TOOLS,
        cwd,
        sessionId,
        sessionRef: {},
        signal: undefined,
        opts: {},
        crossTurnCalls: new Map(),
        getIterations: () => 1,
        getNextIteration: () => 1,
        repeatFailLimit: 3,
        executeToolFn,
    });
    await processToolBatch({
        calls,
        messages: [],
        tools: TEST_TOOLS,
        cwd,
        sessionId,
        sessionRef: {},
        signal: undefined,
        opts: {},
        iterations: 1,
        assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
        pending: dispatcher.pending,
        epoch: dispatcher.epoch,
        startEagerRun: dispatcher.startEagerRun,
        crossTurnCalls: new Map(),
        crossTurnCap: 100,
        dedupStubTotal: 0,
        editCount: 0,
        sessionAgent: 'lead',
        steeringLadder: { emitPostBatchSteering() {} },
        pushToolResultMessage: (message) => results.push(message),
        throwIfAborted() {},
        repeatFailLimit: 3,
        executeToolFn,
    });
    return results;
}

test('streaming: side effects after a streamed patch wait for their segment', () => {
    const started = [];
    const d = makeDispatcher(started);
    d.onToolCall({ id: 'c1', name: 'apply_patch', arguments: { patch: 'x' } });
    d.onToolCall({ id: 'c2', name: 'shell', arguments: { command: 'echo hi' } });
    assert.equal(d.pending.has('c1'), false, 'apply_patch never eager-starts');
    assert.equal(d.pending.has('c2'), false, 'postpatch shell must wait for the barrier');
});

test('streaming: side effects before any streamed patch eager-start', () => {
    const started = [];
    const d = makeDispatcher(started);
    d.onToolCall({ id: 's1', name: 'shell', arguments: { command: 'probe' } });
    assert.equal(d.pending.has('s1'), true, 'segment-0 shell should overlap provider streaming');
    d.onToolCall({ id: 'p1', name: 'apply_patch', arguments: { patch: 'x' } });
    d.onToolCall({ id: 's2', name: 'shell', arguments: { command: 'verify' } });
    assert.equal(d.pending.has('p1'), false, 'apply_patch never eager-starts');
    assert.equal(d.pending.has('s2'), false, 'postpatch shell must wait for the barrier');
});

test('streaming: declared read-only calls still eager-start', () => {
    const started = [];
    const d = makeDispatcher(started);
    d.onToolCall({ id: 'c1', name: 'read', arguments: { path: 'a.txt' } });
    assert.equal(d.pending.has('c1'), true, 'read-only work should overlap provider streaming');
});

test('batch run: shell after apply_patch is left to the serial body', () => {
    const started = [];
    const d = makeDispatcher(started);
    const calls = [
        { id: 'p1', name: 'apply_patch', arguments: { patch: 'x' } },
        { id: 's1', name: 'shell', arguments: { command: 'run tests' } },
        { id: 'r1', name: 'read', arguments: { path: 'a.txt' } },
    ];
    d.startEagerRun(calls, 0, null);
    assert.equal(d.pending.has('p1'), false, 'apply_patch never eager-starts');
    assert.equal(d.pending.has('s1'), false, 'shell after patch must not eager-start');
    assert.equal(d.pending.has('r1'), true, 'reads stay parallel (epoch-guarded)');
});

test('batch run: prepatch shell segment starts but postpatch shell segment waits', () => {
    const started = [];
    const d = makeDispatcher(started);
    const calls = [
        { id: 's1', name: 'shell', arguments: { command: 'prepare' } },
        { id: 'p1', name: 'apply_patch', arguments: { patch: 'x' } },
        { id: 's2', name: 'shell', arguments: { command: 'verify' } },
        { id: 'r1', name: 'read', arguments: { path: 'a.txt' } },
    ];
    d.startEagerRun(calls, 0, null);
    assert.equal(d.pending.has('s1'), true, 'prepatch shell segment should overlap');
    assert.equal(d.pending.has('p1'), false, 'apply_patch never eager-starts');
    assert.equal(d.pending.has('s2'), false, 'postpatch shell must wait for the barrier');
    assert.equal(d.pending.has('r1'), true, 'reads stay parallel (epoch-guarded)');
});

test('batch run: shell with no earlier patch eager-starts', () => {
    const started = [];
    const d = makeDispatcher(started);
    const calls = [
        { id: 's1', name: 'shell', arguments: { command: 'probe' } },
        { id: 's2', name: 'shell', arguments: { command: 'probe2' } },
    ];
    d.startEagerRun(calls, 0, null);
    assert.equal(d.pending.has('s1'), true);
    assert.equal(d.pending.has('s2'), true);
});

test('patch-first mixed batch runs patch then later shells in parallel', async () => {
    const events = [];
    let active = 0;
    let maxActive = 0;
    const calls = [
        { id: 'p1', name: 'apply_patch', arguments: { patch: 'patch', label: 'patch' } },
        { id: 's1', name: 'shell', arguments: { command: 'one', label: 'shell-1' } },
        { id: 's2', name: 'shell', arguments: { command: 'two', label: 'shell-2' } },
    ];
    const results = await runBatch(calls, async (_name, args) => {
        events.push(`start:${args.label}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        events.push(`end:${args.label}`);
        return 'ok';
    });

    assert.deepEqual(events.slice(0, 2), ['start:patch', 'end:patch']);
    assert.deepEqual(new Set(events.slice(2, 4)), new Set(['start:shell-1', 'start:shell-2']));
    assert.equal(maxActive, 2);
    assert.deepEqual(results.map((result) => result.toolKind), ['normal', 'normal', 'normal']);
});

test('tool results preserve call order when a later duplicate is skipped early', async () => {
    const calls = [
        { id: 'r1', name: 'read', arguments: { path: 'same.txt' } },
        { id: 'r2', name: 'read', arguments: { path: 'same.txt' } },
    ];
    const results = await runBatch(calls, async () => 'read body');
    assert.deepEqual(results.map((result) => result.toolCallId), ['r1', 'r2']);
    assert.equal(results[0].content, 'read body');
    assert.match(results[1].content, /\[intra-turn-dedup\]/);
});

test('prepatch shell segment finishes in parallel before the patch barrier', async () => {
    const events = [];
    let active = 0;
    let maxActive = 0;
    const calls = [
        { id: 's1', name: 'shell', arguments: { command: 'one', label: 'shell-1' } },
        { id: 's2', name: 'shell', arguments: { command: 'two', label: 'shell-2' } },
        { id: 'p1', name: 'apply_patch', arguments: { patch: 'patch', label: 'patch' } },
    ];
    await runBatch(calls, async (_name, args) => {
        events.push(`start:${args.label}`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        events.push(`end:${args.label}`);
        return 'ok';
    });
    assert.deepEqual(new Set(events.slice(0, 2)), new Set(['start:shell-1', 'start:shell-2']));
    assert.ok(events.indexOf('start:patch') > events.indexOf('end:shell-1'));
    assert.ok(events.indexOf('start:patch') > events.indexOf('end:shell-2'));
    assert.equal(maxActive, 2);
});

test('failed patch skips later shells without starting them', async () => {
    const executed = [];
    const calls = [
        { id: 'p1', name: 'apply_patch', arguments: { patch: 'patch' } },
        { id: 's1', name: 'shell', arguments: { command: 'one' } },
        { id: 's2', name: 'shell', arguments: { command: 'two' } },
    ];
    const results = await runBatch(calls, async (name) => {
        executed.push(name);
        return name === 'apply_patch' ? 'Error: patch failed' : 'ok';
    });

    assert.deepEqual(executed, ['apply_patch']);
    assert.deepEqual(results.map((result) => result.toolKind), ['error', 'skipped', 'skipped']);
    assert.match(results[1].content, /\[prerequisite-failed\].*skipped without starting/i);
});

test('shell-only batch retains parallel execution', async () => {
    let active = 0;
    let maxActive = 0;
    const calls = [
        { id: 's1', name: 'shell', arguments: { command: 'one' } },
        { id: 's2', name: 'shell', arguments: { command: 'two' } },
    ];
    await runBatch(calls, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return 'ok';
    });
    assert.equal(maxActive, 2);
});

test('parallel shells commit cwd probes deterministically in model call order', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixdog-shell-cwd-batch-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const sessionId = `shell-cwd-${process.pid}-${Date.now()}`;
    const calls = [
        { id: 's1', name: 'shell', arguments: { command: 'one', finalCwd: first } },
        { id: 's2', name: 'shell', arguments: { command: 'two', finalCwd: second } },
    ];
    try {
        await runBatch(calls, async (_name, args, _cwd, _sessionId, _sessionRef, options) => {
            assert.equal(options.deferShellCwdCommit, true);
            fs.writeFileSync(stateFilePath(sessionId, options.toolCallId), `${args.finalCwd}\n`);
            if (options.toolCallId === 's1') {
                await new Promise((resolve) => setTimeout(resolve, 15));
            }
            return 'ok';
        }, { sessionId, cwd: root });
        assert.equal(resolveSessionCwd(sessionId, null, root), second);
    } finally {
        try { fs.rmSync(stateFilePath(sessionId), { force: true }); } catch {}
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('side-effect segments around a patch preserve barrier order', async () => {
    const events = [];
    const calls = [
        { id: 's1', name: 'shell', arguments: { command: 'prepare', label: 'shell-before' } },
        { id: 'p1', name: 'apply_patch', arguments: { patch: 'patch', label: 'patch' } },
        { id: 's2', name: 'shell', arguments: { command: 'verify', label: 'shell-after' } },
    ];
    const results = await runBatch(calls, async (_name, args) => {
        events.push(args.label);
        return 'ok';
    });
    assert.deepEqual(events, ['shell-before', 'patch', 'shell-after']);
    assert.deepEqual(results.map((result) => result.toolKind), ['normal', 'normal', 'normal']);
});

test('a failed patch after an earlier shell skips only later side effects', async () => {
    const executed = [];
    const calls = [
        { id: 's1', name: 'shell', arguments: { command: 'prepatch' } },
        { id: 'p1', name: 'apply_patch', arguments: { patch: 'patch' } },
        { id: 's2', name: 'shell', arguments: { command: 'postpatch' } },
    ];
    const results = await runBatch(calls, async (name) => {
        executed.push(name);
        return name === 'apply_patch' ? 'Error: patch failed' : 'ok';
    });
    assert.deepEqual(executed, ['shell', 'apply_patch']);
    assert.deepEqual(results.map((result) => result.toolKind), ['normal', 'error', 'skipped']);
    assert.match(results[2].content, /\[prerequisite-failed\].*skipped without starting/i);
});
