import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-read-cache-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
const {
    captureReadCacheState, tryReadCached, setReadCached, invalidatePathForSession,
} = await import('./read-cache.mjs');
const { _statTuple } = await import('./util.mjs');
const { setScopedToolCached } = await import('./scoped-cache.mjs');
const { executeBuiltinTool } = await import('../../tools/builtin.mjs');
const { BUILTIN_TOOLS } = await import('../../tools/builtin/builtin-tools.mjs');
const { processToolBatch } = await import('../tool-batch.mjs');
const { createEagerDispatcher } = await import('../eager-dispatch.mjs');

function fixture(text = 'LINE_1\nLINE_2\nLINE_3\nLINE_4\nLINE_5\n') {
    const cwd = mkdtempSync(join(root, 'case-'));
    const file = join(cwd, 'file.txt');
    writeFileSync(join(cwd, 'original.txt'), text);
    writeFileSync(file, text);
    return { cwd, file, sessionId: `cache-test-${randomUUID()}` };
}
function nextOffset(output) {
    const match = /(?:pass offset:|next offset:\s*)(\d+)/.exec(output);
    assert.ok(match, output);
    return Number(match[1]);
}
async function batch(fx, calls, executeToolFn, { eager = false, schemaAllowedTools = null } = {}) {
    const results = [];
    const sessionRef = { schemaAllowedTools };
    const crossTurnCalls = new Map();
    const dispatcher = createEagerDispatcher({
        tools: BUILTIN_TOOLS, cwd: fx.cwd, sessionId: fx.sessionId, sessionRef,
        signal: null, opts: {}, crossTurnCalls, getIterations: () => 1,
        getNextIteration: () => 1, repeatFailLimit: 3, executeToolFn,
    });
    if (eager) {
        for (const call of calls) dispatcher.onToolCall(call);
        await Promise.all([...dispatcher.pending.values()].map(entry => entry.promise));
    }
    await processToolBatch({
        calls, messages: [], tools: BUILTIN_TOOLS, cwd: fx.cwd, sessionId: fx.sessionId,
        sessionRef, signal: null, opts: {}, iterations: 1,
        assistantTurnMsg: { role: 'assistant', content: '', toolCalls: calls },
        pending: dispatcher.pending, epoch: dispatcher.epoch,
        startEagerRun: eager ? dispatcher.startEagerRun : () => {},
        crossTurnCalls, crossTurnCap: 100, sessionAgent: null,
        pushToolResultMessage: message => results.push(message),
        throwIfAborted: () => {}, repeatFailLimit: 3, dedupStubTotal: 0, editCount: 0,
        executeToolFn,
    });
    return results;
}
const readCall = args => ({ id: randomUUID(), name: 'read', arguments: args });
const executeRead = fx => (name, args, cwd) =>
    executeBuiltinTool(name, args, cwd, { sessionId: fx.sessionId });

test('unchanged scalar reads retain exact cached content and source identity', async () => {
    const fx = fixture();
    const args = { file_path: fx.file, offset: 1, limit: 2 };
    const readState = captureReadCacheState({ args, cwd: fx.cwd });
    const content = String(await executeRead(fx)('read', args, fx.cwd));
    setReadCached({ ...fx, args, content, toolUseId: 'original', readState });
    assert.equal(tryReadCached({ ...fx, args })?.content, content);
    assert.equal(tryReadCached({ ...fx, args })?.firstToolUseId, 'original');
});

for (const firstPublic of [true, false]) {
    test(`cached continuation never skips or repeats a row across aliases (public first=${firstPublic})`, async () => {
        const fx = fixture();
        const publicArgs = { file_path: fx.file, offset: 1, limit: 2 };
        const legacyArgs = { path: fx.file, offset: 0, limit: 2 };
        const first = firstPublic ? publicArgs : legacyArgs;
        const second = firstPublic ? legacyArgs : publicArgs;
        const content = String(await executeRead(fx)('read', first, fx.cwd));
        setReadCached({ ...fx, args: first, content });
        const hit = tryReadCached({ ...fx, args: second });
        const output = hit?.content ?? String(await executeBuiltinTool('read', second, fx.cwd, {
            sessionId: fx.sessionId, suppressReadUnchangedStub: true,
        }));
        const resume = String(await executeRead(fx)('read', {
            ...second, offset: nextOffset(output),
        }, fx.cwd));
        assert.match(resume, /^3→LINE_3/);
    });
}

test('same-size same-mtime external rewrites invalidate session results', async () => {
    const fx = fixture('BEFORE\n');
    const time = new Date('2025-01-01T00:00:00.000Z');
    utimesSync(fx.file, time, time);
    const args = { file_path: fx.file };
    const content = String(await executeRead(fx)('read', args, fx.cwd));
    setReadCached({ ...fx, args, content });
    const before = statSync(fx.file);
    writeFileSync(fx.file, 'AFTER_\n');
    utimesSync(fx.file, time, time);
    const after = statSync(fx.file);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeMs, after.mtimeMs);
    assert.notEqual(before.ctimeMs, after.ctimeMs);
    assert.equal(tryReadCached({ ...fx, args }), null);
});

for (const publicInput of [false, true]) {
    for (const objects of [false, true]) {
        test(`array caching preserves windows and invalidates by constituent path (public=${publicInput}, objects=${objects})`, async () => {
            const fx = fixture();
            const other = join(fx.cwd, 'other.txt');
            writeFileSync(other, 'OTHER_1\nOTHER_2\n');
            const key = publicInput ? 'file_path' : 'path';
            const paths = [fx.file, other];
            const args = objects
                ? { [key]: paths.map(path => ({ [key]: path, offset: publicInput ? 2 : 1, limit: 1 })) }
                : { [key]: paths, offset: publicInput ? 2 : 1, limit: 1 };
            const readState = captureReadCacheState({ args, cwd: fx.cwd });
            const content = String(await executeRead(fx)('read', args, fx.cwd));
            assert.match(content, /2→LINE_2/);
            assert.match(content, /2→OTHER_2/);
            setReadCached({ ...fx, args, content, readState });
            assert.equal(tryReadCached({ ...fx, args })?.content, content);
            invalidatePathForSession(fx.sessionId, other, fx.cwd);
            assert.equal(tryReadCached({ ...fx, args }), null);
        });
    }
}

test('a changed array member or unavailable source version prevents deferred insertion', async () => {
    const fx = fixture();
    const other = join(fx.cwd, 'other.txt');
    writeFileSync(other, 'old\n');
    const args = { file_path: [fx.file, other] };
    const readState = captureReadCacheState({ args, cwd: fx.cwd });
    const content = String(await executeRead(fx)('read', args, fx.cwd));
    writeFileSync(other, 'changed\n');
    setReadCached({ ...fx, args, content, readState });
    assert.equal(tryReadCached({ ...fx, args }), null);
    setReadCached({ ...fx, args, content, readState: null });
    assert.equal(tryReadCached({ ...fx, args }), null);
});

for (const eager of [false, true]) {
    test(`deferred insertion never relabels an older read after an external write (eager=${eager})`, async () => {
        const fx = fixture('BEFORE\n');
        const args = { file_path: fx.file };
        const [first] = await batch(fx, [readCall(args)], async (name, input, cwd) => {
            const output = await executeRead(fx)(name, input, cwd);
            writeFileSync(fx.file, 'NEW_CONTENT\n');
            return output;
        }, { eager });
        assert.match(first.content, /BEFORE/);
        const [second] = await batch(fx, [readCall(args)], executeRead(fx), { eager });
        assert.match(second.content, /NEW_CONTENT/);
        assert.doesNotMatch(second.content, /BEFORE/);
        assert.equal(readFileSync(fx.file, 'utf8'), 'NEW_CONTENT\n');
    });

    test(`an unchanged read still becomes a reusable session result (eager=${eager})`, async () => {
        const fx = fixture();
        const args = { file_path: fx.file, offset: 2, limit: 1 };
        let executions = 0;
        const execute = async (...input) => {
            executions++;
            return executeRead(fx)(...input);
        };
        const [first] = await batch(fx, [readCall(args)], execute, { eager });
        const [second] = await batch(fx, [readCall(args)], execute, { eager });
        assert.equal(executions, 1);
        assert.equal(second.content, first.content);
        assert.equal(second.toolKind, 'cache-hit');
    });
}

for (const cached of [false, true]) {
    for (const name of ['read', 'grep']) {
        test(`schema denial precedes cache and execution (${name}, cached=${cached})`, async () => {
            const fx = fixture('CACHED_BODY\n');
            const args = name === 'read'
                ? { file_path: fx.file }
                : { path: fx.file, pattern: 'CACHED_BODY', context: 0 };
            if (cached) {
                const content = 'CACHED_BODY';
                if (name === 'read') setReadCached({ ...fx, args, content });
                else setScopedToolCached({ ...fx, toolName: name, args, content });
            }
            let executions = 0;
            const calls = [1, 2].map(() => ({ id: randomUUID(), name, arguments: args }));
            const results = await batch(fx, calls, async () => {
                executions++;
                return 'unexpected';
            }, { eager: true, schemaAllowedTools: [] });
            assert.equal(executions, 0);
            assert.equal(results.length, 2);
            for (const result of results) {
                assert.equal(result.toolKind, 'error');
                assert.match(result.content, /schema allowlist/);
                assert.doesNotMatch(result.content, /CACHED_BODY/);
            }
        });
    }
}

test('cache metadata probes do not touch UNC or device paths before read validation', t => {
    const paths = ['//blocked.invalid/share/file.txt', '\\\\blocked.invalid\\share\\file.txt', '/dev/zero'];
    if (process.platform === 'win32') paths.push('NUL', 'C:/temp/file.txt:stream');
    let stats = 0;
    t.mock.method(fs, 'statSync', () => { stats++; throw new Error('unexpected filesystem access'); });
    syncBuiltinESMExports();
    try {
        for (const path of paths) assert.equal(_statTuple(path), null);
        assert.equal(stats, 0);
    } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    }
});
