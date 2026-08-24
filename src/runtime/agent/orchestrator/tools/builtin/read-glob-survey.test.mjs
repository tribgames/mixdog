import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';

function lines(fileTag, count) {
    return Array.from({ length: count }, (_, i) => `${fileTag} line-${i + 1}`).join('\n') + '\n';
}

test('multi-file glob fan-out defaults to the survey window per file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-read-glob-survey-'));
    try {
        await writeFile(join(root, 'a.log'), lines('alpha', 200));
        await writeFile(join(root, 'b.log'), lines('beta', 200));
        const out = await executeBuiltinTool('read', { file_path: join(root, '*.log') }, root);
        assert.equal(typeof out, 'string');
        // Head of each file is present…
        assert.match(out, /alpha line-1\b/);
        assert.match(out, /beta line-1\b/);
        assert.match(out, /alpha line-100\b/);
        // …but the survey window stops at 100 lines per file.
        assert.doesNotMatch(out, /alpha line-101\b/);
        assert.doesNotMatch(out, /beta line-101\b/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('explicit limit overrides the glob survey default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-read-glob-explicit-'));
    try {
        await writeFile(join(root, 'a.log'), lines('alpha', 200));
        await writeFile(join(root, 'b.log'), lines('beta', 200));
        const out = await executeBuiltinTool('read', { file_path: join(root, '*.log'), limit: 150 }, root);
        assert.match(out, /alpha line-150\b/);
        assert.doesNotMatch(out, /alpha line-151\b/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('single-file glob match keeps the standard full window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-read-glob-single-'));
    try {
        await writeFile(join(root, 'only.log'), lines('solo', 200));
        const out = await executeBuiltinTool('read', { file_path: join(root, '*.log') }, root);
        assert.match(out, /solo line-200\b/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
