import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import {
  SessionAddressError,
  assertNotAddressed,
  assertResumeTarget,
  beginCanonicalClose,
  bindSessionAddress,
  finishCanonicalClose,
  initSessionAddress,
  markTerminal,
} from './session-address.mjs';

// Deleting a session forgets its search index, which boots the real postgres
// memory runtime in the data dir; that server outlived this file and held the
// test runner's scratch root. The index is outside this suite's subject.
const forgotten = [];
mock.module('../runtime/session-search/session-search-ingest.mjs', {
  namedExports: {
    forgetSessionSearch: async (id) => {
      forgotten.push(id);
    },
  },
});
const { sessionAdopter } = await import('./boot/infrastructure.mjs');
const { createContextSwitch } = await import('./lifecycle/session-switch/context-switch.mjs');
const { createSessionResume } = await import('./lifecycle/session-switch/resume.mjs');
const { createSessionDelete } = await import('./lifecycle/session-switch/session-delete.mjs');

function addressedRuntime(id = 'sess_a') {
  const rt = { session: null, reservedSessionId: null };
  initSessionAddress(rt);
  bindSessionAddress(rt, id);
  const calls = [];
  const deps = {
    rt,
    calls,
    getSession: () => rt.session,
    setSession: (v) => {
      calls.push(['setSession', v?.id ?? null]);
      rt.session = v;
    },
    getAddressedSessionId: () => rt.addressedSessionId,
    assertNotAddressed: (operation) => assertNotAddressed(rt, operation),
    assertResumeTarget: (target) => assertResumeTarget(rt, target),
    markAddressTerminal: () => markTerminal(rt),
    createCurrentSession: async () => calls.push(['createCurrentSession']),
    invalidateContextStatusCache() {},
    invalidatePreSessionToolSurface() {},
    clearRoutePreparation() {},
    getDesktopSession: () => null,
    getMode: () => 'full',
    getMcpScopeId: () => null,
  };
  return deps;
}

test('the adopter ignores late adoption of a fenced session, refuses a retarget and still accepts null', () => {
  const rt = { session: null, reservedSessionId: null };
  initSessionAddress(rt);
  bindSessionAddress(rt, 'sess_a');
  const adopt = sessionAdopter({
    rt,
    bindRuntimeNotificationSession() {},
    goalRuntime: null,
    applyResolvedCwd() {},
  });
  adopt({ id: 'sess_a' });
  assert.equal(rt.session.id, 'sess_a');
  assert.throws(() => adopt({ id: 'sess_b' }), SessionAddressError);
  assert.equal(rt.session.id, 'sess_a', 'a refused retarget leaves the address intact');

  finishCanonicalClose(rt, beginCanonicalClose(rt, 'sess_a'), true);
  adopt(null);
  assert.equal(rt.session, null);
  // A stale continuation (clear / rewind / compaction / turn settle) resolving
  // after the close hands the old object back: it must stay unadopted.
  adopt({ id: 'sess_a' });
  assert.equal(rt.session, null);
});

test('newSession and switchContext refuse to re-key an addressed runtime before closing anything', async () => {
  const deps = addressedRuntime();
  deps.rt.session = { id: 'sess_a' };
  const closed = [];
  const { switchContext, newSession } = createContextSwitch(deps, {
    ingestSessionIntoMemory() {},
    closeSurfaceSession: (...args) => closed.push(args),
    releaseSessionWork() {},
  });
  await assert.rejects(newSession(), SessionAddressError);
  await assert.rejects(switchContext({ cwd: 'x' }), SessionAddressError);
  assert.deepEqual(closed, [], 'the open conversation was not closed by a refused transition');
  assert.equal(deps.rt.session.id, 'sess_a');
  assert.deepEqual(deps.calls, []);
});

test('resume of another id is refused before the previous conversation is retired; its own id and terminal state are checked', async () => {
  const deps = addressedRuntime();
  deps.rt.session = { id: 'sess_a', messages: [] };
  const resumed = [];
  deps.mgr = {
    resumeSession: async (id) => {
      resumed.push(id);
      return null;
    },
  };
  const { resume } = createSessionResume(deps, {
    ingestSessionIntoMemory() {},
    closeSurfaceSession() {
      assert.fail('previous conversation must not be retired');
    },
  });
  await assert.rejects(resume('sess_other'), SessionAddressError);
  assert.deepEqual(resumed, []);
  await resume('sess_a');
  assert.deepEqual(resumed, ['sess_a']);
  markTerminal(deps.rt);
  await assert.rejects(resume('sess_a'), /closed/);
});

test('deleting the current conversation of an addressed runtime leaves it terminal instead of minting a replacement', async () => {
  const deps = addressedRuntime();
  deps.rt.session = { id: 'sess_a' };
  deps.mgr = {
    closeSession: () => true,
    deleteSession: () => true,
  };
  // Deletion proves availability from the session's own stored record.
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-address-delete-'));
  const previousDataDir = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dataDir;
  try {
    mkdirSync(join(dataDir, 'sessions'));
    writeFileSync(
      join(dataDir, 'sessions', 'sess_a.json'),
      JSON.stringify({ id: 'sess_a', owner: 'user', messages: [{ role: 'user', content: 'hello' }] })
    );
    const { deleteSession } = createSessionDelete(deps, { cancelBackgroundTasks() {} });
    assert.equal(await deleteSession('sess_a'), true);
  } finally {
    if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
  assert.equal(deps.rt.session, null);
  assert.equal(deps.rt.admission, 'terminal');
  assert.equal(deps.rt.addressedSessionId, 'sess_a');
  assert.deepEqual(forgotten, ['sess_a']);
  assert.equal(
    deps.calls.some(([name]) => name === 'createCurrentSession'),
    false
  );
});
