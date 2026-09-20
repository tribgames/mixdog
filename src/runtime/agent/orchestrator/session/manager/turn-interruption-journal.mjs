/**
 * turn-interruption-journal.mjs — delta encoding of the interruption
 * tracker's state for the checkpoint journal: appended text/reasoning, newly
 * observed tool calls/results, and phase/responseStarted transitions, keyed
 * off the epochs the tracker bumps on every non-append change.
 */

function textDelta(delta, prev, { epochKey, lenKey, setKey, appendKey }, epoch, text) {
  if (!prev || prev[epochKey] !== epoch || text.length < prev[lenKey]) {
    if (prev || text) {
      delta[setKey] = text;
      return true;
    }
    return false;
  }
  if (text.length > prev[lenKey]) {
    delta[appendKey] = text.slice(prev[lenKey]);
    return true;
  }
  return false;
}

const TEXT_KEYS = { epochKey: 'textEpoch', lenKey: 'textLen', setKey: 'ts', appendKey: 'ta' };
const REASONING_KEYS = { epochKey: 'reasoningEpoch', lenKey: 'reasoningLen', setKey: 'qs', appendKey: 'qa' };

function toolCallDelta(delta, prev, prevCalls, state) {
  let changed = false;
  // A cleared call map is a structural reset: journal the clear and
  // re-emit whatever was recorded after it.
  const callsReset = Boolean(prev) && prev.callsEpoch !== state.callsEpoch;
  if (callsReset) {
    delta.cc = true;
    changed = true;
  }
  const callSet = [];
  for (const [id, entry] of state.observedToolCalls) {
    if (!callsReset && prevCalls.get(id) === entry) continue;
    callSet.push([id, entry]);
  }
  if (callSet.length > 0) {
    delta.cs = callSet;
    changed = true;
  }
  return changed;
}

function toolResultDelta(delta, prevResults, state) {
  let changed = false;
  const resultSet = [];
  for (const [id, entry] of state.observedToolResults) {
    if (prevResults.get(id) === entry) continue;
    resultSet.push([id, entry]);
  }
  if (resultSet.length > 0) {
    delta.os = resultSet;
    changed = true;
  }
  const resultDeleted = [];
  for (const id of prevResults.keys()) {
    if (!state.observedToolResults.has(id)) resultDeleted.push(id);
  }
  if (resultDeleted.length > 0) {
    delta.od = resultDeleted;
    changed = true;
  }
  return changed;
}

/**
 * Delta of `state` against an opaque cursor from a previous call (null =
 * seed). Cost is O(new bytes + observed tool entries), never O(turn).
 * Returns { changed, delta, cursor }.
 */
export function journalDelta(state, cursor) {
  const prev = cursor && typeof cursor === 'object' ? cursor : null;
  const prevCalls = prev?.calls instanceof Map ? prev.calls : new Map();
  const prevResults = prev?.results instanceof Map ? prev.results : new Map();
  const delta = {};
  let changed = false;
  if (prev ? prev.responseStarted !== state.responseStarted : state.responseStarted) {
    delta.rs = state.responseStarted;
    changed = true;
  }
  if (prev ? prev.phase !== state.phase : state.phase !== 'streaming') {
    delta.ph = state.phase;
    changed = true;
  }
  if (textDelta(delta, prev, TEXT_KEYS, state.textEpoch, state.partialAssistantContent)) changed = true;
  if (textDelta(delta, prev, REASONING_KEYS, state.reasoningEpoch, state.partialReasoningContent)) changed = true;
  if (!prev || prev.tombEpoch !== state.tombEpoch) {
    if (prev || state.tombstonedAssistantContent) {
      delta.tb = state.tombstonedAssistantContent;
      changed = true;
    }
  }
  if (toolCallDelta(delta, prev, prevCalls, state)) changed = true;
  if (toolResultDelta(delta, prevResults, state)) changed = true;
  return {
    changed,
    delta,
    cursor: {
      responseStarted: state.responseStarted,
      phase: state.phase,
      textEpoch: state.textEpoch,
      textLen: state.partialAssistantContent.length,
      reasoningEpoch: state.reasoningEpoch,
      reasoningLen: state.partialReasoningContent.length,
      tombEpoch: state.tombEpoch,
      callsEpoch: state.callsEpoch,
      calls: new Map(state.observedToolCalls),
      results: new Map(state.observedToolResults),
    },
  };
}
