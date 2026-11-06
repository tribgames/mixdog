//! The Mixdog app server (P §2.2): the message processor between the transport and the
//! core. It sees the core only through `mixdog-core-api` and the wire only through
//! `mixdog-app-protocol`.
//!
//! - [`AppServer`] / [`ConnectionHandle`]: one handle per accepted connection; the transport
//!   passes every inbound message to it. Initialize latch and version gate, origin rules,
//!   request classes and admission, keyed serialization, dispatch, subscriptions.
//! - [`Outgoing`]: the connection table, server-request fan-out and re-delivery, and the host
//!   channel. Built first, given to the core as its `ServerRequestSink` and `HostChannel`.
//! - [`error_data`] / [`error_frame`]: the single mapping of `CoreError` to the wire.

mod config;
mod connection;
mod error;
mod frame;
mod media;
mod outgoing;
mod serialization;
mod server;
mod sharded;

#[cfg(test)]
mod tests;

pub use config::ServerConfig;
pub use config::VersionGate;
pub use config::VersionOrder;
pub use error::error_data;
pub use error::precondition_values;
pub use frame::error_frame;
pub use frame::error_notification_frame;
pub use frame::response_frame;
pub use media::HostMedia;
pub use media::StreamTarget;
pub use outgoing::Outgoing;
pub use server::AppServer;
pub use server::ConnectionHandle;
pub use server::Inbound;
pub use server::OriginOf;
