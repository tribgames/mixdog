// Push foreground eligibility for relay/direct phone legs (docs/remote-transport.md
// §9, stage 1E). A leg counts as foreground for push suppression only while it
// has authenticated liveness within REMOTE_TRANSPORT_FOREGROUND_STALE_MS: a
// phone that froze or lost its network keeps its registered leg for a long
// time, and trusting its last `setForeground(true)` would suppress pushes to a
// phone nobody is looking at. Pure functions over a structural leg shape, with
// the clock passed in (monotonic by default), so the caller keeps its own leg
// registry and tests drive time by hand.
import { REMOTE_TRANSPORT_FOREGROUND_STALE_MS } from '../../shared/remote-transport';

/** The fields of a phone leg this decision reads (RelayClientState has the
 *  first two; `liveAt` is the one 1A adds). */
export interface ForegroundLeg {
  /** The phone reported itself hidden (`setForeground(false)`). */
  background: boolean;
  /** The sessions the leg reports painting (`setScreenSessions`). */
  screenSessionIds?: ReadonlySet<string>;
  /** Clock reading (`now()` below) of the last authenticated liveness; unset
   *  until the first one, which makes the leg not foreground. */
  liveAt?: number;
}

/** Milliseconds on a monotonic clock; the default for every `now` here. */
export const foregroundNow = (): number => performance.now();

/** Record authenticated liveness on `leg`. Call it ONLY after the carrier
 *  authenticated what it received: an E2EE box that opened (an application
 *  record, an ack, a ping or pong), never for a raw socket event, a relay
 *  `{"pong"}` or unopened bytes. A `visible` report is itself such a box. */
export function noteLegLive(leg: Pick<ForegroundLeg, 'liveAt'>, now: number = foregroundNow()): void {
  leg.liveAt = now;
}

/** Whether the leg showed authenticated liveness within the stale window
 *  (35 000 ms is stale; 34 999 ms is not). Registration is irrelevant. */
export function legIsLive(leg: Pick<ForegroundLeg, 'liveAt'>, now: number = foregroundNow()): boolean {
  return leg.liveAt !== undefined && now - leg.liveAt < REMOTE_TRANSPORT_FOREGROUND_STALE_MS;
}

/** Whether this leg shows `sessionId` for push suppression: live, not
 *  reported hidden (which removes eligibility at once), and reporting that
 *  session on screen. */
export function legShowsSession(leg: ForegroundLeg, sessionId: string, now: number = foregroundNow()): boolean {
  return !leg.background && leg.screenSessionIds?.has(sessionId) === true && legIsLive(leg, now);
}

/** Whether any leg accepted by `match` (default: all) shows `sessionId`. */
export function someLegShowsSession<T extends ForegroundLeg>(
  legs: Iterable<T>,
  sessionId: string,
  match: (leg: T) => boolean = () => true,
  now: number = foregroundNow()
): boolean {
  for (const leg of legs) {
    if (match(leg) && legShowsSession(leg, sessionId, now)) return true;
  }
  return false;
}
