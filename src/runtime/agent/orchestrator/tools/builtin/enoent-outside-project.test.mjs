// A missing ABSOLUTE path outside the project is recovered from its OWN
// filesystem, never from a project-wide scan: no file inside the project can
// be the correction for /sys/block/sd*/size, and the scan is what turned three
// such reads into 17.5s each.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';

async function withDirs(run) {
    const project = await mkdtemp(join(tmpdir(), 'mixdog-enoent-project-'));
    const outside = await mkdtemp(join(tmpdir(), 'mixdog-enoent-outside-'));
    try {
        return await run({ project, outside });
    } finally {
        await rm(project, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
}

test('an outside absolute miss names its own nearest directory, not the project', async () => {
    await withDirs(async ({ project, outside }) => {
        await mkdir(join(project, 'src'), { recursive: true });
        await writeFile(join(project, 'src', 'size'), 'decoy\n');
        await mkdir(join(outside, 'block'), { recursive: true });
        await writeFile(join(outside, 'block', 'sda'), 'disk\n');

        const out = String(await executeBuiltinTool('read', {
            file_path: join(outside, 'block', 'sd*', 'size'),
        }, project));

        assert.match(out, /\[path absent\]/);
        assert.match(out, /nearest existing directory/);
        assert.match(out, /"sda"/);
        // The decoy inside the project must never be offered for an outside path.
        assert.doesNotMatch(out, /same filename exists at/);
        assert.doesNotMatch(out, /project scan/);
    });
});

test('a miss INSIDE the project keeps its same-name recovery', async () => {
    await withDirs(async ({ project }) => {
        await mkdir(join(project, 'src', 'tools'), { recursive: true });
        await writeFile(join(project, 'src', 'tools', 'widget.mjs'), 'export const widget = 1;\n');

        const out = String(await executeBuiltinTool('read', {
            file_path: join(project, 'lib', 'widget.mjs'),
        }, project));

        assert.match(out, /widget\.mjs/);
        assert.doesNotMatch(out, /nearest existing directory/);
    });
});
