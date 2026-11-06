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
pub mod models;
pub mod request;
pub mod schema;
pub mod session;
#[cfg(test)]
mod listing_tests;

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
use crate::providers::connect::frame;
use crate::providers::listing_row;
use crate::transport::http::HttpSend;
use crate::providers::connect::stream::DecodedStream;

pub const PROVIDER_ID: &str = "devin-oauth";

/// The login the account holds: the stored session token, or the reason it
/// cannot be used (`reauth_required` when the user must sign in again).
#[async_trait]
pub trait SessionToken: Send + Sync {
    async fn session_token(&self) -> Result<String, ProviderError>;
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
        Self {
            provider: ProviderId::from(PROVIDER_ID),
            target,
        }
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
    encoder.finish().expect("finishing a Vec cannot fail")
}

impl WireCodec for DevinCodec {
    fn transport(&self) -> TransportKind {
        TransportKind::Http1
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
        );
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
        Box::new(DevinDecoder::new(
            self.provider.clone(),
            self.target.model.clone(),
            self.secrets(),
        ))
    }

    fn classify(&self, response: &ErrorResponse) -> ProviderError {
        error::http_error(response, decoder::OPERATION, &self.secrets())
    }
}

/// The catalog rows of one account.
struct Catalog {
    account: String,
    rows: HashMap<String, ModelRow>,
}

pub struct DevinAdapter {
    id: ProviderId,
    base_url: String,
    http: Arc<dyn HttpSend>,
    token: Arc<dyn SessionToken>,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    catalog: ArcSwapOption<Catalog>,
    /// A default codec only for the trait's `codec()` accessor: the codec of
    /// an attempt is built per account and per turn.
    placeholder: DevinCodec,
}

fn account_key(session_token: &str) -> String {
    Sha256::digest(session_token.as_bytes())
        .iter()
        .take(12)
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl DevinAdapter {
    pub fn new(base_url: Option<String>, http: Arc<dyn HttpSend>, token: Arc<dyn SessionToken>) -> Self {
        let base_url = base_url.unwrap_or_else(|| session::DEFAULT_BASE_URL.to_owned());
        Self {
            id: ProviderId::from(PROVIDER_ID),
            placeholder: DevinCodec::new(DevinTarget {
                base_url: base_url.clone(),
                model: String::new(),
                session: UserSession {
                    jwt: String::new(),
                    api_key: String::new(),
                    api_host: None,
                },
                chat_model_uid: String::new(),
                assignment_jwt: None,
                row: None,
                cascade_id: String::new(),
                execution_id: String::new(),
            }),
            base_url,
            http,
            token,
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            catalog: ArcSwapOption::empty(),
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
            self.catalog.store(Some(Arc::new(Catalog {
                account,
                rows: rows.iter().map(|r| (r.id.clone(), r.clone())).collect(),
            })));
        }
        Ok(rows)
    }

    /// One `GetCliModelConfigs` request: no cache.
    pub async fn fetch_rows(&self, session_token: &str) -> Result<Vec<ModelRow>, ProviderError> {
        let api_key = session::normalize_session_token(session_token);
        let body = schema::encode_metadata_request(&session::request_metadata(&api_key, "", Client::Discovery));
        let bytes = session::unary(
            self.http.as_ref(),
            &self.base_url,
            session::GET_CLI_MODEL_CONFIGS_PATH,
            body,
            &[api_key, session_token.to_owned()],
        )
        .await?;
        let configs = schema::decode_cli_model_configs(&bytes)
            .map_err(|e| error::protocol_error(&format!("malformed GetCliModelConfigsResponse: {e}")))?;
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
        let prompt = request::router_prompt(&request.messages, vision);
        let body = schema::encode_assign_model(&metadata, router_uid, cascade_id, prompt.as_ref());
        let bytes = session::unary(
            self.http.as_ref(),
            base,
            session::ASSIGN_MODEL_PATH,
            body,
            &[session.api_key.clone(), session.jwt.clone()],
        )
        .await?;
        let assignment = schema::decode_assign_model(&bytes)
            .map_err(|e| error::protocol_error(&format!("malformed AssignModelResponse: {e}")))?;
        if assignment.assignment_jwt.is_empty() || assignment.model_uid.is_empty() {
            return Err(error::protocol_error(
                "Devin AssignModel returned no assignment JWT and model uid",
            ));
        }
        Ok(assignment)
    }
}

fn random_uuid() -> String {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

#[async_trait]
impl ModelListing for DevinAdapter {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let token = self.token.session_token().await?;
        let rows = self.fetch_rows(&token).await?;
        Ok(rows.iter().map(|row| listing_row::record(listing::row(row))).collect())
    }
}

#[async_trait]
impl ProviderAdapter for DevinAdapter {
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
        let model = request.model.trim();
        if model.is_empty() {
            let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
            error.message = "Devin requires a model id. Pick a Devin model in Mixdog.".to_owned();
            return Err(error);
        }
        let token = self.token.session_token().await?;
        let rows = self.cached_rows(&token).await?;
        let row = rows.into_iter().find(|r| r.id == model);
        let session = session::exchange_user_jwt(self.http.as_ref(), &self.base_url, &token).await?;
        // The server threads turns that share one cascade id.
        let cascade_id = request
            .options
            .transport_scope
            .clone()
            .or_else(|| request.options.session_id.clone())
            .unwrap_or_else(random_uuid);
        let base = session.api_host.clone().unwrap_or_else(|| self.base_url.clone());
        let wire_uid = ModelRow::wire_uid(row.as_ref(), model, request.options.effort.as_deref());
        let assignment = match row.as_ref().filter(|r| r.router) {
            Some(router) => Some(
                self.assign_model(&session, &base, &wire_uid, &cascade_id, &request, router.supports_vision)
                    .await?,
            ),
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
        let head = self.http.send(wire).await?;
        if (300..400).contains(&head.status) {
            let mut error = error::protocol_error("Devin server redirected the request; redirects are refused");
            error.status = Some(head.status);
            return Err(error);
        }
        if !head.is_success() {
            let rejected = head.read_all().await?;
            return Err(codec.classify(&rejected));
        }
        Ok(Box::new(DecodedStream::new(head.body, codec.decoder(&request)).with_fault_code("unavailable")))
    }
}
