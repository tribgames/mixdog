//! Public xAI Responses socket. Grok OAuth uses its own HTTP-only proxy adapter.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::{
    DeliveryState, ErrorKind, ErrorResponse, Exposure, ModelRequest, ModelStream, ProviderError, SendIdentity, StreamEvent, TransportFault, WireCodec, WsPhase,
};
use serde_json::{Map, Value};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};

use super::adapter::CompatAdapter;
use super::profile::Wire;
use super::responses::CompatResponsesCodec;
use crate::providers::openai::adapter::{ResponsesStream, WS_STREAM_LABEL, WsTimers, expired};
use crate::providers::openai::decoder::ResponsesDecoder;
use crate::providers::openai::delta;
use crate::providers::openai::pool::{Checkout, Compat, WsPool};
use crate::providers::openai::transport_policy::{self, Mode};
use crate::registry::keys::Environment;
use crate::transport::WsDial;
use crate::transport::link::Surface;
use crate::transport::model_driver::ModelCall;
use crate::transport::ws::{CallerHeaders, ConnectError, Message};

pub(super) fn api_wire(value: &str) -> Wire {
    match value.trim().to_ascii_lowercase().as_str() {
        "0" | "false" | "off" | "chat" | "chat-completions" | "chat_completions" => Wire::Chat,
        _ => Wire::Responses,
    }
}

pub(crate) fn request_wire(value: Option<&str>, default: Wire) -> Wire {
    value.map_or(default, api_wire)
}

#[derive(Clone)]
pub(crate) struct XaiSocket(Arc<Shared>);

struct Shared {
    codec: CompatResponsesCodec,
    dial: Arc<dyn WsDial>,
    configured: Option<String>,
    env: Arc<dyn Environment>,
    pool: Arc<WsPool>,
    timers: WsTimers,
}

impl XaiSocket {
    pub fn new(http: &CompatResponsesCodec, dial: Arc<dyn WsDial>, configured: Option<String>, env: Arc<dyn Environment>) -> Self {
        let timers = WsTimers::read(&|name| env.var(name));
        Self(Arc::new(Shared { codec: http.xai_websocket(), dial, configured, env, pool: Arc::default(), timers }))
    }

    pub fn release_session(&self, session_id: &str) {
        self.0.pool.release_session(session_id);
    }

    pub fn release_unloaded_session(&self, session_id: &str) {
        self.0.pool.release_unloaded(session_id);
    }

    /// `None` selects HTTP, `Some` opts into a socket and says whether it may fall back to HTTP.
    pub fn selection(&self, explicit: Option<&str>) -> Option<bool> {
        let raw = explicit
            .map(str::to_owned)
            .or_else(|| self.0.configured.clone())
            .or_else(|| self.0.env.var("MIXDOG_XAI_RESPONSES_TRANSPORT"))
            .or_else(|| self.0.env.var("MIXDOG_XAI_TRANSPORT"));
        let shared = self.0.env.var("MIXDOG_OAI_TRANSPORT");
        let fallback = self.0.env.var("MIXDOG_XAI_WS_HTTP_FALLBACK");
        select(raw.as_deref(), shared.as_deref(), fallback.as_deref())
    }

    /// The xAI capability of the shared transport policy carries delta frames (`RESPONSES_TRANSPORT_CAPABILITIES.xai`).
    fn delta(&self) -> bool {
        transport_policy::resolve_openai(self.0.env.var("MIXDOG_OAI_TRANSPORT").as_deref()).delta.opt_in
    }

    pub async fn open(&self, account: &CompatAdapter, request: &ModelRequest) -> Result<Box<dyn ModelStream>, ProviderError> {
        let wire = self.0.codec.encode(request)?;
        let key = account.gateway_key().await?.filter(|key| !key.is_empty()).ok_or_else(|| {
            let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
            error.message = "xAI API key not configured".into();
            error
        })?;
        let mut body: Map<String, Value> = serde_json::from_slice(&wire.body).expect("encoded Responses JSON");
        // The frame's type is the socket's: the chain compares the request without it, and every frame puts it back first.
        body.shift_remove("type");
        let lane = body.get("prompt_cache_key").and_then(Value::as_str).unwrap_or_default();
        let compat = Compat::new("xai", &key, lane);
        let scope = request.options.transport_scope.as_ref().or(request.options.session_id.as_ref()).filter(|scope| !scope.is_empty());
        let (scope, shared) = scope.map_or_else(|| (format!("\0shared:{}:{}", compat.auth, compat.cache_key), true), |scope| (scope.clone(), false));
        let mut headers = wire.headers;
        headers.retain(|(name, _)| !name.eq_ignore_ascii_case("authorization"));
        headers.push(("Authorization".into(), format!("Bearer {key}")));
        let send = SocketSend {
            socket: self.clone(),
            url: wire.url,
            headers,
            scope,
            shared,
            compat,
            identity: request.options.send_identity.clone(),
            delta: self.delta(),
            instructions_with_previous_response: self.0.codec.instructions_with_previous_response(request),
        };
        send.identity.raise_requesting_once();
        let (inner, chained) = send.exchange(body, self.0.codec.responses_decoder(request), false).await?;
        let retry = chained.map(|body| (body, self.0.codec.responses_decoder(request)));
        Ok(Box::new(XaiStream { inner, send, retry }))
    }

    fn call(&self, identity: &SendIdentity) -> ModelCall {
        ModelCall::new(
            identity,
            self.0.timers.windows(),
            Arc::new(|expiry, delivery, exposure| expired(WS_STREAM_LABEL, Surface::SocketLabeled("xAI WS initial response"), expiry, delivery, exposure)),
        )
    }

    async fn connect(&self, url: &str, headers: Vec<(String, String)>) -> Result<Box<dyn crate::transport::WsSocket>, ProviderError> {
        let invalid = |_| ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
        let mut handshake = url.into_client_request().map_err(invalid)?;
        for (name, value) in &headers {
            handshake.headers_mut().append(
                HeaderName::from_bytes(name.as_bytes()).map_err(|_| ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent))?,
                HeaderValue::from_str(value).map_err(|_| ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent))?,
            );
        }
        handshake.extensions_mut().insert(CallerHeaders(headers));
        match mixdog_rt::time::timeout(Duration::from_secs(30), self.0.dial.dial(handshake)).await {
            Ok(Ok((socket, _))) => Ok(socket),
            Ok(Err(err)) => Err(self.handshake_error(err)),
            Err(_) => {
                let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                error.ws_phase = Some(WsPhase::Handshake);
                error.timed_out = true;
                error.message = "xAI WebSocket handshake timed out".into();
                Err(error)
            }
        }
    }

    fn handshake_error(&self, failure: ConnectError) -> ProviderError {
        let mut error = match failure {
            ConnectError::Transport(fault) => ProviderError::transport(fault, DeliveryState::NotSent),
            ConnectError::Proxy { code, message } => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.code = Some(code);
                error.message = message;
                error
            }
            ConnectError::Rejected(response) => {
                let (head, body) = response.into_parts();
                let headers = head.headers.iter().filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))).collect();
                self.0.codec.classify(&ErrorResponse { status: Some(head.status.as_u16()), headers, body: body.unwrap_or_default() })
            }
        };
        error.ws_phase = Some(WsPhase::Handshake);
        error
    }
}

fn select(raw: Option<&str>, shared: Option<&str>, fallback: Option<&str>) -> Option<bool> {
    let raw = raw?.trim().to_ascii_lowercase();
    if matches!(raw.as_str(), "" | "0" | "false" | "off" | "http" | "https" | "responses-http" | "sdk") {
        return None;
    }
    let policy = transport_policy::resolve_openai(shared);
    (policy.mode != Mode::HttpSse).then(|| {
        policy.allow_http_fallback && !fallback.is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "off" | "no"))
    })
}

pub(crate) fn can_fallback(error: &ProviderError) -> bool {
    if error.kind.is_quota() || matches!(error.kind, ErrorKind::Auth | ErrorKind::Permission | ErrorKind::RateLimited) {
        return false;
    }
    match error.status {
        Some(426 | 408 | 409 | 425) => true,
        Some(525 | 526) => false,
        Some(500..=599) => !error.kind.is_deterministic(),
        Some(_) => false,
        None => match error.transport.as_ref() {
            Some(TransportFault::WsClose { code: Some(code) }) => matches!(*code, 1000 | 1001 | 1005 | 1006 | 1009 | 1011 | 1012),
            Some(_) => true,
            None => error.timed_out || error.code.as_deref() == Some("websocket_connection_limit_reached"),
        },
    }
}

/// One send's requests on the session's socket: the request it was encoded as, and where it goes.
struct SocketSend {
    socket: XaiSocket,
    url: String,
    headers: Vec<(String, String)>,
    scope: String,
    shared: bool,
    compat: Compat,
    identity: SendIdentity,
    delta: bool,
    instructions_with_previous_response: bool,
}

impl SocketSend {
    /// One request frame on the session's socket and the stream of its response, under the socket stream's windows. `Some` is
    /// the request again when the frame was a delta, for the full resend a refused chain gets.
    async fn exchange(
        &self,
        body: Map<String, Value>,
        decoder: ResponsesDecoder,
        fresh: bool,
    ) -> Result<(ResponsesStream, Option<Map<String, Value>>), ProviderError> {
        let attempt = self.socket.call(&self.identity).begin();
        let (checkout, chained) = match attempt.bound(self.submit(&body, fresh)).await {
            Ok(Ok(sent)) => sent,
            Ok(Err(error)) => {
                attempt.fail();
                return Err(error);
            }
            Err(expiry) => return Err(attempt.error(expiry, DeliveryState::Ambiguous, Exposure::default())),
        };
        self.identity.raise_stage("transport");
        attempt.head_received();
        let kept = chained.then(|| body.clone());
        let mut stream = ResponsesStream::socket(checkout, decoder, self.identity.clone(), attempt, body);
        stream.prime().await;
        Ok((stream, kept))
    }

    /// The acquire and the request frame: the delta against the socket's last response when the request extends it, else the
    /// whole request. `true` when the frame was a delta.
    async fn submit(&self, body: &Map<String, Value>, fresh: bool) -> Result<(Checkout, bool), ProviderError> {
        let mut checkout = self.socket.0.pool.checkout(&self.scope, &self.compat, self.shared, fresh).await;
        if checkout.socket.is_none() {
            let socket = self.socket.connect(&self.url, self.headers.clone()).await?;
            if !checkout.attach(socket) {
                let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                error.unsafe_to_retry = true;
                error.message = "xAI WebSocket session closed before sending".into();
                return Err(error);
            }
        }
        let framed = delta::compute_with(self.delta, self.instructions_with_previous_response, &checkout.chain, body);
        let frame = serde_json::to_string(&Value::Object(framed.frame)).expect("a JSON object serializes");
        if let Err(fault) = checkout.socket.as_ref().expect("socket attached").send(Message::text(frame)).await {
            let mut error = ProviderError::transport(fault, DeliveryState::Ambiguous);
            error.ws_phase = Some(WsPhase::Stream);
            return Err(error);
        }
        Ok((checkout, framed.mode == delta::Mode::Delta))
    }
}

/// The response of one send. A delta whose chain the server no longer holds is sent once more in full, on a fresh socket,
/// while nothing of the response was shown.
struct XaiStream {
    inner: ResponsesStream,
    send: SocketSend,
    retry: Option<(Map<String, Value>, ResponsesDecoder)>,
}

#[async_trait]
impl ModelStream for XaiStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            let event = self.inner.next().await;
            match &event {
                Some(Ok(shown)) if crate::providers::idle::output(shown) => self.retry = None,
                Some(Err(error)) if delta::chain_refused(error) && !error.unsafe_to_retry && error.exposure == Exposure::default() => {
                    if let Some((body, decoder)) = self.retry.take() {
                        match self.send.exchange(body, decoder, true).await {
                            Ok((inner, _)) => self.inner = inner,
                            Err(error) => return Some(Err(error)),
                        }
                        continue;
                    }
                }
                _ => {}
            }
            return event;
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    /// A leaf: `next` awaits nothing after the wire's terminal event.
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_xai_explicit_options_preserve_http_default_and_allow_only_selected_fallback() {
        assert_eq!(request_wire(None, Wire::Chat), Wire::Chat);
        assert_eq!(request_wire(Some("responses"), Wire::Chat), Wire::Responses);
        assert_eq!(request_wire(Some("chat-completions"), Wire::Responses), Wire::Chat);
        assert_eq!(select(None, None, None), None);
        assert_eq!(select(Some("https"), None, None), None);
        assert_eq!(select(Some("websocket"), Some("http-sse"), None), None);
        assert_eq!(select(Some("websocket"), None, None), Some(true));
        assert_eq!(select(Some("websocket"), Some("ws-full"), None), Some(false));
        assert_eq!(select(Some("websocket"), None, Some("0")), Some(false));
    }

    use super::super::chat::{CompatChatCodec, CompatConfig};
    use super::super::profile::CompatProfile;
    use crate::providers::openai::scripted::{Dialed, ScriptedDial, Wire as Seen};
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::{Content, Message as Turn, RequestOptions, Role, ToolCall, ToolDefinition, WireRequest};
    use serde_json::json;

    struct Key;

    #[async_trait]
    impl crate::providers::key_source::ApiKeySource for Key {
        async fn key(&self) -> Result<String, ProviderError> {
            Ok("fixture-key".into())
        }
        async fn reload(&self) -> Result<String, ProviderError> {
            self.key().await
        }
    }

    struct NoHttp;

    #[async_trait]
    impl crate::transport::HttpSend for NoHttp {
        async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<crate::transport::HttpResponse, ProviderError> {
            unreachable!("the socket carries every request")
        }
    }

    struct NoEnv;

    impl Environment for NoEnv {
        fn var(&self, _: &str) -> Option<String> {
            None
        }
    }

    fn rig(script: Vec<Dialed>) -> (Arc<ScriptedDial>, XaiSocket, CompatAdapter) {
        let profile = CompatProfile::xai();
        let config = CompatConfig::for_profile(&profile);
        let account = CompatAdapter::new(CompatChatCodec::new(profile.clone(), config.clone()), Arc::new(NoHttp), Some(Arc::new(Key)));
        let dial = ScriptedDial::with(script);
        let socket = XaiSocket::new(&CompatResponsesCodec::new(profile, config, TransportKind::Http1), dial.clone(), Some("websocket".into()), Arc::new(NoEnv));
        (dial, socket, account)
    }

    /// Step 1 asks, under `system` when there is one; step 2 carries step 1's tool call and its result.
    fn steps(system: Option<&str>) -> (ModelRequest, ModelRequest) {
        let tool = ToolDefinition {
            name: "lookup".into(),
            description: "Read a value".into(),
            input_schema: json!({"type": "object", "properties": {"key": {"type": "string"}}}),
            defer_loading: false,
            freeform: None,
        };
        let first = ModelRequest {
            model: "grok-4.5".into(),
            messages: system
                .map(|text| Turn::new(Role::System, Content::Text(text.to_owned().into())))
                .into_iter()
                .chain([Turn::new(Role::User, Content::Text("Look it up.".into()))])
                .collect(),
            tools: vec![tool],
            options: RequestOptions { session_id: Some("sess".into()), ..RequestOptions::default() },
        };
        let mut second = first.clone();
        let mut call = Turn::new(Role::Assistant, Content::Text(String::new().into()));
        call.tool_calls = vec![ToolCall { id: "call_1".into(), name: "lookup".into(), arguments: json!({"key": "answer"}), native_type: None }];
        let mut result = Turn::new(Role::Tool, Content::Text("42".into()));
        result.tool_call_id = Some("call_1".into());
        second.messages.extend([call, result]);
        (first, second)
    }

    fn calls_lookup() -> Vec<String> {
        let item =
            json!({"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "lookup", "arguments": "{\"key\":\"answer\"}", "status": "completed"});
        vec![
            json!({"type": "response.created", "response": {"id": "resp_1", "model": "grok-4.5"}}).to_string(),
            json!({"type": "response.output_item.done", "output_index": 0, "item": item}).to_string(),
            json!({"type": "response.completed", "response": {"id": "resp_1", "status": "completed", "model": "grok-4.5", "output": [item]}}).to_string(),
        ]
    }

    fn answers() -> Vec<String> {
        let item = json!({"type": "message", "id": "msg_2", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "42"}]});
        vec![
            json!({"type": "response.created", "response": {"id": "resp_2", "model": "grok-4.5"}}).to_string(),
            json!({"type": "response.output_text.delta", "item_id": "msg_2", "output_index": 0, "content_index": 0, "delta": "42"}).to_string(),
            json!({"type": "response.output_item.done", "output_index": 0, "item": item}).to_string(),
            json!({"type": "response.completed", "response": {"id": "resp_2", "status": "completed", "model": "grok-4.5", "output": [item]}}).to_string(),
        ]
    }

    async fn completes(mut stream: Box<dyn ModelStream>) {
        let mut completed = false;
        while let Some(event) = stream.next().await {
            completed |= matches!(event.expect("no failure"), StreamEvent::Completed { .. });
        }
        assert!(completed);
    }

    fn texts(dial: &ScriptedDial) -> Vec<String> {
        dial.wire()
            .into_iter()
            .filter_map(|seen| match seen {
                Seen::Upgrade { .. } => None,
                Seen::Frame(text) => Some(text),
            })
            .collect()
    }

    fn sent(dial: &ScriptedDial) -> Vec<Option<Value>> {
        dial.wire()
            .into_iter()
            .map(|seen| match seen {
                Seen::Upgrade { .. } => None,
                Seen::Frame(text) => Some(serde_json::from_str(&text).unwrap()),
            })
            .collect()
    }

    /// The step after tool results goes on the socket that holds step 1's response: its frame names that response and carries
    /// only the tool result, and step 1's frame was the whole request.
    #[tokio::test]
    async fn a_step_after_tool_results_sends_the_chain_and_only_the_new_input() {
        let frames = [calls_lookup(), answers()].concat();
        let (dial, socket, account) = rig(vec![Dialed::Socket { frames, close: (1000, String::new()) }]);
        let (first, second) = steps(None);
        completes(socket.open(&account, &first).await.unwrap()).await;
        completes(socket.open(&account, &second).await.unwrap()).await;

        let sent = sent(&dial);
        let [None, Some(full), Some(chained)] = sent.as_slice() else { panic!("one upgrade and two frames: {sent:?}") };
        assert_eq!(full["type"], "response.create");
        assert!(full.get("previous_response_id").is_none());
        assert_eq!(full["input"].as_array().unwrap().len(), 1);
        assert_eq!(chained["type"], "response.create");
        assert_eq!(chained["previous_response_id"], "resp_1");
        let input = chained["input"].as_array().unwrap();
        assert_eq!(input.len(), 1, "{input:?}");
        assert_eq!((&input[0]["type"], &input[0]["call_id"]), (&json!("function_call_output"), &json!("call_1")));
    }

    /// The server no longer holds step 1's response: the chained frame is refused, and the step goes again once, in full, on a
    /// fresh socket.
    #[tokio::test]
    async fn a_refused_chain_is_sent_again_in_full_once() {
        let refusal = json!({"type": "error", "error": {"type": "invalid_request_error", "code": "previous_response_not_found", "message": "Previous response not found."}});
        let (dial, socket, account) = rig(vec![
            Dialed::Socket { frames: [calls_lookup(), vec![refusal.to_string()]].concat(), close: (1000, String::new()) },
            Dialed::Socket { frames: answers(), close: (1000, String::new()) },
        ]);
        let (first, second) = steps(None);
        completes(socket.open(&account, &first).await.unwrap()).await;
        completes(socket.open(&account, &second).await.unwrap()).await;

        let sent = sent(&dial);
        let [None, Some(_), Some(chained), None, Some(resent)] = sent.as_slice() else { panic!("a second upgrade for the resend: {sent:?}") };
        assert_eq!(chained["previous_response_id"], "resp_1");
        assert!(resent.get("previous_response_id").is_none());
        assert_eq!(resent["input"].as_array().unwrap().len(), 3);
    }

    /// xAI's profile refuses `instructions` beside `previous_response_id`, and the stored response does not hold them: a step
    /// under a system prompt goes in full, its frame naming no response and carrying the instructions and the whole input.
    #[tokio::test]
    async fn a_step_under_instructions_goes_in_full_as_the_profile_refuses_them_beside_the_chain() {
        let frames = [calls_lookup(), answers()].concat();
        let (dial, socket, account) = rig(vec![Dialed::Socket { frames, close: (1000, String::new()) }]);
        let (first, second) = steps(Some("You are a fixture assistant."));
        assert!(!socket.0.codec.instructions_with_previous_response(&second));
        completes(socket.open(&account, &first).await.unwrap()).await;
        completes(socket.open(&account, &second).await.unwrap()).await;

        let [_, step2] = texts(&dial).try_into().expect("two frames on one socket");
        assert!(step2.starts_with(r#"{"type":"response.create","#), "{step2}");
        assert!(!step2.contains("previous_response_id"), "{step2}");
        assert!(step2.contains(r#""instructions":"You are a fixture assistant.""#), "{step2}");
        let input = serde_json::from_str::<Value>(&step2).unwrap()["input"].as_array().unwrap().len();
        assert_eq!(input, 3, "the user turn, the call and its result");
    }
}
