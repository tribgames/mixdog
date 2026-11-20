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
pub mod listing;
#[cfg(test)]
mod listing_tests;
pub mod login;
pub mod models;
pub mod request;
pub mod schema;
pub mod variants;

use crate::transport::deadlines::CURSOR_MODELS;
use crate::transport::deadlines::CURSOR_RUN;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwapOption;
use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::AdviceRule;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Jitter;
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
use crate::providers::connect::provider_error;
use crate::providers::listing_row;
use crate::retry::advice;
use crate::transport::http::BidiOpen;
use crate::transport::http::BodyStream;
use crate::transport::http::FrameSink;
use crate::transport::http::HttpSend;

pub const API_URL: &str = "https://api2.cursor.sh";
pub const RUN_PATH: &str = "/agent.v1.AgentService/Run";
pub const AVAILABLE_MODELS_PATH: &str = "/aiserver.v1.AiService/AvailableModels";
pub const MODELS_PATH: &str = "/agent.v1.AgentService/GetUsableModels";

fn pb_error(detail: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    error.message = format!("Cursor protobuf: {detail}");
    error
}

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
    pub client_version: crate::client_versions::Live,
    pub selection: ModelSelection,
    pub conversation_id: String,
}

pub(crate) fn rpc_headers(access_token: &str, client_version: &str, unary: bool) -> Vec<(String, String)> {
    let mut headers = vec![
        ("content-type".to_owned(), if unary { "application/proto" } else { "application/connect+proto" }.to_owned()),
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

/// Codec of one attempt: the run request is built when the codec is.
pub struct CursorCodec {
    target: CursorTarget,
    run: RunBuild,
}

impl CursorCodec {
    pub fn new(request: &ModelRequest, target: CursorTarget) -> Result<Self, ProviderError> {
        // The run request is built once per send and every in-place retry sends its bytes again (`requestBytes`,
        // cursor-wire.mjs:`handleChatCompletion`): its message id is the send's, drawn by the first attempt.
        let message_id = request.options.send_identity.get_or_mint(random_uuid);
        let run = build_run(request, &target.selection, &target.conversation_id, &message_id)?;
        Ok(Self { target, run })
    }

    pub fn cursor_decoder(&self) -> CursorDecoder {
        CursorDecoder::new(self.run.blobs.clone(), self.run.tools.clone(), self.run.cloud_rule.clone())
            .with_pricing_model(self.target.selection.pricing_model.clone())
            .with_known_tools(self.run.tools.iter().map(|tool| tool.name.clone()).collect())
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
        jitter: Jitter::symmetric_floored(0.2),
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

/// `codec()` of the trait needs a stable codec; the run codec is per attempt.
struct CursorCodecStub;

/// Connect framing of a unary `application/proto` answer: some replies are
/// wrapped in one envelope.
pub(crate) fn unwrap_unary_body(body: &[u8]) -> &[u8] {
    if body.len() >= 5 {
        let length = u32::from_be_bytes(body[1..5].try_into().expect("4 bytes")) as usize;
        if body[0] & (frame::COMPRESSED | frame::END_STREAM) == 0 && body.len() >= length + 5 {
            return &body[5..length + 5];
        }
    }
    body
}

/// Rejected credentials are worth one forced refresh before giving up.
fn is_auth_failure(error: &ProviderError) -> bool {
    matches!(error.kind, mixdog_core_api::domain::provider::ErrorKind::Auth | mixdog_core_api::domain::provider::ErrorKind::Permission)
        || matches!(error.status, Some(401 | 403))
}

/// The server's own detail of a Connect failure the protocol-drift check reads: the message after `Cursor <code>: `.
fn failure_detail(error: &ProviderError) -> &str {
    error.message.split_once(": ").map_or("", |(_, detail)| detail)
}

/// `isCursorProtocolDrift` (cursor-wire-guards.mjs:293): a protocol error, or a detail that names a wire mismatch.
fn is_protocol_drift(error: &ProviderError) -> bool {
    static DRIFT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(?-u:\b)(protocol|protobuf|wire drift|invalid argument|failed_precondition)(?-u:\b)").expect("constant pattern")
    });
    error.code.as_deref() == Some("protocol_error") || DRIFT.is_match(failure_detail(error))
}

/// `withCursorFailureHint`: the guidance a final Cursor failure ends with, once.
fn with_failure_hint(mut error: ProviderError) -> ProviderError {
    let hint = if matches!(error.code.as_deref(), Some("unauthenticated" | "permission_denied")) {
        auth::REAUTH_GUIDANCE
    } else if is_protocol_drift(&error) {
        "Cursor may have changed its wire protocol; update Mixdog or set MIXDOG_CURSOR_CLIENT_VERSION if this persists."
    } else {
        return error;
    };
    error.message = format!("{} {hint}", error.message);
    error
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

pub struct CursorAdapter {
    id: ProviderId,
    api_url: String,
    client_version: crate::client_versions::Live,
    http: Arc<dyn HttpSend>,
    bidi: Arc<dyn BidiOpen>,
    tokens: Arc<dyn AccessToken>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    catalog: ArcSwapOption<Vec<CursorModel>>,
    /// The conversations a throttle touched, by scope.
    rotated: Arc<Conversations>,
    /// The rows the last listing stored, which `getCachedModelInfo` answers.
    rows: crate::catalog::RowStore,
    placeholder: CursorCodecStub,
}
impl CursorAdapter {
    pub fn new(
        provider: &str,
        api_url: Option<String>,
        client_version: Option<crate::client_versions::Live>,
        http: Arc<dyn HttpSend>,
        bidi: Arc<dyn BidiOpen>,
        tokens: Arc<dyn AccessToken>,
    ) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        Self {
            id: ProviderId::from(provider),
            api_url: api_url.unwrap_or_else(|| API_URL.to_owned()),
            client_version: client_version.unwrap_or_else(|| CLIENT_VERSION_FLOOR.into()),
            http,
            bidi,
            tokens,
            policy: retry_policy(),
            keepalive: KeepaliveSchedule::SPEC,
            catalog: ArcSwapOption::empty(),
            rotated: Arc::default(),
            rows: crate::catalog::RowStore::default(),
            placeholder: CursorCodecStub,
        }
    }

    /// The parameterized models of the account, fetched once for the turns
    /// that resolve their variant from it; an empty answer is not kept.
    pub async fn cached_models(&self, access_token: &str) -> Result<Vec<CursorModel>, ProviderError> {
        if let Some(models) = self.catalog.load_full() {
            return Ok((*models).clone());
        }
        let (models, fallback) = self.discover_models(access_token).await;
        // The picker may have installed a live catalog while this send was fetching: it is newer than anything this
        // discovery found, and better than the static list, so it answers first.
        if fallback {
            return Ok(self.catalog.load_full().map_or(models, |installed| (*installed).clone()));
        }
        // A cold fill never replaces a catalog installed while it was fetching; the fallback is never kept.
        let none: Option<Arc<Vec<CursorModel>>> = None;
        let previous = self.catalog.compare_and_swap(&none, Some(Arc::new(models.clone())));
        if let Some(newer) = Option::<Arc<Vec<CursorModel>>>::clone(&*previous) {
            return Ok((*newer).clone());
        }
        Ok(models)
    }

    /// The live catalog with Node's backoff (`getCursorModels`): three attempts after 0.5, 1.5 and 3 s, each
    /// `AvailableModels` then the legacy `GetUsableModels`; the static list answers when none gave a row, flagged so
    /// it is never kept.
    pub async fn discover_models(&self, access_token: &str) -> (Vec<CursorModel>, bool) {
        for delay in [None, Some(Duration::from_millis(500)), Some(Duration::from_millis(1_500)), Some(Duration::from_millis(3_000))] {
            if let Some(delay) = delay {
                mixdog_rt::time::sleep(delay).await;
            }
            if let Ok(models) = self.discover_once(access_token).await
                && !models.is_empty()
            {
                return (models, false);
            }
        }
        (models::fallback_models(), true)
    }

    async fn discover_once(&self, access_token: &str) -> Result<Vec<CursorModel>, ProviderError> {
        if let Ok(models) = self.fetch_models(access_token).await
            && !models.is_empty()
        {
            return Ok(models);
        }
        let body = self.unary(MODELS_PATH, Vec::new(), access_token).await?;
        models::decode_usable_models(unwrap_unary_body(&body)).map_err(|e| pb_error(&e.to_string()))
    }

    async fn unary(&self, path: &str, body: Vec<u8>, access_token: &str) -> Result<Vec<u8>, ProviderError> {
        let head = self
            .http
            .send(
                WireRequest {
                    transport: TransportKind::Http2,
                    method: "POST".to_owned(),
                    url: format!("{}{path}", self.api_url.trim_end_matches('/')),
                    headers: rpc_headers(access_token, &self.client_version.get(), true),
                    body,
                },
                CURSOR_MODELS,
            )
            .await?;
        let success = head.is_success();
        let response = head.read_all().await?;
        if !success {
            return Err(http_status_error(response.status.unwrap_or(0), &response.headers));
        }
        Ok(response.body)
    }

    /// One `AvailableModels` request: no cache.
    pub async fn fetch_models(&self, access_token: &str) -> Result<Vec<CursorModel>, ProviderError> {
        let body = self.unary(AVAILABLE_MODELS_PATH, models::available_models_request(), access_token).await?;
        models::decode_available_models(unwrap_unary_body(&body)).map_err(|e| pb_error(&e.to_string()))
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
                selected_context_window: selected_context_window(route),
            },
        )
    }

    /// The scope a request's conversation belongs to; `None` for a call that owns no session.
    fn scope_of(request: &ModelRequest) -> Option<&str> {
        let options = &request.options;
        [&options.transport_scope, &options.session_id, &options.prompt_cache_key].into_iter().find_map(|scope| scope.as_deref())
    }

    /// The conversation id a scope sends: the derived one until a throttle rotated it.
    fn conversation_of(&self, scope: &str) -> String {
        self.rotated.id_for(scope)
    }

    async fn open(&self, request: &Arc<ModelRequest>, token: &str) -> Result<Box<CursorStream>, ProviderError> {
        // A catalog failure never blocks a turn: the id is then sent as it is.
        let catalog = self.cached_models(token).await.unwrap_or_default();
        let selection = self.selection(&catalog, request)?;
        // `_dispatchChat` raises `requesting` once, ahead of the run's in-place retries and after the catalog was read
        // and the model chosen (cursor.mjs:656).
        request.options.send_identity.raise_requesting_once();
        let scope = Self::scope_of(request).map_or_else(|| format!("cursor-call:{}", random_uuid()), str::to_owned);
        let codec = CursorCodec::new(
            request,
            CursorTarget {
                api_url: self.api_url.clone(),
                access_token: token.to_owned(),
                client_version: self.client_version.clone(),
                selection,
                conversation_id: self.conversation_of(&scope),
            },
        )?;
        let wire = codec.encode(request)?;
        let first = wire.body.clone();
        let (head, sink) = self.bidi.open(wire, first, CURSOR_RUN).await?;
        if !head.is_success() {
            let response = head.read_all().await?;
            return Err(codec.classify(&response));
        }
        let mut stream = CursorStream::new(head.body, sink, codec.cursor_decoder(), token.to_owned());
        if let Some(scope) = Self::scope_of(request) {
            stream.throttle = Some((self.rotated.clone(), scope.to_owned()));
        }
        Ok(Box::new(stream))
    }
}
#[async_trait]
impl ModelListing for CursorAdapter {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let token = self.tokens.access_token(false).await?;
        let (models, fallback) = self.discover_models(&token).await;
        let rows: Vec<ModelRecord> = listing::rows(&models, self.id.as_str()).into_iter().map(listing_row::record).collect();
        // The static list answers this call only: `_loadCursorCatalog` keeps no catalog from it, so `getCachedModelInfo`
        // has nothing of it either.
        if !fallback {
            // The sends read the catalog this listing refreshed (`_loadCursorCatalog` is one cache for both).
            self.catalog.store(Some(Arc::new(models)));
            self.rows.replace(rows.iter().map(|row| std::sync::Arc::new(crate::catalog::stored_row(&self.id, row.clone()))).collect());
        }
        Ok(rows)
    }
}
#[async_trait]
impl ProviderAdapter for CursorAdapter {
    fn release_send(&self, _group: &str) {}
    /// The scope is over: its conversation's throttle record goes with it.
    fn release_session(&self, session_id: &str) {
        self.rotated.release(session_id);
    }
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(self)
    }

    fn native_pdf(&self) -> bool {
        false
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
        // Every in-place retry of Node's bridge force-refreshes the credentials and keeps the previous token when the
        // refresh fails (`createCursorCredentialRefresher`, cursor-wire-guards.mjs:315).
        let mut token = if request.options.send_identity.next_attempt() > 0 {
            match self.tokens.access_token(true).await {
                Ok(next) => next,
                Err(_) => self.tokens.access_token(false).await?,
            }
        } else {
            self.tokens.access_token(false).await?
        };
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
            // Cursor can pin `resource_exhausted` to one conversation id: the retry that follows a throttle starts a
            // fresh one (`cursor-wire.mjs` restart with reason `throttle`).
            if error.status == Some(429)
                && let Some(scope) = Self::scope_of(&request)
            {
                self.rotated.throttled(scope);
            }
            return Err(with_failure_hint(error));
        }
    }
}

/// `session.selectedContextWindow`: the window of the route's saved `context` choice, which decides Max mode.
fn selected_context_window(route: Option<&serde_json::Map<String, Value>>) -> Option<u64> {
    let route = route?;
    route
        .get("selectedContextWindow")
        .and_then(Value::as_u64)
        .or_else(|| route.get("context").and_then(Value::as_str).map(listing::context_window_of))
        .filter(|window| *window > 0)
}
impl crate::catalog::CachedModelInfo for CursorAdapter {
    fn cached_row(&self, model: &str) -> Option<std::sync::Arc<serde_json::Value>> {
        self.rows.find(model)
    }
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
impl WireCodec for CursorCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http2
    }
    fn image_branch(&self, _: &ModelRequest) -> mixdog_image_egress::route::WireBranch {
        mixdog_image_egress::route::WireBranch::InlineOnly
    }

    fn encode(&self, _request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        Ok(WireRequest {
            transport: TransportKind::Http2,
            method: "POST".to_owned(),
            url: format!("{}{RUN_PATH}", self.target.api_url.trim_end_matches('/')),
            headers: rpc_headers(&self.target.access_token, &self.target.client_version.get(), false),
            body: frame::encode(&self.run.message, 0),
        })
    }

    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        Box::new(self.cursor_decoder())
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        http_status_error(response.status.unwrap_or(0), &response.headers)
    }
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
    /// The access token the run was opened with: a server error that echoes it is redacted.
    secret: String,
    /// The conversations of the adapter and the scope this run belongs to, when it has one.
    throttle: Option<(Arc<Conversations>, String)>,
}

/// The conversation ids Cursor's throttles rotated, by scope (`conversation.id = crypto.randomUUID()` of the `throttle`
/// restart): a scope keeps its derived id until a throttle ends one of its runs, and the retry after it sends a fresh one.
#[derive(Default)]
struct Conversations(std::sync::Mutex<std::collections::HashMap<String, Conversation>>);

#[derive(Default)]
struct Conversation {
    rotated: Option<String>,
    throttled: bool,
}

impl Conversations {
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, Conversation>> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The id the next run of `scope` sends.
    fn id_for(&self, scope: &str) -> String {
        let mut all = self.lock();
        let Some(entry) = all.get_mut(scope) else { return conversation_id(scope) };
        if std::mem::take(&mut entry.throttled) {
            entry.rotated = Some(random_uuid());
        }
        entry.rotated.clone().unwrap_or_else(|| conversation_id(scope))
    }

    fn throttled(&self, scope: &str) {
        self.lock().entry(scope.to_owned()).or_default().throttled = true;
    }

    /// The scope ended.
    fn release(&self, scope: &str) {
        self.lock().remove(scope);
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

    /// A leaf: `next` awaits nothing after the wire's terminal event.
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}
impl WireCodec for CursorCodecStub {
    fn transport(&self) -> TransportKind {
        TransportKind::Http2
    }

    fn encode(&self, _request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        Err(ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::Unknown, DeliveryState::NotSent))
    }

    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        Box::new(CursorDecoder::new(request::BlobStore::default(), Vec::new(), None))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        http_status_error(response.status.unwrap_or(0), &response.headers)
    }
}

impl CursorStream {
    fn new(body: Box<dyn BodyStream>, sink: Arc<dyn FrameSink>, decoder: CursorDecoder, secret: String) -> Self {
        let heartbeat_at = std::time::Instant::now() + CLIENT_HEARTBEAT;
        Self {
            secret,
            throttle: None,
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

    fn fail(&mut self, mut err: ProviderError) {
        self.ended = true;
        err.message = crate::oauth::scrub::scrub_oauth_secrets(&err.message, &[&self.secret]);
        // A throttle that ends the run after output (a `resource_exhausted` end frame) is retried by the broker like one
        // that refused it: the retry must not reuse the conversation id Cursor pinned it to.
        if err.status == Some(429)
            && let Some((conversations, scope)) = &self.throttle
        {
            conversations.throttled(scope);
        }
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
                    err.connection = self.body.connection();
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
