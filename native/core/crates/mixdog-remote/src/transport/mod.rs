//! The MXT message transport (DS §7, `shared/remote-transport.ts`): the carrier-agnostic stream
//! core that carries a paired session's live traffic over an always-on WebRTC data channel with
//! the relay as fallback carrier.
//!
//! Nothing here trusts a carrier. Record framing is unauthenticated and only decides what reaches
//! E2EE decryption; a record counts as accepted (and is acked) only after its box opened. Acks
//! and pings are control-domain boxes, so a relay can neither forge an ack nor replay one into
//! another session or direction. Everything is sans-IO: time is passed in, and the caller moves
//! bytes. The wire bytes are identical to the Node product's (`tests/transport_vectors.rs`).

pub mod consts;
pub mod control;
pub mod frame;
pub mod path;
pub mod receiver;
pub mod sender;
pub mod split;

/// A violation of the transport contract (`remote transport: invalid <what>.`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("remote transport: {0}")]
pub struct TransportError(String);

impl TransportError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    pub fn invalid(what: &str) -> Self {
        Self(format!("invalid {what}."))
    }
}
