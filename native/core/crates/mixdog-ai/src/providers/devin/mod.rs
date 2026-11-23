//! `devin-oauth`: chat models through a Devin account over the Cascade
//! `GetChatMessage` server stream (Connect + protobuf).
//!
//! Per attempt: the stored session token becomes a fresh user JWT, a router
//! model is assigned (`AssignModel`), the transcript is lowered into one
//! request, and the gzip Connect frames decode into stream events. Tool
//! calls are reported once the end-stream trailer arrived.
#![allow(clippy::result_large_err, reason = "ProviderError is the contract's error type")]

pub mod auth;
pub mod decoder;
pub mod error;
pub mod families;
pub mod listing;
#[cfg(test)]
mod listing_tests;
pub mod login;
#[cfg(test)]
mod login_tests;
pub mod models;
pub mod request;
pub mod schema;
pub mod session;
#[cfg(test)]
mod stall_tests;

use crate::transport::deadlines::DEVIN_STREAM;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;

use arc_swap::ArcSwapOption;
use async_trait::async_trait;
use flate2::Compression;
use flate2::write::GzEncoder;
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
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_js::locale_compare;
use mixdog_protocol::ProviderId;
use sha2::Digest;
use sha2::Sha256;

use self::decoder::DevinDecoder;
use self::models::ModelRow;
use self::request::ChatParams;
use self::request::build_chat_request;
use self::session::Client;
use self::session::UserSession;
use crate::providers::compat::adapter::shared_first_byte_gate;
use crate::providers::compat::adapter::stream_call;
use crate::providers::connect::frame;
use crate::providers::connect::stream::DecodedStream;
use crate::providers::first_byte::FirstByteSettings;
use crate::providers::listing_row;
use crate::transport::http::HttpSend;
use crate::transport::model_driver::ModelDriver;

pub const PROVIDER_ID: &str = "devin-oauth";
/// The two-row fallback seed native discovery returns for seats it cannot serve.
const DISCOVERY_SEED_UIDS: [&str; 2] = ["swe-1-6", "swe-1-6-fast"];

/// The login the account holds: the stored session token, or the reason it
/// cannot be used (`reauth_required` when the user must sign in again).
#[async_trait]
pub trait SessionToken: Send + Sync {
    async fn session_token(&self) -> Result<String, ProviderError>;

    /// The account this login belongs to: what stays the same when its session token is replaced and differs between
    /// accounts (the credential file, the identity the sign-in returned).
    fn account(&self) -> String;
}

/// Everything a codec needs for one turn of one account.
#[derive(Clone)]
pub struct DevinTarget {
    pub base_url: String,
    /// The catalog model id the turn was asked for (replay identity).
    pub model: String,
    pub session: UserSession,
    pub chat_model_uid: String,
    pub assignment_jwt: Option<String>,
    pub row: Option<ModelRow>,
    pub cascade_id: String,
    pub execution_id: String,
}

pub struct DevinCodec {
    provider: ProviderId,
    target: DevinTarget,
}

impl DevinCodec {
    pub fn new(target: DevinTarget) -> Self {
        Self { provider: ProviderId::from(PROVIDER_ID), target }
    }

    fn secrets(&self) -> Vec<String> {
        let t = &self.target;
        let mut secrets = vec![t.session.api_key.clone(), t.session.jwt.clone()];
        secrets.extend(t.assignment_jwt.clone());
        secrets.extend(t.session.api_key.strip_prefix(session::SESSION_TOKEN_PREFIX).map(str::to_owned));
        secrets
    }
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).expect("writing to a Vec cannot fail");
    let mut out = encoder.finish().expect("finishing a Vec cannot fail");
    // The header's OS byte, as Node's zlib writes it for the host (`OS_CODE`: 10 on Windows, 3 on Unix).
    out[9] = if cfg!(windows) { 10 } else { 3 };
    out
}

/// The catalog rows of one account.
struct Catalog {
    account: String,
    rows: HashMap<String, ModelRow>,
}

fn account_key(session_token: &str) -> String {
    Sha256::digest(session_token.as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// `DevinOAuthProvider.send` runs no retry ladder (devin.mjs:383-431: no `withRetry`), so no row retries: every failure
/// ends the send.
fn no_retry_policy() -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    for row in [&mut policy.request, &mut policy.midstream, &mut policy.transport, &mut policy.connection] {
        row.schedule.max_retries = 0;
        row.by_kind.clear();
    }
    policy.recovery = None;
    policy
}

fn random_uuid() -> String {
    let bytes: [u8; 16] = crate::random::bytes();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

pub struct DevinAdapter {
    id: ProviderId,
    base_url: String,
    /// The transport of the unary RPCs (the JWT exchange, discovery, `AssignModel`).
    http: Arc<dyn HttpSend>,
    /// The transport of the chat stream: its phase deadlines are the driver's.
    driver: ModelDriver,
    /// The stream windows, from the environment as Node reads it.
    first_byte: FirstByteSettings,
    token: Arc<dyn SessionToken>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    catalog: ArcSwapOption<Catalog>,
    /// The rows the last listing stored, which `getCachedModelInfo` answers.
    rows: crate::catalog::RowStore,
    /// A default codec only for the trait's `codec()` accessor: the codec of
    /// an attempt is built per account and per turn.
    placeholder: DevinCodec,
}
impl DevinAdapter {
    pub fn new(base_url: Option<String>, http: Arc<dyn HttpSend>, token: Arc<dyn SessionToken>) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        let base_url = base_url.unwrap_or_else(|| session::DEFAULT_BASE_URL.to_owned());
        Self {
            id: ProviderId::from(PROVIDER_ID),
            placeholder: DevinCodec::new(DevinTarget {
                base_url: base_url.clone(),
                model: String::new(),
                session: UserSession { jwt: String::new(), api_key: String::new(), api_host: None },
                chat_model_uid: String::new(),
                assignment_jwt: None,
                row: None,
                cascade_id: String::new(),
                execution_id: String::new(),
            }),
            base_url,
            driver: ModelDriver::new(http.clone()),
            first_byte: FirstByteSettings::process(),
            http,
            token,
            policy: no_retry_policy(),
            keepalive: KeepaliveSchedule::SPEC,
            catalog: ArcSwapOption::empty(),
            rows: crate::catalog::RowStore::default(),
        }
    }

    /// The account's model rows, fetched once per account for the turns that
    /// send to one of them. An empty answer is not kept: the next lookup asks
    /// again.
    pub async fn cached_rows(&self, session_token: &str) -> Result<Vec<ModelRow>, ProviderError> {
        let account = account_key(session_token);
        if let Some(catalog) = self.catalog.load_full()
            && catalog.account == account
        {
            let mut rows: Vec<_> = catalog.rows.values().cloned().collect();
            rows.sort_by(|a, b| locale_compare(&a.id, &b.id));
            return Ok(rows);
        }
        let rows = self.fetch_rows(session_token).await?;
        if !rows.is_empty() {
            self.catalog.store(Some(Arc::new(Catalog { account, rows: rows.iter().map(|r| (r.id.clone(), r.clone())).collect() })));
        }
        Ok(rows)
    }

    /// The user JWT exchange of this provider's account for `session_token`.
    pub(crate) async fn user_session(&self, session_token: &str) -> Result<UserSession, ProviderError> {
        session::exchange_user_jwt(self.http.as_ref(), &self.base_url, &self.token.account(), session_token).await
    }

    /// `fetchDevinModels`: the native dev-channel identity first; when it fails, answers nothing or only the
    /// fallback seed, the legacy editor identity with the raw token is asked, and its rows win only when native
    /// failed or they are strictly more. One 5 s deadline covers both. No cache.
    pub async fn fetch_rows(&self, session_token: &str) -> Result<Vec<ModelRow>, ProviderError> {
        let deadline = std::time::Instant::now() + DISCOVERY_DEADLINE;
        let native_key = session::normalize_session_token(session_token);
        let native = self.discovery_attempt(&native_key, Client::Discovery, session_token, deadline).await;
        let seed_only = |rows: &[ModelRow]| !rows.is_empty() && rows.iter().all(|row| DISCOVERY_SEED_UIDS.contains(&row.id.as_str()));
        if let Ok(rows) = &native
            && !rows.is_empty()
            && !seed_only(rows)
        {
            return native;
        }
        let legacy = self.discovery_attempt(session_token, Client::Legacy, session_token, deadline).await;
        let legacy_wins = match (&native, &legacy) {
            (_, Err(_)) => false,
            (Err(_), Ok(_)) => true,
            (Ok(native), Ok(legacy)) => legacy.len() > native.len(),
        };
        if legacy_wins { legacy } else { native }
    }

    /// One `GetCliModelConfigs` request under the shared deadline.
    async fn discovery_attempt(
        &self,
        api_key: &str,
        client: Client,
        session_token: &str,
        deadline: std::time::Instant,
    ) -> Result<Vec<ModelRow>, ProviderError> {
        let body = schema::encode_metadata_request(&session::request_metadata(api_key, "", client));
        let secrets = [api_key.to_owned(), session_token.to_owned()];
        let request = session::unary(self.http.as_ref(), &self.base_url, session::GET_CLI_MODEL_CONFIGS_PATH, body, &secrets);
        let bytes = match mixdog_rt::time::timeout(deadline.saturating_duration_since(std::time::Instant::now()), request).await {
            Ok(answer) => answer?,
            Err(_) => {
                let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
                error.code = Some("unavailable".to_owned());
                error.message = format!("Devin model discovery timed out after {} ms", DISCOVERY_DEADLINE.as_millis());
                return Err(error);
            }
        };
        let configs = schema::decode_cli_model_configs(&bytes).map_err(|e| error::protocol_error(&format!("malformed GetCliModelConfigsResponse: {e}")))?;
        Ok(models::normalize_models(&configs))
    }

    /// A router row is not a chat model: `AssignModel` resolves it, per turn,
    /// into a concrete uid plus the JWT that authorizes it on the chat that
    /// shares the cascade id. An incomplete assignment fails the turn.
    async fn assign_model(
        &self,
        session: &UserSession,
        base: &str,
        router_uid: &str,
        cascade_id: &str,
        request: &ModelRequest,
        vision: bool,
    ) -> Result<schema::ModelAssignment, ProviderError> {
        let metadata = session::request_metadata(&session.api_key, "", Client::Cli);
        let prompt = request::router_prompt(&request.messages, vision)?;
        let body = schema::encode_assign_model(&metadata, router_uid, cascade_id, prompt.as_ref());
        let bytes = session::unary(self.http.as_ref(), base, session::ASSIGN_MODEL_PATH, body, &[session.api_key.clone(), session.jwt.clone()]).await?;
        let assignment = schema::decode_assign_model(&bytes).map_err(|e| error::protocol_error(&format!("malformed AssignModelResponse: {e}")))?;
        if assignment.assignment_jwt.is_empty() || assignment.model_uid.is_empty() {
            return Err(error::protocol_error("Devin AssignModel returned no assignment JWT and model uid"));
        }
        Ok(assignment)
    }
}
#[async_trait]
impl ModelListing for DevinAdapter {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let token = self.token.session_token().await?;
        let rows = self.fetch_rows(&token).await?;
        let listed: Vec<ModelRecord> = rows.iter().map(|row| listing_row::record(listing::row(row))).collect();
        self.rows.replace(listed.iter().map(|row| std::sync::Arc::new(crate::catalog::stored_row(&self.id, row.clone()))).collect());
        Ok(listed)
    }
}
#[async_trait]
impl ProviderAdapter for DevinAdapter {
    fn release_send(&self, _group: &str) {}
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

    /// The model's catalog row says whether it has vision (`modelRow?.supportsVision`); a row that cannot be read leaves
    /// the images to the attempt, which fails on the same lookup.
    async fn takes_vision(&self, request: &ModelRequest) -> bool {
        let Ok(token) = self.token.session_token().await else { return true };
        let Ok(rows) = self.cached_rows(&token).await else { return true };
        rows.into_iter().find(|r| r.id == request.model.trim()).is_some_and(|r| r.supports_vision)
    }

    fn retry_policy(&self) -> &RetryPolicy {
        &self.policy
    }

    /// `DevinOAuthProvider.send` runs no retry ladder of its own (devin.mjs:383-431: no `withRetry`, no `onRetry`), so
    /// it raises no `reconnecting`.
    fn send_stages(&self, _model: &str) -> mixdog_core_api::domain::provider::SendStages {
        mixdog_core_api::domain::provider::SendStages { reconnecting: false, ..Default::default() }
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let model = request.model.trim();
        if model.is_empty() {
            let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
            error.message = "Devin requires a model id. Pick a Devin model in Mixdog.".to_owned();
            return Err(error);
        }
        let token = self.token.session_token().await?;
        let rows = self.cached_rows(&token).await?;
        let row = rows.into_iter().find(|r| r.id == model);
        let session = self.user_session(&token).await?;
        // The server threads turns that share one cascade id.
        let cascade_id = request.options.transport_scope.clone().or_else(|| request.options.session_id.clone()).unwrap_or_else(random_uuid);
        let base = session.api_host.clone().unwrap_or_else(|| self.base_url.clone());
        let wire_uid = ModelRow::wire_uid(row.as_ref(), model, request.options.effort.as_deref());
        let assignment = match row.as_ref().filter(|r| r.router) {
            Some(router) => Some(self.assign_model(&session, &base, &wire_uid, &cascade_id, &request, router.supports_vision).await?),
            None => None,
        };
        let codec = DevinCodec::new(DevinTarget {
            base_url: self.base_url.clone(),
            model: model.to_owned(),
            session,
            chat_model_uid: assignment.as_ref().map_or(wire_uid, |a| a.model_uid.clone()),
            assignment_jwt: assignment.map(|a| a.assignment_jwt),
            row,
            cascade_id,
            execution_id: random_uuid(),
        });
        let wire = codec.encode(&request)?;
        // `_streamTurn` raises `requesting` once the chat request is built, before it is sent (devin.mjs:383).
        request.options.send_identity.raise_requesting_once();
        // `transportError` (`devin-wire-transport.mjs:243-261`) words what the raw `fetch` threw.
        // The chat stream is consumed as a Chat Completions stream (`consumeCompatChatCompletionStream`, devin.mjs:404):
        // its first-byte, first-output and idle windows, labelled with the provider's name.
        let identity = &request.options.send_identity;
        let gate = shared_first_byte_gate(&self.first_byte, identity, PROVIDER_ID.to_owned());
        let call = stream_call(PROVIDER_ID.to_owned(), &self.first_byte, identity, Some(gate), false);
        let (head, handle) = self.driver.send(&call, wire, DEVIN_STREAM).await.map_err(|error| error::connection_failed(error, &[]))?;
        if (300..400).contains(&head.status) {
            let mut error = error::protocol_error("Devin server redirected the request; redirects are refused");
            error.status = Some(head.status);
            return Err(error);
        }
        if !head.is_success() {
            let rejected = head.read_all().await?;
            return Err(codec.classify(&rejected));
        }
        // `reportTransport` as the stream opens (openai-compat-chat-stream.mjs:75).
        identity.raise_transport();
        Ok(Box::new(
            DecodedStream::new(head.body, codec.decoder(&request))
                .driven(handle, identity.clone())
                .with_billed_usage(request.model.trim().to_owned())
                .with_fault_code("unavailable")
                .with_fault_prefix("Devin connection failed: "),
        ))
    }
}
impl crate::catalog::CachedModelInfo for DevinAdapter {
    fn cached_row(&self, model: &str) -> Option<std::sync::Arc<serde_json::Value>> {
        self.rows.find(model)
    }
}

/// `DEVIN_DISCOVERY_TIMEOUT_MS`: the whole discovery, native and legacy together.
const DISCOVERY_DEADLINE: std::time::Duration = std::time::Duration::from_millis(5_000);
impl WireCodec for DevinCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
    }
    fn image_branch(&self, _: &ModelRequest) -> mixdog_image_egress::route::WireBranch {
        mixdog_image_egress::route::WireBranch::InlineOnly
    }

    fn encode(&self, request: &ModelRequest) -> Result<WireRequest, ProviderError> {
        let t = &self.target;
        let chat = build_chat_request(
            request,
            &ChatParams {
                provider: &self.provider,
                model: &request.model,
                chat_model_uid: &t.chat_model_uid,
                assignment_jwt: t.assignment_jwt.as_deref(),
                row: t.row.as_ref(),
                metadata: session::request_metadata(&t.session.api_key, &t.session.jwt, Client::Cli),
                cascade_id: &t.cascade_id,
                execution_id: &t.execution_id,
            },
        )?;
        let host = t.session.api_host.as_deref().unwrap_or(&t.base_url);
        Ok(WireRequest {
            transport: TransportKind::Http1,
            method: "POST".to_owned(),
            url: session::join_url(host, session::CHAT_PATH),
            headers: session::stream_headers(),
            body: frame::encode(&gzip(&chat.encode()), frame::COMPRESSED),
        })
    }

    fn decoder(&self, _request: &ModelRequest) -> Box<dyn WireDecoder> {
        let decoder = DevinDecoder::new(self.provider.clone(), self.target.model.clone(), self.secrets());
        Box::new(if self.target.assignment_jwt.is_some() { decoder.with_assignment(&self.target.chat_model_uid) } else { decoder })
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        error::http_error(response, decoder::OPERATION, &self.secrets())
    }
}
