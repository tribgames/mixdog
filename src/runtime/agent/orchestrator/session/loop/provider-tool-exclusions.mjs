// Tools a provider left out of a request because it cannot accept their input
// schema (a Claude tool whose schema is invalid on the Antigravity bridge).
// The user is told once per session and tool on the turn's display-only stage
// channel (stage 'notice'); a call the model still makes to such a tool is
// answered with the reason instead of running it.
const sessions = new WeakMap();

function exclusionsFor(sessionRef) {
  let state = sessions.get(sessionRef);
  if (!state) {
    state = { noticed: new Set(), current: new Map() };
    sessions.set(sessionRef, state);
  }
  return state;
}

const isSessionRef = (value) => value !== null && typeof value === 'object';

/** A new provider request: exclusions describe the latest request only. */
export function beginProviderToolExclusions(sessionRef) {
  if (isSessionRef(sessionRef)) sessions.get(sessionRef)?.current.clear();
}

export function excludedToolNoticeText({ name, pointer, reason }) {
  return `Tool "${name}" was excluded from this session's requests: its input schema is invalid at ${pointer || '/'} (${reason}). Fix the tool's schema or disable the tool.`;
}

/** Record `exclusion` ({ name, pointer, reason }) for the session's current
 *  request and raise the user notice the first time this tool is excluded. */
export function recordProviderToolExclusion(sessionRef, exclusion, onStageChange) {
  const name = String(exclusion?.name || '');
  if (!name || !isSessionRef(sessionRef)) return;
  const state = exclusionsFor(sessionRef);
  state.current.set(name, exclusion);
  if (state.noticed.has(name)) return;
  state.noticed.add(name);
  try {
    onStageChange?.('notice', { tone: 'warn', message: excludedToolNoticeText(exclusion) });
  } catch {
    /* display-only */
  }
}

/** Why `name` cannot be called in the session's current request, or null. */
export function providerToolExclusionReason(sessionRef, name) {
  if (!isSessionRef(sessionRef)) return null;
  const exclusion = sessions.get(sessionRef)?.current.get(String(name || ''));
  if (!exclusion) return null;
  return `tool "${exclusion.name}" is unavailable with the current model: the provider rejected its input schema at ${exclusion.pointer || '/'} (${exclusion.reason}), so it was left out of the request; no call was sent. Use another tool, or ask the user to fix the tool's schema or disable it.`;
}
