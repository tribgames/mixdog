//! Connection transports of the app server (P §4, §6.5; SPEC R1, R8, R13, §4.1).
//!
//! - [`websocket`]: the loopback WebSocket listener (Bearer token, no `Origin`, text frames
//!   under `maxInboundFrameBytes`, X17 binary media frames for the host role, close codes).
//! - [`relay`]: the in-process connection type of a paired phone.
//! - [`writer`]: the byte-budgeted [`ConnectionWriter`], the implementation of
//!   `mixdog_core_api::ConnectionSink`/`Lane`: control reserve, gated lanes, round robin, lag
//!   and writer-driven recovery.
//! - [`hub`]: the connection table and the one heartbeat task.
//!
//! Every transport turns a socket into the same [`AcceptedConnection`] through
//! [`ConnectionHub`]; the reader and writer tasks are shared, so framing, bounds and close
//! behaviour have one implementation.

mod connection;
mod hub;
mod inbound;
pub mod relay;
mod socket;
pub mod stream_mailbox;
pub mod websocket;
mod writer;

pub use connection::AcceptedConnection;
pub use connection::ConnectionOrigin;
pub use connection::InboundFrames;
pub use connection::Transport;
pub use hub::ConnectionHub;
pub use hub::ConnectionLimit;
pub use hub::Pending;
pub use socket::Incoming;
pub use socket::SocketClosed;
pub use socket::SocketRead;
pub use socket::SocketWrite;
pub use writer::ConnectionWriter;
pub use writer::WriterLane;
