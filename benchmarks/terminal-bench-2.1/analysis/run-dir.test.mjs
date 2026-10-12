import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requireLocalRunDir, resolveRunDir } from './run-dir.mjs';

test('run directories fall back to the committed raw-runs export', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-dir-'));
    try {
        mkdirSync(join(root, 'raw-runs', 'jobs-a'), { recursive: true });
        mkdirSync(join(root, 'jobs-b'));
        mkdirSync(join(root, 'raw-runs', 'jobs-b'));
        assert.equal(resolveRunDir('jobs-a', root), join(root, 'raw-runs', 'jobs-a'));
        assert.equal(resolveRunDir('jobs-b', root), join(root, 'jobs-b'));
        assert.equal(requireLocalRunDir('jobs-b', root), join(root, 'jobs-b'));
        assert.throws(() => requireLocalRunDir('jobs-a', root), /not on this machine/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
