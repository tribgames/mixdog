import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createComputerAuthorizationSettings } from './authorization-settings.ts';
import { createComputerExecutionPolicy } from './execution-policy.ts';

const target = { id: 'hwnd:0x1', pid: 42, app: 'fixture', title: 'fixture' };
const candidate = () => ({
  version: 1, actions: ['capture'], windows: [target].map(({ id, pid }) => ({ id, pid })),
  launchTargets: [], allowElevatedInput: false, expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
test('settings save gates dispatch, checks current process, persists and retains host restrictions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-policy-test-'));
  let finish;
  const stopped = new Promise((resolve) => { finish = resolve; });
  const base = createComputerExecutionPolicy({ ...candidate(), actions: ['capture', 'list'] });
  const options = { directory, base, stop: () => stopped, windows: async () => [target] };
  try {
    const settings = createComputerAuthorizationSettings(options);
    const saving = settings.update(candidate());
    assert.throws(() => settings.policy.dispatchAuthority(target.id), /policy_updating/);
    await assert.rejects(settings.update(candidate()), /policy_updating/);
    finish();
    await saving;
    settings.policy.assertAction({ action: 'capture', window_id: target.id });
    assert.throws(() => settings.policy.assertAction({ action: 'list_windows' }), /policy_denied/);
    assert.equal(settings.policy.dispatchAuthority(target.id).authorization_pid, 42);
    const loaded = createComputerAuthorizationSettings(options);
    assert.deepEqual(loaded.read(), settings.read());
    const broader = { ...candidate(), actions: ['act'], windows: [{ id: 'hwnd:0x2', pid: 90 }] };
    await assert.rejects(settings.update(broader), /no longer available/);
    assert.deepEqual(loaded.read(), settings.read());
    await settings.update({ ...candidate(), actions: ['act'] });
    assert.throws(() => settings.policy.assertAction({ action: 'click', window_id: target.id }), /policy_denied/);
    const status = settings.read();
    status.policy.actions.push('list');
    assert.equal(settings.read().policy.actions.includes('list'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid, expired and corrupt authorizations fail closed without stopping active work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-policy-test-'));
  let stops = 0;
  const options = { directory, base: createComputerExecutionPolicy(), stop: async () => { stops++; }, windows: async () => [target] };
  try {
    const settings = createComputerAuthorizationSettings(options);
    for (const value of [undefined, null, {}, { ...candidate(), actions: ['anything'] },
      { ...candidate(), expiresAt: new Date(0).toISOString() },
      { ...candidate(), launchTargets: Array.from({ length: 128 }, (_, index) => `C:\\${index}${'x'.repeat(1000)}`) },
      { ...candidate(), expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString() }]) {
      await assert.rejects(settings.update(value), /policy_invalid/);
    }
    assert.equal(stops, 0);
    const saved = await settings.update({ version: 1, expiresAt: candidate().expiresAt });
    assert.deepEqual(saved.policy.actions, []);
    assert.deepEqual(saved.policy.windows, []);
    assert.throws(() => settings.policy.assertAction({ action: 'capture', window_id: target.id }), /policy_denied/);
    await writeFile(join(directory, 'computer-authorization.json'), '{broken');
    const damaged = createComputerAuthorizationSettings(options);
    assert.equal(damaged.read().error, 'computer_policy_invalid');
    assert.equal(damaged.policy.restricted, true);
    assert.throws(() => damaged.policy.assertAction({ action: 'list_windows' }), /policy_invalid/);
    await damaged.update(candidate());
    assert.equal(damaged.read().error, undefined);
    damaged.policy.assertAction({ action: 'capture', window_id: target.id });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
