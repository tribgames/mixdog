import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCachedDesktopStatus,
  readDesktopStatus,
  recordDesktopStatus,
  subscribeDesktopStatus,
  writeDesktopStatus,
} from './desktop-status-cache.ts';

test('a write answer that arrives after a read sent later never replaces the read', async () => {
  const write = Promise.withResolvers();
  let stored = { browserAutoSignIn: true, saveChatLogins: true };
  const api = { readSettings: async () => stored, updateSetting: () => write.promise };
  await readDesktopStatus(api, 'settings');

  const writing = writeDesktopStatus(api, 'settings', () => api.updateSetting('browserAutoSignIn', false), {
    ...stored,
    browserAutoSignIn: false,
  });
  // Another writer turned chat saving off; the announcement's read answers first.
  stored = { browserAutoSignIn: false, saveChatLogins: false };
  await readDesktopStatus(api, 'settings');
  // The auto-sign-in write answers last, with the snapshot it produced before that change.
  write.resolve({ browserAutoSignIn: false, saveChatLogins: true });
  assert.deepEqual(await writing, { browserAutoSignIn: false, saveChatLogins: true }, 'the caller still gets its answer');
  assert.equal(getCachedDesktopStatus(api, 'settings').saveChatLogins, false);
});

/** A host whose confirmed settings are `start`; `write()` sends one settings write the test settles. */
async function settingsHost(start) {
  let stored = start;
  const api = { readSettings: async () => stored };
  await readDesktopStatus(api, 'settings');
  return {
    api,
    store: (next) => {
      stored = next;
    },
    read: () => readDesktopStatus(api, 'settings'),
    write: (change) => {
      const answer = Promise.withResolvers();
      const writing = writeDesktopStatus(api, 'settings', () => answer.promise, change);
      return {
        succeed: async (value) => {
          answer.resolve(value);
          await writing;
        },
        fail: async () => {
          answer.reject(new Error('disk'));
          await assert.rejects(writing);
        },
      };
    },
    shown: () => getCachedDesktopStatus(api, 'settings'),
  };
}

test('two overlapping writes that both fail leave the confirmed value: no failed change comes back', async () => {
  const host = await settingsHost({ saveChatLogins: false, keepAwake: true });
  const first = host.write({ saveChatLogins: true });
  const second = host.write({ keepAwake: false });
  assert.deepEqual(host.shown(), { saveChatLogins: true, keepAwake: false }, 'both choices show while in flight');
  await first.fail();
  assert.deepEqual(host.shown(), { saveChatLogins: false, keepAwake: false });
  await second.fail();
  assert.deepEqual(host.shown(), { saveChatLogins: false, keepAwake: true });
});

test('fail then succeed: the success answer is what shows', async () => {
  const host = await settingsHost({ saveChatLogins: false, keepAwake: true });
  const first = host.write({ saveChatLogins: true });
  const second = host.write({ keepAwake: false });
  await first.fail();
  await second.succeed({ saveChatLogins: false, keepAwake: false });
  assert.deepEqual(host.shown(), { saveChatLogins: false, keepAwake: false });
});

test('succeed then fail: the first answer stays confirmed, the failed change leaves', async () => {
  const host = await settingsHost({ saveChatLogins: false, keepAwake: true });
  const first = host.write({ saveChatLogins: true });
  const second = host.write({ keepAwake: false });
  await first.succeed({ saveChatLogins: true, keepAwake: true });
  assert.deepEqual(host.shown(), { saveChatLogins: true, keepAwake: false }, 'the second choice still shows on top');
  await second.fail();
  assert.deepEqual(host.shown(), { saveChatLogins: true, keepAwake: true });
});

test('a read answering between the writes is confirmed under the pending changes and outranks older answers', async () => {
  const host = await settingsHost({ saveChatLogins: false, keepAwake: true, runInBackground: true });
  const first = host.write({ saveChatLogins: true });
  host.store({ saveChatLogins: false, keepAwake: true, runInBackground: false });
  await host.read();
  assert.deepEqual(host.shown(), { saveChatLogins: true, keepAwake: true, runInBackground: false });
  // Sent before that read: its answer is older and is not confirmed.
  await first.succeed({ saveChatLogins: true, keepAwake: true, runInBackground: true });
  assert.deepEqual(host.shown(), { saveChatLogins: false, keepAwake: true, runInBackground: false });
});

test('a read sent before a write and answering during it is confirmed, and the choice keeps showing on top', async () => {
  const slow = Promise.withResolvers();
  const host = await settingsHost({ keepAwake: true });
  host.api.readSettings = () => slow.promise;
  const reading = host.read();
  const write = host.write({ keepAwake: false });
  slow.resolve({ keepAwake: true, runInBackground: false });
  assert.deepEqual(await reading, { keepAwake: false, runInBackground: false });
  await write.succeed({ keepAwake: false, runInBackground: false });
  assert.deepEqual(host.shown(), { keepAwake: false, runInBackground: false });
});

test('writes to different fields of the settings object each show and leave on their own', async () => {
  const host = await settingsHost({ keepAwake: true, runInBackground: true });
  const seen = [];
  const stop = subscribeDesktopStatus((key, value, _previous, from) => {
    if (from === host.api && key === 'settings') seen.push(value);
  });
  try {
    const first = host.write({ keepAwake: false });
    const second = host.write({ runInBackground: false });
    // The first answer predates the second write; the second change stays on top of it.
    await first.succeed({ keepAwake: false, runInBackground: true });
    assert.deepEqual(host.shown(), { keepAwake: false, runInBackground: false });
    await second.succeed({ keepAwake: false, runInBackground: false });
    assert.deepEqual(host.shown(), { keepAwake: false, runInBackground: false });
    assert.deepEqual(seen.at(-1), { keepAwake: false, runInBackground: false });
  } finally {
    stop();
  }
});

test('a whole-value change over an unknown value shows while in flight and leaves it unknown when it fails', async () => {
  const api = {};
  const answer = Promise.withResolvers();
  const writing = writeDesktopStatus(api, 'quotaAutoResume', () => answer.promise, false);
  assert.equal(getCachedDesktopStatus(api, 'quotaAutoResume'), false);
  answer.reject(new Error('disk'));
  await assert.rejects(writing);
  assert.equal(getCachedDesktopStatus(api, 'quotaAutoResume'), undefined);
});

test('a quota save outranks section reads started before its acknowledgement', async () => {
  let section = true;
  const api = { getQuotaAutoResume: async () => section };
  const answer = Promise.withResolvers();
  await readDesktopStatus(api, 'quotaAutoResume');
  const writing = writeDesktopStatus(api, 'quotaAutoResume', () => answer.promise, false);
  await readDesktopStatus(api, 'quotaAutoResume'); // The renderer still has the pre-write section.
  section = false;
  answer.resolve(false);
  await writing;
  assert.equal(getCachedDesktopStatus(api, 'quotaAutoResume'), false);

  // Failures roll back to the acknowledged value, not to the stale section read.
  const rejected = writeDesktopStatus(api, 'quotaAutoResume', () => Promise.reject(new Error('disk')), true);
  await assert.rejects(rejected, /disk/);
  assert.equal(getCachedDesktopStatus(api, 'quotaAutoResume'), false);

  // A subsequent host change can still update the toggle.
  section = true;
  await readDesktopStatus(api, 'quotaAutoResume');
  assert.equal(getCachedDesktopStatus(api, 'quotaAutoResume'), true);
});

test('an install result outranks a status read sent before it finished', async () => {
  const slow = Promise.withResolvers();
  const api = { libreOfficeStatus: () => slow.promise };
  const reading = readDesktopStatus(api, 'libreOffice');
  recordDesktopStatus(api, 'libreOffice', { installed: true });
  slow.resolve({ installed: false });
  assert.deepEqual(await reading, { installed: true });
  assert.deepEqual(getCachedDesktopStatus(api, 'libreOffice'), { installed: true });
});
