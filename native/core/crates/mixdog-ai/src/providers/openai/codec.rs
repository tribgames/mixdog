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
use super::client_meta::Metadata;
use super::delta;
use super::config::CODEX_HTTP_BETA;
use super::config::CODEX_ORIGINATOR;
use super::config::CODEX_WS_BETA;
use super::config::CodexIdentity;
use super::config::OpenAiConfig;
use super::config::REPLAY_OWNER;
use super::config::Route;
use super::config::Target;
use super::config::request_scope;
use super::effort::EffortProjection;
use super::decoder::Framing;
use super::decoder::ResponsesDecoder;
use super::error::classify_http;
use crate::providers::leak::ToolNames;
use crate::providers::leak::body_tool_names;

pub struct OpenAiCodec {
    config: OpenAiConfig,
    transport: TransportKind,
}

impl OpenAiCodec {
    /// `transport` is `Http1` (SSE) or `WebSocket`.
    pub fn new(config: OpenAiConfig, transport: TransportKind) -> Self {
        Self { config, transport }
    }

    fn headers(&self, request: &ModelRequest, tier: Option<&str>, body_cache_key: Option<&str>) -> Vec<(String, String)> {
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
                // The handshake lists `originator` first (`openai-ws-pool.mjs:490`), the HTTP request the beta first
                // (`openai-oauth-http-sse.mjs:76`).
                if ws {
                    push("originator", CODEX_ORIGINATOR.into());
                }
                push(
                    "OpenAI-Beta",
                    if ws { CODEX_WS_BETA } else { CODEX_HTTP_BETA }.into(),
                );
                if !ws {
                    push("originator", CODEX_ORIGINATOR.into());
                }
                if !ws {
                    push("x-client-request-id", ctx.request_id());
                }
                push("User-Agent", identity.user_agent.get());
                push("version", identity.version.get());
                push("x-codex-beta-features", identity.beta_features.clone());
                if ws {
                    // The socket opens as a prewarm: one identity block, the
                    // turn's own state travels in each frame's client_metadata.
                    let metadata = Metadata::of(request, &identity.installation_id, ctx.now_unix_ms(), true);
                    for (name, value) in metadata.handshake_headers(&request.model, tier) {
                        push(&name, value);
                    }
                } else {
                    // `_buildOpenAIHttpFallbackHeaders`: the three anchors carry the body's cache key; the thread's
                    // window and metadata ride only the WebSocket.
                    let key = body_cache_key.unwrap_or_default().to_owned();
                    push("session_id", key.clone());
                    push("session-id", key.clone());
                    push("thread-id", key);
                    if let Some(state) = self.turn_state(request) {
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
    fn decoder(&self, request: &ModelRequest) -> Box<dyn WireDecoder> {
        let framing = if self.transport == TransportKind::WebSocket {
            Framing::WebSocket
        } else {
            Framing::Sse
        };
        // `_wsErrLabel(traceProvider)` / `httpLabel(auth)`: the route decides the label, the transport the kind.
        let label = match (self.route(), framing) {
            (Route::ApiKey, Framing::WebSocket) => "OpenAI WS",
            (Route::ApiKey, Framing::Sse) => "OpenAI HTTP fallback",
            (_, Framing::WebSocket) => "OpenAI OAuth WS",
            (_, Framing::Sse) => "OpenAI OAuth HTTP fallback",
        };
        Box::new(
            ResponsesDecoder::new(framing, self.config.context.clone(), ProviderId::from(REPLAY_OWNER))
                .with_label(label)
                .with_known_tools(body_tool_names(self, request, ToolNames::Named)),
        )
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        classify_http(response, self.config.context.now_unix_ms())
    }
}

impl OpenAiCodec {
    pub fn route(&self) -> Route {
        self.config.route()
    }

    /// The client identity of the Codex route.
    pub fn identity(&self) -> Option<&CodexIdentity> {
        match &self.config.target {
            Target::Codex(identity) => Some(identity),
            Target::ApiKey => None,
        }
    }

    /// The same route over another transport (the fallback's HTTP codec).
    pub fn with_transport(&self, transport: TransportKind) -> Self {
        Self { config: self.config.clone(), transport }
    }

    /// The logical turn a socket's frame activates its turn state under (`_withCodexWsClientMetadata`: the v7 form of
    /// the request's turn, or of the session's turn without one), which is not the HTTP request's key (the turn as
    /// given, `openai-oauth-http-sse.mjs:147`). None off the Codex route and for a prewarm frame.
    pub fn ws_turn(&self, request: &ModelRequest) -> Option<String> {
        let Target::Codex(identity) = &self.config.target else {
            return None;
        };
        let metadata = Metadata::of(request, &identity.installation_id, 0, false);
        Some(metadata.turn_id().to_owned()).filter(|turn| !turn.is_empty())
    }

    /// The token the request's turn was issued, if an earlier response of
    /// this turn gave one.
    fn turn_state(&self, request: &ModelRequest) -> Option<String> {
        let turn = request.options.thread.as_ref()?.turn.as_ref()?;
        self.config.context.turn_state(request_scope(request)?, turn.as_str())
    }

    /// The request body a `response.create` frame carries, without `type`:
    /// the transport-only `stream` does not exist on a socket. The second
    /// value is the body's `service_tier`.
    pub fn ws_body(
        &self,
        request: &ModelRequest,
        effort: Option<&EffortProjection>,
    ) -> (Map<String, Value>, Option<&'static str>) {
        let built = build_with(&self.config, request, effort);
        (built.map.into_iter().filter(|(key, _)| key != "stream").collect(), built.service_tier)
    }

    /// `frame` as sent: on the Codex route with the identity block of
    /// [`Metadata`] in its `client_metadata`, and `turn_state`, the token the
    /// socket's activation of the turn returned (`_withCodexWsClientMetadata`).
    pub fn ws_frame(&self, request: &ModelRequest, frame: Map<String, Value>, turn_state: Option<&str>) -> Map<String, Value> {
        let Target::Codex(identity) = &self.config.target else {
            return frame;
        };
        let now = self.config.context.now_unix_ms();
        Metadata::of(request, &identity.installation_id, now, false).frame(frame, now, turn_state)
    }

    /// [`WireCodec::encode`] with the conversation's mid-turn effort updates.
    pub fn encode_with(
        &self,
        request: &ModelRequest,
        effort: Option<&EffortProjection>,
    ) -> Result<WireRequest, ProviderError> {
        let ws = self.transport == TransportKind::WebSocket;
        let route = self.config.route();
        let (map, tier, key) = if ws {
            let (body, tier) = self.ws_body(request, effort);
            // The frame's turn state is decided by the socket that sends it (`open_ws`), which rebuilds the metadata.
            (self.ws_frame(request, delta::response_create(&body, None, None), None), tier, None)
        } else {
            let built = build_with(&self.config, request, effort);
            (built.map, built.service_tier, built.cache_key)
        };
        let body = serde_json::to_vec(&Value::Object(map))
            .expect("a JSON object with string keys always serializes");
        Ok(WireRequest {
            transport: self.transport,
            method: if ws { "GET" } else { "POST" }.into(),
            url: if ws { route.ws_url() } else { route.http_url() }.into(),
            headers: self.headers(request, tier, key.as_deref()),
            body,
        })
    }
}
