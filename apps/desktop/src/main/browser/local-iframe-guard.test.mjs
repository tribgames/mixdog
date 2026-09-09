import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDispatch } from './input-dispatch.ts';

test('a local iframe lookup cannot send input after navigation, tab switch, dialog, or cancellation', async () => {
  for (const reason of ['navigation', 'tab switch', 'dialog', 'cancellation']) {
    let finishLookup;
    let lookupEntered;
    const entered = new Promise(resolve => { lookupEntered = resolve; });
    const lookup = new Promise(resolve => { finishLookup = resolve; });
    const controller = new AbortController();
    let rejected = false;
    const sent = [];
    const dispatch = createBrowserInputDispatch({
      frames: () => new Map([['child', { frameId: 'frame' }]]),
      frameOffset: async () => {
        lookupEntered();
        await lookup;
        return { x: 10, y: 20 };
      },
      cdp: {
        call: async () => ({ frameId: 'frame' }),
        guestDebugger: async () => ({}),
        sendCdpInput: async (_guest, _debugger, _method, _params, signal, session, guard) => {
          signal?.throwIfAborted();
          guard?.();
          sent.push(session);
          return 'completed';
        },
      },
    });
    const work = dispatch({ isOffscreen: () => true }, 'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 30.5, y: 40.5 }, controller.signal,
      () => { if (rejected) throw new Error(reason); });
    await entered;
    if (reason === 'cancellation') controller.abort(new Error(reason));
    else rejected = true;
    finishLookup();
    await assert.rejects(work, new RegExp(reason));
    assert.deepEqual(sent, [], 'neither the child nor root may receive a rejected edit');
  }
});
