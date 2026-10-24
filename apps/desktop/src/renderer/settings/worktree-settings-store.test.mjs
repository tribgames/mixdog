import assert from 'node:assert/strict';
import test from 'node:test';

const base = { newTaskDefault: 'branch', branchPrefix: 'mixdog/', sizeWarnBytes: 1, autoCleanup: false };
// The host: its stored value, and the saves it has been sent but not yet answered.
let host = { ...base };
const calls = [];
const saves = [];
const setupListeners = new Set();
globalThis.window = {
  addEventListener: (_type, listener) => setupListeners.add(listener),
  removeEventListener: (_type, listener) => setupListeners.delete(listener),
  mixdogDesktop: {
    invokeCapability: async ({ capability, args }) => {
      calls.push(capability);
      if (capability === 'getWorktreeSettings') return { value: { ...host } };
      const answer = Promise.withResolvers();
      saves.push({ patch: args[0], ...answer });
      return answer.promise;
    },
  },
};
const store = await import('./worktree-settings-store.ts');
const settle = () => new Promise((r) => setImmediate(r));
/** Answers the oldest save the host has been sent. */
const accept = async () => {
  await settle();
  const save = saves.shift();
  host = { ...host, ...save.patch };
  save.resolve({ value: { ...host } });
  await settle();
};
const reject = async () => {
  await settle();
  saves.shift().reject(new Error('rejected'));
  await settle();
};

test('one shared load fills the cache; later loads do not refetch', async () => {
  assert.equal(store.peekWorktreeSettings(), null);
  await Promise.all([store.loadWorktreeSettings(), store.loadWorktreeSettings()]);
  await store.loadWorktreeSettings();
  assert.deepEqual(store.peekWorktreeSettings(), base);
  assert.equal(calls.filter((c) => c === 'getWorktreeSettings').length, 1);
});

test('a save shows at once and keeps the saved value; a rejected one restores', async () => {
  let notified = 0;
  store.subscribeWorktreeSettings(() => notified++);
  store.saveWorktreeSettings({ autoCleanup: true });
  assert.equal(store.peekWorktreeSettings().autoCleanup, true);
  await accept();
  assert.equal(store.peekWorktreeSettings().autoCleanup, true);
  store.saveWorktreeSettings({ branchPrefix: 'bad/' });
  assert.equal(store.peekWorktreeSettings().branchPrefix, 'bad/');
  await reject();
  assert.equal(store.peekWorktreeSettings().branchPrefix, 'mixdog/');
  // Each save shows; only the rejected one changes the page again.
  assert.equal(notified, 3);
});

test('a change made elsewhere shows on the next open, after the cached first frame', async () => {
  const before = store.peekWorktreeSettings();
  host = { ...host, branchPrefix: 'elsewhere/' };
  // Nothing re-reads on its own: the cache is what a first frame shows.
  assert.equal(store.peekWorktreeSettings().branchPrefix, before.branchPrefix);
  const stop = store.watchWorktreeSettings();
  assert.equal(store.peekWorktreeSettings().branchPrefix, before.branchPrefix);
  await settle();
  assert.equal(store.peekWorktreeSettings().branchPrefix, 'elsewhere/');
  // A read that finds nothing new keeps the same value object.
  const held = store.peekWorktreeSettings();
  await store.refreshWorktreeSettings();
  assert.equal(store.peekWorktreeSettings(), held);
  stop();
});

test('while open, an announced setup change re-reads; after it closes, none does', async () => {
  const stop = store.watchWorktreeSettings();
  await settle();
  host = { ...host, autoCleanup: !host.autoCleanup };
  for (const listener of [...setupListeners]) listener();
  await settle();
  assert.equal(store.peekWorktreeSettings().autoCleanup, host.autoCleanup);
  stop();
  assert.equal(setupListeners.size, 0);
});

test('a change announced during a read is read again, not lost', async () => {
  const readsBefore = calls.filter((c) => c === 'getWorktreeSettings').length;
  const first = store.refreshWorktreeSettings();
  host = { ...host, sizeWarnBytes: 99 };
  const second = store.refreshWorktreeSettings();
  await Promise.all([first, second]);
  await settle();
  assert.equal(store.peekWorktreeSettings().sizeWarnBytes, 99);
  assert.equal(calls.filter((c) => c === 'getWorktreeSettings').length - readsBefore, 2);
});

test('two saves that both fail roll back to the last confirmed value, not to each other', async () => {
  const confirmed = { ...store.peekWorktreeSettings() };
  store.saveWorktreeSettings({ branchPrefix: 'a/' });
  store.saveWorktreeSettings({ autoCleanup: !confirmed.autoCleanup });
  assert.equal(store.peekWorktreeSettings().branchPrefix, 'a/');
  assert.equal(store.peekWorktreeSettings().autoCleanup, !confirmed.autoCleanup);
  // The host answers one save at a time, in order.
  await settle();
  assert.equal(saves.length, 1);
  await reject();
  // A failed: its change is gone, B's still shows while it is unanswered.
  assert.equal(store.peekWorktreeSettings().branchPrefix, confirmed.branchPrefix);
  assert.equal(store.peekWorktreeSettings().autoCleanup, !confirmed.autoCleanup);
  await reject();
  assert.deepEqual(store.peekWorktreeSettings(), confirmed);
});

test('a failed save keeps the later one that succeeds', async () => {
  const confirmed = { ...store.peekWorktreeSettings() };
  store.saveWorktreeSettings({ branchPrefix: 'lost/' });
  store.saveWorktreeSettings({ sizeWarnBytes: 7 });
  await settle();
  await reject();
  await settle();
  await accept();
  assert.deepEqual(store.peekWorktreeSettings(), { ...confirmed, sizeWarnBytes: 7 });
});

test('a read that began before a confirmed save does not overwrite it', async () => {
  const late = Promise.withResolvers();
  const invoke = window.mixdogDesktop.invokeCapability;
  window.mixdogDesktop.invokeCapability = async (request) => {
    if (request.capability !== 'getWorktreeSettings') return invoke(request);
    const stale = { ...host };
    await late.promise;
    return { value: stale };
  };
  try {
    const reading = store.refreshWorktreeSettings();
    store.saveWorktreeSettings({ branchPrefix: 'saved/' });
    await settle();
    await accept();
    late.resolve();
    await reading;
    assert.equal(store.peekWorktreeSettings().branchPrefix, 'saved/');
  } finally {
    window.mixdogDesktop.invokeCapability = invoke;
  }
});
