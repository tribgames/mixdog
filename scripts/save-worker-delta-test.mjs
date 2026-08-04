/**
 * save-worker-delta-test.mjs — proves the save-worker delta handoff persists
 * byte-identical sessions across the append / truncate / worker-base-evicted
 * paths introduced by _buildWirePayload (save-worker.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-save-delta-'));
process.env.MIXDOG_DATA_DIR = dataDir;
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

const store = await import('../src/runtime/agent/orchestrator/session/store.mjs');
const { saveSessionAsync, loadSession, evictLiveSession } = store;

function makeSession(id) {
    return {
        id,
        generation: 0,
        closed: false,
        tools: [],
        messages: [
            { role: 'user', content: `hello from ${id}` },
            { role: 'assistant', content: 'first reply' },
        ],
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

// Disk-truth read: bypass the same-process live cache so the assertion sees
// exactly what the worker wrote.
function diskSession(id) {
    evictLiveSession?.(id);
    const loaded = loadSession(id, { bypassLiveCache: true }) ?? loadSession(id);
    return loaded;
}

test('pure-append turns round-trip byte-identically through the delta lane', async () => {
    const session = makeSession('sess_delta_append');
    await saveSessionAsync(session, { expectedGeneration: 0 });
    for (let turn = 0; turn < 3; turn += 1) {
        session.messages = [
            ...session.messages,
            { role: 'user', content: `turn ${turn} question` },
            { role: 'assistant', content: `turn ${turn} answer ${'x'.repeat(64)}` },
        ];
        session.updatedAt = Date.now();
        await saveSessionAsync(session, { expectedGeneration: 0 });
    }
    const loaded = diskSession('sess_delta_append');
    assert.equal(loaded.messages.length, 8);
    assert.equal(loaded.messages.at(-1).content, `turn 2 answer ${'x'.repeat(64)}`);
    assert.equal(loaded.messages[0].content, 'hello from sess_delta_append');
});

test('a truncated prefix (compaction/clear) falls back to a full snapshot', async () => {
    const session = makeSession('sess_delta_truncate');
    await saveSessionAsync(session, { expectedGeneration: 0 });
    session.messages = [...session.messages, { role: 'assistant', content: 'will survive' }];
    await saveSessionAsync(session, { expectedGeneration: 0 });
    // Compaction-style replacement: drop the head, keep the tail objects.
    session.messages = [
        { role: 'system', content: 'compact summary' },
        ...session.messages.slice(2),
    ];
    session.updatedAt = Date.now();
    await saveSessionAsync(session, { expectedGeneration: 0 });
    const loaded = diskSession('sess_delta_truncate');
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].content, 'compact summary');
    assert.equal(loaded.messages[1].content, 'will survive');
});

test('worker base eviction answers deltaMiss and the full retry still lands', async () => {
    const primary = makeSession('sess_delta_evict');
    await saveSessionAsync(primary, { expectedGeneration: 0 });
    // Roll 9 other ids through the worker (base LRU cap is 8) so the worker
    // evicts sess_delta_evict's base while the parent still holds a baseline.
    for (let index = 0; index < 9; index += 1) {
        await saveSessionAsync(makeSession(`sess_delta_filler_${index}`), { expectedGeneration: 0 });
    }
    primary.messages = [...primary.messages, { role: 'assistant', content: 'after eviction' }];
    primary.updatedAt = Date.now();
    await saveSessionAsync(primary, { expectedGeneration: 0 });
    const loaded = diskSession('sess_delta_evict');
    assert.equal(loaded.messages.length, 3);
    assert.equal(loaded.messages.at(-1).content, 'after eviction');
});

test.after(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});
