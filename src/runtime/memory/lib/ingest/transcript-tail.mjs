// ingest/transcript-tail.mjs
// One incremental read of a transcript file: the bytes past the persisted
// offset, split into complete JSONL lines, stored as conversation rows. The
// persisted boundary only advances past lines that were fully consumed (parsed
// + inserted or intentionally skipped); a malformed trailing line (mid-write
// partial) or a transient insert error stops the walk and leaves the boundary
// untouched so the next sweep retries from the same position instead of
// silently consuming the line forever.
import fs from 'node:fs';
import path from 'node:path';
import { cwdFromTranscriptPath, transcriptRowFromLine } from './transcript-rows.mjs';

/** Bytes appended since `prev`, or null when there is nothing new. A
 *  truncate/rewrite (size shrank below the persisted byte offset) restarts at
 *  zero and bumps the per-file generation: the rewritten lines would otherwise
 *  reuse the SAME transcript:${uuid}#${index} refs as the pre-truncate content
 *  and be silently dropped by ON CONFLICT DO NOTHING. Existing rows (gen 0, no
 *  suffix) are unaffected. */
async function readTranscriptTail(transcriptPath, prev) {
  let stat;
  try {
    stat = await fs.promises.stat(transcriptPath);
  } catch {
    return null;
  }
  let generation = Number(prev.generation) || 0;
  let bytes = prev.bytes;
  let lineIndex = prev.lineIndex;
  if (stat.size < bytes) {
    bytes = 0;
    lineIndex = 0;
    generation += 1;
  }
  if (stat.size <= bytes) return null;
  const fh = await fs.promises.open(transcriptPath, 'r');
  const buf = Buffer.alloc(stat.size - bytes);
  try {
    await fh.read(buf, 0, buf.length, bytes);
  } finally {
    await fh.close();
  }
  return { text: buf.toString('utf8'), bytes, lineIndex, generation };
}

/** Complete lines of `text` with the byte width each one consumes. A final
 *  segment without a trailing newline is a partial line still being written;
 *  it is not yielded, so it is re-read once the writer flushes. */
function* completeLines(text) {
  let cursor = 0;
  while (cursor < text.length) {
    const nl = text.indexOf('\n', cursor);
    if (nl === -1) return;
    const rawLine = text.slice(cursor, nl);
    cursor = nl + 1;
    yield { line: rawLine.replace(/\r$/, ''), consumedBytes: Buffer.byteLength(rawLine, 'utf8') + 1 };
  }
}

function transcriptSourceRef(sessionUuid, index, generation) {
  return generation > 0 ? `transcript:${sessionUuid}#${index}@g${generation}` : `transcript:${sessionUuid}#${index}`;
}

/** Ingests the new lines of one transcript and persists the advanced
 *  boundary. Returns the number of rows inserted. */
export async function ingestTranscriptTail({ db, transcriptPath, cwd, offsets, resolveProjectId, log }) {
  const tail = await readTranscriptTail(transcriptPath, offsets.snapshot(transcriptPath));
  if (!tail) return 0;
  const sessionUuid = path.basename(transcriptPath, '.jsonl');
  const resolvedCwd = typeof cwd === 'string' && cwd ? cwd : cwdFromTranscriptPath(transcriptPath);
  // No cwd resolved -> classify as COMMON (project_id NULL). Falling back to
  // process.cwd() would misclassify rows under the service/plugin cwd.
  const projectId = resolvedCwd ? resolveProjectId(resolvedCwd) : null;
  const boundary = { bytes: tail.bytes, lineIndex: tail.lineIndex, generation: tail.generation };
  let index = tail.lineIndex;
  let count = 0;
  for (const { line, consumedBytes } of completeLines(tail.text)) {
    if (!line) {
      boundary.bytes += consumedBytes;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      break; // malformed line: do not advance past it; retry on next sweep
    }
    index += 1;
    const row = transcriptRowFromLine(parsed);
    if (row) {
      const sourceRef = transcriptSourceRef(sessionUuid, index, tail.generation);
      try {
        const result = await db.query(
          `INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id, time_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING`,
          [row.tsMs, row.role, row.content, sourceRef, sessionUuid, index, projectId, row.timeSource]
        );
        if (Number(result.rowCount ?? result.affectedRows ?? 0) > 0) count += 1;
      } catch (e) {
        log(`[transcript-watch] insert error (${sourceRef}): ${e.message}\n`);
        break; // transient insert failure: the boundary stays before this line
      }
    }
    boundary.bytes += consumedBytes;
    boundary.lineIndex = index;
  }
  offsets.set(transcriptPath, boundary);
  await offsets.persist();
  return count;
}
