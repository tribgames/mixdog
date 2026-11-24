//! `cursor-oauth` / `cursor-api`: the Cursor agent run (`agent.v1.AgentService/Run`),
//! a Connect+protobuf bidirectional stream over HTTP/2.
//!
//! A run's request carries the whole transcript and the server's text and
//! thinking stream back. A tool batch ends the attempt, not the run: the run
//! waits for its results, which the next request of the scope writes back on
//! it when its transcript ends in exactly them; any other continuation, and a
//! run that is gone, is taken up by a new run carrying the transcript
//! ([`open_run`], [`CursorAdapter::resume`]). While the run is
//! open the client answers the server's own requests (request context, blob
//! reads and writes, refused interactions) and sends the protocol's
//! application heartbeat; the heartbeat is the run's liveness toward Cursor,
//! never a judgement about the server.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod answer;
pub mod auth;
pub mod decoder;
pub mod listing;
#[cfg(test)]
mod listing_tests;
pub mod login;
pub mod models;
mod open_run;
#[cfg(test)]
mod open_run_tests;
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
use bytes::Bytes;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ListedRoster;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::Provenance;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
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
use self::open_run::Fingerprint;
use self::open_run::Kept;
use self::open_run::Live;
use self::open_run::Parked;
use self::open_run::Runs;
use self::request::ModelSelection;
use self::request::Prepared;
use self::request::RunBuild;
use self::request::build_prepared;
use self::request::build_run;
use self::request::conversation_id;
use self::request::random_uuid;
use crate::providers::connect::ConnectFailure;
use crate::providers::connect::frame;
use crate::providers::connect::provider_error;
use crate::providers::listing_row;
use crate::retry::advice;
use crate::transport::http::BidiOpen;
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

/// What one request is sent on: its access token, and the refresh token that one was served under (none for a token
/// with no login behind it). A refusal hands the whole of it back, so the source acts on that login and on no other.
#[derive(Clone, PartialEq, Eq)]
pub struct Access {
    pub token: String,
    grant: Option<String>,
}

impl Access {
    /// A token with no login behind it (one exchanged for an API key, or a fixed one).
    pub fn plain(token: String) -> Self {
        Self { token, grant: None }
    }

    fn served_under(token: String, grant: Option<String>) -> Self {
        Self { token, grant }
    }
}

impl std::fmt::Debug for Access {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Access([redacted])")
    }
}

/// The access token to present, refreshed on demand.
#[async_trait]
pub trait AccessToken: Send + Sync {
    async fn access_token(&self) -> Result<Access, ProviderError>;
    /// The server refused `rejected`: the token is exchanged again for the login that attempt was served under and for
    /// no other. A login stored since is returned as it is.
    async fn after_rejection(&self, rejected: &Access) -> Result<Access, ProviderError>;
    /// What an in-place retry is sent on (`createCursorCredentialRefresher`, cursor-wire-guards.mjs:315): the login
    /// stored now, exchanged again whatever its expiry. When that exchange fails the stored token is what the retry goes
    /// out on; a sign-out is the error, and nothing is sent.
    async fn renewed(&self) -> Result<Access, ProviderError>;
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
        // The tools of a run are the ones this side offers, which reach the service as MCP tools: its own file and
        // shell tools, which only this side could run, are not offered to the model. One it asks for all the same
        // is still served by the tool of this side that does the same. The service's own tool that lists the MCP
        // tools is left out as well: the model has the list already, and spent a step of each run on asking for it.
        headers.push(("x-cursor-agent-allowed-tools".to_owned(), "mcp_tool_call".to_owned()));
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

    /// [`Self::new`] for a request already read ([`request::prepare`]).
    fn prepared(request: &ModelRequest, target: CursorTarget, prepared: Prepared) -> Result<Self, ProviderError> {
        let message_id = request.options.send_identity.get_or_mint(random_uuid);
        let run = build_prepared(prepared, &target.selection, &target.conversation_id, &message_id)?;
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

/// The service refused the sign-in itself (401) on a request that carried only its token. A 403 is not: a plan without
/// the data, a blocked or retired endpoint.
pub(crate) fn is_sign_in_refusal(error: &ProviderError) -> bool {
    error.status == Some(401)
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

// Adapter

/// What a model discovery answered with.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Discovery {
    /// The account's own catalog.
    Live,
    /// The static list: no attempt gave a row.
    Fallback,
    /// The static list: the service refused the token the discovery was sent on.
    Refused,
    /// The static list: the sign-in is marked for a new sign-in, so nothing can change until the user signs in again
    /// (which re-lists by itself). A settled answer, asked again by nothing.
    SignedOut,
}

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
    /// The conversations a completed run or a refusal touched, by scope.
    rotated: Arc<Conversations>,
    /// The selections whose model id the service answered as not found, asked under their listed id since.
    unknown_ids: std::sync::Mutex<Vec<ModelSelection>>,
    /// The runs waiting for the results of the batch they handed over, by scope.
    runs: Arc<Runs>,
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
            unknown_ids: Default::default(),
            runs: Arc::default(),
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
        let (models, discovery) = self.discover_models(access_token).await;
        // The picker may have installed a live catalog while this send was fetching: it is newer than anything this
        // discovery found, and better than the static list, so it answers first.
        if discovery != Discovery::Live {
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
    /// it is never kept. A sign-in the primary call refuses is refused again after any wait, so that refusal answers the
    /// static list at once.
    pub async fn discover_models(&self, access_token: &str) -> (Vec<CursorModel>, Discovery) {
        for delay in [None, Some(Duration::from_millis(500)), Some(Duration::from_millis(1_500)), Some(Duration::from_millis(3_000))] {
            if let Some(delay) = delay {
                mixdog_rt::time::sleep(delay).await;
            }
            // The sign-in is judged by the primary call's answer; the legacy call only stands in for its rows.
            match self.fetch_models(access_token).await {
                Ok(models) if !models.is_empty() => return (models, Discovery::Live),
                Err(error) if is_sign_in_refusal(&error) => return (models::fallback_models(), Discovery::Refused),
                _ => {}
            }
            if let Ok(models) = self.fetch_usable_models(access_token).await
                && !models.is_empty()
            {
                return (models, Discovery::Live);
            }
        }
        (models::fallback_models(), Discovery::Fallback)
    }

    /// One legacy `GetUsableModels` request.
    async fn fetch_usable_models(&self, access_token: &str) -> Result<Vec<CursorModel>, ProviderError> {
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

    /// What `request` asks a run for: the catalog, the tools and the transcript are read once per attempt, whether the
    /// attempt goes on the waiting run or opens one.
    async fn asked(&self, request: &ModelRequest, token: &str) -> Result<Asked, ProviderError> {
        // A catalog failure never blocks a turn: the id is then sent as it is.
        let catalog = self.cached_models(token).await.unwrap_or_default();
        let mut selection = self.selection(&catalog, request)?;
        let mut listed = models::listed_selection(&catalog, &selection);
        let mut switched = None;
        if listed.is_some() && self.unknown_ids.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains(&selection) {
            switched = Some(std::mem::replace(&mut selection, listed.take().expect("checked")));
        }
        // `_dispatchChat` raises `requesting` once, ahead of the run's in-place retries and after the catalog was read
        // and the model chosen (cursor.mjs:656).
        request.options.send_identity.raise_requesting_once();
        Ok(Asked { selection, prepared: request::prepare(request)?, listed, switched })
    }

    async fn open(&self, request: &Arc<ModelRequest>, token: &str, asked: Asked) -> Result<Box<CursorStream>, ProviderError> {
        let scope = Self::scope_of(request).map_or_else(|| format!("cursor-call:{}", random_uuid()), str::to_owned);
        let codec = CursorCodec::prepared(
            request,
            CursorTarget {
                api_url: self.api_url.clone(),
                access_token: token.to_owned(),
                client_version: self.client_version.clone(),
                selection: asked.selection,
                conversation_id: self.conversation_of(&scope),
            },
            asked.prepared,
        )?;
        let wire = codec.encode(request)?;
        let first = wire.body.clone();
        let (head, sink) = self.bidi.open(wire, first, CURSOR_RUN).await?;
        if !head.is_success() {
            let response = head.read_all().await?;
            return Err(codec.classify(&response));
        }
        let live = Live {
            body: head.body,
            sink,
            decoder: codec.cursor_decoder(),
            heartbeat_at: std::time::Instant::now() + CLIENT_HEARTBEAT,
            secret: token.to_owned(),
            fingerprint: Fingerprint { selection: codec.target.selection.clone(), tools: codec.run.tools.clone(), cloud_rule: codec.run.cloud_rule.clone() },
        };
        let mut stream = CursorStream::new(live, VecDeque::new(), request);
        if let Some(scope) = Self::scope_of(request) {
            stream.throttle = Some((self.rotated.clone(), scope.to_owned()));
        }
        stream.waits = Some((self.runs.clone(), scope));
        Ok(Box::new(stream))
    }

    /// The step `request` takes on `waiting`, the scope's run that handed over a batch and waited for its results.
    ///
    /// A transcript that ends in exactly those results, asked of the same model, tools and rules, has them written back
    /// on the run, each on its call and in the batch's order, and the run goes on; a failure it then answers with is the
    /// attempt's, as the failure of any stream is. Any other request leaves the run: text of the user after the results,
    /// a transcript that does not continue the batch, another model, other tools or rules. A run that is left is closed
    /// with everything it held, a call it announced behind the batch among it: the model asked for that call before
    /// what the new request says, and the new run decides again with the whole transcript. `None` leaves the step to
    /// that new run.
    fn resume(&self, request: &Arc<ModelRequest>, asked: &Asked, waiting: Kept, scope: &str) -> Option<Box<CursorStream>> {
        let (mut live, replay) = waiting;
        if asked.fingerprint() != live.fingerprint {
            return None;
        }
        let results = results_for(&request.messages, live.decoder.handed())?;
        for (call, result) in live.decoder.handed().iter().zip(&results) {
            for message in answer::answer(&call.exec, result) {
                live.sink.send(frame::encode(&message, 0)).ok()?;
            }
        }
        live.decoder.resume();
        let mut stream = CursorStream::new(live, replay, request);
        stream.throttle = Some((self.rotated.clone(), scope.to_owned()));
        stream.waits = Some((self.runs.clone(), scope.to_owned()));
        Some(Box::new(stream))
    }
}

/// What a request asks a run for.
struct Asked {
    selection: ModelSelection,
    prepared: Prepared,
    /// The same variant under the id the listing gave it, where that is another id: asked when the service does not
    /// know the first.
    listed: Option<ModelSelection>,
    /// The selection this one was switched from, after the service did not know it.
    switched: Option<ModelSelection>,
}

impl Asked {
    fn fingerprint(&self) -> Fingerprint {
        Fingerprint { selection: self.selection.clone(), tools: self.prepared.tools.clone(), cloud_rule: self.prepared.cloud_rule.clone() }
    }
}
#[async_trait]
impl ModelListing for CursorAdapter {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        Ok(self.listed().await?.0)
    }

    /// [`Self::list_models`], with the static list stated as the seed: it is never recorded as the account's answer, so the
    /// catalog asks again once its backoff passed. A sign-in that needs a new sign-in is the exception: its static list
    /// is the provider's settled answer until the user signs in again.
    async fn list_roster(&self) -> Result<ListedRoster, ProviderError> {
        let before = self.roster_identity().await;
        let (rows, discovery) = self.listed().await?;
        let identity = self.roster_identity().await;
        if before != identity {
            let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
            error.message = "the signed-in account changed while the model list was being fetched".to_owned();
            return Err(error);
        }
        let provenance = match discovery {
            Discovery::Live | Discovery::SignedOut => Provenance::Fetched,
            Discovery::Fallback | Discovery::Refused => Provenance::Seed,
        };
        Ok(ListedRoster { rows, provenance, identity })
    }
}

impl CursorAdapter {
    /// One listing. A sign-in already refused sends nothing and answers the static list. A refusal of the sign-in this
    /// listing was sent on is acted on as a send's is: that one is renewed, and the listing runs once more on the renewed
    /// token, or it is marked for a new sign-in when its renewal is refused too.
    async fn listed(&self) -> Result<(Vec<ModelRecord>, Discovery), ProviderError> {
        let (models, discovery) = match self.tokens.access_token().await {
            Ok(access) => match self.discover_models(&access.token).await {
                (_, Discovery::Refused) => match self.tokens.after_rejection(&access).await {
                    Ok(renewed) if renewed.token != access.token => self.discover_models(&renewed.token).await,
                    Ok(_) => (models::fallback_models(), Discovery::Refused),
                    // A refused renewal is no proof the stored sign-in is marked (another process may have renewed it
                    // meanwhile): only the token step reading a marked sign-in settles, on the next ask.
                    Err(error) => {
                        tracing::warn!(provider = self.id.as_str(), kind = ?error.kind, "[cursor] the refused sign-in was not renewed");
                        (models::fallback_models(), Discovery::Refused)
                    }
                },
                discovered => discovered,
            },
            Err(error) if is_sign_in_refusal(&error) => (models::fallback_models(), Discovery::SignedOut),
            Err(error) => return Err(error),
        };
        let rows: Vec<ModelRecord> = listing::rows(&models, self.id.as_str()).into_iter().map(listing_row::record).collect();
        // The static list answers this call only: `_loadCursorCatalog` keeps no catalog from it, so `getCachedModelInfo`
        // has nothing of it either.
        if discovery == Discovery::Live {
            // The sends read the catalog this listing refreshed (`_loadCursorCatalog` is one cache for both).
            self.catalog.store(Some(Arc::new(models)));
            self.rows.replace(rows.iter().map(|row| std::sync::Arc::new(crate::catalog::stored_row(&self.id, row.clone()))).collect());
        }
        Ok((rows, discovery))
    }
}
#[async_trait]
impl ProviderAdapter for CursorAdapter {
    fn release_send(&self, _group: &str) {}
    /// The scope is over: its conversation's throttle record goes with it.
    fn release_session(&self, session_id: &str) {
        self.rotated.release(session_id);
        self.runs.release(session_id);
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

    /// The request carries text and base64 images only: any other attachment is lowered to text before it is built.
    fn native_documents(&self) -> Option<bool> {
        Some(false)
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
        // Every in-place retry of Node's bridge force-refreshes the credentials. One decision either way: a token just
        // obtained has not been refused, and a sign-out seen while obtaining it ends the attempt.
        let mut access = if request.options.send_identity.next_attempt() > 0 { self.tokens.renewed().await? } else { self.tokens.access_token().await? };
        // The scope's waiting run is this attempt's to continue or to close.
        let waiting = match Self::scope_of(&request).and_then(|scope| self.runs.take(scope)) {
            Some(parked) => parked.take().await,
            None => None,
        };
        if let Some(scope) = Self::scope_of(&request)
            && request.messages.iter().any(|message| message.role == Role::Assistant)
        {
            self.rotated.under_way(scope);
        }
        let mut asked = self.asked(&request, &access.token).await;
        if let (Ok(asked), Some(waiting), Some(scope)) = (&asked, waiting, Self::scope_of(&request))
            && let Some(mut stream) = self.resume(&request, asked, waiting, scope)
        {
            stream.prime().await;
            // The run that was given its results answers for itself: a failure is the attempt's, and the retry that
            // follows it finds no run waiting and carries the transcript on a new one.
            return match stream.queue.pop_front() {
                Some(Err(error)) => Err(with_failure_hint(error)),
                Some(first) => {
                    stream.queue.push_front(first);
                    Ok(stream)
                }
                None => Ok(stream),
            };
        }
        let mut refreshed = false;
        let mut by_listing = None;
        let mut switched = None;
        loop {
            let opened = match asked {
                Ok(mut asked) => {
                    switched = asked.switched.take();
                    by_listing = asked.listed.take().map(|selection| {
                        let listed = Asked { selection, prepared: asked.prepared.clone(), listed: None, switched: Some(asked.selection.clone()) };
                        (asked.selection.clone(), listed)
                    });
                    self.open(&request, &access.token, asked).await
                }
                Err(error) => Err(error),
            };
            // `(the failure, the service does not know the model id, the open itself was refused)`
            let (error, unknown_model, unopened) = match opened {
                Ok(mut stream) => {
                    stream.prime().await;
                    match stream.queue.front() {
                        Some(Err(error)) => (error.clone(), stream.unknown_model, false),
                        _ => return Ok(stream),
                    }
                }
                Err(error) => (error, false, true),
            };
            if !refreshed && is_auth_failure(&error) {
                refreshed = true;
                // The refusal is of the attempt this request was sent on, whatever login the file holds by now.
                let next = self.tokens.after_rejection(&access).await?;
                // The same rejected credential is not sent again.
                if next.token != access.token {
                    access = next;
                    asked = self.asked(&request, &access.token).await;
                    continue;
                }
            }
            // The model id the catalog describes by parameters is not one the service knows (a not-found of anything
            // else is the failure it is): the id the listing gave that variant is asked once, and from then on. When
            // it is the listed id the service does not know, the switch to it is undone.
            if unknown_model {
                let mut unknown_ids = self.unknown_ids.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some((unknown, listed)) = by_listing.take() {
                    unknown_ids.push(unknown);
                    asked = Ok(listed);
                    continue;
                }
                if let Some(original) = switched.take() {
                    unknown_ids.retain(|selection| *selection != original);
                }
            }
            // A throttle that refuses the open is before anything was shown too; one a run ended with was the run's to
            // judge, by what the service said of it.
            if unopened
                && error.status == Some(429)
                && let Some(scope) = Self::scope_of(&request)
            {
                self.rotated.refused(scope);
            }
            return Err(with_failure_hint(error));
        }
    }
}

/// The result of each call of `handed`, in the batch's order, when the transcript ends in the batch and exactly its
/// results. The tail reminder the agent puts last on every request ([`MessageSource::TailReminder`]) is no part of the
/// transcript: the run was told it when it was opened. `None` for any other transcript: text of the user after the
/// results, a call the run did not ask for, a result that is missing.
fn results_for(messages: &[Message], handed: &[decoder::Pending]) -> Option<Vec<Message>> {
    let messages = crate::providers::own_call_ids::own_call_ids(messages);
    let last = messages.iter().rposition(|m| m.role == Role::Assistant)?;
    let asked = &messages[last].tool_calls;
    let tail: Vec<&Message> = messages[last + 1..].iter().filter(|m| m.source != Some(MessageSource::TailReminder)).collect();
    if handed.is_empty() || asked.len() != handed.len() || tail.len() != handed.len() || tail.iter().any(|m| m.role != Role::Tool) {
        return None;
    }
    handed.iter().map(|call| tail.iter().find(|m| m.tool_call_id.as_deref() == Some(call.tool_call_id.as_str())).map(|m| (*m).clone())).collect()
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
// The open run

struct CursorStream {
    /// The run's wire; `None` once the run ended or waits for its results.
    live: Option<Live>,
    /// What arrived on the run while it waited, read ahead of the wire.
    replay: VecDeque<Bytes>,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    ended: bool,
    /// Resolves at the next client heartbeat; the core ticker owns the clock.
    heartbeat: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>,
    /// Resolves at the quiet point of the calls announced for a step the service has not listed in full
    /// ([`decoder::QUIET`] after the last frame that was no heartbeat); `None` while no such call waits.
    quiet: Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>>,
    /// The conversations of the adapter and the scope this run belongs to, when it has one.
    throttle: Option<(Arc<Conversations>, String)>,
    /// The send this attempt serves: the server's heartbeat is its transport health.
    identity: mixdog_core_api::domain::provider::SendIdentity,
    /// Where a run that hands over a batch waits, and under which scope.
    waits: Option<(Arc<Runs>, String)>,
    /// The run waiting for this batch's results: it lives as long as this stream.
    parked: Option<Arc<Parked>>,
    /// The run failed before showing anything because the service does not know the model id it was asked for.
    unknown_model: bool,
}

/// The conversation ids of the scopes, where they are not the derived one. The service can pin a refusal to a
/// conversation it holds: a run of such a conversation that fails before any token, by a throttle or by the provider's
/// own failure, makes the next run of the scope send a fresh id. A conversation no run has yet completed on is not one
/// the service holds, so a first request's refusal stands as the service's verdict, and so does the refusal of the
/// fresh id: one new id per streak of failures.
#[derive(Default)]
struct Conversations(std::sync::Mutex<std::collections::HashMap<String, Conversation>>);

#[derive(Default)]
struct Conversation {
    rotated: Option<String>,
    /// The next run sends a fresh id.
    refused: bool,
    /// A run completed a batch or a turn under the current id.
    held: bool,
}

impl Conversations {
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, Conversation>> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The id the next run of `scope` sends.
    fn id_for(&self, scope: &str) -> String {
        let mut all = self.lock();
        let Some(entry) = all.get_mut(scope) else { return conversation_id(scope) };
        if std::mem::take(&mut entry.refused) {
            entry.rotated = Some(random_uuid());
        }
        entry.rotated.clone().unwrap_or_else(|| conversation_id(scope))
    }

    fn held(&self, scope: &str) {
        self.lock().entry(scope.to_owned()).or_default().held = true;
    }

    /// The transcript of a request holds turns of the assistant: a scope nothing is recorded of yet (the process
    /// started with the conversation under way) has a conversation the service holds, as a completed run shows.
    fn under_way(&self, scope: &str) {
        self.lock().entry(scope.to_owned()).or_insert(Conversation { held: true, ..Conversation::default() });
    }

    fn refused(&self, scope: &str) {
        if let Some(entry) = self.lock().get_mut(scope)
            && std::mem::take(&mut entry.held)
        {
            entry.refused = true;
        }
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
    /// The attempt of `request` reading `live`, `replay` first.
    fn new(mut live: Live, replay: VecDeque<Bytes>, request: &Arc<ModelRequest>) -> Self {
        live.decoder.attend(request.clone());
        let heartbeat = Box::pin(mixdog_rt::ticker().wait_until(live.heartbeat_at));
        let identity = request.options.send_identity.clone();
        Self {
            live: Some(live),
            replay,
            throttle: None,
            queue: VecDeque::new(),
            ended: false,
            heartbeat,
            quiet: None,
            identity,
            waits: None,
            parked: None,
            unknown_model: false,
        }
    }

    fn live(&mut self) -> &mut Live {
        self.live.as_mut().expect("a stream that has not ended reads an open run")
    }

    fn rearm_heartbeat(&mut self) {
        let live = self.live();
        live.heartbeat_at += CLIENT_HEARTBEAT;
        let at = live.heartbeat_at;
        self.heartbeat = Box::pin(mixdog_rt::ticker().wait_until(at));
    }

    fn fail(&mut self, mut err: ProviderError) {
        self.ended = true;
        // A run ended before any token by a throttle or by the provider's own failure: the service may have pinned the
        // refusal to the conversation.
        // A limit of the account is no other conversation's to pass: it reaches the user as it is.
        let said = self.live.as_ref().filter(|live| live.decoder.silent()).map(|live| live.decoder.refusal()).unwrap_or_default();
        let refused = self.live.as_ref().is_some_and(|live| live.decoder.silent()) && ((err.status == Some(429) && !said.quota) || said.provider);
        self.unknown_model = said.model;
        let secret = self.live.take().map(|live| live.secret).unwrap_or_default();
        err.message = crate::oauth::scrub::scrub_oauth_secrets(&err.message, &[&secret]);
        if refused && let Some((conversations, scope)) = &self.throttle {
            conversations.refused(scope);
        }
        self.queue.push_back(Err(err));
    }

    /// Writes back what the decoder answered the server, and tells the send the server's heartbeat arrived.
    fn flush_outbound(&mut self) {
        let live = self.live();
        let alive = live.decoder.take_liveness();
        for message in live.decoder.take_outbound() {
            // A closed request body surfaces as the response's own fault.
            let _ = live.sink.send(frame::encode(&message, 0));
        }
        if alive {
            self.identity.raise_stage("transport");
        }
    }

    /// `open`: the wire can still carry the results of a batch handed over now.
    fn push(&mut self, result: Result<Vec<StreamEvent>, ProviderError>, open: bool) {
        self.flush_outbound();
        let reading = &mut self.live().decoder;
        // The quiet stretch is counted from the last frame that was no heartbeat, whatever chunk carried it.
        let (stirred, awaited) = (reading.take_stir(), reading.awaits_quiet());
        if !awaited {
            self.quiet = None;
        } else if stirred {
            self.quiet = Some(Box::pin(mixdog_rt::ticker().wait_until(std::time::Instant::now() + decoder::QUIET)));
        }
        match result {
            Ok(events) => {
                self.queue.extend(events.into_iter().map(Ok));
                if self.live().decoder.terminal_seen() {
                    self.ended = true;
                    if let Some((conversations, scope)) = &self.throttle {
                        conversations.held(scope);
                    }
                    let mut live = self.live.take().expect("the run that answered");
                    live.decoder.leave();
                    match &self.waits {
                        // The server waits on the calls just handed over: the run stays open for their results.
                        Some((runs, scope)) if open && !live.decoder.handed().is_empty() => {
                            let parked = Parked::start(live, std::mem::take(&mut self.replay));
                            runs.insert(scope, &parked);
                            self.parked = Some(parked);
                        }
                        // A finished run is dropped: its request body ends and the response is reset.
                        _ => drop(live),
                    }
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
        if self.live().decoder.has_waiting() {
            let result = self.live().decoder.feed(&[]);
            return self.push(result, true);
        }
        if let Some(bytes) = self.replay.pop_front() {
            let result = self.live().decoder.feed(&bytes);
            return self.push(result, true);
        }
        self.live().decoder.caught_up();
        enum Woke {
            Chunk(Option<Result<Bytes, mixdog_core_api::domain::provider::TransportFault>>),
            Quiet,
            Beat,
        }
        let live = self.live.as_mut().expect("a stream that has not ended reads an open run");
        let quiet = &mut self.quiet;
        let woke = tokio::select! {
            biased;
            chunk = live.body.next() => Woke::Chunk(chunk),
            () = async {
                match quiet {
                    Some(quiet) => quiet.as_mut().await,
                    None => std::future::pending().await,
                }
            } => Woke::Quiet,
            () = &mut self.heartbeat => Woke::Beat,
        };
        let chunk = match woke {
            Woke::Chunk(chunk) => chunk,
            Woke::Quiet => {
                self.quiet = None;
                let events = self.live().decoder.quiet();
                return self.push(Ok(events), true);
            }
            Woke::Beat => {
                let _ = self.live().sink.send(frame::encode(&schema::heartbeat_message(), 0));
                return self.rearm_heartbeat();
            }
        };
        match chunk {
            Some(Ok(bytes)) => {
                let result = self.live().decoder.feed(&bytes);
                self.push(result, true);
            }
            Some(Err(fault)) => {
                let live = self.live();
                let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                err.exposure = live.decoder.exposure();
                err.connection = live.body.connection();
                self.fail(err);
            }
            None => {
                let result = self.live().decoder.finish();
                self.push(result, false);
                self.ended = true;
                self.live = None;
            }
        }
    }
}
