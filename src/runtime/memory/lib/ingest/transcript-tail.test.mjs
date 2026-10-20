import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ingestTranscriptTail } from './transcript-tail.mjs';

test('a NUL run or a damaged line in a transcript does not block the lines after it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-transcript-tail-'));
  const file = join(dir, 'session-1.jsonl');
  const user = (text) =>
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from(`${user('first')}\n`),
      Buffer.alloc(40),
      Buffer.from(`\n{"torn":\n${user('second')}\n`),
      Buffer.alloc(16),
      Buffer.from(`${user('third')}\n`),
    ])
  );
  const inserted = [];
  const db = {
    query: async (_sql, params) => {
      inserted.push(params[2]);
      return { rowCount: 1 };
    },
  };
  let position = null;
  const offsets = {
    snapshot: () => ({ bytes: 0, lineIndex: 0, generation: 0 }),
    set: (_path, value) => {
      position = value;
    },
    persist: async () => {},
  };
  try {
    const count = await ingestTranscriptTail({
      db,
      transcriptPath: file,
      cwd: dir,
      offsets,
      resolveProjectId: () => null,
      log: () => {},
    });
    assert.deepEqual(inserted, ['first', 'second', 'third']);
    assert.equal(count, 3);
    assert.equal(
      position.bytes,
      Buffer.byteLength(`${user('first')}\n`) +
        41 +
        9 +
        Buffer.byteLength(`${user('second')}\n`) +
        16 +
        Buffer.byteLength(`${user('third')}\n`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
