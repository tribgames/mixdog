import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { synchronizeViewSnapshot } from './view-synchronizer.ts';
import { SessionHost } from './session-host.ts';
import { SessionViewRegistry } from './session-view-registry.ts';
import { RecoveringStoreWatcher } from './recovering-store-watcher.ts';
import { viewSyncHost } from './test-support/view-sync-host.mjs';
import { createDesktopService } from './desktop-service.ts';
import { createSnapshotDeltaDecoder } from './state-delta.ts';

test('view recovery replays unchanged host content and keeps lanes independent', async () => {
  const f = await viewSyncHost();
  try {
    f.put('lead', 'completed answer');
    f.put('agent', 'agent finished');
    await f.host.setVisibleSessionsForSource('phone', ['lead', 'agent']);
    let recovered;
    await synchronizeViewSnapshot(f.host, ['lead', 'agent'], (value) => { recovered = value; });
    assert.deepEqual(recovered.sessionStates.map((row) => row.snapshot.items[0].text),
      ['completed answer', 'agent finished']);
    assert.equal(recovered.sessions.length, 2);
    await synchronizeViewSnapshot(f.host, ['deleted-session', 'lead'], (value) => { recovered = value; });
    assert.equal(recovered.sessionStates[0].snapshot, null);
    assert.equal(recovered.sessionStates[0].laneEnd, 'gone');
    assert.equal(recovered.sessionStates[1].snapshot.items[0].text, 'completed answer');
  } finally { await f.close(); }
});

test('new task receipts coalesce retries and survive a host replacement without resubmitting', async () => {
  const f = await viewSyncHost();
  let replacement;
  try {
    const options = { id: 'same-logical-submit', displayText: 'once' };
    const [a, b] = await Promise.all([
      f.host.submitNewTask('once', options), f.host.submitNewTask('once', options),
    ]);
    assert.equal(a.sessionId, b.sessionId);
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.submits, 1);
    replacement = await SessionHost.create(f.options, f.runtime);
    const c = await replacement.submitNewTask('once', { displayText: 'once', id: options.id });
    assert.equal(c.sessionId, a.sessionId);
    assert.equal(c.snapshot.items[0].text, 'once');
    assert.equal(f.state.creates, 1);
    assert.equal(f.state.submits, 1);
    await assert.rejects(replacement.submitNewTask('different', options), /different content/);
  } finally { await replacement?.dispose(); await f.close(); }
});

test('subscription union serializes a departed consumer against a new consumer', async () => {
  const registry = new SessionViewRegistry();
  const released = Promise.withResolvers();
  const started = Promise.withResolvers();
  const attached = new Set();
  const ensure = async (id) => { attached.add(id); return true; };
  await registry.set('old', ['session'], ensure, async () => {});
  const closing = registry.set('old', [], ensure, async (id) => {
    started.resolve();
    await released.promise;
    attached.delete(id);
  });
  await started.promise;
  const opening = registry.set('new', ['session'], ensure, async () => {});
  released.resolve();
  await Promise.all([closing, opening]);
  assert.deepEqual([...attached], ['session']);
  assert.deepEqual([...registry.visible], ['session']);
  registry.close();
});

test('a failed catalog watcher rearms and reconciles without remounting consumers', async () => {
  let current, creations = 0, reconciles = 0, warnings = 0;
  const watcher = new RecoveringStoreWatcher({
    directory: () => 'test-only',
    relevant: () => true,
    changed: () => { reconciles++; },
    error: () => { warnings++; },
    watch: () => {
      creations++;
      current = new EventEmitter();
      current.close = () => {};
      return current;
    },
  });
  try {
    watcher.start();
    current.emit('error', new Error('lost watcher'));
    await delay(300);
    assert.equal(creations, 2);
    assert.equal(reconciles, 1);
    assert.equal(warnings, 1);
  } finally { watcher.close(); }
});

test('desktop stream recovery restores every visible lane and catalogs before its completion marker', async () => {
  const f = await viewSyncHost();
  let service;
  const messages = [];
  try {
    f.put('lead', 'lead initial');
    f.put('agent', 'agent initial');
    service = await createDesktopService({
      options: f.options,
      runtime: { ...f.runtime, loadConfig: async () => ({}) },
      emit: (message) => messages.push(message),
    });
    await service.invoke('setVisibleSessions', [['lead', 'agent']]);
    f.put('lead', 'lead completed');
    f.put('agent', 'agent completed');
    f.state.agents = [{ sessionId: 'agent', ownerSessionId: 'lead', status: 'completed' }];
    messages.length = 0; // The visual client missed the preceding publications.
    await service.control({ kind: 'state-resync' });
    const states = messages.filter((message) => message.kind === 'session-state');
    assert.deepEqual(states.map((message) =>
      createSnapshotDeltaDecoder().decode(message.wire).snapshot.items[0].text),
    ['lead completed', 'agent completed']);
    assert.equal(messages.find((message) => message.kind === 'sessions').sessions.length, 2);
    assert.equal(messages.find((message) => message.kind === 'agent-pool').agents[0].status, 'completed');
    assert.equal(messages.at(-1).kind, 'view-sync-complete');
  } finally { await service?.dispose(); await f.close(); }
});
