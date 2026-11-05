//! Conversation compaction: the token meter, the rule-only rebuild, the
//! summary and the execution-tail archive, behind the loop's [`Compactor`](crate::env::Compactor).
//!
//! The text a model reads is assembled here exactly as the Node pipeline did;
//! `fixtures/agent/compact` holds Node's recorded outputs this module is
//! tested against.

pub mod compactor;
pub mod conversation;
pub mod dropped;
pub mod estimate;
pub mod execution_tail;
pub mod fresh;
pub mod ingest;
pub mod messages;
pub mod observation;
pub mod redact;
pub mod summary;
pub mod summary_run;
pub mod summary_schema;
pub mod text_utils;
pub mod triggers;
