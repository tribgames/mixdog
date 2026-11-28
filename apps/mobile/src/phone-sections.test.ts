import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhoneSections } from './phone-sections.ts';
import {
  createSectionStore,
  sectionsSourceFromFoldStore as source,
} from '../../desktop/src/renderer/section-store-model.ts';

type Listener = (event: any) => void;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function client(name: string) {
  const events = new Set<Listener>();
  const changes = new Set<Listener>();
  const entries = new Map<string, any>();
  const calls: Array<{ method: string; params: any }> = [];
  const fake = {
    name,
    events,
    changes,
    entries,
    calls,
    status: { state: 'ready' },
    answer: (_method: string, _params: any): Promise<unknown> => Promise.resolve({ ok: true }),
    call(method: string, params: any) {
      calls.push({ method, params });
      return fake.answer(method, params);
    },
    on(listener: Listener) {
      events.add(listener);
      return () => {
        events.delete(listener);
      };
    },
    store: {
      sections: (section: string) => [...entries.values()].filter((entry) => entry.section === section),
      section: (section: string, key: string | null = null) => entries.get(`${section}:${key}`),
      appFeed: () => ({ epoch: name, seq: 1 }),
      subscribe(listener: Listener) {
        changes.add(listener);
        return () => {
          changes.delete(listener);
        };
      },
    },
    emit(event: any) {
      for (const listener of [...events]) listener(event);
    },
    change(change: any) {
      for (const listener of [...changes]) listener(change);
    },
    statusTo(state: string) {
      fake.status.state = state;
      fake.emit({ type: 'status', status: { state } });
    },
    notice(method: string, params: any) {
      fake.emit({ type: 'notification', notification: { method, params } });
    },
    section(value: string) {
      const entry = { section: 'config', key: 'notifications', revision: 1, value };
      entries.set('config:notifications', entry);
      fake.change({ type: 'section', section: 'config', key: 'notifications' });
    },
  };
  return fake;
}
type FakeClient = ReturnType<typeof client>;

// onClient is the real boot's handover boundary. Its first start promise may settle after a replacement already arrived.
function boot(first?: FakeClient) {
  let current = first;
  const listeners = new Set<(client: FakeClient) => void>();
  const waiting = deferred<{ client: FakeClient }>();
  return {
    listeners,
    start: () => (current ? Promise.resolve({ client: current }) : waiting.promise),
    client: () => current,
    onClient(listener: (client: FakeClient) => void) {
      listeners.add(listener);
      if (current) listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
    replace(next: FakeClient) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    settleStart(value: FakeClient) {
      waiting.resolve({ client: value });
    },
  };
}
const sections = (value: ReturnType<typeof boot>) =>
  createPhoneSections(value as unknown as Parameters<typeof createPhoneSections>[0], source);
const watchCalls = (value: FakeClient) => value.calls.filter(({ method }) => method === 'fs/watch');

test('installed phone re-pairs in the same page: all existing listeners move to the new client', async () => {
  const a = client('old');
  a.section('old settings');
  const b = client('new');
  b.section('new settings');
  const phone = boot(a);
  const api = sections(phone);
  const rendered = createSectionStore(api);
  const pushes: any[] = [],
    files: any[] = [],
    logins: any[] = [],
    lost: any[] = [];
  const stops = [
    api.subscribe((v) => pushes.push(v)),
    api.subscribeFsChanged((v) => files.push(v)),
    api.subscribeLoginUpdated((v) => logins.push(v)),
    api.subscribeLoginFeedLost((v) => lost.push(v)),
  ];
  await flush();
  a.notice('login/updated', { flowId: 'old-flow', state: 'pending' });
  const lateEvents = [...a.events],
    lateChanges = [...a.changes];
  phone.replace(b); // Installed pairing UI only removes its overlay; api and subscriber identities stay unchanged.
  assert.equal(
    rendered.get('config', 'notifications')?.value,
    'new settings',
    'the existing renderer store adopts the new client even at the same revision'
  );
  assert.equal(a.events.size + a.changes.size, 0, 'old client subscriptions released');
  assert.deepEqual(pushes.at(-2), { kind: 'replace', stage: 'commit', epoch: 'new' });
  assert.ok(
    pushes.some(
      (v) => v.kind === 'replace' && v.stage === 'chunk' && v.entries.some((e: any) => e.value === 'new settings')
    )
  );
  assert.deepEqual(await api.loginFeed('old-flow'), { state: 'pending', lost: true });
  assert.deepEqual(lost, [{ flowId: 'old-flow' }]);
  const beforeLate = [pushes.length, files.length, logins.length, lost.length];
  for (const listener of lateEvents) {
    listener({ type: 'status', status: { state: 'ready' } });
    listener({ type: 'notification', notification: { method: 'fs/changed', params: { watchId: 'stale' } } });
    listener({ type: 'notification', notification: { method: 'login/updated', params: { flowId: 'stale' } } });
  }
  for (const listener of lateChanges) listener({ type: 'appSnapshot' });
  assert.deepEqual(
    [pushes.length, files.length, logins.length, lost.length],
    beforeLate,
    'queued old callbacks cannot leak across handover'
  );
  b.section('latest');
  b.notice('fs/changed', { watchId: 'project-1', changedPaths: ['a.ts'], kind: 'write' });
  b.notice('login/updated', { flowId: 'new-flow', state: 'done' });
  assert.equal(pushes.at(-1).changes[0].entry.value, 'latest');
  assert.deepEqual(files, [{ watchId: 'project-1', changedPaths: ['a.ts'], kind: 'write' }]);
  assert.deepEqual(logins.at(-1), { flowId: 'new-flow', state: 'done' });
  assert.deepEqual(await api.loginFeed('new-flow'), { state: 'done', lost: false });
  assert.equal((await api.snapshot()).entries[0].value, 'latest');
  for (const stop of stops) stop();
  rendered.dispose();
  assert.equal(b.events.size + b.changes.size + phone.listeners.size, 0, 'last unsubscribe releases every observer');
});

test('late first start cannot rebind to an old client, and an unsubscribed pre-start listener stays gone', async () => {
  const phone = boot();
  const api = sections(phone);
  const values: any[] = [];
  const cancelled: any[] = [];
  const stop = api.subscribeFsChanged((v) => values.push(v));
  api.subscribeFsChanged((v) => cancelled.push(v))();
  const a = client('old'),
    b = client('new');
  phone.replace(b);
  phone.settleStart(a);
  await flush();
  a.notice('fs/changed', { watchId: 'old' });
  b.notice('fs/changed', { watchId: 'new' });
  assert.deepEqual(values, [{ watchId: 'new', changedPaths: [] }]);
  assert.deepEqual(cancelled, []);
  stop();
  assert.equal(phone.listeners.size + b.events.size, 0);
});

test('ordinary redial restores each active project watch once; unwatch and project change release ownership', async () => {
  const a = client('a'),
    phone = boot(a),
    api = sections(phone);
  const params = { watchId: 'project-1', path: 'D:\\workspace\\한 글', recursive: true };
  assert.deepEqual(await api.call('fs/watch', params), { ok: true });
  assert.equal(watchCalls(a).length, 1, 'no duplicate initial watch');
  a.statusTo('reconnecting');
  a.statusTo('ready');
  a.statusTo('ready');
  await flush();
  assert.deepEqual(
    watchCalls(a).map(({ params }) => params),
    [params, params]
  );
  await api.call('fs/unwatch', { watchId: 'project-1' });
  await api.call('fs/watch', { watchId: 'project-2', path: '/other', recursive: false });
  a.statusTo('reconnecting');
  a.statusTo('ready');
  await flush();
  assert.deepEqual(
    watchCalls(a).map(({ params }) => params.watchId),
    ['project-1', 'project-1', 'project-2', 'project-2']
  );
  await api.call('fs/unwatch', { watchId: 'project-2' });
  assert.equal(phone.listeners.size + a.events.size, 0);
});

test('client replacement replays active watches and leaves released ones behind', async () => {
  const a = client('a'),
    b = client('b'),
    phone = boot(a),
    api = sections(phone);
  await api.call('fs/watch', { watchId: 'kept', path: '/kept' });
  await api.call('fs/watch', { watchId: 'gone', path: '/gone' });
  await api.call('fs/unwatch', { watchId: 'gone' });
  phone.replace(b);
  await flush();
  assert.deepEqual(
    watchCalls(b).map(({ params }) => params.watchId),
    ['kept']
  );
  assert.equal(a.events.size, 0);
  await api.call('fs/unwatch', { watchId: 'kept' });
  assert.equal(b.events.size + phone.listeners.size, 0);
});

test('a watch requested while disconnected sends once on ready and can be released before dispatch', async () => {
  const a = client('a'),
    phone = boot(a),
    api = sections(phone);
  a.statusTo('reconnecting');
  const pending = api.call('fs/watch', { watchId: 'next', path: '/next' });
  await flush();
  assert.equal(watchCalls(a).length, 0);
  a.statusTo('ready');
  await pending;
  assert.equal(watchCalls(a).length, 1);
  await api.call('fs/unwatch', { watchId: 'next' });
  a.statusTo('reconnecting');
  const cancelled = api.call('fs/watch', { watchId: 'cancelled', path: '/cancelled' });
  await flush();
  await api.call('fs/unwatch', { watchId: 'cancelled' });
  await cancelled;
  a.statusTo('ready');
  await flush();
  assert.equal(watchCalls(a).length, 1);
  assert.equal(phone.listeners.size + a.events.size, 0);
});

test('same-id pending watches both settle on ready or unwatch, and only the current owner is dispatched', async () => {
  const a = client('a'),
    phone = boot(a),
    api = sections(phone);
  a.statusTo('reconnecting');
  const old = api.call('fs/watch', { watchId: 'same', path: '/old' });
  await flush();
  const next = api.call('fs/watch', { watchId: 'same', path: '/new' });
  await flush();
  a.statusTo('ready');
  assert.deepEqual(await Promise.all([old, next]), [undefined, { ok: true }]);
  assert.deepEqual(
    watchCalls(a).map(({ params }) => params.path),
    ['/new']
  );
  a.statusTo('reconnecting');
  a.statusTo('ready');
  await flush();
  assert.deepEqual(
    watchCalls(a).map(({ params }) => params.path),
    ['/new', '/new']
  );
  await api.call('fs/unwatch', { watchId: 'same' });

  a.statusTo('reconnecting');
  const releasedOld = api.call('fs/watch', { watchId: 'same', path: '/released-old' });
  await flush();
  const releasedNext = api.call('fs/watch', { watchId: 'same', path: '/released-new' });
  await flush();
  await api.call('fs/unwatch', { watchId: 'same' });
  assert.deepEqual(await Promise.all([releasedOld, releasedNext]), [undefined, undefined]);
  a.statusTo('ready');
  await flush();
  assert.equal(watchCalls(a).length, 2, 'released replacements never dispatch');
  assert.equal(phone.listeners.size + a.events.size, 0);
});

test('same-id replacement retains the new watch when the original sent request settles late', async () => {
  for (const rejectOld of [false, true]) {
    const a = client('a'),
      phone = boot(a),
      api = sections(phone),
      reply = deferred();
    a.answer = (method, params) =>
      method === 'fs/watch' && params.path === '/old' ? reply.promise : Promise.resolve({ ok: true });
    const old = api.call('fs/watch', { watchId: 'same', path: '/old' });
    await flush();
    assert.deepEqual(await api.call('fs/watch', { watchId: 'same', path: '/new' }), { ok: true });
    if (rejectOld) {
      const error = new Error('old request failed');
      const rejected = assert.rejects(old, (value) => value === error);
      reply.reject(error);
      await rejected;
    } else {
      reply.resolve({ oldResult: true });
      assert.deepEqual(await old, { oldResult: true });
    }
    assert.equal(
      a.calls.filter(({ method }) => method === 'fs/unwatch').length,
      0,
      'old completion cannot remove the replacement'
    );
    a.statusTo('reconnecting');
    a.statusTo('ready');
    await flush();
    assert.deepEqual(
      watchCalls(a).map(({ params }) => params.path),
      ['/old', '/new', '/new']
    );
    await api.call('fs/unwatch', { watchId: 'same' });
    assert.equal(phone.listeners.size + a.events.size, 0);
  }
});

test('unwatch while start is pending prevents dispatch, and a late successful watch is cleaned up', async () => {
  const phone = boot(),
    api = sections(phone),
    a = client('a');
  const pending = api.call('fs/watch', { watchId: 'never', path: '/never' });
  const unwatch = api.call('fs/unwatch', { watchId: 'never' });
  phone.replace(a);
  phone.settleStart(a);
  await Promise.all([pending, unwatch]);
  assert.equal(watchCalls(a).length, 0);
  const reply = deferred();
  a.answer = (method) => (method === 'fs/watch' ? reply.promise : Promise.resolve(null));
  const late = api.call('fs/watch', { watchId: 'late', path: '/late' });
  await flush();
  await api.call('fs/unwatch', { watchId: 'late' });
  reply.resolve({ accepted: true });
  assert.deepEqual(await late, { accepted: true });
  await flush();
  assert.deepEqual(
    a.calls.slice(-2).map(({ method }) => method),
    ['fs/unwatch', 'fs/unwatch'],
    'late success gets a final cleanup'
  );
  a.statusTo('reconnecting');
  a.statusTo('ready');
  assert.equal(watchCalls(a).length, 1, 'released watch is never replayed');
});

test('late initial success after handover establishes the watch on the new client', async () => {
  const a = client('a'),
    b = client('b'),
    phone = boot(a),
    api = sections(phone),
    reply = deferred();
  a.answer = () => reply.promise;
  const pending = api.call('fs/watch', { watchId: 'late', path: '/late' });
  await flush();
  phone.replace(b);
  assert.equal(watchCalls(b).length, 0, 'unconfirmed initial watch is not duplicated');
  reply.resolve({ accepted: true });
  await pending;
  await flush();
  assert.equal(watchCalls(b).length, 1);
  await api.call('fs/unwatch', { watchId: 'late' });
});

test('initial watch failure keeps its error and releases observers; unrelated calls retain params and results', async () => {
  const a = client('a'),
    phone = boot(a),
    api = sections(phone),
    failure = new Error('permission denied');
  a.answer = async () => {
    throw failure;
  };
  await assert.rejects(api.call('fs/watch', { watchId: 'bad', path: '/bad' }), (error) => error === failure);
  assert.equal(phone.listeners.size + a.events.size, 0);
  a.statusTo('reconnecting');
  a.statusTo('ready');
  assert.equal(watchCalls(a).length, 1);
  const params = { arbitrary: 'value' },
    result = { retained: true };
  a.answer = async () => result;
  assert.equal(await api.call('review/diff/get', params), result);
  assert.equal(a.calls.at(-1)!.params, params);
});

test('a released replay that finishes late is cleaned up, and replay errors are reported without retry', async () => {
  const a = client('a'),
    phone = boot(a),
    api = sections(phone);
  await api.call('fs/watch', { watchId: 'x', path: '/x' });
  const reply = deferred();
  a.answer = (method) => (method === 'fs/watch' ? reply.promise : Promise.resolve(null));
  a.statusTo('reconnecting');
  a.statusTo('ready');
  await api.call('fs/unwatch', { watchId: 'x' });
  reply.resolve(null);
  await flush();
  assert.equal(a.calls.at(-1)!.method, 'fs/unwatch');
  a.answer = async () => null;
  await api.call('fs/watch', { watchId: 'y', path: '/y' });
  const pushes: any[] = [];
  const stop = api.subscribe((v) => pushes.push(v));
  a.answer = async () => {
    throw new Error('directory missing');
  };
  a.statusTo('reconnecting');
  a.statusTo('ready');
  await flush();
  assert.deepEqual(pushes.at(-1), { kind: 'feedError', feedId: 'fs:y', message: 'directory missing' });
  assert.equal(watchCalls(a).filter(({ params }) => params.watchId === 'y').length, 2);
  a.answer = async () => null;
  await api.call('fs/unwatch', { watchId: 'y' });
  stop();
});
