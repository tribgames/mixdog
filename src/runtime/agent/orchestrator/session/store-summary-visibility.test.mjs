import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    _normalizeSummaryIndex,
    _sessionSummary,
} from './store-summary-index.mjs';
import {
    listStoredAgentWorkerLinks,
    listStoredAgentWorkers,
    listStoredSessionSummaries as listOrdinarySummaries,
    readStoredSessionTranscript,
    storedSessionExists,
} from './store-summary-reader.mjs';
import {
    listStoredSessions,
    listStoredSessionSummaries as listInternalSummaries,
} from './store/listing.mjs';

function session(id, extra = {}) {
    return {
        id,
        createdAt: 1_000,
        updatedAt: 2_000,
        lastUsedAt: 2_000,
        status: 'idle',
        owner: 'user',
        messages: [{ role: 'user', content: `prompt for ${id}` }],
        ...extra,
    };
}

test('summary visibility is durable and classifies legacy Agent-owned children', () => {
    const legacy = session('legacy-child', {
        owner: 'agent',
        parentSessionId: 'root-lead',
        agent: 'reviewer',
    });
    const summary = _sessionSummary(legacy);
    assert.equal(summary.ownerSessionId, 'root-lead');
    assert.equal(summary.visibility, 'agent-only');

    const [normalized] = _normalizeSummaryIndex({
        version: 2,
        rows: [{
            ...summary,
            visibility: undefined,
            ownerSessionId: 'root-lead',
        }],
    }).rows;
    assert.equal(normalized.visibility, 'agent-only');

    const nested = _sessionSummary(session('nested-child', {
        owner: 'agent',
        parentSessionId: 'parent-child',
        ownerSessionId: 'root-lead',
        agent: 'reviewer',
        visibility: 'agent-only',
        provider: 'test-provider',
        model: 'test-model',
        presetName: 'Test route',
        effort: 'high',
        fast: true,
        modelParameters: { temperature: 0.2 },
        permissionMode: 'strict',
        schemaAllowedTools: ['read', 'grep'],
        taskType: 'review',
        maxLoopIterations: 7,
    }));
    const [normalizedNested] = _normalizeSummaryIndex({
        version: 2,
        rows: [nested],
    }).rows;
    assert.equal(normalizedNested.parentSessionId, 'parent-child');
    assert.equal(normalizedNested.ownerSessionId, 'root-lead');
    assert.equal(normalizedNested.presetName, 'Test route');
    assert.equal(normalizedNested.effort, 'high');
    assert.equal(normalizedNested.fast, true);
    assert.deepEqual(normalizedNested.modelParameters, { temperature: 0.2 });
    assert.equal(normalizedNested.permissionMode, 'strict');
    assert.deepEqual(normalizedNested.schemaAllowedTools, ['read', 'grep']);
    assert.equal(normalizedNested.taskType, 'review');
    assert.equal(normalizedNested.maxLoopIterations, 7);

    const rootLead = _sessionSummary(session('root-lead', {
        owner: 'agent',
        ownerSessionId: 'root-lead',
        agent: 'lead',
        visibility: 'agent-only',
    }));
    assert.equal(rootLead.visibility, 'ordinary');
});

test('ordinary catalogs hide durable and legacy children while Agent and exact-ID discovery remain available', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-only-catalog-'));
    const previous = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = root;
    try {
        const sessionsDir = join(root, 'sessions');
        mkdirSync(sessionsDir);
        const records = [
            session('root-lead', {
                owner: 'agent',
                ownerSessionId: 'root-lead',
                agent: 'lead',
                sourceType: 'lead',
            }),
            session('ordinary-user'),
            session('declared-child', {
                ownerSessionId: 'root-lead',
                agent: 'reviewer',
                visibility: 'agent-only',
            }),
            session('legacy-child', {
                owner: 'agent',
                parentSessionId: 'root-lead',
                agent: 'reviewer',
                agentTag: 'review',
                closed: true,
                status: 'closed',
            }),
        ];
        for (const record of records) {
            writeFileSync(
                join(sessionsDir, `${record.id}.json`),
                JSON.stringify(record),
            );
        }

        const indexRows = records.map((record) => _sessionSummary(record));
        delete indexRows.find((row) => row.id === 'legacy-child').visibility;
        writeFileSync(join(root, 'session-summaries.json'), JSON.stringify({
            version: 2,
            updatedAt: Date.now(),
            rows: indexRows,
        }));
        writeFileSync(join(root, 'agent-workers.json'), JSON.stringify({
            workers: {
                review: {
                    tag: 'review',
                    sessionId: 'legacy-child',
                    parentSessionId: 'root-lead',
                    ownerSessionId: 'root-lead',
                    agent: 'reviewer',
                    status: 'idle',
                    stage: 'idle',
                },
            },
        }));

        const expectedOrdinaryIds = ['ordinary-user', 'root-lead'];
        assert.deepEqual(
            listOrdinarySummaries({ rebuildIfMissing: false })
                .map((row) => row.id)
                .sort(),
            expectedOrdinaryIds,
        );
        assert.deepEqual(
            listOrdinarySummaries({ refreshFromStorage: true })
                .map((row) => row.id)
                .sort(),
            expectedOrdinaryIds,
        );
        assert.deepEqual(
            listStoredSessions().map((row) => row.id).sort(),
            expectedOrdinaryIds,
        );
        assert.deepEqual(
            listStoredSessions({ includeAgentOnly: true }).map((row) => row.id).sort(),
            records.map((row) => row.id).sort(),
        );

        const internal = listInternalSummaries({ refreshFromStorage: true });
        assert.deepEqual(
            internal.map((row) => row.id).sort(),
            records.map((row) => row.id).sort(),
        );
        assert.equal(
            internal.find((row) => row.id === 'declared-child')?.visibility,
            'agent-only',
        );
        assert.equal(
            internal.find((row) => row.id === 'legacy-child')?.visibility,
            'agent-only',
        );
        const durableIndex = JSON.parse(readFileSync(
            join(root, 'session-summaries.json'),
            'utf8',
        ));
        assert.equal(
            durableIndex.rows.find((row) => row.id === 'legacy-child')?.visibility,
            'agent-only',
        );

        assert.equal(
            listStoredAgentWorkers().some((row) => row.sessionId === 'legacy-child'),
            true,
        );
        assert.deepEqual(listStoredAgentWorkerLinks(), [{
            sessionId: 'legacy-child',
            parentSessionId: 'root-lead',
            ownerSessionId: 'root-lead',
        }]);
        assert.equal(storedSessionExists('legacy-child'), true);
        const metadata = await readStoredSessionTranscript('legacy-child', { metadataOnly: true });
        assert.equal(metadata?.parentSessionId, 'root-lead');
        assert.equal(Object.hasOwn(metadata || {}, 'items'), false);
        const exact = await readStoredSessionTranscript('legacy-child');
        assert.equal(exact?.sessionId, 'legacy-child');
        assert.equal(exact?.readOnlyDetachedAgent, true);
    } finally {
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
