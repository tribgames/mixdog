import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRemoteDrive } from './remote-drive.ts';

function fixture({ pane = { size: { width: 1200, height: 800 }, zoom: 0.75 } } = {}) {
  const log = [];
  const makeGuest = (id) => ({
    id,
    url: 'https://a.test/',
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return this.url;
    },
    zoom: 1.25,
    getZoomFactor() {
      return this.zoom;
    },
    reload() {
      log.push(['reload', id]);
    },
  });
  const drive = createBrowserRemoteDrive({
    setGeometry: (guest, size, zoom) => log.push(['geometry', guest.id, size, zoom]),
    paneGeometry: () => pane,
    emulate: async (guest, config) => {
      log.push(['emulate', guest.id, config]);
    },
    fitMetrics: async (guest, viewport) => {
      log.push(['fit', guest.id, viewport]);
    },
    unfitMetrics: async (guest) => {
      log.push(['unfit', guest.id]);
    },
    drivingChanged: (sessionId, driving) => log.push(['driving', sessionId, driving]),
  });
  return { drive, log, makeGuest, pane };
}

const PHONE = { width: 390, height: 780, deviceScaleFactor: 3 };
const IPHONE_PRESET = {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  touch: true,
  userAgent: 'iPhone UA',
};

test('a fit lays the phone metrics over the page only: no preset emulation, no reload', async () => {
  const { drive, log, makeGuest } = fixture();
  const guest = makeGuest(1);
  await drive.apply('s', guest, PHONE);
  assert.deepEqual(log, [
    ['driving', 's', true],
    ['geometry', 1, { width: 390, height: 780 }, 1],
    ['fit', 1, PHONE],
  ]);
  assert.equal(drive.driven(guest), true);
  // Re-applied for a new document: no second announcement, still no reload.
  log.length = 0;
  await drive.apply('s', guest, PHONE);
  assert.deepEqual(
    log.map(([kind]) => kind),
    ['geometry', 'fit']
  );

  // The page's zoom before the fit comes back, and its metrics, nothing else.
  log.length = 0;
  await drive.restore(guest);
  assert.deepEqual(log, [
    ['geometry', 1, { width: 1200, height: 800 }, 1.25],
    ['unfit', 1],
    ['driving', 's', false],
  ]);
  assert.equal(drive.driven(guest), false);
  log.length = 0;
  await drive.restore(guest);
  assert.deepEqual(log, [], 'restoring twice changes nothing');
});

test('a pane preset or zoom chosen during the fit wins when it ends', async () => {
  const { drive, log, makeGuest, pane } = fixture();
  const guest = makeGuest(1);
  await drive.configurePane(guest, IPHONE_PRESET);
  assert.deepEqual(log, [['emulate', 1, IPHONE_PRESET]]);
  await drive.apply('s', guest, PHONE);
  log.length = 0;
  const desktop = { width: null, height: null, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null };
  await drive.configurePane(guest, desktop);
  pane.zoom = 0.5;
  assert.deepEqual(log, [], 'the pane choice waits while the phone drives');

  await drive.restore(guest);
  assert.deepEqual(log, [
    ['geometry', 1, { width: 1200, height: 800 }, 0.5],
    ['unfit', 1],
    ['emulate', 1, desktop],
    ['driving', 's', false],
  ]);
  assert.equal(log.filter(([kind]) => kind === 'reload').length, 0);
});

test('a page without pane choices gets its own zoom back; a destroyed page only ends the drive', async () => {
  const { drive, log, makeGuest } = fixture({ pane: {} });
  const guest = makeGuest(1);
  await drive.apply('s', guest, PHONE);
  log.length = 0;
  await drive.restore(guest);
  assert.deepEqual(log, [
    ['geometry', 1, undefined, 1.25],
    ['unfit', 1],
    ['driving', 's', false],
  ]);

  const gone = makeGuest(2);
  await drive.apply('s', gone, PHONE);
  gone.destroyed = true;
  log.length = 0;
  await drive.restore(gone);
  assert.deepEqual(log, [['driving', 's', false]]);
});
