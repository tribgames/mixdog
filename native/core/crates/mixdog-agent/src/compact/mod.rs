//! Conversation compaction: the token meter, the rule-only rebuild, the
//! summary and the execution-tail archive, behind the loop's [`Compactor`](crate::env::Compactor).
//!
//! The text a model reads is assembled here from the transcript alone: the
//! summary prompts, the handoff message and the recovery note are built by the
//! rules these modules state.

pub mod blob_reads;
pub mod compactor;
pub mod conversation;
pub mod dropped;
pub mod estimate;
pub mod execution_tail;
pub mod fresh;
pub mod image;
pub mod ingest;
pub mod messages;
pub mod observation;
pub mod pressure;
pub mod redact;
pub mod settings;
pub mod settings_service;
pub mod skills;
pub mod summary;
pub mod summary_run;
pub mod summary_schema;
pub mod text_utils;
pub mod tool_schema;
pub mod triggers;

#[cfg(node_twin)]
#[cfg(test)]
mod node_cases_tests;
