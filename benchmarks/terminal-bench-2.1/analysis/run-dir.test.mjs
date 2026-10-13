import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { requireLocalRunDir, resolveRunDir } from './run-dir.mjs';

test('run directories fall back to the committed export via its index', () => {
    const root = mkdtempSync(join(tmpdir(), 'run-dir-'));
    try {
        const a = join(root, 'records', 'm', '2026-01-01', 'h');
        mkdirSync(join(a, 'sub'), { recursive: true });
        mkdirSync(join(root, 'jobs-b'));
        writeFileSync(join(root, 'records', 'index.json'), JSON.stringify([
            { jobsDir: 'jobs-a', path: 'm/2026-01-01/h' },
            { jobsDir: 'jobs-b', path: 'm/2026-01-01/other' },
        ]));
        assert.equal(resolveRunDir('jobs-a', root), a);
        assert.equal(resolveRunDir('jobs-a/sub', root), join(a, 'sub'));
        assert.equal(resolveRunDir('jobs-b', root), join(root, 'jobs-b'));
        assert.equal(requireLocalRunDir('jobs-b', root), join(root, 'jobs-b'));
        assert.throws(() => requireLocalRunDir('jobs-a', root), /not on this machine/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
