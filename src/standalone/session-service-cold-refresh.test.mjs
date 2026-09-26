import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import * as store from '../runtime/agent/orchestrator/session/store-summary-reader.mjs';
import { createStoredSessionViews } from './daemon-stored-session-views.mjs';
import { createSessionService } from './session-service.mjs';

const LEGACY_PAGE = { open: { resumeOptions: { transcriptItemLimit: 512 } }, transcriptItemLimit: 512 };

function coldService() {
  const files = { stamp: 'file-1', version: 1 };
  const reads = [];
  const frames = [];
  let parses = 0;
  const service = createSessionService({
    createSessionRuntime: async () => {
      throw new Error('cold views never materialize');
    },
    sessionExists: async () => true,
    statStoredSession: async () => files.stamp,
    readStoredSession: async (sessionId, options) => {
      reads.push(options.transcriptItemLimit);
      parses += 1;
      return {
        sessionId,
        // Each parse is a new projection, as after a store-cache eviction.
        projectionStamp: `projection-${parses}`,
        items: [{ id: `row-${files.version}`, kind: 'assistant', text: `version ${files.version}` }],
        queued: [],
      };
    },
    onFrame: (frame) => frames.push(frame),
    idleEvictMs: 60_000,
    evictSweepMs: 60_000,
  });
  return { service, files, reads, frames };
}

test('the cold-view refresh reads nothing while the session files keep their settled stamp', async () => {
  const { service, files, reads, frames } = coldService();
  const id = 'sess_cold_refresh';
  const viewer = { clientToken: 'desktop' };
  try {
    const opened = await service.subscribeSession({ sessionId: id, ...LEGACY_PAGE }, viewer);
    assert.deepEqual(reads, [512]);
    let revision = opened.revision;
    let stamp = opened.projectionStamp;
    const refresh = () =>
      service.readSession({ sessionId: id, ...LEGACY_PAGE, baseRevision: revision, baseProjectionStamp: stamp }, viewer);

    for (let tick = 0; tick < 3; tick += 1) {
      const unchanged = await refresh();
      assert.equal(unchanged.unchanged, true);
      assert.equal(unchanged.revision, revision, 'the caller keeps its baseline: nothing to publish');
      assert.equal(unchanged.projectionStamp, stamp);
      assert.equal(Object.hasOwn(unchanged, 'full'), false);
    }
    assert.deepEqual(reads, [512], 'no read while the files are unchanged');
    assert.equal(frames.length, 0);

    // A write to the session record: the next tick reads and refreshes.
    files.stamp = 'file-2';
    files.version = 2;
    const refreshed = await refresh();
    assert.deepEqual(reads, [512, 512]);
    assert.equal(refreshed.full.items[0].text, 'version 2');
    assert.ok(refreshed.revision > revision);
    revision = refreshed.revision;
    stamp = refreshed.projectionStamp;
    assert.equal((await refresh()).unchanged, true);
    assert.deepEqual(reads, [512, 512]);

    // A stamp too fresh to vouch for (or unreadable) always reads.
    files.stamp = null;
    for (let tick = 0; tick < 2; tick += 1) {
      const reread = await refresh();
      revision = reread.revision;
      stamp = reread.projectionStamp;
    }
    assert.deepEqual(reads, [512, 512, 512, 512]);

    // Another window is another projection: it reads.
    files.stamp = 'file-3';
    const grown = await service.readSession(
      { sessionId: id, transcriptItemLimit: 600, baseRevision: revision, baseProjectionStamp: stamp },
      viewer
    );
    assert.ok(grown.full);
    assert.deepEqual(reads, [512, 512, 512, 512, 600]);

    // A baseline this daemon never issued cannot be kept, stamp or not.
    const foreign = await service.readSession(
      { sessionId: id, transcriptItemLimit: 600, baseRevision: 1, baseProjectionStamp: grown.projectionStamp },
      viewer
    );
    assert.ok(foreign.full);
  } finally {
    await service.stop('test complete');
  }
});

test('the last cold view leaving forgets the remembered file stamp', async () => {
  const { service, reads } = coldService();
  const id = 'sess_cold_forget';
  const viewer = { clientToken: 'desktop' };
  try {
    const opened = await service.subscribeSession({ sessionId: id, ...LEGACY_PAGE }, viewer);
    await service.unsubscribeSession({ sessionId: id }, viewer);
    await service.readSession(
      { sessionId: id, ...LEGACY_PAGE, baseRevision: opened.revision, baseProjectionStamp: opened.projectionStamp },
      viewer
    );
    assert.deepEqual(reads, [512, 512]);
  } finally {
    await service.stop('test complete');
  }
});

test('the stored transcript stamp is settled, and covers the record and its checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mixdog-cold-stamp-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = dir;
  const id = 'sess_stamp_probe';
  // The daemon seam delegates to the store's own export.
  const views = createStoredSessionViews({ desktopRuntime: { loadSessionStore: async () => store }, dataDir: dir });
  const stamp = (sessionId) => views.statStoredSession(sessionId);
  try {
    await mkdir(join(dir, 'sessions'), { recursive: true });
    assert.equal(await stamp(id), null, 'an absent record reads normally');
    await writeFile(join(dir, 'sessions', `${id}.json`), '{"id":"sess_stamp_probe"}');
    assert.equal(await stamp(id), null, 'a fresh write is not yet settled');
    await delay(2_200);
    const settled = await stamp(id);
    assert.match(String(settled), /\|absent$/);
    assert.equal(store.storedSessionTranscriptStamp(id), settled);
    assert.equal(await stamp(id), settled);
    await mkdir(join(dir, 'turn-checkpoints'), { recursive: true });
    await writeFile(join(dir, 'turn-checkpoints', `${id}.json`), '{}');
    assert.equal(await stamp(id), null, 'a fresh checkpoint is not yet settled');
    await delay(2_200);
    const withCheckpoint = await stamp(id);
    assert.ok(withCheckpoint && withCheckpoint !== settled && !withCheckpoint.endsWith('|absent'));
    assert.equal(await stamp('../escape'), null);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
