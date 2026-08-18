// Session transcript writer: every user-facing main session owns a
// conversation JSONL that the always-on memory watcher tails. Extracted from
// runtime-core; the mutable locals it needs are injected as accessors.
// (The channel-relay rebind/forwarding half of this module was deleted with
// Discord/Telegram messaging.)
import { createTranscriptWriter } from '../runtime/shared/transcript-writer.mjs';
import { mixdogHome } from '../runtime/shared/plugin-paths.mjs';
import { isAgentOwner } from '../runtime/agent/orchestrator/agent-owner.mjs';

export function createSessionTranscript({
  getSession,
  getCwd,
}) {
  let writer = null;
  let writerKey = '';

  return {
    get transcriptWriter() { return writer; },
    // Session+cwd identity of the current writer binding.
    get transcriptKey() { return writerKey; },
    ensureSessionTranscriptWriter,
  };

  // Every user-facing main session owns a conversation JSONL. The always-on
  // memory watcher tails this same file, while agent-owned sessions retain
  // semantic compaction and stay out of the user's recall pool.
  function ensureSessionTranscriptWriter() {
    const session = getSession();
    if (!session?.id || isAgentOwner(session)) return false;
    const cwd = getCwd();
    const key = `${session.id}\u0000${cwd}`;
    if (writerKey !== key) {
      try {
        writer = createTranscriptWriter({
          mixdogHome: mixdogHome(),
          sessionId: session.id,
          cwd,
          pid: process.pid,
        });
        writerKey = key;
      } catch (error) {
        process.stderr.write(`mixdog: transcript-writer: init failed: ${error?.message || error}\n`);
        writer = null;
        writerKey = '';
        return false;
      }
    }
    try { writer?.ensureConversationBackfill(session.messages); } catch { /* best-effort */ }
    try { writer?.ensureTranscriptFile(); } catch (error) {
      process.stderr.write(`mixdog: transcript-writer: ensureTranscriptFile failed: ${error?.message || error}\n`);
    }
    return writer != null;
  }
}
