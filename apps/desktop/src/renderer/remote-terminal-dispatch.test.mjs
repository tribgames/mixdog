import assert from 'node:assert/strict';
import test from 'node:test';
import { adapterWorld } from './phone-adapter-world.mjs';

// The agent's reveal reaches the phone as the app feed's `ui/openRequested{kind:'terminal'}`; the phone hands its page what Node's relay
// push carried (remoteTerminalRun, then the phone's reader).
test("a terminal reveal reaches the phone's listeners, well-formed only, once per request", async () => {
  const { api, push, settle } = await adapterWorld();
  const runs = [];
  const off = api.onTerminalRunRequested((request) => runs.push(request));
  const reveal = { sessionId: 's1', terminalId: 'session-terminal:s1:2', tabs: [{ id: 'session-terminal:s1:2', tab: 2 }] };
  const open = (params) => push('ui/openRequested', { kind: 'terminal', ...params });

  await open(reveal);
  await open({ sessionId: '' });
  await push('ui/openRequested', 'nope');
  // A malformed tab is dropped; the desktop window's request-id ack never reaches the page.
  await open({ sessionId: 's2', requestId: 'ack', tabs: [{ id: 3, tab: 'x' }] });
  // A path in a tab is never adopted.
  await open({ ...reveal, tabs: [{ id: 'session-terminal:s1:2', tab: 2, cwd: '/secret' }] });
  // The core delivers an app-feed event again after a reconnect: a request id is handed over once.
  await open({ sessionId: 's2', requestId: 'ack', tabs: [{ id: 3, tab: 'x' }] });
  // Two reveals of the same terminal are two pushes in Node (a UUID each): different ids both arrive.
  await open({ ...reveal, requestId: 'one' });
  await open({ ...reveal, requestId: 'two' });
  await settle();
  assert.deepEqual(runs, [reveal, { sessionId: 's2' }, reveal, reveal, reveal]);

  off();
  await open(reveal);
  await settle();
  assert.equal(runs.length, 5);
});
