import assert from 'node:assert/strict';
import test from 'node:test';
import { INSTALL_SCRIPT, requestLinuxInputAccess } from './linux-input-access.ts';

/** `before`: access before any repair; `after`: access once the repair has run (udev applied). */
function deps({ before = false, after = true, status = 0, platform = 'linux', device = true } = {}) {
  const state = { runs: [], waits: 0 };
  return {
    state,
    deps: {
      platform,
      canAccess: () => (state.runs.length ? after : before),
      deviceExists: () => device,
      async runPkexec(script) {
        state.runs.push(script);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return status;
      },
      async wait() {
        state.waits += 1;
      },
    },
  };
}

test('working access skips the privileged repair', async () => {
  const { state, deps: d } = deps({ before: true });
  assert.deepEqual(await requestLinuxInputAccess(d), { ok: true });
  assert.equal(state.runs.length, 0);
});

test('no access runs the repair even when a rule file may already exist', async () => {
  const { state, deps: d } = deps({ before: false, after: true });
  assert.deepEqual(await requestLinuxInputAccess(d), { ok: true });
  assert.equal(state.runs.length, 1);
});

test('one privileged script installs the rule and module config, then reloads udev', async () => {
  const { state, deps: d } = deps();
  assert.deepEqual(await requestLinuxInputAccess(d), { ok: true });
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0], INSTALL_SCRIPT);
  assert.match(INSTALL_SCRIPT, /KERNEL=="uinput", SUBSYSTEM=="misc", TAG\+="uaccess", OPTIONS\+="static_node=uinput"/);
  assert.match(INSTALL_SCRIPT, /> \/etc\/udev\/rules\.d\/70-mixdog-uinput\.rules/);
  assert.match(INSTALL_SCRIPT, /> \/etc\/modules-load\.d\/mixdog-uinput\.conf/);
  const order = ['modprobe uinput', 'udevadm control --reload', 'udevadm trigger'].map((part) =>
    INSTALL_SCRIPT.indexOf(part)
  );
  assert.ok(order.every((index) => index > 0) && order[0] < order[1] && order[1] < order[2]);
});

test('repair exit 0 but access still missing is an actionable failure after a bounded recheck', async () => {
  const { state, deps: d } = deps({ after: false });
  const result = await requestLinuxInputAccess(d);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'access_unavailable');
  assert.equal(result.detail, 'relogin');
  assert.match(result.message, /sign out and sign in again/i);
  assert.equal(state.runs.length, 1);
  assert.ok(state.waits > 0 && state.waits <= 20);
});

test('repair exit 0 with /dev/uinput absent points at the uinput module', async () => {
  const result = await requestLinuxInputAccess(deps({ after: false, device: false }).deps);
  assert.equal(result.reason, 'access_unavailable');
  assert.equal(result.detail, 'no-module');
  assert.match(result.message, /uinput kernel module/);
});

test('access that appears while udev applies the ACL is picked up by the recheck', async () => {
  const { state, deps: d } = deps();
  let checks = 0;
  d.canAccess = () => (state.runs.length ? ++checks > 3 : false);
  assert.deepEqual(await requestLinuxInputAccess(d), { ok: true });
  assert.equal(state.runs.length, 1);
});

test('results map pkexec outcomes to a reason', async () => {
  const reason = async (options) => (await requestLinuxInputAccess(deps(options).deps)).reason;
  assert.equal(await reason({ status: 126 }), 'cancelled');
  assert.equal(await reason({ status: 127 }), 'failed');
  assert.equal(await reason({ status: 1 }), 'failed');
  assert.equal(await reason({ status: 'missing' }), 'pkexec_missing');
  const failed = await requestLinuxInputAccess(deps({ status: 1 }).deps);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.message, /exit 1/);
  assert.deepEqual(await requestLinuxInputAccess(deps({ platform: 'win32' }).deps), { ok: false, reason: 'failed' });
});

test('a failed or cancelled repair is not retried automatically', async () => {
  const { state, deps: d } = deps({ status: 126 });
  await requestLinuxInputAccess(d);
  assert.equal(state.runs.length, 1);
});

test('concurrent requests share one prompt', async () => {
  const { state, deps: d } = deps();
  const results = await Promise.all([requestLinuxInputAccess(d), requestLinuxInputAccess(d)]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(state.runs.length, 1);
});

test('a click during an in-flight repair is not bypassed once access has appeared', async () => {
  const { state, deps: d } = deps();
  let accessible = false;
  d.canAccess = () => accessible;
  d.runPkexec = async (script) => {
    state.runs.push(script);
    await new Promise((resolve) => setTimeout(resolve, 10));
    accessible = true;
    return 0;
  };
  const first = requestLinuxInputAccess(d);
  await new Promise((resolve) => setTimeout(resolve, 2));
  accessible = true; // rule/ACL appeared mid-repair
  const second = requestLinuxInputAccess(d);
  assert.strictEqual(second, first);
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(state.runs.length, 1);
});
