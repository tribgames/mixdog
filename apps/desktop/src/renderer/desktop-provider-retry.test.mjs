import assert from 'node:assert/strict';
import test from 'node:test';

const timers = new Map();
let nextTimer = 1;
globalThis.window = {
  setInterval: (callback, ms) => {
    const id = nextTimer++;
    timers.set(id, { callback, ms });
    return id;
  },
  clearInterval: (id) => timers.delete(id),
};

const {
  DESKTOP_PROVIDERS_RETRY_MS,
  isDesktopProvidersUnavailableError,
  requireDesktopProviders,
  waitForDesktopProviders,
} = await import('./desktop-provider-retry.ts');

test('every surface waiting on desktop providers shares one retry timer', () => {
  const calls = [];
  const leavePicker = waitForDesktopProviders(() => calls.push('picker'));
  const leaveSidebar = waitForDesktopProviders(() => calls.push('sidebar'));
  const leaveOnboarding = waitForDesktopProviders(() => calls.push('onboarding'));
  assert.equal(timers.size, 1);
  const [{ callback, ms }] = timers.values();
  assert.equal(ms, DESKTOP_PROVIDERS_RETRY_MS);
  callback();
  assert.deepEqual(calls, ['picker', 'sidebar', 'onboarding']);
  leavePicker();
  leaveSidebar();
  assert.equal(timers.size, 1, 'the timer runs while anyone still waits');
  calls.length = 0;
  callback();
  assert.deepEqual(calls, ['onboarding']);
  leaveOnboarding();
  assert.equal(timers.size, 0);
});

test('one shared check recognises an offline desktop snapshot and its failure', () => {
  const available = { managedByClient: true, api: [] };
  assert.equal(requireDesktopProviders(available), available);
  assert.equal(requireDesktopProviders(null), null);
  assert.deepEqual(requireDesktopProviders({ unavailable: true }), { unavailable: true }, 'local setup passes');
  let failure;
  try {
    requireDesktopProviders({ managedByClient: true, unavailable: true });
  } catch (reason) {
    failure = reason;
  }
  assert.equal(isDesktopProvidersUnavailableError(failure), true);
  assert.equal(isDesktopProvidersUnavailableError(failure.message), true);
  assert.equal(isDesktopProvidersUnavailableError(new Error('setup boom')), false);
  assert.equal(isDesktopProvidersUnavailableError(''), false);
});
