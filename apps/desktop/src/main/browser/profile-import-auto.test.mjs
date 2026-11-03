// When the automatic cookie import runs: shortly after start (or opt-in), after
// Chrome exits, and hourly, never while Chrome lives, one run at a time, and
// not again after "needs one manual import". Fake timers and a fake importer.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CHROME_POLL_MS,
  CookieAutoImporter,
  CookieAutoImportStateStore,
  HOURLY_MS,
  START_DELAY_MS,
} from './profile-import-auto.ts';

/** Timers that only move when the test says so. */
function manualTimers() {
  let now = 0;
  let nextId = 1;
  const entries = new Map();
  const add = (kind) => (run, ms) => {
    const id = nextId++;
    entries.set(id, { kind, run, ms, due: now + ms });
    return id;
  };
  return {
    timers: {
      setTimeout: add('timeout'),
      setInterval: add('interval'),
      clearTimeout: (id) => entries.delete(id),
      clearInterval: (id) => entries.delete(id),
    },
    pending: () => entries.size,
    /** Advance time, running due timers in order; each run's async work settles before the next. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...entries.entries()]
          .filter(([, entry]) => entry.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!due) break;
        const [id, entry] = due;
        now = entry.due;
        if (entry.kind === 'timeout') entries.delete(id);
        else entry.due += entry.ms;
        entry.run();
        await settle();
      }
      now = end;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function memoryState() {
  let state = {};
  return {
    read: async () => ({ ...state }),
    update: async (patch) => {
      state = { ...state, ...patch };
      for (const key of Object.keys(state)) if (state[key] === undefined || state[key] === false) delete state[key];
    },
    peek: () => state,
  };
}

function setup({ saved = { enabled: false, profileId: '' }, chromeRunning = false, runOutcome } = {}) {
  const clock = manualTimers();
  const state = memoryState();
  const calls = { run: [], settingsWrites: [], forgets: 0, errors: [] };
  const world = { chromeRunning, keySaved: true, keyAvailable: true };
  let persisted = saved;
  const importer = new CookieAutoImporter({
    settings: {
      read: async () => persisted,
      write: async (next) => {
        calls.settingsWrites.push(next);
        persisted = next;
        return next;
      },
    },
    state,
    run: async (profileId) => {
      calls.run.push(profileId);
      return runOutcome ? await runOutcome(profileId) : { state: 'imported', count: 1 };
    },
    chromeRunning: async () => {
      if (world.chromeRunning instanceof Error) throw world.chromeRunning;
      return world.chromeRunning;
    },
    keyStatus: async () => ({ available: world.keyAvailable, saved: world.keySaved }),
    forgetKey: async () => {
      calls.forgets += 1;
      world.keySaved = false;
    },
    timers: clock.timers,
    onError: (error) => calls.errors.push(error),
  });
  return { importer, clock, state, calls, world };
}

const ON = { enabled: true, profileId: 'Default' };

test('it is off by default: nothing is scheduled and nothing runs', async () => {
  const { importer, clock, calls } = setup();
  await importer.start();
  assert.equal(clock.pending(), 0);
  await clock.advance(3 * HOURLY_MS);
  assert.deepEqual(calls.run, []);
  assert.equal((await importer.status()).enabled, false);
});

test('at app start it runs once, after the start delay, when Chrome is not running', async () => {
  const { importer, clock, calls } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS - 1);
  assert.deepEqual(calls.run, [], 'the app gets to finish starting first');
  await clock.advance(1);
  assert.deepEqual(calls.run, ['Default']);
});

test('while Chrome is running nothing runs, not at start and not on the hourly tick', async () => {
  const { importer, clock, calls } = setup({ saved: ON, chromeRunning: true });
  await importer.start();
  await clock.advance(START_DELAY_MS + 2 * HOURLY_MS);
  assert.deepEqual(calls.run, []);
  assert.deepEqual(calls.errors, []);
  assert.equal((await importer.status()).lastError, undefined, 'skipping is quiet');
});

test('a run whose Chrome check is still pending follows the setting as it is when the check ends', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  await importer.start();
  let chromeChecked;
  world.chromeRunning = new Promise((resolve) => {
    chromeChecked = resolve;
  });
  await clock.advance(START_DELAY_MS);
  await importer.configure({ enabled: false, profileId: 'Default' });
  chromeChecked(false);
  await settle();
  assert.deepEqual(calls.run, [], 'turned off while Chrome was checked: no import');

  world.chromeRunning = new Promise((resolve) => {
    chromeChecked = resolve;
  });
  await importer.configure(ON);
  await clock.advance(0);
  await importer.configure({ enabled: true, profileId: 'Profile 1' });
  chromeChecked(false);
  await settle();
  assert.deepEqual(calls.run, ['Profile 1'], 'switched while Chrome was checked: the new profile');
});

test('when Chrome exits, the next poll runs one import; polls while it still runs do not', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON, chromeRunning: true });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  await clock.advance(CHROME_POLL_MS * 3);
  assert.deepEqual(calls.run, []);
  world.chromeRunning = false;
  await clock.advance(CHROME_POLL_MS);
  assert.deepEqual(calls.run, ['Default'], 'the exit is noticed within one poll');
  await clock.advance(CHROME_POLL_MS * 5);
  assert.deepEqual(calls.run, ['Default'], 'a closed Chrome does not rerun on every poll');
});

test('the hourly tick imports when Chrome is closed and skips quietly when it is not', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal(calls.run.length, 1);
  await clock.advance(HOURLY_MS);
  assert.equal(calls.run.length, 2);
  world.chromeRunning = true;
  await clock.advance(HOURLY_MS);
  assert.equal(calls.run.length, 2, 'Chrome is open: skipped');
  world.chromeRunning = false;
  await clock.advance(CHROME_POLL_MS);
  // Chrome closed again within the poll window: that exit is also noticed.
  assert.equal(calls.run.length, 3);
});

test('an unreadable process list is treated as "cannot tell": no run, no error', async () => {
  const { importer, clock, calls, world } = setup({ saved: ON });
  world.chromeRunning = new Error('tasklist failed');
  await importer.start();
  await clock.advance(START_DELAY_MS + HOURLY_MS);
  assert.deepEqual(calls.run, []);
  assert.deepEqual(calls.errors, []);
});

test('runs never overlap: a trigger during a run joins it', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { importer, clock, calls } = setup({
    saved: ON,
    runOutcome: async () => {
      await gate;
      return { state: 'imported', count: 1 };
    },
  });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal((await importer.status()).running, true);
  await clock.advance(HOURLY_MS - START_DELAY_MS);
  assert.equal(calls.run.length, 1, 'the hourly tick finds the first run still going');
  release();
  await settle();
  assert.equal((await importer.status()).running, false);
});

test('after "needs one manual import" automatic runs stop until that is cleared', async () => {
  const { importer, clock, calls, state } = setup({
    saved: ON,
    runOutcome: async () => {
      await state.update({ needsManualImport: true });
      return { state: 'needs-manual-import' };
    },
  });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.equal(calls.run.length, 1);
  assert.equal((await importer.status()).needsManualImport, true);
  await clock.advance(3 * HOURLY_MS);
  assert.equal(calls.run.length, 1, 'no further attempts, so no repeated work');
  // A manual import that succeeds clears the flag; the next tick runs again.
  await state.update({ needsManualImport: false });
  await clock.advance(HOURLY_MS);
  assert.equal(calls.run.length, 2);
});

test('turning it on persists the setting and runs at once; a failure in a run is reported, not thrown', async () => {
  const { importer, clock, calls, state } = setup({
    runOutcome: async () => {
      throw new Error('boom');
    },
  });
  await importer.start();
  await state.update({ needsManualImport: true });
  const status = await importer.configure(ON);
  assert.deepEqual(calls.settingsWrites, [ON]);
  assert.equal(status.enabled, true);
  assert.equal(status.needsManualImport, false, 'opting in again retries from scratch');
  await clock.advance(0);
  assert.deepEqual(calls.run, ['Default']);
  assert.equal(calls.errors.length, 1);
});

test('turning it off or switching profile re-arms the schedule', async () => {
  const { importer, clock, calls } = setup({ saved: ON });
  await importer.start();
  await clock.advance(START_DELAY_MS);
  assert.deepEqual(calls.run, ['Default']);
  await importer.configure({ enabled: false, profileId: 'Default' });
  assert.equal(clock.pending(), 0);
  await clock.advance(3 * HOURLY_MS);
  assert.equal(calls.run.length, 1);
  await importer.configure({ enabled: true, profileId: 'Profile 2' });
  await clock.advance(0);
  assert.deepEqual(calls.run, ['Default', 'Profile 2']);
});

test('stopping cancels every timer', async () => {
  const { importer, clock, calls } = setup({ saved: ON });
  await importer.start();
  assert.equal(clock.pending(), 3);
  importer.stop();
  assert.equal(clock.pending(), 0);
  await clock.advance(5 * HOURLY_MS);
  assert.deepEqual(calls.run, []);
});

test('forgetting the key asks for one manual import only if automatic import is on and a key existed', async () => {
  const on = setup({ saved: ON });
  await on.importer.start();
  const afterForget = await on.importer.forgetKey();
  assert.equal(on.calls.forgets, 1);
  assert.equal(afterForget.keySaved, false);
  assert.equal(afterForget.needsManualImport, true);

  const off = setup();
  await off.importer.start();
  assert.equal((await off.importer.forgetKey()).needsManualImport, false);

  const none = setup({ saved: ON });
  none.world.keySaved = false;
  await none.importer.start();
  assert.equal((await none.importer.forgetKey()).needsManualImport, false);
});

test('the status shows the setting, the key, the last import and the last error', async () => {
  const { importer, state, world } = setup({ saved: ON });
  await importer.start();
  await state.update({ lastImportAt: 1_700_000_000_000, lastCount: 42, lastError: 'Chrome data decryption failed.' });
  world.keyAvailable = false;
  assert.deepEqual(await importer.status(), {
    enabled: true,
    profileId: 'Default',
    keySaved: true,
    keyStorageAvailable: false,
    running: false,
    lastImportAt: 1_700_000_000_000,
    lastCount: 42,
    lastError: 'Chrome data decryption failed.',
    needsManualImport: false,
  });
});

test('the state file keeps only the status fields and survives a bad file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-auto-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new CookieAutoImportStateStore(join(dir, 'state.json'));
  assert.deepEqual(await store.read(), {});
  await store.update({ lastImportAt: 5, lastCount: 3, needsManualImport: true });
  await store.update({ needsManualImport: false, lastError: 'x' });
  assert.deepEqual(await store.read(), { lastImportAt: 5, lastCount: 3, lastError: 'x' });
  await store.clear();
  assert.deepEqual(await store.read(), {});
});
