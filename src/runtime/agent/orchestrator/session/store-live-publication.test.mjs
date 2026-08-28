import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    drainSessionStore,
    saveSessionAsync,
    saveSessionAsyncDeferred,
    subscribeLiveSessions,
} from './store.mjs';

test('async and deferred session saves publish their admitted live snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-live-session-publication-'));
    const previous = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = root;
    mkdirSync(join(root, 'sessions'));
    const published = [];
    const unsubscribe = subscribeLiveSessions((session) => {
        published.push({
            id: session.id,
            messageCount: session.messages.length,
        });
    });
    const session = {
        id: `sess_live_publication_${process.pid}_${Date.now()}`,
        messages: [{ role: 'user', content: 'hello' }],
        generation: 0,
        closed: false,
    };

    try {
        await saveSessionAsync(session, { expectedGeneration: session.generation });
        session.messages.push({ role: 'assistant', content: 'done' });
        await saveSessionAsyncDeferred(session, { expectedGeneration: session.generation });

        assert.deepEqual(published, [
            { id: session.id, messageCount: 1 },
            { id: session.id, messageCount: 2 },
        ]);
    } finally {
        unsubscribe();
        drainSessionStore();
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});

test('an unowned async save publishes no live snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-live-session-refusal-'));
    const previous = process.env.MIXDOG_DATA_DIR;
    process.env.MIXDOG_DATA_DIR = root;
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir);
    const sessionId = `sess_live_refusal_${process.pid}_${Date.now()}`;
    writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify({
        id: 'foreign-session',
        messages: [],
    }));
    const published = [];
    const unsubscribe = subscribeLiveSessions((session) => published.push(session.id));

    try {
        await assert.rejects(
            saveSessionAsync({
                id: sessionId,
                messages: [{ role: 'assistant', content: 'must not publish' }],
                generation: 0,
                closed: false,
            }),
            (error) => error?.code === 'ESESSIONNOTOWNED',
        );
        assert.deepEqual(published, []);
    } finally {
        unsubscribe();
        drainSessionStore();
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
