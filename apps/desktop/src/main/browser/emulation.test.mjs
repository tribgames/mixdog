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
  assert.deepEqual(last(), { userAgent: 'Fixture/1.0', acceptLanguage: 'ko-KR' });
  assert.doesNotMatch(JSON.stringify(f.calls), /Google Chrome/);
  await configure({ locale: '' });
  assert.deepEqual(last(), { userAgent: '' }, 'the session sends its own string and languages again');
  await configure({ reset: true });
  assert.deepEqual(last(), { userAgent: '' });
});
