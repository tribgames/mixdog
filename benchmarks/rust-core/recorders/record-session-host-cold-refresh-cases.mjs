#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-host-cold-refresh.test.mjs (b6f10295a): six legacy 512-item cold views on the refresh
// clock. The real session service (src/standalone/session-service.mjs createSessionService) with scripted stored-session stat/read
// functions, the desktop's SessionHostPublication / SessionHostTransport / SessionHostCatalog (refreshColdViews). Recorded: the stored
// sessions read per tick and the session-state updates published.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-host-cold-refresh-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-host-cold-refresh-cases', import.meta.url);
const { createSessionService } = await set.load('src/standalone/session-service.mjs');
const { SessionHostCatalog } = await set.load('apps/desktop/src/main/session-host-catalog.ts');
const { SessionHostPublication } = await set.load('apps/desktop/src/main/session-host-publication.ts');
const { SessionHostTransport } = await set.load('apps/desktop/src/main/session-host-transport.ts');

await set.run('the cold-view refresh skips unchanged sessions and refreshes a written one', async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `sess_cold_${index}`);
  const stamps = new Map(ids.map((id) => [id, `${id}:1`]));
  const reads = [];
  let parses = 0;
  const service = createSessionService({
    createSessionRuntime: async () => { throw new Error('cold views never materialize'); },
    sessionExists: async () => true,
    statStoredSession: async (id) => stamps.get(id),
    readStoredSession: async (sessionId) => { reads.push(sessionId); parses += 1; return { sessionId, projectionStamp: `projection-${parses}`, items: [{ id: 'row', kind: 'assistant', text: stamps.get(sessionId) }], queued: [] }; },
    idleEvictMs: 60_000, evictSweepMs: 60_000,
  });
  const viewer = { clientToken: 'desktop' };
  const visible = new Set(ids);
  const published = [];
  let transport;
  const publication = new SessionHostPublication({ isDisposed: () => false, controlSessionId: () => '', setControlSessionId: () => {}, visibleSessionIds: () => visible, readSession: (id) => transport.readSession(id), snapshotWithShellJobs: (_id, snapshot) => snapshot, trackShellJobsEngineState: () => {}, onShellPublished: () => {} });
  publication.subscribeSessionStates((update) => published.push(structuredClone(update)));
  transport = new SessionHostTransport(
    { read: (args) => service.readSession(args, viewer), subscribe: (args) => service.subscribeSession(args, viewer) },
    {
      isDisposed: () => false, taskWorkspace: async () => '', openHints: () => ({ resumeOptions: { transcriptItemLimit: 512 } }), transcriptWindow: () => ({ transcriptItemLimit: 512 }),
      projection: (id) => { const projection = publication.projections.get(id); return projection && { revision: projection.revision, projectionStamp: projection.projectionStamp }; },
      applySessionResult: (id, value, publish) => publication.applySessionResult(id, value, publish), deleteProjection: (id) => publication.projections.delete(id),
    },
  );
  const catalog = new SessionHostCatalog(
    { isDisposed: () => false, listSessions: async () => [], listAgentPool: async () => [], publishSessions: () => {}, publishAgents: () => {}, coldSessionIds: () => ids.filter((id) => publication.projections.get(id)?.cold), readSession: (id) => transport.readSession(id) },
    { directory: () => '' },
  );
  try {
    for (const id of ids) {
      const result = await service.subscribeSession({ sessionId: id, open: { resumeOptions: { transcriptItemLimit: 512 } }, transcriptItemLimit: 512 }, viewer);
      publication.applySessionResult(id, result, false);
    }
    const openReads = [...reads];
    reads.length = 0;
    for (let tick = 0; tick < 3; tick += 1) await catalog.refreshColdViews();
    const unchanged = { readsAfterThreeTicks: [...reads], published: [...published] };
    stamps.set(ids[2], `${ids[2]}:2`);
    await catalog.refreshColdViews();
    const written = { reads: [...reads], published: [...published] };
    await catalog.refreshColdViews();
    return { sessions: ids, initialStamps: ids.map((id) => `${id}:1`), openReads, unchanged, writtenSession: ids[2], written, readsAfterNextTick: [...reads] };
  } finally { catalog.close(); await service.stop('test complete'); }
});

await set.finish({
  entry: { hops: "No wire in the Node test: the daemon client is the real session service called in process.", runs: 'createSessionService (readSession / subscribeSession) with scripted statStoredSession / readStoredSession, SessionHostPublication, SessionHostTransport, SessionHostCatalog.refreshColdViews', notRun: 'no real session store or runtime (cold views never materialize); the service\'s idle sweep timers are its own (60 s, never reached)' },
  replay: { entry: 'mixdog-app-server thread reads: replay the open of six cold sessions, three refresh ticks and the one rewrite; compare the stored sessions read per tick and the session-state updates published (whole)', normalised: {} },
});
process.exit(0);
