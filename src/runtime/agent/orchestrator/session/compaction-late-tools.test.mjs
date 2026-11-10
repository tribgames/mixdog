import assert from 'node:assert/strict';
import test from 'node:test';
import { runSessionCompaction } from './manager/compaction-runner.mjs';

const SUMMARY = [
  '## Goal',
  '- continue',
  '',
  '## Constraints & Preferences',
  '- (none)',
  '',
  '## Progress',
  '### Done',
  '- summarized',
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
  '- (none)',
  '',
  '## Critical Context',
  '- (none)',
  '',
  '## Relevant Files',
  '- (none)',
].join('\n');

// A worker gets no prompt fold after compaction: a built-in a setting opened
// mid-conversation (late pool, announced only in dropped history) must be
// announced again by the automatic post-turn compaction too.
test('automatic post-turn compaction re-announces late-enabled tools', async () => {
  const webSearch = { name: 'web_search', description: 'Search the web.', inputSchema: { type: 'object' } };
  const session = {
    id: `late-tools-${process.pid}-${Date.now()}`,
    owner: 'agent',
    provider: 'anthropic-oauth',
    model: 'fake-model',
    contextWindow: 100_000,
    compactBoundaryTokens: 100_000,
    messages: [
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'older request' },
      { role: 'assistant', content: 'older answer' },
      { role: 'user', content: '[mixdog-runtime] obsolete notification' },
      { role: 'user', content: 'current request' },
    ],
    tools: [{ name: 'read', description: 'Read files', inputSchema: { type: 'object' } }],
    deferredProviderMode: 'native',
    deferredToolCatalog: [],
    deferredLateToolCatalog: [webSearch],
    deferredAnnouncedTools: [],
    disallowedTools: [],
    compaction: { auto: true },
  };
  const result = await runSessionCompaction(session, {
    config: {},
    mode: 'auto',
    force: true,
    provider: { name: 'late-tools', send: async () => ({ content: SUMMARY }) },
    model: 'fake-model',
  });
  assert.equal(result.changed, true);
  assert.equal(session.pendingCacheBreakIntent, 'post_turn_compaction');
  assert.deepEqual(
    session.pendingDeferredToolDelta?.added?.map((entry) => entry.name),
    ['web_search']
  );
});
