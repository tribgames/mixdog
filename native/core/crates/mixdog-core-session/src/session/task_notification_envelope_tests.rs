//! `fixtures/task-notification-envelope-cases` (`record-task-notification-envelope-cases.mjs`, b6f10295a): the agent-completion cases
//! of `task-notification-envelope.test.mjs`, replayed through the product's renderer, classifiers, queued-entry builder and delivered
//! registry. Every recorded field is compared except what the manifest excludes: `legacyModelVisible` (Node converts a legacy quoted wrapper
//! into the current envelope; the core queues only envelopes it rendered), `headerStatus` and the parsed `exitCode` and `outputFile` (read only by Node's
//! own task renderers, which the core does not have).

use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use mixdog_agent::agent_tool::board::render_agent_completion;
use mixdog_agent::compact::ingest::IngestView;
use mixdog_agent::compact::ingest::should_exclude_ingest_message;
use mixdog_agent::project::is_internal_runtime_notification;
use mixdog_agent::project::is_model_visible_tool_completion_wrapper;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::text_class::parse_task_notification;
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::agent_registry::flow::model_visible;
use super::completions;
use super::delivered::DeliveredCompletions;
use super::delivered::task_notification_id;
use super::testing::FixedClock;

fn observed(name: &str) -> Value {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/task-notification-envelope-cases/golden.json")).expect("golden.json");
    let golden = Exact::decode(&golden).expect("exact");
    let found = golden.get("cases").as_array().iter().find(|case| case.get("case").as_str() == name).cloned();
    found.unwrap_or_else(|| panic!("no recorded case {name:?}")).get("observed").to_plain().expect("plain")
}

/// `renderAgentCompletionEnvelope(input)`: the arguments the Node options name.
fn render(input: &Value) -> String {
    let field = |key: &str| input[key].as_str().unwrap_or_default().to_owned();
    render_agent_completion(&field("id"), &field("tag"), &field("status"), &field("result"), &field("error"), &field("detail"))
}

fn ingest_excluded(text: &str) -> bool {
    should_exclude_ingest_message(&IngestView { role: Role::User, first_text: text, meta_source: "", skill_body: false, has_tool_calls: false })
}

/// What `parseTaskNotification` returns, less `exitCode` and `outputFile` (the manifest's exclusions).
fn parsed(text: &str) -> Value {
    let n = parse_task_notification(text).expect("an envelope");
    json!({ "taskId": n.task_id, "tag": n.tag, "surface": n.surface, "status": n.status, "summary": n.summary, "result": n.result, "error": n.error })
}

/// The recorded `parsed` less the two excluded fields.
fn recorded_parsed(want: &Value) -> Value {
    let mut parsed = want["parsed"].clone();
    parsed.as_object_mut().unwrap().retain(|key, _| key != "exitCode" && key != "outputFile");
    parsed
}

/// `modelVisibleToolCompletionMessage(text)` with no meta.
fn model_visible_of(text: &str) -> Value {
    json!(model_visible(text, &json!({})).unwrap_or_default())
}

fn classified(want: &Value, text: &str) {
    assert_eq!(parsed(text), recorded_parsed(want), "parseTaskNotification");
    assert_eq!(json!(is_model_visible_tool_completion_wrapper(text)), want["wrapper"], "isModelVisibleToolCompletionWrapper");
    assert_eq!(json!(is_internal_runtime_notification(text)), want["internal"], "isInternalRuntimeNotificationText");
    assert_eq!(json!(ingest_excluded(text)), want["ingestExcluded"], "shouldExcludeIngestMessage");
}

/// The clock the recorder held for the whole run: `enqueuedAt` of every recorded entry.
const HELD_NOW: i64 = 1_800_000_000_000;

fn queued(text: &str, execution_surface: &str, status: &str) -> Value {
    let (id, mut entry) = completions::entry(execution_surface, &task_notification_id(text), status, text, HELD_NOW).expect("a queued completion");
    let fields = entry.as_object_mut().unwrap();
    let message = fields.remove("message").unwrap();
    fields.extend([("id".to_owned(), json!(id)), ("content".to_owned(), message.clone()), ("text".to_owned(), message)]);
    entry
}

#[test]
fn an_agent_completion_is_one_tagged_block_with_its_result_verbatim_as_node_recorded() {
    let want = observed("agent completion is exactly one tagged block with verbatim result and no usage");
    let text = render(&want["input"]);
    assert_eq!(json!(text), want["text"]);
    classified(&want, &text);
    assert_eq!(parsed(&text)["result"], want["input"]["result"], "the result comes back verbatim");
}

/// What the model is shown of each recorded completion; asserts nothing else, so a break of `model_visible` fails here alone.
#[test]
fn the_model_sees_each_recorded_completion_as_node_recorded() {
    for name in [
        "agent completion is exactly one tagged block with verbatim result and no usage",
        "failure without a result carries its error, not a synthetic result or usage",
    ] {
        let want = observed(name);
        let text = render(if want.get("failed").is_some() { &want["failed"] } else { &want["input"] });
        assert_eq!(model_visible_of(&text), want["modelVisible"], "{name}");
    }
}

#[test]
fn a_failure_carries_its_error_and_a_cancellation_neither_result_nor_error_as_node_recorded() {
    let want = observed("failure without a result carries its error, not a synthetic result or usage");
    let text = render(&want["failed"]);
    assert_eq!(json!(text), want["text"]);
    classified(&want, &text);
    assert_eq!(json!(render(&want["cancelled"])), want["cancelledText"]);
}

#[test]
fn a_large_result_is_neither_truncated_by_wrapping_nor_by_its_queued_entry_as_node_recorded() {
    let want = observed("large results are not truncated by wrapping or re-enqueue");
    let text = render(&want["input"]);
    assert_eq!(json!(text), want["text"]);
    let visible = model_visible(&text, &json!({})).unwrap_or_default();
    assert_eq!(json!(visible == text), want["visibleIsText"]);
    let entry = queued(&visible, "agent", "completed");
    assert_eq!(entry, want["entry"], "the entry carries the whole text with its execution");
    assert_eq!(json!(entry["content"].as_str().unwrap() == text), want["entryContentIsText"]);
    assert_eq!(json!(parse_task_notification(entry["content"].as_str().unwrap()).unwrap().result), want["entryResult"]);
}

#[test]
fn a_legacy_quoted_row_classifies_and_dedupes_with_the_current_envelope_as_node_recorded() {
    let want = observed("legacy quoted rows still classify and dedupe against new rows by task identity");
    let (legacy, current) = (want["legacy"].as_str().unwrap(), render(&want["input"]));
    assert_eq!(json!(current), want["current"]);
    assert_eq!(json!(is_model_visible_tool_completion_wrapper(legacy)), want["legacyWrapper"]);
    assert_eq!(json!(ingest_excluded(legacy)), want["legacyIngestExcluded"]);
    assert_eq!(json!(task_notification_id(legacy)), want["legacyTaskId"]);
    // The queue entry's identity is the task's, so a legacy row and its envelope are one entry; the legacy row names no surface or status.
    assert_eq!(queued(legacy, "", ""), want["legacyEntry"]);
    assert_eq!(queued(&current, "agent", "completed"), want["currentEntry"]);
    assert_eq!(queued(legacy, "", "")["id"], queued(&current, "agent", "completed")["id"]);
    let delivered = DeliveredCompletions::new(Arc::new(FixedClock(AtomicU64::new(1_800_000_000_000))));
    assert_eq!(json!(delivered.record(None, Some(legacy))), want["recorded"]);
    assert_eq!(json!(delivered.is_delivered(None, Some(&current))), want["deliveredCurrent"]);
}

#[test]
fn the_task_id_line_names_the_task_before_the_async_header_as_node_recorded() {
    let want = observed("the task_id line names the task before the async header, and the header names it when no line does");
    for (name, recorded) in want.as_object().unwrap() {
        let text = recorded["text"].as_str().unwrap();
        assert_eq!(json!(task_notification_id(text)), recorded["taskId"], "{name}: taskNotificationId");
        assert_eq!(queued(text, "", ""), recorded["entry"], "{name}: the queued entry");
    }
}
