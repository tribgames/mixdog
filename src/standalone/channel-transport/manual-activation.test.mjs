import assert from 'node:assert/strict';
import test from 'node:test';
import { createCallDispatch } from './call-dispatch.mjs';

function fixture(t, occupied = false) {
  const events = [];
  const caller = { leadPid: process.pid, cwd: '/fixture', remoteSessionId: null };
  const old = { leadPid: process.pid, cwd: '/old', remoteSessionId: 'old_session' };
  const state = {
    clients: new Map([
      ['caller', caller],
      ['old', old],
    ]),
    pointerToken: occupied ? 'old' : null,
    remoteAcquired: occupied,
    stickyRemoteFrame: occupied ? { sessionId: 'old_session' } : null,
    pinnedSessionId: occupied ? 'old_session' : null,
    closed: false,
  };
  const dispatch = createCallDispatch({
    state,
    handleCall: async (name, args) => {
      events.push(['call', name, args]);
      return { content: [{ type: 'text', text: 'accepted' }] };
    },
    log() {},
    runExclusiveBinding: (run) => run(),
    movePointer: (token) => {
      events.push(['pointer', token]);
      state.pointerToken = token;
    },
    writeRemoteStateTo: () => {
      events.push(['displaced']);
      return true;
    },
    clearRemoteIntent: () => {
      events.push(['clear']);
      state.pinnedSessionId = null;
    },
    writeRemoteIntent: (_args, id) => {
      events.push(['pin', id]);
      state.pinnedSessionId = id;
    },
    publishRemoteState: () => events.push(['publish']),
  });
  t.after(() => {
    state.closed = true;
    dispatch.close('fixture complete');
  });
  const snapshot = () => ({
    pointerToken: state.pointerToken,
    remoteAcquired: state.remoteAcquired,
    stickyRemoteFrame: state.stickyRemoteFrame,
    pinnedSessionId: state.pinnedSessionId,
    callerSessionId: caller.remoteSessionId,
    oldSessionId: old.remoteSessionId,
  });
  const call = (args, callId = 'request') =>
    dispatch.dispatchCall(
      {
        name: 'activate_channel_bridge',
        args,
        callId,
      },
      caller,
      'caller'
    );
  return { state, events, snapshot, call };
}

for (const occupied of [false, true]) {
  for (const address of [{ sessionId: 'new_session' }, { transcriptPath: '/fixture/new_session.jsonl' }]) {
    test(`automatic activation cannot claim ${occupied ? 'an occupied' : 'a vacant'} bridge via ${Object.keys(address)[0]}`, async (t) => {
      const f = fixture(t, occupied);
      const before = f.snapshot();
      const args = { active: true, claimIfVacant: true, ...address };
      const result = await f.call(args);
      assert.equal(result.claimSkipped, true);
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.events, [], 'no dispatch, pointer change, durable pin or publication');
      assert.deepEqual(await f.call(args), result, 'idempotent replay keeps the same skipped result');
      assert.deepEqual(f.events, []);
    });
  }
}

test('manual activation still takes the addressed session exactly once', async (t) => {
  const f = fixture(t, true);
  const args = { active: true, sessionId: 'new_session', transcriptPath: '/fixture/new_session.jsonl' };
  const result = await f.call(args);
  assert.equal(result.claimSkipped, undefined);
  assert.equal(f.state.pointerToken, 'caller');
  assert.equal(f.state.remoteAcquired, true);
  assert.equal(f.state.pinnedSessionId, 'new_session');
  assert.equal(f.events.filter(([kind]) => kind === 'call').length, 1);
  assert.equal(f.events.filter(([kind]) => kind === 'pin').length, 1);
  const count = f.events.length;
  assert.deepEqual(await f.call(args), result);
  assert.equal(f.events.length, count, 'replay cannot repeat activation effects');
});

test('unaddressed activation and a different session deactivation preserve the owner', async (t) => {
  const f = fixture(t, true);
  const before = f.snapshot();
  assert.equal((await f.call({ active: true }, 'unaddressed')).claimSkipped, true);
  assert.equal((await f.call({ active: false, sessionId: 'new_session' }, 'wrong-off')).releaseSkipped, true);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.events, []);
});

test('the pinned session can still explicitly deactivate the bridge', async (t) => {
  const f = fixture(t, true);
  const result = await f.call({ active: false, sessionId: 'old_session' });
  assert.equal(result.releaseSkipped, undefined);
  assert.equal(f.state.remoteAcquired, false);
  assert.equal(f.state.pinnedSessionId, null);
  assert.equal(f.state.pointerToken, null);
  assert.equal(f.events.filter(([kind]) => kind === 'clear').length, 1);
});
