// Run with --experimental-test-module-mocks.
// A close cancels the session's search writes: queued ones never reach the
// database layer, the running one is cancelled through its signal, and a
// cancellation is not reported as a failed write.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

// Every write the database layer receives; each stays pending until its
// signal aborts, the way a write waiting on a PostgreSQL install does.
const appends = [];
let onAppend = null;
const pendingUntilAborted = (signal) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
mock.module('./session-search-db.mjs', {
  namedExports: {
    appendSessionSearchMessages: (sessionId, _messages, { signal }) => {
      appends.push({ sessionId, signal });
      onAppend?.();
      return pendingUntilAborted(signal);
    },
    replaceSessionSearchMessages: (_sessionId, _plain, _redacted, _redact, { signal }) => pendingUntilAborted(signal),
    deleteSessionSearchMessages: async () => {},
    readSessionSearchBackfillStamps: async () => new Map(),
    readSessionSearchSessionIds: async () => [],
    recordSessionSearchBackfillStamp: async () => {},
  },
});
const { closeSessionSearch, ingestSessionTurn } = await import('./session-search-ingest.mjs');

const turn = (id, count) => ({
  id,
  messages: Array.from({ length: count }, (_, index) => ({ role: 'user', content: `message ${index}` })),
});

function captureReports(t) {
  const reports = [];
  const write = process.stderr.write.bind(process.stderr);
  t.mock.method(process.stderr, 'write', (chunk, ...rest) => {
    if (String(chunk).includes('[session-search]')) reports.push(String(chunk));
    else write(chunk, ...rest);
    return true;
  });
  return reports;
}

test('a write cancelled before its first dispatch never reaches the database layer', async (t) => {
  const reports = captureReports(t);
  appends.length = 0;
  ingestSessionTurn(turn('sess_cancel_before_dispatch', 1));
  await closeSessionSearch('sess_cancel_before_dispatch');
  assert.equal(appends.length, 0);
  assert.deepEqual(reports, [], 'a cancellation is not a failed write');
});

test('closing cancels the running write and every write queued behind it', async (t) => {
  const reports = captureReports(t);
  appends.length = 0;
  const dispatched = new Promise((resolve) => {
    onAppend = resolve;
  });
  ingestSessionTurn(turn('sess_cancel_queue', 1));
  ingestSessionTurn(turn('sess_cancel_queue', 2));
  ingestSessionTurn(turn('sess_cancel_queue', 3));
  await dispatched;
  onAppend = null;
  await closeSessionSearch('sess_cancel_queue');
  assert.equal(appends.length, 1, 'the queued writes never started');
  assert.equal(appends[0].signal.aborted, true, 'the running write was cancelled through its signal');
  assert.deepEqual(reports, []);
});
