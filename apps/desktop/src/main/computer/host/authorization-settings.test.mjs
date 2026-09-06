import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputerAuthorizationSettings } from './authorization-settings.ts';
import { createComputerExecutionPolicy } from './execution-policy.ts';

const target = { id: 'hwnd:0x1', pid: 42, app: 'fixture', title: 'fixture' };
const candidate = () => ({
  version: 1, actions: ['capture'], windows: [target].map(({ id, pid }) => ({ id, pid })),
  launchTargets: [], allowElevatedInput: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

test('an in-process authorization gates dispatch, checks the current process, keeps host restrictions and never persists', async () => {
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  const base = createComputerExecutionPolicy({ ...candidate(), actions: ['capture', 'list'] });
  const options = { base, stop: () => stopped, windows: async () => [target] };
  const settings = createComputerAuthorizationSettings(options);
  assert.equal(settings.read().policy, null);
  assert.equal(settings.read().externallyRestricted, true);
  const saving = settings.update(candidate());
  assert.throws(() => settings.policy.dispatchAuthority(target.id), /policy_updating/);
  await assert.rejects(settings.update(candidate()), /policy_updating/);
  finish();
  await saving;
  settings.policy.assertAction({ action: 'capture', window_id: target.id });
  assert.throws(() => settings.policy.assertAction({ action: 'list_windows' }), /policy_denied/);
  assert.equal(settings.policy.dispatchAuthority(target.id).authorization_pid, 42);
  // Nothing is written anywhere: a new host starts with the launch policy alone.
  assert.equal(createComputerAuthorizationSettings(options).read().policy, null);
  const before = settings.read();
  const broader = { ...candidate(), actions: ['act'], windows: [{ id: 'hwnd:0x2', pid: 90 }] };
  await assert.rejects(settings.update(broader), /no longer available/);
  assert.deepEqual(settings.read(), before);
  await settings.update({ ...candidate(), actions: ['act'] });
  assert.throws(() => settings.policy.assertAction({ action: 'click', window_id: target.id }), /policy_denied/);
  const status = settings.read();
  status.policy.actions.push('list');
  assert.equal(settings.read().policy.actions.includes('list'), false);
});

test('without an authorization the launch policy alone applies; invalid and expired candidates fail closed without stopping work', async () => {
  let stops = 0;
  const options = { base: createComputerExecutionPolicy(), stop: async () => { stops++; }, windows: async () => [target] };
  const settings = createComputerAuthorizationSettings(options);
  assert.equal(settings.policy.restricted, false);
  settings.policy.assertAction({ action: 'list_windows' });
  settings.policy.assertAction({ action: 'click', window_id: 'hwnd:0x9' });
  for (const value of [undefined, null, {}, { ...candidate(), actions: ['anything'] },
    { ...candidate(), expiresAt: new Date(0).toISOString() },
    { ...candidate(), launchTargets: Array.from({ length: 128 }, (_, index) => `C:\\${index}${'x'.repeat(1000)}`) },
    { ...candidate(), expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() }]) {
    await assert.rejects(settings.update(value), /policy_invalid/);
  }
  assert.equal(stops, 0);
  const saved = await settings.update({ version: 1, expiresAt: candidate().expiresAt });
  assert.equal(stops, 1);
  assert.deepEqual(saved.policy.actions, []);
  assert.deepEqual(saved.policy.windows, []);
  assert.equal(settings.policy.restricted, true);
  assert.throws(() => settings.policy.assertAction({ action: 'capture', window_id: target.id }), /policy_denied/);
});
