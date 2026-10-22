import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { snapshotPendingDeferredToolDelta } from '../runtime-core/deferred-tool-delta.mjs';

function isolatedData(t) {
  const previous = process.env.MIXDOG_DATA_DIR;
  const root = mkdtempSync(join(tmpdir(), 'mixdog-pre-send-compact-'));
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

function lateToolSession(late, toolContent) {
  return {
    id: 'pre-send-rearm',
    owner: 'agent',
    provider: 'rearm-test',
    model: 'rearm-test',
    contextWindow: 40_000,
    compaction: {},
    lastProviderSendAt: Date.now() - 6 * 60_000,
    // Announced once as a late delta (acknowledged: nothing pending), never in the boot manifest.
    tools: [],
    deferredProviderMode: 'native',
    deferredMcpToolNames: [late.name],
    deferredAnnouncedTools: [],
    deferredLateToolCatalog: [late],
    messages: [
      { role: 'system', content: 'Preserve instructions.' },
      { role: 'user', content: 'Continue the approved task.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read-1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'read-1', content: toolContent },
    ],
  };
}

test('an in-turn compaction re-arms a late MCP tool whose announcement it strips', async (t) => {
  isolatedData(t);
  const late = { name: 'mcp__late__two', description: 'Two.' };
  const session = lateToolSession(late, 'Original recoverable output.\n'.repeat(4_000));
  assert.equal(snapshotPendingDeferredToolDelta(session), null);
  const result = await runPreSendCompactPass({
    sessionRef: session,
    sessionId: session.id,
    messages: session.messages.slice(),
    requestTools: [],
    // The worker's 5-minute prompt cache has expired: this send compacts.
    opts: { cacheStrategy: { messages: '5m' } },
  });
  assert.equal(result.compactChanged, true);
  assert.deepEqual(snapshotPendingDeferredToolDelta(session)?.added, [late]);
});

test('a pre-send compaction that fails does not re-arm a late MCP tool', async (t) => {
  isolatedData(t);
  const late = { name: 'mcp__late__two', description: 'Two.' };
  const session = lateToolSession(late, 'Original recoverable output.\n'.repeat(4_000));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runPreSendCompactPass({
      sessionRef: session,
      sessionId: session.id,
      messages: session.messages.slice(),
      requestTools: [],
      signal: controller.signal,
      opts: { cacheStrategy: { messages: '5m' } },
    })
  );
  assert.equal(snapshotPendingDeferredToolDelta(session), null);
});
