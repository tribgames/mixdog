// The phone's file search waits for the core's answer to the query it sent. The core reads an unpaired surrogate as U+FFFD
// (decisions.md "frame-lone-surrogate" (a)) and echoes the query so; the adapter must take that echo as its own query's answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-files.ts';

test('a query holding a lone surrogate is answered by the core echoing it with U+FFFD', { timeout: 10_000 }, async () => {
  const listeners = new Set();
  const notify = (method, params) => {
    for (const listener of listeners) listener({ type: 'notification', notification: { method, params } });
  };
  const client = {
    on: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    call: async (method, params) => {
      if (method === 'search/update') {
        // The core's frames as its decoder read the query: the lone unit is U+FFFD.
        const query = params.query.replace(/[\ud800-\udfff]/gu, '\ufffd');
        notify('search/updated', { sessionId: params.sessionId, query, files: [] });
        notify('search/completed', { sessionId: params.sessionId, query });
      }
      return {};
    },
  };
  const host = { ctx: {}, client: () => client, declareLane() {} };
  assert.deepEqual(await adapter.calls.searchProjectFiles(['C:/project', 'a\ud83d', 50, false, false], host), []);
  // A real U+FFFD in the query is the same query to both.
  assert.deepEqual(await adapter.calls.searchProjectFiles(['C:/project', 'a\ufffd', 50, false, false], host), []);
});
