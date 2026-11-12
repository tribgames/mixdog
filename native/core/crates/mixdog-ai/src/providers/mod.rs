//! Provider families. Each submodule is owned by one provider package;
//! `connect` holds the wire pieces shared by the Connect+protobuf families
//! (`cursor`, `devin`).

pub mod action_input;
#[cfg(test)]
mod action_input_tests;
pub mod anthropic;
pub mod compat;
pub mod connect;
pub mod cursor;
pub mod devin;
pub(crate) mod flat_schema;
pub mod file_text;
pub mod custom;
pub mod google;
pub mod grok;
pub mod hosted;
#[cfg(test)]
pub(crate) mod hosted_wire_tests;
pub(crate) mod js_value;
pub mod leak;
#[cfg(test)]
pub(crate) mod leak_golden;
#[cfg(test)]
mod leak_tests;
pub mod key_source;
pub mod listing_row;
pub mod local;
pub mod openai;
#[cfg(test)]
mod served_model_wire_tests;
#[cfg(test)]
mod timing_wire_tests;
#[cfg(test)]
pub(crate) mod wire_fixtures;

/// Node's stream progress kinds (`golden/stream_progress.json`, recorded from Node's real decoders by
/// `fixtures/agent/compact/record_usage.mjs`) against the ones a Rust decoder reports for the same wire events.
#[cfg(test)]
pub(crate) mod progress_golden {
    use mixdog_core_api::domain::provider::StreamEvent;

    /// The progress kinds a decoder reported, consecutive repeats folded (Node reports some wire events twice).
    pub(crate) fn rust_names(events: &[StreamEvent]) -> Vec<String> {
        let mut names: Vec<String> = StreamEvent::progress_kinds(events).into_iter().map(str::to_owned).collect();
        names.dedup();
        names
    }

    /// The kinds Node's decoder reported, consecutive repeats folded.
    pub(crate) fn node_names(kinds: &serde_json::Value) -> Vec<String> {
        let mut names: Vec<String> = kinds.as_array().expect("kinds").iter().map(|kind| kind.as_str().expect("kind").to_owned()).collect();
        names.dedup();
        names
    }

    pub(crate) fn golden() -> serde_json::Value {
        serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/agent/compact/golden/stream_progress.json")).expect("golden")
    }
}