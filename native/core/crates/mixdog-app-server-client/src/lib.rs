//! Rust client for the Mixdog app-server protocol (protocol.md §2.5). `api` is the frozen contract; `engine` is the reference
//! implementation the conformance suite runs; `mock` is the scripted-peer transport.

pub mod api;
pub mod engine;
pub mod mock;

pub use api::*;
pub use engine::connect;
