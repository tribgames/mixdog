/**
 * session-orphan-sweep-test.mjs — proves the periodic sweep reclaims mature
 * closed tombstones that exist ON DISK but are ABSENT from the summary index.
 *
 * Regression guard for the pre-fix bug where sweepStaleSessions iterated only
 * listStoredSessionSummaries() rows, so on-disk session files missing from a
 * stale index were never visited and their tombstones accumulated forever.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('mature closed on-disk orphan absent from summary index gets tombstone-swept', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-orphan-sweep-'));
    process.env.MIXDOG_DATA_DIR = dataDir;
    try {
        const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
        const { sweepStaleSessions, _sessionSummary, _writeSummaryIndex } = store;

        const sessionsDir = join(dataDir, 'sessions');
        mkdirSync(sessionsDir, { recursive: true });

        const now = Date.now();
        const TWO_HOURS = 2 * 60 * 60 * 1000;
        const ONE_HOUR = 60 * 60 * 1000;

        // (1) An INDEXED, fresh, open agent session — present in the summary
        //     index so the index is non-empty (blocking any rebuild) and must
        //     survive the sweep.
        const indexed = {
            id: 'sess_indexed_keep',
            closed: false,
            status: 'idle',
            owner: 'agent:test',
            updatedAt: now,
            createdAt: now,
            lastHeartbeatAt: now,
            messages: [],
        };
        writeFileSync(join(sessionsDir, `${indexed.id}.json`), JSON.stringify(indexed));

        // (2) An ORPHAN closed+mature tombstone — on disk, NOT in the index,
        //     closed >1h ago. Only reachable if the sweep reconciles the index
        //     candidate set with a direct directory scan.
        const orphan = {
            id: 'sess_orphan_tombstone',
            closed: true,
            status: 'closed',
            owner: 'agent:test',
            updatedAt: now - TWO_HOURS,
            createdAt: now - TWO_HOURS,
            messages: [],
        };
        writeFileSync(join(sessionsDir, `${orphan.id}.json`), JSON.stringify(orphan));

        // (3) A shared-store tombstone whose id still has local in-flight work.
        // It must be excluded before unlink, otherwise that work's late save
        // could recreate an open session after the tombstone disappears.
        const locallyLive = {
            ...orphan,
            id: 'sess_shared_tombstone_locally_live',
        };
        writeFileSync(join(sessionsDir, `${locallyLive.id}.json`), JSON.stringify(locallyLive));

        // Index contains ONLY the indexed session — the orphan is absent.
        const rows = _writeSummaryIndex([_sessionSummary(indexed)]);
        assert.equal(rows.length, 1, 'index seeded with exactly one row');
        assert.ok(!rows.some((r) => r.id === orphan.id), 'orphan is absent from the summary index');

        // Tombstone-only pass (no idle sweep) with a 1h maturity threshold.
        const result = sweepStaleSessions({
            sweepIdle: false,
            tombstoneMaxAgeMs: ONE_HOUR,
            isSessionLive: (id) => id === locallyLive.id,
        });

        assert.equal(result.tombstonesCleaned, 1, 'the orphan tombstone was reclaimed');
        assert.ok(
            result.tombstoneDetails.some((d) => d.id === orphan.id),
            'sweep reports the orphan id among tombstone deletions',
        );
        assert.ok(
            !existsSync(join(sessionsDir, `${orphan.id}.json`)),
            'orphan session file was unlinked from disk',
        );
        assert.ok(
            existsSync(join(sessionsDir, `${indexed.id}.json`)),
            'fresh open indexed session was preserved',
        );
        assert.ok(
            existsSync(join(sessionsDir, `${locallyLive.id}.json`)),
            'locally live shared-store tombstone was excluded before unlink',
        );
        const afterLocalWork = sweepStaleSessions({
            sweepIdle: false,
            tombstoneMaxAgeMs: ONE_HOUR,
            isSessionLive: () => false,
        });
        assert.ok(
            afterLocalWork.tombstoneDetails.some((d) => d.id === locallyLive.id),
            'protected tombstone is reclaimed once local work settles',
        );
    } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
        delete process.env.MIXDOG_DATA_DIR;
    }
});
