// Regression: saving/editing a schedule while the channels runtime is ALREADY
// up must re-arm the scheduler. reloadRuntimeConfig() previously passed
// `restart: bridgeConnected`, so on an automation-only install (no Discord/
// Telegram) every reload only destroyed the cron/one-shot bindings and nothing
// ever called scheduler.start() again — schedules stayed silently disarmed
// until the daemon restarted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Scheduler pins its lock path (os.tmpdir) and log dir (data dir) at module
// load, so redirect both to throwaway dirs BEFORE the dynamic import — the test
// must not contend with a live daemon's scheduler lock or append to the real
// schedule.log.
const sandbox = mkdtempSync(join(tmpdir(), 'mixdog-sched-reload-'));
process.env.TEMP = sandbox;
process.env.TMP = sandbox;
process.env.MIXDOG_DATA_DIR = sandbox;
const { Scheduler } = await import('../src/runtime/channels/lib/scheduler.mjs');

const cronEntry = {
  name: 'reload-arm-probe',
  whenCron: '0 9 * * *',
  target: 'session',
  model: 'anthropic-oauth/claude-opus-5',
  prompt: 'hi',
  enabled: true,
  status: 'active',
};

test('reloadConfig({ restart: true }) arms a schedule added while the runtime is up', () => {
  const scheduler = new Scheduler([], [], '');
  try {
    scheduler.start(); // boots with zero schedules, exactly like the daemon
    assert.equal(scheduler.cronJobs.size, 0);
    scheduler.reloadConfig([cronEntry], [], '', { restart: true });
    assert.equal(scheduler.cronJobs.size, 1);
  } finally {
    scheduler.stop();
  }
});

test('reloadConfig({ restart: false }) leaves the scheduler disarmed', () => {
  const scheduler = new Scheduler([], [], '');
  try {
    scheduler.start();
    scheduler.reloadConfig([cronEntry], [], '', { restart: false });
    assert.equal(scheduler.cronJobs.size, 0);
  } finally {
    scheduler.stop();
  }
});

test('reloadRuntimeConfig re-arms whenever the automation runtime is up', () => {
  const source = readFileSync('src/runtime/channels/lib/owned-runtime.mjs', 'utf8');
  const call = source.slice(source.indexOf('scheduler.reloadConfig('));
  const options = call.slice(0, call.indexOf('\n  );'));
  assert.match(options, /restart: automationRunning \|\| getBridgeRuntimeConnected\(\)/);
});
