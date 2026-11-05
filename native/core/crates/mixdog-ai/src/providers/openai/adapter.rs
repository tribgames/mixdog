//! `ProviderAdapter` of the OpenAI Responses routes (`openai`,
//! `openai-oauth`) over HTTP/SSE or WebSocket. One attempt: encode, add the
//! credential, send, hand back the decoded stream. Retrying is above the
//! adapter. Two repeats happen inside an attempt, both decided from the
//! response head or the first frame, before any output exists:
//!
//! - a 401 asks the credential source to reload or refresh once and replays;
//! - a 400 whose structured `param` points at a mid-conversation effort
//!   update replays once without the updates.
//!
//! The HTTP exchange is the shared [`HttpSend`] seam and the socket is the
//! shared [`WsDial`] seam.

#![allow(clippy::result_large_err, reason = "the frozen provider error type is returned unboxed")]

use std::collections::HashMap;
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::HeaderName;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use super::codec::OpenAiCodec;
use super::config::Route;
use super::config::WireContext;
use super::config::request_scope;
use super::effort::EffortProjection;
use super::effort_retry::without_effort_updates;
use crate::transport::link::BodyStream;
use crate::transport::link::HttpSend;
use crate::transport::link::WsDial;
use crate::transport::link::WsSocket;
use crate::transport::ws::ConnectError;
use crate::transport::ws::Message;

const TURN_STATE_HEADER: &str = "x-codex-turn-state";
/// Turn-state scopes kept; the oldest is dropped beyond this.
const MAX_TURN_STATE_SCOPES: usize = 4096;
/// A failure body is read up to this many bytes for classification.
const ERROR_BODY_LIMIT: usize = 1024 * 1024;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// What one attempt authenticates with.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential {
    /// API key or access token.
    pub bearer: String,
    /// `chatgpt-account-id` of a subscription token.
    pub account_id: Option<String>,
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("bearer", &"[redacted]")
            .field("account_id", &self.account_id)
            .finish()
    }
}

#[async_trait]
pub trait CredentialSource: Send + Sync {
    async fn current(&self) -> Result<Credential, ProviderError>;
    /// The server rejected `rejected` with a 401: reload the key or refresh
    /// the token. `None` when there is nothing newer to try.
    async fn after_rejection(&self, rejected: &Credential) -> Result<Option<Credential>, ProviderError>;
}

// ---------------------------------------------------------------------------
// Per-process request context
// ---------------------------------------------------------------------------

struct TurnState {
    turn: String,
    value: Option<String>,
}

#[derive(Default)]
struct TurnStates {
    by_scope: HashMap<String, TurnState>,
    order: VecDeque<String>,
}

/// The values the codec and decoder read that no request carries: the clock,
/// request ids, and the `x-codex-turn-state` tokens of live turns. One per
/// process; the adapter writes the tokens its responses issue.
#[derive(Default)]
pub struct SessionContext {
    states: Mutex<TurnStates>,
}

impl SessionContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// The first token a turn is issued wins for the whole turn; a new turn
    /// in the same scope replaces the previous one.
    fn capture(&self, scope: &str, turn: &str, token: &str) {
        let mut states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        match states.by_scope.get_mut(scope) {
            Some(state) if state.turn == turn => {
                state.value.get_or_insert_with(|| token.to_owned());
                return;
            }
            Some(state) => {
                *state = TurnState { turn: turn.to_owned(), value: Some(token.to_owned()) };
                return;
            }
            None => {}
        }
        if states.order.len() >= MAX_TURN_STATE_SCOPES
            && let Some(oldest) = states.order.pop_front()
        {
            states.by_scope.remove(&oldest);
        }
        states.order.push_back(scope.to_owned());
        states.by_scope.insert(
            scope.to_owned(),
            TurnState { turn: turn.to_owned(), value: Some(token.to_owned()) },
        );
    }
}

impl WireContext for SessionContext {
    fn request_id(&self) -> String {
        rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn now_unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }

    fn turn_state(&self, scope: &str, turn_id: &str) -> Option<String> {
        let states = self.states.lock().unwrap_or_else(PoisonError::into_inner);
        states
            .by_scope
            .get(scope)
            .filter(|state| state.turn == turn_id)
            .and_then(|state| state.value.clone())
    }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

pub struct OpenAiAdapter {
    id: ProviderId,
    codec: OpenAiCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    dial: Arc<dyn WsDial>,
    credentials: Arc<dyn CredentialSource>,
    context: Arc<SessionContext>,
}

/// The seams and sources an adapter runs on.
pub struct AdapterLinks {
    pub http: Arc<dyn HttpSend>,
    pub dial: Arc<dyn WsDial>,
    pub credentials: Arc<dyn CredentialSource>,
    /// The same context the codec's config was built with.
    pub context: Arc<SessionContext>,
}

impl OpenAiAdapter {
    /// `codec.transport()` (`Http1` or `WebSocket`) selects the wire; moving
    /// between them is a decision above the adapter.
    pub fn new(id: ProviderId, codec: OpenAiCodec, links: AdapterLinks) -> Self {
        Self {
            id,
            codec,
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            http: links.http,
            dial: links.dial,
            credentials: links.credentials,
            context: links.context,
        }
    }

    fn authorize(&self, mut wire: WireRequest, credential: &Credential) -> WireRequest {
        wire.headers
            .insert(0, ("Authorization".into(), format!("Bearer {}", credential.bearer)));
        if self.codec.route() == Route::Codex
            && let Some(account) = &credential.account_id
        {
            let at = wire
                .headers
                .iter()
                .position(|(name, _)| name.eq_ignore_ascii_case("originator"))
                .map_or(wire.headers.len(), |i| i + 1);
            wire.headers.insert(at, ("chatgpt-account-id".into(), account.clone()));
        }
        wire
    }

    /// Keeps the turn's `x-codex-turn-state` token for the turn's next request.
    fn remember_turn_state(&self, request: &ModelRequest, token: Option<&str>) {
        if let (Some(token), Some(scope), Some(turn)) = (
            token.filter(|t| !t.is_empty()),
            request_scope(request),
            request.options.thread.as_ref().and_then(|t| t.turn.as_ref()),
        ) {
            self.context.capture(scope, turn.as_str(), token);
        }
    }

    async fn open_http(&self, request: &ModelRequest, wire: WireRequest) -> Result<Opened, ProviderError> {
        let response = self.http.send(wire).await?;
        if response.is_success() {
            let token = header(&response.headers, TURN_STATE_HEADER).map(str::to_owned);
            self.remember_turn_state(request, token.as_deref());
            return Ok(Opened::Stream(ResponsesStream::new(
                Source::Http(response.body),
                self.codec.decoder(request),
            )));
        }
        Ok(Opened::Rejected(read_failure(response).await?))
    }

    async fn open_ws(&self, request: &ModelRequest, wire: WireRequest) -> Result<Opened, ProviderError> {
        let handshake = ws_request(&wire)?;
        let (socket, upgrade) = match self.dial.dial(handshake).await {
            Ok(connected) => connected,
            Err(ConnectError::Transport(fault)) => {
                return Err(ProviderError::transport(fault, DeliveryState::NotSent));
            }
            Err(ConnectError::Rejected(response)) => {
                let headers = response
                    .headers()
                    .iter()
                    .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
                    .collect();
                return Ok(Opened::Rejected(ErrorResponse {
                    status: Some(response.status().as_u16()),
                    headers,
                    body: response.into_body().unwrap_or_default(),
                }));
            }
        };
        let upgrade_token = upgrade
            .headers()
            .get(TURN_STATE_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        self.remember_turn_state(request, upgrade_token.as_deref());
        let frame = String::from_utf8(wire.body)
            .map_err(|_| ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent))?;
        socket
            .send(Message::text(frame))
            .await
            .map_err(|fault| ProviderError::transport(fault, DeliveryState::Ambiguous))?;
        let mut stream = ResponsesStream::new(
            Source::Ws { socket, pending: None },
            self.codec.decoder(request),
        );
        // The first frame decides whether the server took the request.
        stream.prime().await;
        Ok(Opened::Stream(stream))
    }
}

/// The outcome of opening one exchange.
#[allow(clippy::large_enum_variant, reason = "built once per attempt and matched immediately")]
enum Opened {
    Stream(ResponsesStream),
    /// A non-success response head: a status, headers and body.
    Rejected(ErrorResponse),
}

/// The request's mid-conversation effort updates in the provider's form.
/// `RequestOptions` carries no projection yet (P0-API is adding the domain
/// type); this is the one place that reads it.
fn effort_of(_request: &ModelRequest) -> Option<EffortProjection> {
    None
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

async fn read_failure(response: crate::transport::link::HttpResponse) -> Result<ErrorResponse, ProviderError> {
    let status = response.status;
    let headers = response.headers.clone();
    let mut body = Vec::new();
    let mut stream = response.body;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) if body.len() < ERROR_BODY_LIMIT => body.extend_from_slice(&bytes),
            Ok(_) => {}
            Err(fault) => return Err(ProviderError::transport(fault, DeliveryState::Accepted)),
        }
    }
    Ok(ErrorResponse { status: Some(status), headers, body })
}

fn ws_request(wire: &WireRequest) -> Result<Request, ProviderError> {
    let invalid = |what: &str| {
        let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
        err.message = format!("invalid WebSocket request: {what}");
        err
    };
    let mut request = wire
        .url
        .as_str()
        .into_client_request()
        .map_err(|_| invalid("url"))?;
    for (name, value) in &wire.headers {
        request.headers_mut().append(
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid("header name"))?,
            HeaderValue::from_str(value).map_err(|_| invalid("header value"))?,
        );
    }
    Ok(request)
}

#[async_trait]
impl ProviderAdapter for OpenAiAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        &self.codec
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let mut wire = self.codec.encode_with(&request, effort_of(&request).as_ref())?;
        let mut credential = self.credentials.current().await?;
        let mut refreshed = false;
        let mut stripped = false;
        loop {
            let authorized = self.authorize(wire.clone(), &credential);
            let opened = match self.codec.transport() {
                TransportKind::WebSocket => self.open_ws(&request, authorized).await?,
                _ => self.open_http(&request, authorized).await?,
            };
            let rejected = match opened {
                Opened::Stream(stream) => match stream.first_frame_failure() {
                    Some(failure) if !stripped && without_effort_updates(&wire, &failure).is_some() => failure,
                    _ => return Ok(Box::new(stream)),
                },
                Opened::Rejected(rejected) => rejected,
            };
            if rejected.status == Some(401)
                && !refreshed
            {
                refreshed = true;
                if let Some(next) = self.credentials.after_rejection(&credential).await? {
                    credential = next;
                    continue;
                }
            }
            if !stripped && let Some(next) = without_effort_updates(&wire, &rejected) {
                stripped = true;
                wire = next;
                continue;
            }
            let mut err = self.codec.classify(&rejected);
            if rejected.status == Some(401) && refreshed && err.kind == ErrorKind::Auth {
                err.reauth_required = true;
            }
            return Err(err);
        }
    }
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

enum Source {
    Http(Box<dyn BodyStream>),
    Ws {
        socket: Box<dyn WsSocket>,
        /// The first frame, read before the stream was handed out.
        pending: Option<Result<Message, TransportFault>>,
    },
}

impl Source {
    /// The next transport unit: a body chunk, or one WebSocket message.
    async fn next_unit(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self {
            Self::Http(body) => body.next().await,
            Self::Ws { socket, pending } => loop {
                let item = match pending.take() {
                    Some(item) => Some(item),
                    None => socket.recv().await,
                };
                match item? {
                    Ok(Message::Text(text)) => return Some(Ok(Bytes::copy_from_slice(text.as_bytes()))),
                    Ok(Message::Binary(bytes)) => return Some(Ok(Bytes::copy_from_slice(&bytes))),
                    Ok(_) => {}
                    Err(fault) => return Some(Err(fault)),
                }
            },
        }
    }
}

struct ResponsesStream {
    source: Option<Source>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
}

impl ResponsesStream {
    fn new(source: Source, decoder: Box<dyn WireDecoder>) -> Self {
        Self { source: Some(source), decoder, queue: VecDeque::new(), failed: None }
    }

    /// Reads a WebSocket's first frame ahead of the consumer.
    async fn prime(&mut self) {
        if let Some(Source::Ws { socket, pending }) = &mut self.source {
            *pending = socket.recv().await;
        }
    }

    /// The first frame as a failed response, when it is an `error` frame.
    fn first_frame_failure(&self) -> Option<ErrorResponse> {
        let Some(Source::Ws { pending: Some(Ok(Message::Text(text))), .. }) = &self.source else {
            return None;
        };
        let frame: Value = serde_json::from_str(text.as_str()).ok()?;
        if frame.get("type").and_then(Value::as_str) != Some("error") {
            return None;
        }
        Some(ErrorResponse {
            status: frame.get("status").and_then(Value::as_u64).and_then(|s| u16::try_from(s).ok()),
            headers: Vec::new(),
            body: serde_json::to_vec(&frame).ok()?,
        })
    }
}

#[async_trait]
impl ModelStream for ResponsesStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(Ok(event));
            }
            if let Some(err) = self.failed.take() {
                return Some(Err(err));
            }
            let source = self.source.as_mut()?;
            // The terminal event ends the attempt; anything after it is dropped.
            if self.decoder.terminal_seen() {
                self.source = None;
                return None;
            }
            match source.next_unit().await {
                Some(Ok(unit)) => match self.decoder.feed(&unit) {
                    Ok(events) => self.queue.extend(events),
                    Err(err) => {
                        self.source = None;
                        self.failed = Some(err);
                    }
                },
                Some(Err(fault)) => {
                    self.source = None;
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    self.failed = Some(err);
                }
                None => {
                    self.source = None;
                    match self.decoder.finish() {
                        Ok(events) => self.queue.extend(events),
                        Err(err) => self.failed = Some(err),
                    }
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
}
