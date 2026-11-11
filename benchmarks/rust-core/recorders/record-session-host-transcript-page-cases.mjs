#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-host-transcript-page.test.mjs (b6f10295a): an older transcript page across the daemon hop.
// The real session service (createSessionService with a scripted stored-session reader over 300 rows) read through the desktop's
// SessionHostTransport / SessionHostPublication / SessionTranscriptWindows. Per case: every read the transport sent (args, the whole reply and its byte size) and the snapshot the host then held.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-host-transcript-page-cases.mjs --tree <export of b6f10295a with node_modules>
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-host-transcript-page-cases', import.meta.url);
const { createSessionService } = await set.load('src/standalone/session-service.mjs');
const { SessionHostPublication } = await set.load('apps/desktop/src/main/session-host-publication.ts');
const { SessionHostTransport } = await set.load('apps/desktop/src/main/session-host-transport.ts');
const { SessionTranscriptWindows } = await set.load('apps/desktop/src/main/session-transcript-windows.ts');

const item = (id) => ({ id, kind: 'assistant', text: `row ${id} `.repeat(50) });
function fixture({ beforeReply = () => {} } = {}) {
  const id = 'sess_page_host';
  let history = Array.from({ length: 300 }, (_, index) => item(`c${index}`));
  const service = createSessionService({
    createSessionRuntime: async () => { throw new Error('cold views never materialize'); },
    sessionExists: async () => true,
    readStoredSession: async (sessionId, options) => ({ sessionId, projectionStamp: `stamp:${options.transcriptItemLimit}:${history.length}`, items: history.slice(-options.transcriptItemLimit), transcriptHasOlder: history.length > options.transcriptItemLimit, queued: [] }),
    idleEvictMs: 60_000, evictSweepMs: 60_000,
  });
  const viewer = { clientToken: 'desktop' };
  const reads = [];
  const windows = new SessionTranscriptWindows(new Map([['desktop', new Set([id])]]));
  let transport;
  const publication = new SessionHostPublication({ isDisposed: () => false, controlSessionId: () => '', setControlSessionId: () => {}, visibleSessionIds: () => new Set([id]), readSession: (sessionId) => transport.readSession(sessionId), snapshotWithShellJobs: (_id, snapshot) => snapshot, trackShellJobsEngineState: () => {}, onShellPublished: () => {} });
  transport = new SessionHostTransport(
    { read: async (args) => { const result = await service.readSession(args, viewer); reads.push({ args: structuredClone(args), result: structuredClone(result), bytes: Buffer.byteLength(JSON.stringify(result)) }); beforeReply(publication, id, result); return result; } },
    {
      isDisposed: () => false, taskWorkspace: async () => '', openHints: () => ({}), transcriptWindow: (sessionId) => windows.send(sessionId),
      projection: (sessionId) => { const projection = publication.projections.get(sessionId); return projection && { revision: projection.revision, projectionStamp: projection.projectionStamp }; },
      applySessionResult: (sessionId, value, publish) => publication.applySessionResult(sessionId, value, publish), heldTranscript: (sessionId) => publication.heldTranscript(sessionId),
      applyTranscriptPage: (sessionId, value, publish) => publication.applyTranscriptPage(sessionId, value, publish), deleteProjection: (sessionId) => publication.projections.delete(sessionId),
    },
  );
  const open = async () => {
    const result = await service.subscribeSession({ sessionId: id, ...windows.send(id), transcriptPrepend: true, baseRevision: null }, viewer);
    publication.applySessionResult(id, result, false);
  };
  const nextPage = async () => {
    const held = publication.projections.get(id).snapshot.items.length;
    windows.grow(id, held + 64, held);
    return transport.readSession(id, false, false, undefined, true);
  };
  return { id, service, publication, reads, open, nextPage, grow: (rows) => { history = [...history, ...rows]; } };
}

await set.run('an older page crosses the daemon hop as the revealed rows only, and the host keeps its held copy', async () => {
  const f = fixture();
  try {
    await f.open();
    const held = structuredClone(f.publication.projections.get(f.id).snapshot.items);
    const heldRows = f.publication.projections.get(f.id).snapshot.items;
    const snapshot = await f.nextPage();
    const reply = f.reads.at(-1);
    const projection = f.publication.projections.get(f.id);
    return {
      historyRows: 300, rowChars: item('c0').text.length,
      openReadCount: f.reads.length - 1, heldBeforePage: held, reads: f.reads, snapshot, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      heldRowsKeptAsSameObjects: heldRows.every((row, index) => projection.snapshot.items[64 + index] === row), projectionCold: projection.cold, projectionStamp: projection.projectionStamp,
    };
  } finally { await f.service.stop('test complete'); }
});
await set.run('a session that changed between reads answers the page in full', async () => {
  const f = fixture();
  try {
    await f.open();
    f.grow([item('n0'), item('n1')]);
    const snapshot = await f.nextPage();
    return { appendedRows: ['n0', 'n1'], reads: f.reads, snapshot };
  } finally { await f.service.stop('test complete'); }
});
await set.run('held rows that move while the page is in flight fall back to a full read', async () => {
  let moved = false;
  const f = fixture({
    beforeReply: (publication, id, result) => {
      if (moved || !result.page) return;
      moved = true;
      const projection = publication.projections.get(id);
      publication.projections.set(id, { ...projection, snapshot: { ...projection.snapshot, items: projection.snapshot.items.slice(1) } });
    },
  });
  try {
    await f.open();
    const snapshot = await f.nextPage();
    return { reads: f.reads, snapshot };
  } finally { await f.service.stop('test complete'); }
});

await set.finish({
  entry: { hops: "No wire in the Node test: the daemon client is the real session service called in process; replies are recorded as the objects returned (and their JSON byte size, a measure). A replay over the real daemon wire records the same reply objects.", runs: 'createSessionService (subscribeSession, readSession) with a scripted readStoredSession over 300 rows, SessionHostTransport.readSession, SessionHostPublication (projections, applySessionResult, applyTranscriptPage, heldTranscript), SessionTranscriptWindows', notRun: 'no real store or runtime; the viewer is one local client token' },
  replay: { entry: 'mixdog-app-server thread/items/list: replay the open and the next-page read; compare the read args the host sent, each reply whole (page/full, items, byte size) and the held snapshot whole', normalised: {} },
});
process.exit(0);
