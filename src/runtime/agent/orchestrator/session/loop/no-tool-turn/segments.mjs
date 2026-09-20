// Committed-but-unsealed text segments of one user turn.
//
// Max-output recovery parts plus (Lead/TUI only) text-only continuation
// segments (provider pause_turn / terminal steering / stop hook). The terminal
// response returns content = parts + terminal so the UI row that accumulated
// every streamed segment is not overwritten down to only the last segment;
// historyContent keeps persistence single-copy.
import { buildIntermediateAssistantMessage, commitAssistantMessage } from '../assistant-commit.mjs';

export function createTurnSegments({ messages, opts, suppressMidTurnText }) {
  const parts = [];
  return {
    parts,
    commitIntermediate(response) {
      const message = buildIntermediateAssistantMessage(response, opts);
      if (!message) return false;
      commitAssistantMessage(messages, message, opts);
      return true;
    },
    // Record a mid-turn segment for the caller-facing aggregate and surface it
    // live. A suppressed sub-agent session neither surfaces nor accumulates
    // text — except on the max-output ladder, whose parts must still rebuild
    // the complete answer the caller receives (keepWhenSuppressed).
    record(text, { keepWhenSuppressed = false } = {}) {
      if (suppressMidTurnText) {
        if (keepWhenSuppressed) parts.push(text);
        return;
      }
      parts.push(text);
      try {
        opts.onAssistantText?.(text);
      } catch {
        /* best-effort */
      }
    },
    // The UI sealed its streaming row at a tool boundary; earlier committed
    // parts must not re-prepend at terminal (duplicate rows).
    clear() {
      parts.length = 0;
    },
  };
}
