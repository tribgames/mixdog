//! The attachment, redaction and provider-config behavior against the Node recording
//! (`fixtures/ai-admin/model-proxy-twin.json`, `record-model-proxy.mjs`).
use super::*;
use serde_json::json;

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/ai-admin/model-proxy-twin.json")).unwrap()
}

#[test]
fn attachments_match_node() {
    for (i, case) in twin()["attachmentCases"].as_array().unwrap().iter().enumerate() {
        let input = match case["nest"].as_u64() {
            Some(depth) => (0..depth).fold(json!({ "attachmentRef": "x", "filename": "f.txt" }), |inner, _| json!({ "child": inner })),
            None => case["input"].clone(),
        };
        let got = match without_attachment_references(&input, 0) {
            Ok(mut v) if case["nest"].is_u64() => {
                for _ in 0..case["nest"].as_u64().unwrap() {
                    v = v["child"].clone();
                }
                json!({ "value": v })
            }
            Ok(v) => json!({ "value": v }),
            Err(r) => json!({ "error": r.message, "code": r.code, "status": r.status }),
        };
        let want = match case.get("error") {
            Some(e) => json!({ "error": e, "code": case["code"], "status": case["status"] }),
            None => json!({ "value": case["value"] }),
        };
        assert_eq!(got, want, "attachment case {i}");
    }
}

#[test]
fn provider_config_matches_node() {
    for (i, case) in twin()["providerConfigCases"].as_array().unwrap().iter().enumerate() {
        let allow: Vec<&str> = case["allowList"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let got = public_provider_config(&case["providers"], &|n| allow.contains(&n));
        // The fixture writer sorts object keys, so the order Node saw the overrides in is gone:
        // the hidden ids are compared as a set.
        let sorted = |mut v: Value| {
            for entry in v.as_object_mut().unwrap().values_mut() {
                if let Some(list) = entry.get_mut("hiddenModels").and_then(Value::as_array_mut) {
                    list.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
                }
            }
            v
        };
        assert_eq!(sorted(got), sorted(case["value"].clone()), "provider config case {i}");
    }
}

#[test]
fn quota_usable_matches_node() {
    use super::super::quota_usable::{Measurement, quota_measurement_serves_model};
    for (i, case) in twin()["quotaCases"].as_array().unwrap().iter().enumerate() {
        let reading = (!case["reading"].is_null()).then(|| &case["reading"]);
        let use_credits = case["useCredits"].as_bool().unwrap();
        let measurement = if case["measurementNull"].as_bool().unwrap() { Measurement::None } else { Measurement::Single { use_credits, reading } };
        assert_eq!(quota_measurement_serves_model(&measurement, case["model"].as_str().unwrap(), 0), case["value"].as_bool().unwrap(), "quota case {i}: {case}");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn attachment_inlining_matches_node() {
    use mixdog_core_api::domain::provider::{BinarySource, Content, ContentPart, Message, Role};

    use super::super::model_proxy_inline::{AttachmentReader, ReadError, inline_attachments};

    /// Blobs named `<message>.<part>` hold `size` bytes; a missing one is permanently unreadable.
    struct Store(Vec<(String, usize, bool)>);
    #[async_trait::async_trait]
    impl AttachmentReader for Store {
        async fn read(&self, reference: &str) -> Result<Vec<u8>, ReadError> {
            let (_, size, missing) = self.0.iter().find(|(r, _, _)| r == reference).unwrap();
            if *missing { Err(ReadError::Permanent) } else { Ok(vec![7; *size]) }
        }
    }

    for (i, case) in twin()["inlineCases"].as_array().unwrap().iter().enumerate() {
        let mut blobs = Vec::new();
        let mut messages: Vec<Message> = Vec::new();
        for (m, parts) in case["shape"].as_array().unwrap().iter().enumerate() {
            let parts = parts
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(k, p)| {
                    let reference = format!("{m}.{k}");
                    blobs.push((reference.clone(), p["size"].as_u64().unwrap() as usize, p["missing"].as_bool().unwrap()));
                    ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type: "application/pdf".into(), filename: Some("a.pdf".into()), text: None }
                })
                .collect();
            messages.push(Message::new(Role::User, Content::Parts(parts)));
        }
        inline_attachments(&mut messages, &Store(blobs), case["maxBytes"].as_u64().unwrap() as usize).await.unwrap();
        let got: Vec<Vec<Option<usize>>> = messages
            .iter()
            .map(|m| match &m.content {
                Content::Parts(parts) => parts
                    .iter()
                    .map(|p| match p {
                        ContentPart::File { source: BinarySource::Base64(data), .. } => {
                            Some(base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data).unwrap().len())
                        }
                        _ => None,
                    })
                    .collect(),
                _ => unreachable!(),
            })
            .collect();
        let want: Vec<Vec<Option<usize>>> =
            case["bytes"].as_array().unwrap().iter().map(|m| m.as_array().unwrap().iter().map(|b| b.as_u64().map(|n| n as usize)).collect()).collect();
        assert_eq!(got, want, "inline case {i}");
    }
}

#[test]
fn credential_text_is_redacted() {
    assert_eq!(redacted_text("failed with Bearer abcdefghijkl", 100), "failed with [redacted]");
    assert_eq!(redacted_text("key sk-DUMMY-abcdefghijklmnop1234 x", 100), "key [redacted] x");
    assert_eq!(redacted_text("abcdef", 3), "abc");
}
