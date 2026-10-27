import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { snapshotPendingDeferredToolDelta } from '../runtime-core/deferred-tool-delta.mjs';
import { syncSessionCompaction } from '../../../../session-runtime/session-compaction-sync.mjs';

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

// A config reload lands while a pre-send compaction is running: the telemetry
// the pass writes afterwards must keep the reloaded auto-compaction setting,
// not restore the policy it resolved before the reload.
const reloadAutoOff = (session) => syncSessionCompaction(session, { compaction: { auto: false } });

test('a reload that turns auto-compaction off survives the pre-send compaction that was running', async (t) => {
  isolatedData(t);
  const late = { name: 'mcp__late__two', description: 'Two.' };
  const session = lateToolSession(late, 'Original recoverable output.\n'.repeat(4_000));
  const result = await runPreSendCompactPass({
    sessionRef: session,
    sessionId: session.id,
    messages: session.messages.slice(),
    requestTools: [],
    opts: {
      cacheStrategy: { messages: '5m' },
      // Runs after the compaction itself, before the pass records its outcome.
      onStageChange: (stage) => {
        if (stage === 'requesting') reloadAutoOff(session);
      },
    },
  });
  assert.equal(result.compactChanged, true);
  assert.equal(session.compaction.lastStage, 'pre_send');
  assert.equal(session.compaction.auto, false);
});

test('a reload during a pre-send compaction that fails keeps the reloaded setting too', async (t) => {
  isolatedData(t);
  const messages = [{ role: 'system', content: 'Preserve instructions.' }];
  for (let turn = 0; turn < 30; turn += 1) {
    messages.push(
      { role: 'user', content: `request ${turn} ${'context '.repeat(400)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` }
    );
  }
  const session = {
    id: 'pre-send-failed',
    owner: 'agent',
    provider: 'rearm-test',
    model: 'rearm-test',
    contextWindow: 20_000,
    compaction: { conversationThresholdTokens: 1 },
    lastProviderSendAt: Date.now() - 6 * 60_000,
    tools: [],
    messages,
  };
  const provider = {
    name: 'rearm-test',
    async send() {
      reloadAutoOff(session);
      throw new Error('summary unavailable');
    },
  };
  await runPreSendCompactPass({
    sessionRef: session,
    sessionId: session.id,
    messages: session.messages.slice(),
    requestTools: [],
    provider,
    model: 'rearm-test',
    opts: { cacheStrategy: { messages: '5m' } },
  }).catch(() => {});
  assert.equal(session.compaction.lastStage, 'overflow_failed');
  assert.equal(session.compaction.auto, false);
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
