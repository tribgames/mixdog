//! Provider connections and the one keepalive configuration (SPEC §4.9).
//!
//! Every provider TCP connection is created with `SO_KEEPALIVE` already set
//! ([`tcp`]); HTTP/2 PING is configured on the shared HTTP client
//! ([`http::client_builder`]); WebSocket PING is driven by the connection's own
//! task ([`ws`]). A half-open peer therefore ends as a socket error or a
//! [`TransportFault::KeepaliveExpired`](mixdog_core_api::domain::provider::TransportFault)
//! within the schedule. Nothing in this module measures time between content
//! frames: any inbound frame proves the link alive, and a missing one only
//! triggers a probe.

pub mod deadlines;
pub mod fault;
pub mod http;
pub mod link;
pub mod tcp;
pub mod ws;

/// The loopback TLS server and the recording manifest the wire parity checks of every provider share (the Rust half of
/// `benchmarks/terminal-bench-2.1/analysis/parity/wire-server.mjs`).
#[cfg(any(test, feature = "test-support"))]
pub mod loopback;
#[cfg(any(test, feature = "test-support"))]
pub mod manifest;

#[cfg(test)]
pub(crate) mod site_probe;

pub use link::BidiOpen;
pub use link::ABORTED;
pub use link::CONNECTION_ERROR;
pub use link::FETCH_FAILED;
pub use link::REQUEST_TIMED_OUT;
pub use link::SIGNAL_TIMED_OUT;
pub use link::BodyStream;
pub use link::Exchange;
pub use link::FrameSink;
pub use link::HttpResponse;
pub use link::HttpSend;
pub use link::KeepaliveDialer;
pub use link::Redirect;
pub use link::ReqwestLink;
pub use link::Surface;
pub use link::WsDial;
pub use link::WsSocket;

pub use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
pub use mixdog_core_api::domain::keepalive::TransportKind;