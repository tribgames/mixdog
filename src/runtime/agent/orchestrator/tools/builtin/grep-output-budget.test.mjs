import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';

test('grep rendered output is capped at 10 KiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-grep-budget-'));
    try {
        const file = join(root, 'large.txt');
        const body = Array.from(
            { length: 400 },
            (_, index) => `${index + 1} needle ${'x'.repeat(160)}`,
        ).join('\n');
        await writeFile(file, body);
        const out = await executeBuiltinTool('grep', {
            pattern: 'needle',
            path: file,
            mode: 'content',
            limit: 250,
            offset: 0,
            context: 2,
        }, root);
        assert.ok(Buffer.byteLength(out, 'utf8') <= 10 * 1024);
        assert.match(out, /\[grep output capped at 10240 bytes;/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
