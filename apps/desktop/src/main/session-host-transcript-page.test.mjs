import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionService } from '../../../../src/standalone/session-service.mjs';
import { SessionHostPublication } from './session-host-publication.ts';
import { SessionHostTransport } from './session-host-transport.ts';
import { SessionTranscriptWindows } from './session-transcript-windows.ts';

const item = (id) => ({ id, kind: 'assistant', text: `row ${id} `.repeat(50) });
const ids = (items) => items.map((row) => row.id);

function fixture({ beforeReply = () => {} } = {}) {
  const id = 'sess_page_host';
  let history = Array.from({ length: 300 }, (_, index) => item(`c${index}`));
  const service = createSessionService({
    createSessionRuntime: async () => {
      throw new Error('cold views never materialize');
    },
    sessionExists: async () => true,
    readStoredSession: async (sessionId, options) => ({
      sessionId,
      projectionStamp: `stamp:${options.transcriptItemLimit}:${history.length}`,
      items: history.slice(-options.transcriptItemLimit),
      transcriptHasOlder: history.length > options.transcriptItemLimit,
      queued: [],
    }),
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  const viewer = { clientToken: 'desktop' };
  const reads = [];
  const windows = new SessionTranscriptWindows(new Map([['desktop', new Set([id])]]));
  let transport;
  const publication = new SessionHostPublication({
    isDisposed: () => false,
    controlSessionId: () => '',
    setControlSessionId: () => {},
    visibleSessionIds: () => new Set([id]),
    readSession: (sessionId) => transport.readSession(sessionId),
    snapshotWithShellJobs: (_id, snapshot) => snapshot,
    trackShellJobsEngineState: () => {},
    onShellPublished: () => {},
  });
  transport = new SessionHostTransport(
    {
      read: async (args) => {
        const result = await service.readSession(args, viewer);
        reads.push({ args, result, bytes: Buffer.byteLength(JSON.stringify(result)) });
        beforeReply(publication, id, result);
        return result;
      },
    },
    {
      isDisposed: () => false,
      taskWorkspace: async () => '',
      openHints: () => ({}),
      transcriptWindow: (sessionId) => windows.send(sessionId),
      projection: (sessionId) => {
        const projection = publication.projections.get(sessionId);
        return projection && { revision: projection.revision, projectionStamp: projection.projectionStamp };
      },
      applySessionResult: (sessionId, value, publish) => publication.applySessionResult(sessionId, value, publish),
      heldTranscript: (sessionId) => publication.heldTranscript(sessionId),
      applyTranscriptPage: (sessionId, value, publish) => publication.applyTranscriptPage(sessionId, value, publish),
      deleteProjection: (sessionId) => publication.projections.delete(sessionId),
    }
  );
  const open = async () => {
    const result = await service.subscribeSession(
      { sessionId: id, ...windows.send(id), transcriptPrepend: true, baseRevision: null },
      viewer
    );
    publication.applySessionResult(id, result, false);
  };
  const nextPage = async () => {
    const held = publication.projections.get(id).snapshot.items.length;
    windows.grow(id, held + 64, held);
    return transport.readSession(id, false, false, undefined, true);
  };
  return {
    id,
    service,
    publication,
    reads,
    open,
    nextPage,
    grow: (rows) => {
      history = [...history, ...rows];
    },
  };
}

test('an older page crosses the daemon hop as the revealed rows only, and the host keeps its held copy', async () => {
  const f = fixture();
  try {
    await f.open();
    const held = f.publication.projections.get(f.id).snapshot.items;
    const snapshot = await f.nextPage();
    const reply = f.reads.at(-1);
    assert.deepEqual(reply.args.transcriptHeld.count, 32);
    assert.equal(reply.args.transcriptPrepend, true);
    assert.ok(reply.result.page, 'the daemon answered with a page');
    assert.equal(reply.result.page.items.length, 64);
    assert.ok(reply.bytes < Buffer.byteLength(JSON.stringify(snapshot)) * 0.8);
    assert.deepEqual(ids(snapshot.items), Array.from({ length: 96 }, (_, index) => `c${204 + index}`));
    assert.equal(snapshot.transcriptHasOlder, true);
    const projection = f.publication.projections.get(f.id);
    for (let index = 0; index < held.length; index += 1) assert.equal(projection.snapshot.items[64 + index], held[index]);
    assert.equal(projection.cold, true);
    assert.equal(projection.projectionStamp, reply.result.projectionStamp);
    assert.equal(f.reads.length, 1, 'one round trip');
  } finally {
    await f.service.stop('test complete');
  }
});

test('a session that changed between reads answers the page in full', async () => {
  const f = fixture();
  try {
    await f.open();
    // New rows landed: the host's held tail is no longer the daemon's tail.
    f.grow([item('n0'), item('n1')]);
    const snapshot = await f.nextPage();
    const reply = f.reads.at(-1);
    assert.equal(Object.hasOwn(reply.result, 'page'), false);
    assert.ok(reply.result.full);
    assert.deepEqual(snapshot.items.at(-1).id, 'n1');
    assert.equal(snapshot.items.length, 96);
  } finally {
    await f.service.stop('test complete');
  }
});

test('held rows that move while the page is in flight fall back to a full read', async () => {
  let moved = false;
  const f = fixture({
    beforeReply: (publication, id, result) => {
      if (moved || !result.page) return;
      moved = true;
      // A live frame replaced the held rows before the page reply landed.
      const projection = publication.projections.get(id);
      publication.projections.set(id, {
        ...projection,
        snapshot: { ...projection.snapshot, items: projection.snapshot.items.slice(1) },
      });
    },
  });
  try {
    await f.open();
    const snapshot = await f.nextPage();
    assert.equal(f.reads.length, 2, 'the page was dropped for one full read');
    assert.equal(f.reads[1].args.transcriptHeld, undefined);
    assert.equal(f.reads[1].args.baseRevision, null);
    assert.ok(f.reads[1].result.full);
    assert.deepEqual(ids(snapshot.items), Array.from({ length: 96 }, (_, index) => `c${204 + index}`));
  } finally {
    await f.service.stop('test complete');
  }
});
