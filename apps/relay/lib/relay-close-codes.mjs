// WebSocket close codes the relay sends that its peers act on. One table for
// the relay, the desktop leg (main/remote-relay.ts) and the browser
// (renderer/remote-connection-state.ts).

/** A paired phone whose PC has no live leg: at connect, and when a parked
 *  phone outlives the PC's absence. Transient for the phone — never one of the
 *  pairing-revoking closes. */
export const DESKTOP_OFFLINE_CLOSE = 4002;
/** The desktop leg left a joining phone's handshake unanswered AND failed a
 *  liveness probe: the shared leg itself is dead, not one slow handshake. */
export const DESKTOP_HANDSHAKE_STALLED_CLOSE = 4010;
