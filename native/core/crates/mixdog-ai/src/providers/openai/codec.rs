//! `WireCodec` for the Responses wire: one codec per route and transport.
//! Pure: credentials, clock and ids come through the config's `WireContext`.

#![allow(clippy::result_large_err, reason = "the frozen provider error type is returned unboxed")]

use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;

use super::body::build_with;
use super::config::CODEX_HTTP_BETA;
use super::config::CODEX_ORIGINATOR;
use super::config::CODEX_WS_BETA;
use super::config::OpenAiConfig;
use super::config::REPLAY_OWNER;
use super::config::Route;
use super::config::Target;
use super::config::request_scope;
use super::effort::EffortProjection;
use super::decoder::Framing;
use super::decoder::ResponsesDecoder;
use super::error::classify_http;

pub struct OpenAiCodec {
    config: OpenAiConfig,
    transport: TransportKind,
}

impl OpenAiCodec {
    /// `transport` is `Http1` (SSE) or `WebSocket`.
    pub fn new(config: OpenAiConfig, transport: TransportKind) -> Self {
        Self { config, transport }
    }

    fn headers(&self, request: &ModelRequest) -> Vec<(String, String)> {
        let ctx = &self.config.context;
        let ws = self.transport == TransportKind::WebSocket;
        let mut headers = Vec::new();
        let mut push = |name: &str, value: String| headers.push((name.to_owned(), value));
        if !ws {
            push("Content-Type", "application/json".into());
            push("Accept", "text/event-stream".into());
        }
        match &self.config.target {
            Target::ApiKey => {
                if ws {
                    push("OpenAI-Beta", CODEX_WS_BETA.into());
                }
                push("x-client-request-id", ctx.request_id());
            }
            Target::Codex(identity) => {
                push(
                    "OpenAI-Beta",
                    if ws { CODEX_WS_BETA } else { CODEX_HTTP_BETA }.into(),
                );
                push("originator", CODEX_ORIGINATOR.into());
                push("x-client-request-id", ctx.request_id());
                push("User-Agent", identity.user_agent.clone());
                push("version", identity.version.clone());
                push("x-codex-beta-features", identity.beta_features.clone());
                if let Some(key) = request.options.prompt_cache_key.as_deref().filter(|k| !k.is_empty()) {
                    if !ws {
                        push("session_id", key.to_owned());
                    }
                    push("session-id", key.to_owned());
                    push("thread-id", key.to_owned());
                }
                if let Some(thread) = &request.options.thread {
                    push(
                        "x-codex-window-id",
                        format!("{}:{}", thread.id, thread.window),
                    );
                    if let Some(turn) = &thread.turn
                        && let Some(scope) = request_scope(request)
                        && let Some(state) = ctx.turn_state(scope, turn.as_str())
                    {
                        push("x-codex-turn-state", state);
                    }
                }
            }
        }
        headers
    }
}

impl WireCodec for OpenAiCodec {
    fn transport(&self) -> TransportKind {
        self.transport
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        self.encode_with(request, None)
    }

    /// Reports no provider-state slot: Node's first-party routes keep none,
    /// and the ordered replay already carries the reasoning forward.
    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        let framing = if self.transport == TransportKind::WebSocket {
            Framing::WebSocket
        } else {
            Framing::Sse
        };
        Box::new(ResponsesDecoder::new(
            framing,
            self.config.context.clone(),
            ProviderId::from(REPLAY_OWNER),
        ))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        classify_http(response, self.config.context.now_unix_ms())
    }
}

impl OpenAiCodec {
    pub fn route(&self) -> Route {
        self.config.route()
    }

    /// [`WireCodec::encode`] with the conversation's mid-turn effort updates.
    pub fn encode_with(
        &self,
        request: &ModelRequest,
        effort: Option<&EffortProjection>,
    ) -> Result<WireRequest, ProviderError> {
        let built = build_with(&self.config, request, effort);
        let ws = self.transport == TransportKind::WebSocket;
        let route = self.config.route();
        let map = if ws {
            // A response.create frame: `type` leads and `stream` does not exist.
            let mut frame = Map::new();
            frame.insert("type".into(), Value::String("response.create".into()));
            frame.extend(built.map.into_iter().filter(|(key, _)| key != "stream"));
            frame
        } else {
            built.map
        };
        let body = serde_json::to_vec(&Value::Object(map))
            .expect("a JSON object with string keys always serializes");
        Ok(WireRequest {
            transport: self.transport,
            method: if ws { "GET" } else { "POST" }.into(),
            url: if ws { route.ws_url() } else { route.http_url() }.into(),
            headers: self.headers(request),
            body,
        })
    }
}
