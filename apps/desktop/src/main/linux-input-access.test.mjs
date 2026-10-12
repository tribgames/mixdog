import assert from 'node:assert/strict';
import test from 'node:test';
import { INSTALL_SCRIPT, requestLinuxInputAccess } from './linux-input-access.ts';

function deps({ exists = false, status = 0, platform = 'linux' } = {}) {
  const state = { runs: [] };
  return {
    state,
    deps: {
      platform,
      ruleExists: () => exists,
      async runPkexec(script) {
        state.runs.push(script);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return status;
      },
    },
  };
}

test('an existing rule is not reinstalled', async () => {
  const { state, deps: d } = deps({ exists: true });
  assert.deepEqual(await requestLinuxInputAccess(d), { ok: true });
  assert.equal(state.runs.length, 0);
});

test('one privileged script installs the rule and module config, then reloads udev', async () => {
  const { state, deps: d } = deps();
  assert.deepEqual(await requestLinuxInputAccess(d), { ok: true });
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0], INSTALL_SCRIPT);
  assert.match(INSTALL_SCRIPT, /KERNEL=="uinput", SUBSYSTEM=="misc", TAG\+="uaccess", OPTIONS\+="static_node=uinput"/);
  assert.match(INSTALL_SCRIPT, /> \/etc\/udev\/rules\.d\/70-mixdog-uinput\.rules/);
  assert.match(INSTALL_SCRIPT, /> \/etc\/modules-load\.d\/mixdog-uinput\.conf/);
  const order = ['modprobe uinput', 'udevadm control --reload', 'udevadm trigger'].map((part) => INSTALL_SCRIPT.indexOf(part));
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2]);
});

test('results map pkexec outcomes to a reason', async () => {
  assert.deepEqual(await requestLinuxInputAccess(deps({ status: 126 }).deps), { ok: false, reason: 'cancelled' });
  assert.deepEqual(await requestLinuxInputAccess(deps({ status: 127 }).deps), { ok: false, reason: 'failed' });
  assert.deepEqual(await requestLinuxInputAccess(deps({ status: 1 }).deps), { ok: false, reason: 'failed' });
  assert.deepEqual(await requestLinuxInputAccess(deps({ status: 'missing' }).deps), { ok: false, reason: 'pkexec_missing' });
  assert.deepEqual(await requestLinuxInputAccess(deps({ platform: 'win32' }).deps), { ok: false, reason: 'failed' });
});

test('concurrent requests share one prompt', async () => {
  const { state, deps: d } = deps();
  const results = await Promise.all([requestLinuxInputAccess(d), requestLinuxInputAccess(d)]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(state.runs.length, 1);
});