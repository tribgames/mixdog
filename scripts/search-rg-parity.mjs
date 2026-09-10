import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

const project = process.cwd();
const deadlineMs = Number(process.env.MIXDOG_PARITY_DEADLINE_MS || 15000);
assert.ok(Number.isSafeInteger(deadlineMs) && deadlineMs > 0);
const scratch = await mkdtemp(join(tmpdir(), 'mixdog-rg-parity-'));
const fixture = join(scratch, 'fixture');
await mkdir(join(fixture, '.git'), { recursive: true });
await mkdir(join(fixture, '.cache'), { recursive: true });
await writeFile(join(fixture, '.gitignore'), '*.mjs\n');
for (const name of ['keep.mjs', 'drop.mjs', '.cache/hit.mjs', 'other.RS']) {
    await writeFile(join(fixture, name), 'before\nneedle\nafter\n');
}
const server = spawn(resolve('native/mixdog-graph/target/release/mixdog-graph.exe'),
    [project, '--serve-search'], {
        env: { ...process.env, MIXDOG_DATA_DIR: join(scratch, 'data') },
        stdio: ['pipe', 'pipe', 'inherit'],
    });
let id = 0;
const pending = new Map();
const lines = createInterface({ input: server.stdout });
lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
});
server.on('error', error => {
    for (const settle of pending.values()) settle({ error: error.message });
});
server.on('exit', code => {
    for (const settle of pending.values()) settle({ error: `native exit ${code}` });
});
async function native(cwd, args) {
    const requestId = ++id;
    const started = performance.now();
    const response = await new Promise(resolve => {
        pending.set(requestId, resolve);
        server.stdin.write(`${JSON.stringify({
            id: requestId, cwd, args, limit: 0, offset: 0, deadlineMs,
        })}\n`);
    });
    pending.delete(requestId);
    assert.ok(!response.error && !response.unsupported, JSON.stringify(response));
    return { ...response, ms: performance.now() - started };
}
async function rg(cwd, args) {
    const started = performance.now();
    return await new Promise((resolve, reject) => {
        const child = spawn('rg', args, { cwd });
        let stdout = '', stderr = '';
        let timeout = false;
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => { timeout = true; child.kill(); }, deadlineMs);
        child.on('error', reject);
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ lines: stdout.trimEnd().split(/\r?\n/).filter(Boolean),
                complete: !timeout && (code === 0 || code === 1), timeout,
                code, stderr, ms: performance.now() - started });
        });
    });
}
const normalized = rows => rows.map(row => row.replaceAll('\\', '/').replace(/^\.\//, '')).sort();
async function compare(name, cwd, args) {
    // Run sequentially: concurrent drive walks compete for the same storage
    // and distort the completion time we are trying to measure.
    const actual = await native(cwd, args);
    let repeat;
    if (cwd === 'C:/' && process.argv.includes('--repeat-drive')) {
        repeat = await native(cwd, args);
        assert.deepEqual(normalized(repeat.lines), normalized(actual.lines), `${name}: repeated results`);
        assert.equal(repeat.scanErrors, actual.scanErrors, `${name}: repeated errors`);
        assert.equal(repeat.complete, actual.complete, `${name}: repeated completeness`);
        assert.equal(repeat.timeout, actual.timeout, `${name}: repeated timeout`);
    }
    const expected = await rg(cwd, args);
    const traversalFinished = !actual.timeout && !expected.timeout
        && [0, 1, 2].includes(expected.code);
    if (cwd !== 'C:/') {
        assert.ok(actual.complete && expected.complete, `${name}: incomplete search`);
    }
    if (traversalFinished) {
        assert.deepEqual(normalized(actual.lines), normalized(expected.lines), name);
    } else if (cwd !== 'C:/') {
        assert.fail(`${name}: incomplete: ${JSON.stringify({ actual, expected })}`);
    }
    console.log(JSON.stringify({ name, nativeMs: +actual.ms.toFixed(1),
        rgMs: +expected.ms.toFixed(1), nativeCount: actual.lines.length,
        rgCount: expected.lines.length, complete: actual.complete && expected.complete,
        traversalFinished, deadlineMs,
        repeatMs: repeat && +repeat.ms.toFixed(1),
        filesScanned: actual.filesScanned, nativeTimeout: actual.timeout,
        scanErrors: actual.scanErrors, rgTimeout: expected.timeout }));
}
try {
    const rules = [
        ['--glob', '*.mjs'],
        ['--glob', '*.mjs', '--glob', '!drop.mjs'],
        ['--glob', '!drop.mjs', '--glob', '*.mjs'],
        ['--glob', '!**/.cache/**', '--glob', '*.mjs'],
        ['--glob', '*.mjs', '--glob', '!**/.cache/**'],
        ['--glob', 'keep.mjs', '--iglob', '*.rs'],
    ];
    for (let i = 0; !process.argv.includes('--drive-only') && i < rules.length; i++) {
        for (const mode of [['--files'], ['-l', '-e', 'needle'], ['-n', '-H', '-e', 'needle']]) {
            await compare(`fixture-${i}-${mode[0]}`, fixture, ['--hidden', ...mode, ...rules[i], '.']);
        }
    }
    for (const noIgnore of process.argv.includes('--drive-only') ? [] : [false, true]) {
        const filters = ['--hidden', ...(noIgnore ? ['--no-ignore'] : []),
            '--glob', '*.mjs', '--glob', '!**/.git/**', '--glob', '!**/node_modules/**'];
        await compare(`project-files-ignore-${!noIgnore}`, project, ['--files', ...filters, '.']);
        await compare(`project-grep-ignore-${!noIgnore}`, project,
            ['-l', '-F', '-e', 'prepareGrepContextSources', ...filters, '.']);
    }
    if (process.argv.includes('--drive') || process.argv.includes('--drive-only')) {
        await compare('drive-grep', 'C:/', ['-l', '-F', '-e', 'prepareGrepContextSources',
            '--hidden', '--glob', '**/grep-context-expander.mjs', '--glob', '!**/.git/**', '.']);
    }
} finally {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.stdin.end();
    if (server.exitCode === null) await exited;
    lines.close();
    await rm(scratch, { recursive: true, force: true });
}
