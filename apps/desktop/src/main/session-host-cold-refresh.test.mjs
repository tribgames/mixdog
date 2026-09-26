import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionService } from '../../../../src/standalone/session-service.mjs';
import { SessionHostCatalog } from './session-host-catalog.ts';
import { SessionHostPublication } from './session-host-publication.ts';
import { SessionHostTransport } from './session-host-transport.ts';

// Six legacy 512-item cold views on the refresh clock: an unchanged session
// is neither read nor re-published; a written one is refreshed.
test('the cold-view refresh skips unchanged sessions and refreshes a written one', async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `sess_cold_${index}`);
  const stamps = new Map(ids.map((id) => [id, `${id}:1`]));
  const reads = [];
  let parses = 0;
  const service = createSessionService({
    createSessionRuntime: async () => {
      throw new Error('cold views never materialize');
    },
    sessionExists: async () => true,
    statStoredSession: async (id) => stamps.get(id),
    readStoredSession: async (sessionId) => {
      reads.push(sessionId);
      parses += 1;
      return {
        sessionId,
        projectionStamp: `projection-${parses}`,
        items: [{ id: 'row', kind: 'assistant', text: stamps.get(sessionId) }],
        queued: [],
      };
    },
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  const viewer = { clientToken: 'desktop' };
  const visible = new Set(ids);
  const published = [];
  let transport;
  const publication = new SessionHostPublication({
    isDisposed: () => false,
    controlSessionId: () => '',
    setControlSessionId: () => {},
    visibleSessionIds: () => visible,
    readSession: (id) => transport.readSession(id),
    snapshotWithShellJobs: (_id, snapshot) => snapshot,
    trackShellJobsEngineState: () => {},
    onShellPublished: () => {},
  });
  publication.subscribeSessionStates((update) => published.push(update));
  transport = new SessionHostTransport(
    {
      read: (args) => service.readSession(args, viewer),
      subscribe: (args) => service.subscribeSession(args, viewer),
    },
    {
      isDisposed: () => false,
      taskWorkspace: async () => '',
      openHints: () => ({ resumeOptions: { transcriptItemLimit: 512 } }),
      transcriptWindow: () => ({ transcriptItemLimit: 512 }),
      projection: (id) => {
        const projection = publication.projections.get(id);
        return projection && { revision: projection.revision, projectionStamp: projection.projectionStamp };
      },
      applySessionResult: (id, value, publish) => publication.applySessionResult(id, value, publish),
      deleteProjection: (id) => publication.projections.delete(id),
    }
  );
  const catalog = new SessionHostCatalog(
    {
      isDisposed: () => false,
      listSessions: async () => [],
      listAgentPool: async () => [],
      publishSessions: () => {},
      publishAgents: () => {},
      coldSessionIds: () => ids.filter((id) => publication.projections.get(id)?.cold),
      readSession: (id) => transport.readSession(id),
    },
    { directory: () => '' }
  );
  try {
    for (const id of ids) {
      const result = await service.subscribeSession(
        { sessionId: id, open: { resumeOptions: { transcriptItemLimit: 512 } }, transcriptItemLimit: 512 },
        viewer
      );
      publication.applySessionResult(id, result, false);
    }
    reads.length = 0;
    for (let tick = 0; tick < 3; tick += 1) await catalog.refreshColdViews();
    assert.deepEqual(reads, [], 'no unchanged session is read');
    assert.deepEqual(published, [], 'nor re-published');

    stamps.set(ids[2], `${ids[2]}:2`);
    await catalog.refreshColdViews();
    assert.deepEqual(reads, [ids[2]]);
    assert.deepEqual(
      published.map((update) => update.sessionId),
      [ids[2]]
    );
    assert.equal(published[0].snapshot.items[0].text, `${ids[2]}:2`);
    await catalog.refreshColdViews();
    assert.deepEqual(reads, [ids[2]], 'refreshed once, then unchanged again');
  } finally {
    catalog.close();
    await service.stop('test complete');
  }
});
