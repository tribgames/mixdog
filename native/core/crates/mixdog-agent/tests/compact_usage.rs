//! The usage bookkeeping of the session header equals Node's: what one model call writes, the check before
//! a send, the turn's end, the turn id and an adopted compaction, each as the header after the call
//! (fixtures/agent/compact/golden/usage.json, recorded by fixtures/agent/compact/record_usage.mjs).

mod compact_support;

use compact_support::node_message;
use compact_support::node_row;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure::Books;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::HeaderPatch;
use mixdog_agent::compact::pressure::ImageDescriptor;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::Settled;
use mixdog_agent::compact::pressure::TerminalUsage;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::check_change;
use mixdog_agent::compact::pressure::compacted_change;
use mixdog_agent::compact::pressure::iteration_metrics;
use mixdog_agent::compact::pressure::settled_change;
use mixdog_agent::compact::pressure::terminal_usage;
use mixdog_agent::compact::pressure::turn_started;
use mixdog_agent::compact::pressure::usage_change;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::Usage;
use serde_json::Value;
use serde_json::json;

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

struct NoImages;
impl ImageIdentities for NoImages {
    fn images(&self, _: &AgentMessage) -> Vec<ImageDescriptor> {
        Vec::new()
    }
}

struct RebuiltRows;
impl MessageRows for RebuiltRows {
    fn row(&self, message: &AgentMessage) -> Value {
        node_row(message)
    }
}

fn tools_of(value: &Value) -> Vec<ToolDefinition> {
    value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
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

/// A usage record as Node's normalized usage has it, as the run reports it.
fn usage_of(record: &Value) -> Usage {
    let count = |key: &str| record[key].as_u64().unwrap_or(0);
    let reasoning = record["reasoningTokens"].as_u64();
    Usage {
        input_tokens: count("inputTokens"),
        output_tokens: count("outputTokens"),
        cache_read_tokens: count("cachedTokens"),
        cache_write_tokens: count("cacheWriteTokens"),
        reasoning_tokens: reasoning,
        reasoning_incomplete: reasoning.is_some() && record["reasoningTokensComplete"] == Value::Bool(false),
        ..Usage::default()
    }
}

fn applied(header: &Header, patch: &Option<HeaderPatch>) -> Header {
    let mut after = header.clone();
    if let Some(patch) = patch {
        patch.apply(&mut after);
    }
    after
}

#[test]
fn usage_bookkeeping_equals_node() {
    let golden = golden!("usage");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let cases = golden["cases"].as_array().expect("cases");
    let mut ops = std::collections::BTreeSet::new();
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let op = case["op"].as_str().expect("op");
        ops.insert(op);
        let header: Header = case["header"].as_object().expect("header").clone();
        let now = case["now"].as_f64().expect("now");
        let args = &case["args"];
        let messages: Vec<AgentMessage> = case["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let signer = TranscriptSigner { meter: &meter, images: &NoImages, rows: &RebuiltRows };
        let native: Vec<Value> = args["native"].as_array().cloned().unwrap_or_default();
        let books = Books { signer: &signer, native: &native, agent_mode: args["agentMode"].as_bool().unwrap_or(false) };
        let tools = tools_of(&args["tools"]);
        let excludes = args["excludesCache"].as_bool().unwrap_or(false);

        let (patch, result): (Option<HeaderPatch>, Value) = match op {
            "turnStart" => {
                let patch = turn_started(&header);
                let id = patch.as_ref().map_or(Value::Null, |p| p.set["usageMetricsTurnId"].clone());
                (patch, id)
            }
            "iteration" => (Some(iteration_metrics(&header, &args["delta"], excludes, now)), Value::Null),
            "usage" => (usage_change(&header, &args["delta"], &messages, &tools, Some(&books), excludes, now), Value::Null),
            "terminal" | "settled" => {
                let result = &args["result"];
                let usage = result.get("usage").filter(|u| !u.is_null());
                let incremental = args["incremental"].as_bool().expect("incremental");
                let patch = if op == "terminal" {
                    let empty = json!({});
                    let last_turn = result.get("lastTurnUsage").filter(|u| !u.is_null()).or(usage).unwrap_or(&empty);
                    let ask = TerminalUsage {
                        usage,
                        last_turn,
                        tool_calls_total: result["toolCallsTotal"].as_f64().unwrap_or(0.0),
                        incremental,
                        input_excludes_cache: excludes,
                        now,
                    };
                    Some(terminal_usage(&header, &ask))
                } else {
                    let usage = usage_of(&result["usage"]);
                    let last_turn_usage = usage_of(&result["lastTurnUsage"]);
                    let send_tools = tools_of(&args["tools"]);
                    let ask = Settled { transcript: &messages, usage: &usage, last_turn_usage: &last_turn_usage, tool_calls_total: result["toolCallsTotal"].as_u64().unwrap_or(0), send_tools: &send_tools };
                    settled_change(&header, &ask, incremental, Some(&books), excludes, now)
                };
                (patch, Value::Null)
            }
            "check" => {
                let patch = check_change(&header, &messages, &tools, args["reactive"].as_bool().expect("reactive"), &books, now);
                let recorded = Value::Bool(patch.is_some());
                (patch, recorded)
            }
            "compacted" => {
                let patch = compacted_change(&header, now);
                let after = applied(&header, &patch);
                let picked: serde_json::Map<String, Value> = case["after"].as_object().expect("after").keys().map(|key| (key.clone(), after[key].clone())).collect();
                assert_eq!(Value::Object(picked), case["after"], "{name}: header after");
                let stamp = |key: &str| after["compaction"][key].clone();
                assert_eq!(case["result"]["lastChangedAt"], stamp("lastChangedAt"), "{name}: lastChangedAt");
                assert_eq!(case["result"]["lastCompactAt"], stamp("lastCompactAt"), "{name}: lastCompactAt");
                continue;
            }
            other => panic!("unknown op {other}"),
        };
        assert_eq!(Value::Object(applied(&header, &patch)), case["after"], "{name}: header after");
        if matches!(op, "turnStart" | "check") {
            assert_eq!(result, case["result"], "{name}: result");
        }
    }
    assert_eq!(ops.into_iter().collect::<Vec<_>>(), ["check", "compacted", "iteration", "settled", "terminal", "turnStart", "usage"]);
    assert!(cases.len() > 50, "the golden holds every writer's cases");
}
