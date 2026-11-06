//! The core: sessions, feeds, ops, approvals, config, state, notify, rooms and the domain
//! registry (SPEC §3.2). Module owners add their own `pub mod` line below.

pub mod agents;
pub mod approvals;
mod attachments;
pub mod config;
pub mod domains;
pub mod workflow;
pub mod feed;
pub mod goal;
pub mod notify;
pub mod ops;
pub mod ports;
pub mod pricing;
pub mod prompt;
pub mod quota_resume;
pub mod quota_settlement;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod quota_resume_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod quota_settlement_tests;
pub mod rooms;
pub mod run_host;
pub mod session;
pub mod setup;
pub mod state;
pub mod tool_modules;
pub mod turn_review;
