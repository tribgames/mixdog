/**
 * writer-idle-release.mjs — the daemon lets go of the writer lock of a session
 * it has left idle and unwatched, so another Mixdog process (a `--plain` REPL
 * on the same data dir) may open it.
 *
 * A deadline on the session idle clock (./idle-clock.mjs): a session is let go
 * once it has been neither working nor watched for the whole delay, measured
 * from the later of the two; a change of the lock starts it over too. Only
 * the lock goes (store.mjs
 * releaseIdleSessionWriter): the runtime of an idle unwatched session is
 * already reclaimed by retention.mjs, whose detach releases the lock itself,
 * so what is left here holds the lock with no runtime to unload. A release the
 * store refuses (a write still outstanding, a save dropped or failed) keeps
 * the lock until the next of those events starts the clock again.
 */
import { releaseIdleSessionWriter } from '../../runtime/agent/orchestrator/session/store.mjs';
import {
  heldSessionWriterIds,
  onSessionWriterHeldChange,
  sessionWriterHeldHere,
} from '../../runtime/agent/orchestrator/session/store/session-writer-claim.mjs';

export const SESSION_WRITER_IDLE_RELEASE_MS = 30 * 60_000;

/** MIXDOG_SESSION_WRITER_IDLE_RELEASE_MS may only shorten the delay (tests). */
export function sessionWriterIdleReleaseMs(env = process.env) {
  const configured = Number(env.MIXDOG_SESSION_WRITER_IDLE_RELEASE_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(SESSION_WRITER_IDLE_RELEASE_MS, Math.max(50, Math.round(configured)))
    : SESSION_WRITER_IDLE_RELEASE_MS;
}

/** @param {{ idleClock: ReturnType<import('./idle-clock.mjs').createSessionIdleClock>, log?: Function }} deps */
export function createWriterIdleRelease({ idleClock, log = () => {} }) {
  // Sessions whose writer lock this process holds, those claimed before the
  // service existed included.
  const held = new Set(heldSessionWriterIds());

  async function release(id) {
    if (!sessionWriterHeldHere(id)) return;
    const released = await releaseIdleSessionWriter(id);
    log(
      released
        ? `session ${id} idle and unwatched — writer lock released`
        : `session ${id} idle and unwatched — writer lock kept (a write of it is outstanding or failed)`
    );
  }

  const deadline = idleClock.addDeadline({
    delayMs: sessionWriterIdleReleaseMs(),
    tracks: (id) => held.has(id),
    due: (id) => void release(id),
  });

  const unsubscribe = onSessionWriterHeldChange((id, isHeld) => {
    if (isHeld) held.add(id);
    else held.delete(id);
    idleClock.refresh(id);
  });
  for (const id of held) idleClock.refresh(id);

  function stop() {
    unsubscribe();
    held.clear();
  }

  return { stop, armed: (id) => idleClock.armed(id, deadline) };
}
