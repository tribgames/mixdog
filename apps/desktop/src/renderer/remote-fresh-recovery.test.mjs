import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatAdapter } from './remote-protocol-chat.ts';
import { createCapabilityLane } from '../main/protocol/capability-route.ts';
import { routeService } from '../main/protocol/service-route.ts';
import { coreErrorForWindow } from '../main/protocol/core-error.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { normalizedProviderModels } from '../main/desktop-support.ts';
import { createRemoteSessionInbox } from './remote-session-inbox.ts';

test("a fresh recovery publishes the phone client's current projection to the page, with no resume from the feed cursor", async () => {
  const ctx = { sessionsCatalog: { publish() {} }, sessionInbox: createRemoteSessionInbox({ onGap() {} }) };
  let state = { sessionId: 'sess_a', items: [], toolApproval: { id: 'ap-1', kind: 'approval' } };
  const resumed = [];
  const client = {
    call: async () => ({}),
    resumeThread: async (id) => resumed.push(id),
    unsubscribeThread: async () => undefined,
    server: { connection: { device: 'Phone' } },
  };
  const adapter = createChatAdapter({
    sharedFor: (handed) => {
      const protocol = {
        call: (method, params) => handed.call(method, params),
        snapshot: () => ({ entries: [] }),
        noteUserInput() {},
        respond() {},
        pendingServerRequests: () => [],
      };
      return {
        routeService,
        lane: createCapabilityLane({ protocol }),
        coreErrorForWindow,
        normalizedProviderModels,
        sessionStateOf: () => state,
        foldRows: () => [],
      };
    },
    remoteSession: () => undefined,
    roster: { summaries: (rows) => summariesOfThreadRows(rows) },
  });
  const host = { ctx, client: () => client, declareLane() {} };
  const seen = [];
  ctx.sessionInbox.subscribe((update) => seen.push(update));
  // The page still shows a card; the client no longer holds the request.
  state = { sessionId: 'sess_a', items: [], toolApproval: null };
  assert.equal(await adapter.calls.refreshSessionState(['sess_a'], host), true);
  assert.equal(seen.length, 1, 'the page received a frame');
  assert.equal(seen[0].sessionId, 'sess_a');
  assert.equal(seen[0].snapshot.toolApproval, null, 'the stale card is gone');
  assert.deepEqual(resumed, [], 'nothing was resumed from the cursor');
  // A request still held is published as held.
  state = { sessionId: 'sess_a', items: [], toolApproval: { id: 'ap-2', kind: 'approval' } };
  await adapter.calls.refreshSessionState(['sess_a'], host);
  assert.equal(seen.at(-1).snapshot.toolApproval.id, 'ap-2');
});
