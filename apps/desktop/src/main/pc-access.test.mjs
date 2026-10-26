import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPcAccess, pendingRevokesFile, unpairWithPcAccess } from './pc-access.ts';
import { loadRemoteClientCache } from './remote-client-cache.ts';
import { createRemoteControllerKeys } from './remote-controller-keys.ts';
import { MAX_REMOTE_SCREEN_HELPER_KEYS } from '../shared/remote-webrtc.ts';
import { generateSecureDesktopControllerKey } from '../shared/secure-desktop-grant.ts';

const newKey = async () => (await generateSecureDesktopControllerKey()).publicKey;
const [KEY_A, KEY_B, KEY_GONE, KEY_OLD] = await Promise.all([1, 2, 3, 4].map(newKey));

/** The installer as a fake: its install state, the enrolled keys (moved by a
 *  successful operation), and every operation with its options. `answers`
 *  sets one outcome per step (`enroll` UAC, `delegatedEnroll`, `revoke`), as a
 *  string or a function (which may throw or wait). */
function fakeInstaller({ state = 'not-installed', enrolled = [], answers = {} } = {}) {
  const answer = async (step, fallback, target) => {
    const given = answers[step] ?? fallback;
    return typeof given === 'function' ? given(target) : given;
  };
  const installer = {
    installState: state,
    enrolled: new Set(enrolled),
    calls: [],
    async state(key) {
      if (key === undefined || installer.installState !== 'installed') return installer.installState;
      // `check --controller-key` of a key the current install lacks: exit 7.
      return installer.enrolled.has(key) ? 'installed' : 'not-enrolled';
    },
    async install(keys, options = {}) {
      installer.calls.push(['install', [...keys], options]);
      const outcome = await answer('install', 'installed', keys);
      if (outcome === 'installed') {
        installer.installState = 'installed';
        installer.enrolled = new Set(keys);
      }
      return { outcome, state: installer.installState };
    },
    async enroll(keys, options = {}) {
      installer.calls.push(['enroll', Array.isArray(keys) ? [...keys] : keys, options]);
      const outcome = await answer(options.delegated ? 'delegatedEnroll' : 'enroll', 'enrolled', keys);
      if (outcome === 'enrolled') {
        for (const key of options.revoke ?? []) installer.enrolled.delete(key);
        for (const key of [keys].flat()) installer.enrolled.add(key);
      }
      return { outcome, state: installer.installState, ...(outcome === 'failed' ? { detail: 'boom' } : {}) };
    },
    async revoke(key, options = {}) {
      installer.calls.push(['revoke', key, options]);
      const outcome = await answer('revoke', 'revoked', key);
      if (outcome === 'revoked') installer.enrolled.delete(key);
      return { outcome, state: installer.installState };
    },
  };
  return installer;
}

/** The pending record in memory, with the file store's marker semantics. */
function memoryPending(keys = [], unknown = null) {
  let state = { keys: [...keys], unknown };
  let marks = 0;
  return {
    read: async () => ({ keys: [...state.keys], unknown: state.unknown }),
    add: async (key) => {
      if (!state.keys.includes(key)) state = { ...state, keys: [...state.keys, key] };
    },
    markUnknown: async () => {
      state = { ...state, unknown: ++marks + 1000 };
    },
    settle: async (settled, marker) => {
      state = {
        keys: state.keys.filter((key) => !settled.includes(key)),
        unknown: marker != null && marker === state.unknown ? null : state.unknown,
      };
    },
    get keys() {
      return [...state.keys];
    },
    get unknown() {
      return state.unknown;
    },
  };
}

const record = (clientId, publicKey, unpaired = false) => ({ clientId, publicKey, unpaired });
const PHONES = [record('a', KEY_A), record('b', KEY_B), record('gone', KEY_GONE, true)];
/** The service as the app reaches it: the paired-device records, and the
 *  revocations it owes for removed pairings (taken over, then settled). */
function fakeService({ phones = PHONES, owed = [], unknown = 0 } = {}) {
  const service = {
    phones,
    owedKeys: [...owed],
    unknown,
    settled: [],
    down: false,
    keys: async () => {
      if (service.down) throw new Error('service down');
      return service.phones;
    },
    owed: async () => {
      if (service.down) throw new Error('service down');
      return { keys: [...service.owedKeys], unknown: service.unknown };
    },
    settleOwed: async (keys, marker) => {
      service.settled.push([[...keys], marker]);
      service.owedKeys = service.owedKeys.filter((key) => !keys.includes(key));
      if (marker && marker === service.unknown) service.unknown = 0;
    },
  };
  return service;
}
const pcAccessOver = (
  installer,
  { phones = PHONES, pending = memoryPending(), service = fakeService({ phones }) } = {}
) =>
  createPcAccess({
    installer,
    pending,
    keys: () => service.keys(),
    owed: () => service.owed(),
    settleOwed: (keys, unknown) => service.settleOwed(keys, unknown),
  });
const ticks = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const quietErrors = (t) => t.mock.method(console, 'error', () => {});

test('Computer Use setup Approve: one UAC install of every paired phone’s key with the pending revokes, then they are cleared', async () => {
  const installer = fakeInstaller();
  const pending = memoryPending([KEY_OLD]);
  const access = pcAccessOver(installer, { pending });
  assert.deepEqual(await access.readiness(), { state: 'not-installed' });
  assert.deepEqual(await access.approve(), { outcome: 'done' });
  assert.deepEqual(
    installer.calls,
    [['install', [KEY_A, KEY_B], { revoke: [KEY_OLD] }]],
    'an unpaired phone is left out'
  );
  assert.deepEqual(pending.keys, []);

  // An outdated install is replaced the same way; no phone yet still installs.
  const outdated = fakeInstaller({ state: 'outdated' });
  assert.deepEqual(await pcAccessOver(outdated, { phones: [] }).readiness(), { state: 'not-installed' });
  await pcAccessOver(outdated, { phones: [] }).approve();
  assert.deepEqual(outdated.calls, [['install', [], { revoke: [] }]]);

  // A declined prompt keeps the pending revokes for the next time.
  const declined = fakeInstaller({ answers: { install: 'declined' } });
  const kept = memoryPending([KEY_OLD]);
  assert.deepEqual(await pcAccessOver(declined, { pending: kept }).approve(), { outcome: 'declined' });
  assert.deepEqual(kept.keys, [KEY_OLD]);
});

test('Approve new phone: one UAC enroll of every missing phone, the pending revokes in the same call', async () => {
  const installer = fakeInstaller({ state: 'installed' });
  const pending = memoryPending([KEY_OLD]);
  assert.deepEqual(await pcAccessOver(installer, { pending }).approve(), { outcome: 'done' });
  assert.deepEqual(
    installer.calls,
    [['enroll', [KEY_A, KEY_B], { revoke: [KEY_OLD] }]],
    'one enroll for every missing phone'
  );
  assert.deepEqual(pending.keys, []);

  // Only the phones the install lacks.
  const one = fakeInstaller({ state: 'installed', enrolled: [KEY_A] });
  assert.deepEqual(await pcAccessOver(one).approve(), { outcome: 'done' });
  assert.deepEqual(one.calls, [['enroll', [KEY_B], { revoke: [] }]]);

  // A plain check answering not-enrolled is still an install: enroll, never reinstall.
  const lacking = fakeInstaller({ state: 'not-enrolled' });
  await pcAccessOver(lacking).approve();
  assert.deepEqual(lacking.calls, [['enroll', [KEY_A, KEY_B], { revoke: [] }]]);

  // A key waiting to be revoked is never enrolled again.
  const revoking = fakeInstaller({ state: 'installed', enrolled: [KEY_A] });
  assert.deepEqual(await pcAccessOver(revoking, { pending: memoryPending([KEY_B]) }).approve(), {
    outcome: 'nothing-to-do',
  });
  assert.deepEqual(revoking.calls, []);

  // A failed prompt (revokes and enrolls are one key-set write) keeps the pending revokes.
  const failed = fakeInstaller({ state: 'installed', answers: { enroll: 'failed' } });
  const kept = memoryPending([KEY_OLD]);
  assert.deepEqual(await pcAccessOver(failed, { pending: kept }).approve(), { outcome: 'failed', detail: 'boom' });
  assert.deepEqual(failed.calls, [['enroll', [KEY_A, KEY_B], { revoke: [KEY_OLD] }]]);
  assert.deepEqual(kept.keys, [KEY_OLD]);
});

test('every paired phone enrolled is ready; another account’s or an unavailable service prompts nothing', async () => {
  const done = fakeInstaller({ state: 'installed', enrolled: [KEY_A, KEY_B] });
  assert.deepEqual(await pcAccessOver(done).readiness(), { state: 'ready' });
  assert.deepEqual(await pcAccessOver(done).approve(), { outcome: 'nothing-to-do' });
  for (const state of ['other-user', 'unavailable']) {
    const installer = fakeInstaller({ state });
    assert.deepEqual(await pcAccessOver(installer).readiness(), { state });
    assert.deepEqual(await pcAccessOver(installer).approve(), { outcome: state });
    assert.deepEqual(installer.calls, [], state);
  }
  assert.deepEqual(done.calls, []);
});

test('Approve new phone shows only after a refusal only elevation fixes, never while an enroll runs or for an unreachable service', async (t) => {
  quietErrors(t);
  let next = 'service-unreachable';
  let gate = null;
  const installer = fakeInstaller({
    state: 'installed',
    enrolled: [KEY_A],
    answers: { delegatedEnroll: async () => (gate ? gate.promise : next) },
  });
  const access = pcAccessOver(installer);
  assert.deepEqual(
    await access.readiness(),
    { state: 'ready' },
    'missing, not tried yet: the next delivery enrolls it'
  );

  assert.equal(await access.delivered(KEY_B), 'failed');
  assert.deepEqual(await access.readiness(), { state: 'ready' }, 'unreachable: the next delivery tries again');

  for (const refusal of ['delegation-disabled', 'delegation-denied']) {
    next = refusal;
    await access.delivered(KEY_B);
    assert.deepEqual(await access.readiness(), { state: 'needs-enroll' }, refusal);
  }

  // A delegated enroll in flight hides it.
  gate = deferred();
  const running = access.delivered(KEY_B);
  assert.deepEqual(await access.readiness(), { state: 'ready' }, 'in flight');
  gate.resolve('enrolled');
  assert.equal(await running, 'enrolled');
  assert.deepEqual(await access.readiness(), { state: 'ready' });

  // Approve new phone clears it.
  const refused = fakeInstaller({ state: 'installed', answers: { delegatedEnroll: 'delegation-disabled' } });
  const access2 = pcAccessOver(refused, { phones: [record('b', KEY_B)] });
  assert.equal(await access2.delivered(KEY_B), 'delegation-disabled');
  assert.deepEqual(await access2.readiness(), { state: 'needs-enroll' });
  assert.deepEqual(await access2.approve(), { outcome: 'done' });
  assert.deepEqual(await access2.readiness(), { state: 'ready' });
});

test('a delivered key is enrolled through delegation once set up, with no prompt; nothing before setup', async () => {
  const installer = fakeInstaller({ state: 'installed', enrolled: [KEY_A] });
  const access = pcAccessOver(installer);
  assert.equal(await access.delivered(KEY_B), 'enrolled');
  assert.deepEqual(installer.calls, [['enroll', KEY_B, { delegated: true }]]);

  // Already enrolled, or waiting to be revoked: nothing.
  assert.equal(await access.delivered(KEY_A), 'nothing');
  const pendingB = fakeInstaller({ state: 'installed' });
  assert.equal(await pcAccessOver(pendingB, { pending: memoryPending([KEY_B]) }).delivered(KEY_B), 'nothing');
  assert.deepEqual(pendingB.calls, []);

  for (const state of ['not-installed', 'outdated', 'other-user', 'unavailable']) {
    const before = fakeInstaller({ state });
    assert.equal(await pcAccessOver(before).delivered(KEY_B), 'nothing', state);
    assert.deepEqual(before.calls, [], state);
  }
});

test('a delivery first applies the pending revokes the delegated path can run', async () => {
  const installer = fakeInstaller({ state: 'installed' });
  const pending = memoryPending([KEY_OLD]);
  assert.equal(await pcAccessOver(installer, { pending }).delivered(KEY_B), 'enrolled');
  assert.deepEqual(installer.calls, [
    ['revoke', KEY_OLD, { delegated: true }],
    ['enroll', KEY_B, { delegated: true }],
  ]);
  assert.deepEqual(pending.keys, []);
});

test('a pending revoke that did not run blocks the enroll (probe: revoke-failed then enrolled)', async (t) => {
  quietErrors(t);
  for (const answer of ['failed', 'service-unreachable', 'delegation-denied', 'delegation-disabled', 'in-progress']) {
    const installer = fakeInstaller({ state: 'installed', answers: { revoke: answer } });
    const pending = memoryPending([KEY_OLD]);
    const access = pcAccessOver(installer, { pending, phones: [record('b', KEY_B)] });
    assert.equal(await access.delivered(KEY_B), 'blocked', answer);
    assert.deepEqual(installer.calls, [['revoke', KEY_OLD, { delegated: true }]], `${answer}: no enroll`);
    assert.deepEqual(pending.keys, [KEY_OLD], answer);
    // Only a refusal elevation fixes offers Approve new phone, which carries the revoke.
    const elevate = answer === 'delegation-denied' || answer === 'delegation-disabled';
    assert.deepEqual(await access.readiness(), { state: elevate ? 'needs-enroll' : 'ready' }, answer);
  }

  // A thrown revoke: no enroll, the revoke stays owed.
  const throwing = fakeInstaller({
    state: 'installed',
    answers: {
      revoke: () => {
        throw new Error('spawn failed');
      },
    },
  });
  const pending = memoryPending([KEY_OLD]);
  await assert.rejects(pcAccessOver(throwing, { pending }).delivered(KEY_B), /spawn failed/);
  assert.deepEqual(throwing.calls, [['revoke', KEY_OLD, { delegated: true }]]);
  assert.deepEqual(pending.keys, [KEY_OLD]);
});

test('unknown revocations block every enroll until an elevated install with the current pairings resolves them', async () => {
  const installer = fakeInstaller({ state: 'installed', enrolled: [KEY_A] });
  const pending = memoryPending([KEY_OLD], 7);
  const access = pcAccessOver(installer, { pending });
  assert.equal(await access.delivered(KEY_B), 'blocked');
  assert.deepEqual(installer.calls, [], 'no delegated enroll');
  assert.deepEqual(await access.readiness(), { state: 'revocations-unknown' });

  // Approve reinstalls (never a bare enroll) with exactly the paired keys.
  assert.deepEqual(await access.approve(), { outcome: 'done' });
  assert.deepEqual(installer.calls, [['install', [KEY_A, KEY_B], { revoke: [KEY_OLD] }]]);
  assert.deepEqual([pending.keys, pending.unknown], [[], null]);
  assert.deepEqual(await access.readiness(), { state: 'ready' });

  // A loss recorded while the install ran is not resolved by it.
  const racing = memoryPending([], 7);
  const slow = deferred();
  const installing = fakeInstaller({ state: 'installed', answers: { install: () => slow.promise } });
  const approval = pcAccessOver(installing, { pending: racing }).approve();
  await new Promise((resolve) => setImmediate(resolve));
  await racing.markUnknown();
  slow.resolve('installed');
  await approval;
  assert.notEqual(racing.unknown, null);
});

test('the delegated outcomes are logged by name, like failed for the pending revokes', async (t) => {
  const errors = quietErrors(t);
  for (const answer of ['delegation-denied', 'service-unreachable']) {
    const installer = fakeInstaller({ state: 'installed', enrolled: [KEY_A], answers: { revoke: answer } });
    const pending = memoryPending([KEY_A]);
    const access = pcAccessOver(installer, { pending });
    assert.equal(await access.revokeOwed(), 'pending', answer);
    assert.equal(await access.delivered(KEY_B), 'blocked', answer);
    assert.deepEqual(pending.keys, [KEY_A]);
    const enrolling = fakeInstaller({ state: 'installed', answers: { delegatedEnroll: answer } });
    assert.equal(await pcAccessOver(enrolling).delivered(KEY_B), 'failed', answer);
  }
  const logged = errors.mock.calls.map((call) => String(call.arguments[0]));
  for (const answer of ['delegation-denied', 'service-unreachable']) {
    for (const step of ['delegated pending revoke', 'delegated enroll']) {
      assert.ok(
        logged.some((line) => line.includes(`${step}: ${answer}`)),
        `${step}: ${answer}`
      );
    }
  }
});

test('unpair: the revoke is recorded durably before the unpair resolves and kept through every outcome but revoked', async (t) => {
  quietErrors(t);
  const unpairOver = async (installer, pending) => {
    const access = pcAccessOver(installer, { pending });
    const recordedAtUnpair = [];
    const info = await unpairWithPcAccess(access, 'a', async () => {
      recordedAtUnpair.push(...pending.keys);
      return 'INFO';
    });
    assert.equal(info, 'INFO');
    return { recordedAtUnpair, access };
  };
  const settle = ticks;

  // Confirmed revoked: recorded first, removed only after.
  const installed = fakeInstaller({ state: 'installed', enrolled: [KEY_A] });
  const pending = memoryPending();
  const { recordedAtUnpair } = await unpairOver(installed, pending);
  assert.deepEqual(recordedAtUnpair, [KEY_A], 'persisted before the unpair completes');
  await settle();
  assert.deepEqual(installed.calls, [['revoke', KEY_A, { delegated: true }]]);
  assert.deepEqual(pending.keys, []);

  // The revoke still running when the unpair answers (a quit now loses nothing).
  const slow = deferred();
  const running = fakeInstaller({ state: 'installed', enrolled: [KEY_A], answers: { revoke: () => slow.promise } });
  const kept = memoryPending();
  await unpairOver(running, kept);
  assert.deepEqual(kept.keys, [KEY_A]);
  slow.resolve('revoked');
  await settle();
  assert.deepEqual(kept.keys, []);

  // Unavailable, not installed, another account, every refusal, a throw: kept.
  const cases = [
    ...['unavailable', 'not-installed', 'other-user'].map((state) => fakeInstaller({ state })),
    ...['failed', 'delegation-disabled', 'delegation-denied', 'service-unreachable', 'in-progress'].map((revoke) =>
      fakeInstaller({ state: 'installed', enrolled: [KEY_A], answers: { revoke } })
    ),
    fakeInstaller({
      state: 'installed',
      enrolled: [KEY_A],
      answers: {
        revoke: () => {
          throw new Error('spawn failed');
        },
      },
    }),
  ];
  for (const [index, installer] of cases.entries()) {
    const owed = memoryPending();
    await unpairOver(installer, owed);
    await settle();
    assert.deepEqual(owed.keys, [KEY_A], `case ${index}`);
  }

  // The recorded revoke rides the next install.
  const later = fakeInstaller();
  const waiting = memoryPending([KEY_A]);
  await pcAccessOver(later, { phones: [record('b', KEY_B)], pending: waiting }).approve();
  assert.deepEqual(later.calls, [['install', [KEY_B], { revoke: [KEY_A] }]]);
  assert.deepEqual(waiting.keys, []);
});

test('unpair: an unreadable key records unknown revocations; an unrecordable revoke blocks the unpair; a thrown unpair keeps the record', async (t) => {
  quietErrors(t);
  const pending = memoryPending();
  const service = fakeService();
  service.down = true;
  const access = pcAccessOver(fakeInstaller({ state: 'installed' }), { pending, service });
  let unpaired = 0;
  await unpairWithPcAccess(access, 'a', async () => {
    assert.notEqual(pending.unknown, null, 'recorded before the unpair');
    unpaired++;
  });
  assert.equal(unpaired, 1);

  const unwritable = memoryPending();
  unwritable.add = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(
    unpairWithPcAccess(pcAccessOver(fakeInstaller(), { pending: unwritable }), 'a', async () => unpaired++),
    /phone was not removed.*disk full/
  );
  assert.equal(unpaired, 1, 'the unpair did not run');

  // The unpair itself failed: the record stays (fail-closed), nothing is revoked yet.
  const installer = fakeInstaller({ state: 'installed', enrolled: [KEY_A] });
  const kept = memoryPending();
  await assert.rejects(
    unpairWithPcAccess(pcAccessOver(installer, { pending: kept }), 'a', async () => {
      throw new Error('relay refused');
    }),
    /relay refused/
  );
  await ticks();
  assert.deepEqual(kept.keys, [KEY_A]);
  assert.deepEqual(installer.calls, []);

  // A device that never delivered a key unpairs as before.
  const plain = memoryPending();
  await unpairWithPcAccess(pcAccessOver(fakeInstaller(), { pending: plain }), 'x', async () => {});
  assert.deepEqual([plain.keys, plain.unknown], [[], null]);
});

test('an unpair in flight holds every delivery: its pending revoke is not consumed early and the phone is not enrolled again', async (t) => {
  quietErrors(t);
  // A enrolled, B paired but missing. A's unpair is recorded and held unresolved.
  const installer = fakeInstaller({ state: 'installed', enrolled: [KEY_A] });
  const pending = memoryPending();
  const service = fakeService({ phones: [record('a', KEY_A), record('b', KEY_B)] });
  const access = pcAccessOver(installer, { pending, service });
  const hold = deferred();
  const unpairing = unpairWithPcAccess(access, 'a', () => hold.promise);
  await ticks();
  assert.deepEqual(pending.keys, [KEY_A], 'recorded');

  // Deliver B, then A (its pairing still exists): neither runs inside the unpair.
  const deliveredB = access.delivered(KEY_B);
  const deliveredA = access.delivered(KEY_A);
  await ticks();
  assert.deepEqual(installer.calls, [], 'no drain and no enroll while the unpair is in flight');
  assert.deepEqual(pending.keys, [KEY_A]);

  // The unpair completes (the service marked A unpaired) while the service is unavailable.
  service.phones = [record('a', KEY_A, true), record('b', KEY_B)];
  installer.installState = 'unavailable';
  hold.resolve('INFO');
  assert.equal(await unpairing, 'INFO');
  assert.equal(await deliveredB, 'nothing');
  assert.equal(await deliveredA, 'nothing');
  assert.deepEqual(installer.calls, []);
  assert.deepEqual(pending.keys, [KEY_A], 'the revoke is still owed');

  // Back: A is never enrolled again; B's delivery revokes A first, then enrolls B.
  installer.installState = 'installed';
  assert.equal(await access.delivered(KEY_A), 'nothing');
  assert.equal(await access.delivered(KEY_B), 'enrolled');
  assert.equal(await access.delivered(KEY_A), 'nothing', 'not paired now');
  assert.deepEqual(installer.calls, [
    ['revoke', KEY_A, { delegated: true }],
    ['enroll', KEY_B, { delegated: true }],
  ]);
  assert.ok(!installer.enrolled.has(KEY_A));
  assert.deepEqual(pending.keys, []);
});

test('a phone’s replaced key is revoked before its new one enrolls (the real paired-device record)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-pc-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = createRemoteControllerKeys(await loadRemoteClientCache(dir));
  const installer = fakeInstaller({ state: 'installed' });
  const access = createPcAccess({
    installer,
    pending: memoryPending(),
    keys: async () => controller.list(),
    owed: async () => controller.owed(),
    settleOwed: (keys, unknown) => controller.settleOwed([keys, unknown]),
  });
  await controller.deliver('phone-a', KEY_A);
  assert.equal(await access.delivered(KEY_A), 'enrolled');
  // The phone cleared its app data and delivers a new key under the same pairing.
  await controller.deliver('phone-a', KEY_B);
  assert.equal(await access.delivered(KEY_B), 'enrolled');
  assert.deepEqual(installer.calls, [
    ['enroll', KEY_A, { delegated: true }],
    ['revoke', KEY_A, { delegated: true }],
    ['enroll', KEY_B, { delegated: true }],
  ]);
  assert.deepEqual([...installer.enrolled], [KEY_B]);
  assert.deepEqual(controller.owed(), { keys: [], unknown: 0 }, 'taken over, then settled');
  // A late delivery of the old key never enrolls it again.
  assert.equal(await access.delivered(KEY_A), 'nothing');
  assert.equal(installer.calls.length, 3);
});

test('only a phone paired now is enrolled', async () => {
  const installer = fakeInstaller({ state: 'installed' });
  const access = pcAccessOver(installer, { phones: [record('a', KEY_A, true)] });
  assert.equal(await access.delivered(KEY_A), 'nothing', 'its unpair is recorded');
  assert.equal(await access.delivered(KEY_OLD), 'nothing', 'no pairing delivered it');
  assert.deepEqual(installer.calls, []);
});

test('the service’s owed revocations are taken over before any enrollment, approval or revoke, and block enrollment', async (t) => {
  quietErrors(t);
  // Taken over durably, then settled there; drained before the enroll.
  const installer = fakeInstaller({ state: 'installed' });
  const pending = memoryPending();
  const service = fakeService({ owed: [KEY_OLD] });
  const access = pcAccessOver(installer, { pending, service });
  assert.equal(await access.delivered(KEY_B), 'enrolled');
  assert.deepEqual(service.settled, [[[KEY_OLD], 0]]);
  assert.deepEqual(installer.calls, [
    ['revoke', KEY_OLD, { delegated: true }],
    ['enroll', KEY_B, { delegated: true }],
  ]);
  assert.deepEqual(pending.keys, []);

  // Its revoke does not run: blocked, kept here, gone from the service.
  const refusing = fakeInstaller({ state: 'installed', answers: { revoke: 'service-unreachable' } });
  const kept = memoryPending();
  const owing = fakeService({ owed: [KEY_OLD] });
  assert.equal(await pcAccessOver(refusing, { pending: kept, service: owing }).delivered(KEY_B), 'blocked');
  assert.deepEqual([kept.keys, owing.owedKeys], [[KEY_OLD], []]);

  // Unknown in the service: the row says so before it is taken over, and nothing enrolls.
  const lost = fakeInstaller({ state: 'installed' });
  const unknownService = fakeService({ unknown: 5 });
  const lostPending = memoryPending();
  const lostAccess = pcAccessOver(lost, { pending: lostPending, service: unknownService });
  assert.deepEqual(await lostAccess.readiness(), { state: 'revocations-unknown' });
  assert.equal(await lostAccess.delivered(KEY_B), 'blocked');
  assert.notEqual(lostPending.unknown, null);
  assert.equal(unknownService.unknown, 0, 'settled with the marker it read');
  assert.deepEqual(lost.calls, []);

  // The service cannot be asked: nothing enrolls.
  const offline = fakeInstaller({ state: 'installed' });
  const down = fakeService();
  down.down = true;
  await assert.rejects(pcAccessOver(offline, { service: down }).delivered(KEY_B), /service down/);
  assert.deepEqual(offline.calls, []);

  // Approve takes them over first: an owed key is revoked, never installed.
  const fresh = fakeInstaller();
  await pcAccessOver(fresh, { service: fakeService({ owed: [KEY_A] }) }).approve();
  assert.deepEqual(fresh.calls, [['install', [KEY_B], { revoke: [KEY_A] }]]);

  // The owed event's revoke: taken over, revoked, settled.
  const revoking = fakeInstaller({ state: 'installed', enrolled: [KEY_OLD] });
  const fromService = fakeService({ owed: [KEY_OLD] });
  const drained = memoryPending();
  assert.equal(await pcAccessOver(revoking, { pending: drained, service: fromService }).revokeOwed(), 'revoked');
  assert.deepEqual(revoking.calls, [['revoke', KEY_OLD, { delegated: true }]]);
  assert.deepEqual([drained.keys, fromService.owedKeys], [[], []]);

  // Readiness never counts an owed key as a missing phone.
  const missing = fakeInstaller({
    state: 'installed',
    enrolled: [KEY_B],
    answers: { delegatedEnroll: 'delegation-denied' },
  });
  const owedA = fakeService({ phones: [record('a', KEY_A), record('b', KEY_B)] });
  const readinessAccess = pcAccessOver(missing, { service: owedA });
  await readinessAccess.delivered(KEY_A);
  assert.deepEqual(await readinessAccess.readiness(), { state: 'needs-enroll' });
  owedA.owedKeys = [KEY_A];
  assert.deepEqual(await readinessAccess.readiness(), { state: 'ready' });
});

test('pending file: survives a restart; missing is empty; entries bounded by the pairing cap', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-pc-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'pc-access-revokes.json');
  const store = pendingRevokesFile(file);
  assert.deepEqual(await store.read(), { keys: [], unknown: null });
  await store.add(KEY_A);
  await store.add(KEY_B);
  await store.add(KEY_A);
  assert.deepEqual(await pendingRevokesFile(file).read(), { keys: [KEY_A, KEY_B], unknown: null });
  await store.settle([KEY_A]);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { keys: [KEY_B], unknown: null });

  // Past the cap the revocations become unknown rather than dropped.
  const capped = join(dir, 'capped.json');
  const full = await Promise.all(Array.from({ length: MAX_REMOTE_SCREEN_HELPER_KEYS }, newKey));
  await writeFile(capped, JSON.stringify({ keys: full, unknown: null }));
  const big = pendingRevokesFile(capped);
  await big.add(KEY_OLD);
  const after = await pendingRevokesFile(capped).read();
  assert.equal(after.keys.length, MAX_REMOTE_SCREEN_HELPER_KEYS);
  assert.ok(!after.keys.includes(KEY_OLD));
  assert.notEqual(after.unknown, null);
});

test('pending file: corrupt, wrong-shaped or unreadable records are set aside as unknown revocations, resolved only by the install that read them', async (t) => {
  quietErrors(t);
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-pc-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of [
    ['corrupt', '{not json'],
    ['old-shape', JSON.stringify([KEY_A])],
    ['bad-key', JSON.stringify({ keys: ['nope'], unknown: null })],
  ]) {
    const file = join(dir, `${name}.json`);
    await writeFile(file, text);
    const state = await pendingRevokesFile(file).read();
    assert.deepEqual(state.keys, [], name);
    assert.notEqual(state.unknown, null, name);
    // The damaged file is kept aside; the unknown state survives a restart.
    const aside = (await readdir(dir)).filter((entry) => entry.startsWith(`${name}.json.damaged-`));
    assert.equal(aside.length, 1, name);
    assert.equal(await readFile(join(dir, aside[0]), 'utf8'), text);
    const reread = pendingRevokesFile(file);
    assert.deepEqual(await reread.read(), state, `${name} after a restart`);
    // A later loss is not resolved by an install that read the earlier marker.
    await reread.markUnknown();
    await reread.settle([], state.unknown);
    const marker = (await reread.read()).unknown;
    assert.ok(marker !== null && marker !== state.unknown, name);
    await reread.settle([], marker);
    assert.deepEqual(await pendingRevokesFile(file).read(), { keys: [], unknown: null }, name);
  }

  // Unreadable (here a directory where the file should be): unknown, left in place.
  const unreadable = join(dir, 'unreadable.json');
  await mkdir(unreadable);
  assert.notEqual((await pendingRevokesFile(unreadable).read()).unknown, null);
});

test('pending file: the in-memory record moves only after its write succeeded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-pc-access-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parent = join(dir, 'sub');
  const file = join(parent, 'pc-access-revokes.json');
  const store = pendingRevokesFile(file);
  assert.deepEqual(await store.read(), { keys: [], unknown: null });
  await writeFile(parent, 'a file where the directory goes');
  await assert.rejects(store.add(KEY_A));
  assert.deepEqual(await store.read(), { keys: [], unknown: null }, 'not recorded in memory');
  await rm(parent);
  await store.add(KEY_A);
  assert.deepEqual(await pendingRevokesFile(file).read(), { keys: [KEY_A], unknown: null }, 're-adding writes');
});
