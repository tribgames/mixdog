import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCycleScheduler } from './cycle-scheduler.mjs';
import { createCycleLlmAdapters } from './cycle-llm-adapters.mjs';
import { scheduledCycle1Signature } from './cycle-signatures.mjs';

test('a scheduled tick claims cycle1 and never touches CORE', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-cycle-scheduler-'));
  t.after(() => rmSync(dir, { recursive: true }));
  let config = { cycle1: { interval: '10m' } };
  const claimed = [];
  const scheduled = [];
  const db = { query: async () => ({ rows: [{ c: 0 }] }) };
  const { parseInterval } = await import('./memory-cycle-shared.mjs');
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
  assert.deepEqual(claimed, ['cycle1']);
  assert.deepEqual(scheduled, ['cycle1']);
  assert.deepEqual(Object.keys(scheduler.getCycleHealth()), ['cycle1']);
});

test('maintenance LLM adapters dispatch summarization', async () => {
  const calls = [];
  const adapters = createCycleLlmAdapters({
    callAgentDispatch: async (request, prompt) => {
      calls.push({ request, prompt });
      return 'done';
    },
  });
  assert.deepEqual(Object.keys(adapters), ['getCycle1CallLlm']);
  await adapters.getCycle1CallLlm()({}, 'summarize');
  assert.deepEqual(
    calls.map((call) => call.request.agent),
    ['cycle1-agent']
  );
});
