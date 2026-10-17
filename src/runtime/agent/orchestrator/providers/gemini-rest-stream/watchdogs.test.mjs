import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestStreamWatchdogs } from './watchdogs.mjs';
import { geminiTimeoutError } from '../gemini-stream.mjs';
import {
  PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
} from '../../stall-policy.mjs';

test('the REST idle watchdog waits the semantic window and names the idle phase', {
  skip: !PROVIDER_SSE_IDLE_WATCHDOG_ENABLED || PROVIDER_SSE_IDLE_TIMEOUT_MS >= PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
}, async (t) => {
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
