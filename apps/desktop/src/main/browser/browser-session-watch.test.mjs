import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { watchBrowserSessionCookies } from './browser-session-store.ts';

test('a sign-in is written within the debounce: session cookies sealed, persistent ones flushed', async () => {
  const cookies = new EventEmitter();
  let saves = 0;
  let flushes = 0;
  const stop = watchBrowserSessionCookies(
    cookies,
    { save: async () => ++saves },
    { flushStore: async () => void flushes++ },
    10
  );
  const wait = () => new Promise((resolve) => setTimeout(resolve, 30));
  cookies.emit('changed', {}, { name: 'remember', session: false }, 'explicit', false);
  await wait();
  assert.deepEqual([saves, flushes], [0, 1], 'a persistent cookie needs only the profile flush');
  // A burst (a login sets several cookies) is one write.
  cookies.emit('changed', {}, { name: 'sid', session: true }, 'explicit', false);
  cookies.emit('changed', {}, { name: 'csrf', session: true }, 'explicit', false);
  await wait();
  assert.deepEqual([saves, flushes], [1, 2]);
  stop();
  cookies.emit('changed', {}, { name: 'sid', session: true }, 'explicit', true);
  await wait();
  assert.deepEqual([saves, flushes], [1, 2], 'stopped with the host');
  assert.equal(cookies.listenerCount('changed'), 0);
});
