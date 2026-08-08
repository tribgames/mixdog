// Remote transcript binding: the channel worker forwards output by watching a
// per-session transcript file, so the runtime must (re)create the writer for
// the CURRENT session+cwd and push the path to the worker whenever the binding
// can go stale (relay acquire, new session, resume, clear). Extracted from
// runtime-core; every mutable local it needs is injected as an accessor.
import { createTranscriptWriter } from '../runtime/shared/transcript-writer.mjs';
import { mixdogHome } from '../runtime/shared/plugin-paths.mjs';
import { isAgentOwner } from '../runtime/agent/orchestrator/agent-owner.mjs';

const REBIND_MAX_ATTEMPTS = 3;

export function createRemoteTranscript({
  getSession,
  getCwd,
  isRemoteEnabled,
  getRemoteSessionId,
  setRemoteSessionId,
  isCloseRequested,
  channelsEnabled,
  channels,
  bootProfile,
}) {
  let writer = null;
  let writerKey = '';
  let pendingRebind = false;

  return {
    get transcriptWriter() { return writer; },
    // Session+cwd identity of the current binding: a change means forwarding
    // must be re-activated for the new transcript.
    get transcriptKey() { return writerKey; },
    get pendingRebind() { return pendingRebind; },
    resetPendingRebind() { pendingRebind = false; },
    ensureSessionTranscriptWriter,
    ensureRemoteTranscriptWriter,
    pushTranscriptRebind,
    flushPendingTranscriptRebind,
  };

  // Every user-facing main session owns a conversation JSONL, independent of
  // Remote/channel state. The always-on memory watcher tails this same file,
  // while agent-owned sessions retain semantic compaction and stay out of the
  // user's recall pool.
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

  // Bind (or refresh) outbound forwarding only for the manually selected
  // Remote owner. Session creation, close, or liveness never transfers Remote.
  function ensureRemoteTranscriptWriter() {
    const session = getSession();
    if (!isRemoteEnabled() || !session?.id) return false;
    const owner = getRemoteSessionId();
    if (!owner) {
      setRemoteSessionId(session.id);
    } else if (session.id !== owner) {
      return false;
    }
    if (!ensureSessionTranscriptWriter()) return false;
    // Session records are channel discovery hints, so local-only sessions do
    // not write them even though their memory transcript is always present.
    try { writer?.writeSessionRecord(); } catch { /* discovery hint only */ }
    return writer != null;
  }

  // Repoint outbound forwarding at the current transcript. Best-effort: a
  // writer that is not bindable yet (relay acquired before the session exists)
  // defers, and flushPendingTranscriptRebind() re-fires it exactly once.
  function pushTranscriptRebind() {
    if (!isRemoteEnabled()) return;
    if (!ensureRemoteTranscriptWriter()) { pendingRebind = true; return; }
    const transcriptPath = writer?.transcriptPath;
    if (!transcriptPath || !channelsEnabled()) { pendingRebind = true; return; }
    pendingRebind = false;
    executeTranscriptRebind(transcriptPath, 1);
  }

  // Bounded retry on the idempotent worker op; the final failure surfaces one
  // stderr line so a lost rebind is diagnosable without the env-gated profile.
  function executeTranscriptRebind(transcriptPath, attempt) {
    const onError = (error) => {
      const detail = error?.message || String(error);
      bootProfile('channels:rebind-push-failed', { attempt, error: detail });
      if (attempt < REBIND_MAX_ATTEMPTS && isRemoteEnabled() && !isCloseRequested()) {
        const timer = setTimeout(() => {
          // Drop the chain if remote went away or the writer moved on: re-firing
          // the captured path would rebind forwarding to a stale transcript.
          if (!isRemoteEnabled() || !channelsEnabled()) return;
          if (writer?.transcriptPath !== transcriptPath) return;
          executeTranscriptRebind(transcriptPath, attempt + 1);
        }, 150 * attempt);
        timer.unref?.();
      } else {
        process.stderr.write(`mixdog: channels: rebind_current_transcript failed after ${attempt} attempt(s): ${detail}\n`);
      }
    };
    try {
      void channels.execute('rebind_current_transcript', { transcriptPath }).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  // Re-fire a deferred rebind once the writer becomes available; a no-op for
  // already-bound sessions so no unconditional rebind fires per turn.
  function flushPendingTranscriptRebind() {
    if (!pendingRebind || !isRemoteEnabled()) return;
    pushTranscriptRebind();
  }
}
