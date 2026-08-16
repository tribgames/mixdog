import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { recordShardDirectoryReadSuccess } from '../../../../shared/session-shard-health.mjs';
import { executeListTool, executeTreeTool } from './list-tool.mjs';

function readdirError(code, message = 'injected readdir failure') {
    const error = new Error(message);
    error.code = code;
    return error;
}

test('aborted list work cannot poison the result cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-list-abort-'));
    try {
        await writeFile(join(root, 'entry.txt'), 'ok');
        const controller = new AbortController();
        controller.abort(new Error('probe abort'));
        await assert.rejects(
            executeListTool({ path: root, hidden: true }, process.cwd(), { signal: controller.signal }),
            /aborted|probe abort/i,
        );
        assert.match(
            await executeListTool({ path: root, hidden: true }, process.cwd()),
            /entry\.txt\tfile/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('root readdir failures are errors, stay uncached, and mark a repeatedly failing shard unhealthy', async () => {
    const originalShardPid = process.env.MIXDOG_SESSION_SHARD_PID;
    const roots = [];
    let unhealthy = null;
    const onUnhealthy = (detail) => { unhealthy = detail; };
    process.env.MIXDOG_SESSION_SHARD_PID = String(process.pid);
    process.on('mixdog:session-shard-unhealthy', onUnhealthy);
    recordShardDirectoryReadSuccess();
    try {
        for (let index = 0; index < 3; index += 1) {
            const root = await mkdtemp(join(tmpdir(), `mixdog-list-root-fail-${index}-`));
            roots.push(root);
            await writeFile(join(root, `entry-${index}.txt`), 'ok');
            const out = await executeListTool(
                { path: root, hidden: true },
                process.cwd(),
                { readdirImpl: async () => { throw readdirError('EIO'); } },
            );
            assert.match(out, /^Error: readdir failed \(EIO\):/);
        }
        assert.equal(unhealthy?.distinctRoots, 3);
        assert.match(
            await executeListTool({ path: roots[0], hidden: true }, process.cwd()),
            /entry-0\.txt\tfile/,
        );
    } finally {
        recordShardDirectoryReadSuccess();
        process.off('mixdog:session-shard-unhealthy', onUnhealthy);
        if (originalShardPid === undefined) delete process.env.MIXDOG_SESSION_SHARD_PID;
        else process.env.MIXDOG_SESSION_SHARD_PID = originalShardPid;
        await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    }
});

test('list and tree surface skipped subdirectories and never cache partial walks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-list-partial-'));
    const child = join(root, 'child');
    try {
        await mkdir(child);
        await writeFile(join(child, 'nested.txt'), 'ok');
        const partialReaddir = async (path, options) => {
            if (resolve(path) === resolve(child)) throw readdirError('EIO');
            return readdir(path, options);
        };
        const listTelemetry = {};
        const listPartial = await executeListTool(
            { path: root, depth: 2, hidden: true, head_limit: 0 },
            process.cwd(),
            { readdirImpl: partialReaddir, resultTelemetry: listTelemetry },
        );
        assert.match(listPartial, /\[warning\] readdir failed \(EIO\):/);
        assert.equal(listTelemetry.integrity?.status, 'partial');
        assert.doesNotMatch(listPartial, /nested\.txt/);
        assert.match(
            await executeListTool({ path: root, depth: 2, hidden: true, head_limit: 0 }, process.cwd()),
            /child[\\/]nested\.txt\tfile/,
        );

        const treeTelemetry = {};
        const treePartial = await executeTreeTool(
            { path: root, depth: 2, hidden: true, head_limit: 0 },
            process.cwd(),
            { readdirImpl: partialReaddir, resultTelemetry: treeTelemetry },
        );
        assert.match(treePartial, /\[warning\] readdir failed \(EIO\):/);
        assert.equal(treeTelemetry.integrity?.status, 'partial');
        assert.doesNotMatch(treePartial, /nested\.txt/);
        assert.match(
            await executeTreeTool({ path: root, depth: 2, hidden: true, head_limit: 0 }, process.cwd()),
            /nested\.txt/,
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('a successful empty walk is explicitly traceable as integrity-checked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-list-empty-'));
    const resultTelemetry = {};
    try {
        assert.match(
            await executeListTool(
                { path: root, hidden: true },
                process.cwd(),
                { resultTelemetry },
            ),
            /\(empty directory\)/,
        );
        assert.deepEqual(resultTelemetry.integrity, {
            kind: 'directory-walk',
            status: 'empty',
            entriesVisited: 0,
            warnings: 0,
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
