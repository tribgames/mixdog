import assert from 'node:assert/strict';
import test from 'node:test';
import { createEagerDispatcher } from './eager-dispatch.mjs';
import {
    _repeatFailurePatternWouldContinue,
    _repeatFailureSig,
} from './loop/tool-classify.mjs';

function gate() {
    let release;
    return { promise: new Promise((resolve) => { release = resolve; }), release };
}

test('eager dispatch serializes Git mutations, file edits, and shell verification', async () => {
    const gitGate = gate();
    const patchGate = gate();
    const events = [];
    const executeToolFn = async (name) => {
        events.push(`${name}:start`);
        if (name === 'git') await gitGate.promise;
        if (name === 'apply_patch') await patchGate.promise;
        events.push(`${name}:end`);
        return { result: 'ok', explicitSuccess: true };
    };
    const dispatcher = createEagerDispatcher({
        tools: [],
        cwd: process.cwd(),
        sessionId: null,
        sessionRef: {},
        signal: null,
        opts: {},
        crossTurnCalls: new Map(),
        getIterations: () => 1,
        getNextIteration: () => 1,
        repeatFailLimit: 3,
        executeToolFn,
    });
    const calls = [
        { id: 'git', name: 'git', arguments: { command: 'git add --all' } },
        { id: 'patch', name: 'apply_patch', arguments: { patch: 'test' } },
        { id: 'shell', name: 'shell', arguments: { command: 'git status' } },
    ];

    dispatcher.startEagerRun(calls, 0, new Set());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['git:start']);

    gitGate.release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['git:start', 'git:end', 'apply_patch:start']);

    patchGate.release();
    await Promise.all([...dispatcher.pending.values()].map((entry) => entry.promise));
    assert.deepEqual(events, [
        'git:start', 'git:end',
        'apply_patch:start', 'apply_patch:end',
        'shell:start', 'shell:end',
    ]);
});

test('repeat failure signatures normalize paths and detect alternating cycles', () => {
    const cwd = process.cwd();
    const relative = _repeatFailureSig('read', { file_path: 'missing/file.txt' }, cwd);
    const absolute = _repeatFailureSig('read', {
        file_path: `${cwd}/missing/file.txt`,
    }, cwd);
    assert.equal(relative, absolute);

    const other = _repeatFailureSig('read', { file_path: 'missing/other.txt' }, cwd);
    const history = [relative, other, relative, other, relative, other];
    assert.equal(_repeatFailurePatternWouldContinue(history, relative, 3), 2);
    assert.equal(_repeatFailurePatternWouldContinue(history, other, 3), 0);
});
