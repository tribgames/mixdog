//! `cursor-oauth` / `cursor-api`: the Cursor agent run (`agent.v1.AgentService/Run`),
//! a Connect+protobuf bidirectional stream over HTTP/2.
//!
//! One attempt is one run: the request carries the whole transcript, the
//! server's text and thinking stream back, and a tool batch ends the attempt
//! (the next request carries the results in the transcript). While the run is
//! open the client answers the server's own requests (request context, blob
//! reads and writes, refused interactions) and sends the protocol's
//! application heartbeat; the heartbeat is the run's liveness toward Cursor,
//! never a judgement about the server.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod auth;
pub mod decoder;
pub mod login;
pub mod models;
pub mod request;
pub mod schema;

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwapOption;
use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Jitter;
use mixdog_core_api::domain::retry::AdviceRule;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryRow;
use mixdog_core_api::domain::retry::RetrySchedule;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use self::decoder::CursorDecoder;
use self::models::CursorModel;
use self::models::ParameterAsk;
use self::request::ModelSelection;
use self::request::RunBuild;
use self::request::build_run;
use self::request::conversation_id;
use self::request::random_uuid;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::frame;
use crate::transport::http::BidiOpen;
use crate::transport::http::BodyStream;
use crate::transport::http::FrameSink;
use crate::transport::http::HttpSend;
use crate::providers::connect::provider_error;
use crate::retry::advice;

pub const API_URL: &str = "https://api2.cursor.sh";
pub const RUN_PATH: &str = "/agent.v1.AgentService/Run";
pub const AVAILABLE_MODELS_PATH: &str = "/aiserver.v1.AiService/AvailableModels";
/// The release the endpoint is known to accept; a newer one is configured,
/// never scraped from a web page.
pub const CLIENT_VERSION_FLOOR: &str = "cli-2026.10.22-27dcf5f";
/// The protocol's application heartbeat.
const CLIENT_HEARTBEAT: Duration = Duration::from_secs(5);

/// The access token to present, refreshed on demand.
#[async_trait]
pub trait AccessToken: Send + Sync {
    async fn access_token(&self, force_refresh: bool) -> Result<String, ProviderError>;
}

pub struct CursorTarget {
    pub api_url: String,
    pub access_token: String,
    pub client_version: String,
    pub selection: ModelSelection,
    pub conversation_id: String,
}

fn rpc_headers(access_token: &str, client_version: &str, unary: bool) -> Vec<(String, String)> {
    let mut headers = vec![
        (
            "content-type".to_owned(),
            if unary { "application/proto" } else { "application/connect+proto" }.to_owned(),
        ),
        ("te".to_owned(), "trailers".to_owned()),
        ("authorization".to_owned(), format!("Bearer {access_token}")),
        ("x-ghost-mode".to_owned(), "true".to_owned()),
        ("x-cursor-client-version".to_owned(), client_version.to_owned()),
        ("x-cursor-client-type".to_owned(), "cli".to_owned()),
        ("x-request-id".to_owned(), random_uuid()),
    ];
    if !unary {
        headers.push(("connect-protocol-version".to_owned(), "1".to_owned()));
    }
    headers
}

/// A failed HTTP status without a Connect body.
pub fn http_status_error(status: u16, headers: &[(String, String)]) -> ProviderError {
    provider_error(
        ConnectFailure {
            code: String::new(),
            message: format!("Cursor request failed ({status})"),
            http_status: Some(status),
            retry_after: advice::from_headers(headers, std::time::SystemTime::now()),
        },
        DeliveryState::Accepted,
    )
}

/// Codec of one attempt: the run request is built when the codec is.
pub struct CursorCodec {
    target: CursorTarget,
    run: RunBuild,
}

impl CursorCodec {
    pub fn new(request: &ModelRequest, target: CursorTarget) -> Result<Self, ProviderError> {
        let run = build_run(request, &target.selection, &target.conversation_id, &random_uuid())?;
        Ok(Self { target, run })
    }

    pub fn cursor_decoder(&self) -> CursorDecoder {
        CursorDecoder::new(self.run.blobs.clone(), self.run.tools.clone(), self.run.cloud_rule.clone())
    }
}

impl WireCodec for CursorCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http2
    }

    fn encode(&self, _request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        Ok(WireRequest {
            transport: TransportKind::Http2,
            method: "POST".to_owned(),
            url: format!("{}{RUN_PATH}", self.target.api_url.trim_end_matches('/')),
            headers: rpc_headers(&self.target.access_token, &self.target.client_version, false),
            body: frame::encode(&self.run.message, 0),
        })
    }

    fn decoder(&self) -> Box<dyn WireDecoder> {
        Box::new(self.cursor_decoder())
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        http_status_error(response.status.unwrap_or(0), &response.headers)
    }
}

/// The retry rows of Cursor: five in-place retries on a 250 ms..2 s ladder
/// (±20 %), server advice waited in full, one retry of a throttle, no
/// session-level recovery cycles, and a spent in-place budget surfaces.
pub fn retry_policy() -> RetryPolicy {
    let ms = Duration::from_millis;
    let row = RetryRow::single(RetrySchedule {
        max_retries: 5,
        backoff: Backoff::Ladder(vec![ms(250), ms(500), ms(1000), ms(2000), ms(2000)]),
        jitter: Jitter::symmetric(0.2),
        advice: AdviceRule::honored_in_full(),
    });
    let mut policy = RetryPolicy::codex_default();
    policy.request = row.clone();
    policy.midstream = row;
    policy.transport.schedule.max_retries = 0;
    policy.recovery = None;
    policy.status.caps.push((429, 1));
    policy
}

// ---------------------------------------------------------------------------
// The open run
// ---------------------------------------------------------------------------

struct CursorStream {
    body: Box<dyn BodyStream>,
    sink: Arc<dyn FrameSink>,
    decoder: CursorDecoder,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    ended: bool,
    /// Resolves at the next client heartbeat; the core ticker owns the clock.
    heartbeat: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
    heartbeat_at: std::time::Instant,
}

impl CursorStream {
    fn new(body: Box<dyn BodyStream>, sink: Arc<dyn FrameSink>, decoder: CursorDecoder) -> Self {
        let heartbeat_at = std::time::Instant::now() + CLIENT_HEARTBEAT;
        Self {
            body,
            sink,
            decoder,
            queue: VecDeque::new(),
            ended: false,
            heartbeat: Box::pin(mixdog_rt::ticker().wait_until(heartbeat_at)),
            heartbeat_at,
        }
    }

    fn rearm_heartbeat(&mut self) {
        self.heartbeat_at += CLIENT_HEARTBEAT;
        self.heartbeat = Box::pin(mixdog_rt::ticker().wait_until(self.heartbeat_at));
    }

    fn fail(&mut self, err: ProviderError) {
        self.ended = true;
        self.queue.push_back(Err(err));
    }

    fn flush_outbound(&mut self) {
        for message in self.decoder.take_outbound() {
            // A closed request body surfaces as the response's own fault.
            let _ = self.sink.send(frame::encode(&message, 0));
        }
    }

    fn push(&mut self, result: Result<Vec<StreamEvent>, ProviderError>) {
        self.flush_outbound();
        match result {
            Ok(events) => {
                self.queue.extend(events.into_iter().map(Ok));
                // A finished run is dropped: its request body ends and the
                // response is reset, the server's parked work with it.
                if self.decoder.terminal_seen() {
                    self.ended = true;
                }
            }
            Err(err) => self.fail(err),
        }
    }

    /// Pulls until the first event or error is queued.
    async fn prime(&mut self) {
        while self.queue.is_empty() && !self.ended {
            self.step().await;
        }
    }

    async fn step(&mut self) {
        tokio::select! {
            biased;
            chunk = self.body.next() => match chunk {
                Some(Ok(bytes)) => {
                    let result = self.decoder.feed(&bytes);
                    self.push(result);
                }
                Some(Err(fault)) => {
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    self.fail(err);
                }
                None => {
                    self.ended = true;
                    let result = self.decoder.finish();
                    self.push(result);
                }
            },
            () = &mut self.heartbeat => {
                let _ = self.sink.send(frame::encode(&schema::heartbeat_message(), 0));
                self.rearm_heartbeat();
            }
        }
    }
}

#[async_trait]
impl ModelStream for CursorStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(item) = self.queue.pop_front() {
                return Some(item);
            }
            if self.ended {
                return None;
            }
            self.step().await;
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

pub struct CursorAdapter {
    id: ProviderId,
    api_url: String,
    client_version: String,
    http: Arc<dyn HttpSend>,
    bidi: Arc<dyn BidiOpen>,
    tokens: Arc<dyn AccessToken>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    catalog: ArcSwapOption<Vec<CursorModel>>,
    placeholder: CursorCodecStub,
}

/// `codec()` of the trait needs a stable codec; the run codec is per attempt.
struct CursorCodecStub;

impl WireCodec for CursorCodecStub {
    fn transport(&self) -> TransportKind {
        TransportKind::Http2
    }

    fn encode(&self, _request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        Err(ProviderError::new(
            mixdog_core_api::domain::provider::ErrorKind::Unknown,
            DeliveryState::NotSent,
        ))
    }

    fn decoder(&self) -> Box<dyn WireDecoder> {
        Box::new(CursorDecoder::new(request::BlobStore::default(), Vec::new(), None))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        http_status_error(response.status.unwrap_or(0), &response.headers)
    }
}

/// Connect framing of a unary `application/proto` answer: some replies are
/// wrapped in one envelope.
fn unwrap_unary_body(body: &[u8]) -> &[u8] {
    if body.len() >= 5 {
        let length = u32::from_be_bytes(body[1..5].try_into().expect("4 bytes")) as usize;
        if body[0] & (frame::COMPRESSED | frame::END_STREAM) == 0 && body.len() >= length + 5 {
            return &body[5..length + 5];
        }
    }
    body
}

impl CursorAdapter {
    pub fn new(
        provider: &str,
        api_url: Option<String>,
        client_version: Option<String>,
        http: Arc<dyn HttpSend>,
        bidi: Arc<dyn BidiOpen>,
        tokens: Arc<dyn AccessToken>,
    ) -> Self {
        Self {
            id: ProviderId::from(provider),
            api_url: api_url.unwrap_or_else(|| API_URL.to_owned()),
            client_version: client_version.unwrap_or_else(|| CLIENT_VERSION_FLOOR.to_owned()),
            http,
            bidi,
            tokens,
            policy: retry_policy(),
            keepalive: KeepaliveSchedule::SPEC,
            catalog: ArcSwapOption::empty(),
            placeholder: CursorCodecStub,
        }
    }

    /// The parameterized models of the account, fetched once; an empty
    /// answer is not kept.
    pub async fn models(&self, access_token: &str) -> Result<Vec<CursorModel>, ProviderError> {
        if let Some(models) = self.catalog.load_full() {
            return Ok((*models).clone());
        }
        let head = self
            .http
            .send(WireRequest {
                transport: TransportKind::Http2,
                method: "POST".to_owned(),
                url: format!("{}{AVAILABLE_MODELS_PATH}", self.api_url.trim_end_matches('/')),
                headers: rpc_headers(access_token, &self.client_version, true),
                body: models::available_models_request(),
            })
            .await?;
        let success = head.is_success();
        let response = head.read_all().await?;
        if !success {
            return Err(http_status_error(response.status.unwrap_or(0), &response.headers));
        }
        let models = models::decode_available_models(unwrap_unary_body(&response.body)).map_err(|e| {
            let mut error = ProviderError::new(
                mixdog_core_api::domain::provider::ErrorKind::Unknown,
                DeliveryState::Accepted,
            );
            error.message = format!("Cursor protobuf: {e}");
            error
        })?;
        if !models.is_empty() {
            self.catalog.store(Some(Arc::new(models.clone())));
        }
        Ok(models)
    }

    fn selection(&self, catalog: &[CursorModel], request: &ModelRequest) -> Result<ModelSelection, ProviderError> {
        let route = request.options.model_parameters.as_ref().and_then(Value::as_object);
        models::resolve_selection(
            catalog,
            &request.model,
            &ParameterAsk {
                effort: request.options.effort.as_deref(),
                fast: request.options.fast,
                route,
                selected_context_window: None,
            },
        )
    }

    async fn open(&self, request: &Arc<ModelRequest>, token: &str) -> Result<Box<CursorStream>, ProviderError> {
        // A catalog failure never blocks a turn: the id is then sent as it is.
        let catalog = self.models(token).await.unwrap_or_default();
        let selection = self.selection(&catalog, request)?;
        let scope = request
            .options
            .transport_scope
            .clone()
            .or_else(|| request.options.session_id.clone())
            .or_else(|| request.options.prompt_cache_key.clone())
            .unwrap_or_else(|| format!("cursor-call:{}", random_uuid()));
        let codec = CursorCodec::new(
            request,
            CursorTarget {
                api_url: self.api_url.clone(),
                access_token: token.to_owned(),
                client_version: self.client_version.clone(),
                selection,
                conversation_id: conversation_id(&scope),
            },
        )?;
        let wire = codec.encode(request)?;
        let first = wire.body.clone();
        let (head, sink) = self.bidi.open(wire, first).await?;
        if !head.is_success() {
            let response = head.read_all().await?;
            return Err(codec.classify(&response));
        }
        Ok(Box::new(CursorStream::new(head.body, sink, codec.cursor_decoder())))
    }
}

/// Rejected credentials are worth one forced refresh before giving up.
fn is_auth_failure(error: &ProviderError) -> bool {
    matches!(error.kind, mixdog_core_api::domain::provider::ErrorKind::Auth | mixdog_core_api::domain::provider::ErrorKind::Permission) || matches!(error.status, Some(401 | 403))
}

#[async_trait]
impl ProviderAdapter for CursorAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        &self.placeholder
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let mut token = self.tokens.access_token(false).await?;
        let mut refreshed = false;
        loop {
            let error = match self.open(&request, &token).await {
                Ok(mut stream) => {
                    stream.prime().await;
                    match stream.queue.front() {
                        Some(Err(error)) => error.clone(),
                        _ => return Ok(stream),
                    }
                }
                Err(error) => error,
            };
            if !refreshed && is_auth_failure(&error) {
                refreshed = true;
                let next = self.tokens.access_token(true).await?;
                // The same rejected credential is not sent again.
                if next != token {
                    token = next;
                    continue;
                }
            }
            return Err(error);
        }
    }
}
