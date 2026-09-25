// Desktop session metadata (generated titles, user names, archive stamps and
// shared read cursors) on
// disk. The service keeps the live maps while this module owns the file shape:
// validation, the pre-v2 reset, and the atomic
// owner-only write.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';

import { generatedSessionTitle, normalizeSessionTitle } from '../shared/session-title.mjs';
import { isSessionId } from './desktop-state';

const FILE_NAME = 'desktop-session-metadata.json';

interface SessionMetadataMaps {
  titles: Record<string, string>;
  names: Record<string, string>;
  archived: Record<string, number>;
  reads: Record<string, SessionReadCursor>;
  /** A stored title that no longer matches the current generator was rewritten
   *  in memory; the caller persists it. */
  rewritten: boolean;
}

export interface SessionReadCursor {
  messageCount: number;
  revision: number;
}

function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Read and validate the metadata file. A missing/corrupt file and any
 *  pre-v2 shape (dev-era artifact) both start clean rather than migrating. */
export async function readSessionMetadata(root: string): Promise<SessionMetadataMaps> {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await readFile(join(root, FILE_NAME), 'utf8'));
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
      parsed = value as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw new Error('Desktop session metadata could not be loaded.', { cause: error });
    }
  }
  let rewritten = false;
  const normalizedMap = (source: unknown, generated = false): Record<string, string> => {
    const result = emptyMap<string>();
    if (!source || typeof source !== 'object' || Array.isArray(source)) return result;
    for (const [id, value] of Object.entries(source)) {
      if (!isSessionId(id) || typeof value !== 'string') continue;
      const title = generated ? generatedSessionTitle(value, '') : normalizeSessionTitle(value, '');
      if (generated && title !== value.trim()) rewritten = true;
      if (title) result[id] = title;
    }
    return result;
  };
  const legacy = parsed.version !== 2;
  const archived = emptyMap<number>();
  const archivedRaw = legacy ? null : parsed.archived;
  if (archivedRaw && typeof archivedRaw === 'object' && !Array.isArray(archivedRaw)) {
    for (const [id, value] of Object.entries(archivedRaw as Record<string, unknown>)) {
      if (!isSessionId(id)) continue;
      const at = Number(value);
      if (Number.isFinite(at) && at > 0) archived[id] = at;
    }
  }
  const reads = emptyMap<SessionReadCursor>();
  const readsRaw = legacy ? null : parsed.reads;
  if (readsRaw && typeof readsRaw === 'object' && !Array.isArray(readsRaw)) {
    for (const [id, value] of Object.entries(readsRaw as Record<string, unknown>)) {
      if (!isSessionId(id) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const cursor = value as Record<string, unknown>;
      const messageCount = Number(cursor.messageCount);
      const revision = Number(cursor.revision);
      if (!Number.isInteger(messageCount) || messageCount < 0 || messageCount > 10_000_000) continue;
      if (!Number.isSafeInteger(revision) || revision < 1) continue;
      reads[id] = { messageCount, revision };
    }
  }
  return {
    titles: legacy ? emptyMap<string>() : normalizedMap(parsed.titles, true),
    names: legacy ? emptyMap<string>() : normalizedMap(parsed.names),
    archived,
    reads,
    rewritten: !legacy && rewritten,
  };
}

/** Publish the maps atomically (temp + rename, owner-only). `archived` is
 *  omitted when empty so the no-archive file shape stays byte-identical. */
export async function writeSessionMetadata(
  root: string,
  maps: {
    titles: Record<string, string>;
    names: Record<string, string>;
    archived: Record<string, number>;
    reads: Record<string, SessionReadCursor>;
  }
): Promise<void> {
  const target = join(root, FILE_NAME);
  const payload = {
    version: 2 as const,
    titles: maps.titles,
    names: maps.names,
    ...(Object.keys(maps.archived).length ? { archived: maps.archived } : {}),
    ...(Object.keys(maps.reads).length ? { reads: maps.reads } : {}),
  };
  await writeJsonAtomicAsync(target, payload, { secret: true });
}
