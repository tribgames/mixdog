//! The step-level effort judge: a local ONNX classifier that rates the
//! decision an agent faces after a tool batch, and the ladder that turns the
//! rating into an effort. Runs on the same ONNX Runtime as the embeddings.

pub mod error;
pub mod host;
pub mod input;
pub mod install;
pub mod judge;
pub mod ladder;
pub mod model;
pub mod tokenizer;
mod worker;

pub use input::TurnInput;
pub use judge::{EffortJudge, EffortJudgeModel, JudgeLanes, JudgeTiming, TurnVerdict};
pub use ladder::{AutoLadder, CustomLadder, StepLadder};
pub use model::ModelConfig;

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod worker_tests;
#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup")]
mod host_tests;
