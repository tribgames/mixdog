import assert from 'node:assert/strict';
import test from 'node:test';

import { registerHooks } from 'node:module';

registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'electron'
      ? {
          url: 'data:text/javascript,export class BaseWindow{};export class BrowserWindow{};export class WebContentsView{}',
          shortCircuit: true,
        }
      : next(specifier, context),
});

const { createBrowserSessionRestore } = await import('./guest-session-restore.ts');

const guest = (url) => ({
  url,
  getURL() {
    return this.url;
  },
  getZoomFactor: () => 1,
  setZoomFactor() {},
  isDestroyed: () => false,
  loadURL: async function (next) {
    this.url = next;
  },
});

function harness(pages) {
  const gate = { promise: Promise.resolve() };
  let n = 0;
  const ids = new WeakMap();
  const live = new Map([['x', pages]]);
  const standIns = new Set();
  const claimed = [];
  const discarded = [];
  const make = (url, pageId) => {
    const g = guest(url);
    ids.set(g, pageId ?? `new${++n}`);
    return g;
  };
  const restore = createBrowserSessionRestore({
    sessions: {
      currentGuest: () => null,
      visibleGuests: (s) => (live.get(s) ?? []).filter((g) => g.primary),
      backgroundPages: (s) =>
        new Map((live.get(s) ?? []).filter((g) => !g.primary).map((g, i) => [`bg${i}`, { guest: g, kind: g.kind }])),
      selectGuest() {},
    },
    urlPolicy: {},
    pageId: (g) => ids.get(g),
    discardPage: (_s, g) => discarded.push(g),
    claimPage: (_s, g) => claimed.push(g),
    isStandIn: (_s, g) => standIns.has(g),
    ensurePrimaryPage: async (s, pageId) => {
      await gate.promise;
      const g = make('about:blank', pageId);
      g.primary = true;
      live.set(s, [g, ...(live.get(s) ?? [])]);
      return g;
    },
    admitBackgroundPages() {},
    restoreBackgroundPage: (s, _name, kind, pageId) => {
      const g = make('about:blank', pageId);
      g.kind = kind;
      live.set(s, [...(live.get(s) ?? []), g]);
      return { guest: g, kind };
    },
    closeSessionPages: (s) => live.delete(s),
  });
  return { restore, live, ids, standIns, make, claimed, discarded, gate };
}

test('a restored page takes the id its unloaded page had, with no alias kept', async () => {
  const h = harness([]);
  const a = h.make('https://example.test/a', 'p3');
  a.primary = true;
  const b = h.make('https://example.test/b', 'p7');
  b.kind = 'user';
  h.live.set('x', [a, b]);
  h.restore.releaseSession('x', true);
  await h.restore.restoreSession('x');
  assert.deepEqual(
    h.live.get('x').map((g) => [h.ids.get(g), g.url]),
    [
      ['p3', 'https://example.test/a'],
      ['p7', 'https://example.test/b'],
    ]
  );
  // Unloaded and restored again: the same ids.
  h.restore.releaseSession('x', true);
  await h.restore.restoreSession('x');
  assert.deepEqual(
    h.live.get('x').map((g) => h.ids.get(g)),
    ['p3', 'p7']
  );
});

test('a blank tab a person made returns, the blank stand-in does not', async () => {
  const h = harness([]);
  const standIn = h.make('about:blank', 'p1');
  standIn.primary = true;
  h.standIns.add(standIn);
  const mine = h.make('about:blank', 'p2');
  mine.kind = 'user';
  h.live.set('x', [standIn, mine]);
  h.restore.releaseSession('x', true);
  await h.restore.restoreSession('x');
  assert.deepEqual(
    h.live.get('x').map((g) => [h.ids.get(g), g.url]),
    [['p2', 'about:blank']]
  );
});

test('a restored primary is claimed again, so a later unload keeps it', async () => {
  const h = harness([]);
  const mine = h.make('about:blank', 'p2');
  mine.primary = true;
  h.live.set('x', [mine]);
  h.restore.releaseSession('x', true);
  await h.restore.restoreSession('x');
  assert.deepEqual(h.claimed, h.live.get('x'));
});

test('a restore overtaken by a deletion creates nothing, or takes down what it made', async () => {
  const h = harness([]);
  const mine = h.make('https://example.test/a', 'p2');
  mine.primary = true;
  h.live.set('x', [mine]);
  h.restore.releaseSession('x', true);
  const restoring = h.restore.restoreSession('x');
  h.restore.releaseSession('x');
  await assert.rejects(restoring, /changed during restore/);
  assert.deepEqual(h.live.get('x') ?? [], [], 'no page made for the deleted session');
  assert.deepEqual(h.discarded, []);
});

test('a restore deleted while its primary is being made takes that primary down', async () => {
  const h = harness([]);
  const mine = h.make('https://example.test/a', 'p2');
  mine.primary = true;
  h.live.set('x', [mine]);
  h.restore.releaseSession('x', true);
  let open;
  h.gate.promise = new Promise((resolve) => (open = resolve));
  const restoring = h.restore.restoreSession('x');
  await new Promise((resolve) => setImmediate(resolve));
  h.restore.releaseSession('x');
  open();
  await assert.rejects(restoring, /changed during restore/);
  assert.equal(h.discarded.length, 1);
  assert.equal(h.ids.get(h.discarded[0]), 'p2');
});

test('ended sessions and non-restorable stand-ins leave no suspended descriptors behind', async () => {
  const h = harness([]);
  const standIn = h.make('about:blank', 'p1');
  standIn.primary = true;
  h.standIns.add(standIn);
  h.live.set('x', [standIn]);
  h.restore.releaseSession('x', true);
  assert.equal(h.restore.hasSuspended('x'), false, 'blank stand-in alone is not stored');

  const page = h.make('https://example.test/ended', 'p2');
  page.primary = true;
  h.live.set('x', [page]);
  h.restore.releaseSession('x', true);
  assert.equal(h.restore.hasSuspended('x'), true);
  h.restore.forgetSession('x');
  assert.equal(h.restore.hasSuspended('x'), false, 'ended session drops its suspended descriptors');
  await h.restore.restoreSession('x');
  assert.deepEqual(h.live.get('x') ?? [], [], 'nothing restores after the session ended');
});
