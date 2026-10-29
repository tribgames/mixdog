import test from 'node:test';
import assert from 'node:assert/strict';
// The stall policy reads host overrides once at load; the modules load with
// the defaults (watchdog on, transport idle below the semantic idle), and the
// host's values are put back afterwards.
const POLICY_ENV = Object.keys(process.env).filter((name) =>
  /^(MIXDOG_PROVIDER_|MIXDOG_STALL_|MIXDOG_ENABLE_STREAM_WATCHDOG$|STALL_TIMEOUT_S$)/.test(name),
);
const hostPolicy = POLICY_ENV.map((name) => [name, process.env[name]]);
for (const name of POLICY_ENV) delete process.env[name];
let createRestStreamWatchdogs, geminiTimeoutError, PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS, PROVIDER_SSE_IDLE_TIMEOUT_MS;
try {
  ({ createRestStreamWatchdogs } = await import('./watchdogs.mjs'));
  ({ geminiTimeoutError } = await import('../gemini-stream.mjs'));
  ({ PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS, PROVIDER_SSE_IDLE_TIMEOUT_MS } = await import('../../stall-policy.mjs'));
} finally {
  for (const [name, value] of hostPolicy) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test('the REST idle watchdog waits the semantic window and names the idle phase', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reader = { read: () => new Promise(() => {}), cancel: async () => {} };
  const watchdogs = createRestStreamWatchdogs({
    reader,
    label: 'fixture',
    firstByteTimeoutMs: 1000,
    timeoutError: geminiTimeoutError,
  });
  watchdogs.clearFirstByte();
  watchdogs.resetIdle();
  let failure = null;
  watchdogs.read().catch((error) => {
    failure = error;
  });
  t.mock.timers.tick(PROVIDER_SSE_IDLE_TIMEOUT_MS);
  await Promise.resolve();
  assert.equal(failure, null, 'still alive at the transport-byte idle window');
  t.mock.timers.tick(PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS - PROVIDER_SSE_IDLE_TIMEOUT_MS);
  await Promise.resolve();
  assert.equal(failure?.timeoutPhase, 'idle');
  assert.match(failure.message, new RegExp(`SSE idle timed out after ${PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS}ms`));
  watchdogs.stop();
});

test('the REST first-byte watchdog names the first-chunk phase', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reader = { read: () => new Promise(() => {}), cancel: async () => {} };
  const watchdogs = createRestStreamWatchdogs({
    reader,
    label: 'fixture',
    firstByteTimeoutMs: 1000,
    timeoutError: geminiTimeoutError,
  });
  let failure = null;
  watchdogs.read().catch((error) => {
    failure = error;
  });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(failure?.timeoutPhase, 'first-chunk');
  watchdogs.stop();
});
