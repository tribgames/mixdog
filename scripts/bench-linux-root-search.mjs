// Run only inside the disposable root-search test container.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, symlink, readlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

const bin = '/usr/lib/node_modules/mixdog/native-tools/';
const excludes = ['!proc/**', '!sys/**', '!dev/**'];
const fixture = '/opt/mixdog-root-search-fixture';
await mkdir(`${fixture}/nested/.hidden`, { recursive: true });
await writeFile(`${fixture}/mixdogrootneedle-a`, '');
await writeFile(`${fixture}/nested/.hidden/mixdogrootneedle-b`, '');
try {
    await symlink(`${fixture}/nested`, `${fixture}/mixdogrootneedle-link`);
} catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.equal(await readlink(`${fixture}/mixdogrootneedle-link`), `${fixture}/nested`);
}

// Independent non-following filesystem traversal, with the same root exclusions.
const oracleStarted = performance.now();
const inventory = execFileSync('find', [
    '/', '(', '-path', '/proc', '-o', '-path', '/sys', '-o', '-path', '/dev',
    '-o', '-name', '.git', ')', '-prune', '-o', '-printf', '%y %p\\0',
], { encoding: 'utf8', timeout: 20000, maxBuffer: 40 * 1024 * 1024 })
    .split('\0').filter(Boolean).map(row => ({ type: row[0], path: row.slice(2) }));
console.log(JSON.stringify({ oracleMs: performance.now() - oracleStarted, entries: inventory.length }));

function subsequence(query, path) {
    let cursor = 0;
    for (const char of path.toLowerCase()) if (char === query[cursor]) cursor++;
    return cursor === query.length;
}

async function query(binary, request) {
    const child = spawn(bin + binary, ['/', '--serve-search'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    const start = performance.now();
    let timer;
    try {
        return await new Promise((resolve, reject) => {
            timer = setTimeout(() => resolve({ wallMs: performance.now() - start, hardTimeout: true }), 17500);
            child.on('error', reject);
            child.stdin.on('error', reject);
            child.on('exit', code => reject(new Error(`search exited ${code}: ${stderr}`)));
            lines.on('line', line => {
                const response = JSON.parse(line);
                if (response.id === 1) resolve({ wallMs: performance.now() - start, ...response });
            });
            child.stdin.write(JSON.stringify({ id: 1, cwd: '/', deadlineMs: 16000, ...request }) + '\n');
        });
    } finally {
        clearTimeout(timer);
        lines.close();
        child.kill('SIGKILL');
        await new Promise(resolve => child.exitCode !== null || child.signalCode !== null
            ? resolve() : child.once('exit', resolve));
    }
}

const cases = [
    {
        name: 'fuzzy-known-hits-root',
        request: { fuzzy: 'mixdogrootneedle', limit: 1000, hidden: true, includeNoise: true, exclude: excludes },
        expected: inventory.filter(row => ['f', 'd', 'l'].includes(row.type) && subsequence('mixdogrootneedle', row.path))
            .map(row => row.path.slice(1)),
    },
    {
        name: 'fuzzy-python3-root',
        request: { fuzzy: 'python3', limit: 1000, hidden: true, includeNoise: true, exclude: excludes },
        expected: inventory.filter(row => ['f', 'd', 'l'].includes(row.type) && subsequence('python3', row.path))
            .map(row => row.path.slice(1)),
    },
    {
        name: 'glob-python-root',
        request: { args: ['--files', '--hidden', '--no-ignore',
            ...['usr/bin/python*', 'usr/local/bin/python*', 'bin/python*', 'opt/**/python3*', ...excludes]
                .flatMap(pattern => ['--glob', pattern]), '.'], limit: 1000 },
        expected: inventory.filter(row => row.type === 'f'
            && /^(?:\/usr\/(?:local\/)?bin\/python[^/]*|\/bin\/python[^/]*|\/opt\/(?:.*\/)?python3[^/]*)$/.test(row.path))
            .map(row => row.path.slice(1)),
    },
    {
        name: 'glob-known-hits-root',
        request: { args: ['--files', '--hidden', '--no-ignore', '--glob', '**/mixdogrootneedle*',
            ...excludes.flatMap(pattern => ['--glob', pattern]), '.'], limit: 1000 },
        expected: inventory.filter(row => row.type === 'f' && row.path.split('/').at(-1).startsWith('mixdogrootneedle'))
            .map(row => row.path.slice(1)),
    },
];
for (const item of cases) {
    if (process.argv[2] && item.name !== process.argv[2]) continue;
    for (const binary of process.argv.includes('--fixed-only') ? ['mixdog-graph-fixed'] : ['mixdog-graph', 'mixdog-graph-fixed']) {
        const result = await query(binary, item.request);
        const paths = (result.matches || result.lines || []).map(path => path.replace(/^\.?\//, '')).sort();
        const complete = result.complete === true && result.partial !== true && !result.error;
        console.log(JSON.stringify({
            case: item.name, binary, wallMs: result.wallMs, complete,
            hardTimeout: result.hardTimeout || false, timeout: result.timeout,
            expectedCount: item.expected.length, actualCount: paths.length,
            handlerMs: result.handlerMs, inventoryMs: result.inventoryMs, rankMs: result.rankMs,
            scanErrors: result.scanErrors, error: result.error,
            exact: complete && JSON.stringify(paths) === JSON.stringify([...item.expected].sort()),
        }));
        if (binary.endsWith('-fixed')) {
            assert.equal(complete, true, JSON.stringify(result));
            assert.deepEqual(paths, [...item.expected].sort());
        }
    }
}
