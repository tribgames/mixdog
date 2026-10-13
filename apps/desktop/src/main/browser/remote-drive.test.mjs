import assert from 'node:assert/strict';
import test from 'node:test';

import { MOBILE_CHROME_USER_AGENT } from '../../shared/remote-browser.ts';
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
    drivingChanged: (sessionId, driving) => log.push(['driving', sessionId, driving]),
  });
  return { drive, log, makeGuest };
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

test('a driving phone sizes the page and emulates a mobile device; a new user agent reloads once', async () => {
  const { drive, log, makeGuest } = fixture();
  const guest = makeGuest(1);
  await drive.apply('s', guest, PHONE);
  assert.deepEqual(log, [
    ['driving', 's', true],
    ['geometry', 1, { width: 390, height: 780 }, 1],
    [
      'emulate',
      1,
      {
        width: 390,
        height: 780,
        deviceScaleFactor: 3,
        mobile: true,
        touch: true,
        userAgent: MOBILE_CHROME_USER_AGENT,
      },
    ],
    ['reload', 1],
  ]);
  assert.equal(drive.driven(guest), true);
  // Re-applied for a new document: no second announcement, no reload loop.
  log.length = 0;
  await drive.apply('s', guest, PHONE);
  assert.deepEqual(
    log.map(([kind]) => kind),
    ['geometry', 'emulate']
  );
});

test('the pane preset is held while driven and restored afterwards, reloading only for a changed agent', async () => {
  const { drive, log, makeGuest } = fixture();
  const guest = makeGuest(1);
  await drive.configurePane(guest, IPHONE_PRESET);
  assert.deepEqual(log, [['emulate', 1, IPHONE_PRESET]]);
  await drive.apply('s', guest, PHONE);
  log.length = 0;
  const desktop = { width: null, height: null, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null };
  await drive.configurePane(guest, desktop);
  assert.deepEqual(log, [], 'the pane choice waits while the phone drives');

  await drive.restore(guest);
  assert.deepEqual(log, [
    ['geometry', 1, { width: 1200, height: 800 }, 0.75],
    ['emulate', 1, desktop],
    ['reload', 1],
    ['driving', 's', false],
  ]);
  assert.equal(drive.driven(guest), false);
  log.length = 0;
  await drive.restore(guest);
  assert.deepEqual(log, [], 'restoring twice changes nothing');

  // A pane already on the same mobile agent keeps its page loaded both ways.
  const other = makeGuest(2);
  await drive.configurePane(other, { ...IPHONE_PRESET, userAgent: MOBILE_CHROME_USER_AGENT });
  await drive.apply('s', other, PHONE);
  await drive.restore(other);
  assert.equal(log.filter(([kind]) => kind === 'reload').length, 0);
});

test('a page without pane choices returns to no emulation; a destroyed page only ends the drive', async () => {
  const { drive, log, makeGuest } = fixture({ pane: {} });
  const guest = makeGuest(1);
  guest.url = 'about:blank';
  await drive.apply('s', guest, PHONE);
  assert.equal(log.filter(([kind]) => kind === 'reload').length, 0, 'a blank page has nothing to reload');
  log.length = 0;
  await drive.restore(guest);
  assert.deepEqual(log, [
    ['geometry', 1, undefined, undefined],
    ['emulate', 1, { width: null, height: null, deviceScaleFactor: 1, mobile: false, touch: false, userAgent: null }],
    ['driving', 's', false],
  ]);

  const gone = makeGuest(2);
  await drive.apply('s', gone, PHONE);
  gone.destroyed = true;
  log.length = 0;
  await drive.restore(gone);
  assert.deepEqual(log, [['driving', 's', false]]);
});
