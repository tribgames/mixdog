import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';

function lines(fileTag, count) {
    return Array.from({ length: count }, (_, i) => `${fileTag} line-${i + 1}`).join('\n') + '\n';
}

test('multi-file glob fan-out caps the survey window at 25 lines per file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-read-glob-survey-'));
    try {
        await writeFile(join(root, 'a.log'), lines('alpha', 200));
        await writeFile(join(root, 'b.log'), lines('beta', 200));
        const out = await executeBuiltinTool('read', { file_path: join(root, '*.log') }, root);
        assert.equal(typeof out, 'string');
        // Head of each file is present…
        assert.match(out, /alpha line-1\b/);
        assert.match(out, /beta line-1\b/);
        assert.match(out, /alpha line-25\b/);
        assert.match(out, /beta line-25\b/);
        assert.doesNotMatch(out, /alpha line-26\b/);
        assert.doesNotMatch(out, /beta line-26\b/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('explicit limit is clamped to 25 lines per glob-expanded file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-read-glob-explicit-'));
    try {
        await writeFile(join(root, 'a.log'), lines('alpha', 200));
        await writeFile(join(root, 'b.log'), lines('beta', 200));
        const out = await executeBuiltinTool('read', { file_path: join(root, '*.log'), limit: 150 }, root);
        assert.match(out, /alpha line-25\b/);
        assert.doesNotMatch(out, /alpha line-26\b/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('glob fan-out shares a 10 KB output budget across files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-read-glob-budget-'));
    try {
        const payload = 'x'.repeat(300);
        for (let i = 0; i < 10; i++) {
            await writeFile(join(root, `${i}.log`), lines(`${i}-${payload}`, 25));
        }
        const out = await executeBuiltinTool('read', { file_path: join(root, '*.log'), limit: 25 }, root);
        assert.ok(Buffer.byteLength(out, 'utf8') <= 10 * 1024);
        assert.match(out, /0\.log/);
        assert.match(out, /9\.log/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('single-file glob match uses the same 25-line cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-read-glob-single-'));
    try {
        await writeFile(join(root, 'only.log'), lines('solo', 200));
        const out = await executeBuiltinTool('read', { file_path: join(root, '*.log') }, root);
        assert.match(out, /solo line-25\b/);
        assert.doesNotMatch(out, /solo line-26\b/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
