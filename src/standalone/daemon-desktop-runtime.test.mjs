// The Agents pool the daemon lends to desktop callers takes its running state
// from this daemon's in-memory turn activity, never from the worker index rows.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runtimeState } from '../runtime/agent/orchestrator/session/manager/runtime-state.mjs';
import { createDesktopRuntime } from './daemon-desktop-runtime.mjs';

test('the Agents pool shows working exactly while the daemon has the turn in flight', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-runtime-pool-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    runtimeState.clear();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'sessions'));
  const writeLead = (status) =>
    writeFileSync(
      join(root, 'lead-workers.json'),
      JSON.stringify({ workers: { lead: { sessionId: 'lead', agent: 'lead', status, stage: status } } })
    );
  const store = await createDesktopRuntime({ getLocalSessionBridge: () => null }).loadSessionStore();
  const leadStatus = () => store.listStoredAgentWorkers().find((row) => row.sessionId === 'lead')?.status;

  writeLead('running');
  runtimeState.set('lead', { stage: 'streaming', session: { owner: 'user', agent: 'lead' } });
  assert.equal(leadStatus(), 'running');

  // The row still claims running, but the daemon has no turn in flight.
  runtimeState.set('lead', { stage: 'done', session: { owner: 'user', agent: 'lead' } });
  assert.equal(leadStatus(), 'unknown');

  writeLead('idle');
  assert.equal(leadStatus(), 'idle');
});

test('the Agents pool drops working when the daemon is lost and restores it for the turns the reconnected daemon runs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-desktop-runtime-reconnect-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  t.after(() => {
    runtimeState.clear();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'sessions'));
  const lead = (sessionId) => ({ sessionId, agent: 'lead', status: 'running', stage: 'running' });
  writeFileSync(
    join(root, 'lead-workers.json'),
    JSON.stringify({ workers: { first: lead('first'), second: lead('second') } })
  );
  const store = await createDesktopRuntime({ getLocalSessionBridge: () => null }).loadSessionStore();
  const statuses = () => Object.fromEntries(store.listStoredAgentWorkers().map((row) => [row.sessionId, row.status]));
  const turn = { stage: 'streaming', session: { owner: 'user', agent: 'lead' } };

  runtimeState.set('first', turn);
  runtimeState.set('second', turn);
  assert.deepEqual(statuses(), { first: 'running', second: 'running' });

  // The daemon is lost: the rows still declare running, but nothing is guessed.
  runtimeState.clear();
  assert.deepEqual(statuses(), { first: 'unknown', second: 'unknown' });

  // The reconnected daemon runs only one of them again.
  runtimeState.set('second', turn);
  assert.deepEqual(statuses(), { first: 'unknown', second: 'running' });
});
