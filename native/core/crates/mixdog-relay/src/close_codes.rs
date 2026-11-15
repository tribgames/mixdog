//! Every WebSocket close code and reason the relay sends (`lib/relay-close-codes.mjs` and the literals in `server.mjs`,
//! `lib/relay-legs.mjs`, `lib/relay-transport.mjs`, `lib/relay-hook.mjs`). Peers act on these: the desktop leg and the browser
//! read them from their own tables.

/// A frame past the receiver's payload ceiling: the connection is closed with this code (the `ws` library's reason).
pub const MESSAGE_TOO_BIG: u16 = 1009;
pub const MESSAGE_TOO_BIG_REASON: &str = "Max payload size exceeded";

/// A newer leg of the same desktop or hook took over.
pub const SUPERSEDED: u16 = 4000;
pub const SUPERSEDED_REASON: &str = "superseded";

/// A paired phone whose PC has no live leg: at connect, and when a parked phone outlives the PC's absence. Transient for
/// the phone, never one of the pairing-revoking closes.
pub const DESKTOP_OFFLINE: u16 = 4002;
pub const DESKTOP_OFFLINE_REASON: &str = "desktop offline";

/// The pairing or the device was revoked.
pub const REVOKED: u16 = 4003;
pub const PAIRING_REVOKED_REASON: &str = "pairing revoked";
pub const DEVICE_REVOKED_REASON: &str = "device revoked";

/// The desktop refused the joining client; the reason is the desktop's own, at most 120 UTF-16 units.
pub const DESKTOP_REJECTED_CLIENT: u16 = 4004;
pub const DESKTOP_REJECTED_CLIENT_REASON: &str = "desktop rejected client";
pub const DESKTOP_REJECTED_CLIENT_REASON_MAX: usize = 120;

/// A phone without a per-browser credential: it drops the old pairing and rescans.
pub const PAIRING_RESCAN_REQUIRED: u16 = 4005;
pub const PAIRING_RESCAN_REQUIRED_REASON: &str = "pairing rescan required";

/// A consumer that cannot drain what is sent to it, or a producer that stalls mid-frame.
pub const SLOW_PEER: u16 = 4008;
pub const SLOW_CONSUMER_REASON: &str = "slow consumer";
pub const SLOW_PRODUCER_REASON: &str = "slow producer";

/// The relay's memory ceilings are full.
pub const RELAY_BUSY: u16 = 4009;
pub const RELAY_BUSY_REASON: &str = "relay busy";

/// The desktop leg left a joining phone's handshake unanswered and failed a liveness probe: the shared leg itself is dead.
pub const DESKTOP_HANDSHAKE_STALLED: u16 = 4010;
pub const DESKTOP_HANDSHAKE_STALLED_REASON: &str = "desktop leg unresponsive";
