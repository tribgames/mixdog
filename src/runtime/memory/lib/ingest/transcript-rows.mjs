// ingest/transcript-rows.mjs
// Pure helpers over one transcript JSONL row: timestamp coercion, cwd
// extraction from the first rows of a file, and the conversation-row shape the
// watcher stores (same purity as ingest_session).
import fs from 'node:fs';
import { sessionMessageContentForIngest, shouldExcludeIngestMessage } from '../session-ingest.mjs';

// Coerce a transcript timestamp (seconds, ms, or ISO string) to ms and
// preserve whether it came from the source or was synthesized at collection.
export function parseTsWithSource(value, fallbackMs = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { tsMs: value < 1e12 ? value * 1000 : value, timeSource: 'recorded' };
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed)
    ? { tsMs: parsed, timeSource: 'recorded' }
    : { tsMs: fallbackMs, timeSource: 'collected' };
}

export function parseTsToMs(value) {
  return parseTsWithSource(value).tsMs;
}

// Extract cwd from the transcript file's JSONL rows. Mixdog embeds the session
// cwd as a top-level `cwd` field on every message row, so scanning the first
// few lines is reliable on all platforms without slug-decoding ambiguity.
// Returns undefined when no cwd is found or the extracted path does not exist
// on disk (falls back to COMMON).
export function cwdFromTranscriptPath(fp) {
  let fd;
  try {
    fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 100 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    fd = undefined;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj.cwd === 'string' && obj.cwd) {
          const candidate = obj.cwd;
          try {
            if (fs.statSync(candidate).isDirectory()) return candidate;
          } catch {}
        }
      } catch {}
    }
  } catch {
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return undefined;
}

/** The row a parsed transcript line contributes, or null when the line is not
 *  a pure conversation row. Transcript lines carry the role either as
 *  message.role (legacy) or as the top-level `type` field
 *  ({"type":"assistant","message":{...}} — the current session-runtime
 *  writer); reading only message.role silently skipped EVERY line of
 *  current-format transcripts. Reuses the ingest_session shape/exclude
 *  predicates so only pure conversation rows are stored (strips manager.mjs
 *  prefix envelopes, drops synthetic reference-files/compaction/ack/
 *  internal-notification rows). */
export function transcriptRowFromLine(parsed) {
  const role =
    parsed.message?.role ?? (parsed.type === 'user' || parsed.type === 'assistant' ? parsed.type : undefined);
  if (role !== 'user' && role !== 'assistant') return null;
  const shaped = { role, content: parsed.message?.content };
  if (shouldExcludeIngestMessage(shaped)) return null;
  const content = sessionMessageContentForIngest(shaped);
  if (!content?.trim()) return null;
  const { tsMs, timeSource } = parseTsWithSource(parsed.timestamp ?? parsed.ts);
  return { role, content, tsMs, timeSource };
}
