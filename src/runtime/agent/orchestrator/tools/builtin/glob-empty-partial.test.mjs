import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGlobTool } from './search-glob-tool.mjs';

test('empty partial glob results keep the incomplete warning and are not cached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-glob-empty-partial-'));
    let calls = 0;
    try {
        const options = {
            __runRgWindowedLines: async () => {
                calls++;
                return { lines: [], complete: false, partial: true, timeout: true, cacheSafe: false };
            },
        };
        for (let i = 0; i < 2; i++) {
            const result = await executeGlobTool({ path: root, pattern: '**/*.mjs', sort: 'natural', limit: 25 }, root, options);
            assert.match(result, /no files found yet/);
            assert.match(result, /partial results|incomplete/);
        }
        assert.equal(calls, 2);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
