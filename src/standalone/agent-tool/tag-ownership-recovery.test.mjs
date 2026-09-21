import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import { rowMatchesContext } from './helpers.mjs';
import { normalizeTagTombstones, recoverTagTombstoneOwner, tagTombstoneKey } from './worker-rows.mjs';

mock.module('../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: { clearGatewaySessionRoute: () => true, writeGatewaySessionRoutes: () => true },
});
const { createTagRegistry } = await import('./tag-registry.mjs');

const original = (owner, extra = {}) => ({
  id: `child-${owner}`,
  agentTag: 'shared',
  parentSessionId: owner,
  ownerSessionId: owner,
  agent: 'worker',
  clientHostPid: 4242,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 30_000,
  status: 'idle',
  ...extra,
});
const legacy = (extra = {}) => ({
  tag: 'shared', agent: 'worker', cwd: '/work', clientHostPid: 4242,
  reapedAt: new Date(Date.now() - 10_000).toISOString(), ...extra,
});

function fixture(t, sessions, tombstones = []) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tag-owner-'));
  const file = join(root, 'agent-workers.json');
  writeFileSync(file, JSON.stringify({ version: 2, workers: {}, tombstones }));
  const registry = createTagRegistry({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr: {
      listSessions: () => sessions,
      getSession: (id) => sessions.find((s) => s.id === id) || null,
      getSessionRuntime: () => null,
    },
  });
  t.after(() => { registry.clearScheduledReaps(); rmSync(root, { recursive: true, force: true }); });
  return { registry, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

test('owner-scoped tombstone keys survive PID changes and separate sibling and nested callers', () => {
  const row = { ...legacy(), parentSessionId: 'lead-a', ownerSessionId: 'root', sessionId: 'child' };
  assert.equal(tagTombstoneKey(row), tagTombstoneKey({ ...row, clientHostPid: 9999 }));
  assert.notEqual(tagTombstoneKey(row), tagTombstoneKey({ ...row, parentSessionId: 'lead-b' }));
  assert.equal(rowMatchesContext(row, { callerSessionId: 'lead-a', clientHostPid: 9999 }), true);
  assert.equal(rowMatchesContext(row, { callerSessionId: 'root', clientHostPid: 4242 }), false);
  assert.deepEqual(normalizeTagTombstones({ tombstones: [row] })[0], row);
});

test('a unique original session recovers a legacy tag without widening ownership', (t) => {
  const session = original('lead-a');
  const { registry, read } = fixture(t, [session], [legacy()]);
  const before = read();
  const recovered = registry.tagTombstoneForTag('shared', { callerSessionId: 'lead-a', clientHostPid: 9999 });
  assert.equal(recovered.sessionId, session.id);
  assert.equal(recovered.ownerSessionId, 'lead-a');
  assert.equal(registry.tagTombstoneForTag('shared', { callerSessionId: 'lead-b', clientHostPid: 4242 }), null);
  assert.deepEqual(read(), before, 'lookup does not rewrite the persisted index');
  registry.consumeTagTombstone(recovered);
  assert.deepEqual(read().tombstones, {}, 'authorized reuse consumes the original legacy key');
});

test('missing, ambiguous, unrelated or post-reap evidence cannot recover ownership', () => {
  const row = legacy();
  for (const sessions of [
    [],
    [original('lead-a'), original('lead-b')],
    [original('lead-a'), original('lead-a', { id: 'second-child' })],
    [original('lead-a', { clientHostPid: 9999 })],
    [original('lead-a', { agentTag: 'other' })],
    [original('lead-a', { createdAt: Date.now() + 1_000 })],
    [original('lead-a', { createdAt: null })],
  ]) {
    assert.equal(recoverTagTombstoneOwner(row, sessions), row);
    assert.equal(rowMatchesContext(row, { callerSessionId: 'lead-a', clientHostPid: 4242 }), false);
  }
});

test('new reap records preserve ownership and cannot overwrite a sibling tag', (t) => {
  const sessions = [original('lead-a'), original('lead-b')];
  const { registry, read } = fixture(t, sessions);
  for (const session of sessions) {
    registry.bindTag('shared', session, { status: 'idle' });
    assert.equal(registry.tombstoneTerminalSession('shared', session.id, session), true);
  }
  const rows = Object.values(read().tombstones);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.parentSessionId).sort(), ['lead-a', 'lead-b']);
  const own = registry.tagTombstoneForTag('shared', { callerSessionId: 'lead-a', clientHostPid: 9999 });
  registry.consumeTagTombstone(own);
  assert.deepEqual(Object.values(read().tombstones).map((r) => r.parentSessionId), ['lead-b']);
});

test('recovered legacy consumption preserves a newer replacement record', (t) => {
  const row = legacy();
  const { registry, read } = fixture(t, [original('lead-a')], [row]);
  const recovered = registry.tagTombstoneForTag('shared', { callerSessionId: 'lead-a' });
  const replacement = { ...row, reapedAt: new Date(Date.now()).toISOString() };
  registry.writeWorkerRows((_workers, tombstones) => tombstones.set(tagTombstoneKey(replacement), replacement));
  registry.consumeTagTombstone(recovered);
  assert.equal(Object.values(read().tombstones)[0].reapedAt, replacement.reapedAt);
});
