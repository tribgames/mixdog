// session-activity-signal.mjs
// Process-local "a session's activity state may have changed" pulse: a turn
// started or settled, a task wait began or ended, a background task was
// handed off or finished. Status surfaces that project activity from the
// runtime map (the Agents pool) listen and re-read at once instead of waiting
// for their next store event. Import-free leaf.
const listeners = new Set();

export function onSessionActivityChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSessionActivityChange(sessionId = '') {
  emit(listeners, sessionId);
}

// A turn started on a session: the one point every turn passes through, whoever
// started it. Unlike the activity pulse it never fires on a settle or a wait.
const turnStartListeners = new Set();

export function onSessionTurnStart(listener) {
  if (typeof listener !== 'function') return () => {};
  turnStartListeners.add(listener);
  return () => turnStartListeners.delete(listener);
}

export function emitSessionTurnStart(sessionId = '') {
  emit(turnStartListeners, sessionId);
}

// A live session started or stopped showing an approval card waiting on the
// user (its runtime state's `toolApproval`): the session catalog, which
// stamps that on each row, listens and re-reads.
const approvalCardListeners = new Set();

export function onSessionApprovalCardChange(listener) {
  if (typeof listener !== 'function') return () => {};
  approvalCardListeners.add(listener);
  return () => approvalCardListeners.delete(listener);
}

export function emitSessionApprovalCardChange(sessionId = '') {
  emit(approvalCardListeners, sessionId);
}

// The bots whose sends are in flight in a session changed (bot-owned-work.mjs):
// the session catalog stamps them on each row (`handedBy`) and re-reads.
const botWorkListeners = new Set();

export function onSessionBotWorkChange(listener) {
  if (typeof listener !== 'function') return () => {};
  botWorkListeners.add(listener);
  return () => botWorkListeners.delete(listener);
}

export function emitSessionBotWorkChange(sessionId = '') {
  emit(botWorkListeners, sessionId);
}

function emit(targets, sessionId) {
  for (const listener of [...targets]) {
    try {
      listener(String(sessionId || ''));
    } catch {
      /* a listener's failure never affects the transition */
    }
  }
}
