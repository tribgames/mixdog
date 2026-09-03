import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserEmulation } from './emulation.ts';

test('emulation validates compound input before attaching CDP or partially resetting the page', async () => {
  let cdpCalls = 0;
  const emulation = createBrowserEmulation({
    cdp: {
      call: async () => {
        cdpCalls += 1;
        return {};
      },
    },
    invalidateInteractionState() {},
    snapshotResult: async () => ({ text: 'fixture snapshot' }),
  });
  const guest = {};
  await assert.rejects(
    emulation.applyEmulation(guest, { reset: true, width: 390 }),
    /requires width and height together/,
  );
  await assert.rejects(
    emulation.applyEmulation(guest, {
      width: 390,
      height: 844,
      networkProfile: 'satellite',
    }),
    /networkProfile must be none, offline, slow3g, or fast3g/,
  );
  await assert.rejects(
    emulation.applyEmulation(guest, { latitude: 37.5 }),
    /latitude and longitude together/,
  );
  await assert.rejects(
    emulation.applyEmulation(guest, { reset: true, timezone: 'Not/A_Real_Zone' }),
    /timezone must be a valid IANA timezone/,
  );
  assert.equal(cdpCalls, 0);
});
