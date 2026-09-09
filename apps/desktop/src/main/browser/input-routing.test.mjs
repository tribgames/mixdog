import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDispatch } from './input-dispatch.ts';

function fixture() {
  let documentId = 'first';
  let hit = { frameId: 'child' };
  const frames = new Map([['session', { frameId: 'child' }]]);
  const sent = [];
  let lookups = 0;
  const guest = { isOffscreen: () => true };
  const dispatch = createBrowserInputDispatch({
    documentId: () => documentId,
    frames: () => frames,
    frameOffset: async () => ({ x: 100, y: 200 }),
    cdp: {
      call: async () => { lookups++; if (hit instanceof Error) throw hit; return hit; },
      guestDebugger: async () => ({}),
      sendCdpInput: async (_guest, _cdp, _method, input, _signal, session, guard) => {
        guard();
        sent.push({ ...input, session });
        return 'completed';
      },
    },
  });
  const send = (type, x = 120, y = 230, buttons = type === 'mouseReleased' ? 0 : 1, signal) =>
    dispatch(guest, 'Input.dispatchMouseEvent', { type, x, y, buttons, button: 'left' }, signal);
  return { send, sent, frames, lookups: () => lookups,
    hit: value => { hit = value; }, navigate: () => { documentId = 'second'; } };
}

test('a pressed child-frame gesture retains its renderer through movement and release outside it', async () => {
  const f = fixture();
  await f.send('mousePressed');
  f.hit({ frameId: 'parent' });
  await f.send('mouseMoved', 80, 190);
  await f.send('mouseReleased', 500, 500);
  assert.deepEqual(f.sent.map(({ session, x, y }) => ({ session, x, y })), [
    { session: 'session', x: 20, y: 30 },
    { session: 'session', x: -20, y: -10 },
    { session: 'session', x: 400, y: 300 },
  ]);
  assert.equal(f.lookups(), 1);
  await f.send('mouseMoved', 500, 500, 0);
  assert.equal(f.sent.at(-1).session, undefined);
  assert.equal(f.lookups(), 2);
});

test('node-less compositor input reaches the root once, without retrying a dispatched edit', async () => {
  const f = fixture();
  f.hit(new Error("Protocol error (DOM.getNodeForLocation): No node found at given location"));
  await f.send('mousePressed', 799, 300);
  await f.send('mouseMoved', 799, 350);
  await f.send('mouseReleased', 799, 350);
  assert.equal(f.lookups(), 1);
  assert.deepEqual(f.sent.map(({ session, x }) => ({ session, x })), [
    { session: undefined, x: 799 }, { session: undefined, x: 799 }, { session: undefined, x: 799 },
  ]);
});

test('lookup errors and cancellation remain failures and never dispatch input', async () => {
  for (const message of ['Target closed', 'Access denied', 'request timed out']) {
    const f = fixture();
    f.hit(new Error(message));
    await assert.rejects(f.send('mousePressed'), { message });
    assert.deepEqual(f.sent, []);
  }
  const f = fixture();
  f.hit(new Error('No node found at given location'));
  await assert.rejects(f.send('mousePressed', 10, 10, 1, AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  assert.deepEqual(f.sent, []);
});

test('a changed document or detached iframe never redirects the rest of a gesture to another page', async () => {
  for (const change of [f => f.navigate(), f => f.frames.clear()]) {
    const f = fixture();
    await f.send('mousePressed');
    change(f);
    await assert.rejects(f.send('mouseReleased'), /page changed/);
    assert.equal(f.sent.length, 1);
  }
});
