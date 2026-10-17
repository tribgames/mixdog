import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionService } from './session-service.mjs';
import { readTranscriptRange } from './session-service/projection/transcript-window.mjs';
import { sessionReadOutput } from './session-tool-output.mjs';

const history = Array.from({ length: 8300 }, (_, i) => ({
  id: `hist_s_${i}_0`,
  kind: i % 2 ? 'turndone' : 'assistant',
  text: `row ${i}`,
  ...(i % 2 ? { status: 'failed' } : {}),
}));
const stored = async (_id, { transcriptItemLimit }) => ({
  items: history.slice(-transcriptItemLimit),
  transcriptHasOlder: history.length > transcriptItemLimit,
});

test('request-local ranges preserve cold/live history beyond UI window caps without changing attached views', async () => {
  const entry = { runtime: { getState: () => ({ items: history.slice(-10) }) }, transcriptView: { full: true } };
  for (const offset of [0, 20, 8200, 8300, 9000]) {
    const cold = await readTranscriptRange(null, 's', stored, { offset, limit: 5 });
    const live = await readTranscriptRange(entry, 's', stored, { offset, limit: 5 });
    assert.deepEqual(live, cold);
    const end = Math.max(0, history.length - offset);
    assert.deepEqual(cold.items, history.slice(Math.max(0, end - 5), end));
  }
  assert.deepEqual(entry.transcriptView, { full: true });
});

test('budget-cut backward pages traverse every item once', async () => {
  const rows = history.slice(-105).map((item) => ({ ...item, text: '😀"\\'.repeat(1500) }));
  const reader = async (_id, { transcriptItemLimit }) => ({
    items: rows.slice(-transcriptItemLimit),
    transcriptHasOlder: rows.length > transcriptItemLimit,
  });
  let offset = 0;
  const seen = [];
  do {
    const range = await readTranscriptRange(null, 's', reader, { offset, limit: 25 });
    const output = sessionReadOutput('s', range);
    seen.unshift(...output.items.map((item) => item.id));
    offset = output.nextOffset;
  } while (offset !== null);
  assert.deepEqual(
    seen,
    rows.map((item) => item.id)
  );
});

test('service range reads preserve failure rows and avoid runtime creation', async () => {
  const service = createSessionService({
    createSessionRuntime: async () => assert.fail('read must not create a runtime'),
    sessionExists: async () => true,
    readStoredSession: stored,
  });
  try {
    const result = await service.readSession({ sessionId: 's', transcriptRange: { offset: 1, limit: 3 } });
    assert.deepEqual(result.range.items, history.slice(-4, -1));
    await assert.rejects(service.readSession({ sessionId: 's', transcriptRange: { offset: -1, limit: 1 } }), /invalid/);
  } finally {
    await service.stop('test complete');
  }
});
