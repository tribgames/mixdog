//! The core: sessions, feeds, ops, approvals, config, state, notify, rooms and the domain
//! registry (SPEC §3.2). Module owners add their own `pub mod` line below.

pub mod approvals;
pub mod config;
pub mod domains;
// pub mod workflow; // WP-WORKFLOW: unverified (blocked by mixdog-services errors); re-enable at "freeze lifted"
pub mod feed;
pub mod notify;
pub mod ops;
pub mod ports;
pub mod pricing;
pub mod rooms;
pub mod session;
pub mod setup;
pub mod state;
pub mod tool_modules;
