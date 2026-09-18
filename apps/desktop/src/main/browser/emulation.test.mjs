import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserEmulation } from './emulation.ts';

function recordingEmulation() {
  const calls = [];
  const emulation = createBrowserEmulation({
    cdp: {
      call: async (_guest, method, params) => {
        calls.push({ method, params });
        return {};
      },
    },
    invalidateInteractionState() {},
    snapshotResult: async () => ({ text: 'fixture snapshot' }),
  });
  return { calls, emulation, guest: { getUserAgent: () => 'Fixture/1.0' } };
}

test('an emulated locale is also the language the page asks servers for', async () => {
  const withLocale = recordingEmulation();
  await withLocale.emulation.configureEmulation(withLocale.guest, { locale: 'ko-KR' });
  assert.deepEqual(
    withLocale.calls.map((call) => call.method),
    ['Emulation.setLocaleOverride', 'Network.setUserAgentOverride']
  );
  assert.deepEqual(withLocale.calls[1].params, { userAgent: 'Fixture/1.0', acceptLanguage: 'ko-KR' });

  // A caller-supplied user agent already carries the locale in its own call.
  const withAgent = recordingEmulation();
  await withAgent.emulation.configureEmulation(withAgent.guest, { locale: 'ko-KR', userAgent: 'Custom/2.0' });
  const agentCalls = withAgent.calls.filter((call) => call.method === 'Network.setUserAgentOverride');
  assert.equal(agentCalls.length, 1);
  assert.deepEqual(agentCalls[0].params, { userAgent: 'Custom/2.0', acceptLanguage: 'ko-KR' });

  // Clearing the locale restores the browser's own language negotiation.
  const cleared = recordingEmulation();
  await cleared.emulation.configureEmulation(cleared.guest, { locale: '' });
  assert.deepEqual(cleared.calls[1].params, { userAgent: 'Fixture/1.0' });
});

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
    /requires width and height together/
  );
  await assert.rejects(
    emulation.applyEmulation(guest, {
      width: 390,
      height: 844,
      networkProfile: 'satellite',
    }),
    /networkProfile must be none, offline, slow3g, or fast3g/
  );
  await assert.rejects(emulation.applyEmulation(guest, { latitude: 37.5 }), /latitude and longitude together/);
  await assert.rejects(
    emulation.applyEmulation(guest, { reset: true, timezone: 'Not/A_Real_Zone' }),
    /timezone must be a valid IANA timezone/
  );
  assert.equal(cdpCalls, 0);
});
