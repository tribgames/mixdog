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

test('same-file edits serialize while different-file edits stay parallel', async () => {
    const firstEditGate = gate();
    const events = [];
    const executeToolFn = async (name, args) => {
        events.push(`start:${args.file_path}#${args.old_string}`);
        if (args.old_string === 'a1') await firstEditGate.promise;
        events.push(`end:${args.file_path}#${args.old_string}`);
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
        { id: 'e1', name: 'edit', arguments: { file_path: 'a.txt', old_string: 'a1', new_string: 'x' } },
        { id: 'e2', name: 'edit', arguments: { file_path: 'A.TXT', old_string: 'a2', new_string: 'y' } },
        { id: 'e3', name: 'edit', arguments: { file_path: 'b.txt', old_string: 'b1', new_string: 'z' } },
    ];

    dispatcher.startEagerRun(calls, 0, new Set());
    await new Promise((resolve) => setImmediate(resolve));
    // e1 runs and blocks. e2 targets the same file (case variant) and must
    // wait. e3 targets an independent file and must run to completion in
    // parallel with the blocked e1.
    assert.ok(events.includes('start:a.txt#a1'));
    assert.ok(!events.includes('start:A.TXT#a2'));
    assert.ok(events.includes('end:b.txt#b1'));

    firstEditGate.release();
    await Promise.all([...dispatcher.pending.values()].map((entry) => entry.promise));
    assert.ok(events.indexOf('start:A.TXT#a2') > events.indexOf('end:a.txt#a1'));
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
