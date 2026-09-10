import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-range-test-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const {
    flushReadRangeIndexesSync,
    sweepStaleReadRangeIndexes,
} = await import('./read-range-index.mjs');
const { streamReadRange } = await import('./read-streaming.mjs');
const { renderReadLine } = await import('./read-formatting.mjs');

after(async () => {
    flushReadRangeIndexesSync();
    await fs.rm(root, { recursive: true, force: true });
});

function mockFs(t, name, implementation) {
    t.mock.method(fs, name, implementation);
    syncBuiltinESMExports();
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    });
}

async function fixture(name, text) {
    const file = join(root, name);
    await fs.writeFile(file, text);
    return { file, st: await fs.stat(file) };
}

test('first range read does not wait for pending cache maintenance', async (t) => {
    const directory = join(process.env.MIXDOG_DATA_DIR, 'read-range-index');
    await fs.mkdir(directory, { recursive: true });
    const { file, st } = await fixture('first.txt', 'first\nsecond\n');
    const readdir = fs.readdir;
    let release;
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    mockFs(t, 'readdir', async (path, ...args) => {
        if (path === directory) {
            started();
            await blocked;
        }
        return readdir(path, ...args);
    });
    const reading = streamReadRange(file, 0, 1, st);
    const timeout = setTimeout(release, 2000);
    let completedBeforeRelease = false;
    try {
        await entered;
        const winner = await Promise.race([
            reading.then((result) => ({ result })),
            blocked.then(() => null),
        ]);
        completedBeforeRelease = winner !== null;
        assert.ok(completedBeforeRelease, 'cleanup blocked the foreground read');
        assert.match(winner.result.text, /^1→first/);
    } finally {
        clearTimeout(timeout);
        release();
        await reading;
        await nextTurn();
    }
});

test('small repeated windows bound read bytes and close their handles', async (t) => {
    const { file, st } = await fixture('small-window.txt', 'hello world\n'.repeat(200000));
    await streamReadRange(file, 0, 5, st);
    const open = fs.open;
    let opens = 0;
    let closes = 0;
    let bytes = 0;
    mockFs(t, 'open', async (...args) => {
        const handle = await open(...args);
        if (args[0] === file) {
            opens++;
            const read = handle.read.bind(handle);
            const close = handle.close.bind(handle);
            handle.read = async (...readArgs) => {
                const result = await read(...readArgs);
                bytes += result.bytesRead;
                return result;
            };
            handle.close = async () => { closes++; return close(); };
        }
        return handle;
    });
    const result = await streamReadRange(file, 0, 5, st);
    assert.match(result.text, /^1→hello world\n2→hello world/);
    assert.equal(opens, 1);
    assert.equal(closes, opens);
    assert.ok(bytes <= 128 * 1024, `read ${bytes} bytes for five short lines`);
});

test('adaptive reads preserve deep windows and concurrent offsets', async () => {
    const rows = Array.from({ length: 40000 }, (_, i) => `row ${i} ${'한글'.repeat(40)}`);
    const { file, st } = await fixture('deep.txt', `${rows.join('\r\n')}\r\n`);
    const offsets = [30000, 1, 18000, 39998];
    const results = await Promise.all(offsets.map((offset) => streamReadRange(file, offset, 2, st)));
    for (let i = 0; i < offsets.length; i++) {
        const offset = offsets[i];
        assert.equal(results[i].text.split('\n').slice(0, 2).join('\n'),
            rows.slice(offset, offset + 2).map((row, j) => renderReadLine(offset + j + 1, row)).join('\n'));
    }
});

test('UTF-8 and CRLF split across a small chunk retain exact content and prefix hash', async () => {
    const text = `${'x\n'.repeat(32767)}한글\r\n끝`;
    const { file, st } = await fixture('boundary.txt', text);
    const result = await streamReadRange(file, 32767, 3, st);
    assert.equal(result.text, '32768→한글\n32769→끝');
    assert.equal(result.prefixHash, createHash('sha256').update(Buffer.from(text).subarray(0, 65536)).digest('hex'));
    const crlf = await fixture('crlf.txt', `${'x\n'.repeat(32767)}x\r\nlast\n`);
    assert.equal((await streamReadRange(crlf.file, 32767, 3, crlf.st)).text, '32768→x\n32769→last');
});

test('same-size same-mtime rewrites invalidate cached byte anchors', async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => `row-${i}-${'x'.repeat(30)}`);
    const original = `${rows.join('\n')}\n`;
    const { file, st } = await fixture('rewrite.txt', original);
    await streamReadRange(file, 5000, 1, st);
    const firstNewline = original.indexOf('\n');
    const changed = `${original.slice(0, firstNewline)} ${original.slice(firstNewline + 1)}`;
    await fs.writeFile(file, changed);
    await fs.utimes(file, st.atime, st.mtime);
    const result = await streamReadRange(file, 5000, 1, st);
    assert.equal(result.text.split('\n')[0], renderReadLine(5001, rows[5001]));
});

test('persisted indexes validate through a borrowed handle and reject rewritten prefixes', async () => {
    const { file, st } = await fixture('persisted.txt', 'line\n'.repeat(6000));
    await streamReadRange(file, 5000, 1, st);
    flushReadRangeIndexesSync();
    // A fresh module instance exercises disk loading without evicting its file.
    const fresh = await import('./read-range-index.mjs?persisted-io-test');
    const handle = await fs.open(file, 'r');
    try {
        const loaded = await fresh.getReadRangeIndex(file, st, handle);
        assert.ok(loaded.anchors.has(4096));
        assert.ok((await handle.stat()).isFile(), 'validation must leave borrowed handles open');
        await fs.writeFile(file, `LINE\n${'line\n'.repeat(5999)}`);
        await fs.utimes(file, st.atime, st.mtime);
        const rewritten = await fresh.getReadRangeIndex(file, st, handle);
        assert.deepEqual([...rewritten.anchors], [[0, 0]]);
    } finally {
        await handle.close();
    }
});

test('read failures close the borrowed handle without masking the error', async (t) => {
    const { file, st } = await fixture('failure.txt', 'body\n');
    const open = fs.open;
    let closes = 0;
    mockFs(t, 'open', async (...args) => {
        const handle = await open(...args);
        if (args[0] === file) {
            const close = handle.close.bind(handle);
            handle.read = async () => { throw new Error('injected read failure'); };
            handle.close = async () => { closes++; return close(); };
        }
        return handle;
    });
    await assert.rejects(streamReadRange(file, 0, 1, st), /injected read failure/);
    assert.equal(closes, 1);
});

test('cache sweep bounds concurrency and preserves fresh or unrelated files', async (t) => {
    const directory = join(root, 'sweep');
    await fs.mkdir(directory);
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 40; i++) {
        const file = join(directory, `${i}.json`);
        await fs.writeFile(file, '{}');
        await fs.utimes(file, stale, stale);
    }
    await fs.writeFile(join(directory, 'fresh.json'), '{}');
    await fs.writeFile(join(directory, 'keep.txt'), 'keep');
    const stat = fs.stat;
    let active = 0;
    let peak = 0;
    mockFs(t, 'stat', async (...args) => {
        active++;
        peak = Math.max(peak, active);
        try {
            await nextTurn();
            return await stat(...args);
        } finally { active--; }
    });
    await sweepStaleReadRangeIndexes(directory);
    assert.ok(peak > 0 && peak <= 8, `peak metadata concurrency: ${peak}`);
    assert.deepEqual((await fs.readdir(directory)).sort(), ['fresh.json', 'keep.txt']);
});
