// The daemon's session catalog API: ordinary listings go through the reader's
// async listing (which may answer from the session catalog DB), a `limit`
// asks for one keyset page, and the wire result carries its cursor.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoredSessionViews } from './daemon-stored-session-views.mjs';
import { createSessionActionCalls } from './session-service/session-calls/session-action.mjs';

function views() {
  const calls = [];
  const store = {
    listStoredSessionSummaries: (options) => {
      calls.push(['sync', options]);
      return [{ id: 'sync' }];
    },
    listStoredSessionSummariesAsync: async (options) => {
      calls.push(['async', options]);
      return [{ id: 'async' }];
    },
    listStoredSessionSummaryPage: async (options) => {
      calls.push(['page', options]);
      return { sessions: [{ id: 'page' }], nextCursor: 'next' };
    },
  };
  return { calls, views: createStoredSessionViews({ desktopRuntime: { loadSessionStore: async () => store } }) };
}

test('ordinary listings use the async reader; only `page` pages; a refresh is never paged', async () => {
  const { calls, views: stored } = views();
  assert.deepEqual(await stored.listSessions(), [{ id: 'async' }]);
  assert.deepEqual(await stored.listSessions({ limit: 2 }), [{ id: 'async' }], '`limit` alone keeps the full array');
  assert.deepEqual(await stored.listSessions({ page: { limit: 2, cursor: 'c' } }), {
    sessions: [{ id: 'page' }],
    nextCursor: 'next',
  });
  assert.deepEqual(await stored.listSessions({ page: { limit: 2 }, refreshFromStorage: true }), [{ id: 'async' }]);
  assert.deepEqual(calls, [
    ['async', { refreshFromStorage: false }],
    ['async', { refreshFromStorage: false }],
    ['page', { limit: 2, cursor: 'c' }],
    ['async', { refreshFromStorage: true }],
  ]);
});

test('the session catalog call returns a page with its cursor', async () => {
  const { views: stored } = views();
  const actions = createSessionActionCalls({
    isClosed: () => false,
    log: () => {},
    listSessions: stored.listSessions,
    getRemoteSessionState: async () => null,
    projection: {},
    retention: {},
    entries: {},
  });
  assert.deepEqual(await actions.listSessionCatalog({ page: { limit: 1 } }), {
    sessions: [{ id: 'page' }],
    nextCursor: 'next',
    remoteSession: null,
  });
  assert.deepEqual(await actions.listSessionCatalog(), { sessions: [{ id: 'async' }], remoteSession: null });
});
