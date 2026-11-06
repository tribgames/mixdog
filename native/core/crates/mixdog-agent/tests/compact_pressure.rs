//! The context-pressure state equals Node's: the usage snapshot, the provider baseline, their
//! invalidations and the checkpoint restore, each as the header after the call.

mod compact_support;

use std::collections::HashMap;

use compact_support::node_message;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::pressure::BaselineArgs;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::HeaderPatch;
use mixdog_agent::compact::pressure::ImageDescriptor;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::UsageSnapshotArgs;
use mixdog_agent::compact::pressure::invalidate_context_usage_snapshot;
use mixdog_agent::compact::pressure::invalidate_provider_context_baseline;
use mixdog_agent::compact::pressure::record_context_usage_snapshot;
use mixdog_agent::compact::pressure::record_provider_context_baseline;
use mixdog_agent::compact::pressure::restore_turn_checkpoint_context_state;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;

/// The golden transcripts carry text only; media is the host's to price.
struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only golden: {part:?}")
    }
}

/// Node's image descriptors of the messages that carry images, by message id.
struct GoldenImages(HashMap<String, Vec<ImageDescriptor>>);

impl GoldenImages {
    fn new(golden: &Value) -> Self {
        let dimension = |v: &Value| v.as_f64();
        Self(
            golden
                .as_object()
                .expect("images")
                .iter()
                .map(|(id, list)| {
                    let images = list
                        .as_array()
                        .expect("descriptors")
                        .iter()
                        .map(|d| ImageDescriptor {
                            identity: d["identity"].as_str().expect("identity").to_owned(),
                            width: dimension(&d["width"]),
                            height: dimension(&d["height"]),
                            detail: d["detail"].as_str().expect("detail").to_owned(),
                        })
                        .collect();
                    (id.clone(), images)
                })
                .collect(),
        )
    }
}

impl ImageIdentities for GoldenImages {
    fn images(&self, message: &AgentMessage) -> Vec<ImageDescriptor> {
        message.message_id.as_ref().and_then(|id| self.0.get(id)).cloned().unwrap_or_default()
    }
}

fn header_of(value: &Value) -> Header {
    value.as_object().expect("header").clone()
}

fn tools_of(value: &Value) -> Vec<ToolDefinition> {
    value
        .as_array()
        .expect("tools")
        .iter()
        .map(|t| ToolDefinition {
            name: t["name"].as_str().expect("name").to_owned(),
            description: t["description"].as_str().expect("description").to_owned(),
            input_schema: t["inputSchema"].clone(),
            defer_loading: t["deferLoading"] == Value::Bool(true),
        })
        .collect()
}

/// A recorded argument that may be absent or null (`undefined`/`null` in Node).
fn optional_number(value: Option<&Value>) -> Option<f64> {
    value.filter(|v| !v.is_null()).map(mixdog_js::to_number)
}

#[test]
fn pressure_state_equals_node() {
    let golden = golden!("pressure");
    let now = golden["now"].as_f64().expect("now");
    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    for case in golden["cases"].as_array().expect("cases") {
        let name = case["name"].as_str().expect("name");
        let messages: Vec<AgentMessage> = case["messages"].as_array().expect("messages").iter().map(node_message).collect();
        let images = GoldenImages::new(&case["images"]);
        let signer = TranscriptSigner { meter: &meter, images: &images };
        let header = header_of(&case["header"]);
        let args = &case["args"];

        let (patch, result): (Option<HeaderPatch>, Value) = match case["op"].as_str().expect("op") {
            "snapshot" => {
                let source = args.get("source").and_then(Value::as_str).unwrap_or("post_compact");
                let patch = record_context_usage_snapshot(
                    &header,
                    &header_of(&args["policy"]),
                    &messages,
                    &signer,
                    &UsageSnapshotArgs {
                        used_tokens: mixdog_js::to_number_of(args.get("usedTokens")),
                        message_tokens_est: optional_number(args.get("messageTokensEst")),
                        source,
                        updated_at: optional_number(args.get("updatedAt")),
                        now,
                    },
                );
                let result = patch.as_ref().map_or(Value::Null, |p| p.set["contextUsageSnapshot"].clone());
                (patch, result)
            }
            "invalidateSnapshot" => (Some(invalidate_context_usage_snapshot()), Value::Null),
            "invalidateBaseline" => (Some(invalidate_provider_context_baseline()), Value::Null),
            "baseline" => {
                let tools = tools_of(&args["tools"]);
                let patch = record_provider_context_baseline(
                    &header,
                    &messages,
                    &args["usage"],
                    &signer,
                    &BaselineArgs {
                        boundary: args.get("boundary").and_then(Value::as_str).unwrap_or("complete"),
                        send_tools: &tools,
                        input_excludes_cache: args["excludesCache"].as_bool().expect("excludesCache"),
                        token_calibration: args["calibration"].as_f64().expect("calibration"),
                        now,
                    },
                );
                let result = Value::Bool(patch.is_some());
                (patch, result)
            }
            "restore" => {
                let restored = restore_turn_checkpoint_context_state(&header, &messages, &args["checkpoint"], &signer, now);
                (Some(restored.patch), Value::Bool(restored.anchored))
            }
            other => panic!("unknown op {other}"),
        };

        let mut after = header.clone();
        if let Some(patch) = &patch {
            patch.apply(&mut after);
        }
        assert_eq!(Value::Object(after), case["after"], "{name}: header after");
        assert_eq!(result, case["result"], "{name}: result");
    }
}

#[test]
fn the_two_invalidations_clear_what_a_route_change_makes_stale() {
    let mut header = header_of(&serde_json::json!({ "contextUsageSnapshot": { "usedTokens": 1 }, "contextPressureBaselineTokens": 5, "contextPressureUnanchoredAfterRestart": true }));
    invalidate_context_usage_snapshot().apply(&mut header);
    invalidate_provider_context_baseline().apply(&mut header);
    assert!(!header.contains_key("contextUsageSnapshot"));
    assert!(!header.contains_key("contextPressureUnanchoredAfterRestart"));
    assert_eq!(header["contextPressureBaselineTokens"], Value::Null);
    assert_eq!(header["lastContextTokensStaleAfterCompact"], Value::Bool(true));
}
