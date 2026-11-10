//! The Node recordings of `fixtures/provider-wire` (`benchmarks/rust-core/recorders/record-provider-wire.mjs`): each
//! scenario's Node send arguments (`input.json`), the exchange the loopback hub recorded (`exchange.json`) and Node's
//! result (`result.json`), with the reading of Node's transcript messages into the neutral ones.

use std::path::PathBuf;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

pub(crate) struct Recorded {
    pub input: Value,
    pub exchange: Value,
    pub result: Value,
}

impl Recorded {
    /// The POSTs the provider made to `path_part`, in order (token grants and catalog reads excluded by the filter).
    pub fn posts(&self, path_part: &str) -> Vec<&Value> {
        self.exchange["records"]
            .as_array()
            .expect("records")
            .iter()
            .filter(|r| r["method"] == "POST" && r["path"].as_str().is_some_and(|p| p.contains(path_part)))
            .collect()
    }

    pub fn body(&self, path_part: &str) -> String {
        let posts = self.posts(path_part);
        assert_eq!(posts.len(), 1, "one POST to {path_part}");
        posts[0]["bodyText"].as_str().expect("bodyText").to_owned()
    }
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/provider-wire")
}

#[allow(clippy::disallowed_methods, reason = "test-only read of checked-in fixture files")]
pub(crate) fn load(group: &str, scenario: &str) -> Recorded {
    let dir = root().join(group).join(scenario);
    let read = |file: &str| -> Value {
        serde_json::from_slice(&std::fs::read(dir.join(file)).unwrap_or_else(|e| panic!("{group}/{scenario}/{file}: {e}")))
            .expect("json")
    };
    Recorded { input: read("input.json"), exchange: read("exchange.json"), result: read("result.json") }
}

/// The recorded scenario names of `group`, in directory order.
#[allow(clippy::disallowed_methods, reason = "test-only listing of checked-in fixture files")]
pub(crate) fn scenarios(group: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root().join(group))
        .expect("group dir")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Node's provider name of a replay envelope as the Rust owner of the same provider.
fn owner_of(node: &str) -> ProviderId {
    ProviderId::from(match node {
        "antigravity" => "antigravity-oauth",
        other => other,
    })
}

/// A Node transcript message (`{role, content, toolCalls, toolCallId, providerReplay}`) as the neutral message. A Gemini-shaped
/// replay (`items` a parts array, `requestContext.model`) becomes the Google codecs' envelope `{parts, model}`.
pub(crate) fn message(node: &Value) -> Message {
    let role = match node["role"].as_str().expect("role") {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("role {other}"),
    };
    let mut message = Message::new(role, Content::Text(node["content"].as_str().unwrap_or_default().to_owned()));
    message.tool_calls = node["toolCalls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|call| ToolCall {
            id: call["id"].as_str().unwrap_or_default().to_owned(),
            name: call["name"].as_str().unwrap_or_default().to_owned(),
            arguments: call["arguments"].clone(),
            native_type: None,
        })
        .collect();
    message.tool_call_id = node["toolCallId"].as_str().map(str::to_owned);
    if let Some(replay) = node.get("providerReplay") {
        let mut items = json!({ "parts": replay["items"] });
        if let Some(model) = replay.pointer("/requestContext/model") {
            items["model"] = model.clone();
        }
        message.push_replay(ProviderReplay { owner: owner_of(replay["provider"].as_str().expect("provider")), items });
    }
    message
}

/// What a send answered as Node's result reports it: the text, the model that answered and the usage. `promptTokens`
/// is left out: the neutral usage has no such field (the ledger derives the prompt from the counts compared here).
pub(crate) fn node_answer(result: &Value) -> Value {
    let ok = &result["ok"];
    let usage = &ok["usage"];
    json!({
        "content": ok["content"],
        "model": ok["model"],
        "usage": {
            "inputTokens": usage["inputTokens"],
            "outputTokens": usage["outputTokens"],
            "cachedTokens": usage["cachedTokens"],
            "cacheWriteTokens": usage.get("cacheWriteTokens").cloned().unwrap_or(json!(0)),
            "raw": usage["raw"],
        },
    })
}

/// The same of a decoded stream: the folded text (a `FinalContent` replaces it), the model a `ServedModel` names
/// (else `requested`) and the last usage.
pub(crate) fn rust_answer(events: &[StreamEvent], requested: &str) -> Value {
    let mut content = String::new();
    let mut model = requested.to_owned();
    let mut usage = None;
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => content.push_str(text),
            StreamEvent::FinalContent(text) => content = text.clone(),
            StreamEvent::ServedModel(served) => model = served.clone(),
            StreamEvent::Usage(u) => usage = Some(u.clone()),
            _ => {}
        }
    }
    let usage = usage.unwrap_or_default();
    json!({
        "content": content,
        "model": model,
        "usage": {
            "inputTokens": usage.input_tokens,
            "outputTokens": usage.output_tokens,
            "cachedTokens": usage.cache_read_tokens,
            "cacheWriteTokens": usage.cache_write_tokens,
            "raw": usage.raw,
        },
    })
}

pub(crate) fn tools(node: &Value) -> Vec<ToolDefinition> {
    node.as_array()
        .into_iter()
        .flatten()
        .map(|tool| ToolDefinition {
            name: tool["name"].as_str().expect("name").to_owned(),
            description: tool["description"].as_str().unwrap_or_default().to_owned(),
            input_schema: tool["inputSchema"].clone(),
            defer_loading: false,
            freeform: None,
        })
        .collect()
}
