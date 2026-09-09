import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshContextCompactMessages } from '../compact.mjs';
import { runFreshContextCompact } from '../loop/fresh-context.mjs';
import { persistToolResultArtifactSync, pruneOffloadSession } from '../tool-result-offload.mjs';
import { projectSessionMessagesForIngest } from '../../../../memory/lib/session-ingest.mjs';
import { buildExecutionTail, executionTokens, EXECUTION_RECOVERY_SOURCE } from './execution-tail.mjs';

function sandbox(t) {
    const previous = process.env.MIXDOG_DATA_DIR;
    const root = mkdtempSync(join(tmpdir(), 'mixdog-execution-tail-'));
    process.env.MIXDOG_DATA_DIR = root;
    t.after(() => {
        if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
        else process.env.MIXDOG_DATA_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}

function pair(id, result, args = { file_path: `${id}.js`, old_string: 'before', new_string: 'after' }) {
    return [
        { role: 'assistant', content: '', toolCalls: [{ id, name: 'edit', arguments: args }] },
        { role: 'tool', toolCallId: id, content: result },
    ];
}

test('Memory-only handoff cannot erase seven completed edits or the original request before steering', async () => {
    const original = { role: 'user', content: 'Remove mobile from h1, not metadata.' };
    const steering = { role: 'user', content: 'Steam too.', meta: { source: 'steering' } };
    const messages = [{ role: 'system', content: 'rules' }, original, ...pair('rank-0', 'Updated rank-hub.js')];
    messages.push(steering);
    for (let i = 1; i < 7; i += 1) messages.push(...pair(`edit-${i}`, `Updated file ${i}`));
    let providerCalls = 0;
    const compacted = await runFreshContextCompact({
        sessionRef: { id: 'seven-edits', contextWindow: 500_000 },
        sessionId: 'seven-edits',
        messages,
        compactBudgetTokens: 250_000,
        compactPolicy: { contextWindow: 500_000, reserveTokens: 0 },
        activeTurn: true,
        provider: { async send() { providerCalls += 1; throw new Error('unexpected summary call'); } },
        executeMemorySearch: async ({ action }) => action === 'ingest_session' ? 'ok' : 'The assistant plans to edit h1.',
    });
    assert.equal(providerCalls, 0);
    assert.deepEqual(compacted.messages.filter(m => m.role === 'tool'), messages.filter(m => m.role === 'tool'));
    assert.deepEqual(compacted.messages.flatMap(m => m.toolCalls || []), messages.flatMap(m => m.toolCalls || []));
    assert.equal(compacted.messages.filter(m => m.content === original.content).length, 1);
    assert.equal(compacted.messages.filter(m => m.content === steering.content).length, 1);
    assert.equal(compacted.diagnostics.toolHistoryBudget, 25_000);
    const again = freshContextCompactMessages(compacted.messages, 250_000, {
        force: true, contextWindow: 500_000, handoffText: 'Still in progress.', activeTurn: true,
    });
    assert.deepEqual(again.messages.filter(m => m.role === 'tool'), messages.filter(m => m.role === 'tool'));
    assert.equal(again.messages.filter(m => m.content === original.content).length, 1);
});

test('failed, partially applied, and running outcomes remain verbatim and are never promoted to success', () => {
    const messages = [
        { role: 'user', content: 'Apply the changes and verify.' },
        ...pair('partial', 'Applied a.js; rejected b.js: context mismatch'),
        ...pair('failed', 'Error: permission denied'),
        ...pair('running', 'background task\ntask_id: job-123\nstatus: running', { command: 'node build.mjs' }),
    ];
    const result = buildExecutionTail(messages, { contextWindow: 100_000 });
    assert.deepEqual(result.messages.filter(m => m.role === 'tool'), messages.filter(m => m.role === 'tool'));
    assert.equal(result.toolBudget, 5_000);
});

test('large tool results are archived exactly and retained calls remain paired under the strict cap', t => {
    sandbox(t);
    const content = 'EXACT_OUTPUT\n'.repeat(15_000);
    const messages = [{ role: 'user', content: 'inspect' }, ...pair('huge', content), ...pair('recent', 'Updated recent.js')];
    const result = buildExecutionTail(messages, { contextWindow: 40_000, sessionId: 'huge-results' });
    assert.equal(result.toolBudget, 2_000);
    assert.ok(result.toolTokens <= result.toolBudget);
    const recovery = result.messages.find(m => m.meta?.source === EXECUTION_RECOVERY_SOURCE);
    const path = recovery.content.match(/available at (.+?) \(sha256:/)[1];
    const archive = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(archive.messages, messages);
    assert.equal(result.messages.find(m => m.toolCallId === 'recent').content, 'Updated recent.js');
    const ids = result.messages.flatMap(m => (m.toolCalls || []).map(c => c.id));
    assert.deepEqual(result.messages.filter(m => m.role === 'tool').map(m => m.toolCallId), ids);
    assert.equal(projectSessionMessagesForIngest(result.messages).some(m => m.content.includes('available at')), false);
});

test('large arguments and opaque provider replay cannot bypass the tool-history budget', t => {
    sandbox(t);
    const messages = [
        { role: 'user', content: 'work' },
        ...pair('old', 'Updated old.js', { patch: 'large patch '.repeat(5_000) }),
        ...pair('latest', 'Updated latest.js'),
    ];
    messages[1].providerReplay = { items: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(5_000) }] };
    const result = buildExecutionTail(messages, { contextWindow: 20_000, sessionId: 'large-arguments' });
    assert.equal(result.toolBudget, 1_000);
    assert.ok(result.toolTokens <= 1_000);
    assert.ok(result.omittedGroups > 0);
    assert.ok(result.messages.some(m => m.toolCallId === 'latest'));
    assert.equal(result.messages.some(m => m.toolCallId === 'old'), false);
    assert.ok(executionTokens(messages.slice(1, 3)) > 1_000);
});

test('archive failure leaves the input unchanged and refuses compaction rather than dropping evidence', t => {
    const root = sandbox(t);
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, 'occupied');
    process.env.MIXDOG_DATA_DIR = blocked;
    const messages = [{ role: 'user', content: 'work' }, ...pair('large', 'result '.repeat(10_000))];
    const before = JSON.stringify(messages);
    assert.throws(() => buildExecutionTail(messages, { contextWindow: 20_000, sessionId: 'blocked' }), /could not be archived/);
    assert.equal(JSON.stringify(messages), before);
});

test('repeated archive references keep their underlying artifacts reachable during pruning', async t => {
    sandbox(t);
    const sessionId = 'archive-chain';
    const original = persistToolResultArtifactSync({ sessionId, toolCallId: 'original', content: 'original evidence' });
    const inner = persistToolResultArtifactSync({ sessionId, toolCallId: 'inner', content: JSON.stringify({ path: original.path }) });
    const outer = persistToolResultArtifactSync({ sessionId, toolCallId: 'outer', content: JSON.stringify({ path: inner.path }) });
    const unused = persistToolResultArtifactSync({ sessionId, toolCallId: 'unused', content: 'unreachable evidence' });
    const old = new Date(Date.now() - 3_600_000);
    for (const artifact of [original, inner, outer, unused]) utimesSync(artifact.path, old, old);
    await pruneOffloadSession(sessionId, () => [{ content: outer.path }]);
    assert.equal(readFileSync(original.path, 'utf8'), 'original evidence');
    assert.ok(existsSync(inner.path));
    assert.ok(existsSync(outer.path));
    assert.equal(existsSync(unused.path), false);
    assert.equal(dirname(inner.path), dirname(outer.path));
});
