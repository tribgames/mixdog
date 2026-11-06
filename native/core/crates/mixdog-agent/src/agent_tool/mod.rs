//! The `agent` tool's orchestration (Node `session-runtime/services/agent-tool/`): request
//! dispatch, explicit-tag spawn and dead-tag send resolution, resume of reaped tags, close
//! and cleanup. [`AgentRuntime`] implements the tools crate's `AgentPort`; everything it
//! reads or changes outside those decisions is a trait in [`host`].

pub mod board;
pub mod dispatch;
pub mod error_text;
pub mod flow;
pub mod host;
pub mod model_select;
pub mod progress;
pub mod resume;
pub mod scope;
pub mod stamp;
pub mod views;
pub mod watchdog;

pub use dispatch::AgentDeps;
pub use dispatch::AgentRuntime;
