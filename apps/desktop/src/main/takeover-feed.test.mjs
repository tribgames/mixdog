import assert from 'node:assert/strict';
import test from 'node:test';

import { beginComputerOperation } from './human-only-approval.ts';
import { createTakeoverFeed } from './takeover-feed.ts';
import { createTakeoverStateHandler } from './takeover-state.ts';
import { createTakeoverGate } from './takeover-gate.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The window process's takeover wiring over the real gate, fed the way the core feeds it: server requests. */
function rig() {
  const gate = createTakeoverGate();
  const calls = [];
  const browser = {
    endTakeoverPage: (sessionId, current) => calls.push(['end', sessionId, current]),
    openForTakeover: (sessionId, id) => calls.push(['open', sessionId, id]),
  };
  const handle = createTakeoverStateHandler({
    gate,
    login: { sync: (sessionId, login) => calls.push(['login', sessionId, login]) },
    loginOf: (snapshot) => {
      const takeover = snapshot?.toolApproval?.takeover;
      return takeover?.purpose === 'login' ? { id: snapshot.toolApproval.id, url: takeover.url, tab: takeover.tab ?? '' } : null;
    },
    browser: () => browser,
    capture: (sessionId, id, tab) => {
      calls.push(['capture', sessionId, id, tab]);
      return true;
    },
  });
  const feed = createTakeoverFeed(handle);
  const request = (id, params) => feed({ type: 'serverRequest', request: { id, method: 'item/tool/requestApproval', params } });
  const resolved = (id, threadId, resolution = { kind: 'timedOut', at: 1 }) =>
    feed({ type: 'serverRequestResolved', params: { requestId: id, threadId, resolution } });
  const held = (sessionId) => {
    try {
      gate.assertFree(sessionId);
      return false;
    } catch {
      return true;
    }
  };
  return { gate, calls, request, resolved, held, dispose: () => gate.dispose() };
}

const takeover = (extra = {}) => ({ kind: 'takeover', threadId: 'T', turnId: 'r1', takeover: { surface: 'browser', instructions: 'sign in', tab: 'p1', ...extra }, expiresAt: Date.now() + 900_000 });

test('a takeover card the core times out ends the page it handed over and frees the session', async () => {
  const { calls, request, resolved, held, dispose } = rig();
  request('a1', takeover());
  assert.equal(held('T'), true);
  assert.equal(held('U'), false, 'another session keeps working');
  await sleep(5);
  assert.deepEqual(calls, [['login', 'T', null], ['end', 'T', 'a1'], ['capture', 'T', 'a1', 'p1'], ['open', 'T', 'a1']]);
  calls.length = 0;
  // The core's 15-minute deadline passed: `serverRequest/resolved` with the timedOut resolution.
  resolved('a1', 'T');
  assert.deepEqual(calls, [['login', 'T', null], ['end', 'T', '']], 'the handed-over page is ended');
  assert.equal(held('T'), false);
  dispose();
});

test('a screen takeover that expires gives the screen back', async () => {
  const { request, resolved, dispose } = rig();
  request('s1', takeover({ surface: 'computer' }));
  await sleep(5);
  assert.throws(() => beginComputerOperation()(), /human-only approval is pending/);
  resolved('s1', 'T');
  await sleep(10);
  assert.doesNotThrow(() => beginComputerOperation()());
  dispose();
});

test('a login takeover starts and ends its sign-in window with the card', async () => {
  const { calls, request, resolved, dispose } = rig();
  request('l1', takeover({ purpose: 'login', url: 'https://login.example.com/' }));
  await sleep(5);
  assert.deepEqual(calls.find((call) => call[0] === 'login'), ['login', 'T', { id: 'l1', url: 'https://login.example.com/', tab: 'p1' }]);
  assert.equal(calls.some((call) => call[0] === 'open'), false, 'a login takeover never reveals the panel');
  calls.length = 0;
  resolved('l1', 'T', { kind: 'decided' });
  assert.deepEqual(calls, [['login', 'T', null], ['end', 'T', '']]);
  dispose();
});

test('a replaced takeover is not ended by the late resolution of the one it replaced', async () => {
  const { calls, request, resolved, held, dispose } = rig();
  request('a1', takeover());
  request('a2', takeover({ tab: 'p2' }));
  await sleep(5);
  calls.length = 0;
  resolved('a1', 'T');
  assert.deepEqual(calls, []);
  assert.equal(held('T'), true);
  resolved('a2', 'T');
  assert.equal(held('T'), false);
  assert.deepEqual(calls.at(-1), ['end', 'T', '']);
  dispose();
});

test('requests that are no takeover, name no session or were never seen are ignored', () => {
  const { calls, request, resolved, held, dispose } = rig();
  request('c1', { kind: 'secret', threadId: 'T', secret: {} });
  request('c2', { command: 'ls', threadId: 'T' });
  request('c3', { kind: 'takeover', takeover: { surface: 'browser' } });
  resolved('c1', 'T');
  resolved('unknown', 'T');
  assert.deepEqual(calls, []);
  assert.equal(held('T'), false);
  dispose();
});