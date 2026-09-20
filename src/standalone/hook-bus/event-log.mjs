/**
 * hook-bus/event-log.mjs — the observer log every hook event lands in: a
 * bounded recent list, per-event counts, and the cwd cursor the next config
 * lookup defaults to.
 */
import { DEFAULT_EVENTS } from './constants.mjs';
import { compactValue, summarizePayload } from './payload.mjs';

export function createHookEventLog({ maxEvents, cursor }) {
  const recent = [];
  const counts = new Map(DEFAULT_EVENTS.map((name) => [name, 0]));

  function emit(name, payload = {}) {
    const eventName = String(name || '').trim();
    if (!eventName) return null;
    if (payload?.cwd) cursor.cwd = payload.cwd;
    counts.set(eventName, (counts.get(eventName) || 0) + 1);
    const entry = {
      ts: new Date().toISOString(),
      name: eventName,
      summary: summarizePayload(payload),
      payload: compactValue(payload),
    };
    recent.push(entry);
    while (recent.length > maxEvents) recent.shift();
    return entry;
  }

  return { emit, recent, counts };
}
