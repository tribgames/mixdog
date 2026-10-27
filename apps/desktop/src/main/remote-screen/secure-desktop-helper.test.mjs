import assert from 'node:assert/strict';
import test from 'node:test';

import { createSecureDesktopHelper, DECLINED_ON_PC } from './secure-desktop-helper.ts';

const KEY = Buffer.from([4, ...new Array(64).fill(7)]).toString('base64url');

function fakeAdapter(installed) {
  const listeners = { change: new Set(), frame: new Set(), challenge: new Set(), issue: new Set() };
  const calls = [];
  const link = { connected: false };
  const listen = (set) => (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  return {
    calls,
    listeners,
    link,
    attached: () => Object.values(listeners).reduce((sum, set) => sum + set.size, 0),
    adapter: {
      installed: () => installed,
      connected: () => link.connected,
      desktop: () => null,
      session: () => null,
      locked: () => null,
      setActive: async (active) => {
        calls.push(['active', active]);
      },
      sendInput: async (command) => {
        calls.push(['input', command.op]);
      },
      sendGrant: async (grant) => {
        calls.push(['grant', grant.epoch]);
      },
      setVideoRun: (epoch) => calls.push(['run', epoch]),
      latestFrame: () => null,
      onFrame: listen(listeners.frame),
      onDesktopChanged: listen(listeners.change),
      onGrantChallenge: listen(listeners.challenge),
      onHelperIssue: listen(listeners.issue),
      dispose: () => calls.push(['dispose']),
    },
  };
}

/** A helper whose first adapter reports `installed`; every rebuilt one is installed. */
function build({ installed = false, state = 'not-installed' } = {}) {
  const built = [];
  const asked = [];
  const installer = {
    current: state,
    result: null,
    state: async (controllerKey) => {
      asked.push(['state', controllerKey]);
      return installer.current;
    },
    request: async (controllerKey) => {
      asked.push(['request', controllerKey]);
      return installer.result;
    },
    ensureRunning: async () => {
      asked.push(['ensure-running']);
      return { installed: true, running: true };
    },
  };
  const helper = createSecureDesktopHelper({
    adapter: () => {
      const fake = fakeAdapter(built.length === 0 ? installed : true);
      built.push(fake);
      return fake.adapter;
    },
    installer,
  });
  // One session's lease; tests of several sessions take more.
  return { helper, lease: helper.lease(), built, installer, asked };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('the install request goes to the installer with the phone’s key; installed or updated rebuilds the adapter, nothing else does', async () => {
  const env = build();
  const changes = [];
  env.lease.onDesktopChanged(() => changes.push(env.lease.installed()));
  const challenges = [];
  env.lease.onGrantChallenge((challenge) => challenges.push(challenge));
  await env.lease.setActive(true);
  env.lease.setVideoRun(3);
  changes.length = 0;
  for (const outcome of ['failed', 'in-progress', 'other-user', 'unavailable']) {
    env.installer.result = { outcome, state: 'not-installed' };
    assert.equal(await env.lease.requestInstall(KEY), env.installer.result, 'the installer’s own result');
  }
  assert.equal(env.built.length, 1);
  // Each checks the state for that key first, then asks.
  assert.deepEqual(
    env.asked,
    new Array(4).fill(null).flatMap(() => [
      ['state', KEY],
      ['request', KEY],
    ])
  );
  assert.equal(env.lease.installed(), false);

  env.installer.result = { outcome: 'installed', state: 'installed' };
  await env.lease.requestInstall(KEY);
  assert.equal(env.built.length, 2, 'a fresh client: the old one read the state before the install');
  assert.deepEqual(env.built[0].calls.at(-1), ['dispose']);
  assert.equal(env.built[0].attached(), 0, 'nothing left on the old adapter');
  // The wanted run and activation go to the new one, and the sessions re-read it.
  assert.deepEqual(env.built[1].calls, [
    ['run', 3],
    ['active', true],
  ]);
  assert.deepEqual(changes, [true]);
  // Listeners stay on the helper; calls reach the new adapter.
  for (const listener of env.built[1].listeners.challenge) listener({ nonce: 'n', challenge: 'c' });
  assert.deepEqual(challenges, [{ nonce: 'n', challenge: 'c' }]);
  await env.lease.sendGrant({ challenge: 'c', epoch: 3, signature: 's' });
  await env.lease.sendInput({ op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: false });
  assert.deepEqual(env.built[1].calls.slice(2), [
    ['grant', 3],
    ['input', 'key'],
  ]);

  env.installer.result = { outcome: 'updated', state: 'installed' };
  await env.lease.requestInstall(KEY);
  assert.equal(env.built.length, 3);
  // A request another session joined ends with the same install: one rebuild.
  env.installer.result = { outcome: 'installed', state: 'installed' };
  await Promise.all([env.lease.requestInstall(KEY), env.helper.lease().requestInstall(KEY)]);
  assert.equal(env.built.length, 4);
});

test('a request that changes nothing keeps the live adapter: installed and current for that key before it', async () => {
  // Installed and current with this phone's key, and the adapter knows it.
  const env = build({ installed: true, state: 'installed' });
  await env.lease.setActive(true);
  env.installer.result = { outcome: 'installed', state: 'installed' };
  await env.lease.requestInstall(KEY);
  assert.equal(env.built.length, 1, 'no rebuild: the live adapter stays');
  assert.deepEqual(
    env.built[0].calls.filter(([op]) => op === 'dispose'),
    []
  );
  // Another phone's key (outdated for this one) that the update replaced: rebuilt.
  env.installer.current = 'outdated';
  env.installer.result = { outcome: 'updated', state: 'installed' };
  await env.lease.requestInstall(KEY);
  assert.equal(env.built.length, 2);
  // Installed before, but the adapter predates it (built before the install): rebuilt.
  const stale = build({ installed: false, state: 'installed' });
  stale.installer.result = { outcome: 'installed', state: 'installed' };
  await stale.lease.requestInstall(KEY);
  assert.equal(stale.built.length, 2);
});

test('one prompt per request and none after a refusal: a decline latches for every session until restart', async () => {
  const env = build();
  let prompts = 0;
  env.installer.request = async (controllerKey) => {
    env.asked.push(['request', controllerKey]);
    prompts += 1;
    return { outcome: 'declined', state: 'not-installed' };
  };
  assert.deepEqual(await env.lease.requestInstall(KEY), { outcome: 'declined', state: 'not-installed' });
  assert.equal(prompts, 1);
  // Two more, from two other sessions: no prompt; declined, saying why.
  const others = [env.helper.lease(), env.helper.lease()];
  for (const other of others) {
    assert.deepEqual(await other.requestInstall(KEY), {
      outcome: 'declined',
      state: 'not-installed',
      detail: DECLINED_ON_PC,
    });
  }
  assert.equal(prompts, 1, 'nothing launched after the decline');
  assert.ok(DECLINED_ON_PC.length <= 256, 'fits the status detail');
});

test('one session holds the helper: only its runs, grants, input and helper events; the hold passes on deactivation or when it ends', async () => {
  const env = build({ installed: true, state: 'installed' });
  const adapter = env.built[0];
  const [first, second] = [env.lease, env.helper.lease()];
  const heard = { first: [], second: [] };
  /** Each session's current run: a fresh one, minted, whenever it takes the hold. */
  const run = { first: null, second: null };
  for (const [name, lease] of [
    ['first', first],
    ['second', second],
  ]) {
    lease.onHold(() => {
      run[name] = lease.mintVideoRun();
      lease.setVideoRun(run[name]);
    });
    lease.onDesktopChanged(() => heard[name].push(['change', lease.ownedElsewhere()]));
    lease.onGrantChallenge((challenge) => heard[name].push(['challenge', challenge.nonce]));
    lease.onHelperIssue((code) => heard[name].push(['issue', code]));
    lease.onFrame((frame) => heard[name].push(['frame', frame.id]));
  }
  const key = { op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true };
  const challenge = (nonce, value) => {
    for (const listener of adapter.listeners.challenge) listener({ nonce, challenge: value });
  };
  second.setVideoRun(second.mintVideoRun());
  assert.deepEqual(adapter.calls, [], 'no holder: nothing declared');

  // The first to activate holds it: a fresh run declared, then activation.
  await first.setActive(true);
  assert.equal(run.first, 2, 'minted after the second’s 1: one counter for every session');
  assert.deepEqual(adapter.calls, [
    ['run', 2],
    ['active', true],
  ]);
  assert.equal(first.ownedElsewhere(), false);
  assert.equal(second.ownedElsewhere(), true);
  assert.deepEqual(heard.second, [['change', true]], 'told it is held elsewhere');

  // The second waits and can't disturb it.
  await second.setActive(true);
  second.setVideoRun(second.mintVideoRun());
  challenge('n1', 'c1');
  for (const listener of adapter.listeners.issue) listener('grant_expired');
  for (const listener of adapter.listeners.frame) listener({ id: 1 });
  assert.deepEqual(heard.first.slice(-3), [
    ['challenge', 'n1'],
    ['issue', 'grant_expired'],
    ['frame', 1],
  ]);
  assert.equal(
    heard.second.some(([kind]) => kind !== 'change'),
    false,
    'the waiting session hears no challenge, issue or frame'
  );
  await assert.rejects(second.sendGrant({ challenge: 'c1', epoch: run.first, signature: 's' }), /held by another/);
  await assert.rejects(second.sendInput(key), /held by another/);
  assert.equal(second.latestFrame(), null);
  await first.sendGrant({ challenge: 'c1', epoch: run.first, signature: 's' });
  await first.sendInput(key);
  assert.deepEqual(
    adapter.calls.slice(2),
    [
      ['grant', 2],
      ['input', 'key'],
    ],
    'only the holder’s run, grant and input'
  );

  // The holder deactivates: deactivate (revoke), the successor's fresh run,
  // then activate.
  heard.first.length = 0;
  heard.second.length = 0;
  let mark = adapter.calls.length;
  await first.setActive(false);
  assert.equal(run.second, 4);
  assert.deepEqual(adapter.calls.slice(mark), [
    ['active', false],
    ['run', 4],
    ['active', true],
  ]);
  assert.equal(second.ownedElsewhere(), false);
  assert.equal(first.ownedElsewhere(), true);
  assert.deepEqual(heard.first, [['change', true]]);
  assert.deepEqual(heard.second, [['change', false]]);
  await assert.rejects(first.sendGrant({ challenge: 'c1', epoch: run.first, signature: 's' }), /held by another/);
  challenge('n2', 'c2');
  await second.sendGrant({ challenge: 'c2', epoch: 4, signature: 's' });
  assert.deepEqual(adapter.calls.slice(mark + 3), [['grant', 4]]);

  // The first asks again and waits; the holder's session ends: it passes
  // back, again with a revoke and a fresh run.
  await first.setActive(true);
  mark = adapter.calls.length;
  second.dispose();
  assert.equal(first.ownedElsewhere(), false);
  assert.deepEqual(adapter.calls.slice(mark), [
    ['active', false],
    ['run', 5],
    ['active', true],
  ]);
  // A disposed lease is inert.
  await second.setActive(true);
  assert.equal(first.ownedElsewhere(), false);
  // The last holder lets go with nobody waiting: the helper is deactivated.
  await first.setActive(false);
  assert.deepEqual(adapter.calls.at(-1), ['active', false]);
  assert.equal(first.ownedElsewhere(), false);
});

test('the four challenges the helper still keeps (issued at 0, 2, 4 and 6 s) stay answerable; the fifth evicts the oldest', async () => {
  const env = build({ installed: true, state: 'installed' });
  const adapter = env.built[0];
  env.lease.onHold(() => env.lease.setVideoRun(1));
  const challenge = (value) => {
    for (const listener of adapter.listeners.challenge) listener({ nonce: 'n', challenge: value });
  };
  await env.lease.setActive(true);
  for (const value of ['c0', 'c2', 'c4', 'c6']) challenge(value);
  // At 6 s the helper still holds c0 (age 6 s, inclusive), so it is relayed.
  await env.lease.sendGrant({ challenge: 'c0', epoch: 1, signature: 's' });
  challenge('c8');
  challenge('c10');
  // c2 is now the oldest beyond the four kept (c4, c6, c8, c10).
  await assert.rejects(env.lease.sendGrant({ challenge: 'c2', epoch: 1, signature: 's' }), /no challenge/);
  await env.lease.sendGrant({ challenge: 'c4', epoch: 1, signature: 's' });
});

test('a handover at the same epoch still revokes: the successor’s input waits for its own grant for a new challenge', async () => {
  const env = build({ installed: true, state: 'installed' });
  const adapter = env.built[0];
  const [first, second] = [env.lease, env.helper.lease()];
  // Both sessions declare run 1: on the helper a repeated epoch alone ends nothing.
  for (const lease of [first, second]) lease.onHold(() => lease.setVideoRun(1));
  const phones = { first: [], second: [] };
  first.onGrantChallenge((challenge) => phones.first.push(challenge.challenge));
  second.onGrantChallenge((challenge) => phones.second.push(challenge.challenge));
  const challenge = (value) => {
    for (const listener of adapter.listeners.challenge) listener({ nonce: 'n', challenge: value });
  };
  const key = { op: 'key', vk: 0x41, scan: 0x1e, extended: false, down: true };

  await first.setActive(true);
  challenge('first-1');
  await first.sendGrant({ challenge: 'first-1', epoch: 1, signature: 's' });
  await first.sendInput(key);
  await second.setActive(true);

  const mark = adapter.calls.length;
  await first.setActive(false);
  assert.deepEqual(
    adapter.calls.slice(mark),
    [
      ['active', false],
      ['run', 1],
      ['active', true],
    ],
    'deactivated (the helper releases, revokes the grant and every challenge) before the run and the activation'
  );
  // The first phone's grant does not carry over at the same epoch.
  await assert.rejects(second.sendInput(key), /no grant/);
  challenge('second-1');
  assert.deepEqual(phones.second, ['second-1']);
  await assert.rejects(second.sendGrant({ challenge: 'second-1', epoch: 2, signature: 's' }), /another run/);
  await assert.rejects(second.sendInput(key), /no grant/, 'still not');
  await second.sendGrant({ challenge: 'second-1', epoch: 1, signature: 's' });
  await second.sendInput(key);
  assert.deepEqual(adapter.calls.slice(mark + 3), [
    ['grant', 1],
    ['input', 'key'],
  ]);
  // A challenge answers once.
  await assert.rejects(second.sendGrant({ challenge: 'second-1', epoch: 1, signature: 's' }), /no challenge/);
});

test('an old challenge of the previous holder is dead after the handover', async () => {
  const env = build({ installed: true, state: 'installed' });
  const adapter = env.built[0];
  const [first, second] = [env.lease, env.helper.lease()];
  for (const lease of [first, second]) lease.onHold(() => lease.setVideoRun(lease.mintVideoRun()));
  const challenge = (value) => {
    for (const listener of adapter.listeners.challenge) listener({ nonce: 'n', challenge: value });
  };
  await first.setActive(true);
  // Issued to the first phone and never answered.
  challenge('open-1');
  challenge('open-2');
  await second.setActive(true);
  await first.setActive(false);
  const run = adapter.calls.filter(([op]) => op === 'run').at(-1)[1];
  // Neither phone can use it: the successor, at its own run, nor the first.
  for (const value of ['open-1', 'open-2']) {
    await assert.rejects(second.sendGrant({ challenge: value, epoch: run, signature: 's' }), /no challenge/);
    await assert.rejects(first.sendGrant({ challenge: value, epoch: 1, signature: 's' }), /held by another/);
  }
  assert.equal(
    adapter.calls.some(([op]) => op === 'grant'),
    false,
    'nothing relayed'
  );
});

test('a check that reads installed while the adapter reports not installed rebuilds it', async () => {
  const env = build();
  assert.equal(await env.lease.installState(), 'not-installed');
  assert.equal(env.built.length, 1);
  // An install finished outside a request that saw it end.
  env.installer.current = 'installed';
  assert.equal(await env.lease.installState(KEY), 'installed');
  assert.deepEqual(env.asked.at(-1), ['state', KEY], 'relative to the phone’s key when given');
  assert.equal(env.built.length, 2);
  await env.lease.installState();
  assert.equal(env.built.length, 2, 'not again once the adapter is installed');
  // An installed adapter is not rebuilt by a check.
  const current = build({ installed: true, state: 'installed' });
  await current.lease.installState();
  assert.equal(current.built.length, 1);
});

test('ensureRunning starts a stopped service through the installer; callers together share one attempt; a connected helper needs none', async () => {
  const env = build({ installed: true, state: 'installed' });
  let finish;
  env.installer.ensureRunning = () => {
    env.asked.push(['ensure-running']);
    return new Promise((resolve) => (finish = resolve));
  };
  // Two sessions starting together.
  const first = env.lease.ensureRunning();
  const second = env.helper.lease().ensureRunning();
  assert.equal(first, second, 'one attempt');
  finish({ installed: true, running: false });
  assert.deepEqual(await first, { installed: true, running: false }, 'the installer’s own answer');
  assert.deepEqual(env.asked, [['ensure-running']]);
  // The next call is a new attempt.
  const third = env.lease.ensureRunning();
  finish({ installed: true, running: true });
  assert.deepEqual(await third, { installed: true, running: true });
  assert.equal(env.asked.length, 2);
  // Connected: the service runs; nothing is started.
  env.built[0].link.connected = true;
  assert.deepEqual(await env.lease.ensureRunning(), { installed: true, running: true });
  assert.equal(env.asked.length, 2);
});

test('dispose: the adapter goes, and a request that ends later rebuilds nothing', async () => {
  const env = build();
  let finish;
  env.installer.request = () => new Promise((resolve) => (finish = resolve));
  const pending = env.lease.requestInstall(KEY);
  // Past its state check: the request is with the installer.
  await flush();
  env.helper.dispose();
  assert.deepEqual(env.built[0].calls, [['dispose']]);
  assert.equal(env.built[0].attached(), 0);
  finish({ outcome: 'installed', state: 'installed' });
  await pending;
  env.installer.current = 'installed';
  await env.lease.installState();
  assert.equal(env.built.length, 1);
  env.helper.dispose();
  assert.deepEqual(env.built[0].calls, [['dispose']], 'once');
});
