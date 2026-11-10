//! The provider request snapshot behind `tools/toolsStatus` with `snapshot: true`: what a thread's
//! next send puts on the wire before any credential is added, so a benchmark can hash the surface
//! the model reads (the tool catalog and active tools the session holds, the request's system texts and
//! tools, and the body the route's own codec encodes). It replaces the contract digest that
//! `benchmarks/terminal-bench-2.1/analysis/contract-hash.mjs` took from Node's request builders.

use mixdog_core_api::domain::provider::{Content, ContentPart, Message, ModelRequest, ProviderAdapter, Role, ToolDefinition};
use mixdog_store::schema::record::Header;
use serde_json::{json, Map, Value};

fn tool_json(tool: &ToolDefinition) -> Value {
    let mut out = Map::new();
    out.insert("name".into(), Value::String(tool.name.clone()));
    out.insert("description".into(), Value::String(tool.description.clone()));
    out.insert("inputSchema".into(), tool.input_schema.clone());
    if tool.defer_loading {
        out.insert("deferLoading".into(), Value::Bool(true));
    }
    Value::Object(out)
}

fn text_of(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text(text, _) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn docs(header: &Header, key: &str) -> Value {
    Value::Array(header.get(key).and_then(Value::as_array).cloned().unwrap_or_default())
}

/// The snapshot of `request` as `provider`'s codec encodes it, with the session documents of `header`.
/// The headers are the codec's own; the adapter adds the credential header at send time, so none is here.
/// `user_message` is the turn the next send would add (a thread has no user turn before its first send, and a
/// codec such as Gemini's refuses a request with nothing to send; Node's builder throws "No messages to send" there too).
pub fn snapshot(header: &Header, provider: &dyn ProviderAdapter, request: &ModelRequest, user_message: Option<&str>) -> Result<Value, String> {
    let with_message;
    let request = match user_message {
        Some(text) => {
            let mut messages = request.messages.clone();
            messages.push(Message::new(Role::User, Content::Text(text.into())));
            with_message = ModelRequest { messages, ..request.clone() };
            &with_message
        }
        None => request,
    };
    let wire = provider.codec().encode(request).map_err(|error| format!("the {} request could not be encoded: {}", provider.id().as_str(), error.message))?;
    let body = serde_json::from_slice::<Value>(&wire.body).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&wire.body).into_owned()));
    Ok(json!({
        "provider": provider.id().as_str(),
        "model": request.model,
        "providerMode": header.get("deferredProviderMode").cloned().unwrap_or(Value::Null),
        "transport": format!("{:?}", wire.transport),
        "method": wire.method,
        "url": wire.url,
        "headers": wire.headers.iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(),
        "system": request.messages.iter().filter(|message| message.role == Role::System).map(|message| text_of(&message.content)).collect::<Vec<_>>(),
        "tools": request.tools.iter().map(tool_json).collect::<Vec<_>>(),
        "catalog": docs(header, "deferredToolCatalog"),
        "active": docs(header, "tools"),
        "disallowedTools": docs(header, "disallowedTools"),
        "body": body,
    }))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::{ErrorResponse, Message, ProviderError, RequestOptions, WireCodec, WireDecoder, WireRequest};

    use super::*;

    /// A codec whose body is the JSON of the request's model, system texts and tool names.
    struct JsonCodec;

    impl WireCodec for JsonCodec {
        fn transport(&self) -> TransportKind {
            TransportKind::Http1
        }
        fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
            let body = json!({
                "model": request.model,
                "instructions": request.messages.iter().filter(|m| m.role == Role::System).map(|m| text_of(&m.content)).collect::<Vec<_>>(),
                "tools": request.tools.iter().map(|t| json!({"type": "function", "name": t.name, "parameters": t.input_schema})).collect::<Vec<_>>(),
                "input": request.messages.iter().filter(|m| m.role != Role::System).map(|m| text_of(&m.content)).collect::<Vec<_>>(),
            });
            Ok(WireRequest { transport: TransportKind::Http1, method: "POST".into(), url: "https://example.invalid/v1/responses".into(), headers: vec![("authorization".into(), "never shown".into())], body: serde_json::to_vec(&body).unwrap() })
        }
        fn decoder(&self, _: &ModelRequest) -> Box<dyn WireDecoder> {
            unreachable!("a snapshot decodes nothing")
        }
        fn classify(&self, _: &ErrorResponse) -> ProviderError {
            unreachable!("a snapshot sends nothing")
        }
    }

    /// The mock provider with this codec: the adapter of the test.
    struct Adapter(JsonCodec, mixdog_protocol::ProviderId, mixdog_core_api::domain::retry::RetryPolicy, mixdog_core_api::domain::keepalive::KeepaliveSchedule);

    #[async_trait::async_trait]
    impl ProviderAdapter for Adapter {
        fn id(&self) -> &mixdog_protocol::ProviderId {
            &self.1
        }
        fn codec(&self) -> &dyn WireCodec {
            &self.0
        }
        fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
            &self.2
        }
        fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
            &self.3
        }
        async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn mixdog_core_api::domain::provider::ModelStream>, ProviderError> {
            unreachable!("a snapshot sends nothing")
        }
    }

    fn adapter() -> Adapter {
        let mock = mixdog_core_api::domain::mock::MockProvider::new([]);
        Adapter(JsonCodec, mixdog_protocol::ProviderId::from("openai-oauth"), mock.retry_policy().clone(), mock.keepalive().clone())
    }

    #[test]
    fn the_snapshot_holds_the_requests_wire_body_its_tools_and_the_sessions_documents() {
        let header = json!({
            "deferredProviderMode": "native",
            "deferredToolCatalog": [{ "name": "read" }, { "name": "grep" }],
            "tools": [{ "name": "read" }],
            "disallowedTools": ["memory", "recall"],
        })
        .as_object()
        .unwrap()
        .clone();
        let schema = json!({ "type": "object", "properties": { "path": { "type": "string" } } });
        let mut read = ToolDefinition { name: "read".into(), description: "Read a file".into(), input_schema: schema.clone(), defer_loading: false, freeform: None };
        read.defer_loading = true;
        let request = ModelRequest {
            model: "gpt-5.6-sol".into(),
            messages: vec![Message::new(Role::System, Content::Text("rules".into())), Message::new(Role::System, Content::Text("env".into())), Message::new(Role::User, Content::Text("hi".into()))],
            tools: vec![read],
            options: RequestOptions::default(),
        };
        let got = snapshot(&header, &adapter(), &request, None).unwrap();
        assert_eq!(got["provider"], "openai-oauth");
        assert_eq!(got["model"], "gpt-5.6-sol");
        assert_eq!(got["providerMode"], "native");
        assert_eq!(got["transport"], "Http1");
        assert_eq!(got["system"], json!(["rules", "env"]), "the user's message is not part of the surface");
        assert_eq!(got["tools"], json!([{ "name": "read", "description": "Read a file", "inputSchema": schema, "deferLoading": true }]));
        assert_eq!(got["catalog"], json!([{ "name": "read" }, { "name": "grep" }]));
        assert_eq!(got["active"], json!([{ "name": "read" }]));
        assert_eq!(got["disallowedTools"], json!(["memory", "recall"]));
        assert_eq!(got["body"]["instructions"], json!(["rules", "env"]));
        assert_eq!(got["body"]["tools"][0]["parameters"], schema);
        assert_eq!(got["headers"], json!([["authorization", "never shown"]]), "the codec's headers are listed as encoded");
    }

    #[test]
    fn a_user_message_is_the_last_turn_of_the_snapshot_and_none_adds_nothing() {
        let bare = ModelRequest { model: "m".into(), messages: vec![Message::new(Role::System, Content::Text("rules".into()))], tools: Vec::new(), options: RequestOptions::default() };
        assert_eq!(snapshot(&Header::new(), &adapter(), &bare, None).unwrap()["body"]["input"], json!([]));
        assert_eq!(snapshot(&Header::new(), &adapter(), &bare, Some("hi")).unwrap()["body"]["input"], json!(["hi"]));
    }

    #[test]
    fn a_session_without_deferred_documents_snapshots_empty_lists() {
        let request = ModelRequest { model: "m".into(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() };
        let got = snapshot(&Header::new(), &adapter(), &request, None).unwrap();
        assert_eq!(got["catalog"], json!([]));
        assert_eq!(got["active"], json!([]));
        assert_eq!(got["disallowedTools"], json!([]));
        assert_eq!(got["providerMode"], Value::Null);
    }
}
