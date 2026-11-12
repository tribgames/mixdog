//! The header a manual compaction commits equals Node's session after `runSessionCompaction`
//! (fixtures/compaction-commit/golden.json, `record-compaction-commit.mjs`): the usage totals, the
//! `compaction` record, the invalidated baseline, the post-compaction usage snapshot and the
//! cache-break intent, the fallback title, with the answer: the whole header is compared, every key.

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

/// A manual pass archives each message as its stored row (Node's `serializeExecutionArchive` over `session.messages`),
/// never as `null`.
#[test]
fn a_manual_pass_archives_each_message_as_its_stored_row() {
    use mixdog_agent::compact::execution_tail::MessageRows;
    let rows = vec![
        json!({ "role": "user", "content": "hi" }),
        json!({ "role": "assistant", "content": "", "toolCalls": [{ "id": "c1", "name": "read", "arguments": {} }] }),
        json!({ "role": "tool", "content": "body", "toolCallId": "c1" }),
    ];
    let messages: Vec<AgentMessage> = rows.iter().map(|row| message_of(row).unwrap()).collect();
    let stored = registered(&messages, &rows);
    for (message, row) in messages.iter().zip(&rows) {
        assert_eq!(&stored.row(message), row);
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
            freeform: None,
        })
        .collect()
}

fn header_of(session: &Value) -> Header {
    session.as_object().expect("session").iter().filter(|(key, _)| key.as_str() != "messages").map(|(k, v)| (k.clone(), v.clone())).collect()
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// The whole header, every key: `header_of` leaves out `messages` only because a header is the session without its transcript.
fn comparable(header: &Header) -> Value {
    Value::Object(header.clone())
}

fn snapshot_of(case: &Value, header: &Header, messages: &[AgentMessage]) -> Arc<ContextSnapshot> {
    let wire = case["beforeRequestTools"].as_array().expect("tools");
    let prefix = case["beforeNativePrefix"].as_u64().expect("prefix") as usize;
    let provider = header["provider"].as_str().expect("provider").to_owned();
    Arc::new(ContextSnapshot {
        header: header.clone(),
        provider: provider.clone(),
        model: header["model"].as_str().expect("model").to_owned(),
        context_window: Value::Null,
        cwd: Value::Null,
        mode: Value::Null,
        messages: messages.to_vec(),
        active: true,
        request_native: wire[..prefix].to_vec(),
        request_defined: definitions(&wire[prefix..]),
        session_defined: definitions(case["before"]["tools"].as_array().expect("tools")),
        agent_mode: false,
        annotations: HashMap::new(),
        media: Arc::new(TextOnly),
        images: Arc::new(TextOnly),
        rows: Arc::new(StoredBodies),
        replay_owner: ProviderId::from(provider.as_str()),
    })
}

/// A session whose `messages` lead with four system blocks plans and commits over them as Node does
/// (fixtures/compaction-system-blocks/golden.json, `record-compaction-system-blocks.mjs`, recorded from
/// b6f10295a): the whole result object and the record equal Node's, counts and tokens included. The
/// blocks come from the header; the compactor and the stored rows keep the transcript alone.
#[test]
fn a_plan_and_its_commit_count_the_system_blocks_of_the_request() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/compaction-system-blocks/golden.json")).expect("golden json");
    let now = golden["now"].as_f64().expect("now");
    let rows_of = |messages: &Value| -> Vec<Value> { messages.as_array().expect("messages").iter().filter(|m| m["role"] != "system").cloned().collect() };
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let value = &case["result"]["value"];
        let mut header = header_of(&case["before"]);
        for (key, system) in ["promptBase", "promptStable", "bp3CoreContext", "promptEnv"].into_iter().zip(case["before"]["messages"].as_array().expect("messages")) {
            header.insert(key.into(), system["content"].clone());
        }
        header.insert("bp3EnvSplit".into(), json!(true));
        let before_rows = rows_of(&case["before"]["messages"]);
        let transcript: Vec<AgentMessage> = before_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        // The header's blocks are the recorded ones, message for message.
        let recorded: Vec<AgentMessage> = case["before"]["messages"].as_array().expect("messages")[..4].iter().map(|row| message_of(row).expect("a system block")).collect();
        let blocks = super::super::factory::system_messages(&header);
        assert_eq!(blocks.iter().map(|m| &m.message).collect::<Vec<_>>(), recorded.iter().map(|m| &m.message).collect::<Vec<_>>(), "{name}: the header rebuilds Node's four system messages");
        let snapshot = snapshot_of(case, &header, &transcript);
        let session_messages = priced(&header, &transcript);
        let plan = forced_plan(&snapshot, &session_messages).expect("a window").expect("a plan");
        let after_rows = rows_of(&case["after"]["messages"]);
        let compacted: Vec<AgentMessage> = after_rows.iter().map(|row| message_of(row).expect("a stored row")).collect();
        let mode = case["compactMode"].as_str().unwrap_or_default();
        let mut parts = mode.split(':');
        let (pipeline_mode, kind, route) = (parts.next().map(str::to_owned), parts.next(), parts.next().map(str::to_owned));
        let record = &case["after"]["compaction"];
        let changed = value["changed"] == Value::Bool(true);
        let facts = CommitFacts {
            snapshot: snapshot.clone(),
            messages: session_messages,
            before_rows,
            plan,
            compacted,
            compacted_rows: after_rows,
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
            committed_at: std::sync::Arc::new(move || now),
        };
        let (working, result) = committed_header(&facts, &header, &[]);
        assert_eq!(&result, value, "{name}: the reply");
        let mut want = header_of(&case["after"]);
        for key in ["promptBase", "promptStable", "bp3CoreContext", "promptEnv", "bp3EnvSplit"] {
            want.insert(key.into(), header[key].clone());
        }
        assert_eq!(comparable(&working), comparable(&want), "{name}: the header");
        compared += 1;
    }
    assert_eq!(compared, 2);
}

#[test]
fn a_committed_header_equals_nodes_session() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/compaction-commit/golden.json")).expect("golden json");
    let now = golden["now"].as_f64().expect("now");
    let sampled = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
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
        let snapshot = snapshot_of(case, &header, &messages);
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
            committed_at: { let sampled = sampled.clone(); std::sync::Arc::new(move || { sampled.fetch_add(1, std::sync::atomic::Ordering::SeqCst); now }) },
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
    assert_eq!(sampled.load(std::sync::atomic::Ordering::SeqCst), compared, "`recordCompactionTiming` samples the clock once per commit");
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

/// `compactConversationForHeir` hands the compactor the source's whole transcript: the system blocks its requests lead with
/// (`source.messages` holds them), then the conversation. Each case is what Node's `compactConversation` received
/// (fixtures/inheritance-carry/golden.json, `record-inheritance-carry.mjs`).
#[test]
fn the_compactor_of_an_heir_sees_the_source_transcript_with_its_system_blocks() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/inheritance-carry/golden.json")).expect("golden json");
    let wire = |message: &AgentMessage| {
        let role = match message.message.role {
            mixdog_core_api::domain::provider::Role::System => "system",
            mixdog_core_api::domain::provider::Role::User => "user",
            mixdog_core_api::domain::provider::Role::Assistant => "assistant",
            other => panic!("a role the golden has none of: {other:?}"),
        };
        let mixdog_core_api::domain::provider::Content::Text(content) = &message.message.content else { panic!("text content") };
        let tier = message.message.cache_tier.map(|tier| match tier {
            mixdog_core_api::domain::provider::CacheTier::Tier3 => "tier3",
            mixdog_core_api::domain::provider::CacheTier::Env => "env",
        });
        match tier {
            Some(tier) => json!({ "role": role, "content": content, "cacheTier": tier }),
            None => json!({ "role": role, "content": content }),
        }
    };
    let mut compared = 0;
    for case in golden["cases"].as_array().expect("cases") {
        let Some(call) = case["compactorCalls"].as_array().expect("calls").first() else { continue };
        let source = case["setup"]["source"]["messages"].as_array().expect("source messages");
        let block = |tier: Option<&str>| source.iter().find(|m| m["role"] == "system" && m["cacheTier"].as_str() == tier).map(|m| m["content"].clone()).expect("the system block");
        let mut header = Header::new();
        header.insert("bp3EnvSplit".into(), json!(true));
        header.insert("promptBase".into(), block(None));
        header.insert("bp3CoreContext".into(), block(Some("tier3")));
        header.insert("promptEnv".into(), block(Some("env")));
        let rows: Vec<Value> = source.iter().filter(|m| m["role"] != "system").cloned().collect();
        let got: Vec<Value> = super::super::factory::session_messages(&header, &rows).expect("messages").iter().map(wire).collect();
        assert_eq!(Value::Array(got), call["messages"], "{}", case["name"]);
        compared += 1;
    }
    assert_eq!(compared, 6);
}