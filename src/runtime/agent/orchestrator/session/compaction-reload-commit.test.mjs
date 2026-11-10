// A config reload that lands while an automatic compaction is in flight syncs
// the new global settings into the live session. The commit that follows must
// keep them: it writes only its own outcome telemetry.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compact-reload-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { runSessionCompaction } = await import('./manager/compaction-runner.mjs');
const { syncSessionCompaction } = await import('../../../../session-runtime/session-compaction-sync.mjs');

test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const SUMMARY = [
  '## Goal',
  '- keep settings',
  '',
  '## Constraints & Preferences',
  '- (none)',
  '',
  '## Progress',
  '### Done',
  '- older turns summarized',
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
  '- continue',
  '',
  '## Critical Context',
  '- (none)',
  '',
  '## Relevant Files',
  '- (none)',
].join('\n');

function sessionFor(tag) {
  const messages = [{ role: 'system', content: 'system rules stay exact' }];
  for (let turn = 0; turn < 30; turn += 1) {
    messages.push(
      { role: 'user', content: `request ${turn} ${'context '.repeat(400)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` }
    );
  }
  return {
    id: `compact-reload-${process.pid}-${tag}`,
    provider: 'anthropic-oauth',
    model: 'fake-model',
    owner: 'agent',
    contextWindow: 60_000,
    compactBoundaryTokens: 60_000,
    messages,
    tools: [],
    compaction: { auto: true, reservedTokens: 3000, summaryModel: 'old-model', conversationThresholdTokens: 1 },
  };
}

// Runs one automatic compaction; `onSend` runs inside the summary call, where
// the reload lands.
async function autoCompactWhile(session, onSend) {
  const provider = {
    name: 'anthropic-oauth',
    async send() {
      onSend();
      await new Promise((resolve) => setImmediate(resolve));
      return { content: SUMMARY };
    },
  };
  return runSessionCompaction(session, { mode: 'auto', config: {}, provider, model: 'fake-model' });
}

const reloadAutoOff = (session) => syncSessionCompaction(session, { compaction: { auto: false } });

test('a reload that turns auto-compaction off survives the automatic compaction that was running', async () => {
  const session = sessionFor('complete');
  const result = await autoCompactWhile(session, () => reloadAutoOff(session));
  assert.equal(result.changed, true, JSON.stringify(result));
  assert.equal(session.compaction.lastStage, 'post_turn');
  assert.equal(session.compaction.auto, false);
  assert.equal(Object.hasOwn(session.compaction, 'reservedTokens'), false, 'a removed setting is not written back');
  assert.equal(Object.hasOwn(session.compaction, 'summaryModel'), false);
  assert.equal(session.compaction.conversationThresholdTokens, 1, 'per-session fields stay');
  assert.equal(session.compaction.compactCount, 1, 'the commit still records its own outcome');
});

test('a reload during an automatic compaction that fails keeps the reloaded settings too', async () => {
  const session = sessionFor('failed');
  const result = await autoCompactWhile(session, () => {
    reloadAutoOff(session);
    session.messages = session.messages.slice(0, -2);
  });
  assert.equal(result.changed, false);
  assert.match(result.error, /changed while compacting/);
  assert.equal(session.compaction.lastStage, 'post_turn_failed');
  assert.equal(session.compaction.auto, false);
  assert.equal(Object.hasOwn(session.compaction, 'reservedTokens'), false);
});

test('without a reload the commit keeps the session settings', async () => {
  const session = sessionFor('plain');
  const result = await autoCompactWhile(session, () => {});
  assert.equal(result.changed, true);
  assert.equal(session.compaction.auto, true);
  assert.equal(session.compaction.reservedTokens, 3000);
  assert.equal(session.compaction.summaryModel, 'old-model');
});
