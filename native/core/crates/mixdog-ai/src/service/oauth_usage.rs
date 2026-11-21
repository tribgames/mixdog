//! Plan-usage measurement for OAuth accounts (`fetchOAuthUsageSnapshot` of
//! `providers/oauth-usage.mjs`): one reading per provider account, cached in
//! memory (60 s) and on disk (`gateway-oauth-usage-cache.json`), recorded into
//! the account roster and the quota history. [`OAuthUsage`] is also the
//! [`UsageProbe`] the account rotation calls.
//!
//! Differences from Node that cannot be observed: disk writes land at once
//! instead of after a 250 ms debounce, and a date-time without an offset reads
//! as UTC.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use serde_json::Value;

use super::usage_normalize as norm;
use super::usage_normalize::Obj;
use super::usage_normalize::clean;
use super::usage_normalize::normalize_anthropic_usage;
use super::usage_normalize::normalize_codex_rate_limits;
use super::usage_normalize::normalize_codex_reset_credits;
use super::usage_normalize::normalize_openai_wham_usage;
use super::usage_normalize::num_or;
use super::usage_normalize::or_truthy;
use crate::accounts::ACCOUNT_PROVIDERS;
use crate::accounts::AccountStore;
use crate::accounts::QuotaWindowInput;
use crate::accounts::rotation::UsageProbe;
use crate::oauth::CredentialIo;

const CACHE_FILE: &str = "gateway-oauth-usage-cache.json";
const LIVE_CACHE_TTL_MS: i64 = 60_000;
const DISK_CACHE_TTL_MS: i64 = 10 * 60_000;
const STALE_DISK_CACHE_TTL_MS: i64 = 7 * 24 * 60 * 60_000;
const NEGATIVE_CACHE_TTL_MS: i64 = 5 * 60_000;
const FETCH_TIMEOUT: Duration = Duration::from_millis(4500);
const WARN_TTL_MS: i64 = 5 * 60_000;
const CODEX_RESET_CREDITS_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_RESET_CONSUME_URL: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
/// Redeeming a reset credit is an explicit user action: it gets the generous
/// budget a redeem needs so a slow backend cannot abort a request the server
/// is already applying.
const CODEX_REDEEM_TIMEOUT: Duration = Duration::from_secs(30);

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A failed usage request; `status` is the HTTP status when the server answered.
#[derive(Clone, Debug, thiserror::Error)]
#[error("{message}")]
pub struct UsageError {
    pub status: Option<u16>,
    pub message: String,
}

impl UsageError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { status: None, message: message.into() }
    }

    fn with_status(message: String, status: u16) -> Self {
        Self { status: Some(status), message }
    }

    /// The server refused the credential: refresh it and ask again.
    fn auth_rejection(&self) -> bool {
        matches!(self.status, Some(401 | 403))
    }
}

pub struct UsageResponse {
    pub status: u16,
    pub body: String,
}

impl UsageResponse {
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    fn json(&self) -> Result<Value, UsageError> {
        serde_json::from_str(&self.body).map_err(|e| UsageError::new(e.to_string()))
    }
}

/// The usage endpoints' HTTP (no redirects; `Err` is a transport failure).
#[async_trait]
pub trait UsageHttp: Send + Sync {
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration) -> Result<UsageResponse, UsageError>;
    async fn post_json(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration) -> Result<UsageResponse, UsageError>;
}

/// The credential one usage request is sent with: a JSON doc with Node's key spelling (`access_token`/`accessToken`,
/// `account_id`, `user_id`, `key`), and the attempt its source handed it out on. The retry behind its refusal hands the
/// whole of it back, so the source refreshes the login of that attempt and of no other.
#[derive(Clone)]
pub struct UsageAuth {
    pub doc: Value,
    /// The source's own; nothing else reads it.
    attempt: Option<Arc<dyn std::any::Any + Send + Sync>>,
}

impl UsageAuth {
    /// A credential whose source tells no login behind it.
    pub fn plain(doc: Value) -> Self {
        Self { doc, attempt: None }
    }

    /// A credential handed out on `attempt`, which [`Self::attempt`] gives back to the source.
    pub fn sent_on(doc: Value, attempt: impl std::any::Any + Send + Sync) -> Self {
        Self { doc, attempt: Some(Arc::new(attempt)) }
    }

    pub fn attempt<T: std::any::Any>(&self) -> Option<&T> {
        self.attempt.as_ref()?.downcast_ref()
    }
}

/// The provider side of a measurement: its credential and, for the providers
/// that report plan usage themselves, their own snapshot.
#[async_trait]
pub trait UsageSource: Send + Sync {
    /// The account's credential (`ensureAuth({reason: 'usage'})`). `rejected` is the retry after a 401/403: the
    /// credential the refused request was sent with, whose login is refreshed (`forceRefresh`).
    async fn ensure_auth(&self, provider: &str, account_id: &str, rejected: Option<&UsageAuth>) -> Result<Option<UsageAuth>, UsageError>;

    /// `getUsageSnapshot()` of cursor-oauth, cursor-api, antigravity-oauth,
    /// muse-code-oauth, command-code-oauth and opencode-go-oauth.
    async fn provider_snapshot(&self, provider: &str, account_id: &str) -> Result<Option<Value>, UsageError>;

    /// Resolve the configured key once, before either a cache lookup or a new flight.
    async fn cursor_api_plan(&self) -> Result<Option<Arc<dyn CursorApiPlan>>, UsageError> {
        Ok(None)
    }

    /// Whether the provider can refresh its credential on demand (the retry
    /// after a rejected token).
    fn can_refresh(&self, provider: &str) -> bool {
        let _ = provider;
        true
    }
}

#[async_trait]
pub trait CursorApiPlan: Send + Sync {
    fn key_identity(&self) -> [u8; 32];
    async fn read(&self) -> Result<Value, UsageError>;
}

/// The Grok CLI version gate (`grok-client-version.mjs`).
#[async_trait]
pub trait GrokClient: Send + Sync {
    /// Awaited before the first proxy/usage call so a cold start never sends
    /// the floor version.
    async fn warm(&self);
    /// `x-grok-client-version` and `User-Agent`.
    fn headers(&self) -> Vec<(String, String)>;
}

/// One measured quota window of the usage ledger's quota history.
#[derive(Clone, PartialEq, Debug)]
pub struct QuotaSample {
    pub provider: String,
    pub account: String,
    pub label: String,
    pub ts: i64,
    pub used_pct: f64,
    pub reset_at: Option<i64>,
}

/// The usage ledger's quota history (`recordQuotaQueued`).
#[async_trait]
pub trait QuotaHistory: Send + Sync {
    async fn record(&self, samples: Vec<QuotaSample>) -> Result<(), String>;
}

/// Which account of which provider a reading is for.
#[derive(Clone, Debug, Default)]
pub struct RouteInfo {
    pub provider: String,
    pub model: String,
    /// The account the reading is for; callers resolve the roster's selected
    /// account (`currentProviderAccountId`), `default` without a roster.
    pub account_id: String,
}

pub struct UsageDeps {
    pub http: Arc<dyn UsageHttp>,
    pub source: Arc<dyn UsageSource>,
    pub grok: Arc<dyn GrokClient>,
    pub history: Arc<dyn QuotaHistory>,
    pub store: AccountStore,
    /// The lanes the cache file's reads and writes run on.
    pub io: CredentialIo,
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    /// The plugin data directory holding `gateway-oauth-usage-cache.json`.
    pub data_dir: PathBuf,
}

type Inflight = Shared<BoxFuture<'static, Option<Value>>>;

/// The Cursor API plan's readings and flights, per key generation, in memory only; and the warning throttle.
#[derive(Default)]
struct Caches {
    memory: HashMap<String, Value>,
    inflight: HashMap<String, Inflight>,
    last_warn: HashMap<String, i64>,
    cursor_key: Option<[u8; 32]>,
    cursor_generation: u64,
}

pub struct OAuthUsage {
    deps: UsageDeps,
    /// The readings of the cache file, shared with every other service over that file.
    cache: Arc<cache::UsageCache>,
    caches: Mutex<Caches>,
    cursor_resolve: tokio::sync::Semaphore,
}

// keys and freshness

/// The snapshot field naming the sign-in a reading was measured under.
const CREDENTIAL_STAMP: &str = "credentialStamp";

/// Marks a reading with the sign-in whose request produced it. Only the source that sent the successful request knows
/// which credential that was (an auth retry or a replaced login changes it), so the mark is made there, never inferred
/// from the credential before or after.
pub fn stamp_reading(reading: &mut Value, stamp: Option<String>) {
    if let (Some(stamp), Some(object)) = (stamp, reading.as_object_mut()) {
        object.insert(CREDENTIAL_STAMP.into(), Value::String(stamp));
    }
}

/// An opaque identity of an OAuth sign-in: its account identity when the document names one, else its access token. A
/// document with no access token (an API key, a logged-out file) has none, so it never gates on a subscription reading.
/// The two spellings of a credential (the usage source's and the file's) may name different fields; a stamp that does
/// not match leaves the reading unused, never applied.
pub fn credential_stamp(provider: &str, doc: &serde_json::Map<String, Value>) -> Option<String> {
    let nested = doc.get("claudeAiOauth").and_then(Value::as_object).unwrap_or(doc);
    let pick = |keys: &[&str]| keys.iter().find_map(|k| nested.get(*k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()));
    let token = pick(&["access_token", "accessToken"])?;
    let identity = pick(&["account_id", "accountId", "user_id", "userId", "project_id", "projectId", "email"]).unwrap_or(token);
    Some(crate::catalog::account_fingerprint(&[provider, identity]))
}

/// What the window states is left of it (dollars or credits), kept beside its percent, which is stored as observed: a
/// rounded 100% with something left is judged by `policy::window_full`, never rewritten here.
fn remaining_of(window: &Value) -> Option<f64> {
    ["remainingUsd", "remainingCredits"].iter().find_map(|k| window.get(*k).and_then(Value::as_f64))
}

/// The quota windows and cache moment of `snapshot`.
fn snapshot_windows(snapshot: &Value) -> Option<(Vec<crate::accounts::Window>, i64)> {
    let windows = snapshot
        .get("quotaWindows")
        .and_then(Value::as_array)?
        .iter()
        .map(|raw| {
            let mut window: crate::accounts::Window = serde_json::from_value(raw.clone()).unwrap_or_default();
            if let Some(left) = remaining_of(raw).and_then(serde_json::Number::from_f64) {
                window.extra.insert(crate::accounts::REMAINING.to_owned(), Value::Number(left));
            }
            window
        })
        .collect();
    Some((windows, snapshot.get("cachedAt").and_then(Value::as_f64).unwrap_or(0.0) as i64))
}

fn provider_key(route: &RouteInfo) -> String {
    route.provider.to_lowercase()
}

fn cache_provider_key(route: &RouteInfo) -> String {
    let provider = provider_key(route);
    if route.account_id == "default" { provider } else { format!("{provider}\u{2}{}", route.account_id) }
}

fn route_key(route: &RouteInfo) -> String {
    format!("{}\u{1}{}", cache_provider_key(route), route.model)
}

/// A route cache key is a model identifier, not free-form text: a malformed
/// route once copied a user prompt into the provider-wide cache.
fn cache_model_id(v: Option<&Value>) -> Option<String> {
    let model = clean(v)?;
    (model.chars().count() <= 160 && !model.chars().any(char::is_whitespace)).then_some(model)
}

fn contentful(snapshot: &Value) -> bool {
    snapshot.get("quotaWindows").and_then(Value::as_array).is_some_and(|w| !w.is_empty()) || snapshot.get("balance").is_some_and(Value::is_object)
}

fn has_future_window(snapshot: &Value, now: i64) -> bool {
    let windows = snapshot.get("quotaWindows").and_then(Value::as_array).cloned().unwrap_or_default();
    windows.is_empty() || windows.iter().any(|w| !norm::truthy(w.get("resetAt")) || num_or(w.get("resetAt"), 0.0) > now as f64)
}

fn fresh(snapshot: Option<&Value>, ttl_ms: i64, now: i64) -> Option<Value> {
    let s = snapshot.filter(|s| contentful(s))?;
    let at = num_or(s.get("cachedAt"), 0.0);
    if at == 0.0 || now as f64 - at > ttl_ms as f64 || !has_future_window(s, now) {
        return None;
    }
    Some(s.clone())
}

/// The newest fresh snapshot of `provider` (its bare key or any route key).
fn newest_provider_snapshot<'a>(entries: impl Iterator<Item = (&'a String, &'a Value)>, provider: &str, ttl_ms: i64, now: i64) -> Option<Value> {
    if provider.is_empty() {
        return None;
    }
    let prefix = format!("{provider}\u{1}");
    let mut best: Option<Value> = None;
    let mut best_at = 0.0;
    for (key, snapshot) in entries {
        if key != provider && !key.starts_with(&prefix) {
            continue;
        }
        if let Some(f) = fresh(Some(snapshot), ttl_ms, now) {
            let at = num_or(f.get("cachedAt"), 0.0);
            if at >= best_at {
                best_at = at;
                best = Some(f);
            }
        }
    }
    best
}

// disk cache

// The file functions below are the bodies of lane jobs (`CredentialIo`): reads run on the
// interactive lane, the locked read-modify-write on the durability lane.
#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
pub(super) fn read_json_file(path: &std::path::Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `updateJsonAtomicSync` for the usage cache: one writer per file at a time (the file's
/// lock, shared with every other process), the current content read under that lock (a file
/// that does not parse is recovered as `mixdog-statefile` does), and the new content published
/// atomically. Errors are returned; Node's callers drop them because usage display must never
/// affect the request path.
pub(super) fn update_json_atomic(
    lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
    path: &std::path::Path,
    mutate: impl FnOnce(Option<Value>) -> Value,
) -> std::io::Result<()> {
    let opts = mixdog_statefile::Opts { compact: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::update_json::<_, std::convert::Infallible>(lane, path, |current| Ok(Some(mutate(current))), &opts).map(drop).map_err(
        |error| match error {
            mixdog_statefile::StateError::Io(error) => error,
            other => std::io::Error::other(other.to_string()),
        },
    )
}

fn status_error(prefix: &str, status: u16) -> UsageError {
    UsageError::with_status(format!("{prefix} {status}"), status)
}

fn header(name: &str, value: impl Into<String>) -> (String, String) {
    (name.to_owned(), value.into())
}

struct CodexAuth {
    token: String,
    account_id: Option<String>,
    /// The sign-in this credential is ([`credential_stamp`]).
    stamp: Option<String>,
    /// What the source handed out, for the retry behind a refusal.
    sent: UsageAuth,
}

fn codex_auth_shape(sent: Option<UsageAuth>) -> Option<CodexAuth> {
    let sent = sent?;
    let auth = &sent.doc;
    let token = clean_token(or_truthy(auth, &["access_token", "accessToken"]))?;
    let stamp = auth.as_object().and_then(|doc| credential_stamp("openai-oauth", doc));
    let account_id = clean(or_truthy(auth, &["account_id", "accountId"]));
    Some(CodexAuth { token, account_id, stamp, sent })
}

fn clean_token(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn codex_headers(auth: &CodexAuth, beta: &str) -> Vec<(String, String)> {
    let mut h = vec![header("Authorization", format!("Bearer {}", auth.token)), header("originator", "Codex Desktop")];
    if let Some(id) = &auth.account_id {
        h.push(header("chatgpt-account-id", id.clone()));
    }
    h.push(header("OpenAI-Beta", beta));
    h.push(header("Accept", "application/json"));
    h
}

/// The explicit outcome code of a reset-credit redeem.
fn codex_reset_outcome(code: Option<&Value>) -> Result<&'static str, UsageError> {
    match code.and_then(Value::as_str) {
        Some("reset") => Ok("reset"),
        Some("nothing_to_reset") => Ok("nothingToReset"),
        Some("no_credit") => Ok("noCredit"),
        Some("already_redeemed") => Ok("alreadyRedeemed"),
        other => Err(UsageError::new(format!("Unknown Codex reset outcome: {}", other.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("missing")))),
    }
}

fn is_hex_revision(s: &str) -> bool {
    s.len() == 67 && s.starts_with("v1:") && s[3..].chars().all(|c| c.is_ascii_hexdigit())
}

fn is_uuid_v1_to_5(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    let widths = [8, 4, 4, 4, 12];
    parts.len() == 5
        && parts.iter().zip(widths).all(|(p, w)| p.len() == w && p.chars().all(|c| c.is_ascii_hexdigit()))
        && matches!(parts[2].as_bytes()[0], b'1'..=b'5')
        && matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

/// The result of a redeem: the server's outcome and the offer left.
#[derive(Clone, Debug)]
pub struct ResetCreditResult {
    pub outcome: &'static str,
    pub reset_credits: Option<Value>,
}

impl OAuthUsage {
    pub fn new(deps: UsageDeps) -> Arc<Self> {
        let cache = cache::UsageCache::for_path(deps.data_dir.join(CACHE_FILE), deps.io, deps.log.clone());
        Arc::new(Self { deps, cache, caches: Mutex::new(Caches::default()), cursor_resolve: tokio::sync::Semaphore::new(1) })
    }

    /// This service as the account rotation's [`UsageProbe`].
    pub fn probe(self: &Arc<Self>) -> Arc<dyn UsageProbe> {
        Arc::new(Arc::clone(self))
    }

    fn caches(&self) -> std::sync::MutexGuard<'_, Caches> {
        self.caches.lock().unwrap_or_else(PoisonError::into_inner)
    }

    async fn cursor_plan(&self) -> (Option<Arc<dyn CursorApiPlan>>, u64) {
        let _serial = self.cursor_resolve.acquire().await.expect("the cursor gate is never closed");
        let plan = self.deps.source.cursor_api_plan().await.ok().flatten();
        let identity = plan.as_ref().map(|plan| plan.key_identity());
        let mut caches = self.caches();
        if caches.cursor_key != identity {
            caches.cursor_key = identity;
            caches.cursor_generation += 1;
            caches.memory.retain(|key, _| !key.starts_with("cursor-api\u{2}"));
            caches.inflight.retain(|key, _| !key.starts_with("cursor-api\u{2}"));
        }
        (plan, caches.cursor_generation)
    }

    async fn fetch_cursor_plan(self: &Arc<Self>, route: &RouteInfo, force: bool) -> Option<Value> {
        let (plan, generation) = self.cursor_plan().await;
        let plan = plan?;
        let key = format!("cursor-api\u{2}{generation}");
        let flight = {
            let mut caches = self.caches();
            if caches.cursor_generation != generation {
                return None;
            }
            if !force && let Some(hit) = fresh(caches.memory.get(&key), LIVE_CACHE_TTL_MS, now_ms()) {
                return Some(cursor_route_view(hit, route));
            }
            if let Some(running) = caches.inflight.get(&key) {
                running.clone()
            } else {
                let service = Arc::downgrade(self);
                let flight_key = key.clone();
                let account = route.account_id.clone();
                let task = async move {
                    let reading = plan.read().await.ok().filter(contentful);
                    let service = service.upgrade()?;
                    let (active, current) = service.cursor_plan().await;
                    let reading = reading.filter(|_| active.is_some() && current == generation).map(|mut reading| {
                        reading["cachedAt"] = Value::from(now_ms());
                        reading
                    });
                    {
                        let mut caches = service.caches();
                        caches.inflight.remove(&flight_key);
                        if caches.cursor_generation != generation {
                            return None;
                        }
                        if let Some(reading) = reading.as_ref() {
                            caches.memory.insert(flight_key, reading.clone());
                        }
                    }
                    if let Some(reading) = reading.as_ref() {
                        service.record_quota_history("cursor-api", &account, reading).await;
                    }
                    reading
                }
                .boxed()
                .shared();
                caches.inflight.insert(key, task.clone());
                task
            }
        };
        let reading = flight.await?;
        let (_, current) = self.cursor_plan().await;
        (current == generation).then(|| cursor_route_view(reading, route))
    }

    fn log(&self, message: &str) {
        (self.deps.log)(message);
    }

    fn warn_throttled(&self, key: &str, message: &str) {
        let now = now_ms();
        {
            let mut c = self.caches();
            if let Some(last) = c.last_warn.get(key).copied().filter(|l| *l != 0)
                && now - last < WARN_TTL_MS
            {
                return;
            }
            c.last_warn.insert(key.to_owned(), now);
        }
        self.log(message);
    }

    /// The cached reading for a route without measuring (`readCachedOAuthUsageSnapshot`).
    pub async fn read_cached(&self, route: &RouteInfo, allow_stale: bool) -> Option<Value> {
        if provider_key(route) == "cursor-api" {
            let (plan, generation) = self.cursor_plan().await;
            plan?;
            let caches = self.caches();
            let key = format!("cursor-api\u{2}{generation}");
            return fresh(caches.memory.get(&key), LIVE_CACHE_TTL_MS, now_ms()).map(|reading| cursor_route_view(reading, route));
        }
        self.cache.displayed(&route_key(route), &cache_provider_key(route), allow_stale).await
    }

    /// The stored `default`-slot reading of `provider`, only when it was measured for this provider under the sign-in
    /// `stamp` names ([`credential_stamp`]): another credential's, an unstamped or a foreign reading is none.
    pub async fn read_bound(&self, provider: &str, stamp: &str) -> Option<(Vec<crate::accounts::Window>, i64)> {
        let route = RouteInfo { provider: provider.to_owned(), model: String::new(), account_id: "default".to_owned() };
        let snapshot = self.read_cached(&route, false).await?;
        let named = |field: &str| snapshot.get(field).and_then(Value::as_str);
        if named("accountId") != Some("default") || named("provider") != Some(provider) || named(CREDENTIAL_STAMP) != Some(stamp) {
            return None;
        }
        snapshot_windows(&snapshot)
    }

    /// Drops every cached reading of one provider (memory and disk): a
    /// mutation that changes quota server-side must not keep serving the
    /// pre-mutation meters.
    pub async fn invalidate(&self, provider: &str) {
        let provider_only = provider.to_lowercase();
        if provider_only.is_empty() {
            return;
        }
        self.caches().memory.retain(|key, _| !key.starts_with(&format!("{provider_only}\u{2}")));
        // The readings are gone from here on; the file's erase is awaited but decides nothing (a failure is said by
        // the task, and stays owed to the file).
        let _ = self.cache.invalidate_provider(&provider_only).await;
    }

    // Codex

    async fn codex_auth(&self, account_id: &str, rejected: Option<&UsageAuth>) -> Result<Option<CodexAuth>, UsageError> {
        let auth = self.deps.source.ensure_auth("openai-oauth", account_id, rejected).await?;
        Ok(codex_auth_shape(auth))
    }

    async fn reset_credits_with_auth(&self, auth: &CodexAuth) -> Result<Option<Value>, UsageError> {
        let res = self.deps.http.get(CODEX_RESET_CREDITS_URL, &codex_headers(auth, "codex-1"), FETCH_TIMEOUT).await?;
        if !res.ok() {
            return Ok(None);
        }
        let account = auth.account_id.clone().unwrap_or_default();
        Ok(normalize_codex_reset_credits(Some(&res.json()?), &account, now_ms()))
    }

    /// The reset-credit offer of an account (`fetchOpenAICodexResetCredits`).
    pub async fn fetch_codex_reset_credits(&self, account_id: &str) -> Result<Option<Value>, UsageError> {
        match self.codex_auth(account_id, None).await? {
            Some(auth) => self.reset_credits_with_auth(&auth).await,
            None => Ok(None),
        }
    }

    async fn post_consume(&self, auth: &CodexAuth, key: &str) -> Result<UsageResponse, UsageError> {
        let mut headers = codex_headers(auth, "codex-1");
        headers.push(header("Content-Type", "application/json"));
        let body = serde_json::json!({ "redeem_request_id": key });
        self.deps.http.post_json(CODEX_RESET_CONSUME_URL, &headers, &body, CODEX_REDEEM_TIMEOUT).await
    }

    /// Redeems a reset credit (`consumeOpenAICodexResetCredit`). The server
    /// decides the outcome; the request is idempotent, so ONE replay after a
    /// transport failure turns an unknown outcome into the server's answer.
    pub async fn consume_codex_reset_credit(
        &self,
        account_id: &str,
        expected_offer_revision: &str,
        idempotency_key: &str,
    ) -> Result<ResetCreditResult, UsageError> {
        let revision = expected_offer_revision.trim();
        let key = idempotency_key.trim();
        if !is_hex_revision(revision) {
            return Err(UsageError::new("Codex reset offer revision is invalid"));
        }
        if !is_uuid_v1_to_5(key) {
            return Err(UsageError::new("Codex reset idempotency key is invalid"));
        }
        let Some(auth) = self.codex_auth(account_id, None).await? else {
            return Err(UsageError::new("Codex is not signed in"));
        };
        let response = match self.post_consume(&auth, key).await {
            Ok(r) => r,
            Err(_) => self.post_consume(&auth, key).await?,
        };
        if !response.ok() {
            return Err(UsageError::new(format!("Codex reset failed: HTTP {}", response.status)));
        }
        let outcome = codex_reset_outcome(response.json()?.get("code"))?;
        self.invalidate("openai-oauth").await;
        let reset_credits = self.reset_credits_with_auth(&auth).await.ok().flatten();
        Ok(ResetCreditResult { outcome, reset_credits })
    }

    async fn fetch_codex_usage(&self, account_id: &str, rejected: Option<&UsageAuth>, sent: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        let Some(auth) = self.codex_auth(account_id, rejected).await? else { return Ok(None) };
        *sent = Some(auth.sent.clone());
        let headers = codex_headers(&auth, "responses=experimental");
        let usage_request = self.deps.http.get("https://chatgpt.com/backend-api/wham/usage", &headers, FETCH_TIMEOUT);
        let (res, credits) = futures::future::join(usage_request, self.reset_credits_with_auth(&auth)).await;
        let res = res?;
        if !res.ok() {
            return Err(status_error("openai-oauth usage", res.status));
        }
        let data = res.json()?;
        let now = now_ms();
        let Some(mut usage) = normalize_openai_wham_usage(&data, now) else { return Ok(None) };
        // /wham/usage may carry the authoritative count while the detail
        // endpoint is down: keep it, and let richer expiry details replace it.
        let account = auth.account_id.clone().unwrap_or_default();
        let embedded = normalize_codex_reset_credits(data.get("rate_limit_reset_credits"), &account, now);
        if let Some(resolved) = credits.ok().flatten().or(embedded)
            && let Some(o) = usage.as_object_mut()
        {
            o.insert("resetCredits".into(), resolved);
        }
        stamp_reading(&mut usage, auth.stamp.clone());
        Ok(Some(usage))
    }

    // Anthropic

    async fn fetch_anthropic_usage(&self, account_id: &str, rejected: Option<&UsageAuth>, sent: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        let auth = self.deps.source.ensure_auth("anthropic-oauth", account_id, rejected).await?;
        sent.clone_from(&auth);
        let auth = auth.map(|auth| auth.doc);
        let Some(token) = auth.as_ref().and_then(|a| clean_token(or_truthy(a, &["accessToken", "access_token"]))) else {
            return Ok(None);
        };
        let headers = vec![
            header("Authorization", format!("Bearer {token}")),
            header("anthropic-beta", "oauth-2025-04-20"),
            header("User-Agent", "claude-code/2.0.0"),
            header("Content-Type", "application/json"),
            header("Accept", "application/json"),
        ];
        let res = self.deps.http.get("https://api.anthropic.com/api/oauth/usage", &headers, FETCH_TIMEOUT).await?;
        if !res.ok() {
            return Err(status_error("anthropic oauth usage", res.status));
        }
        let Some(mut usage) = normalize_anthropic_usage(&res.json()?, "anthropic-oauth", now_ms()) else { return Ok(None) };
        stamp_reading(&mut usage, auth.as_ref().and_then(Value::as_object).and_then(|doc| credential_stamp("anthropic-oauth", doc)));
        Ok(Some(usage))
    }

    // Grok

    fn grok_headers(token: &str, user_id: &str, extra: Vec<(String, String)>) -> Vec<(String, String)> {
        let mut h = vec![
            header("Authorization", format!("Bearer {token}")),
            header("X-XAI-Token-Auth", "xai-grok-cli"),
            header("x-userid", user_id),
            header("Accept", "application/json"),
        ];
        h.extend(extra);
        h
    }

    /// `format=credits` is what the official CLI requests: unified-billing
    /// accounts only report their real cadence and reset there; the legacy
    /// shape stays a fallback.
    async fn probe_grok_billing(&self, headers: &[(String, String)], route: &RouteInfo, refused: &mut Option<u16>) -> Option<Value> {
        for url in ["https://cli-chat-proxy.grok.com/v1/billing?format=credits", "https://cli-chat-proxy.grok.com/v1/billing"] {
            let Ok(res) = self.deps.http.get(url, headers, FETCH_TIMEOUT).await else { continue };
            if !res.ok() {
                note_grok_refusal(url, res.status, refused);
                continue;
            }
            let Ok(data) = res.json() else { continue };
            let config = data.get("config").filter(|c| c.is_object()).unwrap_or(&data);
            let now = now_ms();
            if let Some(window) = norm::credit_window_from_billing(config, now) {
                let mut keys: Vec<String> = data.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
                keys.sort();
                let mut out = Obj::new();
                out.insert("provider".into(), Value::String(grok_provider(route)));
                out.insert("model".into(), if route.model.is_empty() { Value::Null } else { route.model.clone().into() });
                out.insert("source".into(), "grok-build-billing".into());
                out.insert("quotaWindows".into(), Value::Array(vec![window]));
                out.insert("balance".into(), norm::balance_from_grok_billing(config, now));
                out.insert("rawKeys".into(), keys.into_iter().map(Value::String).collect());
                return Some(Value::Object(out));
            }
        }
        None
    }

    async fn probe_grok_generic(&self, headers: &[(String, String)], route: &RouteInfo, refused: &mut Option<u16>) -> Option<Value> {
        for url in [
            "https://cli-chat-proxy.grok.com/v1/billing",
            "https://api.x.ai/v1/usage",
            "https://api.x.ai/v1/rate_limits",
            "https://api.x.ai/v1/rate-limits",
            "https://cli-chat-proxy.grok.com/v1/usage",
            "https://cli-chat-proxy.grok.com/v1/rate_limits",
        ] {
            let Ok(res) = self.deps.http.get(url, headers, Duration::from_millis(2500)).await else { continue };
            if !res.ok() {
                note_grok_refusal(url, res.status, refused);
                continue;
            }
            let Ok(data) = res.json() else { continue };
            let now = now_ms();
            let parsed = normalize_codex_rate_limits(or_truthy(&data, &["rate_limits", "rateLimits"]), "grok-oauth", now)
                .or_else(|| normalize_anthropic_usage(&data, "grok-oauth", now));
            if let Some(mut parsed) = parsed {
                if let Some(o) = parsed.as_object_mut() {
                    o.insert("provider".into(), Value::String(grok_provider(route)));
                }
                return Some(parsed);
            }
        }
        None
    }

    async fn fetch_grok_usage(&self, route: &RouteInfo, rejected: Option<&UsageAuth>, sent: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        let auth = self.deps.source.ensure_auth("grok-oauth", &route.account_id, rejected).await?;
        let Some(auth) = auth else { return Ok(None) };
        *sent = Some(auth.clone());
        let auth = auth.doc;
        let Some(token) = clean_token(or_truthy(&auth, &["access_token", "accessToken", "key"])) else {
            return Ok(None);
        };
        let user_id = or_truthy(&auth, &["user_id", "userId", "principal_id", "principalId"]).and_then(Value::as_str).unwrap_or("").to_owned();
        self.deps.grok.warm().await;
        let cli = Self::grok_headers(&token, &user_id, self.deps.grok.headers());
        let mut refused = None;
        if let Some(billing) = self.probe_grok_billing(&cli, route, &mut refused).await {
            return Ok(Some(billing));
        }
        let generic = Self::grok_headers(&token, &user_id, vec![header("User-Agent", "xai-grok-build/mixdog")]);
        if let Some(usage) = self.probe_grok_generic(&generic, route, &mut refused).await {
            return Ok(Some(usage));
        }
        // No probe gave a reading and the proxy refused the token: that is the measurement's answer, so the retry
        // behind a refused credential runs.
        match refused {
            Some(status) => Err(status_error("grok-oauth usage", status)),
            None => Ok(None),
        }
    }

    // measurement

    /// `rejected`: the credential a refused measurement was sent with, for the retry behind it. `sent`: the one this
    /// measurement was sent with, once its source handed it out.
    async fn measure_usage(&self, route: &RouteInfo, rejected: Option<&UsageAuth>, sent: &mut Option<UsageAuth>) -> Result<Option<Value>, UsageError> {
        let provider = provider_key(route);
        match provider.as_str() {
            "openai-oauth" => self.fetch_codex_usage(&route.account_id, rejected, sent).await,
            "anthropic-oauth" => self.fetch_anthropic_usage(&route.account_id, rejected, sent).await,
            "grok-oauth" => self.fetch_grok_usage(route, rejected, sent).await,
            "cursor-oauth" | "cursor-api" | "antigravity-oauth" | "muse-code-oauth" | "command-code-oauth" | "opencode-go-oauth" => {
                self.deps.source.provider_snapshot(&provider, &route.account_id).await
            }
            _ => Ok(None),
        }
    }

    /// One measurement, retried once behind a forced credential refresh when
    /// the server rejected the token: the stored expiry is only what the
    /// server said at issue, a subscription change can revoke it earlier.
    async fn measure_with_auth_retry(&self, route: &RouteInfo) -> Result<Option<Value>, UsageError> {
        let mut sent = None;
        match self.measure_usage(route, None, &mut sent).await {
            Err(e) if e.auth_rejection() && self.deps.source.can_refresh(&provider_key(route)) => {
                // The refresh is for the credential the refused request itself carried.
                let rejected = sent.take();
                self.measure_usage(route, rejected.as_ref(), &mut sent).await
            }
            other => other,
        }
    }

    /// The fallback after a failed measurement, and its bookkeeping. A
    /// credential the server refuses even after a forced refresh cannot vouch
    /// for the reading it last produced: the recorded quota goes with it.
    async fn usage_after_failure(&self, err: &UsageError, provider: &str, account_id: &str) -> Option<Value> {
        if err.auth_rejection()
            && ACCOUNT_PROVIDERS.contains(&provider)
            && !crate::accounts::rotation::uses_bound_plan_evidence(provider)
            && let Err(e) = self.deps.store.clear_quota_state(provider, account_id).await
        {
            self.log(&format!("Account usage could not be cleared: {e}"));
        }
        self.warn_throttled(&format!("oauth-usage:{provider}"), &format!("gateway {provider} usage fetch unavailable: {err}"));
        None
    }

    /// Caches the reading under the provider key and, when the route names a
    /// model, under the model-qualified key; returns the route's own view.
    fn cache_snapshot(&self, ticket: &cache::Ticket, snapshot: &Value, route: &RouteInfo, provider: &str, provider_only: &str) -> Value {
        let model = cache_model_id(Some(&Value::String(route.model.clone()))).or_else(|| cache_model_id(snapshot.get("model")));
        let mut provider_snapshot = snapshot.as_object().cloned().unwrap_or_default();
        let provider_name =
            if route.provider.is_empty() { clean_token(snapshot.get("provider")).unwrap_or_else(|| provider.to_owned()) } else { route.provider.clone() };
        provider_snapshot.insert("provider".into(), Value::String(provider_name));
        provider_snapshot.insert("accountId".into(), Value::String(route.account_id.clone()));
        provider_snapshot.insert("cachedAt".into(), Value::from(now_ms()));
        provider_snapshot.shift_remove("model");
        let mut route_snapshot = provider_snapshot.clone();
        let mut updates = Vec::new();
        if let Some(model) = &model {
            route_snapshot.insert("model".into(), Value::String(model.clone()));
            updates.push((format!("{provider_only}\u{1}{model}"), Value::Object(route_snapshot.clone())));
        }
        updates.push((provider_only.to_owned(), Value::Object(provider_snapshot)));
        // Published only while the measurement's ticket is current; a retirement since leaves nothing of it.
        self.cache.put(ticket, updates);
        Value::Object(route_snapshot)
    }

    async fn record_quota_history(&self, provider: &str, account: &str, snapshot: &Value) {
        let ts = now_ms();
        let samples: Vec<QuotaSample> = snapshot
            .get("quotaWindows")
            .and_then(Value::as_array)
            .map(|ws| {
                ws.iter()
                    .filter_map(|w| {
                        let label: String = clean(w.get("label"))?.chars().take(40).collect();
                        let used = w.get("usedPct").and_then(Value::as_f64).filter(|u| u.is_finite() && *u >= 0.0)?;
                        let reset_at = w.get("resetAt").and_then(Value::as_f64).filter(|r| r.is_finite()).map(|r| r.round() as i64);
                        Some(QuotaSample {
                            provider: provider.to_owned(),
                            account: if account.is_empty() { "default".into() } else { account.to_owned() },
                            label,
                            ts,
                            used_pct: norm::round(used, 2),
                            reset_at,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if samples.is_empty() {
            return;
        }
        if let Err(e) = self.deps.history.record(samples).await {
            self.log(&format!("Quota history could not be saved: {e}"));
        }
    }

    /// Records the reading's windows on the account's roster row. False when the roster write was refused or failed: the
    /// roster does not hold the reading.
    async fn record_account_usage(&self, provider: &str, account_id: &str, snapshot: &Value) -> bool {
        let Some(windows) = snapshot.get("quotaWindows").and_then(Value::as_array) else { return true };
        // Each stored window keeps the sign-in whose request measured it: after a restart that is what lets a withdrawn
        // meter retire the row's old usage and nothing another credential measured.
        let stamp = snapshot.get(CREDENTIAL_STAMP).and_then(Value::as_str).map(str::to_owned);
        let strings = |v: Option<&Value>| v.and_then(Value::as_array).map(|a| a.iter().map(|t| t.as_str().unwrap_or("").to_owned()).collect::<Vec<_>>());
        let inputs: Vec<QuotaWindowInput> = windows
            .iter()
            .take(12)
            .map(|w| QuotaWindowInput {
                label: w.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
                used_pct: w.get("usedPct").and_then(Value::as_f64),
                remaining: remaining_of(w),
                credential: stamp.clone(),
                reset_at: w.get("resetAt").and_then(Value::as_f64).map(|r| r as i64),
                models: strings(w.get("models")),
                except: strings(w.get("except")),
                limit: w.get("limit").and_then(Value::as_str).map(str::to_owned),
                binding: w.get("binding").and_then(Value::as_bool),
            })
            .collect();
        match self.deps.store.record_usage(provider, account_id, inputs).await {
            Ok(()) => true,
            Err(e) => {
                self.log(&format!("Account usage could not be saved: {e}"));
                false
            }
        }
    }

    /// The reading for a route, measured when the cached one is not current;
    /// `None` for a provider that is not an OAuth account or that reports
    /// nothing (`fetchOAuthUsageSnapshot`). `force` bypasses the caches.
    pub async fn fetch_snapshot(self: &Arc<Self>, route: &RouteInfo, force: bool) -> Option<Value> {
        let provider = provider_key(route);
        if provider == "cursor-api" {
            return self.fetch_cursor_plan(route, force).await;
        }
        if !provider.contains("oauth") {
            return None;
        }
        let key = route_key(route);
        let provider_only = cache_provider_key(route);
        if !force {
            // A reading this process measured within the live window; one the file seeded is not a measurement.
            let cached = self.cache.measured(&key, &provider_only).await;
            if cached.is_some() {
                return cached;
            }
            if self.cache.measured_nothing(&key, &provider_only).await {
                return None;
            }
        }
        let (ticket, measuring) = {
            let this = Arc::clone(self);
            let (route, key2, provider_only2) = (route.clone(), key.clone(), provider_only.clone());
            let start = move |ticket: cache::Ticket| -> BoxFuture<'static, Option<Value>> {
                async move {
                    let out = this.measure_and_cache(&route, &provider, &provider_only2, &ticket).await;
                    this.cache.ended(&key2, &ticket);
                    out
                }
                .boxed()
            };
            self.cache.measuring(&key, &provider_only, start).await
        };
        let answer = measuring.await;
        // A measurement whose epoch a retirement ended serves nothing: the caller gets what is current for the route.
        self.cache.resolved(&ticket, answer, &key)
    }

    async fn measure_and_cache(&self, route: &RouteInfo, provider: &str, provider_only: &str, ticket: &cache::Ticket) -> Option<Value> {
        let key = route_key(route);
        let measured = self.measure_with_auth_retry(route).await;
        // A retirement overtook the measurement: what it brings back, a reading, nothing or a failure, changes nothing
        // in the cache, the roster or the history.
        if !self.cache.current(ticket) {
            return None;
        }
        let snapshot = match measured {
            Ok(s) => s,
            Err(e) => self.usage_after_failure(&e, provider, &route.account_id).await,
        };
        if let Some(none) = snapshot.as_ref().filter(|s| !contentful(s) && s.get("quotaWindows").is_some_and(Value::is_array))
            && let Some(stamp) = none.get(CREDENTIAL_STAMP).and_then(Value::as_str)
        {
            // The slot's readings that sign-in measured are gone from here on, so a withdrawn limit is not served
            // again; the file's erase is its own task, which this measurement does not wait for. Not for a ticket
            // overtaken meanwhile: then the roster keeps its usage too.
            if self.cache.retire_stamped(ticket, stamp).is_some()
                && ACCOUNT_PROVIDERS.contains(&provider)
                && let Err(e) = self.deps.store.retire_usage(provider, &route.account_id, stamp).await
            {
                self.log(&format!("Account usage could not be retired: {e}"));
            }
            // Do not replace another sign-in's cached reading with a slot-wide negative entry.
            return None;
        }
        let Some(snapshot) = snapshot.filter(contentful) else {
            if !crate::accounts::rotation::uses_bound_plan_evidence(provider) {
                self.cache.put_negative(ticket, &[&key, provider_only]);
            }
            return None;
        };
        // The roster is what the pool and the quota check choose over. A reading it does not hold is a failed reading:
        // it is not returned as measured, and not cached, so the next call measures and records again.
        if ACCOUNT_PROVIDERS.contains(&provider) && !self.record_account_usage(provider, &route.account_id, &snapshot).await {
            return None;
        }
        if !self.cache.current(ticket) {
            return None;
        }
        self.record_quota_history(provider, &route.account_id, &snapshot).await;
        Some(self.cache_snapshot(ticket, &snapshot, route, provider, provider_only))
    }
}

fn cursor_route_view(mut reading: Value, route: &RouteInfo) -> Value {
    reading["accountId"] = Value::String(route.account_id.clone());
    if let Some(model) = cache_model_id(Some(&Value::String(route.model.clone()))) {
        reading["model"] = Value::String(model);
    }
    reading
}

/// Keeps the first 401 the Grok CLI proxy answered a usage probe with: the host the sign-in's token is for. Another
/// host refusing that token, or any other status, says nothing about the sign-in.
fn note_grok_refusal(url: &str, status: u16, refused: &mut Option<u16>) {
    if status == 401 && url.starts_with("https://cli-chat-proxy.grok.com/") {
        refused.get_or_insert(status);
    }
}

fn grok_provider(route: &RouteInfo) -> String {
    if route.provider.is_empty() { "grok-oauth".into() } else { route.provider.clone() }
}

/// The rotation's probe: a forced or first-time reading of one account, whose
/// result lands in the roster (`fetchOAuthUsageSnapshot` with `{provider,
/// accountId}`); failures are absorbed.
#[async_trait]
impl UsageProbe for Arc<OAuthUsage> {
    async fn measure(&self, provider: &str, account_id: &str, force: bool) {
        let route = RouteInfo { provider: provider.to_owned(), model: String::new(), account_id: account_id.to_owned() };
        let _ = self.fetch_snapshot(&route, force).await;
    }
}

mod cache;
#[cfg(test)]
mod tests;
