//! The agent run loop: send → tool calls → execute → send again, with
//! steering injected at model-call boundaries, bounded recovery ladders,
//! compaction at the request boundary, sub-agent orchestration and approval
//! waits. Every wait is cancel-safe and the loop arms no timer; retries go
//! through the one [`RetryDecider`](mixdog_core_api::domain::retry::RetryDecider).
//!
//! The host (session actor) supplies everything outside the loop through the
//! traits in [`env`]; providers and tools come in as the domain traits of
//! `mixdog-core-api`.

pub mod agent_tool;
pub mod attachments;
mod barriers;
mod batch;
pub mod boundary;
mod cache_observation;
pub mod cache_scope;
pub mod cancel;
pub mod coerce;
pub mod compact;
pub mod effort;
pub mod env;
pub mod explorer;
pub mod fork;
pub mod interrupt;
pub mod limits;
pub mod message;
pub mod message_row;
pub mod native_search;
mod no_tool;
pub mod offload;
pub mod one_shot;
pub mod prefix_guard;
pub mod project;
pub mod recovery;
pub mod repair;
pub mod response;
pub mod result_kind;
pub mod run;
mod send;
pub mod skill_update;
mod stored_args;
#[cfg(feature = "test-support")]
pub mod test_hooks;
pub use send::assemble_request;
pub use send::kept_messages;
pub use send::wire_request;
pub use send::with_tail_reminder;
pub use send::without_tail_reminder;
pub mod steer;
pub mod step_effort;
pub mod subagent;
pub mod tail_rules;
pub mod text;
pub mod text_only;
pub mod todo;
pub mod tools;
pub mod web_route;

pub use run::AgentError;
pub use run::CompactFailure;
pub use run::ContextOverflow;
pub use run::Run;
pub use run::RunCarry;
pub use run::RunConfig;
pub use run::RunFailure;
pub use run::RunOutput;
