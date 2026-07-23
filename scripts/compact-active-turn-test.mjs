import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sandbox the session store: these tests persist real session files, and
// without this they polluted ~/.mixdog/data/sessions with visible
// `sess_test_*` rows in the desktop Recent list (user report).
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-compact-active-'));
import {
    compactSessionMessages,
    isSessionCompactionBlocked,
    markSessionAskStart,
    markSessionToolCall,
    getSessionRuntime,
} from '../src/runtime/agent/orchestrator/session/manager.mjs';
import { loadSession, saveSessionAsync } from '../src/runtime/agent/orchestrator/session/store.mjs';

test('isSessionCompactionBlocked is true while runtime reports tool_running with live controller', () => {
    const sessionId = `sess_test_${process.pid}_${Date.now()}`;
    const session = {
        id: sessionId,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        messages: [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' },
        ],
        tools: [],
        generation: 1,
        closed: false,
        compaction: { type: 1, compactType: 1 },
        contextWindow: 128_000,
    };
    void saveSessionAsync(session, { expectedGeneration: 1 });
    markSessionAskStart(sessionId);
    markSessionToolCall(sessionId, 'read');
    const entry = getSessionRuntime(sessionId);
    entry.controller = new AbortController();

    assert.equal(isSessionCompactionBlocked(sessionId), true);
});

test('compactSessionMessages returns no-op while turn is active', async () => {
    const sessionId = `sess_test_compact_${process.pid}_${Date.now()}`;
    const session = {
        id: sessionId,
        provider: 'openai',
        model: 'gpt-4.1-mini',
        messages: [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' },
        ],
        tools: [],
        generation: 1,
        closed: false,
        compaction: { type: 1, compactType: 1 },
        contextWindow: 128_000,
    };
    await saveSessionAsync(session, { expectedGeneration: 1 });
    markSessionAskStart(sessionId);
    markSessionToolCall(sessionId, 'grep');
    const entry = getSessionRuntime(sessionId);
    entry.controller = new AbortController();

    const before = loadSession(sessionId);
    const result = await compactSessionMessages(sessionId);
    const after = loadSession(sessionId);

    assert.equal(result?.changed, false);
    assert.equal(result?.reason, 'compact skipped: turn in progress');
    assert.deepEqual(after.messages, before.messages);
});
