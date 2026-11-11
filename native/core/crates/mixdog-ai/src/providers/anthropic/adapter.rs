//! `ProviderAdapter` of `anthropic` and `anthropic-oauth`: exactly one request
//! attempt. The only replay inside an attempt is the credential recovery of
//! the initial response, decided on the status alone before a stream exists:
//! one credential refresh after a 401/403. A body is compressed exactly when
//! Node compresses it (official messages URL, at least 8 KiB), waiting for
//! lane room rather than ever skipping it; a gzip body refused with 400/415 is
//! sent once more plain, as Node's `sendWithCompression` does. The adapter also lists the route's models
//! ([`ModelListing`]): one GET, no retry, no cache, no fallback list.
//!
//! The HTTP exchange is the shared [`HttpSend`] seam of `transport::http`.

use crate::transport::deadlines::MODEL_STREAM;
use crate::transport::deadlines::ANTHROPIC_MODELS;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use flate2::Compression;
use flate2::GzBuilder;
use futures::future::BoxFuture;
use mixdog_core_api::domain::cache_warm::CacheWarmSend;
use mixdog_core_api::domain::cache_warm::cache_warm_request;
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
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;
use mixdog_rt::CpuBulk;
use mixdog_rt::LaneToken;
use tokio_util::sync::CancellationToken;

use crate::claude_floors;
use crate::claude_floors::Feature;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;
use crate::transport::preconnect::Preconnect;
use crate::transport::preconnect::Setting;

use crate::warmer::send::{Post, WarmContext, send_cache_warm};
use crate::warmer::stream::{WarmFailure, WarmUsage};
use super::before_output::BeforeOutput;
use super::fast_mode::CapacityError;
use super::fast_mode;
use super::betas::BetaFeatures;
use super::betas::beta_header;
use super::codec::ANTHROPIC_VERSION;
use super::codec::AnthropicCodec;
use super::codec::AnthropicConfig;
use super::codec::Flavor;
use super::codec::Plain;
use super::codec::beta_names;
use super::codec::layer_extra_headers;
use super::codec::threaded;
use super::threads;
use super::threads::Directive;
use super::threads::Mode;
use super::threads::Plan;
use super::threads::PlanInput;
use super::threads::ThreadSession;
use serde_json::Value;
use super::models::AnthropicModel;
use super::models::listing_url;
use super::models::parse_listing;
use super::oauth::OAuthSession;
use super::policy::retry_policy;

/// The compression job could not run to completion; nothing was sent.
fn gzip_failure(cause: &dyn std::fmt::Display) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    err.message = format!("request compression failed: {cause}");
    err
}

/// Request bodies at least this large are sent gzip-encoded.
const GZIP_MIN_BYTES: usize = 8 * 1024;

/// A compressor standing in for the gzip lane, as `createAnthropicApiKeyFetch({ compress })` takes one; set only by
/// tests ([`AnthropicAdapter::with_compressor`]).
pub type Compressor = Arc<dyn Fn(Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>, String>> + Send + Sync>;

/// The gzip header's operating-system byte Node's zlib writes (`OS_CODE` of zlib's `zutil.h`): the compressed body
/// is byte for byte Node's.
const GZIP_OS: u8 = if cfg!(windows) { 10 } else if cfg!(target_os = "macos") { 19 } else { 3 };

/// `officialMessagesUrl` (`anthropic-api-key-fetch.mjs:10-17`): the request goes to exactly
/// `https://api.anthropic.com` at path `/v1/messages`, decided on the final URL so a custom base, proxy or gateway
/// never gets a compressed body.
fn official_messages_url(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.origin().ascii_serialization() == ANTHROPIC_ORIGIN && u.path() == "/v1/messages")
}

/// `anthropicGzipLatch` (`request-compression.mjs:29`): set once a compressed body refused with 400/415 was accepted
/// plain; from then on no Anthropic body of this process is compressed.
static GZIP_LATCHED: AtomicBool = AtomicBool::new(false);

/// `anthropicGzipLatch.reset()` (`request-compression.mjs:23-25`), which only Node's tests call.
#[cfg(any(test, feature = "test-support"))]
pub fn reset_gzip_latch() {
    GZIP_LATCHED.store(false, Ordering::SeqCst);
}

/// `anthropicGzipLatch.disabled()` without the environment switch: whether a refused compressed body latched
/// compression off.
#[cfg(any(test, feature = "test-support"))]
pub fn gzip_latched() -> bool {
    GZIP_LATCHED.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

pub use crate::providers::key_source::ApiKeySource;

pub enum Credentials {
    ApiKey(Arc<dyn ApiKeySource>),
    OAuth(Arc<OAuthSession>),
}

/// The secret one request carries.
#[derive(Clone)]
struct Secret(String);

impl Credentials {
    async fn current(&self) -> Result<Secret, ProviderError> {
        match self {
            Self::ApiKey(source) => source.key().await.map(Secret),
            Self::OAuth(session) => session.access_token().await.map(Secret),
        }
    }

    /// The secret to replay with after the server rejected `rejected`, if
    /// there is a different one.
    async fn after_rejection(&self, rejected: &Secret) -> Result<Option<Secret>, ProviderError> {
        match self {
            Self::ApiKey(source) => {
                let key = source.reload().await?;
                Ok((key != rejected.0).then_some(Secret(key)))
            }
            Self::OAuth(session) => session.token_after_rejection(&rejected.0).await.map(|t| Some(Secret(t))),
        }
    }

    /// The account a thread belongs to (`threadAccountKey`): the key itself for an API key, the credential file
    /// for a subscription.
    fn thread_account(&self, provider: &str, base_url: &str, secret: &Secret) -> String {
        match self {
            Self::ApiKey(_) => threads::account_key(provider, &[base_url, &secret.0]),
            Self::OAuth(session) => threads::account_key(provider, &[&session.account()]),
        }
    }

    fn header(&self, secret: &Secret) -> (String, String) {
        match self {
            Self::ApiKey(_) => ("x-api-key".to_owned(), secret.0.clone()),
            // `postMessages` (`gzip-post.mjs:19`): the first header, spelled `Authorization`.
            Self::OAuth(_) => ("Authorization".to_owned(), format!("Bearer {}", secret.0)),
        }
    }

    /// Whether this refusal is one a credential refresh can fix. On the subscription wire, every 401 and only
    /// Anthropic's exact revoked-token 403 (`isRefreshableAuthRejection`, initial-status.mjs:20): any other 403 is a
    /// terminal policy refusal.
    fn refreshable(&self, status: Option<u16>, body: &[u8]) -> bool {
        match self {
            Self::ApiKey(_) => status == Some(401),
            Self::OAuth(_) => {
                status == Some(401)
                    || (status == Some(403) && String::from_utf8_lossy(body).contains("OAuth token has been revoked"))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

pub struct AnthropicAdapter {
    id: ProviderId,
    codec: AnthropicCodec,
    policy: RetryPolicy,
    keepalive: KeepaliveSchedule,
    http: Arc<dyn HttpSend>,
    credentials: Credentials,
    gzip_lane: CpuBulk,
    /// The subscription route's socket warm-up (`preconnect('https://api.anthropic.com')`).
    preconnect: Option<Preconnect>,
    /// The process settings the request reads (Node's `process.env`).
    settings: Setting,
    /// A test's compressor in place of the gzip lane.
    compressor: Option<Compressor>,
}

/// The origin the subscription route warms (`anthropic-oauth.mjs:352`, `:535`), whatever its base URL.
const ANTHROPIC_ORIGIN: &str = "https://api.anthropic.com";

impl AnthropicAdapter {
    /// Warms the messages API now, as the subscription provider's constructor does (`anthropic-oauth.mjs:352`), and
    /// again before each send (`_sendOnce`, `anthropic-oauth.mjs:535`).
    pub fn with_preconnect(mut self, preconnect: Preconnect) -> Self {
        preconnect.warm(ANTHROPIC_ORIGIN);
        self.preconnect = Some(preconnect);
        self
    }

    pub fn api_key(
        config: AnthropicConfig,
        http: Arc<dyn HttpSend>,
        keys: Arc<dyn ApiKeySource>,
        gzip_lane: CpuBulk,
    ) -> Self {
        Self::new(Flavor::ApiKey, config, http, Credentials::ApiKey(keys), true, gzip_lane)
    }

    /// `enterprise`: a pay-as-you-go subscription whose 429 is retried like an
    /// API key's; every other subscription surfaces a 429 at once.
    pub fn oauth(
        config: AnthropicConfig,
        http: Arc<dyn HttpSend>,
        session: Arc<OAuthSession>,
        enterprise: bool,
        gzip_lane: CpuBulk,
    ) -> Self {
        Self::new(Flavor::OAuth, config, http, Credentials::OAuth(session), enterprise, gzip_lane)
    }

    fn new(
        flavor: Flavor,
        config: AnthropicConfig,
        http: Arc<dyn HttpSend>,
        credentials: Credentials,
        retry_429: bool,
        gzip_lane: CpuBulk,
    ) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        Self {
            id: ProviderId::from(flavor.provider_name()),
            codec: AnthropicCodec::new(flavor, config),
            policy: retry_policy(retry_429),
            keepalive: KeepaliveSchedule::SPEC,
            http,
            credentials,
            gzip_lane,
            preconnect: None,
            settings: Arc::new(|name| std::env::var(name).ok()),
            compressor: None,
        }
    }

    /// Compresses with `compressor` instead of the gzip lane (Node's `compress` option of
    /// `createAnthropicApiKeyFetch`, which only its tests pass).
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_compressor(mut self, compressor: Compressor) -> Self {
        self.compressor = Some(compressor);
        self
    }

    /// The process settings read from `settings` instead of the process environment.
    pub fn with_settings(mut self, settings: Setting) -> Self {
        self.settings = settings;
        self
    }

    fn request_with(&self, wire: &WireRequest, secret: &Secret) -> WireRequest {
        let mut request = wire.clone();
        // A configured extra header of the credential's name already replaced it.
        let (name, value) = self.credentials.header(secret);
        if !request.headers.iter().any(|h| h.0.eq_ignore_ascii_case(&name)) {
            match self.credentials {
                Credentials::OAuth(_) => request.headers.insert(0, (name, value)),
                Credentials::ApiKey(_) => request.headers.push((name, value)),
            }
        }
        request
    }

    /// Compression is a bulk-CPU lane job and never skipped for load: this
    /// waits for lane room. Dropping the attempt cancels the wait, or the
    /// queued job, so a cancelled request compresses nothing.
    async fn gzip(&self, body: &[u8]) -> Result<Vec<u8>, ProviderError> {
        let raw = body.to_vec();
        if let Some(compress) = &self.compressor {
            return compress(raw).await.map_err(|e| gzip_failure(&e));
        }
        let cancel = CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let job = self
            .gzip_lane
            .submit_wait(&cancel, move |_| {
                let mut encoder = GzBuilder::new().operating_system(GZIP_OS).write(Vec::new(), Compression::default());
                encoder.write_all(&raw)?;
                encoder.finish()
            })
            .await
            .map_err(|e| gzip_failure(&e))?;
        job.await
            .map_err(|e| gzip_failure(&e))?
            .map_err(|e| gzip_failure(&e))
    }

    /// One POST of `wire` with the credential.
    async fn post(&self, wire: &WireRequest, secret: &Secret) -> Result<HttpResponse, ProviderError> {
        self.fetch(self.request_with(wire, secret)).await
    }

    /// The client's `fetch` (`createAnthropicApiKeyFetch`, the subscription's `postMessages`): one request, compressed
    /// as `sendWithCompression` compresses it (`request-compression.mjs:75-82`): a POST to the official messages URL
    /// with a body of at least `GZIP_MIN_BYTES` that carries no `content-encoding`, unless the process latch or
    /// `MIXDOG_ANTHROPIC_REQ_GZIP=0` turned compression off; a compression failure sends the body plain. A 400/415 to
    /// the compressed body is drained and the same request sent once plain; when that plain send succeeds,
    /// compression is off for the rest of the process.
    pub async fn fetch(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
        let wire = &request;
        let eligible = wire.method.eq_ignore_ascii_case("POST")
            && official_messages_url(&wire.url)
            && wire.body.len() >= GZIP_MIN_BYTES
            && !GZIP_LATCHED.load(Ordering::SeqCst)
            && (self.settings)("MIXDOG_ANTHROPIC_REQ_GZIP").as_deref() != Some("0")
            && !request.headers.iter().any(|h| h.0.eq_ignore_ascii_case("content-encoding"));
        if !eligible {
            return self.http.send(request, MODEL_STREAM).await;
        }
        let Ok(packed) = self.gzip(&wire.body).await else {
            return self.http.send(request, MODEL_STREAM).await;
        };
        let mut compressed = request.clone();
        compressed.body = packed;
        // `withContentEncoding` drops the plain body's `content-length` and appends `Content-Encoding` after the
        // request's own headers (`request-compression.mjs:39-48`).
        compressed.headers.retain(|h| !h.0.eq_ignore_ascii_case("content-length"));
        compressed.headers.push(("Content-Encoding".to_owned(), "gzip".to_owned()));
        let response = self.http.send(compressed, MODEL_STREAM).await?;
        if !matches!(response.status, 400 | 415) {
            return Ok(response);
        }
        // Drained best-effort before the plain resend (`resendIfEncodingRejected`), which goes out on the same turn of
        // Node's event loop and so finds the refusal's socket still busy.
        let held = response.read_all_held().await.ok();
        let retry = self.http.send(request, MODEL_STREAM).await;
        drop(held);
        let retry = retry?;
        if retry.is_success() {
            GZIP_LATCHED.store(true, Ordering::SeqCst);
        }
        Ok(retry)
    }

    /// The body to replay at standard speed after `rejected` refused the fast request `body`, when
    /// the refusal switches fast mode down (`dropFastSpeedAfter`): the same body without `speed`
    /// (the betas stay). `None` for a request that did not ask for fast speed or a refusal that
    /// leaves fast mode alone.
    fn after_fast_refusal(&self, body: &[u8], rejected: &ErrorResponse) -> Option<Vec<u8>> {
        let mut parsed: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(body).ok()?;
        if parsed.get("speed").and_then(serde_json::Value::as_str) != Some("fast") {
            return None;
        }
        let message = String::from_utf8_lossy(&rejected.body);
        let refusal = CapacityError {
            status: rejected.status.unwrap_or(0),
            message: &message,
            headers: &rejected.headers,
            retry_after_ms: None,
        };
        if !self.codec.config().fast_mode.note_capacity_error(&refusal, true, fast_mode::now_ms()).downgraded() {
            return None;
        }
        parsed.shift_remove("speed");
        serde_json::to_vec(&parsed).ok()
    }

    /// Whether `rejected` refused a version-floor feature of the request (`anthropicCapabilityReplay`): the feature is
    /// then switched off for the model on this route and the request is to be encoded again, once per feature and
    /// attempt. Nothing has streamed yet.
    fn floor_rejected(&self, request: &ModelRequest, status: Option<u16>, text: &str, replayed: &mut Vec<Feature>) -> bool {
        let Some(feature) = claude_floors::rejection(status, text) else { return false };
        if replayed.contains(&feature) {
            return false;
        }
        replayed.push(feature);
        claude_floors::mark_unsupported(feature, self.codec.flavor().provider_name(), &request.model);
        true
    }

    /// The thread plan of a request, when it threads at all: a create, a continue of the conversation's stored
    /// response, or unthreaded.
    fn plan(&self, request: &ModelRequest, plain: &Plain, secret: &Secret, directive: Option<Directive>) -> Option<Plan> {
        let scope = self.codec.thread_scope(request)?;
        let body: Value = serde_json::from_slice(&plain.wire.body).ok()?;
        let config = self.codec.config();
        let provider = self.codec.flavor().provider_name();
        Some(config.threads.plan(PlanInput {
            provider,
            scope,
            body: &body,
            betas: &beta_names(&plain.wire),
            account: &self.credentials.thread_account(provider, &config.base_url, secret),
            cache_ttls: &self.codec.cache_ttls(request),
            now: super::oauth::now_ms(),
            directive,
            send_group: request.options.send_group.as_deref(),
        }))
    }

    /// `issueNonStreamingFallback` (anthropic-api-recovery.mjs:41-64): the request once more without streaming, under
    /// the non-streaming timeout, its whole response as the turn's events.
    async fn non_streaming(&self, request: &ModelRequest, wire: &WireRequest, secret: &Secret) -> Result<Box<dyn ModelStream>, ProviderError> {
        let mut wire = wire.clone();
        if let Some(body) = super::nonstream::body(&wire.body) {
            wire.body = body;
        }
        wire.headers.push(("x-stainless-timeout".to_owned(), super::nonstream::TIMEOUT_SECONDS.to_owned()));
        let read = self.post(&wire, secret).await?.read_all().await?;
        if !read.status.is_some_and(|status| (200..300).contains(&status)) {
            return Err(self.codec.classify(&read));
        }
        let message: Value = serde_json::from_slice(&read.body).map_err(|e| {
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            err.message = format!("Anthropic non-streaming response is not JSON: {e}");
            err
        })?;
        Ok(Box::new(AnthropicStream::ready(super::nonstream::events(&self.id, &request.model, &message))))
    }

    async fn failure(&self, response: HttpResponse) -> ProviderError {
        match response.read_all().await {
            Ok(rejected) => self.codec.classify(&rejected),
            Err(err) => err,
        }
    }

    /// A refused warm's error, worded as `anthropicQuotaError` words it for both routes.
    async fn warm_failure(&self, response: HttpResponse, secret: &Secret) -> ProviderError {
        match response.read_all().await {
            Ok(rejected) => {
                let mut error = self.codec.classify(&rejected);
                error.message = super::errors::quota_error_text(&rejected, &[&secret.0]);
                error
            }
            Err(err) => err,
        }
    }

    /// One `GET /v1/models`: no retry, no credential replay, no cache.
    async fn fetch_listing(&self) -> Result<Vec<u8>, ProviderError> {
        let flavor = self.codec.flavor();
        let secret = self.credentials.current().await?;
        let mut headers = vec![("anthropic-version".to_owned(), ANTHROPIC_VERSION.to_owned())];
        if flavor == Flavor::OAuth {
            headers.push((
                "anthropic-beta".to_owned(),
                beta_header(flavor, BetaFeatures::default()),
            ));
            headers.push(("anthropic-dangerous-direct-browser-access".to_owned(), "true".to_owned()));
            headers.push((
                "user-agent".to_owned(),
                format!("claude-cli/{} (external, sdk-cli)", self.codec.config().cli_version),
            ));
            headers.push(("x-app".to_owned(), "cli".to_owned()));
        } else {
            layer_extra_headers(&mut headers, &self.codec.config().extra_headers);
        }
        let wire = WireRequest {
            transport: TransportKind::Http1,
            method: "GET".to_owned(),
            url: listing_url(flavor, self.codec.config()),
            headers,
            body: Vec::new(),
        };
        let response = self
            .http
            .send(self.request_with(&wire, &secret), ANTHROPIC_MODELS)
            .await?;
        if !(200..300).contains(&response.status) {
            return Err(self.failure(response).await);
        }
        response.read_all().await.map(|read| read.body)
    }

    /// The listed models with everything the route's normalizer derives
    /// (family, tier, `latest`, release date, thinking types).
    pub async fn list_rows(&self) -> Result<Vec<AnthropicModel>, ProviderError> {
        let body = self.fetch_listing().await?;
        parse_listing(&body, self.codec.flavor(), &self.codec.config().caps).map_err(|e| {
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            err.message = format!("model listing is not JSON: {e}");
            err
        })
    }
}

/// Cache-warm mode (`sendCacheWarm`): the request `attempt` would build for the warm of `request`
/// (output capped at one token), POSTed once and plain: no retry, credential replay, fallback
/// model or re-send, no compression, and the stream cut at the first content block. The account
/// gate may skip it; the response is read by the warmer's stream reader.
#[async_trait]
impl CacheWarmSend for AnthropicAdapter {
    async fn send_cache_warm(
        &self,
        request: &ModelRequest,
        ctx: &WarmContext<'_>,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure> {
        // A warm never threads: Node builds its body with the plain request builder.
        let wire = self.codec.encode_plain(&cache_warm_request(request)).map_err(|e| WarmFailure::new(e.message))?.wire;
        let secret = self.credentials.current().await.map_err(|e| WarmFailure::new(e.message))?;
        let post: Post<'_> = Box::new(move || {
            Box::pin(async move {
                let response = self.http.send(self.request_with(&wire, &secret), MODEL_STREAM).await?;
                if response.is_success() { Ok(response) } else { Err(self.warm_failure(response, &secret).await) }
            })
        });
        send_cache_warm(ctx, cancel, post, on_usage).await
    }
}

#[async_trait]
impl ModelListing for AnthropicAdapter {
    async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let rows = self.list_rows().await?.iter().map(AnthropicModel::to_record).collect();
        let listing = &self.codec.config().listing;
        // Node's order (`anthropic.mjs:478`, `anthropic-model-resolve.mjs:231`); both routes
        // sanitize as `anthropic`, the subscription route's rows keep their own provider name.
        let enriched = listing.enrich_listed(self.codec.flavor().provider_name(), rows);
        Ok(listing.sanitize_listed("anthropic", enriched))
    }
}

#[async_trait]
impl ProviderAdapter for AnthropicAdapter {
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

    fn models(&self) -> Option<&dyn ModelListing> {
        Some(self)
    }

    fn cache_warm(&self) -> Option<&dyn CacheWarmSend> {
        Some(self)
    }

    /// The API-key route's `[<provider name>] retry attempt <n> after <message>, delay <ms>ms` (anthropic-api-transport.mjs:203-206,
    /// `label: this.name`, anthropic.mjs:411). The OAuth route writes a line of its own shape (anthropic-oauth-request.mjs:146).
    fn retry_line(&self, _model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        use mixdog_core_api::domain::provider::RetryLine;
        use mixdog_core_api::domain::provider::RetryLineStyle;
        Some(match self.codec.flavor() {
            Flavor::ApiKey => RetryLine { tag: format!("[{}]", self.id), delay: true, style: RetryLineStyle::Attempt },
            Flavor::OAuth => RetryLine { tag: format!("[{}]", self.id), delay: true, style: RetryLineStyle::OfMax },
        })
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        if let Some(preconnect) = &self.preconnect {
            preconnect.warm(ANTHROPIC_ORIGIN);
        }
        let mut plain = self.codec.encode_plain(&request)?;
        let mut secret = self.credentials.current().await?;
        let mut refreshed = false;
        let mut directive = None;
        let mut floor_replays = Vec::new();
        // A threaded request the API refuses over its thread is planned again, as a create or unthreaded.
        'plan: loop {
            let mut plan = self.plan(&request, &plain, &secret, directive);
            let mut wire = match &plan {
                Some(plan) if plan.mode != Mode::None => threaded(&plain.wire, &plan.body, &plan.betas),
                _ => plain.wire.clone(),
            };
            let mut speed_dropped = false;
            loop {
                let response = self.post(&wire, &secret).await?;
                if (200..300).contains(&response.status) {
                    let thread = plan.as_mut().and_then(Plan::take_session);
                    let stream = Box::new(AnthropicStream::new(response.body, self.codec.decoder(&request)).with_thread(thread));
                    // OAuth replays only a rejected initial response (`_resendAfterRejection`).
                    if self.codec.flavor() != Flavor::ApiKey {
                        return Ok(stream);
                    }
                    let opened = BeforeOutput::read(stream).await;
                    if let Some(err) = opened.failure()
                        && self.floor_rejected(&request, err.status, &err.message, &mut floor_replays)
                    {
                        // A fresh send (`withAnthropicCapabilityFallback`): its thread is planned again, with no directive.
                        directive = None;
                        plain = self.codec.encode_plain(&request)?;
                        continue 'plan;
                    }
                    return Ok(Box::new(opened));
                }
                let rejected = response.read_all().await?;
                // A fast-pool refusal (or "Fast mode is not enabled") says nothing about standard-speed
                // capacity: the cooldown is recorded, `speed` is dropped and the request replayed once
                // at once, instead of waiting out a window only the fast pool owns.
                if !speed_dropped
                    && let Some(standard) = self.after_fast_refusal(&wire.body, &rejected)
                {
                    wire.body = standard;
                    speed_dropped = true;
                    continue;
                }
                if self.floor_rejected(&request, rejected.status, &String::from_utf8_lossy(&rejected.body), &mut floor_replays) {
                    directive = None;
                    plain = self.codec.encode_plain(&request)?;
                    continue 'plan;
                }
                let mut err = self.codec.classify(&rejected);
                if !refreshed && self.credentials.refreshable(err.status, &rejected.body) {
                    refreshed = true;
                    if self.codec.flavor() == Flavor::OAuth {
                        mixdog_rt::node_stderr!("[anthropic-oauth] {} — forcing refresh and retrying once", rejected.status.unwrap_or(0));
                    }
                    if let Some(next) = self.credentials.after_rejection(&secret).await? {
                        secret = next;
                        continue;
                    }
                }
                if refreshed && err.status == Some(401) && err.kind == ErrorKind::Auth {
                    // The grant was refreshed and is still refused.
                    err.reauth_required = true;
                }
                let refusal = String::from_utf8_lossy(&rejected.body);
                if let Some(next) = plan.as_ref().and_then(|plan| plan.classify(rejected.status.unwrap_or(0), &refusal)) {
                    directive = Some(next);
                    plain = self.codec.encode_plain(&request)?;
                    continue 'plan;
                }
                // A gateway that 404s the streaming endpoint but serves non-streaming: one non-streaming re-issue,
                // nothing having streamed yet (anthropic.mjs:363-368).
                if self.codec.flavor() == Flavor::ApiKey && rejected.status == Some(404) {
                    return self.non_streaming(&request, &wire, &secret).await;
                }
                if self.codec.flavor() == Flavor::OAuth && rejected.status == Some(429) {
                    // `anthropicQuotaError(status, headers, scrubTokens(text))` (initial-status.mjs:90): the quota wording
                    // over the scrubbed body, never the body's own message.
                    err.message = super::errors::quota_error_text(&rejected, &[&secret.0]);
                } else if self.codec.flavor() == Flavor::OAuth {
                    // `judgeInitialStatus` (initial-status.mjs:101) words a transient status alone; any other refusal
                    // is worded and logged by `_handleHttpError` (anthropic-oauth.mjs:862, :949).
                    let status = rejected.status.unwrap_or(0);
                    if matches!(err.kind, ErrorKind::Transient | ErrorKind::Overloaded) {
                        err.message = format!("Anthropic OAuth API {status}");
                    } else {
                        // `scrubTokens(text).slice(0, 200)`: a credential the server echoed is redacted before it is logged or returned.
                        let shown = crate::oauth::scrub::scrubbed_prefix(&refusal, &[&secret.0], 200);
                        mixdog_rt::node_stderr!("[anthropic-oauth] API error {status}: {shown}");
                        err.message = format!("Anthropic OAuth API {status}: {shown}");
                    }
                }
                return Err(err);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

struct AnthropicStream {
    body: Option<Box<dyn BodyStream>>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
    /// The last usage report handed to the consumer, carried by a later error.
    last_usage: Option<Usage>,
    /// A threaded send's hold on its conversation; dropped with the stream (or on failure), which gives the
    /// conversation back.
    thread: Option<ThreadSession>,
}

impl AnthropicStream {
    fn new(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self {
            body: Some(body),
            decoder,
            queue: VecDeque::new(),
            failed: None,
            last_usage: None,
            thread: None,
        }
    }

    /// A turn already whole: its events, then the end.
    fn ready(events: Vec<StreamEvent>) -> Self {
        Self {
            body: None,
            decoder: Box::new(super::decoder::AnthropicDecoder::for_model(ProviderId::from(""), "")),
            queue: events.into(),
            failed: None,
            last_usage: None,
            thread: None,
        }
    }

    fn with_thread(mut self, thread: Option<ThreadSession>) -> Self {
        self.thread = thread;
        self
    }

    /// The response ended: the thread records it when the API confirmed storing it.
    fn complete_thread(&mut self) {
        if let Some(thread) = self.thread.take() {
            thread.complete(self.body.take());
        }
    }

    fn enqueue(&mut self, events: Vec<StreamEvent>) {
        for event in &events {
            if let StreamEvent::Usage(usage) = event {
                self.last_usage = Some(usage.clone());
            }
        }
        self.queue.extend(events);
    }

    fn fail(&mut self, mut err: ProviderError) {
        self.body = None;
        self.thread = None;
        // Node carries a turn's partial usage on a stream that was cut (a read failure, a stall, a truncation:
        // anthropic-sse-turn/turn-outcome.mjs `partialFields`), not on an error the provider sent in the stream
        // (`_anthropicSseError`, anthropic-sse.mjs:138), whose usage no ledger sees.
        if err.transport.is_some() {
            err.partial_usage = self.last_usage.clone().map(Box::new);
        }
        self.failed = Some(err);
    }
}

#[async_trait]
impl ModelStream for AnthropicStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(event) = self.queue.pop_front() {
                return Some(Ok(event));
            }
            if let Some(err) = self.failed.take() {
                return Some(Err(err));
            }
            let body = self.body.as_mut()?;
            // The terminal event ends the attempt; whatever else the body
            // carries (pings) is dropped with it.
            if self.decoder.terminal_seen() {
                self.body = None;
                return None;
            }
            match body.next().await {
                Some(Ok(chunk)) => {
                    if let Some(thread) = self.thread.as_mut() {
                        thread.feed(&chunk);
                    }
                    match self.decoder.feed(&chunk) {
                        Ok(events) => {
                            self.enqueue(events);
                            // An error held back behind this chunk's events
                            // surfaces now, not when the next chunk arrives.
                            if let Err(err) = self.decoder.feed(&[]) {
                                self.fail(err);
                            } else if self.decoder.terminal_seen() {
                                self.complete_thread();
                            }
                        }
                        Err(err) => self.fail(err),
                    }
                }
                Some(Err(fault)) => {
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    self.fail(err);
                }
                None => {
                    self.body = None;
                    match self.decoder.finish() {
                        Ok(events) => {
                            self.enqueue(events);
                            self.complete_thread();
                        }
                        Err(err) => self.fail(err),
                    }
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    /// A leaf: `next` awaits nothing after the wire's terminal event.
    fn on_wire_left(&mut self, _left: Arc<dyn Fn() + Send + Sync>) {}
}
