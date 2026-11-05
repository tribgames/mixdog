//! Rust client for the Mixdog app-server protocol (protocol.md §2.5, LR §6.2).
//!
//! - `api`: the frozen client contract shared with `packages/protocol-client`.
//! - `engine`: the client behind it (`connect`): driver, per-feed folding, op reconciliation, reconnect ladder.
//! - `ws`, `inprocess`: the two transports (`Connector`s); `discovery` finds a local core; `mock`: the scripted peer the
//!   conformance suite drives.
//! - `ctl`: the management-path client (`mixdogd ctl`, the updater, the desktop main).

pub mod api;
pub mod ctl;
pub mod discovery;
pub mod engine;
pub mod inprocess;
pub mod mock;
pub mod options;
pub mod ws;

pub use api::*;
pub use engine::connect;
