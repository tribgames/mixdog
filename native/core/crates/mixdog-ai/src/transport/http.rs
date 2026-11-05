//! The shared HTTP client configuration.

//!
//! The one HTTP seam of every provider package is re-exported here: send a
//! `WireRequest`, get a status, headers and a streaming body ([`HttpSend`],
//! [`HttpResponse`], [`BodyStream`]); [`BidiOpen`] for request-streaming
//! exchanges; [`ReqwestLink`] is the implementation.

use mixdog_core_api::domain::keepalive::KeepaliveSchedule;

pub use super::link::BidiOpen;
pub use super::link::BodyStream;
pub use super::link::FrameSink;
pub use super::link::HttpResponse;
pub use super::link::HttpSend;
pub use super::link::ReqwestLink;

/// A `reqwest` client builder with the keepalive schedule on every
/// connection: `SO_KEEPALIVE` on the socket and HTTP/2 PING (also while
/// idle). It sets no request, read or total timeout: a response ends by the
/// facts of SPEC §4.9 only. Callers add their TLS, proxy and header settings.
pub fn client_builder(schedule: &KeepaliveSchedule) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .tcp_keepalive(schedule.tcp.idle)
        .tcp_keepalive_interval(schedule.tcp.interval)
        .tcp_keepalive_retries(schedule.tcp.count)
        .http2_keep_alive_interval(schedule.h2.interval)
        .http2_keep_alive_timeout(schedule.h2.timeout)
        .http2_keep_alive_while_idle(schedule.h2.while_idle)
}