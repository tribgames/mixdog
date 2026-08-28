import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    recordContextUsageSnapshot,
    resolveWorkerCompactPolicy,
} from './loop/compact-policy.mjs';
import { readStoredSessionTranscript } from './store-summary-reader.mjs';

test('cold transcript reads preserve the canonical post-compact usage snapshot', async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mixdog-context-restart-'));
    const previousDataDir = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = dataDir;
    t.after(async () => {
        if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previousDataDir;
        await rm(dataDir, { recursive: true, force: true });
    });

    const id = `context_restart_${process.pid}_${Date.now()}`;
    const messages = [
        { role: 'user', content: 'Compacted conversation summary' },
        { role: 'assistant', content: 'Retained continuation context' },
    ];
    const tools = [
        { name: 'read', description: 'Read files', inputSchema: { type: 'object' } },
    ];
    const session = {
        id,
        generation: 0,
        closed: false,
        provider: 'openai-oauth',
        model: 'gpt-5.6-sol',
        cwd: process.cwd(),
        contextWindow: 272_000,
        rawContextWindow: 272_000,
        compactBoundaryTokens: 272_000,
        usageMetricsTurnId: 'turn-after-compact',
        usageMetricsEpoch: 3,
        messages,
        tools,
        compaction: {
            auto: true,
            boundaryTokens: 272_000,
            triggerTokens: 272_000,
        },
    };
    const policy = resolveWorkerCompactPolicy(session, tools);
    recordContextUsageSnapshot(session, policy, {
        messages,
        usedTokens: 35_000,
        source: 'post_compact',
    });

    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    await writeFile(
        join(dataDir, 'sessions', `${id}.json`),
        JSON.stringify(session),
        'utf8',
    );

    const first = await readStoredSessionTranscript(id);
    const second = await readStoredSessionTranscript(id);
    assert.equal(first.preparedContextProjection, true);
    assert.equal(first.stats.currentEstimatedContextTokens, 35_000);
    assert.equal(second.stats.currentEstimatedContextTokens, 35_000);
    assert.equal(first.autoCompactTokenLimit, second.autoCompactTokenLimit);
    assert.equal(first.displayContextWindow, second.displayContextWindow);
});
