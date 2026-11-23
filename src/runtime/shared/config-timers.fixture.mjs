import assert from 'node:assert/strict';

/** The timers `config` (config.mjs) arms from now on (the test's own are not
 *  counted): `delays`, and `fired()`, which resolves once the next of them has
 *  run, with the listener pass it started finished, and rejects after 5 s.
 *  Restored when `t` ends. */
export function configTimers(t, config) {
  const delays = [];
  let waiters = [];
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => {
    if (!/[\\/]config\.mjs:/.test(new Error().stack)) return real(fn, ms, ...rest);
    delays.push(ms);
    return real(
      (...args) => {
        fn(...args);
        const done = waiters;
        waiters = [];
        for (const resolve of done) resolve();
      },
      ms,
      ...rest
    );
  });
  t.mock.method(globalThis, 'setInterval', () => assert.fail('nothing polls'));
  const fired = () =>
    new Promise((resolve, reject) => {
      const timer = real(() => reject(new Error('no config timer ran')), 5000);
      waiters.push(() =>
        config.configChangePassSettled().then(() => {
          clearTimeout(timer);
          resolve();
        }, reject)
      );
    });
  return { delays, fired };
}
