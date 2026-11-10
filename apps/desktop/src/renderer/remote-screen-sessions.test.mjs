import assert from 'node:assert/strict';
import test from 'node:test';
import { VISUALIZE_PANELS_EVENT } from '../shared/visualize.ts';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state.ts';
import { setVisualizePanelOnScreen } from './visualize-store.ts';
import { withPhoneApi } from './test-support/phone-api-rig.mjs';

// Node's version (b6f10295a) read the `setScreenSessions` / `setVisualizePanels` frames off a fake socket. The phone reports its screen to the
// core as `ui/screenSessions/changed` through `ctx.phone.refreshScreen()` (remote-shim-api.ts); what that notification carries is replayed by
// apps/mobile/src/screen-reporter.test.ts. This file keeps what the page itself does: record the set it paints and ask the phone to report it.
const withScreen = (run) =>
  withPhoneApi({}, async (rig) => {
    const reports = [];
    rig.ctx.phone.refreshScreen = () => reports.push({ sessions: [...rig.ctx.lastScreenSessionIds], panels: [...rig.ctx.visualizePanelIds] });
    await run({ ...rig, reports });
  });

test('a remote page reports the sessions it paints apart from its delivery subscription', async () => {
  await withScreen(async ({ ctx, api, reports, calls }) => {
    api.reportScreenSessions(['a']);
    assert.deepEqual(ctx.lastScreenSessionIds, ['a'], 'kept for the next leg');
    assert.deepEqual(reports, [{ sessions: ['a'], panels: [] }], 'the phone is asked to report it');
    assert.deepEqual(calls, [], 'no Node-named call carries it any more');
  });
});

test('a remote page tells the core which visualize panels it has on screen, and each new leg again', async () => {
  await withScreen(async ({ ctx, reports }) => {
    setVisualizePanelOnScreen('a', true);
    assert.deepEqual(ctx.visualizePanelIds, ['a']);
    setVisualizePanelOnScreen('a', false);
    assert.deepEqual(ctx.visualizePanelIds, [], 'closed: no longer viewing');
    setVisualizePanelOnScreen('b', true);
    assert.deepEqual(ctx.visualizePanelIds, ['b']);
    const before = reports.length;
    // A new leg knows nothing until told.
    window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
    assert.equal(reports.length, before + 1);
    assert.deepEqual(reports.at(-1).panels, ['b']);
    setVisualizePanelOnScreen('b', false);
    // Store and shim meet on the one shared event name.
    window.dispatchEvent(new CustomEvent(VISUALIZE_PANELS_EVENT, { detail: ['c'] }));
    assert.deepEqual(ctx.visualizePanelIds, ['c']);
    assert.deepEqual(reports.at(-1).panels, ['c']);
    window.dispatchEvent(new CustomEvent(VISUALIZE_PANELS_EVENT, { detail: 'x' }));
    assert.deepEqual(ctx.visualizePanelIds, [], 'a malformed list is none');
  });
});
