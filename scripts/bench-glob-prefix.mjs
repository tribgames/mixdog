// Compare cold native searches on a generated tree without scanning the host root.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildGlobPatternGroups } from '../src/runtime/agent/orchestrator/tools/builtin/lib/glob-static-prefix.mjs';
import { tryServeSearch, shutdownNativeSearchServer } from '../src/runtime/agent/orchestrator/tools/builtin/native-search-client.mjs';

const root = await mkdtemp(join(tmpdir(), 'mixdog-prefix-bench-'));
const patterns = ['usr/bin/python*', 'usr/local/bin/python*', 'bin/python*', 'opt/**/python3*'];
try {
    for (const name of ['usr/bin/python3', 'usr/local/bin/python3.12', 'opt/runtime/python3']) {
        await mkdir(join(root, name, '..'), { recursive: true });
        await writeFile(join(root, name), '');
    }
    await symlink(join(root, 'usr/bin'), join(root, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
    for (let batch = 0; batch < 20; batch++) {
        await Promise.all(Array.from({ length: 50 }, async (_, index) => {
            const dir = join(root, 'unrelated', `d${batch * 50 + index}`);
            await mkdir(dir, { recursive: true });
            await writeFile(join(dir, 'other.txt'), '');
        }));
    }
    const narrowed = await buildGlobPatternGroups({
        patterns, baseEntries: [{ root, prefix: '' }], resolveRoot: resolve,
    });
    async function measure(groups) {
        await shutdownNativeSearchServer('benchmark-cold');
        const started = performance.now();
        const results = await Promise.all([...groups].map(async ([cwd, filters]) => {
            const response = await tryServeSearch(
                ['--files', '--hidden', ...filters.flatMap(pattern => ['--glob', pattern]), '.'],
                { cwd },
                { limit: 100 },
            );
            assert.equal(response.complete, true);
            assert.equal(response.partial, false);
            return response.lines.map(line => resolve(cwd, line));
        }));
        return { ms: performance.now() - started, paths: [...new Set(results.flat())].sort() };
    }
    const broadMs = [];
    const narrowMs = [];
    for (let sample = 0; sample < 3; sample++) {
        const broadGroups = new Map([[root, patterns]]);
        const [broad, narrow] = sample % 2 === 0
            ? [await measure(broadGroups), await measure(narrowed)]
            : await (async () => {
                const narrow = await measure(narrowed);
                return [await measure(broadGroups), narrow];
            })();
        assert.deepEqual(narrow.paths, broad.paths);
        assert.equal(narrow.paths.length, 3);
        broadMs.push(broad.ms);
        narrowMs.push(narrow.ms);
    }
    const median = values => [...values].sort((a, b) => a - b)[1];
    console.log(JSON.stringify({
        fixtureDirectories: 1000,
        completeIdenticalMatches: 3,
        broadMs, narrowMs,
        broadMedianMs: median(broadMs),
        narrowMedianMs: median(narrowMs),
        scope: 'Cold search server; warm OS cache; includes startup. Synthetic tree, not a host-root benchmark.',
    }, null, 2));
} finally {
    await shutdownNativeSearchServer('benchmark-done');
    await rm(root, { recursive: true, force: true });
}
