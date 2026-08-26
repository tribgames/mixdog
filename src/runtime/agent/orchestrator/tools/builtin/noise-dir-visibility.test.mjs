// Dependency/cache trees stay hidden by default, but a caller who NAMES one is
// asking for it, and a clean fuzzy miss must not report a file that exists as
// absent.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';

async function withNoiseTree(run) {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-noise-vis-'));
    try {
        await mkdir(join(root, '__pycache__'), { recursive: true });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, '__pycache__', 'convert_masks.cpython-311.pyc'), 'cached MARKER blob\n');
        await writeFile(join(root, 'src', 'app.py'), 'print("hello")\n');
        return await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('a glob that names a pruned directory searches inside it', async () => {
    await withNoiseTree(async (root) => {
        const named = String(await executeBuiltinTool('glob', { pattern: '__pycache__/*.pyc' }, root));
        assert.match(named, /convert_masks\.cpython-311\.pyc/);

        // Unnamed: the default prune still applies, so noise stays out of a
        // broad sweep.
        const broad = String(await executeBuiltinTool('glob', { pattern: '**/*.pyc' }, root));
        assert.match(broad, /no files found/);
    });
});

test('a grep glob filter that names a pruned directory searches inside it', async () => {
    await withNoiseTree(async (root) => {
        const out = String(await executeBuiltinTool('grep', {
            pattern: 'MARKER',
            path: '.',
            glob: '__pycache__/*.pyc',
            mode: 'files',
        }, root));
        assert.match(out, /convert_masks/);
    });
});

test('a clean fuzzy miss reports that the hit exists in a skipped tree', async () => {
    await withNoiseTree(async (root) => {
        const out = String(await executeBuiltinTool('find', { query: 'convert_masks' }, root));
        assert.match(out, /no fuzzy match/);
        assert.match(out, /include_noise:true/);
        // The default answer still lists no dependency path.
        assert.doesNotMatch(out, /convert_masks\.cpython-311\.pyc/);

        // The flag it names actually produces the file.
        const noisy = String(await executeBuiltinTool('find', {
            query: 'convert_masks',
            include_noise: true,
        }, root));
        assert.match(noisy, /convert_masks\.cpython-311\.pyc/);

        // A query with no file behind it stays a plain miss.
        const missing = String(await executeBuiltinTool('find', { query: 'no_such_artifact_here' }, root));
        assert.match(missing, /no fuzzy match/);
        assert.doesNotMatch(missing, /include_noise:true/);
    });
});
