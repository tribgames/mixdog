//! Provider layer of the Rust core: provider-neutral machinery that every
//! provider family builds on (PW §2–§4, §6; SPEC §4.9).
//!
//! - [`transport`]: connection setup with the one keepalive schedule (TCP,
//!   HTTP/2 PING, WebSocket PING) and the mapping of socket failures to
//!   [`mixdog_core_api::domain::provider::TransportFault`]. A connection is
//!   dead only on transport facts; no content timer exists anywhere here.
//! - [`retry`]: the production [`mixdog_core_api::domain::retry::RetryDecider`]
//!   and the shared error-classification and Retry-After rules.
//! - [`admission`]: per-lane, priority- and owner-fair request admission.
//! - [`catalog`]: the model catalog, always built from the full provider
//!   configuration.
//! - [`oauth`]: PKCE, loopback login, credential files, refresh outcomes.
//! - [`broker`]: the single send loop above the adapters, and the server side
//!   of the model proxy.

pub mod accounts;
pub mod admission;
pub mod broker;
pub mod catalog;
pub mod client_versions;
pub mod effort;
pub mod netproxy;
pub mod oauth;
pub mod providers;
pub mod registry;
pub mod retry;
pub mod service;
pub mod transport;
pub mod warmer;
#[cfg(feature = "count-work")]
pub mod work;

/// The process-wide state a provider send leaves behind, put back as a new process has it: the Anthropic gzip and
/// OpenAI zstd latches, the Anthropic message threads and fast mode, the logged tool exclusions, the warmed origins,
/// the Gemini cache registry and its announced redirects, the lane settings read from the environment, the running
/// credential refreshes. A test that replays a recording Node made in a fresh process starts here.
/// `tests/it/process_state.rs` holds every process-wide value of the crate to this list or a reason.
#[cfg(any(test, feature = "test-support"))]
pub fn reset_process_state() {
    admission::settings::reset_process_lane_settings();
    oauth::single_flight::reset();
    providers::anthropic::reset_process_state();
    providers::compat::schema::reset_warned();
    providers::grok::reset_process_state();
    providers::openai::adapter::reset_zstd_latch();
    providers::google::adapter::reset_announced();
    providers::google::cache::registry::Registry::reset_shared();
    transport::preconnect::reset();
}