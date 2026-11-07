//! Cache-sharing forks against the Node recording
//! (`providers/anthropic-shared-prefix/cases.json`, recorded by
//! `benchmarks/rust-core/recorders/record-anthropic-shared-prefix.mjs` from
//! Node's own request builders and thread planner): where the fork keeps its
//! message breakpoint, and that a fork never carries a response thread.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;

use super::AnthropicCodec;
use super::AnthropicConfig;
use super::Flavor;
use super::ModelCaps;
use super::effort_tests::message_of;
use super::effort_tests::tool_of;

#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
fn recording() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/providers/anthropic-shared-prefix/cases.json");
    let text = std::fs::read_to_string(path).expect("recorded cases");
    mixdog_js::fixture_tools::parse_golden(&text).expect("json")
}

fn encode(case: &Value) -> mixdog_core_api::domain::provider::WireRequest {
    let flavor = if case["route"] == "anthropic-oauth" { Flavor::OAuth } else { Flavor::ApiKey };
    // The model's catalog capabilities as Node saw them: only the output limit shows in these bodies.
    let caps = Some(ModelCaps {
        max_output_tokens: case["expected"]["body"]["max_tokens"].as_u64().map(|v| v as u32),
        ..ModelCaps::default()
    });
    let codec = AnthropicCodec::new(flavor, AnthropicConfig::new(Arc::new(move |_: &str| caps.clone())));
    let request = ModelRequest {
        model: case["model"].as_str().expect("model").into(),
        messages: case["messages"].as_array().expect("messages").iter().map(message_of).collect(),
        tools: case["tools"].as_array().expect("tools").iter().map(tool_of).collect(),
        options: RequestOptions {
            shared_cache_prefix_count: case["sharedCachePrefixCount"].as_u64().map(|count| count as usize),
            ..RequestOptions::default()
        },
    };
    codec.encode(&request).expect("encodes")
}

fn header<'a>(wire: &'a mixdog_core_api::domain::provider::WireRequest, name: &str) -> Option<&'a str> {
    wire.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

#[test]
fn a_fork_encodes_the_recorded_request_on_both_routes() {
    let document = recording();
    let cases = document["requests"].as_array().expect("requests");
    assert_eq!(cases.len(), 14);
    for case in cases {
        let id = case["id"].as_str().expect("id");
        let wire = encode(case);
        let body: Value = serde_json::from_slice(&wire.body).expect("json");
        assert_eq!(body, case["expected"]["body"], "{id}: body");
        assert_eq!(header(&wire, "anthropic-beta"), case["expected"]["betaHeader"].as_str(), "{id}: anthropic-beta");
    }
}

/// The fork's breakpoint is the saved request's own: same message and block,
/// the prefix bytes equal the saved request's, and the suffix carries none.
#[test]
fn a_fork_reads_the_saved_requests_entry_and_writes_none_for_its_suffix() {
    let document = recording();
    let cases = document["requests"].as_array().expect("requests");
    let find = |id: &str| cases.iter().find(|c| c["id"] == id).unwrap_or_else(|| panic!("{id}"));
    for suffix in ["oauth", "api"] {
        let saved = &find(&format!("saved.{suffix}"))["expected"]["body"]["messages"];
        let fork = encode(find(&format!("fork.{suffix}")));
        let body: Value = serde_json::from_slice(&fork.body).expect("json");
        let messages = body["messages"].as_array().expect("messages");
        let saved = saved.as_array().expect("saved");
        assert_eq!(&messages[..saved.len()], saved.as_slice(), "{suffix}: the shared prefix, marker included");
        let marked: Vec<usize> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| m["content"].as_array().is_some_and(|c| c.iter().any(|b| b.get("cache_control").is_some())))
            .map(|(i, _)| i)
            .collect();
        assert_eq!(marked, vec![saved.len() - 1], "{suffix}");
    }
}

/// A request carrying the field never continues a response thread: Node's
/// planner leaves it unthreaded, and the encoded request has no `thread`.
#[test]
fn a_fork_never_carries_a_response_thread() {
    let document = recording();
    let plans = document["threads"].as_array().expect("threads");
    let forks: Vec<&Value> = plans.iter().filter(|p| !p["sharedCachePrefixCount"].is_null()).collect();
    assert_eq!(forks.len(), 2);
    for plan in forks {
        assert_eq!(plan["expected"]["mode"], "none");
        assert!(plan["expected"]["thread"].is_null());
        assert_eq!(plan["expected"]["threadBeta"], false);
    }
    for case in document["requests"].as_array().expect("requests") {
        let wire = encode(case);
        let body: Value = serde_json::from_slice(&wire.body).expect("json");
        assert!(body.get("thread").is_none(), "{}", case["id"]);
        assert!(!header(&wire, "anthropic-beta").unwrap_or("").contains("message-threads"), "{}", case["id"]);
    }
}
