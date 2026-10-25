import assert from 'node:assert/strict';
import test from 'node:test';
import { VISUALIZE_PANELS_EVENT } from '../shared/visualize.ts';
import { createRemoteApi } from './remote-shim-api.ts';
import { publishedCeilings, withShim } from './remote-shim-test-harness.mjs';

const nextCall = async (leg, method) => {
  let frame = await leg.nextPayload();
  while (frame.method !== method) frame = await leg.nextPayload();
  return frame;
};

test('a remote page reports the sessions it paints apart from its delivery subscription', async () => {
  await withShim({}, async ({ ctx, dial }) => {
    ctx.updaterListeners = new Set();
    ctx.settingsChangedListeners = new Set();
    const api = createRemoteApi(ctx);
    const leg = await dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    api.reportScreenSessions(['a']);
    assert.deepEqual((await nextCall(leg, 'setScreenSessions')).params, [['a']]);
    assert.deepEqual(ctx.lastScreenSessionIds, ['a'], 'kept for the next leg');
  });
});

test('a remote page tells the desktop which visualize panels it has on screen, and each new leg again', async () => {
  const { setVisualizePanelOnScreen } = await import('./visualize-store.ts');
  const { REMOTE_CONNECTION_READY_EVENT } = await import('./remote-connection-state.ts');
  await withShim({}, async ({ ctx, dial }) => {
    ctx.updaterListeners = new Set();
    ctx.settingsChangedListeners = new Set();
    // The page's window events reach the shim's listeners.
    const page = new EventTarget();
    window.addEventListener = page.addEventListener.bind(page);
    window.dispatchEvent = page.dispatchEvent.bind(page);
    createRemoteApi(ctx);
    const leg = await dial({ remoteParity: true, ready: publishedCeilings(4096, 4096) });
    setVisualizePanelOnScreen('a', true);
    assert.deepEqual((await nextCall(leg, 'setVisualizePanels')).params, [['a']]);
    setVisualizePanelOnScreen('a', false);
    assert.deepEqual((await nextCall(leg, 'setVisualizePanels')).params, [[]], 'closed: no longer viewing');
    setVisualizePanelOnScreen('b', true);
    assert.deepEqual((await nextCall(leg, 'setVisualizePanels')).params, [['b']]);
    // A new leg knows nothing until told.
    window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
    assert.deepEqual((await nextCall(leg, 'setVisualizePanels')).params, [['b']]);
    setVisualizePanelOnScreen('b', false);
    await nextCall(leg, 'setVisualizePanels');
    // Store and shim meet on the one shared event name.
    window.dispatchEvent(new CustomEvent(VISUALIZE_PANELS_EVENT, { detail: ['c'] }));
    assert.deepEqual((await nextCall(leg, 'setVisualizePanels')).params, [['c']]);
  });
});
