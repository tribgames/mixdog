/**
 * AbortController helpers — ported from a reference agent CLI pattern.
 *
 * `createAbortController()` raises the signal's max listener cap so long-running
 * sessions with many per-iteration handlers don't trip Node's default warning.
 */
import { setMaxListeners } from 'events';

const DEFAULT_MAX_LISTENERS = 50;

export function createAbortController(maxListeners = DEFAULT_MAX_LISTENERS) {
  const controller = new AbortController();
  try { setMaxListeners(maxListeners, controller.signal); } catch { /* node < 19 fallback */ }
  return controller;
}
