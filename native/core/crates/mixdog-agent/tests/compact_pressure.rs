//! The context-pressure state equals Node's: the usage snapshot, the provider baseline, their
//! invalidations and the checkpoint restore, each as the header after the call.

mod compact_support;

use std::collections::HashMap;

use compact_support::node_message;
use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::tool_schema::RequestTools;
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
use mixdog_agent::compact::pressure::AttachmentBytes;
use mixdog_agent::compact::pressure::BlobError;
use mixdog_agent::compact::pressure::restore_turn_checkpoint_context_state_rows;
use mixdog_agent::compact::pressure::rows_exact_signature;
use mixdog_agent::compact::pressure::rows_shape_signature;
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

/// The store's row of a message: the golden row Node held, found by message id, else the row
/// rebuilt from the message itself.
struct GoldenRows(Vec<Value>);

impl MessageRows for GoldenRows {
    fn row(&self, message: &AgentMessage) -> Value {
        message
            .message_id
            .as_deref()
            .and_then(|id| self.0.iter().find(|row| row["meta"]["transcript"]["messageId"] == id))
            .cloned()
            .unwrap_or_else(|| compact_support::node_row(message))
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
        let stored = GoldenRows(case["messages"].as_array().expect("messages").clone());
        let signer = TranscriptSigner { meter: &meter, images: &images, rows: &stored };
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
                let native = args["native"].as_array().expect("native").clone();
                let patch = record_provider_context_baseline(
                    &header,
                    &messages,
                    &args["usage"],
                    &signer,
                    &BaselineArgs {
                        boundary: args.get("boundary").and_then(Value::as_str).unwrap_or("complete"),
                        send_tools: RequestTools { native: &native, defined: &tools },
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
fn row_signatures_equal_nodes() {
    let golden = golden!("pressure");
    let blobs = GoldenBlobs::new(&golden);
    let sets = golden["rowSigns"].as_array().expect("rowSigns");
    assert!(sets.iter().any(|s| s["name"] == "files"));
    for set in sets {
        let name = set["name"].as_str().expect("name");
        let rows = set["rows"].as_array().expect("rows");
        assert_eq!(rows_exact_signature(&[], &blobs).unwrap(), set["empty"].as_str().expect("empty"), "{name}: empty");
        for count in 1..=rows.len() {
            assert_eq!(rows_exact_signature(&rows[..count], &blobs).unwrap(), set["exact"][count - 1].as_str().expect("exact"), "{name}: exact of {count}");
            assert_eq!(rows_shape_signature(&rows[..count], &blobs).unwrap(), set["shape"][count - 1].as_str().expect("shape"), "{name}: shape of {count}");
        }
    }
}

#[test]
fn row_restores_equal_nodes() {
    let golden = golden!("pressure");
    let now = golden["now"].as_f64().expect("now");
    let blobs = GoldenBlobs::new(&golden);
    let cases = golden["rowRestores"].as_array().expect("rowRestores");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let header = header_of(&case["header"]);
        let rows = case["rows"].as_array().expect("rows");
        let restored = restore_turn_checkpoint_context_state_rows(&header, rows, &case["checkpoint"], &blobs, now).expect("readable rows");
        let mut after = header.clone();
        restored.patch.apply(&mut after);
        assert_eq!(Value::Object(after), case["after"], "{name}: header after");
        assert_eq!(Value::Bool(restored.anchored), case["result"], "{name}: result");
    }
}

#[test]
fn a_transient_read_failure_propagates_and_a_missing_blob_does_not() {
    struct Busy;
    impl AttachmentBytes for Busy {
        type Error = &'static str;
        fn bytes(&self, _: &str) -> Result<Vec<u8>, BlobError<&'static str>> {
            Err(BlobError::Transient("EBUSY"))
        }
        fn office_text(&self, _: &[u8], _: &str) -> Result<Option<String>, &'static str> {
            Ok(None)
        }
    }
    let row = serde_json::json!({ "role": "user", "content": [{ "type": "file", "attachmentRef": "a".repeat(64), "mimeType": "text/plain" }] });
    assert_eq!(rows_exact_signature(&[row], &Busy), Err("EBUSY"));
}

/// The golden store: blobs by reference, and Node's office extraction by bytes and filename.
struct GoldenBlobs {
    blobs: HashMap<String, Vec<u8>>,
    office: Vec<(String, Vec<u8>, Option<String>)>,
}

impl GoldenBlobs {
    fn new(golden: &Value) -> Self {
        use base64::Engine;
        let decode = |v: &Value| base64::engine::general_purpose::STANDARD.decode(v.as_str().expect("base64")).expect("valid base64");
        Self {
            blobs: golden["blobs"].as_object().expect("blobs").iter().map(|(k, v)| (k.clone(), decode(v))).collect(),
            office: golden["office"]
                .as_array()
                .expect("office")
                .iter()
                .map(|o| (o["filename"].as_str().expect("filename").to_owned(), decode(&o["bytes"]), o["text"].as_str().map(str::to_owned)))
                .collect(),
        }
    }
}

impl AttachmentBytes for GoldenBlobs {
    type Error = std::convert::Infallible;
    fn bytes(&self, reference: &str) -> Result<Vec<u8>, BlobError<Self::Error>> {
        self.blobs.get(reference).cloned().ok_or(BlobError::Permanent)
    }
    fn office_text(&self, bytes: &[u8], filename: &str) -> Result<Option<String>, Self::Error> {
        Ok(self.office.iter().find(|(f, b, _)| f == filename && b == bytes).expect("recorded office file").2.clone())
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
