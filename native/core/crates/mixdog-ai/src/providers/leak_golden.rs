//! Node's recorded leaked tool-call goldens (`fixtures/agent/leaked-toolcall/golden/leaked_toolcall.json`, written by
//! `record.mjs` from Node's real decoders) against what a Rust decoder reports for the same wire events.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use serde_json::Value;

pub(crate) fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/agent/leaked-toolcall/golden/leaked_toolcall.json"))
        .expect("golden")
}

/// The recorded scenarios of one route.
pub(crate) fn route(name: &str) -> Vec<Value> {
    golden()["scenarios"]
        .as_array()
        .expect("scenarios")
        .iter()
        .filter(|scenario| scenario["route"] == name)
        .cloned()
        .collect()
}

/// The tools the scenario's request offered.
pub(crate) fn known(scenario: &Value) -> HashSet<String> {
    scenario["known"]
        .as_array()
        .expect("known")
        .iter()
        .map(|name| name.as_str().expect("name").to_owned())
        .collect()
}

pub(crate) fn text_of(events: &[StreamEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// The turn's text as the fold keeps it: the deltas, unless the provider returned another final content.
pub(crate) fn content_of(events: &[StreamEvent]) -> String {
    let mut content = String::new();
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => content.push_str(text),
            StreamEvent::FinalContent(text) => content = text.clone(),
            _ => {}
        }
    }
    content
}

/// The calls the turn returns (result.toolCalls): the last ReturnedCalls, else every dispatched call.
pub(crate) fn returned_of(events: &[StreamEvent]) -> Vec<ToolCall> {
    match events.iter().rev().find_map(|e| if let StreamEvent::ReturnedCalls(calls) = e { Some(calls.clone()) } else { None }) {
        Some(calls) => calls,
        None => calls_of(events),
    }
}

pub(crate) fn calls_of(events: &[StreamEvent]) -> Vec<ToolCall> {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::ToolCallDone(call) => Some(call.clone()),
            _ => None,
        })
        .collect()
}

/// A minted id is recorded as `<prefix>_leaked_*` (16 random hex digits); every other id is exact.
fn same_id(want: &str, got: &str) -> bool {
    match want.strip_suffix('*') {
        Some(prefix) => got
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.len() == 16 && rest.chars().all(|c| c.is_ascii_hexdigit())),
        None => want == got,
    }
}

pub(crate) fn assert_calls(label: &str, want: &Value, got: &[ToolCall]) {
    let want = want.as_array().expect("calls");
    assert_eq!(want.len(), got.len(), "{label}: calls {want:?} against {got:?}");
    for (want, got) in want.iter().zip(got) {
        assert!(same_id(want["id"].as_str().expect("id"), &got.id), "{label}: id {} against {}", want["id"], got.id);
        assert_eq!(want["name"].as_str().expect("name"), got.name, "{label}: name");
        assert_eq!(want["arguments"], got.arguments, "{label}: arguments");
    }
}

/// The kinds a leaked call is reported by: `text` and `tool`, consecutive repeats folded (Node reports some
/// wire events twice).
fn leak_kinds(kinds: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = kinds.into_iter().filter(|kind| kind == "text" || kind == "tool").collect();
    out.dedup();
    out
}

struct Step {
    text: String,
    calls: Vec<Value>,
    kinds: Vec<String>,
}

fn node_steps(scenario: &Value) -> Vec<Step> {
    scenario["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .map(|step| Step {
            text: step["text"].as_array().expect("text").iter().filter_map(Value::as_str).collect(),
            calls: step["calls"].as_array().expect("calls").clone(),
            kinds: step["kinds"].as_array().expect("kinds").iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        })
        .collect()
}

fn rust_steps(steps: &[Vec<StreamEvent>]) -> Vec<Step> {
    steps
        .iter()
        .map(|events| Step {
            text: text_of(events),
            calls: calls_of(events)
                .into_iter()
                .map(|call| serde_json::json!({ "id": call.id, "name": call.name, "arguments": call.arguments }))
                .collect(),
            kinds: StreamEvent::progress_kinds(events).into_iter().map(str::to_owned).collect(),
        })
        .collect()
}

/// The last wire event and the end of the stream are one step: Node flushes the guard when the body ends, Rust at
/// the terminal event.
fn merge_tail(mut steps: Vec<Step>) -> Vec<Step> {
    if let Some(last) = steps.pop()
        && let Some(before) = steps.last_mut()
    {
        before.text.push_str(&last.text);
        before.calls.extend(last.calls);
        before.kinds.extend(last.kinds);
    }
    steps
}

/// What Node's decoder returned for the scenario against what the Rust decoder's events fold to: the content, the
/// returned calls, and (for a scenario that shows text) per wire event the text relayed, the calls dispatched when
/// the route dispatches live, and the leak's progress.
pub(crate) fn check(label: &str, scenario: &Value, steps: &[Vec<StreamEvent>], live_calls: bool) {
    let all: Vec<StreamEvent> = steps.iter().flatten().cloned().collect();
    let result = &scenario["result"];
    let content = result["content"].as_str().expect("content");
    assert_eq!(content_of(&all), content, "{label}: content");
    // The list the turn returns: the provider's own ReturnedCalls when it names one, else the calls it dispatched.
    assert_calls(label, &result["toolCalls"], &returned_of(&all));
    let want = merge_tail(node_steps(scenario));
    let got = merge_tail(rust_steps(steps));
    assert_eq!(want.len(), got.len(), "{label}: steps");
    for (index, (want, got)) in want.iter().zip(&got).enumerate() {
        let at = format!("{label} step {index} {}", scenario["wire"][index]);
        assert_eq!(want.text, got.text, "{at}: text");
        if live_calls {
            let got_calls: Vec<ToolCall> = got
                .calls
                .iter()
                .map(|call| ToolCall {
                    id: call["id"].as_str().expect("id").to_owned(),
                    name: call["name"].as_str().expect("name").to_owned(),
                    arguments: call["arguments"].clone(),
                    native_type: None,
                })
                .collect();
            assert_calls(&at, &Value::Array(want.calls.clone()), &got_calls);
        }
        if scenario["native"] != true {
            assert_eq!(
                leak_kinds(want.kinds.clone()),
                leak_kinds(got.kinds.clone()),
                "{at}: progress"
            );
        }
    }
}
