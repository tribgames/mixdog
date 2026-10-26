/**
 * Starting a browser takeover fixes the page it hands over
 * (browser/user-takes-page.ts). A named tab that cannot be resolved makes that
 * throw, and the session-state listener that starts the takeover runs inside
 * the publication's error isolation, which drops what a listener throws
 * (session-host-publication.ts emitIsolated). So the failure is settled here:
 * the pending takeover approval is declined with the error as its reason, so
 * the agent is told and the card does not stay pending, and the failure is
 * reported.
 */

interface TakeoverCaptureDeps {
  /** Fixes the handed-over page; throws when the named tab cannot be handed over. */
  capture(sessionId: string, id: string, tab: string): void;
  /** Settles the pending takeover approval as not approved, with `reason`. */
  decline(sessionId: string, id: string, reason: string): Promise<unknown>;
  report(event: string, details: Record<string, unknown>): void;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** True when the handed-over page is fixed; false when the takeover was declined instead. */
export function captureTakeoverOrDecline(
  deps: TakeoverCaptureDeps,
  sessionId: string,
  id: string,
  tab: string
): boolean {
  try {
    deps.capture(sessionId, id, tab);
    return true;
  } catch (error) {
    const reason = messageOf(error);
    deps.report('takeover-capture-failed', { sessionId, id, tab, message: reason });
    deps.decline(sessionId, id, reason).catch((declineError: unknown) => {
      deps.report('takeover-decline-failed', { sessionId, id, message: messageOf(declineError) });
    });
    return false;
  }
}
