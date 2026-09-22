// manager/ask-turn-steering-drain.mjs
// The steering drain one ask turn hands to agentLoop: the host's own queued
// prompts at every continuation boundary, plus — at the TERMINAL boundary only
// — the manager's pending-message entries, grouped into one steering item per
// mode and adopted by this turn (so their delivery/ack/release rides it).
import { _groupPendingMessageEntries, drainPendingMessages, releasePendingMessages } from './pending-messages.mjs';

/**
 * @param {object} input
 * @param {string} input.sessionId
 * @param {object} input.turn  the ask turn state (pendingEntries)
 * @param {object} input.askOpts
 */
export function createAskSteeringDrain({ sessionId, turn, askOpts }) {
  // Mid-chain queued prompt/notification drain is owned by agentLoop at
  // provider-continuation boundaries (after a tool batch, before the next
  // send). The post-loop tail drain in askSession still handles items that
  // arrive after the model would otherwise stop.
  return (sid, drainOptions = {}) => {
    const out = [];
    if (typeof askOpts?.drainSteering === 'function') {
      try {
        const drained = askOpts.drainSteering(sid || sessionId, drainOptions);
        if (Array.isArray(drained)) out.push(...drained);
      } catch {
        /* best-effort steering drain */
      }
    }
    // Manager/pending-messages entries carry no mode/priority/slash
    // metadata, so they stay OUT of the mid-chain (post-tool-batch) drain —
    // that would bypass the queued-command filters. At the TERMINAL boundary
    // they are exactly pending input: an `agent type=send` queued while the
    // terminal sample was in flight must be folded into THIS turn before any
    // stop hook runs, instead of losing its slot to a synthetic continuation
    // prompt. The mutex is held for the whole ask, so this drain races
    // nothing. Entries consumed here join the turn's pending entries: their
    // delivery/ack (and release on failure) rides this turn, and the
    // post-loop drain can no longer see them.
    if (drainOptions?.stage === 'terminal') {
      const pendingNow = drainPendingMessages(sessionId);
      if (pendingNow.length > 0) {
        // One steering entry per mode group: the merged prompt (if any) and
        // each task notification on its own, so the loop stores them apart.
        const groupsNow = _groupPendingMessageEntries(pendingNow);
        if (groupsNow.length > 0) {
          turn.pendingEntries.push(...pendingNow);
          for (const group of groupsNow) {
            out.push({
              content: group.content,
              text: group.text,
              ids: group.ids,
              mode: group.mode,
              ...(group.execution ? { execution: group.execution } : {}),
            });
          }
        } else {
          releasePendingMessages(sessionId, pendingNow);
        }
      }
    }
    return out;
  };
}
