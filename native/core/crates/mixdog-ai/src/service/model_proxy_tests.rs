//! The attachment, redaction and provider-config behavior against the Node recording
//! (`fixtures/ai-admin/model-proxy-twin.json`, `record-model-proxy.mjs`).
use super::*;
use serde_json::json;

#[test]
fn credential_text_is_redacted() {
    assert_eq!(redacted_text("failed with Bearer abcdefghijkl", 100), "failed with [redacted]");
    assert_eq!(redacted_text("key sk-DUMMY-abcdefghijklmnop1234 x", 100), "key [redacted] x");
    assert_eq!(redacted_text("abcdef", 3), "abc");
}

#[test]
fn only_credential_shaped_text_is_redacted_and_the_cut_comes_after_the_redaction() {
    for secret in ["sk-abcdefghijkl", "pk-abcdefghijkl", "rk-abcdefghijkl", "xai-abcdefghijkl", "gsk-abcdefghijkl", "sess-abcdefghijkl", "Bearer abcdefgh", "AIzaabcdefghijklmnopqrst"] {
        assert_eq!(redacted_text(&format!("a {secret} b"), 100), "a [redacted] b", "{secret}");
    }
    for plain in ["sk-short", "Bearer abc", "AIzaTooShort", "ask-abcdefghijklmnop", "no secret here"] {
        assert_eq!(redacted_text(plain, 100), plain, "{plain}");
    }
    // The limit counts what is left after the redaction.
    assert_eq!(redacted_text("sk-abcdefghijklmnopqrstuvwx and more", 12), "[redacted] a");
}

fn lowered(value: Value) -> Value {
    without_attachment_references(&value, 0).unwrap()
}

#[test]
fn an_attachment_reference_a_server_sends_is_lowered_to_unavailable_text_and_inline_data_passes_untouched() {
    let unavailable = |label: &str| json!({ "type": "text", "text": format!("[attachment unavailable: {label}]") });
    // The label is the file's own name, without its directories, else the first of its types.
    assert_eq!(lowered(json!({ "attachmentRef": "x", "filename": "C:\\secret\\dir\\report.pdf" })), unavailable("report.pdf"));
    assert_eq!(lowered(json!({ "attachmentRef": "x", "filename": "/etc/passwd" })), unavailable("passwd"));
    assert_eq!(lowered(json!({ "attachmentRef": "x", "mimeType": "image/png", "type": "image" })), unavailable("image/png"));
    assert_eq!(lowered(json!({ "attachmentRef": "x", "mediaType": "application/pdf" })), unavailable("application/pdf"));
    assert_eq!(lowered(json!({ "attachmentRef": "x", "type": "document" })), unavailable("document"));
    assert_eq!(lowered(json!({ "attachmentRef": "x", "filename": "" })), unavailable("file"));
    assert_eq!(lowered(json!({ "attachmentRef": "x" })), unavailable("file"));
    // Control characters cannot forge a line of the text; the label is bounded.
    assert_eq!(lowered(json!({ "attachmentRef": "x", "mimeType": "a\n\r]b" })), unavailable("a_b"));
    assert_eq!(lowered(json!({ "attachmentRef": "x", "mimeType": "m".repeat(500) })), unavailable(&"m".repeat(200)));
    // References are found at any depth; data that is inline stays as it is.
    let input = json!({ "content": [{ "type": "document", "data": "QUJD", "source": { "attachmentRef": "x", "filename": "a.txt" } }, "text", 3, null] });
    assert_eq!(lowered(input), json!({ "content": [{ "type": "document", "data": "QUJD", "source": unavailable("a.txt") }, "text", 3, null] }));
    let inline = json!({ "type": "document", "data": "QUJD", "mediaType": "application/pdf" });
    assert_eq!(lowered(inline.clone()), inline);
}

#[test]
fn a_request_nested_deeper_than_128_levels_is_refused() {
    let nested = |levels: usize| (0..levels).fold(json!({ "attachmentRef": "x", "filename": "f.txt" }), |inner, _| json!({ "child": inner }));
    assert!(without_attachment_references(&nested(128), 0).is_ok());
    let refused = without_attachment_references(&nested(129), 0).unwrap_err();
    assert_eq!((refused.message.as_str(), refused.code, refused.status), ("The model call is nested too deeply.", "MODEL_PROXY_REQUEST_INVALID", 400));
    // The depth counts arrays too, and a scalar past the limit is not a container.
    let deep_array = (0..129).fold(json!([]), |inner, _| json!([inner]));
    assert!(without_attachment_references(&deep_array, 0).is_err());
    assert!(without_attachment_references(&json!("text"), 500).is_ok());
}

fn providers() -> Value {
    json!({
        "openai-oauth": {
            "enabled": true, "apiKey": "sk-leaky-leaky-leaky", "baseURL": "https://private.example", "label": "work", "models": [{ "id": "gpt" }],
            "accounts": [{ "id": "me@example.com" }], "authState": "present",
            "modelProxy": { "inputExcludesCache": true, "nativePdf": false, "consumesReadWindows": true, "takesImages": false,
                "firstResponseBudget": { "transportMs": 1000, "semanticMs": 2000 }, "internal": 1 }
        },
        "anthropic-oauth": { "enabled": true },
        "mine": {
            "type": "custom", "name": " Mine sk-abcdefghijklmnop ", "enabled": false, "authState": "weird", "baseURL": "https://corp.example",
            "models": [{ "id": "a", "hidden": true }, { "id": "b" }, { "id": "z", "hidden": "yes" }],
            "modelOverrides": { "c": { "hidden": true }, "a": { "hidden": true }, "d": { "hidden": false } },
            "modelProxy": { "consumesReadWindows": false, "takesImages": true, "firstResponseBudget": { "transportMs": 1000, "semanticMs": 0 } }
        }
    })
}

#[test]
fn a_server_learns_of_a_provider_only_what_the_public_config_lists() {
    let config = public_provider_config(&providers(), &|name| name != "anthropic-oauth");
    assert_eq!(
        config["openai-oauth"],
        json!({
            "enabled": true, "authState": "present",
            "modelProxy": { "inputExcludesCache": true, "nativePdf": false, "consumesReadWindows": true, "takesImages": false,
                "firstResponseBudget": { "transportMs": 1000, "semanticMs": 2000 } }
        }),
        "no key, base URL, label, model list or account"
    );
    assert!(config.get("anthropic-oauth").is_none(), "a provider the allow-list refuses is not mentioned");
    // A custom provider adds its registered name (redacted) and the ids hidden on this PC, each once; a trait that is
    // not the notable value is left out, and so is an unknown auth state.
    assert_eq!(config["mine"], json!({ "enabled": false, "type": "custom", "name": "Mine [redacted]", "hiddenModels": ["a", "c"], "modelProxy": {} }));
    assert!(!config.to_string().contains("corp.example") && !config.to_string().contains("leaky"));
}

#[test]
fn the_public_config_has_no_provider_for_a_refused_name_and_reads_a_malformed_store_as_empty() {
    assert_eq!(public_provider_config(&providers(), &|_| false), json!({}));
    assert_eq!(public_provider_config(&json!("nope"), &|_| true), json!({}));
    let bare = public_provider_config(&json!({ "x": 5 }), &|_| true);
    assert_eq!(bare["x"], json!({ "enabled": false, "modelProxy": {} }));
}

mod inlining {
    use mixdog_core_api::domain::provider::{BinarySource, Content, ContentPart, Message, Role};

    use super::super::super::model_proxy_inline::{AttachmentReader, ReadError, inline_attachments};

    /// Blobs by reference: their size, or a permanent or transient failure.
    struct Store(Vec<(&'static str, Result<usize, bool>)>);

    #[async_trait::async_trait]
    impl AttachmentReader for Store {
        async fn read(&self, reference: &str) -> Result<Vec<u8>, ReadError> {
            match self.0.iter().find(|(r, _)| *r == reference).unwrap().1 {
                Ok(size) => Ok(vec![7; size]),
                Err(true) => Err(ReadError::Permanent),
                Err(false) => Err(ReadError::Other("store is down".into())),
            }
        }
    }

    fn message(references: &[&str]) -> Message {
        let parts = references
            .iter()
            .map(|r| ContentPart::File { source: BinarySource::AttachmentRef((*r).into()), mime_type: "application/pdf".into(), filename: Some("a.pdf".into()), text: None })
            .collect();
        Message::new(Role::User, Content::Parts(parts))
    }

    fn inlined(messages: &[Message]) -> Vec<Vec<bool>> {
        messages
            .iter()
            .map(|m| match &m.content {
                Content::Parts(parts) => parts.iter().map(|p| matches!(p, ContentPart::File { source: BinarySource::Base64(_), .. })).collect(),
                _ => unreachable!(),
            })
            .collect()
    }

    #[tokio::test]
    async fn newer_attachments_are_inlined_first_within_one_byte_budget_for_the_whole_call() {
        let store = Store(vec![("old", Ok(60)), ("mid", Ok(60)), ("new-a", Ok(30)), ("new-b", Ok(30))]);
        let mut messages = vec![message(&["old"]), message(&["mid"]), message(&["new-a", "new-b"])];
        inline_attachments(&mut messages, &store, 100).await.unwrap();
        // 100 bytes: the newest message's parts (later part first, 30 + 30), then 60 does not fit in the 40 left.
        assert_eq!(inlined(&messages), [vec![false], vec![false], vec![true, true]]);
        // A blob larger than what is left stays a reference but does not stop a smaller older one.
        let store = Store(vec![("big", Ok(90)), ("small", Ok(5)), ("newest", Ok(20))]);
        let mut messages = vec![message(&["small"]), message(&["big"]), message(&["newest"])];
        inline_attachments(&mut messages, &store, 30).await.unwrap();
        assert_eq!(inlined(&messages), [vec![true], vec![false], vec![true]]);
    }

    #[tokio::test]
    async fn an_unreadable_blob_stays_a_reference_and_a_failing_store_fails_the_call() {
        let store = Store(vec![("gone", Err(true)), ("ok", Ok(1))]);
        let mut messages = vec![message(&["gone", "ok"])];
        inline_attachments(&mut messages, &store, 10).await.unwrap();
        assert_eq!(inlined(&messages), [vec![false, true]]);
        let store = Store(vec![("down", Err(false))]);
        let mut messages = vec![message(&["down"])];
        assert_eq!(inline_attachments(&mut messages, &store, 10).await, Err("store is down".to_owned()));
    }
}

#[test]
fn a_quota_reading_serves_a_model_only_on_measured_evidence() {
    use super::super::quota_usable::{Measurement, quota_measurement_serves_model};
    let serves = |reading: Value, use_credits: bool| {
        let reading = (!reading.is_null()).then_some(&reading);
        quota_measurement_serves_model(&Measurement::Single { use_credits, reading }, "gpt-5", 0)
    };
    assert!(quota_measurement_serves_model(&Measurement::None, "gpt-5", 0), "a provider that reports no quota is never exhausted");
    assert!(serves(json!({ "quotaWindows": [{ "label": "5H", "usedPct": 40 }, { "label": "7D", "usedPct": 99.9 }] }), false));
    assert!(!serves(json!({ "quotaWindows": [{ "label": "5H", "usedPct": 40 }, { "label": "7D", "usedPct": 100 }] }), false), "one spent window is spent");
    assert!(!serves(json!({ "quotaWindows": [{ "label": "5H" }] }), false), "a window with no meter is no evidence");
    assert!(!serves(json!({ "quotaWindows": [] }), false));
    assert!(!serves(Value::Null, true), "a failed reading is no evidence");
    // Credits count only for an account that pays with them, and only a positive or unlimited balance.
    let credits = json!({ "quotaWindows": [{ "label": "5H", "usedPct": 100 }], "balance": { "remainingCredits": 3 } });
    assert!(serves(credits.clone(), true));
    assert!(!serves(credits, false));
    assert!(serves(json!({ "balance": { "unlimited": true } }), true));
    assert!(!serves(json!({ "balance": { "remainingUsd": 0 } }), true));
    // A window that names other models does not speak for this one.
    assert!(!serves(json!({ "quotaWindows": [{ "label": "5H", "usedPct": 10, "models": ["claude"] }] }), false));
}


