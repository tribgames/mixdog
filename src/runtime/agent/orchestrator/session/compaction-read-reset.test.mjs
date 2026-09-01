import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../tools/builtin.mjs';
import { runSessionCompaction } from './manager/compaction-runner.mjs';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { resetReadStateAfterCompaction } from './read-dedup.mjs';
import { createContextStatus } from '../../../../session-runtime/context-status.mjs';

const SUMMARY = [
    '## Goal',
    '- continue after compaction',
    '',
    '## Constraints & Preferences',
    '- (none)',
    '',
    '## Progress',
    '### Done',
    '- old context summarized',
    '',
    '### In Progress',
    '- (none)',
    '',
    '### Blocked',
    '- (none)',
    '',
    '## Key Decisions',
    '- (none)',
    '',
    '## Next Steps',
    '- reread the working file',
    '',
    '## Critical Context',
    '- active file must be readable again',
    '',
    '## Relevant Files',
    '- working.txt',
].join('\n');

function fixture(t, tag) {
    const dir = mkdtempSync(join(tmpdir(), `mixdog-compact-read-${tag}-`));
    const file = join(dir, 'working.txt');
    const sessionId = `compact-read-${tag}-${process.pid}-${Date.now()}`;
    writeFileSync(file, 'alpha\nbeta\n', 'utf8');
    t.after(() => {
        resetReadStateAfterCompaction(sessionId);
        rmSync(dir, { recursive: true, force: true });
    });
    return { dir, file, sessionId };
}

async function establishUnchangedSnapshot({ dir, file, sessionId }) {
    const first = String(await executeBuiltinTool('read', { path: file }, dir, { sessionId }));
    assert.match(first, /alpha/);
    const duplicate = await executeBuiltinTool('read', { path: file }, dir, { sessionId });
    assert.equal(duplicate, `[file unchanged: ${file.replaceAll('\\', '/')}]`);
}

function handoffProvider(name) {
    return {
        name,
        async send() {
            return { content: SUMMARY };
        },
    };
}

function contextStatusFor(session) {
    return createContextStatus({
        getSession: () => session,
        getRoute: () => ({
            provider: session.provider,
            model: session.model,
            contextWindow: session.contextWindow,
        }),
        getCurrentCwd: () => session.cwd || process.cwd(),
        getMode: () => 'full',
    }).contextStatus();
}

test('manual compaction starts a fresh read epoch', async (t) => {
    const fx = fixture(t, 'manual');
    await establishUnchangedSnapshot(fx);

    const session = {
        id: fx.sessionId,
        provider: 'anthropic-oauth',
        model: 'fake-model',
        contextWindow: 100_000,
        compactBoundaryTokens: 100_000,
        messages: [
            { role: 'system', content: 'system rules stay exact' },
            { role: 'user', content: 'older request about working.txt' },
            { role: 'assistant', content: 'older answer with file details' },
            { role: 'user', content: 'current request remains verbatim' },
        ],
        tools: [
            { name: 'read', description: 'Read files', inputSchema: { type: 'object' } },
        ],
        deferredNativeTools: true,
        deferredDiscoveredTools: ['recall'],
        deferredToolCatalog: [
            {
                name: 'recall',
                description: 'Recall stored context '.repeat(80),
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
            },
        ],
        owner: 'agent',
        compaction: {},
    };
    const result = await runSessionCompaction(session, {
        mode: 'manual',
        force: true,
        provider: handoffProvider('compact-read-manual'),
        model: 'fake-model',
    });

    assert.equal(result.changed, true);
    const liveStatus = contextStatusFor(session);
    const repeatedStatus = contextStatusFor(session);
    const restartedStatus = contextStatusFor(JSON.parse(JSON.stringify(session)));
    assert.equal(liveStatus.usedTokens, result.afterTokens);
    assert.equal(repeatedStatus.usedTokens, result.afterTokens);
    assert.equal(restartedStatus.usedTokens, result.afterTokens);
    const reread = String(await executeBuiltinTool('read', { path: fx.file }, fx.dir, { sessionId: fx.sessionId }));
    assert.doesNotMatch(reread, /file unchanged/);
    assert.match(reread, /alpha/);
});

test('automatic pre-send compaction resets reads only after transcript change', async (t) => {
    const fx = fixture(t, 'auto');
    await establishUnchangedSnapshot(fx);

    const session = {
        id: fx.sessionId,
        owner: 'agent',
        provider: 'compact-read-auto',
        model: 'fake-model',
        cwd: fx.dir,
        contextWindow: 20_000,
        compactBoundaryTokens: 20_000,
        messages: [
            { role: 'user', content: 'small request' },
            { role: 'assistant', content: 'small answer' },
        ],
        tools: [],
        compaction: { auto: true },
    };
    const state = {
        provider: handoffProvider('compact-read-auto'),
        messages: session.messages,
        model: session.model,
        requestTools: [],
        sessionRef: session,
        sessionId: fx.sessionId,
        cwd: fx.dir,
        opts: {},
        signal: null,
        iterations: 1,
        lastUsage: null,
        firstTurnUsage: null,
        providerState: null,
        reactiveOverflowRetryPending: false,
        loopUsageMetricsTurnId: () => 'test-turn',
        loopUsageMetricsEpoch: () => 0,
    };

    const noChange = await runPreSendCompactPass(state);
    assert.equal(noChange.compactChanged, false);
    const stillUnchanged = await executeBuiltinTool('read', { path: fx.file }, fx.dir, { sessionId: fx.sessionId });
    assert.equal(stillUnchanged, `[file unchanged: ${fx.file.replaceAll('\\', '/')}]`);

    session.messages.unshift(
        { role: 'user', content: `large old request ${'context '.repeat(12_000)}` },
        { role: 'assistant', content: `large old answer ${'detail '.repeat(12_000)}` },
    );
    const changed = await runPreSendCompactPass({ ...state, messages: session.messages });
    assert.equal(changed.compactChanged, true);

    const reread = String(await executeBuiltinTool('read', { path: fx.file }, fx.dir, { sessionId: fx.sessionId }));
    assert.doesNotMatch(reread, /file unchanged/);
    assert.match(reread, /alpha/);
});
