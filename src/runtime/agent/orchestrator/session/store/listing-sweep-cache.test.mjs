import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sweepStaleSessions } from './listing.mjs';

const HOUR = 60 * 60 * 1000;

function writeSession(dir, doc, mtimeMs) {
    const path = join(dir, `${doc.id}.json`);
    writeFileSync(path, JSON.stringify(doc));
    if (mtimeMs) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
    return path;
}

test('a session whose file changed between sweeps is judged from its new contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-sweep-cache-'));
    const previous = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = root;
    try {
        const sessionsDir = join(root, 'sessions');
        mkdirSync(sessionsDir);
        const old = Date.now() - 48 * HOUR;
        const open = {
            id: 'agent-open',
            owner: 'agent',
            agent: 'reviewer',
            status: 'idle',
            createdAt: old,
            updatedAt: old,
            messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }],
        };
        const path = writeSession(sessionsDir, open, old);
        const options = { sweepIdle: false, tombstoneMaxAgeMs: HOUR, isSessionLive: () => false };

        // First pass: open record, nothing to reap; its verdict is now cached.
        let result = sweepStaleSessions(options);
        assert.equal(result.tombstonesCleaned, 0);
        assert.equal(existsSync(path), true);

        // The file becomes a mature tombstone (new size and mtime): the second
        // pass must see the change instead of the cached open verdict.
        writeSession(sessionsDir, { ...open, closed: true, status: 'closed', updatedAt: old, messages: [] }, old + 1_000);
        result = sweepStaleSessions(options);
        assert.equal(result.tombstonesCleaned, 1);
        assert.equal(existsSync(path), false);
    } finally {
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
