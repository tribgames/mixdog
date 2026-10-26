import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ELEVATION_DECLINED_EXIT,
  SECURE_DESKTOP_BUSY_EXIT,
  SECURE_DESKTOP_OTHER_USER_EXIT,
  SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT,
  SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT,
  installStateFromCheckExit,
} from './client.ts';
import { createSecureDesktopInstaller, installOfferFor } from './install-request.ts';

/** A fake bridge: `check` answers from `states` in order (the last repeats);
 *  `verifyImage` answers `image`; `elevateInstall` answers from `elevations`
 *  (an Error is thrown, a promise is adopted as the still-running child);
 *  `startService` answers from `starts`. */
function fakePort({ states, elevations = [], starts = [], image = { ok: true } }) {
  const calls = { check: 0, verify: 0, elevate: 0, start: 0, checkKeys: [], elevateKeys: [] };
  return {
    calls,
    port: {
      async check(controllerKey) {
        const state = states[Math.min(calls.check, states.length - 1)];
        calls.check += 1;
        calls.checkKeys.push(controllerKey);
        return state;
      },
      async verifyImage() {
        calls.verify += 1;
        return image;
      },
      async elevateInstall(controllerKey) {
        const next = elevations[calls.elevate];
        calls.elevate += 1;
        calls.elevateKeys.push(controllerKey);
        if (next instanceof Error) throw next;
        return next;
      },
      async startService() {
        const next = starts[Math.min(calls.start, starts.length - 1)];
        calls.start += 1;
        return next ?? { installed: false, running: false };
      },
    },
  };
}

/** A phone's public control key: base64url of an uncompressed P-256 point. */
const controllerKey = (fill) => Buffer.from([4, ...new Array(64).fill(fill)]).toString('base64url');
const KEY = controllerKey(7);
const OTHER_KEY = controllerKey(9);

test('the phone key reaches check and the elevated install', async () => {
  const { port, calls } = fakePort({ states: ['not-installed', 'installed'], elevations: [0] });
  assert.equal((await createSecureDesktopInstaller(port).request(KEY)).outcome, 'installed');
  assert.deepEqual(calls.elevateKeys, [KEY]);
  assert.deepEqual(calls.checkKeys, [KEY, KEY]);
});

test('a missing or invalid phone key fails without a prompt', async () => {
  const compressed = Buffer.from([2, ...new Array(32).fill(7)]).toString('base64url');
  for (const key of [undefined, '', 'not-a-key', compressed, `${KEY}=`]) {
    const { port, calls } = fakePort({ states: ['not-installed'] });
    const result = await createSecureDesktopInstaller(port).request(key);
    assert.equal(result.outcome, 'failed');
    assert.match(result.detail, /control key is invalid/);
    assert.equal(calls.elevate, 0);
    assert.equal(calls.verify, 0);
  }
});

test('another phone re-enrolls through an approved update that replaces the key', async () => {
  // The bridge's check reports `outdated` (exit 2) when the install does not
  // enroll the asking phone's key; the approved update writes that key.
  // One `outdated` for the offer's state(), one for the request's own check.
  const { port, calls } = fakePort({ states: ['outdated', 'outdated', 'installed'], elevations: [0] });
  const installer = createSecureDesktopInstaller(port);
  assert.equal(installOfferFor(await installer.state(OTHER_KEY)), 'update');
  assert.deepEqual(await installer.request(OTHER_KEY), { outcome: 'updated', state: 'installed' });
  assert.deepEqual(calls.elevateKeys, [OTHER_KEY]);
});

test('a second phone does not join or take over another phone’s running request', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { port, calls } = fakePort({ states: ['not-installed', 'not-installed', 'installed'], elevations: [gate] });
  const installer = createSecureDesktopInstaller(port);
  const first = installer.request(KEY);
  const second = await installer.request(OTHER_KEY);
  assert.equal(second.outcome, 'in-progress');
  release(0);
  assert.equal((await first).outcome, 'installed');
  assert.deepEqual(calls.elevateKeys, [KEY]);
});

test('check exit codes map to the install state the phone sees', () => {
  assert.equal(installStateFromCheckExit(0), 'installed');
  assert.equal(installStateFromCheckExit(1), 'not-installed');
  assert.equal(installStateFromCheckExit(2), 'outdated');
  assert.equal(installStateFromCheckExit(3), 'unavailable');
  assert.equal(installStateFromCheckExit(4), 'other-user');
});

test('a request installs a missing helper with one prompt', async () => {
  const { port, calls } = fakePort({ states: ['not-installed', 'installed'], elevations: [0] });
  const result = await createSecureDesktopInstaller(port).request(KEY);
  assert.deepEqual(result, { outcome: 'installed', state: 'installed' });
  assert.equal(calls.elevate, 1);
});

test('a request updates an outdated helper and reports it as an update', async () => {
  const { port, calls } = fakePort({ states: ['outdated', 'installed'], elevations: [0] });
  assert.deepEqual(await createSecureDesktopInstaller(port).request(KEY), { outcome: 'updated', state: 'installed' });
  assert.equal(calls.elevate, 1);
});

test('a stale check is offered as an update to approve, distinct from a fresh install', () => {
  // check exit 2 (stale) is the outdated state, offered as "approve update".
  assert.equal(installOfferFor(installStateFromCheckExit(2)), 'update');
  assert.equal(installOfferFor(installStateFromCheckExit(1)), 'install');
  for (const exitCode of [0, 3, 4]) assert.equal(installOfferFor(installStateFromCheckExit(exitCode)), 'none');
});

test('a current, unavailable, or other-user helper never prompts', async () => {
  for (const state of ['installed', 'unavailable', 'other-user']) {
    const { port, calls } = fakePort({ states: [state] });
    const result = await createSecureDesktopInstaller(port).request(KEY);
    assert.deepEqual(result, { outcome: state, state });
    assert.equal(calls.elevate, 0, 'a request for another account never takes it over');
  }
});

test('a declined prompt reports declined and is not retried', async () => {
  const { port, calls } = fakePort({
    states: ['not-installed'],
    elevations: [ELEVATION_DECLINED_EXIT, 0],
  });
  const installer = createSecureDesktopInstaller(port);
  assert.deepEqual(await installer.request(KEY), { outcome: 'declined', state: 'not-installed' });
  assert.equal(calls.elevate, 1, 'nothing prompts again on its own');
  assert.equal(installer.pending, false);
  await installer.state();
  assert.equal(calls.elevate, 1, 'reading the state never prompts');
});

/** A promise settled from outside: the elevated child that is still running. */
function outstandingChild() {
  let exit;
  const promise = new Promise((resolve) => {
    exit = resolve;
  });
  return { promise, exit };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('an elevation still running at the report deadline latches: repeated requests launch once', async () => {
  // The reviewer's probe: two timeouts used to mean two launches.
  const child = outstandingChild();
  const { port, calls } = fakePort({ states: ['not-installed'], elevations: [child.promise] });
  const installer = createSecureDesktopInstaller(port, { reportAfterMs: 5 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await installer.request(KEY);
    assert.equal(result.outcome, 'in-progress');
    assert.equal(result.state, 'not-installed');
    // An unanswered prompt keeps the latch; the phone is told to answer it.
    assert.match(result.detail, /prompt is already open on the PC: answer it there/);
  }
  assert.equal(calls.elevate, 1, 'a single launch however many requests time out');
  assert.equal(installer.pending, true, 'the latch is held while the child runs');

  // Only once the launched elevation exits (here: declined) is the latch
  // released, and the next press may prompt again.
  child.exit(ELEVATION_DECLINED_EXIT);
  await flush();
  assert.equal(installer.pending, false);
  await installer.request(KEY);
  assert.equal(calls.elevate, 2);
});

test('a latched request answers installed on its own installed check, but the latch holds until the child settles', async () => {
  const child = outstandingChild();
  const { port, calls } = fakePort({
    states: ['not-installed', 'not-installed', 'installed'],
    elevations: [child.promise],
  });
  const installer = createSecureDesktopInstaller(port, { reportAfterMs: 5 });
  assert.equal((await installer.request(KEY)).outcome, 'in-progress');
  assert.deepEqual(await installer.request(KEY), { outcome: 'installed', state: 'installed' });
  assert.equal(installer.pending, true, 'an installed check never releases the launched elevation');
  child.exit(0);
  await flush();
  assert.equal(installer.pending, false);
  assert.equal(calls.elevate, 1);
});

test('an enrolled phone’s installed check never releases another phone’s latch: B pending, A installed, C requests → one launch', async () => {
  // The reviewer's sequence. A is already enrolled (checks installed); the
  // install B started enrolls B, so until it finishes B and C check outdated.
  const KEY_A = KEY;
  const KEY_B = OTHER_KEY;
  const KEY_C = controllerKey(11);
  const child = outstandingChild();
  const elevateKeys = [];
  const port = {
    async check(key) {
      return key === KEY_A ? 'installed' : 'outdated';
    },
    async verifyImage() {
      return { ok: true };
    },
    async elevateInstall(key) {
      elevateKeys.push(key);
      return child.promise;
    },
    async startService() {
      return { installed: true, running: true };
    },
  };
  const installer = createSecureDesktopInstaller(port, { reportAfterMs: 5 });

  assert.equal((await installer.request(KEY_B)).outcome, 'in-progress', 'B: the UAC prompt is still open');
  assert.deepEqual(await installer.request(KEY_A), { outcome: 'installed', state: 'installed' });
  const c = await installer.request(KEY_C);
  assert.equal(c.outcome, 'in-progress');
  assert.match(c.detail, /prompt is already open on the PC/);
  assert.deepEqual(elevateKeys, [KEY_B], 'exactly one launch');
  assert.equal(installer.pending, true);

  child.exit(0);
  await flush();
  assert.equal(installer.pending, false);
});

test('an elevated refusal for another account reports other-user', async () => {
  const { port } = fakePort({ states: ['not-installed', 'other-user'], elevations: [SECURE_DESKTOP_OTHER_USER_EXIT] });
  assert.deepEqual(await createSecureDesktopInstaller(port).request(KEY), {
    outcome: 'other-user',
    state: 'other-user',
  });
});

test('an image the install would refuse fails with the reason and never prompts', async () => {
  const detail = 'this helper build has no release signer pin (a local or development build)';
  const { port, calls } = fakePort({ states: ['not-installed'], image: { ok: false, detail } });
  assert.deepEqual(await createSecureDesktopInstaller(port).request(KEY), {
    outcome: 'failed',
    state: 'not-installed',
    detail,
  });
  assert.equal(calls.elevate, 0);
});

test('an elevated image refusal reports failed with a clear detail', async () => {
  const { port } = fakePort({ states: ['not-installed'], elevations: [SECURE_DESKTOP_UNTRUSTED_IMAGE_EXIT] });
  const result = await createSecureDesktopInstaller(port).request(KEY);
  assert.equal(result.outcome, 'failed');
  assert.match(result.detail, /not a signed, unrevoked Mixdog release build/);
});

test('an undeterminable revocation status reports failed, never installed', async () => {
  const { port } = fakePort({ states: ['not-installed'], elevations: [SECURE_DESKTOP_REVOCATION_UNKNOWN_EXIT] });
  assert.deepEqual(await createSecureDesktopInstaller(port).request(KEY), {
    outcome: 'failed',
    state: 'not-installed',
    detail: 'could not check certificate revocation (offline?)',
  });
});

test('a busy exit (another install running) reports in-progress', async () => {
  const { port } = fakePort({ states: ['not-installed'], elevations: [SECURE_DESKTOP_BUSY_EXIT] });
  const result = await createSecureDesktopInstaller(port).request(KEY);
  assert.equal(result.outcome, 'in-progress');
  assert.match(result.detail, /already running/);
});


test('ensureRunning starts an installed-but-stopped service without prompting', async () => {
  const { port, calls } = fakePort({
    states: ['installed'],
    starts: [{ installed: true, running: true }],
  });
  const result = await createSecureDesktopInstaller(port).ensureRunning();
  assert.deepEqual(result, { installed: true, running: true });
  assert.equal(calls.elevate, 0);
  assert.equal(calls.start, 1);
});

test('ensureRunning does nothing when the helper is not installed for this user', async () => {
  for (const state of ['not-installed', 'other-user', 'unavailable']) {
    const { port, calls } = fakePort({ states: [state] });
    const result = await createSecureDesktopInstaller(port).ensureRunning();
    assert.deepEqual(result, { installed: false, running: false });
    assert.equal(calls.start, 0);
  }
});

test('a failed install, or one that could not run, reports failed', async () => {
  {
    const { port } = fakePort({ states: ['not-installed'], elevations: [1] });
    const result = await createSecureDesktopInstaller(port).request(KEY);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.state, 'not-installed');
    assert.match(result.detail, /exited with 1/);
  }
  {
    const { port } = fakePort({ states: ['not-installed'], elevations: [new Error('spawn powershell ENOENT')] });
    const result = await createSecureDesktopInstaller(port).request(KEY);
    assert.equal(result.outcome, 'failed');
    assert.match(result.detail, /ENOENT/);
  }
  {
    // Exit 0, but the check still does not see a current install.
    const { port } = fakePort({ states: ['not-installed', 'outdated'], elevations: [0] });
    const result = await createSecureDesktopInstaller(port).request(KEY);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.state, 'outdated');
  }
});

test('requests while one is pending join it: one prompt', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let elevations = 0;
  let checks = 0;
  const installer = createSecureDesktopInstaller({
    async check() {
      checks += 1;
      return checks === 1 ? 'not-installed' : 'installed';
    },
    async verifyImage() {
      return { ok: true };
    },
    async elevateInstall() {
      elevations += 1;
      await gate;
      return 0;
    },
  });
  const first = installer.request(KEY);
  const second = installer.request(KEY);
  assert.equal(installer.pending, true);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult, secondResult);
  assert.equal(firstResult.outcome, 'installed');
  assert.equal(elevations, 1);
  assert.equal(installer.pending, false);
});
