import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerPages } from './pages.ts';

function makeGuest(pageId) {
  return { pageId, isDestroyed: () => false, getURL: () => 'https://a.example/', isLoading: () => false };
}

function harness({ policy } = {}) {
  const handlers = new Map();
  const log = [];
  const connection = { request: async () => ({}), handleRequest: (method, handler) => handlers.set(method, handler) };
  const visible = [makeGuest('p1')];
  const backgrounds = new Map();
  const owner = new Map([[visible[0], 'sess']]);
  let current = visible[0];
  const pages = new Map([['p1', visible[0]]]);
  const state = (guest) => ({ guest, state: { pageId: guest.pageId, documentGeneration: 1, cdpSessions: new Map() } });
  const ctx = {
    page: (id) => (pages.has(id) ? state(pages.get(id)) : undefined),
    session: () => undefined,
    cdp: { guestDebugger: async () => ({}) },
    events: { flush: () => {}, facts: (id) => ({ pageId: id, seq: 1 }) },
    redactKnown: (_id, text) => text,
    isEngineMode: () => true,
  };
  const host = {
    sessions: {
      visibleGuests: (id) => visible.filter((g) => owner.get(g) === id),
      backgroundPages: () => backgrounds,
      currentGuest: () => current,
      liveGuest: () => current,
      backgroundPageForGuest: (_id, guest) => [...backgrounds.values()].find((p) => p.guest === guest),
      setAgentPage: (_id, guest) => log.push(`agentPage ${guest.pageId}`),
      sessionIdForGuest: (guest) => owner.get(guest),
    },
    tabs: {
      resolveTargetGuest: (_id, background, tab) => {
        log.push(`target ${background} ${tab}`);
        if (tab === 'bad') throw new Error('no page "bad"; call list_tabs');
        if (background) {
          const guest = makeGuest('p2');
          pages.set('p2', guest);
          owner.set(guest, 'sess');
          backgrounds.set('bg', { guest, window: { isDestroyed: () => false }, kind: 'agent', lastUsedAt: 0 });
          return { guest, background: true, tabName: 'bg' };
        }
        return tab === 'p1' ? { guest: visible[0], background: false } : null;
      },
    },
    lifecycle: {
      restoreSession: async () => log.push('restore'),
      ensureGuest: async (_id, options) => {
        log.push(`ensure ${JSON.stringify(options)}`);
        return visible[0];
      },
      requestBrowserSurface: (id, reveal) => log.push(`surface ${id} ${reveal}`),
      revealPage: async (id, guest) => (log.push(`reveal ${guest.pageId}`), 'shown'),
      discardCreatedPage: (_id, guest) => (log.push(`discard ${guest.pageId}`), true),
      discardUntouchedBlank: () => {},
      recoverCrashedGuest: async () => {},
      backgroundEntryByPageId: (_id, pageId) => [...backgrounds].find(([, p]) => p.guest.pageId === pageId) ?? null,
      destroyBackgroundPage: (_id, name, entry) => {
        log.push(`destroy ${name}`);
        backgrounds.delete(name);
        pages.delete(entry.guest.pageId);
        current = visible[0];
      },
    },
    taskLifecycle: { retain: (guest) => log.push(`retain ${guest.pageId}`) },
    store: { pageId: (guest) => guest.pageId, invalidateInteraction: () => {}, for: () => ({ networkFailures: [] }) },
    leases: { acquire: (pageId, commandId, ttlMs) => (log.push(`lease ${pageId} ${commandId} ${ttlMs}`), 'lease-1') },
    page: {
      urls: {
        validatedAgentUrl: async (raw) => {
          if (policy) throw new Error(policy);
          return raw;
        },
      },
      downloadsForSession: () => [],
      sessionIdOf: () => 'sess',
    },
  };
  registerPages(connection, ctx, host);
  const call = (method, params) => handlers.get(`host/browser/pages/${method}`)(params, new AbortController().signal);
  return { call, log, backgrounds, visible };
}

test('resolve answers the visible page with its descriptor and the lease the command holds it by', async () => {
  const h = harness();
  const result = await h.call('resolve', {
    sessionId: 'sess',
    tab: { pageId: 'p1' },
    lease: { commandId: 'c1', ttlMs: 5000 },
  });
  assert.equal(result.page.pageId, 'p1');
  assert.equal(result.page.tabId, 'v1');
  assert.equal(result.page.sessionId, 'sess');
  assert.equal(result.page.background, false);
  assert.equal(result.page.facts.pageId, 'p1');
  assert.equal(result.leaseId, 'lease-1');
  assert.ok(h.log.includes('lease p1 c1 5000'));
  assert.ok(h.log.includes('agentPage p1'));
});

test('resolve with background:true makes the hidden page; a tab index is the visible position', async () => {
  const h = harness();
  const hidden = await h.call('resolve', { sessionId: 'sess', background: true });
  assert.equal(hidden.page.background, true);
  assert.equal(hidden.page.tabId, 'bg');
  assert.equal(hidden.leaseId, undefined);
  await h.call('resolve', { sessionId: 'sess', tab: { index: 1 } });
  assert.ok(h.log.includes('target false v1'));
});

test('resolve places a command with no tab on a visible page of its own, or on the pane page when it adopts', async () => {
  const h = harness();
  await h.call('resolve', { sessionId: 'sess', open: {} });
  await h.call('resolve', { sessionId: 'sess', adopt: true });
  assert.ok(h.log.includes('ensure {"reveal":false,"adopt":false}'));
  assert.ok(h.log.includes('ensure {"reveal":false,"adopt":true}'));
});

test('resolve fails for an unknown tab and for an invalid session id', async () => {
  const h = harness();
  await assert.rejects(h.call('resolve', { sessionId: 'sess', tab: { pageId: 'bad' } }), (e) => e.code === -32000);
  await assert.rejects(h.call('resolve', { sessionId: 'bad id' }), (e) => e.code === -32602);
});

test('resolve with open.url loads the admitted url; a refused one is -32015 and the page it made is discarded', async () => {
  const refused = harness({ policy: 'blocked by policy' });
  await assert.rejects(
    refused.call('resolve', { sessionId: 'sess', open: { url: 'http://10.0.0.1/' } }),
    (e) => e.code === -32015 && e.data.reason === 'blocked by policy'
  );
  assert.equal(refused.log.some((l) => l.startsWith('discard')), false, 'the pane page was already known');
  const revealed = harness();
  const result = await revealed.call('resolve', { sessionId: 'sess', open: { reveal: true } });
  assert.equal(result.page.pageId, 'p1');
  assert.ok(revealed.log.includes('retain p1') && revealed.log.includes('reveal p1'));
});

test('list gives every page of the session and the active one', async () => {
  const h = harness();
  await h.call('resolve', { sessionId: 'sess', background: true });
  const listed = await h.call('list', { sessionId: 'sess' });
  assert.deepEqual(
    listed.pages.map((p) => [p.pageId, p.tabId, p.background]),
    [
      ['p1', 'v1', false],
      ['p2', 'bg', true],
    ]
  );
  assert.equal(listed.activePageId, 'p1');
});

test('close destroys a background page and names the page that is active next', async () => {
  const h = harness();
  await h.call('resolve', { sessionId: 'sess', background: true });
  const closed = await h.call('close', { pageId: 'p2', reason: 'turnEnd' });
  assert.deepEqual(closed, { closed: true, nextActivePageId: 'p1' });
  assert.ok(h.log.includes('destroy bg'));
  assert.deepEqual(await h.call('close', { pageId: 'p2', reason: 'turnEnd' }), { closed: false });
});

test('the visible tab stays with the panel: the agent is told how to move on, the sweeps close nothing', async () => {
  const h = harness();
  await assert.rejects(
    h.call('close', { pageId: 'p1', reason: 'agent' }),
    (e) => e.code === -32000 && /stays with the browser panel/.test(e.message)
  );
  assert.deepEqual(await h.call('close', { pageId: 'p1', reason: 'idle' }), { closed: false });
  await assert.rejects(h.call('close', { pageId: 'p1', reason: 'nope' }), (e) => e.code === -32602);
});

test('surface reveals, hides and hands off through the lifecycle (which reports host/browser/surface)', async () => {
  const h = harness();
  const revealed = await h.call('surface', { sessionId: 'sess', op: 'reveal', pageId: 'p1' });
  assert.equal(revealed.facts.pageId, 'p1');
  await h.call('surface', { sessionId: 'sess', op: 'reveal' });
  await h.call('surface', { sessionId: 'sess', op: 'hide' });
  await h.call('surface', { sessionId: 'sess', op: 'handoff' });
  assert.deepEqual(
    h.log.filter((l) => l.startsWith('surface') || l.startsWith('reveal')),
    ['reveal p1', 'surface sess true', 'surface sess hide', 'surface sess handoff']
  );
  await assert.rejects(h.call('surface', { sessionId: 'sess', op: 'x' }), (e) => e.code === -32602);
});
