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

test("deleting a deleted bot's archived chat removes the bot's remaining data and the history for good", async () => {
  const retired = new Set(['sess_home_probe']);
  const { owner, calls } = ownerWith({
    rows: () => [{ id: 'sess_home_probe' }, { id: 'sess_home_live' }],
    control: () => true,
  });
  owner.sessionMetadata.isRetired = async (id) => retired.has(id);
  const host = new SessionHostLifecycle(owner);
  await host.deleteSession('sess_home_probe');
  assert.deepEqual(
    calls.filter(([name]) => name !== 'forget' && name !== 'publish'),
    [
      ['purgeAgentDefinition', ['probe']],
      ['deleteSession', ['sess_home_probe']],
    ]
  );
  // A live bot's chat (or any other session) never purges a bot.
  calls.length = 0;
  await host.deleteSession('sess_home_live');
  assert.deepEqual(
    calls.filter(([name]) => name === 'purgeAgentDefinition'),
    []
  );
});

test('restoring a deleted bot brings its chat back out of 보관됨 before the reply', async () => {
  const marks = [];
  const owner = {
    client: {},
    callOptions: () => ({}),
    publication: { projections: new Map() },
    sessionMetadata: {
      load: async () => {},
      isRetired: async () => true,
      setRetired: async (id, value) => {
        marks.push(['retired', id, value]);
        return true;
      },
      setArchived: async (id, value) => {
        marks.push(['archived', id, value]);
        return true;
      },
    },
    publishCatalogs: async () => {},
    sessionCatalogLoaded: () => true,
    storedSessionRows: () => [],
    invokeControlResult: async (name, args) => {
      marks.push([name, args]);
      return { value: { id: 'probe', name: 'Probe' }, snapshot: null };
    },
  };
  const host = new SessionHostLifecycle(owner);
  host.republishSessionCatalog = async () => {};
  const { value } = await host.invokeCapability('restoreAgentDefinition', ['probe']);
  assert.equal(value.id, 'probe');
  assert.deepEqual(marks, [
    ['restoreAgentDefinition', ['probe']],
    ['retired', 'sess_home_probe', false],
    ['archived', 'sess_home_probe', false],
  ]);
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
