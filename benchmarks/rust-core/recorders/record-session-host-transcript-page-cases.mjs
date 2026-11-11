#!/usr/bin/env node
// Recording of apps/desktop/src/main/session-host-transcript-page.test.mjs (b6f10295a): an older transcript page across the daemon hop.
// The real session service (createSessionService with a scripted stored-session reader over 300 rows) read through the desktop's
// SessionHostTransport / SessionHostPublication / SessionTranscriptWindows. Per case: every read the transport sent (args, the reply's
// shape and byte size) and the snapshot the host then held.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-session-host-transcript-page-cases.mjs --tree <export of b6f10295a with node_modules>
import { createHash } from 'node:crypto';
import { openSet } from './lib/case-set.mjs';

const set = openSet('session-host-transcript-page-cases', import.meta.url);
const { createSessionService } = await set.load('src/standalone/session-service.mjs');
const { SessionHostPublication } = await set.load('apps/desktop/src/main/session-host-publication.ts');
const { SessionHostTransport } = await set.load('apps/desktop/src/main/session-host-transport.ts');
const { SessionTranscriptWindows } = await set.load('apps/desktop/src/main/session-transcript-windows.ts');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const item = (id) => ({ id, kind: 'assistant', text: `row ${id} `.repeat(50) });
const ids = (items) => items.map((row) => row.id);
/** A reply with its rows reduced to ids + sha256 (the rows are `row <id> ` repeated: the id fixes them). */
const replyShape = (reply) => {
  const shape = { keys: Object.keys(reply.result), args: reply.args, bytes: reply.bytes };
  for (const key of ['page', 'full']) if (reply.result[key]) shape[key] = { keys: Object.keys(reply.result[key]), itemIds: reply.result[key].items ? ids(reply.result[key].items) : null, itemsSha256: reply.result[key].items ? sha(JSON.stringify(reply.result[key].items)) : null, transcriptHasOlder: reply.result[key].transcriptHasOlder ?? null };
  shape.projectionStamp = reply.result.projectionStamp ?? null;
  return shape;
};

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
    { read: async (args) => { const result = await service.readSession(args, viewer); reads.push({ args: JSON.parse(JSON.stringify(args)), result, bytes: Buffer.byteLength(JSON.stringify(result)) }); beforeReply(publication, id, result); return result; } },
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
    const held = f.publication.projections.get(f.id).snapshot.items;
    const snapshot = await f.nextPage();
    const reply = f.reads.at(-1);
    const projection = f.publication.projections.get(f.id);
    return {
      historyRows: 300, rowChars: item('c0').text.length,
      openReadCount: f.reads.length - 1, heldIdsBeforePage: ids(held), reply: replyShape(reply),
      replyBytesUnder80PercentOfSnapshot: reply.bytes < Buffer.byteLength(JSON.stringify(snapshot)) * 0.8, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      snapshotIds: ids(snapshot.items), transcriptHasOlder: snapshot.transcriptHasOlder,
      heldRowsKeptAsSameObjects: held.every((row, index) => projection.snapshot.items[64 + index] === row), projectionCold: projection.cold, projectionStampEqualsReply: projection.projectionStamp === reply.result.projectionStamp,
      readsInTotal: f.reads.length,
    };
  } finally { await f.service.stop('test complete'); }
});
await set.run('a session that changed between reads answers the page in full', async () => {
  const f = fixture();
  try {
    await f.open();
    f.grow([item('n0'), item('n1')]);
    const snapshot = await f.nextPage();
    const reply = f.reads.at(-1);
    return { appendedRows: ['n0', 'n1'], reply: replyShape(reply), hasPage: Object.hasOwn(reply.result, 'page'), hasFull: Boolean(reply.result.full), lastId: snapshot.items.at(-1).id, count: snapshot.items.length, snapshotIds: ids(snapshot.items) };
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
    return { readsInTotal: f.reads.length, secondRead: replyShape(f.reads[1]), secondReadArgsHeld: f.reads[1].args.transcriptHeld ?? null, secondReadBaseRevision: f.reads[1].args.baseRevision ?? null, firstRead: replyShape(f.reads[0]), secondReadIsFull: Boolean(f.reads[1].result.full), snapshotIds: ids(snapshot.items) };
  } finally { await f.service.stop('test complete'); }
});

await set.finish({
  entry: { runs: 'createSessionService (subscribeSession, readSession) with a scripted readStoredSession over 300 rows, SessionHostTransport.readSession, SessionHostPublication (projections, applySessionResult, applyTranscriptPage, heldTranscript), SessionTranscriptWindows', notRun: 'no real store or runtime; the viewer is one local client token' },
  replay: { entry: 'mixdog-app-server thread/items/list: replay the open and the next-page read; compare the read args the host sent, the reply shape (page/full, item ids and sha256, byte size) and the held snapshot ids', normalised: { rows: 'reply rows are recorded as ids plus sha256 of the rows (each row is `row <id> ` x50)' } },
});
process.exit(0);
