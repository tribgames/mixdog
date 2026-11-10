/**
 * The one strict loader of a legacy `<id>.json` record: its text → that
 * session's document, or null. A leaf (no store dependency) so every reader,
 * the session-log seam and the migration worker (by URL) share it; it adds no
 * lifecycle defaults (serialize.mjs `_storedSessionFromText` does, on top).
 */
import { isLifecycleUnreadable, readTopLevelLifecycleRecord } from '../lifecycle-scan.mjs';

/** The module and export the migration worker imports the loader from. */
export const LEGACY_SESSION_LOADER = Object.freeze({ url: import.meta.url, exportName: 'loadLegacySession' });

/** `text` as session `sessionId`'s document when it is a strict,
 *  duplicate-free record of that id, else null. */
export function loadLegacySession(text, sessionId) {
  try {
    // A plain JSON.parse resolves a duplicate top-level `id` last-wins, so
    // `{"id":"other",…,"id":"me"}` would read as this file's own session:
    // an ambiguous or malformed record is no session at all.
    const record = readTopLevelLifecycleRecord(text);
    if (isLifecycleUnreadable(record) || record.id !== sessionId) return null;
    // Older builds persisted this runtime-local snapshot; it is never reloaded.
    delete record.doc._providerPrefixGuardState;
    return record.doc;
  } catch {
    return null;
  }
}
