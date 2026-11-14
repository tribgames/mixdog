//! The session view of the terminal clients: the store facade over `mixdog-app-server-client` that the Node terminal UI's session
//! store was, and the audit that says what that UI needs from the protocol.
//!
//! - `action_route`, `action_tables`: a session action (`setTheme`, `listWorkflows`, ...) becomes one protocol request.
//! - `reducer`, `rows`, `state`: the thread fold and the projection the UI reads (`tests/fixtures/tui-state-fields.json` lists
//!   the fields it reads).
//! - `store`, `connect`: the facade a UI drives (`tests/fixtures/tui-store-calls.json` lists the members it calls).
//!
//! `tests/protocol_coverage.rs` proves the audit against the protocol; what the core does not yet serve is in
//! `tests/fixtures/core-gaps.json`.

pub mod action_route;
pub mod action_tables;
pub mod connect;
pub mod reducer;
pub mod rows;
pub mod state;
pub mod store;
