// manager/session-errors.mjs
// Extracted verbatim from manager.mjs. Re-exported through the facade so
// loop.mjs and other importers resolve SessionClosedError unchanged.

/**
 * Thrown when a session is closed while a call is in-flight. Callers (agent
 * handler, CLI) should render this as "cancelled" rather than a hard error.
 */
export class SessionClosedError extends Error {
    constructor(sessionId, reason, closeReason) {
        super(reason ? `Session "${sessionId}" closed: ${reason}` : `Session "${sessionId}" closed`);
        this.name = 'SessionClosedError';
        this.sessionId = sessionId;
        this.cancelled = true;
        // closeReason is the diagnostic enum (request-abort / manual /
        // idle-sweep / runner-crash). Kept separate from `reason` (the free
        // -form message) so consumers can branch on it without regex parsing.
        this.reason = closeReason || null;
    }
}
