//! What a manual compaction answers and records once its summary is made equals Node's
//! `runSessionCompaction` (fixtures/compaction-commit/golden.json, recorded by
//! benchmarks/rust-core/recorders/record-compaction-commit.mjs with a fake summary provider): the
//! result object, the `session.compaction` record with its timing, and the usage totals.

#[cfg(node_twin)]
use crate::compact_support;

#[cfg(node_twin)]
use compact_support::node_message;
#[cfg(node_twin)]
use compact_support::node_row;
#[cfg(node_twin)]
use compact_support::replay_owner;
#[cfg(node_twin)]
use mixdog_agent::compact::estimate::MediaMeter;
#[cfg(node_twin)]
use mixdog_agent::compact::estimate::MessageMeter;
#[cfg(node_twin)]
use mixdog_agent::compact::estimate::PartMeter;
#[cfg(node_twin)]
use mixdog_agent::compact::execution_tail::MessageRows;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::Archived;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::CommitInput;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::ImageDescriptor;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::ImageIdentities;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::Route;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::StatusInput;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::SummaryFacts;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::TRANSCRIPT_MOVED_ERROR;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::TranscriptSigner;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::commit_compaction;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::compaction_plan;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::failed_compaction;
#[cfg(node_twin)]
use mixdog_agent::compact::pressure::usage_totals;
#[cfg(node_twin)]
use mixdog_agent::compact::tool_schema::RequestTools;
#[cfg(node_twin)]
use mixdog_agent::message::AgentMessage;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ContentPart;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::ToolDefinition;
#[cfg(node_twin)]
use serde_json::Map;
use serde_json::Value;

#[cfg(node_twin)]
struct TextOnly;
#[cfg(node_twin)]
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

#[cfg(node_twin)]
struct NoImages;
#[cfg(node_twin)]
impl ImageIdentities for NoImages {
    fn images(&self, _: &AgentMessage) -> Vec<ImageDescriptor> {
        Vec::new()
    }
}

#[cfg(node_twin)]
struct RebuiltRows;
#[cfg(node_twin)]
impl MessageRows for RebuiltRows {
    fn row(&self, message: &AgentMessage) -> Value {
        node_row(message)
    }
}

#[cfg(node_twin)]
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

#[cfg(node_twin)]
fn header_of(session: &Value) -> Map<String, Value> {
    session.as_object().expect("session").iter().filter(|(k, _)| !matches!(k.as_str(), "messages" | "tools")).map(|(k, v)| (k.clone(), v.clone())).collect()
}

#[cfg(node_twin)]
fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// compact-smoke.mjs's migration check: `normalizeCompactionConfig` drops the retired compaction types and their knobs.
#[test]
fn the_retired_compaction_keys_are_dropped() {
    let legacy = serde_json::json!({ "type": "semantic", "compactType": "recall-fasttrack", "semantic": "auto", "prune": true, "tailTurns": 5, "auto": true });
    let migrated = mixdog_agent::compact::settings::normalize_compaction(Some(&legacy));
    for key in ["type", "compactType", "semantic", "prune", "tailTurns"] {
        assert!(!migrated.contains_key(key), "{key} kept: {migrated:?}");
    }
    assert_eq!(migrated.get("auto"), Some(&Value::Bool(true)));
}


#[cfg(node_twin)]
#[test]
fn the_config_keys_are_nodes() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/compaction-commit/golden.json")).expect("golden json");
    let keys: Vec<&str> = golden["configKeys"].as_array().expect("configKeys").iter().map(|k| k.as_str().unwrap()).collect();
    assert_eq!(keys, mixdog_agent::compact::pressure::COMPACTION_CONFIG_KEYS);
}
#[cfg(node_twin)]
#[test]
fn the_commit_equals_nodes() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/compaction-commit/golden.json")).expect("golden json");
    let now = golden["now"].as_f64().expect("now");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let (mut differ, mut compared) = (Vec::new(), 0);
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let before = &case["before"];
        let header = header_of(before);
        let messages: Vec<AgentMessage> = before["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &RebuiltRows };
        let wire = case["beforeRequestTools"].as_array().expect("tools");
        let prefix = case["beforeNativePrefix"].as_u64().expect("prefix") as usize;
        let request_defined = definitions(&wire[prefix..]);
        let session_defined = definitions(before["tools"].as_array().expect("tools"));
        let provider = header["provider"].as_str().expect("provider");
        let status = StatusInput {
            session: &header,
            route: Route { provider, model: header["model"].as_str().expect("model"), context_window: Value::Null },
            cwd: Value::Null,
            mode: Value::Null,
            messages: &messages,
            active: true,
            request_tools: RequestTools { native: &wire[..prefix], defined: &request_defined },
            session_tools: RequestTools { native: &[], defined: &session_defined },
            tool_breakdown: &Value::Null,
            agent_mode: false,
            meter: &meter,
            signer: &signer,
            env: &compact_support::NoVars,
        };
        let plan = compaction_plan(&status, false, true).expect("a manual pass has a window").expect("a plan");
        let after = &case["after"];
        let (got_result, got_record) = match case["result"]["value"].get("error").and_then(Value::as_str) {
            Some(error) => {
                if name.contains("moved") {
                    assert_eq!(error, TRANSCRIPT_MOVED_ERROR);
                }
                let fresh_error = case["result"]["value"]["freshContextError"].as_str();
                let failed = failed_compaction(&status, &plan, false, now, error, fresh_error);
                (failed.result, failed.compaction)
            }
            None => {
                let value = &case["result"]["value"];
                let appended_count = case["appendedCount"].as_u64().expect("appendedCount") as usize;
                let after_rows = after["messages"].as_array().expect("after messages");
                let (compacted_rows, appended_rows) = after_rows.split_at(after_rows.len() - appended_count);
                let compacted: Vec<AgentMessage> = compacted_rows.iter().map(node_message).collect();
                let appended: Vec<AgentMessage> = appended_rows.iter().map(node_message).collect();
                // How the pass ran, as the record reports it (`lastCompactMode`): pipeline mode, summary kind, route.
                let mode = case["compactMode"].as_str().unwrap_or_default();
                let mut parts = mode.split(':');
                let (pipeline_mode, kind, route) = (parts.next().map(str::to_owned), parts.next(), parts.next().map(str::to_owned));
                let record = &after["compaction"];
                let fresh = SummaryFacts {
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
                };
                let after_wire = case["afterRequestTools"].as_array().expect("tools");
                let after_prefix = case["afterNativePrefix"].as_u64().expect("prefix") as usize;
                let after_defined = definitions(&after_wire[after_prefix..]);
                let changed = value["changed"] == Value::Bool(true);
                let archived = changed.then(|| Archived { dropped: value["droppedMessages"].as_u64().unwrap_or(0), identities: Some(value["droppedIdentities"].clone()).filter(|i| !i.is_null()) });
                let committed = commit_compaction(&CommitInput {
                    status: &status,
                    plan: &plan,
                    auto_mode: false,
                    now,
                    started_at: now,
                    commit_started_at: now,
                    committed_at: now,
                    fresh: &fresh,
                    before_rows: before["messages"].as_array().expect("messages"),
                    compacted_rows,
                    compacted: &compacted,
                    appended: &appended,
                    after_tools: RequestTools { native: &after_wire[..after_prefix], defined: &after_defined },
                    archived,
                });
                // The usage totals the summary added to the session (the pass adds them before the commit).
                if !value["usage"].is_null() {
                    let totals = usage_totals(&header, &value["usage"], provider.starts_with("anthropic"));
                    for (key, want) in &totals {
                        if &after[key.as_str()] != want {
                            differ.push(format!("{name}: {key} Rust {want}, Node {}", after[key.as_str()]));
                        }
                    }
                }
                (committed.result, committed.compaction)
            }
        };
        let want_result = &case["result"]["value"];
        if &got_result != want_result {
            differ.push(format!("{name}: result Rust {got_result}, Node {want_result}"));
        }
        let got_record = Value::Object(got_record);
        if got_record != after["compaction"] {
            differ.push(format!("{name}: record Rust {got_record}, Node {}", after["compaction"]));
        }
        compared += 1;
    }
    assert!(compared >= 10, "{compared}");
    assert!(differ.is_empty(), "{} differ: {}", differ.len(), differ.iter().take(4).cloned().collect::<Vec<_>>().join(" ; "));
}
