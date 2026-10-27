import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTranscriptIngest } from './transcript-ingest.mjs';

test('transcript watcher initialization waits for the first active-session sweep', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mixdog-transcript-watch-'));
  const projectDir = path.join(root, 'project');
  const sessionId = 'sess_readiness_regression';
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  const inserts = [];
  let offsets = '{}';
  let watcher = null;

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        timestamp: new Date().toISOString(),
        cwd: projectDir,
        message: { content: 'persisted before memory readiness' },
      })}\n`
    );

    const ingest = createTranscriptIngest({
      getDb: () => ({
        async query(_sql, values) {
          inserts.push(values);
          return { rowCount: 1 };
        },
      }),
      loadMeta: async () => offsets,
      persistMeta: async (value) => {
        offsets = value;
      },
      projectsRoot: () => root,
      resolveProjectId: () => 'project-readiness',
    });

    await ingest.loadTranscriptOffsets();
    watcher = await ingest.initTranscriptWatcher();

    assert.equal(inserts.length, 1);
    assert.equal(inserts[0][2], 'persisted before memory readiness');
    assert.equal(inserts[0][4], sessionId);
  } finally {
    watcher?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("forgetTranscripts drops only the named files' persisted offsets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mixdog-transcript-forget-'));
  const keep = path.join(root, 'keep.jsonl');
  const drop = path.join(root, 'drop.jsonl');
  let persisted = JSON.stringify({
    [keep]: { bytes: 5, lineIndex: 1, generation: 0 },
    [drop]: { bytes: 9, lineIndex: 2, generation: 0 },
  });
  try {
    const ingest = createTranscriptIngest({
      getDb: () => null,
      loadMeta: async () => persisted,
      persistMeta: async (value) => {
        persisted = value;
      },
      projectsRoot: () => root,
      resolveProjectId: () => null,
    });
    await ingest.loadTranscriptOffsets();

    assert.equal(await ingest.forgetTranscripts([drop, path.join(root, 'never-seen.jsonl')]), 1);
    assert.deepEqual(Object.keys(JSON.parse(persisted)), [keep]);
    assert.equal(ingest.getOffset(drop), undefined);
    assert.equal(ingest.getOffset(keep).bytes, 5);
    assert.equal(await ingest.forgetTranscripts([drop]), 0, 'forgetting twice is a no-op');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
