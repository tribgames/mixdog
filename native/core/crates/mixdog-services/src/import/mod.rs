//! Conversation import: discovery of Codex / Claude Code / Claude Desktop (Cowork)
//! conversations on disk, conversion to plain-text turns, and background import jobs.

#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]

pub mod candidate;
pub mod claude;
pub mod codex;
pub mod convert;
pub mod discovery;
pub mod fsutil;
pub mod history;
pub mod jobs;
pub mod service;
pub mod titles;
pub mod turns;

pub use candidate::{Candidate, Env};
pub use convert::{Conversion, Limits, Source};
pub use discovery::{Discovery, Imported};
pub use jobs::{ImportJobs, ImportOrigin, ImportSessions, ImportedSession};
pub use service::ImportService;
