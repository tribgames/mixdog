import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

mock.module('../../../vendor/statusline/src/gateway/session-routes.mjs', {
  namedExports: {
    clearGatewaySessionRoute: () => true,
    writeGatewaySessionRoutes: () => true,
  },
});
const { createTagRegistry } = await import('./tag-registry.mjs');
const { createCloseFlow } = await import('./close-flow.mjs');

const iso = (ms) => new Date(ms).toISOString();

function workerSession(id, tag, owner) {
  const now = iso(Date.now());
  return {
    id,
    agentTag: tag,
    ownerSessionId: owner,
    parentSessionId: owner,
    agent: 'reviewer',
    provider: 'anthropic-oauth',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    lastUsedAt: now,
  };
}

function setup(sessions) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-close-stale-'));
  const mgr = {
    getSession: (id) => sessions.get(id) || null,
    listSessions: () => [...sessions.values()],
    getSessionRuntime: () => null,
    hideSessionFromList: () => {},
    unloadSessionRuntime: () => {},
  };
  const registry = createTagRegistry({
    dataDir: root,
    cfgMod: { loadConfig: () => ({}) },
    mgr,
    emitSubagentEvent: () => {},
  });
  const closeFlow = createCloseFlow({ mgr, registry, views: {} });
  return { root, mgr, registry, closeFlow };
}

test("closing another caller's tag is not found and leaves the binding", async () => {
  const session = workerSession('sess_a1', 'review1', 'lead-a');
  const { root, registry, closeFlow } = setup(new Map([[session.id, session]]));
  try {
    registry.bindTag('review1', session, { status: 'idle' });
    await assert.rejects(
      closeFlow.close({ tag: 'review1' }, { callerSessionId: 'lead-b' }),
      /agent close: target "review1" not found/
    );
    assert.equal(registry.tags.get('review1'), 'sess_a1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an own stale local tag is still forgotten', async () => {
  const session = workerSession('sess_a2', 'review2', 'lead-a');
  const sessions = new Map([[session.id, session]]);
  const { root, registry, mgr } = setup(sessions);
  try {
    registry.bindTag('review2', session, { status: 'idle' });
    // resolveTag found no session for the tag; the caller's own binding remains.
    const closeFlow = createCloseFlow({ mgr, registry: { ...registry, resolveTag: () => null }, views: {} });
    const result = await closeFlow.close({ tag: 'review2' }, { callerSessionId: 'lead-a' });
    assert.equal(result.closed, true);
    assert.equal(result.forgotten, true);
    assert.equal(registry.tags.has('review2'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
