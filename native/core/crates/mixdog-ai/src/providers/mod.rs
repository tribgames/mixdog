//! Provider families. Each submodule is owned by one provider package;
//! `connect` holds the wire pieces shared by the Connect+protobuf families
//! (`cursor`, `devin`).

pub mod action_input;
pub mod anthropic;
pub mod compat;
pub mod connect;
pub mod cursor;
pub mod devin;
pub mod first_byte;
pub(crate) mod flat_schema;
pub mod file_text;
pub mod custom;
pub mod google;
pub mod grok;
pub mod hosted;
pub(crate) mod head_wait;
pub(crate) mod idle;
#[cfg(test)]
pub(crate) mod hosted_wire_tests;
pub(crate) mod js_value;
pub mod leak;
#[cfg(test)]
mod leak_tests;
pub mod key_source;
pub mod listing_row;
pub mod local;
pub mod openai;
pub(crate) mod rejections;
mod tool_result_copies;
#[cfg(test)]
mod served_model_wire_tests;
#[cfg(test)]
mod timing_wire_tests;

/// Node's stream progress kinds (`golden/stream_progress.json`, recorded from Node's real decoders by
/// `fixtures/agent/compact/record_usage.mjs`) against the ones a Rust decoder reports for the same wire events.
#[cfg(test)]
pub(crate) mod progress_golden {




}