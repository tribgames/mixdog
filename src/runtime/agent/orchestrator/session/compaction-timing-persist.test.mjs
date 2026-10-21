// The compaction timing fields are part of the saved session record: they
// survive a save and a cold reload from disk.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-compaction-timing-persist-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const { runSessionCompaction } = await import('./manager/compaction-runner.mjs');
const { drainSessionStore, evictLiveSession, loadSession, saveSessionAsync } = await import('./store.mjs');
const { settleSessionSummaryIndex } = await import('./store/listing.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  rmSync(dataDir, { recursive: true, force: true });
});

const SUMMARY = [
  '## Goal',
  '- keep the work',
  '## Constraints & Preferences',
  '- (none)',
  '## Progress',
  '### Done',
  '- older turns summarized',
  '### In Progress',
  '- (none)',
  '### Blocked',
  '- (none)',
  '## Key Decisions',
  '- (none)',
  '## Next Steps',
  '- continue',
  '## Critical Context',
  '- (none)',
  '## Relevant Files',
  '- (none)',
].join('\n');

const TIMING_FIELDS = [
  'lastStartedAt',
  'lastCommittedAt',
  'lastDurationMs',
  'lastPipelineMs',
  'lastSummaryMs',
  'lastCommitMs',
  'lastCompactMode',
];

test('compaction timing fields and the summary mode survive a save and a cold reload', async () => {
  const messages = [{ role: 'system', content: 'system rules stay exact' }];
  for (let turn = 0; turn < 30; turn += 1) {
    messages.push(
      { role: 'user', content: `request ${turn} ${'context '.repeat(400)}` },
      { role: 'assistant', content: `answer ${turn} ${'detail '.repeat(400)}` }
    );
  }
  const session = {
    id: `sess_compaction_timing_persist_${process.pid}`,
    provider: 'anthropic',
    model: 'fake-model',
    owner: 'agent',
    contextWindow: 100_000,
    compactBoundaryTokens: 100_000,
    messages,
    tools: [],
    generation: 0,
    closed: false,
    compaction: { conversationThresholdTokens: 1 },
  };
  const provider = {
    name: 'anthropic',
    async send() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { content: SUMMARY };
    },
  };
  const result = await runSessionCompaction(session, {
    mode: 'manual',
    force: true,
    config: {},
    provider,
    model: 'fake-model',
    archive: false,
  });
  assert.equal(result.changed, true);
  const recorded = Object.fromEntries(TIMING_FIELDS.map((key) => [key, session.compaction[key]]));
  for (const key of TIMING_FIELDS) assert.notEqual(recorded[key], undefined, key);
  assert.equal(recorded.lastCompactMode, 'conversation-summary:isolated:session');

  await saveSessionAsync(session, { expectedGeneration: session.generation });
  evictLiveSession(session.id);
  const reloaded = loadSession(session.id);
  assert.notEqual(reloaded, session);
  assert.deepEqual(Object.fromEntries(TIMING_FIELDS.map((key) => [key, reloaded.compaction[key]])), recorded);
});
