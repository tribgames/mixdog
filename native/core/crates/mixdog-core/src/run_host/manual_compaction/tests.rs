//! The header a manual compaction commits equals Node's session after `runSessionCompaction`
//! (fixtures/compaction-commit/golden.json, `record-compaction-commit.mjs`): the usage totals, the
//! `compaction` record, the invalidated baseline, the post-compaction usage snapshot and the
//! cache-break intent, with the answer. The fallback title Node also sets is not ported (see the
//! module doc), so `title` and `titleUpdatedAt` are left out of both sides.

use std::collections::HashMap;

use mixdog_agent::compact::estimate::{MediaMeter, PartMeter};
use mixdog_agent::compact::pressure::{ImageDescriptor, ImageIdentities};
use mixdog_core_api::domain::provider::{ContentPart, ToolDefinition};
use mixdog_protocol::ProviderId;

use super::super::context_world::StoredBodies;
use super::*;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}
impl ImageIdentities for TextOnly {
    fn images(&self, _: &AgentMessage) -> Vec<ImageDescriptor> {
        Vec::new()
    }
}

fn definitions(tools: &[Value]) -> Vec<ToolDefinition> {
    tools
        .iter()
        .map(|t| ToolDefinition {
            name: t["name"].as_str().expect("name").to_owned(),
            description: t["description"].as_str().expect("description").to_owned(),
            input_schema: t["inputSchema"].clone(),
            defer_loading: t["deferLoading"] == Value::Bool(true),
        })
        .collect()
}

fn header_of(session: &Value) -> Header {
    session.as_object().expect("session").iter().filter(|(key, _)| key.as_str() != "messages").map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn comparable(header: &Header) -> Value {
    Value::Object(header.iter().filter(|(key, _)| !matches!(key.as_str(), "messages" | "tools" | "title" | "titleUpdatedAt")).map(|(k, v)| (k.clone(), v.clone())).collect())
}

#[test]
fn a_committed_header_equals_nodes_session() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/compaction-commit/golden.json")).expect("golden json");
    let now = golden["now"].as_f64().expect("now");
    let (mut differ, mut compared) = (Vec::new(), 0);
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let value = &case["result"]["value"];
        if value.get("error").is_some() {
            continue;
        }
        let before = &case["before"];
        let header = header_of(before);
        let before_rows: Vec<Value> = before["messages"].as_array().expect("messages").clone();
        let messages: Vec<AgentMessage> = before_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        let wire = case["beforeRequestTools"].as_array().expect("tools");
        let prefix = case["beforeNativePrefix"].as_u64().expect("prefix") as usize;
        let provider = header["provider"].as_str().expect("provider").to_owned();
        let snapshot = Arc::new(ContextSnapshot {
            header: header.clone(),
            provider: provider.clone(),
            model: header["model"].as_str().expect("model").to_owned(),
            context_window: Value::Null,
            cwd: Value::Null,
            mode: Value::Null,
            messages: messages.clone(),
            active: true,
            request_native: wire[..prefix].to_vec(),
            request_defined: definitions(&wire[prefix..]),
            session_defined: definitions(before["tools"].as_array().expect("tools")),
            agent_mode: false,
            annotations: HashMap::new(),
            media: Arc::new(TextOnly),
            images: Arc::new(TextOnly),
            rows: Arc::new(StoredBodies),
            replay_owner: ProviderId::from(provider.as_str()),
        });
        let plan = with_status(&snapshot, &header, &messages, |status| compaction_plan(status, false, true)).expect("a window").expect("a plan");
        let after = &case["after"];
        let appended_count = case["appendedCount"].as_u64().expect("appendedCount") as usize;
        let after_rows = after["messages"].as_array().expect("after messages");
        let (compacted_rows, appended_rows) = after_rows.split_at(after_rows.len() - appended_count);
        let compacted: Vec<AgentMessage> = compacted_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        let mode = case["compactMode"].as_str().unwrap_or_default();
        let mut parts = mode.split(':');
        let (pipeline_mode, kind, route) = (parts.next().map(str::to_owned), parts.next(), parts.next().map(str::to_owned));
        let record = &after["compaction"];
        let changed = value["changed"] == Value::Bool(true);
        let facts = CommitFacts {
            snapshot: snapshot.clone(),
            messages,
            before_rows,
            plan,
            compacted,
            compacted_rows: compacted_rows.to_vec(),
            fresh: SummaryFacts {
                usage: Some(value["usage"].clone()).filter(|u| !u.is_null()),
                fresh_context: value["freshContext"] == Value::Bool(true),
                handoff_source: text(&value["handoffSource"]),
                summary_provider: text(&record["lastSummaryProvider"]),
                summary_model: text(&record["lastSummaryModel"]),
                pipeline_mode,
                summary_route: route,
                forked: kind == Some("fork"),
                generated_ms: record["lastSummaryMs"].as_f64(),
                total_ms: record["lastPipelineMs"].as_f64(),
            },
            archived: changed.then(|| Archived { dropped: value["droppedMessages"].as_u64().unwrap_or(0), identities: Some(value["droppedIdentities"].clone()).filter(|i| !i.is_null()) }),
            now,
            started_at: now,
            commit_started_at: now,
        };
        let appended: Vec<(ItemId, Value)> = appended_rows.iter().enumerate().map(|(n, row)| (ItemId::from(format!("late_{n}")), row.clone())).collect();
        let (working, result) = committed_header(&facts, &header, &appended);
        if &result != value {
            differ.push(format!("{name}: result Rust {result}, Node {value}"));
        }
        let (got, want) = (comparable(&working), comparable(&header_of(after)));
        if got != want {
            differ.push(format!("{name}: header Rust {got}, Node {want}"));
        }
        compared += 1;
    }
    assert_eq!(compared, 8, "the recorded cases that commit or leave the transcript");
    assert!(differ.is_empty(), "{} differ: {}", differ.len(), differ.iter().take(3).cloned().collect::<Vec<_>>().join(" ; "));
}

#[test]
fn a_header_change_names_what_was_set_and_what_went() {
    let before = json!({ "a": 1, "b": 2, "c": 3 }).as_object().cloned().unwrap();
    let after = json!({ "a": 1, "b": 5, "d": 4 }).as_object().cloned().unwrap();
    let change = header_change(&before, &after);
    assert_eq!(Value::Object(change.set), json!({ "b": 5, "d": 4 }));
    assert_eq!(change.unset, ["c"]);
}
