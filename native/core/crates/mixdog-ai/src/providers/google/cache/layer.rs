//! Explicit `cachedContents` for the Gemini API (`_ensureGeminiCache`,
//! `_joinOrCreateGeminiCache`, `_createGeminiCache`, `_scheduleGeminiCacheDelete`
//! of `gemini.mjs`): attach a session's live cache, reuse one another session
//! made, or create or refresh one; a request forked from a shared prefix only
//! reads the session's live cache. No timer lives here: the runtime seam
//! ([`CacheRuntime`]) runs the detached create and the delayed delete.

use crate::transport::deadlines::CACHE_CREATE;
use crate::transport::deadlines::CACHE_DELETE;
use std::sync::Arc;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::BoxFuture;
use futures::future::Either;
use futures::future::select;
use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::AdviceRule;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Jitter;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryRow;
use mixdog_core_api::domain::retry::RetrySchedule;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use serde_json::Value;

use crate::oauth::carried;
use crate::retry::StandardRetryDecider;
use crate::retry::random_samples;

use super::super::error::ErrorDialect;
use super::super::error::classify;

use super::policy;
use super::policy::CacheRequest;
use super::policy::Tuning;
use super::registry::CacheEntry;
use super::registry::Claim;
use super::registry::Create;
use super::registry::DELETE_GRACE_MS;
use super::registry::Registry;
use mixdog_core_api::domain::provider::ProviderState;
use crate::transport::HttpSend;
use crate::transport::TransportKind;

/// Clock and task seam; production wires it to the runtime's task tokens.
pub trait CacheRuntime: Send + Sync {
    fn now_ms(&self) -> u64;
    /// Runs `task` to completion even if every caller that wanted its result
    /// has gone away: a cache create is shared by every waiting session.
    fn spawn(&self, task: BoxFuture<'static, ()>);
    /// Runs `task` after `delay_ms`.
    fn spawn_after(&self, delay_ms: u64, task: BoxFuture<'static, ()>);
    /// Resolves `ms` from now, on the runtime's timers; dropping it disarms it.
    fn deadline(&self, ms: u64) -> BoxFuture<'static, ()>;
}

/// One request's ask of the cache.
pub struct Ask<'a> {
    pub model: &'a str,
    pub request: CacheRequest<'a>,
    pub state: Option<&'a ProviderState>,
    pub iteration: u32,
    /// `RequestOptions::shared_cache_prefix_count` is set: read, never write.
    pub fork: bool,
}

/// The cache to attach, and the session state the response carries back.
#[derive(Debug, PartialEq, Eq)]
pub struct Answer {
    pub cache_name: Option<String>,
    /// `Some` when the state changed (an attach, create or refresh).
    pub state: Option<ProviderState>,
}

pub struct ExplicitCache {
    api_key: String,
    fingerprint: String,
    origin: String,
    http: Arc<dyn HttpSend>,
    runtime: Arc<dyn CacheRuntime>,
    registry: Arc<Registry>,
    tuning: Tuning,
}

impl ExplicitCache {
    /// The Gemini API's clock: the one time source of the cache layer (`CacheRuntime::now_ms`), which the dated
    /// model redirects read too (`this._now`).
    pub(in crate::providers::google) fn now_ms(&self) -> u64 {
        self.runtime.now_ms()
    }

    pub fn new(
        api_key: impl Into<String>,
        origin: impl Into<String>,
        http: Arc<dyn HttpSend>,
        runtime: Arc<dyn CacheRuntime>,
        registry: Arc<Registry>,
        tuning: Tuning,
    ) -> Self {
        let api_key = api_key.into();
        Self {
            fingerprint: policy::credential_fingerprint(&api_key),
            api_key,
            origin: origin.into(),
            http,
            runtime,
            registry,
            tuning,
        }
    }

    /// The same cache, serving the key a request is sent with: Node reads the key per send (`_getApiKey()`), and
    /// the cache it makes, finds and drops belongs to that key's fingerprint.
    pub fn keyed(&self, api_key: &str) -> Self {
        Self {
            fingerprint: policy::credential_fingerprint(api_key),
            api_key: api_key.to_owned(),
            origin: self.origin.clone(),
            http: self.http.clone(),
            runtime: self.runtime.clone(),
            registry: self.registry.clone(),
            tuning: self.tuning,
        }
    }

    /// The key was rejected (401): every cache made under it is unusable
    /// (`_invalidateGeminiCachesForCredentialFingerprint`).
    pub fn forget_credential(&self) {
        self.registry.invalidate_credential(&self.fingerprint);
    }

    /// `dropRejectedGeminiCache`, registry half: the server refused `name`.
    pub fn forget(&self, name: &str) {
        self.registry.invalidate_name(name);
    }

    fn wire(&self, method: &str, url: String, body: Vec<u8>) -> WireRequest {
        // `geminiApiHeaders(apiKey, json)` (gemini.mjs:93-95): `Content-Type` first when there is a body, then the key.
        let mut headers = Vec::new();
        if !body.is_empty() {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        }
        headers.push(("x-goog-api-key".to_owned(), self.api_key.clone()));
        WireRequest { transport: TransportKind::Http1, method: method.into(), url, headers, body }
    }

    /// `_ensureGeminiCache`.
    pub async fn ensure(&self, ask: Ask<'_>) -> Answer {
        let none = || Answer { cache_name: None, state: None };
        if self.tuning.disabled {
            return none();
        }
        let state = ask.state.and_then(|s| s.gemini.as_ref());
        let now = self.runtime.now_ms();
        let decision =
            policy::decide(state, ask.model, &self.fingerprint, &ask.request, ask.iteration, now, &self.tuning);
        let attached = || Answer { cache_name: state.filter(|_| decision.can_attach).map(|s| s.cache_name.clone()), state: None };
        if decision.can_reuse {
            return attached();
        }
        // A fork only reads the session's live cache; creating or refreshing
        // one would store the fork's own suffix.
        if ask.fork {
            return attached();
        }
        if self.api_key.is_empty() || policy::explicit_cache_min_tokens(ask.model).is_none() {
            return none();
        }
        if policy::prefix_below_minimum(ask.model, &ask.request) {
            return attached();
        }
        let count = policy::prefix_count(ask.request.contents);
        let hash = policy::prefix_hash(ask.model, &ask.request, count);
        let key = policy::global_cache_key(&self.fingerprint, ask.model, &hash, count);
        let adopted = |entry: &CacheEntry| Answer {
            cache_name: Some(entry.cache_name.clone()),
            // The session's other provider keys ride along unchanged.
            state: Some(ProviderState {
                gemini: Some(entry.attach(ask.iteration)),
                rest: ask.state.map(|s| s.rest.clone()).unwrap_or_default(),
            }),
        };
        match self.registry.claim(&key, now) {
            Claim::Live(entry) => adopted(&entry),
            Claim::Join(create) => {
                // A waiter never inherits the creation duty: it waits for exactly
                // that create, then takes whatever is published for the prefix.
                let made = create.await.ok().flatten().or_else(|| self.registry.get(&key, self.runtime.now_ms()));
                match made {
                    Some(entry) => adopted(&entry),
                    None => attached(),
                }
            }
            Claim::Own { done, wait } => {
                let prior = state.map(|s| s.cache_name.clone());
                let made = self.own_create(&key, ask.model, &ask.request, count, hash, prior, done, wait).await;
                // A failed refresh must not silently keep a cache that may have expired.
                made.map_or_else(none, |entry| adopted(&entry))
            }
        }
    }

    /// Starts the create the registry granted this caller, then waits for it.
    /// The create outlives this caller: the task itself releases the key.
    #[allow(clippy::too_many_arguments)]
    async fn own_create(
        &self,
        key: &str,
        model: &str,
        request: &CacheRequest<'_>,
        count: usize,
        hash: String,
        prior: Option<String>,
        done: oneshot::Sender<Option<CacheEntry>>,
        wait: Create,
    ) -> Option<CacheEntry> {
        let body = policy::create_body(model, &self.tuning, request, count);
        let job = CreateJob {
            http: self.http.clone(),
            runtime: self.runtime.clone(),
            registry: self.registry.clone(),
            origin: self.origin.clone(),
            tuning: self.tuning,
            key: key.to_owned(),
            model: model.to_owned(),
            count,
            hash,
            fingerprint: self.fingerprint.clone(),
            prior,
            post: self.wire("POST", format!("{}/v1beta/cachedContents", self.origin), body.to_string().into_bytes()),
            delete_headers: self.wire("DELETE", String::new(), Vec::new()).headers,
            guard: FlightGuard { registry: self.registry.clone(), key: key.to_owned(), armed: true },
        };
        self.runtime.spawn(job.run(done).boxed());
        wait.await.ok().flatten()
    }
}

/// `withRetry`'s defaults (`stall-policy.mjs`): five attempts, the step at
/// retry `n` being `[250, 1000, 2000, 4000, 8000][n]`, so 1/2/4/8 s, jittered
/// symmetrically by `MIXDOG_PROVIDER_RETRY_JITTER_RATIO` (0.2); advice in full.
fn create_retry_policy(tuning: &Tuning) -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    policy.request = RetryRow::single(RetrySchedule {
        max_retries: 4,
        backoff: Backoff::Ladder([1, 2, 4, 8].map(Duration::from_secs).to_vec()),
        jitter: Jitter::symmetric(tuning.retry_jitter_ratio),
        advice: AdviceRule::honored_in_full(),
    });
    policy
}

/// The line `_createGeminiCache` writes to stderr when the create fails (`gemini.mjs:596`).
fn log_create_failure(message: &str) {
    mixdog_rt::node_stderr!("[gemini] cachedContents.create error: {}", crate::oauth::carried::redact(message));
}

struct CreateJob {
    http: Arc<dyn HttpSend>,
    runtime: Arc<dyn CacheRuntime>,
    registry: Arc<Registry>,
    origin: String,
    tuning: Tuning,
    key: String,
    model: String,
    count: usize,
    hash: String,
    fingerprint: String,
    prior: Option<String>,
    post: WireRequest,
    delete_headers: Vec<(String, String)>,
    guard: FlightGuard,
}

/// Frees the key if the create's task is dropped before it finished (runtime
/// shutdown), so a flight can never outlive its owner.
struct FlightGuard {
    registry: Arc<Registry>,
    key: String,
    armed: bool,
}

impl FlightGuard {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        if self.armed {
            self.registry.release(&self.key);
        }
    }
}

impl CreateJob {
    /// `_createGeminiCache`: never fails; a failure resolves `None` so every
    /// waiter proceeds uncached and the next turn tries again.
    ///
    /// Bounded by `PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS`: at the deadline the
    /// request is dropped and the flight resolves `None` for every joiner.
    async fn run(mut self, done: oneshot::Sender<Option<CacheEntry>>) {
        let deadline = self.runtime.deadline(self.tuning.create_total_ms as u64);
        let entry = match select(Box::pin(self.create()), deadline).await {
            Either::Left((entry, _)) => entry,
            Either::Right(((), _)) => {
                log_create_failure(&format!("Gemini cachedContents.create total timed out after {}ms", self.tuning.create_total_ms as u64));
                None
            }
        };
        self.registry.finish(&self.key, entry, done, self.runtime.now_ms());
        self.guard.disarm();
    }

    /// `withRetry` around the POST (`_postGeminiCacheCreate`): the shared
    /// verdict decides retry and delay from the typed error; each attempt is
    /// bounded by `PROVIDER_CACHE_CREATE_TIMEOUT_MS`. A spent or surfaced
    /// failure resolves `None`, as Node's catch does.
    async fn create(&self) -> Option<CacheEntry> {
        let policy = create_retry_policy(&self.tuning);
        let mut state = RetryState::new(RetryClass::Request, self.model.clone());
        let mut attempt = 0_u32;
        let (name, token_size) = loop {
            attempt += 1;
            let deadline = self.runtime.deadline(self.tuning.create_attempt_ms as u64);
            let error = match select(Box::pin(self.post_once()), deadline).await {
                Either::Left((Ok(made), _)) => break made,
                Either::Left((Err(error), _)) => error,
                // `ProviderTimeoutError`: a transient transport fact, worded by the attempt's timer (`withRetry`).
                Either::Right(((), _)) => {
                    let mut error = ProviderError::transport(TransportFault::Io { os_code: None }, DeliveryState::Ambiguous);
                    error.message = format!("Gemini cachedContents.create attempt {attempt} timed out after {}ms", self.tuning.create_attempt_ms as u64);
                    error
                }
            };
            let decision = StandardRetryDecider.verdict(&error, &state, &policy, random_samples());
            state = decision.next;
            match decision.verdict {
                Verdict::Retry { delay, .. } => self.runtime.deadline(delay.as_millis() as u64).await,
                _ => {
                    log_create_failure(&error.message);
                    return None;
                }
            }
        };
        let now = self.runtime.now_ms();
        if let Some(prior) = self.prior.as_ref().filter(|p| **p != name) {
            self.schedule_delete(prior.clone());
        }
        let entry = CacheEntry {
            cache_name: name,
            cache_created_at: now,
            cache_expires_at: now + (self.tuning.ttl_seconds * 1000.0) as u64,
            cache_model: self.model.clone(),
            cache_token_size: token_size,
            cache_prefix_content_count: self.count,
            cache_prefix_hash: self.hash.clone(),
            cache_credential_fingerprint: self.fingerprint.clone(),
        };
        Some(entry)
    }

    /// One POST: the new cache's name and token size, or the typed failure.
    async fn post_once(&self) -> Result<(String, u64), ProviderError> {
        let response = self.http.send(self.post.clone(), CACHE_CREATE).await?;
        if !response.is_success() {
            let mut rejected = response.read_all().await?;
            // The refusal is classified with the credentials this request carried redacted, whichever link answered.
            carried::note_request(&self.post);
            if let Some(clean) = carried::matcher().redacted(&rejected.body) {
                rejected.body = clean;
            }
            // `geminiRestError(res, text, 'Gemini cachedContents.create')`, whose message the create's catch writes to
            // stderr.
            let now = std::time::UNIX_EPOCH + std::time::Duration::from_millis(self.runtime.now_ms());
            return Err(classify(&rejected, &ErrorDialect::gemini("Gemini cachedContents.create"), now));
        }
        let body = response.read_all().await?.body;
        let unreadable = || ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
        let data: Value = serde_json::from_slice(&body).map_err(|_| unreadable())?;
        let name = data
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty())
            .ok_or_else(unreadable)?
            .to_owned();
        let token_size = data
            .pointer("/usageMetadata/totalTokenCount")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n > 0.0)
            .unwrap_or(0.0) as u64;
        Ok((name, token_size))
    }

    /// Best-effort cleanup of the superseded cache so storage cost accrues on
    /// the live revision only; the TTL reclaims whatever a failed delete leaves.
    fn schedule_delete(&self, name: String) {
        let (http, registry, runtime) = (self.http.clone(), self.registry.clone(), self.runtime.clone());
        let request = WireRequest {
            transport: TransportKind::Http1,
            method: "DELETE".into(),
            url: format!("{}/v1beta/{name}", self.origin),
            headers: self.delete_headers.clone(),
            body: Vec::new(),
        };
        let clock = runtime.clone();
        runtime.spawn_after(
            DELETE_GRACE_MS,
            async move {
                if registry.name_is_live(&name, clock.now_ms()) {
                    return;
                }
                let _ = http.send(request, CACHE_DELETE).await;
            }
            .boxed(),
        );
    }
}
