//! The context-pressure state: the cached prompt's one scale in the live reading and the next turn's pressure, a transient blob
//! read failure propagating, and what the two invalidations clear after a route change.

use crate::compact_support;

use std::collections::HashMap;

use compact_support::replay_owner;
use mixdog_agent::compact::estimate::MediaMeter;
use mixdog_agent::compact::estimate::MessageMeter;
use mixdog_agent::compact::estimate::PartMeter;
use mixdog_agent::compact::execution_tail::MessageRows;
use mixdog_agent::compact::pressure::AttachmentBytes;
use mixdog_agent::compact::pressure::BlobError;
use mixdog_agent::compact::pressure::Header;
use mixdog_agent::compact::pressure::ImageDescriptor;
use mixdog_agent::compact::pressure::ImageIdentities;
use mixdog_agent::compact::pressure::TranscriptSigner;
use mixdog_agent::compact::pressure::invalidate_context_usage_snapshot;
use mixdog_agent::compact::pressure::invalidate_provider_context_baseline;
use mixdog_agent::compact::pressure::rows_exact_signature;
use mixdog_agent::message::AgentMessage;
use mixdog_core_api::domain::provider::ContentPart;
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

impl GoldenImages {}

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

#[test]
fn cached_prompt_has_one_scale_in_live_reading_and_next_turn_pressure() {
    use mixdog_agent::boundary::{CompactPolicy, CompactSettings, ContextReading};
    use mixdog_agent::compact::pressure::{Books, send_pressure, usage_change};
    use mixdog_core_api::domain::provider::Usage;
    use serde_json::json;

    let owner = replay_owner();
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let images = GoldenImages(HashMap::new());
    let stored = GoldenRows(Vec::new());
    let signer = TranscriptSigner { meter: &meter, images: &images, rows: &stored };
    let books = Books { signer: &signer, native: &[], agent_mode: false, env: &compact_support::NoVars };
    let messages = vec![AgentMessage::user("request")];
    let policy = CompactPolicy::resolve(&CompactSettings { auto: true, context_window: Some(500_000), ..Default::default() }).unwrap();
    // The reported session's last prompt: 2 fresh + 405,809 read + 1,943 written.
    for (excludes, input) in [(true, 2), (false, 407_754)] {
        let mut header = header_of(&json!({
            "provider": "anthropic-oauth", "model": "m",
            "contextWindow": 500_000, "compactBoundaryTokens": 500_000
        }));
        let usage = Usage { input_tokens: input, cache_read_tokens: 405_809, cache_write_tokens: 1_943, output_tokens: 1_245, ..Default::default() };
        let mut reading = ContextReading::default();
        reading.measure(&usage, excludes);
        let delta = json!({
            "source": "provider_send", "deltaInput": input, "deltaOutput": 1_245,
            "deltaCachedRead": 405_809, "deltaCacheWrite": 1_943, "deltaPrompt": 407_754
        });
        usage_change(&header, &delta, &messages, &[], Some(&books), excludes, 1.0, 2.0).unwrap().apply(&mut header);
        let mut next = messages.clone();
        next.push(AgentMessage::assistant("answer", Vec::new()));
        let pressure = send_pressure(&header, &next, &[], &books).tokens.unwrap();
        assert_eq!(pressure, 408_999, "prompt plus reply, not cache counted twice");
        assert_eq!(header["lastContextTokens"], json!(407_754));
        assert_eq!(reading.display_before(pressure), 407_754);
        assert!(pressure < policy.trigger_tokens, "the reported 816k must not compact this 408k context");
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

#[test]
fn the_two_invalidations_clear_what_a_route_change_makes_stale() {
    let mut header = header_of(
        &serde_json::json!({ "contextUsageSnapshot": { "usedTokens": 1 }, "contextPressureBaselineTokens": 5, "contextPressureUnanchoredAfterRestart": true }),
    );
    invalidate_context_usage_snapshot().apply(&mut header);
    invalidate_provider_context_baseline().apply(&mut header);
    assert!(!header.contains_key("contextUsageSnapshot"));
    assert!(!header.contains_key("contextPressureUnanchoredAfterRestart"));
    assert_eq!(header["contextPressureBaselineTokens"], Value::Null);
    assert_eq!(header["lastContextTokensStaleAfterCompact"], Value::Bool(true));
}
