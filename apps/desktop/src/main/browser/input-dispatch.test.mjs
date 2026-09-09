import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDispatch } from './input-dispatch.ts';

test('offscreen child-frame input uses child coordinates and rechecks local ownership at dispatch', async () => {
  const sent = [];
  let current = true;
  const dispatch = createBrowserInputDispatch({
    documentId: () => 'document',
    frames: () => new Map([['child-session', { frameId: 'child-frame' }]]),
    frameOffset: async () => ({ x: 100, y: 200 }),
    cdp: {
      call: async (_guest, _method, params) => {
        assert.equal(params.x, 120);
        assert.equal(params.y, 230);
        return { frameId: 'child-frame' };
      },
      guestDebugger: async () => ({}),
      sendCdpInput: async (_guest, _cdp, method, params, _signal, session, guard) => {
        guard?.();
        sent.push({ method, params, session });
        return 'completed';
      },
    },
  });
  const input = { type: 'mousePressed', x: 120.25, y: 230.25 };
  const guard = () => { if (!current) throw new Error('document changed'); };
  await dispatch({ isOffscreen: () => true }, 'Input.dispatchMouseEvent', input, undefined, guard);
  assert.deepEqual(sent, [{
    method: 'Input.dispatchMouseEvent', params: { ...input, x: 20.25, y: 30.25 }, session: 'child-session',
  }]);
  current = false;
  await assert.rejects(dispatch({ isOffscreen: () => true }, 'Input.dispatchMouseEvent', input, undefined, guard),
    /document changed/);
  assert.equal(sent.length, 1);
});
