import assert from 'node:assert/strict';
import test from 'node:test';
import { coreLocalPages, createCoreLocalPages, ownerIdOf, setCoreLocalPages } from './core-local-pages.ts';

function fakeOwner(id) {
  const listeners = [];
  return {
    id,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    once(_event, listener) { listeners.push(listener); },
    destroy() { this.destroyed = true; for (const l of listeners) l(); },
    count: () => listeners.length,
  };
}

function fakeCore() {
  const calls = [];
  const state = { down: false, origin: 'http://127.0.0.1:1' };
  const invoke = async (name, args) => {
    calls.push([name, args]);
    if (state.down) throw new Error('link down');
    if (name === 'localPageOrigin') return state.origin;
    if (name === 'localPageUrlIn') return `${state.origin}/p/${args[3]}`;
    return undefined;
  };
  return { calls, state, invoke };
}

test('a destroyed owner is refused before any core call', async () => {
  const core = fakeCore();
  const pages = createCoreLocalPages(core.invoke);
  const owner = fakeOwner(7);
  owner.destroyed = true;
  await assert.rejects(pages.url('/r', 'a.html', { owner }), /preview owner is closed/);
  assert.equal(core.calls.length, 0);
});

test('url passes root, rel, token and owner id; destroy listener registered once per owner', async () => {
  const core = fakeCore();
  const pages = createCoreLocalPages(core.invoke);
  const owner = fakeOwner(7);
  const url = await pages.url('/r', 'a.html', { owner, ownerId: 'uuid-1', accessToken: 'tok' });
  await pages.url('/r', 'b.html', { owner, ownerId: 'uuid-1' });
  assert.equal(url, 'http://127.0.0.1:1/p/uuid-1');
  assert.deepEqual(core.calls[0], ['localPageUrlIn', ['/r', 'a.html', 'tok', 'uuid-1']]);
  assert.equal(owner.count(), 1);
  assert.equal(ownerIdOf(owner), 'wc:7');
  owner.destroy();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(core.calls.at(-1), ['localPageRevokeOwner', ['uuid-1']]);
});

test('a revoke that fails is queued and flushed by the next refresh', async () => {
  const core = fakeCore();
  const pages = createCoreLocalPages(core.invoke);
  const owner = fakeOwner(3);
  await pages.url('/r', 'a.html', { owner, ownerId: 'w' });
  core.state.down = true;
  owner.destroy();
  await new Promise((r) => setImmediate(r));
  core.state.down = false;
  core.calls.length = 0;
  await pages.refresh();
  assert.deepEqual(core.calls.map((c) => c[0]), ['localPageOrigin', 'localPageRevokeOwner']);
  core.calls.length = 0;
  await pages.refresh();
  assert.deepEqual(core.calls.map((c) => c[0]), ['localPageOrigin']);
});

test('origin is cached; refresh re-queries', async () => {
  const core = fakeCore();
  const pages = createCoreLocalPages(core.invoke);
  assert.equal(await pages.origin(), 'http://127.0.0.1:1');
  core.state.origin = 'http://127.0.0.1:2';
  assert.equal(await pages.origin(), 'http://127.0.0.1:1');
  assert.equal(await pages.refresh(), 'http://127.0.0.1:2');
  assert.equal(await pages.origin(), 'http://127.0.0.1:2');
});

test('coreLocalPages throws when unset', () => {
  setCoreLocalPages(null);
  assert.throws(() => coreLocalPages(), /not connected/);
  const pages = createCoreLocalPages(async () => '');
  setCoreLocalPages(pages);
  assert.equal(coreLocalPages(), pages);
  setCoreLocalPages(null);
});
