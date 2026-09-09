import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserInputDriver } from './input.ts';
import { timeBrowserCommand, browserFailureTiming } from './timing.ts';
import { createBrowserCommandQueue } from './command-queue.ts';

test('click timings follow dispatched events and stop at a dialog without replay', async () => {
  for (const dialog of [false, true]) {
    const events = [];
    const input = createBrowserInputDriver(async (_guest, _method, params) => {
      events.push(params.type);
      return dialog && params.type === 'mousePressed' ? 'dialog' : 'completed';
    });
    const result = await timeBrowserCommand(0, async () => {
      await input.clickAt({}, 10, 20);
      return { text: 'done' };
    });
    const expected = dialog ? ['mouseMoved', 'mousePressed'] : ['mouseMoved', 'mousePressed', 'mouseReleased'];
    assert.deepEqual(events, expected);
    assert.deepEqual(Object.keys(result.timing.mouseEvents), expected);
    for (const event of Object.values(result.timing.mouseEvents)) {
      assert.equal(event.count, 1);
      assert.ok(event.totalMs >= 0);
    }
  }
});

test('the command ceiling returns timing even while cancelled work is still pending', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const error = new Error('command timed out');
  const queue = createBrowserCommandQueue({
    chains: new Map(), pendingReads: new Map(), backgroundEntryByPageId: () => null,
    run: async () => { await pending; return { text: 'late' }; },
    bounded: async (_promise, _ms, _label, _signal, onTimeout) => { onTimeout(); throw error; },
    readOnlyActions: new Set(), commandTimeoutMs: 1,
  });
  await assert.rejects(queue.executeSerialized({ action: 'click' }), (caught) => caught === error);
  const timing = browserFailureTiming(error);
  assert.ok(timing && Number.isFinite(timing.commandMs));
  const before = JSON.stringify(timing);
  finish();
  await pending;
  assert.equal(JSON.stringify(timing), before);
});
