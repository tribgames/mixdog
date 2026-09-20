// ingest/transcript-discovery.mjs
// Which files under the projects root are watchable session transcripts, and
// which of them were active recently enough for a safety sweep.
import fs from 'node:fs';
import path from 'node:path';

const ACTIVE_WINDOW_MS = 30 * 60_000;

export function isSkippedWatchPath(relOrBase) {
  return relOrBase.includes('tmp') || relOrBase.includes('cache') || relOrBase.includes('plugins');
}

export function isTranscriptJsonlName(name) {
  const base = path.basename(name);
  return base.endsWith('.jsonl') && !base.startsWith('agent-');
}

export function isWatchable(relOrBase) {
  return isTranscriptJsonlName(relOrBase) && !isSkippedWatchPath(relOrBase);
}

/** Transcripts under `root/<project>/` modified within the active window,
 *  as { path, mtime }. Unreadable directories and vanished files are skipped. */
export async function discoverActiveTranscripts(root) {
  let topLevel;
  try {
    topLevel = await fs.promises.readdir(root);
  } catch {
    return [];
  }
  const files = [];
  for (const d of topLevel) {
    if (isSkippedWatchPath(d)) continue;
    const full = path.join(root, d);
    let inner;
    try {
      inner = await fs.promises.readdir(full);
    } catch {
      continue;
    }
    for (const f of inner) {
      if (!isTranscriptJsonlName(f)) continue;
      const fp = path.join(full, f);
      try {
        const stat = await fs.promises.stat(fp);
        files.push({ path: fp, mtime: stat.mtimeMs });
      } catch {}
    }
  }
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  return files.filter((f) => f.mtime > cutoff);
}
