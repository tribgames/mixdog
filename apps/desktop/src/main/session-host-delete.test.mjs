import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionHostLifecycle } from './session-host-lifecycle.ts';
import { createRemoteMethods } from './remote-methods.ts';

function ownerWith({ rows, control }) {
  const calls = [];
  const owner = {
    client: { unsubscribe: async () => {} },
    callOptions: () => ({}),
    visibleSessionIds: new Set(['s1']),
    visibleSessionSources: new Map(),
    publication: { projections: new Map([['s1', {}]]) },
    sessionMetadata: { forget: async (id) => calls.push(['forget', id]) },
    publishCatalogs: async () => calls.push(['publish']),
    listSessions: async () => rows(),
    invokeControl: async (name, args) => {
      calls.push([name, args]);
      return control();
    },
  };
  return { owner, calls };
}

test('deleting an already-deleted session resolves as a no-op and drops stale local state', async () => {
  const { owner, calls } = ownerWith({ rows: () => [], control: () => assert.fail('daemon must not be called') });
  const result = await new SessionHostLifecycle(owner).deleteSession('s1');
  assert.equal(result, null);
  assert.equal(owner.visibleSessionIds.has('s1'), false);
  assert.equal(owner.publication.projections.has('s1'), false);
  assert.deepEqual(calls, [['forget', 's1'], ['publish']]);
});

test('a session that vanishes between listing and daemon delete is a no-op', async () => {
  let listed = 0;
  const { owner } = ownerWith({
    rows: () => (listed++ === 0 ? [{ id: 's1' }] : []),
    control: () => false,
  });
  assert.equal(await new SessionHostLifecycle(owner).deleteSession('s1'), null);
});

test('a daemon "Session is not available" failure is a no-op, other failures still reject', async () => {
  const gone = ownerWith({
    rows: () => [{ id: 's1' }],
    control: () => {
      throw new Error('Session is not available.');
    },
  });
  assert.equal(await new SessionHostLifecycle(gone.owner).deleteSession('s1'), null);
  const broken = ownerWith({ rows: () => [{ id: 's1' }], control: () => false });
  await assert.rejects(new SessionHostLifecycle(broken.owner).deleteSession('s1'), /could not be deleted/);
});

test('remote deleteSession swallows a missing-session error from the host', async () => {
  const methods = createRemoteMethods({
    host: {
      async deleteSession() {
        throw new Error('Error invoking remote method: Session is not available.');
      },
    },
  });
  assert.equal(await methods.deleteSession(['sess_abc']), null);
});
