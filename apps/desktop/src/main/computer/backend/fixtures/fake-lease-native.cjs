'use strict';
// A user32 stand-in for the lease thread under test (foreground-lock-host.test.mjs).
// The shared buffer carries the test's instructions in and the thread's calls
// out, readable while the test's own event loop is blocked:
// counts [locks, unlocks, unlock calls, lock mode, unlock mode, clock mode] and
// times [last lock, last unlock] on the process-wide monotonic clock.
// Lock mode 1 refuses; unlock mode 1 answers false, 2 throws, 3 ends the
// thread; clock mode 1 throws.
module.exports = function fakeLeaseNative({ shared }) {
  const counts = new Int32Array(shared, 0, 8);
  const times = new Float64Array(shared, 32, 2);
  const now = () => Number(process.hrtime.bigint()) / 1e6;
  return {
    now() {
      if (Atomics.load(counts, 5) === 1) throw new Error('QueryPerformanceCounter failed');
      return now();
    },
    foregroundProcessId: () => 4242,
    lock() {
      if (Atomics.load(counts, 3) === 1) return { locked: false, error: 5 };
      times[0] = now();
      Atomics.add(counts, 0, 1);
      return { locked: true, error: 0 };
    },
    unlock() {
      Atomics.add(counts, 2, 1);
      const mode = Atomics.load(counts, 4);
      if (mode === 3) process.exit(3);
      if (mode === 2) throw new Error('LockSetForegroundWindow failed');
      if (mode === 1) return { unlocked: false, error: 5 };
      times[1] = now();
      Atomics.add(counts, 1, 1);
      return { unlocked: true, error: 0 };
    },
  };
};
