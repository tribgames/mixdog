import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  QUOTA_RESUME_FILE,
  cancelQuotaResumeEntry,
  deferQuotaResumeEntry,
  forgetQuotaSuspendedGoal,
  listQuotaResumeEntries,
  noteQuotaSuspendedGoal,
  publicQuotaResume,
  quotaAutoResumeEnabled,
  quotaResumeEntry,
  quotaSuspendedGoal,
  reloadQuotaResumeStore,
  scheduleQuotaResumeEntry,
  setQuotaAutoResumeEnabled,
  subscribeQuotaResume,
} from './quota-resume-store.mjs';

function isolateDataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-resume-store-'));
  const overrides = {
    MIXDOG_DATA_DIR: dir,
    // Config writes keep user-data backups under the config dir; never the user's.
    MIXDOG_CONFIG_DIR: dir,
    MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  reloadQuotaResumeStore();
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    reloadQuotaResumeStore();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const request = (sessionId, resetAt = 5_000) => ({
  sessionId,
  turnKey: `turn:${sessionId}-user`,
  provider: 'openai-oauth',
  model: 'gpt-x',
  resetAt,
});

test('the auto-resume setting defaults on, persists in runtime config, and turning it off cancels every resume', (t) => {
  const dir = isolateDataDir(t);
  assert.equal(quotaAutoResumeEnabled(), true);
  scheduleQuotaResumeEntry(request('sess_a'));
  scheduleQuotaResumeEntry(request('sess_b'));
  const changed = [];
  const unsubscribe = subscribeQuotaResume((sessionId) => changed.push(sessionId));
  t.after(unsubscribe);

  assert.equal(setQuotaAutoResumeEnabled(false), false);
  assert.equal(quotaAutoResumeEnabled(), false);
  assert.deepEqual(listQuotaResumeEntries(), []);
  assert.deepEqual(changed, [null]);
  const config = JSON.parse(readFileSync(join(dir, 'mixdog-config.json'), 'utf8'));
  assert.equal(config.quotaResume.autoResume, false);

  assert.equal(setQuotaAutoResumeEnabled(true), true);
  assert.equal(quotaAutoResumeEnabled(), true);
});

test('entries survive a reload and stay generation-guarded', (t) => {
  const dir = isolateDataDir(t);
  const first = scheduleQuotaResumeEntry(request('sess_a', 1_000));
  const replaced = scheduleQuotaResumeEntry(request('sess_a', 2_000));
  assert.ok(replaced.generation > first.generation);
  assert.equal(deferQuotaResumeEntry('sess_a', first.generation, { resetAt: 9_000, attempts: 1 }), null);
  assert.equal(cancelQuotaResumeEntry('sess_a', { generation: first.generation }), false);
  const deferred = deferQuotaResumeEntry('sess_a', replaced.generation, { resetAt: 9_000, attempts: 1 });
  assert.equal(deferred.generation, replaced.generation);
  noteQuotaSuspendedGoal('sess_a', replaced.turnKey, 'goal-1');

  // A daemon restart: the in-memory copy is gone, the file is not.
  reloadQuotaResumeStore();
  assert.deepEqual(quotaResumeEntry('sess_a'), { ...deferred });
  assert.equal(quotaSuspendedGoal('sess_a', replaced.turnKey), 'goal-1');
  assert.equal(quotaSuspendedGoal('sess_a', 'turn:other'), '');
  assert.deepEqual(publicQuotaResume(quotaResumeEntry('sess_a')), {
    state: 'waiting',
    turnKey: replaced.turnKey,
    provider: 'openai-oauth',
    model: 'gpt-x',
    resetAt: 9_000,
    attempts: 1,
  });
  // A later schedule never reuses a generation issued before the restart.
  assert.ok(scheduleQuotaResumeEntry(request('sess_b')).generation > replaced.generation);
  assert.equal(JSON.parse(readFileSync(join(dir, QUOTA_RESUME_FILE), 'utf8')).entries.length, 2);
  assert.equal(forgetQuotaSuspendedGoal('sess_a'), true);
  assert.equal(quotaSuspendedGoal('sess_a', replaced.turnKey), '');
});

test('an unchanged entry publishes one snapshot identity', (t) => {
  isolateDataDir(t);
  scheduleQuotaResumeEntry(request('sess_a'));
  assert.equal(publicQuotaResume(quotaResumeEntry('sess_a')), publicQuotaResume(quotaResumeEntry('sess_a')));
  assert.equal(publicQuotaResume(null), null);
  assert.throws(() => scheduleQuotaResumeEntry({ ...request('sess_c'), resetAt: null }), TypeError);
});
