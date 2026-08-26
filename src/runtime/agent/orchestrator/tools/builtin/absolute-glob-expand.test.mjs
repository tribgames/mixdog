// An absolute glob is expanded straight off the filesystem when the inventory
// walker cannot see its targets (symlink farms such as /sys and /proc). The
// pattern bounds the walk; anything unbounded or unsupported declines.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { expandAbsoluteGlob, expandAbsoluteGlobs } from './lib/absolute-glob-expand.mjs';

async function withBlockTree(run) {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-abs-glob-'));
    try {
        for (const disk of ['sda', 'sdb', 'nvme0n1']) {
            await mkdir(join(root, 'block', disk, 'device'), { recursive: true });
            await writeFile(join(root, 'block', disk, 'size'), '2048\n');
            await writeFile(join(root, 'block', disk, 'device', 'model'), `${disk}-model\n`);
        }
        return await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test('a magic middle segment expands to every matching path', async () => {
    await withBlockTree(async (root) => {
        const sizes = await expandAbsoluteGlob(join(root, 'block', 'sd*', 'size'));
        assert.equal(sizes.length, 2);
        assert.ok(sizes.every((p) => p.endsWith('/size')));
        assert.ok(sizes.some((p) => p.includes('/sda/')));
        assert.ok(sizes.some((p) => p.includes('/sdb/')));

        const models = await expandAbsoluteGlob(join(root, 'block', '*', 'device', 'model'));
        assert.equal(models.length, 3);
    });
});

test('a pattern with no matches answers empty, not null', async () => {
    await withBlockTree(async (root) => {
        assert.deepEqual(await expandAbsoluteGlob(join(root, 'block', 'hd*', 'size')), []);
    });
});

test('unbounded or non-absolute patterns decline so the caller keeps its answer', async () => {
    await withBlockTree(async (root) => {
        assert.equal(await expandAbsoluteGlob(join(root, '**', 'size')), null);
        assert.equal(await expandAbsoluteGlob('block/sd*/size'), null);
        assert.equal(await expandAbsoluteGlob(join(root, 'block', 'sda', 'size')), null);
    });
});

test('the batch form dedupes and honours its limit', async () => {
    await withBlockTree(async (root) => {
        const found = await expandAbsoluteGlobs([
            join(root, 'block', 'sd*', 'size'),
            join(root, 'block', 's*a', 'size'),
        ], { limit: 5 });
        assert.equal(found.length, 2);
        const limited = await expandAbsoluteGlobs([join(root, 'block', '*', 'size')], { limit: 1 });
        assert.equal(limited.length, 1);
    });
});
