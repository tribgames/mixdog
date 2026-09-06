import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHost } from './session-host.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('route replies cannot rewind streamed selections and baseline gaps recover without replay', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'mixdog-route-order-'));
  let host;
  let hooks;
  let configured;
  let configureCalls = 0;
  const reads = [];
  const updates = [];
  const id = 'session_route_order';
  const old = { sessionId: id, model: 'gpt-old', provider: 'openai', effort: 'low', fast: false, items: [], queued: [], busy: true };
  const selected = { ...old, model: 'gpt-new', effort: 'high', fast: true };
  let current = old;
  let revision = 1;
  const unsupported = async () => { throw new Error('unexpected call'); };
  const client = {
    list: unsupported, create: unsupported,
    async subscribe() { return { sessionId: id, revision, full: current }; },
    async unsubscribe() { return {}; },
    async read(params) {
      reads.push(params);
      return { sessionId: id, revision, full: current };
    },
    configure() {
      configureCalls += 1;
      configured = deferred();
      return configured.promise;
    },
    submit: unsupported, abort: unsupported, approve: unsupported,
    async close() {},
  };
  try {
    host = await SessionHost.create({
      userDataPath, packaged: false, resourcesPath: userDataPath, appPath: userDataPath,
    }, {
      async attachSessionClient(next) { hooks = next; return client; },
      loadProjects: unsupported, loadSessionStore: unsupported,
      loadStatuslineSegments: unsupported, executeCodeGraphTool: unsupported,
    });
    host.subscribeSessionStates((update) => updates.push(update));
    await host.setVisibleSessions([id]);
    const first = host.setModelRoute({ provider: 'openai', model: 'gpt-new' }, id);
    current = selected;
    revision = 3;
    hooks.onFrame({ type: 'session-state', sessionId: id, revision, full: current });
    configured.resolve({ sessionId: id, revision: 2, full: old });
    assert.deepEqual(await first, { ...selected, remoteEnabled: false, remoteSessionId: null });
    const count = updates.length;
    hooks.onFrame({ type: 'session-state', sessionId: id, revision: 2, baseRevision: 1, patch: { fast: false } });
    hooks.onFrame({ type: 'session-state', sessionId: id, revision: 0, full: old });
    assert.equal(updates.length, count);
    assert.equal(reads.length, 0, 'stale patches do not cause a resync');

    const second = host.setFast(false, id);
    revision = 4;
    hooks.onFrame({ type: 'session-state', sessionId: id, revision, full: current });
    revision = 5;
    current = { ...selected, fast: false };
    configured.resolve({ sessionId: id, revision, baseRevision: 3, patch: { fast: false } });
    assert.equal((await second).fast, false);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].baseRevision, null, 'a crossed baseline requests an authoritative full snapshot');
    assert.equal(configureCalls, 2, 'mutations must not be replayed');
    assert.equal(updates.at(-1).snapshot.fast, false);
  } finally {
    await host?.dispose();
    await rm(userDataPath, { recursive: true, force: true });
  }
});
