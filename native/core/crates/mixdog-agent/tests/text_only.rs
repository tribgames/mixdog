//! The text-only input check against the goldens recorded from Node's
//! `assertLocalModelInput` (`fixtures/agent/record-text-only.mjs`).
//! Fixture loading reads files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]

use async_trait::async_trait;
use mixdog_agent::text_only::MediaText;
use mixdog_agent::text_only::TextOnlyModel;
use mixdog_agent::text_only::assert_text_only_input;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::JsonValue;
use serde_json::json;

/// The media layer's file text forms the cases exercise: text files decoded,
/// any other payload described, a gone reference its placeholder.
struct Media;

fn label(filename: Option<&str>, mime: &str, bytes: usize) -> String {
    format!("{}({mime}, {bytes} bytes)", filename.map(|f| format!("{f} ")).unwrap_or_default())
}

#[async_trait]
impl MediaText for Media {
    async fn prepare_pdf_text(&self, messages: Vec<Message>) -> Result<Vec<Message>, Box<ProviderError>> {
        Ok(messages)
    }

    fn text_form(&self, part: &ContentPart) -> Result<Option<String>, Box<ProviderError>> {
        use base64::Engine as _;
        let ContentPart::File { source, mime_type, filename, .. } = part else {
            return Ok(None);
        };
        let BinarySource::Base64(data) = source else {
            let name = filename.as_deref().unwrap_or("").rsplit(['/', '\\']).next().unwrap_or("");
            return Ok(Some(format!("[attachment unavailable: {}]", if name.is_empty() { mime_type } else { name })));
        };
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
        let label = label(filename.as_deref(), mime_type, bytes.len());
        Ok(Some(if mime_type.starts_with("text/") {
            format!("--- {label} ---\n{}", String::from_utf8(bytes).unwrap())
        } else {
            format!("[file not sent inline: {label} — this type has no inline form; open it from disk with read]")
        }))
    }
}

fn part_from_json(part: &JsonValue) -> ContentPart {
    let str_of = |key: &str| part.get(key).and_then(JsonValue::as_str).map(str::to_owned);
    match part["type"].as_str().unwrap() {
        "text" => ContentPart::Text(str_of("text").unwrap(), false),
        "image" => ContentPart::Image(ImageSource::Base64 {
            data: str_of("data").unwrap(),
            mime_type: str_of("mimeType").unwrap(),
        }),
        "file" => ContentPart::File {
            source: match str_of("data") {
                Some(data) => BinarySource::Base64(data),
                None => BinarySource::AttachmentRef(str_of("attachmentRef").unwrap()),
            },
            mime_type: str_of("mimeType").unwrap(),
            filename: str_of("filename"),
            text: None,
        },
        "document" => ContentPart::Document {
            source: DocumentSource::Text { media_type: None, data: part["source"]["data"].as_str().unwrap().to_owned() },
            title: str_of("title"),
        },
        other => panic!("part type {other}"),
    }
}

fn message_from_json(message: &JsonValue) -> Message {
    let role = match message["role"].as_str().unwrap() {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("role {other}"),
    };
    let content = match &message["content"] {
        JsonValue::String(text) => Content::Text(text.clone()),
        JsonValue::Array(parts) => Content::Parts(parts.iter().map(part_from_json).collect()),
        other => panic!("content {other}"),
    };
    Message::new(role, content)
}

/// Node's message shape for the compared fields.
fn message_to_json(message: &Message) -> JsonValue {
    let role = format!("{:?}", message.role).to_lowercase();
    let content = match &message.content {
        Content::Text(text) => json!(text),
        Content::Parts(parts) => JsonValue::Array(
            parts
                .iter()
                .map(|p| match p {
                    ContentPart::Text(t, _) => json!({"type": "text", "text": t}),
                    ContentPart::Image(_) => json!({"type": "image"}),
                    ContentPart::File { .. } => json!({"type": "file"}),
                    ContentPart::Document { .. } => json!({"type": "document"}),
                })
                .collect(),
        ),
    };
    json!({"role": role, "content": content})
}

#[test]
fn rust_check_matches_the_recorded_node_results() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/agent/text_only/cases.json");
    let cases: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 19);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let input = &case["input"];
        let model = TextOnlyModel {
            name: input["model"]["name"].as_str().unwrap().to_owned(),
            supports_tools: input["capabilities"]["tools"]
                .as_bool()
                .or_else(|| input["model"]["supportsFunctionCalling"].as_bool()),
        };
        let messages: Vec<Message> = input["messages"].as_array().unwrap().iter().map(message_from_json).collect();
        let tools = !input["tools"].as_array().unwrap().is_empty();
        let effort = input["options"]["effort"].as_str().is_some_and(|e| !e.is_empty());
        let result = assert_text_only_input(&model, &Media, messages, tools, effort);
        match (result, case.get("error")) {
            (Err(error), Some(expected)) => assert_eq!(&JsonValue::from(error.message), expected, "{name}"),
            (Ok(messages), None) => {
                let got: Vec<JsonValue> = messages.iter().map(message_to_json).collect();
                let want: Vec<JsonValue> = case["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| {
                        // Node's tool message also carries its call id.
                        json!({"role": m["role"], "content": normalize(&m["content"])})
                    })
                    .collect();
                assert_eq!(got, want, "{name}");
            }
            (got, want) => panic!("{name}: Rust {got:?} vs Node {want:?}"),
        }
    }
}

/// Parts that stay media (none after a successful check) keep only their type.
fn normalize(content: &JsonValue) -> JsonValue {
    match content {
        JsonValue::Array(parts) => JsonValue::Array(
            parts
                .iter()
                .map(|p| if p["type"] == "text" { json!({"type": "text", "text": p["text"]}) } else { json!({"type": p["type"]}) })
                .collect(),
        ),
        other => other.clone(),
    }
}
