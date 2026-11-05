//! The step-level effort judge: a local ONNX classifier that rates the
//! decision an agent faces after a tool batch, and the ladder that turns the
//! rating into an effort. Runs on the same ONNX Runtime as the embeddings.

pub mod error;
pub mod input;
pub mod install;
pub mod judge;
pub mod ladder;
pub mod model;
pub mod tokenizer;

pub use judge::{EffortJudge, EffortJudgeModel};
pub use ladder::{AutoLadder, CustomLadder, StepLadder};
pub use model::ModelConfig;

#[cfg(test)]
mod tests;
