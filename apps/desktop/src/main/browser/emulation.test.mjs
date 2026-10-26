import assert from 'node:assert/strict';
import test from 'node:test';

import { rememberBrowserIdentity } from './browser-identity.ts';
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

test('a phone fit changes only the device metrics and gives back exactly the ones before it', async () => {
  const { calls, emulation, guest } = recordingEmulation();
  // The agent's own emulation: a device size, a locale, a position and headers.
  await emulation.configureEmulation(guest, { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: true });
  await emulation.configureEmulation(guest, { locale: 'ko-KR' });
  await emulation.configureEmulation(guest, { latitude: 37.5, longitude: 127 });
  await emulation.configureEmulation(guest, { headers: { 'X-Agent': '1' } });
  const prior = calls.find((call) => call.method === 'Emulation.setDeviceMetricsOverride').params;

  calls.length = 0;
  await emulation.fitMetrics(guest, { width: 411, height: 782, deviceScaleFactor: 2.625 });
  assert.deepEqual(
    calls.map((call) => call.method),
    ['Emulation.setDeviceMetricsOverride'],
    'no reset and no other domain is touched'
  );
  assert.deepEqual(
    [calls[0].params.width, calls[0].params.height, calls[0].params.deviceScaleFactor, calls[0].params.mobile],
    [411, 782, 2.625, true],
    'the guest keeps its mobile flag'
  );

  calls.length = 0;
  await emulation.unfitMetrics(guest);
  assert.deepEqual(calls, [{ method: 'Emulation.setDeviceMetricsOverride', params: prior }], 'the exact metrics before');

  // The agent's overrides are still in force: a later agent change to one of
  // their groups keeps its siblings, which only holds while nothing reset them.
  calls.length = 0;
  await emulation.configureEmulation(guest, { userAgent: 'Agent/3.0' });
  assert.deepEqual(calls.find((call) => call.method === 'Network.setUserAgentOverride').params, {
    userAgent: 'Agent/3.0',
    acceptLanguage: 'ko-KR',
  });
  assert.ok(!calls.some((call) => /clear/.test(call.method)));

  // No metrics before the fit: they are cleared again afterwards. A second
  // unfit changes nothing.
  const bare = recordingEmulation();
  await bare.emulation.fitMetrics(bare.guest, { width: 411, height: 782, deviceScaleFactor: 2.625 });
  bare.calls.length = 0;
  await bare.emulation.unfitMetrics(bare.guest);
  await bare.emulation.unfitMetrics(bare.guest);
  assert.deepEqual(
    bare.calls.map((call) => call.method),
    ['Emulation.clearDeviceMetricsOverride']
  );
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

test('partial emulation preserves group siblings, isolates guests and forgets overrides on reset', async () => {
  const f = recordingEmulation();
  const configure = (command) => f.emulation.configureEmulation(f.guest, command);
  const last = (method) => f.calls.filter((call) => call.method === method).at(-1).params;
  await configure({ userAgent: 'Custom/2.0', locale: 'fr-FR', colorScheme: 'light', reducedMotion: true });
  await configure({ locale: 'en-GB' });
  assert.deepEqual(last('Network.setUserAgentOverride'), { userAgent: 'Custom/2.0', acceptLanguage: 'en-GB' });
  await configure({ userAgent: 'Next/3.0' });
  assert.deepEqual(last('Network.setUserAgentOverride'), { userAgent: 'Next/3.0', acceptLanguage: 'en-GB' });
  await configure({ reducedMotion: false });
  assert.deepEqual(last('Emulation.setEmulatedMedia').features, [
    { name: 'prefers-color-scheme', value: 'light' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await configure({ colorScheme: 'dark' });
  assert.deepEqual(last('Emulation.setEmulatedMedia').features, [
    { name: 'prefers-color-scheme', value: 'dark' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ]);
  await f.emulation.configureEmulation({ getUserAgent: () => 'Other/1.0' }, { locale: 'ko-KR' });
  assert.deepEqual(last('Network.setUserAgentOverride'), { userAgent: 'Other/1.0', acceptLanguage: 'ko-KR' });
  await configure({ reset: true });
  await configure({ locale: 'ko-KR', reducedMotion: true });
  assert.deepEqual(last('Network.setUserAgentOverride'), { userAgent: 'Fixture/1.0', acceptLanguage: 'ko-KR' });
  assert.deepEqual(last('Emulation.setEmulatedMedia').features, [{ name: 'prefers-reduced-motion', value: 'reduce' }]);
});

// Last in this file: the partition's identity is process-wide once remembered.
test("emulation leaves the partition's own agent string to the session and still applies a custom agent and locale", async () => {
  rememberBrowserIdentity({ userAgent: 'Fixture/1.0' });
  const custom = recordingEmulation();
  await custom.emulation.configureEmulation(custom.guest, { userAgent: 'Custom/2.0', locale: 'fr-FR' });
  assert.deepEqual(custom.calls.filter((call) => call.method === 'Network.setUserAgentOverride').at(-1).params, {
    userAgent: 'Custom/2.0',
    acceptLanguage: 'fr-FR',
  });
  const f = recordingEmulation();
  const configure = (command) => f.emulation.configureEmulation(f.guest, command);
  const last = () => f.calls.filter((call) => call.method === 'Network.setUserAgentOverride').at(-1).params;
  await configure({ locale: 'ko-KR' });
  // Locale emulated before any engine fact is known: the partition's own
  // string is not restated (that would drop the client-hint brands, with no
  // later re-send); only the language is overridden.
  assert.deepEqual(last(), { userAgent: '', acceptLanguage: 'ko-KR' });
  assert.doesNotMatch(JSON.stringify(f.calls), /Google Chrome/);
  await configure({ locale: '' });
  assert.deepEqual(last(), { userAgent: '' }, 'the session sends its own string and languages again');
  await configure({ reset: true });
  assert.deepEqual(last(), { userAgent: '' });
});
