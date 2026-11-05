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
pub mod oauth;
pub mod providers;
pub mod registry;
pub mod retry;
pub mod service;
pub mod transport;