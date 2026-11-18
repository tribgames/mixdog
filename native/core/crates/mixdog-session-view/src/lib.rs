//! The session view of the terminal clients: the store facade over `mixdog-app-server-client` that the terminal UI drives.
//!
//! - `action_route`, `action_tables`: a session action (`setTheme`, `listWorkflows`, ...) becomes one protocol request.
//! - `reducer`, `rows`, `state`: the thread fold and the projection the UI reads (see [`state::PROJECTED_FIELDS`]).
//! - `store`, `connect`: the facade a UI drives.

pub mod action_route;
pub mod action_tables;
pub mod connect;
pub mod reducer;
pub mod rows;
pub mod state;
pub mod store;
