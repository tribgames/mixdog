/**
 * src/tui/session/live-share/delta.mjs - owner-side frame shaping: the live
 * state subset mirrored to viewers, the full snapshot frame, and the
 * frame-to-frame delta against the last published baseline.
 */
// Above this many patched rows per frame the delta degenerates to a full
// items push (bulk rewrites: compaction, clear, history restore).
const MAX_FRAME_PATCHES = 48;

// Live-state mirror (attach parity): the transcript alone left an attached
// viewer blind to the owner's activity — busy/stop state, the queued
// follow-up list, the web-search summary, agent workers/jobs, and the
// context gauge stats all live in owner process state. Mirror a compact
// subset so viewer surfaces render them natively. queued entries are
// projected to display fields only (content parts may carry images).
const LIVE_STATS_KEYS = [
  'currentContextSource',
  'currentContextTokens',
  'currentEstimatedContextTokens',
  'currentContextUpdatedAt',
  'costUsd',
  'turns',
  'inputTokens',
  'outputTokens',
  'latestInputTokens',
  'latestPromptTokens',
  'contextTokens',
];

function liveStateOf(st) {
  const stats = st.stats && typeof st.stats === 'object' ? st.stats : {};
  const statsSubset = {};
  for (const key of LIVE_STATS_KEYS) {
    if (stats[key] !== undefined) statsSubset[key] = stats[key];
  }
  return {
    busy: st.busy === true,
    commandBusy: st.commandBusy === true,
    queued: (Array.isArray(st.queued) ? st.queued : []).map((entry) => ({
      id: entry?.id,
      text: String(entry?.displayText ?? entry?.text ?? entry?.message ?? '').slice(0, 2000),
      ...(entry?.enqueuedAt ? { enqueuedAt: entry.enqueuedAt } : {}),
    })),
    activeToolSummary: st.activeToolSummary || null,
    activeTools: st.activeTools || null,
    agentWorkers: Array.isArray(st.agentWorkers) ? st.agentWorkers : [],
    agentJobs: Array.isArray(st.agentJobs) ? st.agentJobs : [],
    ownerClientHostPid: Number(st.clientHostPid) || process.pid,
    displayContextWindow: Number(st.displayContextWindow) || 0,
    compactBoundaryTokens: Number(st.compactBoundaryTokens) || 0,
    autoCompactTokenLimit: Number(st.autoCompactTokenLimit) || 0,
    stats: statsSubset,
  };
}

export function fullFrame(sessionId, st) {
  return {
    t: 'full',
    sessionId,
    items: Array.isArray(st.items) ? st.items : [],
    tail: st.streamingTail || null,
    spinner: st.spinner || null,
    live: liveStateOf(st),
  };
}

// References the next delta is computed against. Pure pointer assignments,
// so re-baselining on every publish with no viewers is effectively free.
export function baselineOf(st, liveSig = JSON.stringify(liveStateOf(st))) {
  return { items: st.items, tail: st.streamingTail, spinner: st.spinner, liveSig };
}

export const EMPTY_BASELINE = Object.freeze({ items: null, tail: null, spinner: null, liveSig: '' });

function itemsDelta(prevItems, nextItems) {
  const prev = Array.isArray(prevItems) ? prevItems : [];
  const next = Array.isArray(nextItems) ? nextItems : [];
  let structural = next.length < prev.length;
  const changed = [];
  if (!structural) {
    for (let i = 0; i < prev.length; i++) {
      if (next[i] === prev[i]) continue;
      if (!next[i]?.id || next[i].id !== prev[i]?.id) {
        structural = true;
        break;
      }
      changed.push(next[i]);
      if (changed.length > MAX_FRAME_PATCHES) {
        structural = true;
        break;
      }
    }
  }
  if (structural) return { items: next };
  const delta = {};
  if (changed.length) delta.changed = changed;
  if (next.length > prev.length) delta.appended = next.slice(prev.length);
  return delta;
}

// Streaming text grows append-only frame to frame: ship just the new suffix
// so long responses stay a few bytes per frame, not O(text).
function tailDelta(prevTail, nextTail) {
  const next = nextTail || null;
  const prev = prevTail || null;
  const appendOnly =
    next &&
    prev &&
    next.id === prev.id &&
    typeof next.text === 'string' &&
    typeof prev.text === 'string' &&
    next.text.length >= prev.text.length &&
    next.text.startsWith(prev.text);
  if (!appendOnly) return { tail: next };
  const meta = {};
  for (const [key, value] of Object.entries(next)) {
    if (key === 'text') continue;
    if (!Object.is(prev[key], value)) meta[key] = value;
  }
  return {
    tailAppend: {
      id: next.id,
      base: prev.text.length,
      text: next.text.slice(prev.text.length),
      ...(Object.keys(meta).length ? { meta } : {}),
    },
  };
}

/** Delta of `st` against `baseline`; `frame` is null when nothing changed. */
export function deltaFrame(baseline, st) {
  const frame = { t: 'delta' };
  let dirty = false;
  if (st.items !== baseline.items) {
    Object.assign(frame, itemsDelta(baseline.items, st.items));
    dirty = true;
  }
  if (st.streamingTail !== baseline.tail) {
    Object.assign(frame, tailDelta(baseline.tail, st.streamingTail));
    dirty = true;
  }
  if (st.spinner !== baseline.spinner) {
    frame.spinner = st.spinner || null;
    dirty = true;
  }
  const live = liveStateOf(st);
  const liveSig = JSON.stringify(live);
  if (liveSig !== baseline.liveSig) {
    frame.live = live;
    dirty = true;
  }
  return { frame: dirty ? frame : null, baseline: baselineOf(st, liveSig) };
}
