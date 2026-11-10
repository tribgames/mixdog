// Bounded dedup state for execution notifications: which transcript cards were
// displayed (per card key), whether an execution's visible response is still a
// bodyless preview or has reached its body, and which keys belong to finished
// executions so they are evicted first.

// Terminal keys are evicted FIRST (a finished execution can no longer emit),
// but the bound is absolute: with only nonterminal keys left the oldest one
// goes, otherwise the map grew for the whole session.
function pickEviction(keys, terminalKeys) {
  const list = [...keys];
  return list.find((candidate) => terminalKeys.has(candidate)) ?? list[0];
}

export function createExecutionDedup({ displayedNotificationKeys, limit = 256 }) {
  // Tracks whether an execution's visible response is only a bodyless preview
  // or has reached its final body. A preview must not permanently suppress the
  // later body, while repeated body retries remain idempotent.
  const responseStates = new Map();
  const terminalNotificationKeys = new Set();
  const terminalResponseKeys = new Set();
  const notificationExecutionIds = new Map();

  function clear() {
    displayedNotificationKeys.clear();
    responseStates.clear();
    terminalNotificationKeys.clear();
    terminalResponseKeys.clear();
    notificationExecutionIds.clear();
  }

  function rememberNotificationKey(key, terminal = false, executionId = '') {
    if (!key) return;
    displayedNotificationKeys.delete(key);
    if (executionId) notificationExecutionIds.set(key, executionId);
    if (terminal) terminalNotificationKeys.add(key);
    else terminalNotificationKeys.delete(key);
    while (displayedNotificationKeys.size >= limit) {
      const evicted = pickEviction(displayedNotificationKeys, terminalNotificationKeys);
      if (evicted == null) break;
      displayedNotificationKeys.delete(evicted);
      terminalNotificationKeys.delete(evicted);
      notificationExecutionIds.delete(evicted);
    }
    displayedNotificationKeys.add(key);
  }

  function rememberResponseState(key, value, terminal = false) {
    if (!key) return;
    responseStates.delete(key);
    if (terminal) terminalResponseKeys.add(key);
    else terminalResponseKeys.delete(key);
    while (responseStates.size >= limit) {
      const evicted = pickEviction(responseStates.keys(), terminalResponseKeys);
      if (evicted == null) break;
      responseStates.delete(evicted);
      terminalResponseKeys.delete(evicted);
    }
    responseStates.set(key, value);
  }

  // A terminal status marks every key the execution displayed as evictable-first.
  function promote(executionId) {
    if (!executionId) return;
    for (const [key, keyExecutionId] of notificationExecutionIds) {
      if (keyExecutionId !== executionId || !displayedNotificationKeys.has(key)) continue;
      terminalNotificationKeys.add(key);
    }
    const responseState = responseStates.get(executionId);
    if (responseState) rememberResponseState(executionId, responseState, true);
  }

  return {
    clear,
    rememberNotificationKey,
    rememberResponseState,
    promote,
    hasNotificationKey: (key) => displayedNotificationKeys.has(key),
    responseState: (executionId) => (executionId ? responseStates.get(executionId) : ''),
  };
}
