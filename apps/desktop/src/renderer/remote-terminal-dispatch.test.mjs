import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_TERMINAL_RUN_EVENT } from '../shared/terminal-command.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

test("a relayed terminal reveal reaches the phone's listeners, authenticated and well-formed only", async () => {
  await withShim({}, async ({ ctx, dial }) => {
    const api = createRemoteApi(ctx);
    const leg = await dial({ ready: publishedCeilings(4096, 4096) });
    const runs = [];
    const off = api.onTerminalRunRequested((request) => runs.push(request));
    const reveal = {
      sessionId: 's1',
      terminalId: 'session-terminal:s1:2',
      tabs: [{ id: 'session-terminal:s1:2', tab: 2 }],
    };

    ctx.handleMessage({ event: REMOTE_TERMINAL_RUN_EVENT, payload: reveal }, false);
    assert.deepEqual(runs, [], 'clear relay data is ignored');

    await leg.deliver({ event: REMOTE_TERMINAL_RUN_EVENT, payload: reveal });
    await leg.deliver({ event: REMOTE_TERMINAL_RUN_EVENT, payload: { sessionId: '' } });
    await leg.deliver({ event: REMOTE_TERMINAL_RUN_EVENT, payload: 'nope' });
    // A malformed tab is dropped; the request-id ack of the desktop window never rides the relay.
    await leg.deliver({
      event: REMOTE_TERMINAL_RUN_EVENT,
      payload: { sessionId: 's2', requestId: 'ack', tabs: [{ id: 3, tab: 'x' }] },
    });
    // A path in a relayed tab is never adopted.
    await leg.deliver({
      event: REMOTE_TERMINAL_RUN_EVENT,
      payload: { ...reveal, tabs: [{ id: 'session-terminal:s1:2', tab: 2, cwd: '/secret' }] },
    });
    assert.deepEqual(runs, [reveal, { sessionId: 's2' }, reveal]);

    off();
    await leg.deliver({ event: REMOTE_TERMINAL_RUN_EVENT, payload: reveal });
    assert.equal(runs.length, 3);
  });
});
