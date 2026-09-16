import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCycleScheduler } from './cycle-scheduler.mjs';
import { createCycleLlmAdapters } from './cycle-llm-adapters.mjs';
import { scheduledCycle1Signature, scheduledCycle2Signature } from './cycle-signatures.mjs';
import { claimAndMarkScheduledCycle } from './memory-cycle-requests.mjs';

test('old configuration cannot schedule a retired cycle or mutate CORE', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cycle-scheduler-'));
  t.after(() => rmSync(dir, { recursive: true }));
  let config = { cycle1: { interval: '10m' }, cycle2: { interval: '1h' }, cycle3: { interval: '1ms' } };
  const claimed = [];
  const scheduled = [];
  const db = { query: async () => ({ rows: [{ c: 0 }] }) };
  const { parseInterval } = await import('./memory-cycle2.mjs');
  const scheduler = createCycleScheduler({
    getDb: () => db,
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    readMainConfig: () => config,
    memoryCyclesEnabled: () => true,
    getCycleLastRun: async () => ({}),
    parseInterval,
    cycleStateFile: join(dir, 'state.json'),
    scheduledCycle1Signature,
    scheduledCycle2Signature,
    claimAndMarkScheduledCycle: async (_db, kind) => {
      claimed.push(kind);
      return { claimed: true };
    },
    resolveCoalesceMaxRetries: () => 3,
    scheduleCoalescedCycleRetry: (_db, kind) => {
      scheduled.push(kind);
    },
    onCoreMemoryChanged: () => {
      throw new Error('maintenance cannot modify CORE');
    },
  });
  await scheduler.checkCycles();
  assert.deepEqual(claimed, ['cycle1', 'cycle2']);
  assert.deepEqual(scheduled, ['cycle1', 'cycle2']);
  assert.deepEqual(Object.keys(scheduler.getCycleHealth()), ['cycle1', 'cycle2']);
  await assert.rejects(claimAndMarkScheduledCycle(db, 'cycle3', 1000), /invalid cycle/);
});

test('maintenance LLM adapters expose only the two supported roles', async () => {
  const calls = [];
  const adapters = createCycleLlmAdapters({
    callAgentDispatch: async (request, prompt) => {
      calls.push({ request, prompt });
      return 'done';
    },
  });
  assert.deepEqual(Object.keys(adapters), ['getCycle1CallLlm', 'getCycle2CallLlm']);
  await adapters.getCycle1CallLlm()({}, 'summarize');
  await adapters.getCycle2CallLlm()({}, 'review history');
  assert.deepEqual(
    calls.map((call) => call.request.agent),
    ['cycle1-agent', 'cycle2-agent']
  );
});
