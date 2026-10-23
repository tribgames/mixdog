// Committed-but-unsealed text segments of one user turn.
//
// Max-output recovery parts plus text-only continuation
// segments (provider pause_turn / terminal steering / stop hook). The terminal
// response returns content = parts + terminal so the UI row that accumulated
// every streamed segment is not overwritten down to only the last segment;
// historyContent keeps persistence single-copy.
import { buildIntermediateAssistantMessage, commitAssistantMessage } from '../assistant-commit.mjs';

export function createTurnSegments({ messages, opts }) {
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
    // live for every session.
    // `committed: true` marks text that is the just-committed message's own.
    // A committed message is whole, so the text after it is another message
    // and a break keeps the aggregate from running the two together; a part
    // that was cut off (max-output recovery) resumes right where it stopped.
    record(text, { committed = false } = {}) {
      parts.push(committed ? `${text.trimEnd()}\n\n` : text);
      try {
        opts.onAssistantText?.(text, { committed });
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
