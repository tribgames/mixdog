import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { graphBinaryPath } from '../../src/runtime/agent/orchestrator/tools/code-graph/graph-binary.mjs';

const execFile = promisify(execFileCallback);

// Use the same local or installed native binary as the application. These
// tests exercise real filesystem notifications, not just classification helpers.
const binary = graphBinaryPath();
assert.ok(binary, 'The native graph binary must be prepared before running these tests');

function session(root, data) {
    const child = spawn(binary, [root, '--serve-search'], {
        env: { ...process.env, MIXDOG_DATA_DIR: data },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let sequence = 0;
    let stderr = '';
    const pending = new Map();
    const changes = new Set();
    const reader = createInterface({ input: child.stdout });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`native exit ${code}: ${stderr}`)));
    });
    // An early process failure must also reject in-flight requests.
    exited.catch(error => {
        for (const waiter of [...pending.values(), ...changes]) waiter.reject(error);
    });
    reader.on('line', line => {
        const value = JSON.parse(line);
        if (value.event === 'invalidate') {
            for (const waiter of changes) waiter.resolve(value);
        }
        pending.get(value.id)?.resolve(value);
    });
    function waiter() {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const timer = setTimeout(() => reject(new Error(`native notification/request timeout: ${stderr}`)), 5000);
        return { promise, resolve, reject, clear: () => clearTimeout(timer) };
    }
    return {
        async response(args) {
            const id = ++sequence;
            const waiting = waiter();
            pending.set(id, waiting);
            child.stdin.write(`${JSON.stringify({ id, cwd: root, args, limit: 0, deadlineMs: 4000 })}\n`);
            try {
                const response = await waiting.promise;
                return response;
            } finally {
                pending.delete(id);
                waiting.clear();
            }
        },
        async query(args) {
            const response = await this.response(args);
            assert.equal(response.complete, true, JSON.stringify(response));
            assert.equal(response.timeout, false);
            assert.equal(response.scanErrors, 0);
            return response.lines.map(line => line.replaceAll('\\', '/').replace(/^\.\//, '')).sort();
        },
        async changed(action) {
            const waiting = waiter();
            changes.add(waiting);
            try {
                await action();
                await waiting.promise;
            } finally {
                changes.delete(waiting);
                waiting.clear();
            }
        },
        async close() {
            child.stdin.end();
            await exited;
            reader.close();
        },
    };
}

async function fixture(run) {
    const base = await mkdtemp(join(tmpdir(), 'mg-native-invalidation-'));
    const root = join(base, 'repo');
    await mkdir(join(root, '.git', 'info'), { recursive: true });
    const sessions = [];
    const open = () => {
        const server = session(root, join(base, `data-${sessions.length}`));
        sessions.push(server);
        return server;
    };
    try {
        await run({ root, open });
    } finally {
        await Promise.all(sessions.map(server => server.close()));
        await rm(base, { recursive: true, force: true });
    }
}

for (const rule of ['.gitignore', '.ignore', '.git/info/exclude']) {
    test(`in-place ${rule} edits change cached membership in both directions`, async () => {
        await fixture(async ({ root, open }) => {
            const path = join(root, rule);
            await writeFile(path, '# initial\n');
            await writeFile(join(root, 'visible.txt'), 'needle\n');
            const warm = open();
            const args = ['--files', '--hidden', '.'];
            assert.ok((await warm.query(args)).includes('visible.txt'));
            await warm.changed(() => writeFile(path, 'visible.txt\n'));
            const excluded = await warm.query(args);
            assert.ok(!excluded.includes('visible.txt'));
            assert.deepEqual(excluded, await open().query(args));
            await warm.changed(() => writeFile(path, '# restored\n'));
            const restored = await warm.query(args);
            assert.ok(restored.includes('visible.txt'));
            assert.deepEqual(restored, await open().query(args));
        });
    });
}

for (const name of ['node_modules', '.cache']) {
    test(`${name} changes remain visible when actual search rules include it`, async () => {
        await fixture(async ({ root, open }) => {
            const dir = join(root, name);
            await mkdir(dir);
            const existing = join(dir, 'existing.txt');
            await writeFile(existing, 'hay\n');
            const warm = open();
            const args = ['-l', '--hidden', '-F', '-e', 'needle', '.'];
            assert.deepEqual(await warm.query(args), []);
            await warm.changed(() => writeFile(existing, 'needle\n'));
            assert.deepEqual(await warm.query(args), [`${name}/existing.txt`]);
            await warm.changed(() => writeFile(join(dir, 'added.txt'), 'needle\n'));
            const changed = await warm.query(args);
            assert.deepEqual(changed, [`${name}/added.txt`, `${name}/existing.txt`]);
            assert.deepEqual(changed, await open().query(args));
        });
    });
}

test('rename, delete and directory moves preserve membership across concurrent requests', async () => {
    await fixture(async ({ root, open }) => {
        await writeFile(join(root, '.gitignore'), 'ignored/\n');
        await mkdir(join(root, 'source'));
        await writeFile(join(root, 'source', 'before.txt'), 'needle\n');
        const warm = open();
        const args = ['--files', '.'];
        assert.deepEqual(await warm.query(args), ['source/before.txt']);
        async function check(action, expected) {
            await warm.changed(action);
            const concurrent = await Promise.all(Array.from({ length: 6 }, () => warm.query(args)));
            for (const paths of concurrent) assert.deepEqual(paths, expected);
            assert.deepEqual(concurrent[0], await open().query(args));
        }
        await check(
            () => rename(join(root, 'source', 'before.txt'), join(root, 'source', 'after.txt')),
            ['source/after.txt'],
        );
        await check(() => rename(join(root, 'source'), join(root, 'ignored')), []);
        await check(() => rename(join(root, 'ignored'), join(root, 'restored')), ['restored/after.txt']);
        await check(() => rm(join(root, 'restored', 'after.txt')), []);
    });
});

test('Windows hidden attribute changes update cached file membership', {
    skip: process.platform !== 'win32',
}, async () => {
    await fixture(async ({ root, open }) => {
        const path = join(root, 'visible.txt');
        await writeFile(path, 'needle\n');
        const warm = open();
        const args = ['--files', '.'];
        assert.deepEqual(await warm.query(args), ['visible.txt']);
        await warm.changed(() => execFile('attrib', ['+H', path]));
        assert.deepEqual(await warm.query(args), []);
        assert.deepEqual(await open().query(args), []);
        await warm.changed(() => execFile('attrib', ['-H', path]));
        assert.deepEqual(await warm.query(args), ['visible.txt']);
    });
});

test('Windows directory permission loss and recovery agree with uncached searches', {
    skip: process.platform !== 'win32',
}, async () => {
    await fixture(async ({ root, open }) => {
        const dir = join(root, 'protected');
        await mkdir(dir);
        await writeFile(join(dir, 'hit.txt'), 'needle\n');
        const warm = open();
        const args = ['-l', '-F', '-e', 'needle', '.'];
        assert.deepEqual(await warm.query(args), ['protected/hit.txt']);
        let denied = false;
        try {
            await warm.changed(async () => {
                await execFile('icacls', [dir, '/deny', '*S-1-1-0:(RD)']);
                denied = true;
            });
            const cached = await warm.response(args);
            const fresh = await open().response(args);
            assert.equal(cached.complete, false);
            assert.equal(cached.partial, true);
            assert.equal(cached.timeout, false);
            assert.ok(cached.scanErrors > 0);
            assert.equal(cached.scanErrors, fresh.scanErrors);
            assert.deepEqual(cached.lines, fresh.lines);
            await warm.changed(async () => {
                await execFile('icacls', [dir, '/remove:d', '*S-1-1-0']);
                denied = false;
            });
            assert.deepEqual(await warm.query(args), ['protected/hit.txt']);
        } finally {
            if (denied) await execFile('icacls', [dir, '/remove:d', '*S-1-1-0']);
        }
    });
});
