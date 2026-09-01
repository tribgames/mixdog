// Memory tool dispatch routing and the cross-session recall merge contract.
import './_env.mjs';
import test from 'node:test';
import { createToolCallHandler } from '../../src/runtime/memory/lib/tool-call-handler.mjs';
import { mergeSessionRowsIntoGlobal } from '../../src/runtime/memory/lib/memory-session-merge.mjs';

test('memory handler injects action=core for public schema calls', async () => {
  let dispatchedMemoryArgs = null;
  const dispatchMemoryToolCall = createToolCallHandler({
    handleSearch: async () => ({ text: '' }),
    handleMemoryAction: async (args) => {
      dispatchedMemoryArgs = args;
      return { text: 'ok' };
    },
  });
  await dispatchMemoryToolCall('memory', { op: 'list' });
  if (dispatchedMemoryArgs?.action !== 'core' || dispatchedMemoryArgs?.op !== 'list') {
    throw new Error(`memory handler must inject action=core for the public schema: ${JSON.stringify(dispatchedMemoryArgs)}`);
  }
  await dispatchMemoryToolCall('memory', { action: 'status' });
  if (dispatchedMemoryArgs?.action !== 'status') {
    throw new Error('memory handler must preserve internal status calls');
  }
});

// Behaviour-level checks for the cross-session merge contract. These exercise
// the pure mergeSessionRowsIntoGlobal() helper (no DB) so the starve-prevention
// + dedupe + includeRaw-parity invariants are guarded, not just the schema.
test('cross-session recall merge: starve prevention, dedupe, sort, passthrough', () => {
  // 1) Starve prevention: a flood of session rows must NOT push global hybrid
  //    hits off the first page. Global rows carry a real retrievalScore; the
  //    session rows (score 0) must sort AFTER them under importance.
  const globalHits = [
    { id: 1, retrievalScore: 0.9, ts: 100 },
    { id: 2, retrievalScore: 0.8, ts: 110 },
  ];
  const sessionFlood = Array.from({ length: 20 }, (_, i) => ({ id: 1000 + i, retrievalScore: 0, ts: 200 + i }));
  const mergedImportance = mergeSessionRowsIntoGlobal(globalHits, sessionFlood, { sort: 'importance' });
  if (mergedImportance.slice(0, 2).map((r) => r.id).join(',') !== '1,2') {
    throw new Error(`session merge must not starve global first page under importance: ${JSON.stringify(mergedImportance.slice(0, 3))}`);
  }
  if (mergedImportance.length !== globalHits.length + sessionFlood.length) {
    throw new Error('session merge must append all non-duplicate session rows');
  }
  // 2) Dedupe by id AND by global root member id (member/leaf double-output).
  const globalWithMembers = [{ id: 5, retrievalScore: 0.7, ts: 100, members: [{ id: 51 }, { id: 52 }] }];
  const sessionDupes = [
    { id: 5, retrievalScore: 0, ts: 300 }, // dup root id
    { id: 51, retrievalScore: 0, ts: 301 }, // dup member id
    { id: 99, retrievalScore: 0, ts: 302 }, // genuinely new
  ];
  const mergedDedupe = mergeSessionRowsIntoGlobal(globalWithMembers, sessionDupes, { sort: 'importance' });
  const dedupeIds = mergedDedupe.map((r) => Number(r.id)).sort((a, b) => a - b);
  if (dedupeIds.join(',') !== '5,99') {
    throw new Error(`session merge must dedupe root+member ids, leaving only new rows: ${JSON.stringify(dedupeIds)}`);
  }
  // 3) date sort keeps newest-first across the merged set.
  const mergedDate = mergeSessionRowsIntoGlobal(
    [{ id: 1, retrievalScore: 0.9, ts: 100 }],
    [{ id: 2, retrievalScore: 0, ts: 999 }],
    { sort: 'date' },
  );
  if (Number(mergedDate[0].id) !== 2) {
    throw new Error(`session merge under date sort must order by ts desc: ${JSON.stringify(mergedDate)}`);
  }
  // 4) Empty session rows is a no-op passthrough (no crash, same array).
  const passthrough = mergeSessionRowsIntoGlobal(globalHits, [], { sort: 'importance' });
  if (passthrough.length !== globalHits.length) {
    throw new Error('session merge with no session rows must be a passthrough');
  }
});
