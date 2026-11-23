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

use crate::transport::deadlines::ANTHROPIC_MODELS;
use crate::transport::deadlines::MODEL_STREAM;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use crate::cache_tail::AdmittedWrite;
use crate::transport::link::Exchange;
use async_trait::async_trait;
use flate2::Compression;
use flate2::GzBuilder;
use futures::future::BoxFuture;
use mixdog_core_api::domain::cache_tail::{Admission, Counters, Purpose, TailRoute, Verdict, WireManifest};

/// The permit a write went out under, with the gate that issued it: the write's usage is settled on it, once.
type Tail = Option<AdmittedWrite>;

/// What a transcript-carrying write is admitted by, immediately before its bytes go out ([`AnthropicAdapter::dispatch`]):
/// the request, the cache layout of its body, the credential the write carries and what it is for.
struct Admit<'a> {
    request: &'a ModelRequest,
    manifest: Option<&'a Arc<WireManifest>>,
    secret: &'a Secret,
    purpose: Purpose,
    /// Whether this POST's `requesting` stage was raised (or has none to raise): raised by its first admitted write, so a
    /// write the cache owner refuses, which requests nothing, shows none.
    announced: std::sync::atomic::AtomicBool,
    /// The speed the plain body of this write carries (`fast`, else empty), noted as the attempt's dispatched tier once the
    /// write is admitted: the dispatched bytes may be a compressed copy, which no longer states it.
    speed: &'static str,
}

impl Admit<'_> {
    fn quiet(announced: bool) -> std::sync::atomic::AtomicBool {
        std::sync::atomic::AtomicBool::new(announced)
    }
}

/// `fast` when the Messages body asks for fast-mode speed, else empty (standard).
fn body_speed(body: &[u8]) -> &'static str {
    #[derive(serde::Deserialize)]
    struct Sent {
        speed: Option<String>,
    }
    match serde_json::from_slice::<Sent>(body) {
        Ok(Sent { speed: Some(speed) }) if speed == "fast" => "fast",
        _ => "",
    }
}

/// What a body's cache layout is read off: the map the encoder sent, or the bytes a refit left.
enum Layout {
    Map(serde_json::Map<String, Value>),
    Sent(Vec<u8>),
}

use mixdog_core_api::domain::cache_warm::CacheWarmSend;
use mixdog_core_api::domain::cache_warm::cache_warm_request;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Boundary;
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
use crate::providers::connect::rewrite::Attempt;
use crate::providers::connect::rewrite::Credential;
use crate::providers::connect::rewrite::RewriteCodec;
use crate::providers::connect::rewrite::Rewriter;
use crate::transport::http::BodyStream;
use crate::transport::http::HttpResponse;
use crate::transport::http::HttpSend;
use crate::transport::link::Redirect;
use crate::transport::link::Surface;
use crate::transport::link::deadline_error;
use crate::transport::model_driver::Expiry;
use crate::transport::model_driver::ModelCall;
use crate::transport::model_driver::ModelDriver;
use crate::transport::preconnect::Preconnect;
use crate::transport::preconnect::Setting;
use mixdog_core_api::domain::provider::AttemptHandle;
use mixdog_core_api::domain::provider::AttemptPhase;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::MediaSupport;
use mixdog_core_api::domain::provider::PhaseWindows;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_rt::Expired;

use super::before_output::BeforeOutput;
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
use super::fast_mode;
use super::fast_mode::CapacityError;
use super::models::AnthropicModel;
use super::models::listing_url;
use super::models::parse_listing;
use super::oauth::OAuthSession;
use super::policy::retry_policy;
use super::threads;
use super::threads::Directive;
use super::threads::Mode;
use super::threads::Plan;
use super::threads::PlanInput;
use super::threads::ThreadSession;
use crate::warmer::send::{Post, WarmContext, send_cache_warm};
use crate::warmer::stream::{WarmFailure, WarmUsage};
use serde_json::Value;

/// The compression job could not run to completion; nothing was sent.
fn gzip_failure(cause: &dyn std::fmt::Display) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    err.message = format!("request compression failed: {cause}");
    err
}

/// Observe the warm reader's evidence before its accounting totals collapse omissions into zeroes.
#[derive(Default)]
struct WarmCacheEvidence {
    pending: Vec<u8>,
    counters: Counters,
    reported: bool,
    ended: bool,
}

impl WarmCacheEvidence {
    fn feed(&mut self, chunk: &[u8]) {
        if self.ended {
            return;
        }
        let mut start = self.pending.len().saturating_sub(1);
        self.pending.extend_from_slice(chunk);
        while let Some(end) = self.pending[start..].windows(2).position(|pair| pair == b"\n\n") {
            let frame: Vec<_> = self.pending.drain(..start + end + 2).collect();
            start = 0;
            let text = String::from_utf8_lossy(&frame);
            let data = text.split('\n').filter_map(|line| line.strip_prefix("data:").map(mixdog_js::js_trim_start)).collect::<Vec<_>>().join("\n");
            let Ok(event) = serde_json::from_str::<Value>(&data) else { continue };
            let kind = event.get("type").and_then(Value::as_str);
            // Stop at the same frame as the warm reader, even if more frames arrived in this chunk.
            if event.is_null()
                || event.get("error").is_some_and(crate::providers::js_value::truthy)
                || matches!(kind, Some("error" | "message_stop"))
                || (kind == Some("content_block_start") && self.reported)
            {
                self.ended = true;
                self.pending.clear();
                return;
            }
            let usage = match kind {
                Some("message_start") => event.get("message").and_then(|message| message.get("usage")),
                Some("message_delta") => event.get("usage"),
                _ => None,
            };
            let Some(usage) = usage.filter(|value| value.is_object() || value.is_array()) else { continue };
            self.reported = true;
            let cache = usage.get("cache_creation").unwrap_or(&Value::Null);
            let keep = |held: &mut Option<u64>, raw: &Value, name| {
                if let Some(tokens) = raw.get(name).and_then(Value::as_u64) {
                    *held = Some(tokens);
                }
            };
            keep(&mut self.counters.read, usage, "cache_read_input_tokens");
            keep(&mut self.counters.created, usage, "cache_creation_input_tokens");
            keep(&mut self.counters.created_5m, cache, "ephemeral_5m_input_tokens");
            keep(&mut self.counters.created_1h, cache, "ephemeral_1h_input_tokens");
        }
    }
}

struct WarmCacheBody {
    body: Box<dyn BodyStream>,
    evidence: WarmCacheEvidence,
    write: Tail,
}

impl Drop for WarmCacheBody {
    fn drop(&mut self) {
        if let Some(write) = self.write.take() {
            write.settle(self.evidence.reported.then_some(self.evidence.counters));
        }
    }
}

#[async_trait]
impl BodyStream for WarmCacheBody {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        let next = self.body.next().await;
        if let Some(Ok(chunk)) = &next {
            self.evidence.feed(chunk);
        }
        next
    }
}

/// Request bodies at least this large are sent gzip-encoded.
const GZIP_MIN_BYTES: usize = 8 * 1024;

/// A compressor standing in for the gzip lane, as `createAnthropicApiKeyFetch({ compress })` takes one; set only by
/// tests ([`AnthropicAdapter::with_compressor`]).
pub type Compressor = Arc<dyn Fn(Vec<u8>) -> BoxFuture<'static, Result<Vec<u8>, String>> + Send + Sync>;

/// The gzip header's operating-system byte Node's zlib writes (`OS_CODE` of zlib's `zutil.h`): the compressed body
/// is byte for byte Node's.
const GZIP_OS: u8 = if cfg!(windows) {
    10
} else if cfg!(target_os = "macos") {
    19
} else {
    3
};

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

// Credentials

pub use crate::providers::key_source::ApiKeySource;

pub enum Credentials {
    ApiKey(Arc<dyn ApiKeySource>),
    OAuth(Arc<OAuthSession>),
    /// A gateway's or a custom provider's Messages engine: the engine's own credential header (or none), placed and
    /// refreshed as the engine's credential says.
    Engine(Arc<dyn Credential>),
}

/// The secret one request carries, for a subscription the login it was served under, and for an engine the attempt
/// its credential served.
#[derive(Clone)]
struct Secret(String, Option<super::oauth::Attempt>, Option<EngineSent>);

/// What an engine's credential served one request on, and whether that attempt's login was renewed for it.
#[derive(Clone)]
struct EngineSent {
    attempt: Attempt,
    exchanged: bool,
}

impl Secret {
    fn of(attempt: super::oauth::Attempt) -> Self {
        Self(attempt.access_token.clone(), Some(attempt), None)
    }

    /// An engine's attempt; the secret redacted from its refusals is the key its header carries.
    fn sent(attempt: Attempt, exchanged: bool) -> Self {
        let value = attempt.header.as_ref().map_or("", |(_, value)| value.as_str());
        let key = value.strip_prefix("Bearer ").unwrap_or(value).to_owned();
        Self(key, None, Some(EngineSent { attempt, exchanged }))
    }

    /// The engine's attempt was served on a login renewed for it.
    fn exchanged(&self) -> bool {
        self.2.as_ref().is_some_and(|sent| sent.exchanged)
    }
}

impl Credentials {
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn current(&self) -> Result<Secret, ProviderError> {
        match self {
            Self::ApiKey(source) => source.key().await.map(|key| Secret(key, None, None)),
            Self::OAuth(session) => session.attempt().await.map(Secret::of),
            Self::Engine(credential) => credential.attempt().await.map(|attempt| Secret::sent(attempt, false)),
        }
    }

    /// The secret to replay with after the server rejected `rejected`, if
    /// there is a different one.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn after_rejection(&self, rejected: &Secret) -> Result<Option<Secret>, ProviderError> {
        match self {
            Self::ApiKey(source) => {
                let key = source.reload().await?;
                Ok((key != rejected.0).then_some(Secret(key, None, None)))
            }
            Self::OAuth(session) => match &rejected.1 {
                Some(attempt) => session.after_rejection(attempt).await.map(|next| Some(Secret::of(next))),
                None => Ok(None),
            },
            Self::Engine(credential) => {
                let Some(sent) = &rejected.2 else { return Ok(None) };
                // The refusal is of the attempt this request was sent on; the same refused header is not sent again, unless
                // the credential resends whatever the refresh gave.
                let next = credential.after_rejection(&sent.attempt).await?;
                Ok((next.attempt.header != sent.attempt.header || !credential.resend_needs_new()).then(|| Secret::sent(next.attempt, next.exchanged)))
            }
        }
    }

    /// The account a thread belongs to (`threadAccountKey`): the key itself for an API key, the credential file
    /// for a subscription.
    fn thread_account(&self, provider: &str, base_url: &str, secret: &Secret) -> String {
        match self {
            Self::ApiKey(_) | Self::Engine(_) => threads::account_key(provider, &[base_url, &secret.0]),
            Self::OAuth(session) => threads::account_key(provider, &[&session.account()]),
        }
    }

    fn header(&self, secret: &Secret) -> Option<(String, String)> {
        match self {
            Self::ApiKey(_) => Some(("x-api-key".to_owned(), secret.0.clone())),
            // `postMessages` (`gzip-post.mjs:19`): the first header, spelled `Authorization`.
            Self::OAuth(_) => Some(("Authorization".to_owned(), format!("Bearer {}", secret.0))),
            Self::Engine(_) => secret.2.as_ref().and_then(|sent| sent.attempt.header.clone()),
        }
    }

    /// Whether this refusal is one a credential refresh can fix. On the subscription wire, every 401 and only
    /// Anthropic's exact revoked-token 403 (`isRefreshableAuthRejection`, initial-status.mjs:20): any other 403 is a
    /// terminal policy refusal.
    fn refreshable(&self, status: Option<u16>, body: &[u8]) -> bool {
        match self {
            Self::ApiKey(_) => status == Some(401),
            Self::OAuth(_) => status == Some(401) || (status == Some(403) && String::from_utf8_lossy(body).contains("OAuth token has been revoked")),
            Self::Engine(credential) => {
                !crate::providers::compat::login::opencode_go::gateway_owns_auth_recovery()
                    && status.is_some_and(|status| credential.refreshes_on(status, body))
            }
        }
    }
}

// Adapter

/// The retry counts `CLAUDE_CODE_MAX_RETRIES` can name (0..=100).
const BUDGET_COUNTS: usize = 101;

pub struct AnthropicAdapter {
    id: ProviderId,
    codec: AnthropicCodec,
    policy: RetryPolicy,
    /// The policy of a `claude-opus-*` send on the API-key route, where repeated overloads end the send.
    opus_policy: Option<RetryPolicy>,
    /// The request-row budgets `CLAUDE_CODE_MAX_RETRIES` has asked for, by count and policy: the setting is read on every
    /// request (`anthropicMaxAttempts`), and a count is built once. One slot per count (0..=100) for each of the two policies, owned by the adapter.
    budgets: Vec<std::sync::OnceLock<Box<RetryPolicy>>>,
    keepalive: KeepaliveSchedule,
    /// The transport of every model exchange: its phase deadlines are the driver's; listings and cache warms go through
    /// [`ModelDriver::aux`] and begin no attempt.
    driver: ModelDriver,
    credentials: Credentials,
    gzip_lane: CpuBulk,
    /// The subscription route's socket warm-up (`preconnect('https://api.anthropic.com')`).
    preconnect: Option<Preconnect>,
    /// The process settings the request reads (Node's `process.env`).
    settings: Setting,
    /// `prepareAnthropicImages`' resizer: every inline image of a request is fitted before it is built.
    images: Option<super::images::ImageFitter>,
    /// A test's compressor in place of the gzip lane.
    compressor: Option<Compressor>,
    /// What a gateway's or a custom provider's Messages engine declares apart from the API-key route it inherits.
    engine: Option<Engine>,
}

/// A Messages engine of another provider (`GatewayMessagesEngine extends AnthropicProvider`, wire-gateway.mjs:58; a custom
/// provider's class on the anthropic protocol, custom-provider.mjs:162): the API-key route's request, stream, windows and
/// recoveries under the provider's own name, base URL and credential header. Its writes go to no cache owner and it warms
/// no cache: the native routes' cache tail is not its own.
struct Engine {
    /// Edits each request the codec encoded (a custom provider's fields and headers), before its images are fitted.
    rewriter: Option<Arc<dyn Rewriter>>,
    /// [`ProviderAdapter::codec`] of a rewritten engine: the codec with the rewrite applied.
    view: Option<Arc<dyn WireCodec>>,
    media: MediaSupport,
    listing: Option<Arc<dyn ModelListing>>,
    input_excludes_cache: Option<bool>,
}

/// The origin the subscription route warms (`anthropic-oauth.mjs:352`, `:535`), whatever its base URL.
const ANTHROPIC_ORIGIN: &str = "https://api.anthropic.com";

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
        let warm = cache_warm_request(request);
        // The provider renders the thinking configuration into the prompt, so every message entry is keyed on it. A
        // budget must stay under `max_tokens`: the one-token cap drops it, and that warm would read no message entry and
        // write one no turn reads. It is not sent.
        if self.thinking_of(&warm) != self.thinking_of(request) {
            return Err(WarmFailure::new(
                "cache warm not sent: the one-token cap changes this request's thinking configuration, which its cache entries are keyed on",
            ));
        }
        // A warm never threads: Node builds its body with the plain request builder.
        let plain = self.plain(&warm).await.map_err(|e| WarmFailure::new(e.into_message()))?;
        let secret = self.credentials.current().await.map_err(|e| WarmFailure::new(e.into_message()))?;
        let wire = plain.wire;
        let manifest = plain.manifest;
        // Admitted inside the POST, after the warmer's own lane and account checks: a warm never compacts, and on a cold,
        // unproven or rewritten tail at that moment it is not sent.
        let warm_ref = &warm;
        let post: Post<'_> = Box::new(move || {
            Box::pin(async move {
                // A cache warm is no model attempt: the driver's auxiliary transport, timed by its own exchange, plain.
                let admit =
                    Admit { request: warm_ref, manifest: manifest.as_ref(), secret: &secret, purpose: Purpose::Warm, announced: Admit::quiet(true), speed: "" };
                let (mut response, _, write) = self.dispatch(Route::Aux, self.request_with(&wire, &secret), Some(&admit)).await?;
                if !response.is_success() {
                    drop(write);
                    return Err(self.warm_failure(response, &secret).await);
                }
                if write.is_some() {
                    response.body = Box::new(WarmCacheBody { body: response.body, evidence: WarmCacheEvidence::default(), write });
                }
                Ok(response)
            })
        });
        send_cache_warm(ctx, cancel, post, on_usage).await
    }
}

#[async_trait]
impl ModelListing for AnthropicAdapter {
    /// The subscription route's roster is the signed-in user's (`identity.id`), listed from the endpoint it asks; an
    /// organization alone names no user, so a credential without a user id names no account. An API key's list is not tied
    /// to one.
    async fn roster_identity(&self) -> mixdog_core_api::domain::provider::RosterIdentity {
        let Credentials::OAuth(session) = &self.credentials else { return Default::default() };
        let identity = session.stored().await.ok().and_then(|stored| stored.identity);
        let user = identity.as_ref().and_then(|i| i.get("id")).and_then(Value::as_str).filter(|s| !s.is_empty());
        mixdog_core_api::domain::provider::RosterIdentity {
            account: user.map(|id| crate::catalog::account_fingerprint(&[id])),
            endpoint: Some(listing_url(self.codec.flavor(), self.codec.config())),
            client_version: None,
        }
    }

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
    fn release_send(&self, _group: &str) {}
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        match self.engine.as_ref().and_then(|engine| engine.view.as_deref()) {
            Some(view) => view,
            None => &self.codec,
        }
    }

    fn retry_policy(&self) -> &RetryPolicy {
        self.budgeted(&self.policy, false)
    }

    /// The API-key route takes a PDF as a document block; an engine declares its own (`GatewayMessagesEngine.nativePdf`).
    fn native_pdf(&self) -> bool {
        self.engine.as_ref().is_none_or(|engine| engine.media.native_pdf)
    }

    fn native_documents(&self) -> Option<bool> {
        self.engine.as_ref().and_then(|engine| engine.media.native_documents)
    }

    fn input_excludes_cache(&self) -> Option<bool> {
        self.engine.as_ref().and_then(|engine| engine.input_excludes_cache)
    }

    /// `isTerminalOverloadModel`: `^claude-opus-` after trimming and lowercasing.
    fn retry_policy_for(&self, model: &str) -> &RetryPolicy {
        match &self.opus_policy {
            Some(policy) if model.trim().to_lowercase().starts_with("claude-opus-") => self.budgeted(policy, true),
            _ => self.budgeted(&self.policy, false),
        }
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        &self.keepalive
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        match &self.engine {
            Some(engine) => engine.listing.as_deref(),
            None => Some(self),
        }
    }

    fn cache_warm(&self) -> Option<&dyn CacheWarmSend> {
        if self.engine.is_some() { None } else { Some(self) }
    }

    /// The API-key route's `[<provider name>] retry attempt <n> after <message>, delay <ms>ms` (anthropic-api-transport.mjs:203-206,
    /// `label: this.name`, anthropic.mjs:411). The OAuth route writes a line of its own shape (anthropic-oauth-request.mjs:146).
    fn retry_line(&self, _model: &str) -> Option<mixdog_core_api::domain::provider::RetryLine> {
        use mixdog_core_api::domain::provider::RetryLine;
        use mixdog_core_api::domain::provider::RetryLineStyle;
        Some(match self.codec.flavor() {
            Flavor::ApiKey => RetryLine { tag: format!("[{}]", self.id), delay: true, style: RetryLineStyle::AnthropicApi },
            Flavor::OAuth => RetryLine { tag: format!("[{}]", self.id), delay: true, style: RetryLineStyle::OfMax },
        })
    }

    /// `decideStreamError` (anthropic-midstream-recovery.mjs), the two branches that end in the non-streaming
    /// re-issue: a stream that died after text or thinking was shown (`recoverNonStreaming`, once the owner withdrew it)
    /// and a stall that exposed nothing (`classifier === 'stream_stalled'`). A dispatched tool call is a replay
    /// boundary, and a cut while a tool input was streaming is the loop's split-call replay.
    fn recovers_cut(&self, _request: &ModelRequest, failure: &ProviderError) -> bool {
        let exposure = failure.exposure;
        if exposure.tool_dispatched || exposure.tool_input_cut {
            return false;
        }
        exposure.text_emitted || failure.timeout_phase.is_some()
    }

    /// `issueNonStreamingFallback` for a stream that died: the same request once more without streaming. Its failure
    /// ends the send's recovery (`markProviderRecoveryExhausted`).
    async fn recover_spent(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let exhausted = |mut err: ProviderError| {
            err.recovery_exhausted = true;
            err
        };
        let plain = self.plain(&request).await.map_err(exhausted)?;
        let secret = self.credentials.current().await.map_err(exhausted)?;
        self.non_streaming(&request, &plain.wire, &secret, plain.manifest.as_ref()).await
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        self.attempt_model(request, false, false).await
    }
}

// Stream

struct AnthropicStream {
    body: Option<Box<dyn BodyStream>>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<StreamEvent>,
    failed: Option<ProviderError>,
    /// The last usage report handed to the consumer, carried by a later error.
    last_usage: Option<Usage>,
    /// The turn's decoder, asked for its blocks when the stream is cut (`partialAssistantBlocks`).
    partial: Option<super::decoder::Shared>,
    /// A threaded send's hold on its conversation; dropped with the stream (or on failure), which gives the
    /// conversation back.
    thread: Option<ThreadSession>,
    /// The credential the request was sent with: an error event that echoes it is redacted.
    secret: Option<String>,
    /// The send this stream answers: each body chunk read marks transport on it.
    identity: Option<mixdog_core_api::domain::provider::SendIdentity>,
    /// The attempt this stream answers: `message_start` and the output are reported on it, and the driver, which owns the
    /// body this stream reads, follows the deadlines they install. The stream runs no timer of its own.
    attempt: Option<AttemptHandle>,
    /// The cache owner's permit of this attempt: the input usage goes back on it once the response ends, is cut, or the
    /// stream is dropped.
    tail: Tail,
}

impl Drop for AnthropicStream {
    fn drop(&mut self) {
        self.settle_tail();
    }
}

/// Where a request goes: a model request is an attempt of the driver, anything else (the `fetch` client the replays drive)
/// begins none.
#[derive(Clone, Copy)]
enum Route<'a> {
    Model(&'a ModelCall),
    Aux,
}

/// The failure of `expiry` for a stream labelled `label`: the head and the non-streaming total are the transport's own
/// timeout (the SDK's `headersTimeout`, `Connection error.`); the first-payload wait is the empty stream
/// (`armFirstMessageTimer`: `EEMPTYSTREAM`, no `message_start` within the window); the first-output and idle windows are the
/// stall (`streamStalledError`, `stall-policy.mjs:161`: `ESTREAMSTALL`, unsafe to retry once a tool call was dispatched).
fn expired(label: &str, expiry: Expiry, delivery: DeliveryState, exposure: Exposure) -> ProviderError {
    let ms = expiry.window.as_millis();
    match expiry.phase {
        AttemptPhase::Connect | AttemptPhase::Head | AttemptPhase::Recovery => {
            let mut err = deadline_error(Expired { after: expiry.window }, delivery, Surface::Sdk);
            err.exposure = exposure;
            err
        }
        AttemptPhase::Payload => {
            let mut err = ProviderError::new(ErrorKind::Transient, delivery);
            err.code = Some("EEMPTYSTREAM".into());
            err.message = format!("{label} SSE stream produced no message_start within {ms}ms");
            err.timed_out = true;
            err.timeout_phase = Some(StreamTimeoutPhase::FirstChunk);
            err.exposure = exposure;
            err
        }
        AttemptPhase::FirstOutput | AttemptPhase::Idle | AttemptPhase::Retired => {
            let mut err = ProviderError::new(ErrorKind::Transient, delivery);
            err.code = Some("ESTREAMSTALL".into());
            err.message = format!("{label} SSE stream timed out after {ms}ms of inactivity");
            mixdog_rt::node_stderr!("[provider-stall] {} (tool dispatched: {})", err.message, exposure.tool_dispatched);
            err.timed_out = true;
            err.timeout_phase = Some(StreamTimeoutPhase::Idle);
            err.exposure = exposure;
            err.unsafe_to_retry = exposure.tool_dispatched;
            err
        }
    }
}

#[cfg(test)]
mod idle_tests {
    use std::time::Duration;

    use mixdog_core_api::domain::provider::AttemptPhase;
    use mixdog_core_api::domain::provider::SendIdentity;

    use super::*;
    use crate::providers::anthropic::decoder::AnthropicDecoder;
    use crate::providers::anthropic::decoder::Shared;
    use crate::providers::anthropic::tests::FixedKey;
    use crate::providers::anthropic::tests::ScriptedHttp;
    use crate::providers::anthropic::tests::config;
    use crate::providers::anthropic::tests::cpu_bulk;
    use crate::providers::idle::testing::Timetable;
    use crate::transport::link::Exchange;

    /// A transport that answers each request's head after `head_after[n]` seconds with a body that delivers `chunks[n]` on its
    /// timetable and then stays silent.
    struct Script {
        head_after: Vec<u64>,
        chunks: Vec<Vec<(u64, &'static str)>>,
        next: std::sync::atomic::AtomicUsize,
    }

    impl Script {
        fn of(head_after: &[u64], chunks: &[&[(u64, &'static str)]]) -> Arc<Self> {
            Arc::new(Self { head_after: head_after.to_vec(), chunks: chunks.iter().map(|c| c.to_vec()).collect(), next: 0.into() })
        }
    }

    fn wire() -> WireRequest {
        WireRequest { transport: TransportKind::Http1, method: "POST".into(), url: "http://x.test/".into(), headers: Vec::new(), body: Vec::new() }
    }

    fn adapter() -> AnthropicAdapter {
        AnthropicAdapter::api_key(config("https://api.anthropic.com"), ScriptedHttp::new(Vec::new()), Arc::new(FixedKey), cpu_bulk())
    }

    fn model_call(adapter: &AnthropicAdapter, identity: &SendIdentity) -> ModelCall {
        let mut request = crate::providers::anthropic::tests::request(
            vec![crate::providers::anthropic::tests::text_message(mixdog_core_api::domain::provider::Role::User, "hi")],
            mixdog_core_api::domain::provider::RequestOptions::default(),
        );
        request.options.send_identity = identity.clone();
        adapter.model_call(&request, false)
    }

    fn shared() -> Shared {
        Shared::new(AnthropicDecoder::for_model(ProviderId::from("anthropic"), "claude-sonnet-4-6"))
    }

    /// One model submission through the driver, read through the adapter's stream.
    #[allow(clippy::result_large_err, reason = "a test helper")]
    async fn open(script: Arc<Script>, call: &ModelCall, identity: &SendIdentity) -> Result<AnthropicStream, ProviderError> {
        let (response, attempt) = ModelDriver::new(script).send(call, wire(), MODEL_STREAM).await?;
        let decoder = shared();
        Ok(AnthropicStream::new(response.body, Box::new(decoder.clone())).with_partial(decoder).with_identity(identity.clone()).with_attempt(attempt))
    }

    async fn failure(stream: &mut AnthropicStream) -> ProviderError {
        loop {
            match stream.next().await.expect("the window ends the stream") {
                Ok(_) => continue,
                Err(err) => break err,
            }
        }
    }

    const MESSAGE_START: &str =
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":1}}}\n\n";
    struct OpenBody {
        first: Option<&'static [u8]>,
        waiting: Option<tokio::sync::oneshot::Sender<()>>,
    }

    #[async_trait]
    impl BodyStream for OpenBody {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            if let Some(first) = self.first.take() {
                return Some(Ok(bytes::Bytes::from_static(first)));
            }
            if let Some(waiting) = self.waiting.take() {
                let _ = waiting.send(());
            }
            std::future::pending().await
        }
    }

    #[tokio::test]
    async fn cancel_before_first_output_records_the_message_start_usage() {
        use crate::catalog::{PricedUsage, UsageArgs};
        use crate::registry::accounted::{AccountedAdapter, AccountingDeps};
        use crate::registry::accounting::{UsagePricing, UsageRow, UsageSink};

        struct Http(std::sync::Mutex<Option<OpenBody>>);
        #[async_trait]
        impl HttpSend for Http {
            async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
                let body = self.0.lock().unwrap().take().expect("one POST");
                Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(body) })
            }
        }
        struct Pricing;
        impl UsagePricing for Pricing {
            fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
                PricedUsage { input: args.input_tokens, cost_usd: None, rates: Default::default() }
            }
        }
        struct Ledger(tokio::sync::mpsc::UnboundedSender<UsageRow>);
        #[async_trait]
        impl UsageSink for Ledger {
            async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
                self.0.send(row).map_err(|e| e.to_string())
            }
        }

        let (waiting, read) = tokio::sync::oneshot::channel();
        let http = Arc::new(Http(std::sync::Mutex::new(Some(OpenBody {
            first: Some(b"data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-served\",\"usage\":{\"input_tokens\":4,\"cache_read_input_tokens\":8}}}\n\n"),
            waiting: Some(waiting),
        }))));
        let (record, mut rows) = tokio::sync::mpsc::unbounded_channel();
        let ledger: Arc<dyn UsageSink> = Arc::new(Ledger(record));
        let deps = AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(ledger.clone())));
        let api = AnthropicAdapter::api_key(config("https://api.anthropic.com"), http, Arc::new(FixedKey), cpu_bulk());
        let adapter = AccountedAdapter::wrap(Arc::new(api), "anthropic", Arc::new(deps));
        let request = crate::providers::anthropic::tests::request(Vec::new(), Default::default());
        {
            let opening = adapter.attempt(Arc::new(request));
            tokio::pin!(opening);
            tokio::select! {
                ready = read => ready.expect("the opener asked for the next chunk"),
                _ = &mut opening => panic!("no visible output or terminal event was sent"),
            }
        }
        let row = mixdog_rt::time::timeout(Duration::from_secs(10), rows.recv()).await.expect("cancellation records usage").expect("row");
        assert_eq!((row.model.as_str(), row.cache_read, row.output), ("claude-served", 8.0, 0.0));
        assert!(rows.try_recv().is_err(), "no second settlement");
    }

    #[tokio::test]
    async fn dropping_a_warm_body_settles_only_the_cache_evidence_it_read() {
        let clock = Arc::new(std::sync::atomic::AtomicI64::new(1));
        let gate = crate::cache_tail::Books::default().gate(
            "warm-drop",
            None,
            crate::cache_tail::GateSettings {
                clock: {
                    let clock = clock.clone();
                    Arc::new(move || clock.load(Ordering::SeqCst))
                },
                auto_clear: Arc::new(|| true),
                sizing: 1,
                fresh: false,
                last_send_at: Some(1),
            },
        );
        let route = TailRoute("anthropic|fixture".into());
        let manifest = crate::cache_tail::manifest::anthropic(&serde_json::json!({
            "messages": [{"role":"user","content":[{"type":"text","text":"prompt","cache_control":{"type":"ephemeral"}}]}]
        }));
        let Verdict::Send(permit) =
            gate.0.admit(Admission { purpose: Purpose::Warm, route: &route, manifest: &manifest, generation: None, unreduced: None }).await
        else {
            panic!("the session's tail is live")
        };
        let mut body = WarmCacheBody {
            body: Box::new(OpenBody {
                first: Some(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":9,\"cache_creation\":{\"ephemeral_5m_input_tokens\":9,\"ephemeral_1h_input_tokens\":0}}}}\n\n"),
                waiting: None,
            }),
            evidence: WarmCacheEvidence::default(),
            write: Some(AdmittedWrite::new(gate.clone(), permit)),
        };
        assert!(matches!(body.next().await, Some(Ok(_))));
        {
            let mut next = std::pin::pin!(body.next());
            assert!(futures::poll!(&mut next).is_pending());
        }
        // Dropping the warm reader also drops its body, even though no terminal frame arrived.
        drop(body);
        let snapshot = gate.0.snapshot().expect("drop settled the observed write");
        let held: Vec<&Value> = snapshot["receipts"].as_object().unwrap().values().flat_map(|route| route.as_object().unwrap().values()).collect();
        assert_eq!(held.len(), 1);
        assert_eq!(held[0]["extent"], 9);
    }

    #[test]
    fn warm_cache_evidence_distinguishes_omissions_from_reported_zeroes() {
        let mut evidence = WarmCacheEvidence::default();
        evidence.feed(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":4}}}\n");
        evidence.feed(b"\n");
        assert!(evidence.reported);
        assert_eq!(evidence.counters, Counters::default());

        evidence.feed(b"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_1h_input_tokens\":2}}}\n\n");
        evidence.feed(b"data: {\"type\":\"content_block_start\"}\n\ndata: {\"type\":\"message_delta\",\"usage\":{\"cache_creation_input_tokens\":2}}\n\n");
        assert_eq!(evidence.counters, Counters { read: Some(0), created: None, created_5m: None, created_1h: Some(2) });
    }

    #[tokio::test]
    async fn an_in_band_refusal_carries_the_last_observed_usage_once_regardless_of_chunking() {
        struct Chunks(VecDeque<bytes::Bytes>);

        #[async_trait]
        impl BodyStream for Chunks {
            async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
                self.0.pop_front().map(Ok)
            }
        }

        const START: &str = "data: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-served\",\"usage\":{\"input_tokens\":4,\"cache_read_input_tokens\":8,\"cache_creation_input_tokens\":13,\"cache_creation\":{\"ephemeral_5m_input_tokens\":3}}}}\n\n";
        const DELTA: &str = "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2,\"cache_creation\":{\"ephemeral_1h_input_tokens\":7}}}\n\n";
        const ERROR: &str = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        let open = |chunks: VecDeque<bytes::Bytes>| AnthropicStream::new(Box::new(Chunks(chunks)), Box::new(shared()));
        let split = [START, DELTA, ERROR].map(|frame| bytes::Bytes::from_static(frame.as_bytes()));
        for chunks in [[bytes::Bytes::from([START, DELTA, ERROR].concat())].into(), split.into()] {
            let mut stream = open(chunks);
            let mut reported = None;
            let err = loop {
                match stream.next().await.expect("terminal error") {
                    Ok(StreamEvent::Usage(usage)) => reported = Some(usage),
                    Ok(StreamEvent::Completed { .. }) => panic!("a failed attempt never completes"),
                    Ok(_) => {}
                    Err(err) => break err,
                }
            };
            assert_eq!(err.kind, ErrorKind::Overloaded);
            assert_eq!(err.partial_model.as_deref(), Some("claude-served"));
            let partial = err.partial_usage.as_deref().expect("reported usage on failure");
            let reported = reported.expect("usage before the failure");
            assert_eq!(partial.raw, reported.raw);
            assert_eq!(
                (partial.input_tokens, partial.output_tokens, partial.cache_read_tokens, partial.cache_write_tokens, partial.cache_write_1h_tokens),
                (4, 2, 8, 13, 7)
            );
            let split = &partial.raw.as_ref().unwrap()["cache_creation"];
            assert_eq!(split["ephemeral_5m_input_tokens"], 3);
            assert_eq!(split["ephemeral_1h_input_tokens"], 7);
            assert!(stream.next().await.is_none(), "no second terminal bill");
        }
        let empty = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{}}}\n\n";
        let mut stream = open([bytes::Bytes::from_static(empty.as_bytes()), bytes::Bytes::from_static(ERROR.as_bytes())].into());
        assert!(failure(&mut stream).await.partial_usage.is_none(), "an empty usage report is not evidence");
    }

    const TEXT: &str = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":1}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
    );

    /// A stream that stalls after signed thinking and a completed call keeps both with the failure: the continuation
    /// that keeps the call sends the thinking back ahead of it (`partialAssistantBlocks`).
    #[tokio::test(start_paused = true)]
    async fn a_stalled_stream_carries_its_signed_thinking_and_completed_call() {
        let frame = |event: serde_json::Value| format!("data: {event}\n\n");
        let chunk = [
            serde_json::json!({ "type": "message_start", "message": { "model": "claude-x", "usage": { "input_tokens": 1 } } }),
            serde_json::json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
            serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "hm" } }),
            serde_json::json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig" } }),
            serde_json::json!({ "type": "content_block_stop", "index": 0 }),
            serde_json::json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "t1", "name": "echo" } }),
            serde_json::json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{}" } }),
            serde_json::json!({ "type": "content_block_stop", "index": 1 }),
        ]
        .into_iter()
        .map(frame)
        .collect::<String>();
        let chunk: &'static str = Box::leak(chunk.into_boxed_str());
        let identity = SendIdentity::default();
        let windows = PhaseWindows { head: Some(Duration::from_secs(100)), idle: Some(Duration::from_secs(20)), ..PhaseWindows::default() };
        let call = ModelCall::new(&identity, windows, Arc::new(|expiry, delivery, exposure| expired("Anthropic", expiry, delivery, exposure)));
        let mut stream = open(Script::of(&[0], &[&[(0, chunk)]]), &call, &identity).await.expect("the head");
        let failure = failure(&mut stream).await;
        assert_eq!(failure.code.as_deref(), Some("ESTREAMSTALL"));
        assert_eq!(failure.partial_thinking_blocks, vec![serde_json::json!({ "type": "thinking", "thinking": "hm", "signature": "sig" })]);
        let replay = failure.partial_replay.clone().expect("the completed blocks travel with the cut");
        assert_eq!(
            replay.items,
            serde_json::json!([
                { "type": "thinking", "thinking": "hm", "signature": "sig" },
                { "type": "tool_use", "id": "t1", "name": "echo", "input": {} }
            ])
        );
    }

    /// A stream whose attempt a later one replaced is stale: its late chunk marks no transport and moves no phase of the
    /// current attempt.
    #[tokio::test(start_paused = true)]
    async fn a_replaced_attempts_late_chunk_changes_nothing() {
        let identity = SendIdentity::default();
        let stale = identity.begin_attempt(PhaseWindows::default(), false);
        let decoder = shared();
        let mut stream = AnthropicStream::new(Timetable::of(&[(1, TEXT)]), Box::new(decoder.clone()))
            .with_partial(decoder)
            .with_identity(identity.clone())
            .with_attempt(stale);
        let current = identity.begin_attempt(PhaseWindows::default(), false);
        identity.take_boundaries();
        assert!(matches!(stream.next().await, Some(Ok(_))), "the stale stream still decodes its own bytes");
        assert!(identity.take_boundaries().is_empty(), "no boundary of the stale attempt reaches the send");
        assert!(!identity.take_transport(), "no transport mark either");
        let ctx = identity.attempt_context();
        assert_eq!((ctx.id, ctx.phase), (current.id(), AttemptPhase::Head), "the current attempt is still awaiting its head");
    }

    /// A stream not yet read has marked nothing: the response head is not a transport mark.
    #[tokio::test(start_paused = true)]
    async fn a_stream_before_its_first_read_has_marked_no_transport() {
        let identity = SendIdentity::default();
        let _stream = AnthropicStream::new(Timetable::of(&[(5, ": k\n\n")]), Box::new(shared())).with_identity(identity.clone());
        assert!(!identity.take_transport());
    }

    #[async_trait]
    impl HttpSend for Script {
        async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
            let n = self.next.fetch_add(1, Ordering::SeqCst);
            mixdog_rt::time::sleep(Duration::from_secs(self.head_after[n])).await;
            Ok(HttpResponse { status: 200, headers: Vec::new(), body: Timetable::of(&self.chunks[n]) })
        }
    }
    /// The head window this route declares (the SDK's 600 s `headersTimeout`) is longer than the fallback's 120 s: a head that
    /// takes 500 s is answered, and one that never comes expires at 600 s.
    #[tokio::test(start_paused = true)]
    async fn the_declared_head_window_survives_the_fallback_and_expires_at_its_own_value() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let call = model_call(&adapter, &identity);
        assert!(open(Script::of(&[500], &[&[]]), &call, &identity).await.is_ok(), "a 500 s head is inside the declared 600 s");
        let began = tokio::time::Instant::now();
        let err = open(Script::of(&[100_000], &[&[]]), &call, &identity).await.err().expect("the head never comes");
        assert_eq!(began.elapsed(), Duration::from_secs(600), "expires at the declared window, not the fallback's");
        assert!(err.transport.is_some(), "the head expiry reads as the transport's own timeout, as the SDK's headersTimeout did");
    }
    /// `CLAUDE_CODE_MAX_RETRIES` is read on every request, not once at construction (`anthropicMaxAttempts`).
    #[test]
    fn the_retry_budget_follows_the_setting_as_it_changes() {
        let value = Arc::new(std::sync::Mutex::new(None::<String>));
        let source = value.clone();
        let adapter = adapter().with_settings(Arc::new(move |name| (name == "CLAUDE_CODE_MAX_RETRIES").then(|| source.lock().unwrap().clone()).flatten()));
        let retries = |adapter: &AnthropicAdapter| adapter.retry_policy_for("claude-sonnet-4").request.schedule.max_retries;
        assert_eq!(retries(&adapter), 10);
        *value.lock().unwrap() = Some("2".into());
        assert_eq!(retries(&adapter), 2);
        *value.lock().unwrap() = Some("5".into());
        assert_eq!(retries(&adapter), 5);
        *value.lock().unwrap() = None;
        assert_eq!(retries(&adapter), 10);
    }
    /// `API_TIMEOUT_MS` is the response-head bound of a model request (`anthropicRequestTimeoutMs`): a head that never comes
    /// expires at the configured 5 s, not at the SDK's ten minutes.
    #[tokio::test(start_paused = true)]
    async fn api_timeout_ms_bounds_a_stalled_response_head() {
        let adapter = adapter().with_settings(Arc::new(|name| (name == "API_TIMEOUT_MS").then(|| "5000".to_owned())));
        let identity = SendIdentity::default();
        let call = model_call(&adapter, &identity);
        let began = tokio::time::Instant::now();
        let err = open(Script::of(&[100_000], &[&[]]), &call, &identity).await.err().expect("the head never comes");
        assert_eq!(began.elapsed(), Duration::from_secs(5));
        assert!(err.transport.is_some());
    }
    /// Every submission is an attempt with a whole fresh window: a second head that takes 500 s again is answered, though the
    /// two together outlast one window.
    #[tokio::test(start_paused = true)]
    async fn a_resend_gets_a_whole_fresh_window() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let call = model_call(&adapter, &identity);
        let began = tokio::time::Instant::now();
        assert!(open(Script::of(&[500], &[&[]]), &call, &identity).await.is_ok());
        assert!(open(Script::of(&[500], &[&[]]), &call, &identity).await.is_ok());
        assert_eq!(began.elapsed(), Duration::from_secs(1000));
    }
    /// No `message_start` within the first-payload window ends the stream as an empty one, however many pings arrive, and the
    /// window is the declared one.
    #[tokio::test(start_paused = true)]
    async fn pings_alone_do_not_hold_the_first_message_window() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let call = model_call(&adapter, &identity);
        let window = adapter.first_message_ms() as u64;
        let script = Script::of(
            &[0],
            &[&[
                (0, "event: ping\ndata: {\"type\":\"ping\"}\n\n"),
                (window / 2000, ": ping\n\n"),
                (window / 2000, ": ping\n\n"),
                (window / 2000, ": ping\n\n"),
            ]],
        );
        let mut stream = open(script, &call, &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        let err = failure(&mut stream).await;
        assert_eq!(err.code.as_deref(), Some("EEMPTYSTREAM"));
        assert_eq!(err.message, format!("Anthropic SSE stream produced no message_start within {window}ms"));
        assert!(err.timed_out);
        assert_eq!(began.elapsed(), Duration::from_millis(window));
        assert!(stream.next().await.is_none());
    }
    /// The idle window is a byte-idle limit armed at `message_start` (`anthropic-sse.mjs:274`): comment pings, named pings and
    /// fragments of an event that never completes, each less than the window apart, keep the stream alive for longer than the
    /// window with no abort, no output and one request; then silence ends it once, one window after the last chunk.
    #[tokio::test(start_paused = true)]
    async fn bytes_keep_a_started_stream_alive_and_silence_ends_it_one_window_after_the_last_chunk() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let call = model_call(&adapter, &identity);
        let idle = adapter.stream_idle_ms().expect("the watchdog is on") as u64 / 1000;
        let thinking = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n";
        let apart = idle - 20;
        let script = Script::of(
            &[0],
            &[&[
                (0, MESSAGE_START),
                (apart, thinking),
                (apart, ": ping\n\n"),
                (apart, "event: ping\ndata: {\"type\":\"ping\"}\n\n"),
                (apart, "event: content_block_delta\ndata: {\"type\":\"content_bl"),
                (apart, "ock_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\""),
                (apart, ": ping\n\n"),
            ]],
        );
        let mut stream = open(script.clone(), &call, &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        identity.take_boundaries();
        let mut shown = Vec::new();
        let err = loop {
            match stream.next().await.expect("the window ends the stream") {
                Ok(event) => shown.push(event),
                Err(err) => break err,
            }
        };
        assert_eq!(err.code.as_deref(), Some("ESTREAMSTALL"));
        assert_eq!(err.message, format!("Anthropic SSE stream timed out after {}ms of inactivity", idle * 1000));
        assert_eq!(began.elapsed(), Duration::from_secs(6 * apart + idle), "exactly one window after the last chunk, past two windows of pings");
        // The thinking start is the stream's one output (the decoder reports it as reasoning progress); no ping or fragment adds one.
        assert_eq!(
            shown.iter().filter(|event| crate::providers::idle::output(event)).count(),
            1,
            "a ping or a fragment is never reported as model output: {shown:?}"
        );
        assert_eq!(
            identity.take_boundaries().iter().filter(|(_, boundary)| *boundary == Boundary::FirstSemanticOutput).count(),
            1,
            "the first output was published once, by the thinking start"
        );
        assert_eq!(script.next.load(Ordering::SeqCst), 1, "one POST");
    }
    /// A text delta that arrives without any `message_start` is no output of the attempt, and the pings after it renew nothing:
    /// the stream ends as the empty one at the original first-message deadline.
    #[tokio::test(start_paused = true)]
    async fn a_delta_without_message_start_does_not_let_pings_hold_the_first_message_deadline() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let call = model_call(&adapter, &identity);
        let window = adapter.first_message_ms() as u64;
        let delta = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n";
        let every = window / 1000 / 3;
        let script = Script::of(
            &[0],
            &[&[
                (0, delta),
                (every, ": ping\n\n"),
                (every, "event: ping\ndata: {\"type\":\"ping\"}\n\n"),
                (every, ": ping\n\n"),
                (every, ": ping\n\n"),
                (every, ": ping\n\n"),
            ]],
        );
        let mut stream = open(script, &call, &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        let err = failure(&mut stream).await;
        assert_eq!(err.code.as_deref(), Some("EEMPTYSTREAM"));
        assert_eq!(began.elapsed(), Duration::from_millis(window), "the deadline of the head, not renewed by the delta or the pings");
    }
    /// Bytes before `message_start` renew nothing: the first-message window keeps its own deadline, and the stream that never
    /// starts is the empty one at that deadline however many bytes arrive. After `message_start` the 120 s byte-idle window runs
    /// from the start, whatever the long first-output window would allow.
    #[tokio::test(start_paused = true)]
    async fn the_idle_window_is_armed_by_message_start_and_not_by_earlier_bytes() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let call = model_call(&adapter, &identity);
        let idle = adapter.stream_idle_ms().expect("the watchdog is on") as u64 / 1000;
        let first = adapter.first_message_ms() as u64 / 1000;
        let script = Script::of(&[0], &[&[(0, ": ping\n\n"), (first - 30, ": ping\n\n"), (20, MESSAGE_START)]]);
        let mut stream = open(script, &call, &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        let err = failure(&mut stream).await;
        assert_eq!(err.message, format!("Anthropic SSE stream timed out after {}ms of inactivity", idle * 1000));
        assert_eq!(began.elapsed(), Duration::from_secs(first - 10 + idle), "the window runs from message_start, not from the pings before it");
    }
    /// Output starts the idle window, which is the declared `PROVIDER_SSE_IDLE_TIMEOUT_MS`.
    #[tokio::test(start_paused = true)]
    async fn silence_after_output_expires_at_the_declared_idle_window() {
        let (adapter, identity) = (adapter(), SendIdentity::default());
        let call = model_call(&adapter, &identity);
        let idle = adapter.stream_idle_ms().expect("the watchdog is on") as u64;
        let mut stream = open(Script::of(&[0], &[&[(0, TEXT)]]), &call, &identity).await.expect("the head");
        let began = tokio::time::Instant::now();
        let err = failure(&mut stream).await;
        assert_eq!(err.message, format!("Anthropic SSE stream timed out after {idle}ms of inactivity"));
        assert_eq!(began.elapsed(), Duration::from_millis(idle));
        assert!(err.partial_usage.is_some(), "a stall carries the turn's usage as a cut stream does");
    }
    /// What one body chunk makes of a send: whether it marked transport, the first event it decoded (none when the
    /// chunk completes no frame), and whether `message_start` was seen.
    async fn observe(chunk: &'static str) -> (bool, Option<StreamEvent>, bool) {
        let identity = SendIdentity::default();
        let attempt = identity.begin_attempt(PhaseWindows::default(), false);
        let decoder = shared();
        let mut stream = AnthropicStream::new(Timetable::of(&[(0, chunk)]), Box::new(decoder.clone()))
            .with_partial(decoder.clone())
            .with_identity(identity.clone())
            .with_attempt(attempt);
        let first = mixdog_rt::time::timeout(Duration::from_secs(1), stream.next()).await.ok().flatten().map(|item| item.expect("an event"));
        (identity.take_transport(), first, decoder.message_started())
    }
    /// Transport is the body's: a chunk that completes no frame (a partial line, a comment) marks it with no event; a named
    /// ping marks it and is a keepalive, not the message; `message_start` and a semantic delta mark it and are progress.
    #[tokio::test(start_paused = true)]
    async fn each_body_chunk_marks_transport_apart_from_keepalive_and_semantic_progress() {
        use mixdog_core_api::domain::provider::ProgressKind;

        let (transport, event, started) = observe("data: {\"type\":\"pi").await;
        assert!(transport && event.is_none() && !started, "a partial line decodes nothing");
        let (transport, event, started) = observe(": comment\n\n").await;
        assert!(transport && event.is_none() && !started, "a comment-only chunk decodes nothing");
        let (transport, event, started) = observe("event: ping\ndata: {\"type\":\"ping\"}\n\n").await;
        assert!(transport && matches!(event, Some(StreamEvent::ProviderKeepalive)) && !started, "a named ping is a keepalive");
        let (transport, event, started) = observe(MESSAGE_START).await;
        assert!(transport && matches!(event, Some(StreamEvent::Progress(ProgressKind::Semantic))) && started, "message_start");
        let (transport, event, _) =
            observe("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n")
                .await;
        assert!(transport && matches!(event, Some(StreamEvent::TextDelta(t)) if t == "hi"), "a semantic delta");
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
            // The body is the driver's: a read that outlives the deadline of the phase the attempt is in ends with its fault.
            let read = body.next().await;
            match read {
                Some(Ok(chunk)) => {
                    self.mark_transport();
                    let started = |stream: &Self| stream.partial.as_ref().is_some_and(super::decoder::Shared::message_started);
                    // The idle window is a byte-idle limit (`anthropic-sse.mjs:274`): a chunk of a started stream renews it on
                    // receipt, before the thread parser or the SSE framing spend any time on it.
                    let was_started = started(self);
                    if was_started
                        && !chunk.is_empty()
                        && let Some(attempt) = &self.attempt
                    {
                        attempt.renew_idle();
                    }
                    if let Some(thread) = self.thread.as_mut() {
                        thread.feed(&chunk);
                    }
                    match self.decoder.feed(&chunk) {
                        Ok(events) => {
                            // Only `message_start` is the first payload (`anthropic-sse.mjs:142`): a ping, a comment or a
                            // recognized fallback block is progress too, but not the message. The first output is the
                            // semantic one; both move this attempt's clock only while it is the current attempt.
                            let message_started = started(self);
                            if let Some(attempt) = &self.attempt
                                && message_started
                            {
                                attempt.observe(Boundary::FirstProtocolPayload);
                                // The chunk that carried `message_start` arms the byte-idle deadline; output observed
                                // after it moves the phase and no deadline. Output of a stream with no `message_start`
                                // is no output of the attempt: its first-message deadline stands.
                                if !was_started && !chunk.is_empty() {
                                    attempt.renew_idle();
                                }
                                if events.iter().any(crate::providers::idle::output) {
                                    attempt.observe(Boundary::FirstSemanticOutput);
                                }
                            }
                            self.enqueue(events);
                            // An error held back behind this chunk's events
                            // surfaces now, not when the next chunk arrives.
                            if let Err(err) = self.decoder.feed(&[]) {
                                self.fail(err);
                            } else if self.decoder.terminal_seen() {
                                self.complete_thread();
                                self.settle_tail();
                            }
                        }
                        Err(err) => self.fail(err),
                    }
                }
                Some(Err(fault)) => {
                    let exposure = self.decoder.exposure();
                    // A phase deadline of the driver ended the body: its one failure, as classified above; a stall carries the
                    // turn's partial usage as a cut stream does.
                    let mut err = match body.expired(exposure) {
                        Some(mut timed) => {
                            if timed.timeout_phase == Some(StreamTimeoutPhase::Idle) {
                                timed.partial_usage = self.last_usage.clone().map(Box::new);
                            }
                            timed
                        }
                        None => {
                            let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                            err.exposure = exposure;
                            err.partial_usage = self.last_usage.clone().map(Box::new);
                            err
                        }
                    };
                    err.connection = body.connection();
                    err.exposure = exposure;
                    self.fail(err);
                }
                None => {
                    // A body that ended cleanly before the terminal event names the connection it rode, as a fault does.
                    let connection = body.connection();
                    self.body = None;
                    match self.decoder.finish() {
                        Ok(events) => {
                            self.enqueue(events);
                            self.complete_thread();
                            self.settle_tail();
                        }
                        Err(mut err) => {
                            err.connection = connection;
                            self.fail(err);
                        }
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

/// A refusal with the credential the request carried (whatever its kind, wherever its text echoes it) redacted from its
/// body, so no message, log line or thread decision built from it holds the credential. The credential is the one the
/// refused request was sent with, not whichever one the account holds by the time the refusal is read.
fn scrub_refusal(mut refusal: ErrorResponse, secret: &Secret) -> ErrorResponse {
    let text = String::from_utf8_lossy(&refusal.body);
    let clean = crate::oauth::scrub::scrub_oauth_secrets(&text, &[&secret.0]);
    if clean != text {
        refusal.body = clean.into_bytes();
    }
    refusal
}
impl AnthropicAdapter {
    /// Warms the messages API now, as the subscription provider's constructor does (`anthropic-oauth.mjs:352`), and
    /// again before each send (`_sendOnce`, `anthropic-oauth.mjs:535`).
    pub fn with_preconnect(mut self, preconnect: Preconnect) -> Self {
        preconnect.warm(ANTHROPIC_ORIGIN);
        self.preconnect = Some(preconnect);
        self
    }

    pub fn api_key(config: AnthropicConfig, http: Arc<dyn HttpSend>, keys: Arc<dyn ApiKeySource>, gzip_lane: CpuBulk) -> Self {
        Self::new(Flavor::ApiKey, config, http, Credentials::ApiKey(keys), true, gzip_lane)
    }

    /// `enterprise`: a pay-as-you-go subscription whose 429 is retried like an
    /// API key's; every other subscription surfaces a 429 at once.
    pub fn oauth(config: AnthropicConfig, http: Arc<dyn HttpSend>, session: Arc<OAuthSession>, enterprise: bool, gzip_lane: CpuBulk) -> Self {
        Self::new(Flavor::OAuth, config, http, Credentials::OAuth(session), enterprise, gzip_lane)
    }

    fn new(flavor: Flavor, config: AnthropicConfig, http: Arc<dyn HttpSend>, credentials: Credentials, retry_429: bool, gzip_lane: CpuBulk) -> Self {
        #[cfg(feature = "count-work")]
        crate::work::provider_built();
        // `terminalAtLimit`: an API-key first-party Opus ends its send after repeated overloads instead of spending the
        // whole budget (`anthropic.mjs:408`); the subscription route and custom endpoints keep the ordinary policy.
        let opus_policy = (flavor == Flavor::ApiKey && !config.custom_endpoint).then(|| {
            let mut policy = retry_policy(retry_429);
            policy.overload.stop_after_repeated = true;
            policy
        });
        Self {
            opus_policy,
            id: ProviderId::from(flavor.provider_name()),
            codec: AnthropicCodec::new(flavor, config).with_cli_version_source(match &credentials {
                Credentials::OAuth(session) => session.cli_version_source(),
                Credentials::ApiKey(_) | Credentials::Engine(_) => None,
            }),
            policy: retry_policy(retry_429),
            budgets: (0..2 * BUDGET_COUNTS).map(|_| std::sync::OnceLock::new()).collect(),
            keepalive: KeepaliveSchedule::SPEC,
            driver: ModelDriver::new(http),
            credentials,
            gzip_lane,
            preconnect: None,
            settings: Arc::new(|name| std::env::var(name).ok()),
            images: None,
            compressor: None,
            engine: None,
        }
    }

    /// The Messages engine `id` of another provider on the API-key route, sending with `credential` and taking
    /// documents as `media` declares. The engine keeps the route's retry rows; an Opus model's early end is the
    /// first-party API's alone. The state the native routes keep for the process (the capability floors, the fast-mode
    /// cooldown, the gzip latch, the prefix trace) is not the engine's: its floors are kept under its own name, its
    /// fast-mode state is its own, and it neither compresses nor traces.
    pub fn engine(
        id: ProviderId,
        config: AnthropicConfig,
        http: Arc<dyn HttpSend>,
        credential: Arc<dyn Credential>,
        media: MediaSupport,
        gzip_lane: CpuBulk,
    ) -> Self {
        let config = AnthropicConfig { fast_mode: Arc::new(fast_mode::FastMode::default()), ..config };
        let mut adapter = Self::new(Flavor::ApiKey, config, http, Credentials::Engine(credential), true, gzip_lane);
        adapter.codec.set_floors_of(id.as_str());
        adapter.id = id;
        adapter.opus_policy = None;
        adapter.engine = Some(Engine { rewriter: None, view: None, media, listing: None, input_excludes_cache: None });
        adapter
    }

    /// An engine's requests pass through `rewriter` ([`Self::engine`]).
    pub fn with_rewriter(mut self, rewriter: Arc<dyn Rewriter>) -> Self {
        let view: Arc<dyn WireCodec> = Arc::new(RewriteCodec::new(
            Arc::new(AnthropicCodec::new(Flavor::ApiKey, self.codec.config().clone()).with_floors_of(self.id.as_str())),
            rewriter.clone(),
        ));
        if let Some(engine) = self.engine.as_mut() {
            engine.rewriter = Some(rewriter);
            engine.view = Some(view);
        }
        self
    }

    /// An engine's model listing ([`Self::engine`]); one without lists none of its own.
    pub fn with_listing(mut self, listing: Arc<dyn ModelListing>) -> Self {
        if let Some(engine) = self.engine.as_mut() {
            engine.listing = Some(listing);
        }
        self
    }

    /// An engine's usage convention when its class states it apart from its name ([`ProviderAdapter::input_excludes_cache`]).
    pub fn with_input_excludes_cache(mut self, excludes: bool) -> Self {
        if let Some(engine) = self.engine.as_mut() {
            engine.input_excludes_cache = Some(excludes);
        }
        self
    }

    /// `base` with its request row's retry count as `CLAUDE_CODE_MAX_RETRIES` reads now.
    fn budgeted<'a>(&'a self, base: &'a RetryPolicy, opus: bool) -> &'a RetryPolicy {
        let retries = super::policy::request_retries(|name| (self.settings)(name));
        if retries == base.request.schedule.max_retries {
            return base;
        }
        self.budgets[usize::from(opus) * BUDGET_COUNTS + retries as usize].get_or_init(|| {
            let mut policy = base.clone();
            policy.request.schedule.max_retries = retries;
            Box::new(policy)
        })
    }

    /// Prepares the images of every request body with `fitter` ([`super::images::ImageFitter::fit_wire`]).
    pub fn with_images(mut self, fitter: Option<super::images::ImageFitter>) -> Self {
        self.images = fitter;
        self
    }

    /// The request as `prepareAnthropicImages` leaves it: the lowered body with its images fitted.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn plain(&self, request: &ModelRequest) -> Result<Plain, ProviderError> {
        let mut plain = self.codec.encode_plain(request)?;
        if let Some(engine) = &self.engine {
            if let Some(rewriter) = &engine.rewriter {
                plain.wire = rewriter.rewrite(plain.wire, request)?;
            }
            // No cache owner judges an engine's writes: its body's layout is not read.
            plain.layout = None;
        }
        let mut refitted = false;
        if let Some(fitter) = &self.images {
            let before = plain.wire.body.len();
            plain.wire = fitter.fit_wire(request, plain.wire).await?;
            refitted = before != plain.wire.body.len();
        }
        // The cache layout of what goes out: a body whose images were refitted is described again from its bytes.
        if let Some(map) = plain.layout.take() {
            let layout = if refitted { Layout::Sent(plain.wire.body.clone()) } else { Layout::Map(map) };
            plain.manifest = Some(Arc::new(self.manifest_of(layout).await?));
        }
        Ok(plain)
    }

    /// The cache layout of a body, read on the bulk CPU lane as compression is: hashing a long transcript (about 26 ms for a
    /// 2.3 MB body in a debug build) never runs on the async caller. Dropping the attempt cancels the wait or the job.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn manifest_of(&self, layout: Layout) -> Result<WireManifest, ProviderError> {
        let failure = |cause: &dyn std::fmt::Display| {
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
            err.message = format!("the request's cache layout could not be read: {cause}");
            err
        };
        let cancel = CancellationToken::new();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let job = self
            .gzip_lane
            .submit_wait(&cancel, move |_| {
                // A body that cannot be read is not described as one with no transcript: the attempt fails unsent.
                match layout {
                    Layout::Map(map) => Ok(crate::cache_tail::manifest::of_body(&map)),
                    Layout::Sent(bytes) => {
                        serde_json::from_slice::<Value>(&bytes).map(|body| crate::cache_tail::manifest::anthropic(&body)).map_err(std::io::Error::other)
                    }
                }
            })
            .await
            .map_err(|e| failure(&e))?;
        job.await.map_err(|e| failure(&e))?.map_err(|e| failure(&e))
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
        let Some((name, value)) = self.credentials.header(secret) else { return request };
        match &self.credentials {
            Credentials::Engine(credential) => credential.place(&mut request.headers, (name, value)),
            // A configured extra header of the credential's name already replaced it.
            _ if request.headers.iter().any(|h| h.0.eq_ignore_ascii_case(&name)) => {}
            Credentials::OAuth(_) => request.headers.insert(0, (name, value)),
            Credentials::ApiKey(_) => request.headers.push((name, value)),
        }
        request
    }

    /// Compression is a bulk-CPU lane job and never skipped for load: this
    /// waits for lane room. Dropping the attempt cancels the wait, or the
    /// queued job, so a cancelled request compresses nothing.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
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
        job.await.map_err(|e| gzip_failure(&e))?.map_err(|e| gzip_failure(&e))
    }

    /// One model POST of `wire` with the credential: an attempt of the driver (and the plain re-send after a refused gzip
    /// body is another), whose handle the response's boundaries are reported on, bound to the permit its write was admitted
    /// under ([`Self::dispatch`]).
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn post(&self, call: &ModelCall, wire: &WireRequest, admit: &Admit<'_>) -> Result<(HttpResponse, AttemptHandle, Tail), ProviderError> {
        let (response, attempt, tail) = self.fetch_routed(Route::Model(call), self.request_with(wire, admit.secret), Some(admit)).await?;
        Ok((response, attempt.expect("a model route begins an attempt"), tail))
    }

    /// The model submission of `request`: the windows this route declares (the fallback policy fills the rest) and how an
    /// expiry of each phase reads. The head is bounded as the SDK's `headersTimeout` bounded it (600 s), the first payload by
    /// `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (`message_start`), idle by `PROVIDER_SSE_IDLE_TIMEOUT_MS` (`MIXDOG_ENABLE_STREAM_WATCHDOG=0`
    /// drops it to the fallback), and the non-streaming `recovery` by `PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS` (300 s, the
    /// `x-stainless-timeout` it sends). No window is declared for the first output: the fallback's.
    fn model_call(&self, request: &ModelRequest, recovery: bool) -> ModelCall {
        let millis = |ms: f64| std::time::Duration::from_millis(ms as u64);
        let windows = PhaseWindows {
            // `anthropicRequestTimeoutMs`: `API_TIMEOUT_MS` (the SDK's ten minutes unset) bounds the response head.
            head: Some(std::time::Duration::from_millis(super::policy::request_timeout_ms(|name| (self.settings)(name)))),
            payload: Some(millis(self.first_message_ms())),
            first_output: None,
            idle: self.stream_idle_ms().map(millis),
            recovery: Some(std::time::Duration::from_secs(300)),
        };
        let label = self.stream_label();
        let call =
            ModelCall::new(&request.options.send_identity, windows, Arc::new(move |expiry, delivery, exposure| expired(label, expiry, delivery, exposure)));
        if recovery { call.recovery() } else { call }
    }

    /// The client's `fetch` (`createAnthropicApiKeyFetch`, the subscription's `postMessages`): one request, compressed
    /// as `sendWithCompression` compresses it (`request-compression.mjs:75-82`): a POST to the official messages URL
    /// with a body of at least `GZIP_MIN_BYTES` that carries no `content-encoding`, unless the process latch or
    /// `MIXDOG_ANTHROPIC_REQ_GZIP=0` turned compression off; a compression failure sends the body plain. A 400/415 to
    /// the compressed body is drained and the same request sent once plain; when that plain send succeeds,
    /// compression is off for the rest of the process.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn fetch(&self, request: WireRequest) -> Result<HttpResponse, ProviderError> {
        self.fetch_routed(Route::Aux, request, None).await.map(|(response, ..)| response)
    }

    /// One request of [`Self::fetch`]'s rule, on `route`: a model request is an attempt of the driver (the plain re-send of a
    /// refused gzip body is another), a request that is not one begins none. Each write is admitted by `admit` on its own
    /// ([`Self::dispatch`]): the compressed body after the compression's wait, the plain re-send again at its own moment.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn fetch_routed(
        &self,
        route: Route<'_>,
        request: WireRequest,
        admit: Option<&Admit<'_>>,
    ) -> Result<(HttpResponse, Option<AttemptHandle>, Tail), ProviderError> {
        let wire = &request;
        // An engine sends its body as its SDK did, plain, whatever its base URL; the process latch is not its own.
        let eligible = self.engine.is_none()
            && wire.method.eq_ignore_ascii_case("POST")
            && official_messages_url(&wire.url)
            && wire.body.len() >= GZIP_MIN_BYTES
            && !GZIP_LATCHED.load(Ordering::SeqCst)
            && (self.settings)("MIXDOG_ANTHROPIC_REQ_GZIP").as_deref() != Some("0")
            && !request.headers.iter().any(|h| h.0.eq_ignore_ascii_case("content-encoding"));
        if !eligible {
            return self.dispatch(route, request, admit).await;
        }
        let Ok(packed) = self.gzip(&wire.body).await else {
            return self.dispatch(route, request, admit).await;
        };
        let mut compressed = request.clone();
        compressed.body = packed;
        // `withContentEncoding` drops the plain body's `content-length` and appends `Content-Encoding` after the
        // request's own headers (`request-compression.mjs:39-48`).
        compressed.headers.retain(|h| !h.0.eq_ignore_ascii_case("content-length"));
        compressed.headers.push(("Content-Encoding".to_owned(), "gzip".to_owned()));
        let (response, attempt, tail) = self.dispatch(route, compressed, admit).await?;
        if !matches!(response.status, 400 | 415) {
            return Ok((response, attempt, tail));
        }
        // Drained best-effort before the plain resend (`resendIfEncodingRejected`). The refused compressed write reported
        // no usage: its permit settles empty, and the plain re-send is admitted on its own.
        drop(tail);
        drop(response.read_all().await);
        let (retry, attempt, tail) = self.dispatch(route, request, admit).await?;
        if retry.is_success() {
            GZIP_LATCHED.store(true, Ordering::SeqCst);
        }
        Ok((retry, attempt, tail))
    }

    /// The one place Messages requests reach the transport. A write that carries a session transcript (`admit`) is
    /// admitted here, after every wait that can delay it (compression, lanes, credential refresh are all behind the
    /// caller), immediately before the write; the response comes back bound to that permit. A refusal is the write's error:
    /// nothing is sent. A transport failure settles the permit empty.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn dispatch(
        &self,
        route: Route<'_>,
        mut request: WireRequest,
        admit: Option<&Admit<'_>>,
    ) -> Result<(HttpResponse, Option<AttemptHandle>, Tail), ProviderError> {
        let exchange = if matches!(self.credentials, Credentials::OAuth(_)) {
            // Validate the final write, including replays and cache warms. Redirects can move both the bearer and
            // body to another path on the same origin, or resend the body alone to another origin.
            if request.method != "POST" || !url::Url::parse(&request.url).is_ok_and(|url| url.as_str() == "https://api.anthropic.com/v1/messages") {
                let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
                error.message = "Anthropic subscription requests must use the official Messages endpoint".into();
                return Err(error);
            }
            let agent = self.codec.resolve_cli_user_agent().await;
            if let Some((_, value)) = request.headers.iter_mut().find(|(name, _)| name.eq_ignore_ascii_case("user-agent")) {
                *value = agent;
            } else {
                request.headers.push(("user-agent".to_owned(), agent));
            }
            Exchange { redirect: Redirect::Error, ..MODEL_STREAM }
        } else {
            MODEL_STREAM
        };
        let tail = match admit {
            Some(admit) => self.admit(admit).await?,
            None => None,
        };
        if let Some(admit) = admit
            && !admit.announced.swap(true, Ordering::SeqCst)
        {
            // The subscription route raises `requesting` before every POST (`doRequest`, anthropic-oauth-request.mjs:64);
            // the API-key route once before its ladder (anthropic.mjs:300).
            match self.codec.flavor() {
                Flavor::OAuth => admit.request.options.send_identity.raise_stage("requesting"),
                Flavor::ApiKey => admit.request.options.send_identity.raise_requesting_once(),
            }
        }
        // Admitted and about to be written: only now does this attempt's request carry its speed. A write the cache owner
        // refused, or a warm or listing fetch, dispatches no model request and notes none.
        if let (Route::Model(_), Some(admit)) = (&route, admit) {
            admit.request.options.send_identity.note_dispatched_speed_tier(admit.speed);
        }
        let sent = match route {
            Route::Model(call) => self.driver.send(call, request, exchange).await.map(|(response, attempt)| (response, Some(attempt))),
            Route::Aux => self.driver.aux().send(request, exchange).await.map(|response| (response, None)),
        };
        sent.map(|(response, attempt)| (response, attempt, tail))
    }

    /// The `thinking` field the body of `request` carries: it depends on the model, the options and `max_tokens`, never
    /// on the transcript, so it is read off the request without its messages and tools. `None` for a body without one
    /// (or a request that does not encode: its send reports why).
    fn thinking_of(&self, request: &ModelRequest) -> Option<Value> {
        let mut options = request.options.clone();
        options.shared_cache_prefix_count = None;
        options.effort_projection = None;
        use mixdog_core_api::domain::provider::{Content, Message, Role};
        let probe =
            ModelRequest { model: request.model.clone(), messages: vec![Message::new(Role::User, Content::Text("x".into()))], tools: Vec::new(), options };
        let body: Value = serde_json::from_slice(&self.codec.encode_plain(&probe).ok()?.wire.body).ok()?;
        body.get("thinking").cloned()
    }

    /// The body to replay at standard speed after `rejected` refused the fast request `body`, when
    /// the refusal switches fast mode down (`dropFastSpeedAfter`): the same body without `speed`
    /// (the betas stay). `None` for a request that did not ask for fast speed or a refusal that
    /// leaves fast mode alone.
    fn after_fast_refusal(&self, body: &[u8], rejected: &ErrorResponse) -> Option<Vec<u8>> {
        // An engine's refusal is its own to surface: no standard-speed replay, no cooldown recorded.
        if self.engine.is_some() {
            return None;
        }
        let mut parsed: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(body).ok()?;
        if parsed.get("speed").and_then(serde_json::Value::as_str) != Some("fast") {
            return None;
        }
        let message = String::from_utf8_lossy(&rejected.body);
        let refusal = CapacityError { status: rejected.status.unwrap_or(0), message: &message, headers: &rejected.headers, retry_after_ms: None };
        if !self.codec.config().fast_mode.note_capacity_error(&refusal, true, fast_mode::now_ms()).downgraded() {
            return None;
        }
        parsed.shift_remove("speed");
        serde_json::to_vec(&parsed).ok()
    }

    /// Whether `rejected` refused a version-floor feature of the request (`anthropicCapabilityReplay`): the feature is
    /// then switched off for the model on this route and the request is to be encoded again, once per feature and
    /// attempt. Nothing has streamed yet.
    fn floor_rejected(&self, request: &ModelRequest, wire: &WireRequest, status: Option<u16>, text: &str, replayed: &mut Vec<Feature>) -> bool {
        // An engine has no capability replay (Node's gateway and custom engines had none): its refusal surfaces.
        if self.engine.is_some() {
            return false;
        }
        let Some(feature) = claude_floors::rejection(status, text) else { return false };
        // A 400 can name `output_config` or the beta for another reason: only a request that carried an effort update
        // was refused one. Any other surfaces as it is, and the model keeps its updates.
        if feature == Feature::EffortUpdates && !super::codec::beta_names(wire).iter().any(|beta| beta == super::effort_updates::BETA) {
            return false;
        }
        if replayed.contains(&feature) {
            return false;
        }
        replayed.push(feature);
        claude_floors::mark_unsupported(feature, self.state_key(), &request.model);
        if feature == Feature::EffortUpdates {
            let said: String = text.chars().take(300).collect();
            mixdog_rt::node_stderr!("[{}] {} rejected the mid-conversation effort update; retrying once without it: {said}", self.state_key(), request.model);
        }
        true
    }

    /// The provider every state this adapter keeps beyond one request (thread records, refresh claims, cache-owner
    /// routes, capability floors) is kept under: the route's own name, an engine's name for an engine.
    fn state_key(&self) -> &str {
        self.id.as_str()
    }

    /// The thread plan of a request, when it threads at all: a create, a continue of the conversation's stored
    /// response, or unthreaded.
    fn plan(&self, request: &ModelRequest, plain: &Plain, secret: &Secret, directive: Option<Directive>) -> Option<Plan> {
        let scope = self.codec.thread_scope(request)?;
        let body: Value = serde_json::from_slice(&plain.wire.body).ok()?;
        let config = self.codec.config();
        let provider = self.state_key();
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
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn non_streaming(
        &self,
        request: &ModelRequest,
        wire: &WireRequest,
        secret: &Secret,
        manifest: Option<&Arc<WireManifest>>,
    ) -> Result<Box<dyn ModelStream>, ProviderError> {
        let mut wire = wire.clone();
        if let Some(body) = super::nonstream::body(&wire.body) {
            wire.body = body;
        }
        wire.headers.push(("x-stainless-timeout".to_owned(), super::nonstream::TIMEOUT_SECONDS.to_owned()));
        request.options.send_identity.raise_stage_with("requesting", serde_json::json!({ "transport": "non-streaming-fallback" }));
        // A failure of this re-issue ends the send's recovery (`markProviderRecoveryExhausted`, anthropic-api-recovery.mjs:57).
        let exhausted = |mut err: ProviderError| {
            err.recovery_exhausted = true;
            err
        };
        // A real exchange of its own: the driver's recovery attempt, one generation total over head and body.
        let call = self.model_call(request, true);
        // A POST of its own: admitted at its write, on the credential it goes out on.
        let admit = Admit { request, manifest, secret, purpose: request.options.tail_purpose, announced: Admit::quiet(true), speed: body_speed(&wire.body) };
        let (response, _, tail) = self.post(&call, &wire, &admit).await.map_err(exhausted)?;
        let read = scrub_refusal(response.read_all().await.map_err(exhausted)?, secret);
        if !read.status.is_some_and(|status| (200..300).contains(&status)) {
            return Err(exhausted(self.codec.classify(&read)));
        }
        let message: Value = serde_json::from_slice(&read.body).map_err(|e| {
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            err.message = format!("Anthropic non-streaming response is not JSON: {e}");
            exhausted(err)
        })?;
        // The turn's replay is owned as the streamed turn's is (the wire's owner, `createProviderReplay('anthropic', …)`,
        // anthropic-request-utils.mjs:552), so the next request of the same route reads it back.
        Ok(Box::new(AnthropicStream::ready(super::nonstream::events(self.codec.owner(), &request.model, &message)).with_tail(tail)))
    }

    /// Asks the session's cache owner to admit one write of `admit.request`, whose body has the cache layout
    /// `admit.manifest`, on the credential `admit.secret`, now. Only [`Self::dispatch`] calls it, immediately before the
    /// write, so a replay on another body, credential or moment is judged again. `None`: no owner, or a body with no
    /// transcript marker. A refusal is the write's error: nothing is sent.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn admit(&self, admit: &Admit<'_>) -> Result<Tail, ProviderError> {
        let Some(manifest) = admit.manifest.filter(|m| m.tail.is_some()) else { return Ok(None) };
        let Some(gate) = admit.request.options.tail_gate.clone() else { return Ok(None) };
        let config = self.codec.config();
        let provider = self.state_key();
        // The serving credential as an opaque identity (an API key's own hash, a subscription's account file).
        let route = TailRoute(format!(
            "{provider}|{}|{}|{}",
            config.base_url,
            admit.request.model,
            self.credentials.thread_account(provider, &config.base_url, admit.secret)
        ));
        match gate
            .0
            .admit(Admission {
                purpose: admit.purpose,
                route: &route,
                manifest,
                generation: admit.request.options.tail_generation,
                unreduced: admit.request.options.tail_unreduced,
            })
            .await
        {
            Verdict::Send(permit) => Ok(Some(AdmittedWrite::new(gate, permit))),
            Verdict::Refuse(refusal) => Err(ProviderError::tail_refused(refusal)),
        }
    }

    /// `PROVIDER_SSE_IDLE_TIMEOUT_MS` unless `MIXDOG_ENABLE_STREAM_WATCHDOG` turns the idle watchdog off.
    fn stream_idle_ms(&self) -> Option<f64> {
        crate::providers::google::cache::policy::sse_idle_ms(|name| (self.settings)(name))
    }

    /// `PROVIDER_FIRST_BYTE_TIMEOUT_MS`: how long a stream may take to produce its `message_start`.
    fn first_message_ms(&self) -> f64 {
        crate::providers::google::cache::policy::stall_deadlines_ms(|name| (self.settings)(name)).0
    }

    /// `labels.display` of the stream's errors (`OAUTH_STREAM_LABELS`).
    fn stream_label(&self) -> &'static str {
        match self.codec.flavor() {
            Flavor::OAuth => "Anthropic OAuth",
            Flavor::ApiKey => "Anthropic",
        }
    }

    async fn failure(&self, response: HttpResponse, secret: &Secret) -> ProviderError {
        match response.read_all().await {
            Ok(rejected) => self.codec.classify(&scrub_refusal(rejected, secret)),
            Err(err) => err,
        }
    }

    /// A refused warm's error, worded as `anthropicQuotaError` words it for both routes.
    async fn warm_failure(&self, response: HttpResponse, secret: &Secret) -> ProviderError {
        match response.read_all().await {
            Ok(rejected) => {
                let rejected = scrub_refusal(rejected, secret);
                let mut error = self.codec.classify(&rejected);
                error.message = super::errors::quota_error_text(&rejected, &[&secret.0]);
                error
            }
            Err(err) => err,
        }
    }

    /// One `GET /v1/models`: no retry, no credential replay, no cache.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn fetch_listing(&self) -> Result<Vec<u8>, ProviderError> {
        let flavor = self.codec.flavor();
        let secret = self.credentials.current().await?;
        let mut headers = vec![("anthropic-version".to_owned(), ANTHROPIC_VERSION.to_owned())];
        let exchange = if flavor == Flavor::OAuth {
            headers.push(("anthropic-beta".to_owned(), beta_header(flavor, BetaFeatures::default())));
            headers.push(("anthropic-dangerous-direct-browser-access".to_owned(), "true".to_owned()));
            headers.push(("user-agent".to_owned(), self.codec.resolve_cli_user_agent().await));
            headers.push(("x-app".to_owned(), "cli".to_owned()));
            // The bearer is scoped to the official listing, not to a redirect target on the same origin.
            Exchange { redirect: Redirect::Error, ..ANTHROPIC_MODELS }
        } else {
            layer_extra_headers(&mut headers, &self.codec.config().extra_headers);
            ANTHROPIC_MODELS
        };
        let wire =
            WireRequest { transport: TransportKind::Http1, method: "GET".to_owned(), url: listing_url(flavor, self.codec.config()), headers, body: Vec::new() };
        // A GET with no transcript: nothing to admit.
        let response = self.driver.aux().send(self.request_with(&wire, &secret), exchange).await?;
        if !(200..300).contains(&response.status) {
            return Err(self.failure(response, &secret).await);
        }
        response.read_all().await.map(|read| read.body)
    }

    /// The listed models with everything the route's normalizer derives
    /// (family, tier, `latest`, release date, thinking types).
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn list_rows(&self) -> Result<Vec<AnthropicModel>, ProviderError> {
        let body = self.fetch_listing().await?;
        parse_listing(&body, self.codec.flavor(), &self.codec.config().caps).map_err(|e| {
            let mut err = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
            err.message = format!("model listing is not JSON: {e}");
            err
        })
    }
}
impl AnthropicAdapter {
    /// One attempt. `model_retry`: the attempt is the replay of a refused model id (`_modelRetry`), which is made once.
    async fn attempt_model(&self, request: Arc<ModelRequest>, model_retry: bool, mut version_replayed: bool) -> Result<Box<dyn ModelStream>, ProviderError> {
        request.options.send_identity.raise_stage("preparing");
        if let Some(preconnect) = &self.preconnect {
            preconnect.warm(ANTHROPIC_ORIGIN);
        }
        let mut plain = self.plain(&request).await?;
        let mut secret = self.credentials.current().await?;
        let call = self.model_call(&request, false);
        let mut refreshed = false;
        let mut directive = None;
        let mut floor_replays = Vec::new();
        // The `max_tokens` a context-overflow 400 shrank this send to (`maxTokensAdjusted`): once per attempt, and kept
        // by every body the attempt builds after it.
        let mut shrunk_max_tokens: Option<u64> = None;
        // A threaded request the API refuses over its thread is planned again, as a create or unthreaded.
        'plan: loop {
            // Diagnostic: per-block prefix hashes of exactly what is sent (`recordAnthropicPrefix(anthropicPrefixSessionId(opts), …)`).
            let options = &request.options;
            let session = options.usage_session_id.as_deref().filter(|s| !s.is_empty()).or(options.session_id.as_deref());
            if self.engine.is_none() {
                super::prefix_trace::record(session, plain.prefix.clone());
            }
            let mut plan = self.plan(&request, &plain, &secret, directive);
            let mut wire = match &plan {
                Some(plan) if plan.mode != Mode::None => threaded(&plain.wire, &plan.body, &plan.betas),
                _ => plain.wire.clone(),
            };
            if let Some(max) = shrunk_max_tokens
                && let Some(body) = super::max_tokens::with_max_tokens(&wire.body, max)
            {
                wire.body = body;
            }
            let mut speed_dropped = false;
            loop {
                // Every write (a replay after a refusal, a refreshed credential, a re-planned thread, the plain re-send of a
                // refused compressed body included) is admitted at the write itself ([`Self::dispatch`]), on the credential
                // it carries and the clock of that moment; the cache layout is the transcript's, which a thread plan, a
                // dropped speed or a shrunk `max_tokens` leaves as it is. Every real exchange is an attempt of the driver:
                // fresh head, first-message and first-output windows, none inherited.
                let admit = Admit {
                    request: &request,
                    manifest: plain.manifest.as_ref(),
                    secret: &secret,
                    purpose: request.options.tail_purpose,
                    announced: Admit::quiet(false),
                    speed: body_speed(&wire.body),
                };
                let (response, attempt, mut tail) = match self.post(&call, &wire, &admit).await {
                    Ok(sent) => sent,
                    Err(error) => {
                        if error.tail_refusal.is_some()
                            && let Some(plan) = plan.take()
                        {
                            plan.unsent();
                        }
                        return Err(error);
                    }
                };
                if (200..300).contains(&response.status) {
                    let thread = plan.as_mut().and_then(Plan::take_session);
                    // The transport mark is the stream's, raised on each body chunk (`anthropic-sse.mjs:275`): health only.
                    let decoder = self.codec.decoder_with_partial(&request, super::betas::sent_display_updates(&super::codec::beta_names(&wire)));
                    let stream = Box::new(
                        AnthropicStream::new(response.body, Box::new(decoder.clone()))
                            .with_identity(request.options.send_identity.clone())
                            .with_attempt(attempt)
                            .with_partial(decoder)
                            .with_thread(thread)
                            .with_secret(&secret)
                            .with_tail(tail.take()),
                    );
                    // OAuth replays only a rejected initial response (`_resendAfterRejection`); an engine has no capability
                    // replay to read the opening for.
                    if self.codec.flavor() != Flavor::ApiKey || self.engine.is_some() {
                        return Ok(stream);
                    }
                    let opened = BeforeOutput::read(stream).await;
                    if let Some(err) = opened.failure()
                        && self.floor_rejected(&request, &wire, err.status, &err.message, &mut floor_replays)
                    {
                        if err.partial_usage.is_some() {
                            let mut failed = err.clone();
                            if !crate::registry::accounted::handoff_abandoned_usage(&mut failed, &request.options.send_identity) {
                                // No owner can record an internal replay here. Let the caller settle the billed attempt.
                                return Ok(Box::new(opened));
                            }
                        }
                        // A fresh send (`withAnthropicCapabilityFallback`): its thread is planned again, with no directive.
                        directive = None;
                        plain = self.plain(&request).await?;
                        continue 'plan;
                    }
                    return Ok(Box::new(opened));
                }
                // A refused write reports no usage: its permit settles empty, and any replay below is admitted on its own.
                drop(tail);
                let rejected = scrub_refusal(response.read_all().await?, &secret);
                // A fast-pool refusal (or "Fast mode is not enabled") says nothing about standard-speed
                // capacity: the cooldown is recorded, `speed` is dropped and the request replayed once
                // at once, instead of waiting out a window only the fast pool owns.
                if !speed_dropped && let Some(standard) = self.after_fast_refusal(&wire.body, &rejected) {
                    wire.body = standard;
                    speed_dropped = true;
                    continue;
                }
                // "input length and `max_tokens` exceed context limit": `max_tokens` shrinks to what the context has room
                // for and the request is replayed once (`withBodyRecovery`, anthropic-api-transport.mjs:122-139;
                // `_openResponse`, anthropic-oauth.mjs:823-836).
                if shrunk_max_tokens.is_none()
                    && let Some((body, max)) =
                        super::max_tokens::adjust_for_context_overflow(&wire.body, rejected.status, &String::from_utf8_lossy(&rejected.body))
                {
                    wire.body = body;
                    shrunk_max_tokens = Some(max);
                    continue;
                }
                if self.floor_rejected(&request, &wire, rejected.status, &String::from_utf8_lossy(&rejected.body), &mut floor_replays) {
                    directive = None;
                    plain = self.plain(&request).await?;
                    continue 'plan;
                }
                let mut err = self.codec.classify(&rejected);
                // `rejectedToolSchema`: a 400 that names one of the tools this body carried.
                crate::providers::rejections::mark_tool_schema(&mut err, &rejected.body, &crate::providers::rejections::wire_tool_names(&wire.body));
                if !refreshed
                    && self.credentials.refreshable(err.status, &rejected.body)
                    && request.options.send_identity.claim_refresh(self.credentials.thread_account(self.state_key(), &self.codec.config().base_url, &secret))
                {
                    refreshed = true;
                    if self.codec.flavor() == Flavor::OAuth {
                        mixdog_rt::node_stderr!("[anthropic-oauth] {} — forcing refresh and retrying once", rejected.status.unwrap_or(0));
                    }
                    request.options.send_identity.raise_stage("preparing");
                    if let Some(next) = self.credentials.after_rejection(&secret).await? {
                        secret = next;
                        continue;
                    }
                }
                match &self.credentials {
                    // An engine's credential marks a resend refused after its login was renewed for it.
                    Credentials::Engine(credential) => {
                        if refreshed && secret.exchanged() {
                            credential.refused_again(rejected.status.unwrap_or(0), &mut err);
                        }
                    }
                    // The grant was refreshed and is still refused.
                    _ if refreshed && err.status == Some(401) && err.kind == ErrorKind::Auth => err.reauth_required = true,
                    _ => {}
                }
                let refusal = String::from_utf8_lossy(&rejected.body);
                if rejected.status == Some(400)
                    && let Credentials::OAuth(session) = &self.credentials
                    && let Some(version) = session.cli_version_source()
                    && version.learn_required(&refusal.chars().take(2_000).collect::<String>()).await
                    && !version_replayed
                {
                    version_replayed = true;
                    continue;
                }
                if let Some(next) = plan.as_ref().and_then(|plan| plan.classify(rejected.status.unwrap_or(0), &refusal)) {
                    directive = Some(next);
                    plain = self.plain(&request).await?;
                    continue 'plan;
                }
                // An unknown model on the subscription route: the catalog is read again and the request replayed once, on
                // the family's current id when the refreshed catalog no longer lists the requested one
                // (`_openResponse`, anthropic-oauth.mjs:932). A 404 usually says this credential cannot reach the model,
                // so the substitution needs the catalog's word that the id is gone; a refresh that failed is "cannot tell".
                if self.codec.flavor() == Flavor::OAuth && !model_retry && super::models::names_unknown_model(rejected.status, &refusal) {
                    mixdog_rt::node_stderr!("[anthropic-oauth] unknown model — refreshing catalog + 1 retry");
                    // `_refreshModelCache`: the roster file is fetched again and rewritten (the one refresh OpenAI's replay runs too);
                    // the rows the replay decides on are then read from the listing.
                    self.codec.config().listing.refresh_roster("anthropic-oauth").await;
                    let refreshed = self.list_rows().await.ok();
                    let next = refreshed.as_deref().and_then(|rows| super::models::resolve_after_404(rows, &request.model));
                    let mut replay = (*request).clone();
                    if let Some(next) = next {
                        mixdog_rt::node_stderr!("[anthropic-oauth] {} left the catalog — continuing on {next}", request.model);
                        request.options.send_identity.raise_stage_with(
                            "notice",
                            serde_json::json!({ "tone": "info", "message": format!("{} is no longer offered — continuing on {next}", request.model) }),
                        );
                        replay.model = next;
                    }
                    return Box::pin(self.attempt_model(Arc::new(replay), true, version_replayed)).await;
                }
                // A gateway that 404s the streaming endpoint but serves non-streaming: one non-streaming re-issue,
                // nothing having streamed yet (anthropic.mjs:363-368).
                if self.codec.flavor() == Flavor::ApiKey && rejected.status == Some(404) {
                    return self.non_streaming(&request, &wire, &secret, plain.manifest.as_ref()).await;
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
impl AnthropicStream {
    fn new(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self {
            partial: None,
            secret: None,
            body: Some(body),
            decoder,
            queue: VecDeque::new(),
            failed: None,
            last_usage: None,
            thread: None,
            identity: None,
            attempt: None,
            tail: None,
        }
    }

    /// A turn already whole: its events, then the end.
    fn ready(events: Vec<StreamEvent>) -> Self {
        let last_usage = events.iter().rev().find_map(|event| match event {
            StreamEvent::Usage(usage) => Some(usage.clone()),
            _ => None,
        });
        Self {
            partial: None,
            secret: None,
            body: None,
            decoder: Box::new(super::decoder::AnthropicDecoder::for_model(ProviderId::from(""), "")),
            queue: events.into(),
            failed: None,
            last_usage,
            thread: None,
            identity: None,
            attempt: None,
            tail: None,
        }
    }

    fn with_tail(mut self, tail: Tail) -> Self {
        self.tail = tail;
        self
    }

    /// Hands the attempt's input usage (the last report, whole or cut) to the cache owner, once.
    fn settle_tail(&mut self) {
        if let Some(write) = self.tail.take() {
            write.settle(self.last_usage.as_ref().map(Counters::of_usage));
        }
    }

    fn with_identity(mut self, identity: mixdog_core_api::domain::provider::SendIdentity) -> Self {
        self.identity = Some(identity);
        self
    }

    fn with_attempt(mut self, attempt: AttemptHandle) -> Self {
        self.attempt = Some(attempt);
        self
    }

    /// The transport mark (`progress('transport')`, `anthropic-sse.mjs:275`): bytes of the response body arrived, whatever
    /// they decode to. It is health only: no keepalive, no semantic progress, and no phase moves with it. A stream whose
    /// attempt a later one replaced or that ended marks nothing.
    fn mark_transport(&self) {
        let Some(identity) = &self.identity else { return };
        if self.attempt.as_ref().is_none_or(|attempt| attempt.context().is_some()) {
            identity.raise_transport();
        }
    }

    fn with_thread(mut self, thread: Option<ThreadSession>) -> Self {
        self.thread = thread;
        self
    }

    fn with_partial(mut self, partial: super::decoder::Shared) -> Self {
        self.partial = Some(partial);
        self
    }

    fn with_secret(mut self, secret: &Secret) -> Self {
        self.secret = Some(secret.0.clone());
        self
    }

    /// The response ended: the thread records it when the API confirmed storing it.
    fn complete_thread(&mut self) {
        if let Some(thread) = self.thread.take() {
            thread.complete(self.body.take());
        }
    }

    fn enqueue(&mut self, events: Vec<StreamEvent>) {
        if let Some(usage) = events.iter().rev().find_map(|event| match event {
            StreamEvent::Usage(usage) => Some(usage),
            _ => None,
        }) {
            self.last_usage = Some(usage.clone());
            // The API-key opener may still be waiting for output, so its accounting wrapper has not seen this event.
            if let Some(model) = self.partial.as_ref().and_then(super::decoder::Shared::usage_model) {
                crate::registry::accounted::observe_attempt_usage(usage.clone(), Some(model));
            }
        }
        self.queue.extend(events);
    }

    fn fail(&mut self, mut err: ProviderError) {
        self.body = None;
        self.thread = None;
        // The decoder attaches observed usage to in-band errors. Transport cuts carry the last usage event if needed.
        if err.partial_usage.is_none() && err.transport.is_some() {
            err.partial_usage = self.last_usage.clone().map(Box::new);
        }
        // One rule for every cut (a stall, a first-message timeout, a transport fault, a truncation): what the turn had
        // completed travels with it, so a continuation sends its signed thinking back ahead of the calls it keeps.
        // The thinking and the exact replay travel independently: a turn that cannot build the exact replay keeps its thinking.
        if (err.transport.is_some() || err.timeout_phase.is_some())
            && let Some(cut) = self.partial.as_ref().map(super::decoder::Shared::partial)
        {
            if err.partial_thinking_blocks.is_empty() {
                err.partial_thinking_blocks = cut.thinking;
            }
            if err.partial_replay.is_none() {
                err.partial_replay = cut.replay.map(Box::new);
            }
        }
        if let Some(secret) = &self.secret {
            err.message = crate::oauth::scrub::scrub_oauth_secrets(&err.message, &[secret]);
        }
        self.failed = Some(err);
        self.settle_tail();
    }
}
