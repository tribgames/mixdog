/**
 * Persisted copy of the agent pool's session-header cache. The in-memory
 * cache of store-agent-worker-rows.mjs died with the daemon, so the first
 * pool listing after every restart re-read every worker transcript (~1,700
 * records, ~1 GB) just to rebuild headers that had not changed: seconds of
 * I/O and CPU right when the restored conversation was loading.
 *
 * The file only seeds the in-memory cache. Every seeded entry is still served
 * under that cache's full-stamp policy — the record must still have the exact
 * { dev, ino, size, mtimeNs, ctimeNs } its header was read from, a stamp that
 * was settled when cached — so a record changed while no daemon ran (or by
 * another process) is read again. Being a cache, an absent, unreadable,
 * damaged, other-version or other-field-set file seeds nothing (a bad entry
 * alone is skipped) and is replaced by the next write; writes are atomic.
 */
import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionStampOf } from './store/canonical-reader.mjs';
import { isStoredSessionId } from './store-summary-fields.mjs';
import { dataDir } from './store-summary-locations.mjs';

const VERSION = 1;
const STAMP_KEYS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
const UNSIGNED = /^\d+$/;

export function storedAgentWorkerHeaderCachePath(dir = dataDir()) {
  return join(dir, 'agent-worker-header-cache.json');
}

function decodeStamp(value) {
  if (!Array.isArray(value) || value.length !== STAMP_KEYS.length) return null;
  if (!value.every((part) => typeof part === 'string' && UNSIGNED.test(part))) return null;
  return sessionStampOf(Object.fromEntries(STAMP_KEYS.map((key, index) => [key, BigInt(value[index])])));
}

function decodeHeader(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.keys(value).every((key) => fields.has(key)) ? value : null;
}

/** sessionId -> { stamp, header } from the file at `path`; empty when the
 *  file is absent, unreadable, damaged, or written for another version or
 *  header field list. */
export async function readPersistedWorkerHeaders(path, fields) {
  const entries = new Map();
  let doc;
  try {
    doc = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return entries;
  }
  if (doc?.version !== VERSION || doc.fields !== fields.join(',')) return entries;
  if (!doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions)) return entries;
  const wanted = new Set(fields);
  for (const [sessionId, entry] of Object.entries(doc.sessions)) {
    if (!isStoredSessionId(sessionId) || !entry || typeof entry !== 'object') continue;
    const stamp = decodeStamp(entry.stamp);
    const header = decodeHeader(entry.header, wanted);
    if (stamp && header) entries.set(sessionId, { stamp, header });
  }
  return entries;
}

/** Replaces the file at `path` with `entries` (sessionId -> { stamp, header })
 *  by rename, so a reader sees the old file or the new one, never a torn one.
 *  Resolves false instead of throwing: a lost write only costs the next
 *  restart some re-reads. The data directory is never created: a store that
 *  is gone gets no cache. */
export async function writePersistedWorkerHeaders(path, fields, entries) {
  const sessions = {};
  for (const [sessionId, { stamp, header }] of entries) {
    sessions[sessionId] = { stamp: STAMP_KEYS.map((key) => String(stamp[key])), header };
  }
  // The temp shape is atomic-file.mjs's `<name>.mixdog-tmp-<hex>`.
  const tmp = `${path}.mixdog-tmp-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify({ version: VERSION, fields: fields.join(','), sessions }), { flag: 'wx' });
    await rename(tmp, path);
    return true;
  } catch {
    await unlink(tmp).catch(() => {});
    return false;
  }
}
