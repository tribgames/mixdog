/**
 * One conversation per automation name: schedule/webhook fires reuse the
 * newest open session with the same (sourceType, sourceName) so every run
 * stacks as a turn in ONE resumable session (user decision — the desktop
 * sidebar shows a single Automations row per name instead of one Recent row
 * per fire). Tombstoned (closed) sessions are skipped, so archiving-by-close
 * or deletion naturally starts a fresh conversation on the next fire.
 */
import { listStoredSessionSummaries } from '../agent/orchestrator/session/store-summary-reader.mjs';
import { updateSessionRoute } from '../agent/orchestrator/session/manager/session-lifecycle.mjs';

/**
 * Find and route-refresh the newest reusable session for an automation name.
 * Returns the live session object, or null when no open session exists.
 */
export function reuseAutomationSession(sourceType, sourceName, route) {
  const wantedType = String(sourceType || '').trim().toLowerCase();
  const wantedName = String(sourceName || '').trim().toLowerCase();
  if (!wantedType || !wantedName) return null;
  let rows = [];
  // Fresh file scan (not the sidecar index): a fire moments after the
  // previous one must find the session that run just saved even when the
  // summary index lags behind the store.
  try { rows = listStoredSessionSummaries({ refreshFromStorage: true }); } catch { return null; }
  for (const row of rows) { // rows are activity-desc — newest match wins
    if (row?.closed === true) continue;
    if (String(row?.sourceType || '').trim().toLowerCase() !== wantedType) continue;
    if (String(row?.sourceName || '').trim().toLowerCase() !== wantedName) continue;
    // Route refresh: model/effort edits between fires apply to the SAME
    // conversation. updateSessionRoute reloads context meta + cache keys,
    // registers the session live, and schedules the save; it returns null
    // for closed/corrupt sessions, which falls through to the next row.
    const session = updateSessionRoute(row.id, {
      provider: route.provider,
      model: route.model,
      effort: route.effort || null,
      fast: route.fast === true,
    });
    if (session) return session;
  }
  return null;
}
