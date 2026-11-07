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
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
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
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration)
        -> Result<UsageResponse, UsageError>;
    async fn post_json(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &Value,
        timeout: Duration,
    ) -> Result<UsageResponse, UsageError>;
}

/// The provider side of a measurement: its credential and, for the providers
/// that report plan usage themselves, their own snapshot.
#[async_trait]
pub trait UsageSource: Send + Sync {
    /// The account's credential (`ensureAuth({reason: 'usage'})`): a JSON doc
    /// with Node's key spelling (`access_token`/`accessToken`, `account_id`,
    /// `user_id`, `key`). `force_refresh` is the retry after a 401/403.
    async fn ensure_auth(
        &self,
        provider: &str,
        account_id: &str,
        force_refresh: bool,
    ) -> Result<Option<Value>, UsageError>;

    /// `getUsageSnapshot()` of cursor-oauth, cursor-api, antigravity-oauth,
    /// muse-code-oauth, command-code-oauth and opencode-go-oauth.
    async fn provider_snapshot(&self, provider: &str, account_id: &str) -> Result<Option<Value>, UsageError>;

    /// Whether the provider can refresh its credential on demand (the retry
    /// after a rejected token).
    fn can_refresh(&self, provider: &str) -> bool {
        let _ = provider;
        true
    }
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

#[derive(Default)]
struct Caches {
    memory: HashMap<String, Value>,
    inflight: HashMap<String, Inflight>,
    last_warn: HashMap<String, i64>,
}

pub struct OAuthUsage {
    deps: UsageDeps,
    caches: Mutex<Caches>,
}

// -- keys and freshness ---------------------------------------------------------------

fn provider_key(route: &RouteInfo) -> String {
    route.provider.to_lowercase()
}

fn cache_provider_key(route: &RouteInfo) -> String {
    let provider = provider_key(route);
    if route.account_id == "default" {
        provider
    } else {
        format!("{provider}\u{2}{}", route.account_id)
    }
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
    snapshot.get("quotaWindows").and_then(Value::as_array).is_some_and(|w| !w.is_empty())
        || snapshot.get("balance").is_some_and(Value::is_object)
}

fn has_future_window(snapshot: &Value, now: i64) -> bool {
    let windows = snapshot.get("quotaWindows").and_then(Value::as_array).cloned().unwrap_or_default();
    windows.is_empty()
        || windows.iter().any(|w| !norm::truthy(w.get("resetAt")) || num_or(w.get("resetAt"), 0.0) > now as f64)
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
fn newest_provider_snapshot<'a>(
    entries: impl Iterator<Item = (&'a String, &'a Value)>,
    provider: &str,
    ttl_ms: i64,
    now: i64,
) -> Option<Value> {
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

// -- disk cache -----------------------------------------------------------------------

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
    mixdog_statefile::update_json::<_, std::convert::Infallible>(lane, path, |current| Ok(Some(mutate(current))), &opts)
        .map(drop)
        .map_err(|error| match error {
            mixdog_statefile::StateError::Io(error) => error,
            other => std::io::Error::other(other.to_string()),
        })
}

/// Rewrites the routes of the cache file through `edit`. A lane job body: callers on the
/// request path go through [`OAuthUsage::update_disk_cache`].
fn update_disk_cache(
    lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
    path: &std::path::Path,
    edit: impl FnOnce(&mut Obj),
) -> std::io::Result<()> {
    update_json_atomic(lane, path, |current| {
        let mut routes = current
            .as_ref()
            .and_then(|c| c.get("routes"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        edit(&mut routes);
        let mut doc = Obj::new();
        doc.insert("version".into(), Value::from(1));
        doc.insert("updatedAt".into(), Value::from(now_ms()));
        doc.insert("routes".into(), Value::Object(routes));
        Value::Object(doc)
    })
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
}

fn codex_auth_shape(auth: Option<&Value>) -> Option<CodexAuth> {
    let auth = auth?;
    let token = clean_token(or_truthy(auth, &["access_token", "accessToken"]))?;
    Some(CodexAuth { token, account_id: clean(or_truthy(auth, &["account_id", "accountId"])) })
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
        other => Err(UsageError::new(format!(
            "Unknown Codex reset outcome: {}",
            other.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("missing")
        ))),
    }
}

fn is_hex_revision(s: &str) -> bool {
    s.len() == 67
        && s.starts_with("v1:")
        && s[3..].chars().all(|c| c.is_ascii_hexdigit())
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
        Arc::new(Self { deps, caches: Mutex::new(Caches::default()) })
    }

    /// This service as the account rotation's [`UsageProbe`].
    pub fn probe(self: &Arc<Self>) -> Arc<dyn UsageProbe> {
        Arc::new(Arc::clone(self))
    }

    fn caches(&self) -> std::sync::MutexGuard<'_, Caches> {
        self.caches.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn cache_path(&self) -> PathBuf {
        self.deps.data_dir.join(CACHE_FILE)
    }

    /// `edit`s the cache file's routes under the file lock, on the durability lane.
    async fn update_disk_cache(&self, edit: impl FnOnce(&mut Obj) + Send + 'static) -> std::io::Result<()> {
        let path = self.cache_path();
        self.deps.io.write_job(move |lane| update_disk_cache(lane, &path, edit)).await
    }

    fn log(&self, message: &str) {
        (self.deps.log)(message);
    }

    fn warn_throttled(&self, key: &str, message: &str) {
        let now = now_ms();
        {
            let mut c = self.caches();
            if let Some(last) = c.last_warn.get(key).copied().filter(|l| *l != 0) {
                if now - last < WARN_TTL_MS {
                    return;
                }
            }
            c.last_warn.insert(key.to_owned(), now);
        }
        self.log(message);
    }

    /// The cached reading for a route without measuring (`readCachedOAuthUsageSnapshot`).
    pub async fn read_cached(&self, route: &RouteInfo, allow_stale: bool) -> Option<Value> {
        let key = route_key(route);
        let provider_only = cache_provider_key(route);
        let disk_ttl = if allow_stale { STALE_DISK_CACHE_TTL_MS } else { DISK_CACHE_TTL_MS };
        let now = now_ms();
        {
            let c = self.caches();
            let mem = fresh(c.memory.get(&key), LIVE_CACHE_TTL_MS, now)
                .or_else(|| fresh(c.memory.get(&provider_only), LIVE_CACHE_TTL_MS, now))
                .or_else(|| newest_provider_snapshot(c.memory.iter(), &provider_only, LIVE_CACHE_TTL_MS, now));
            if mem.is_some() {
                return mem;
            }
        }
        let path = self.cache_path();
        let raw = self.deps.io.read_job(move |_| Ok(read_json_file(&path))).await.ok().flatten();
        let routes = raw.as_ref().and_then(|r| r.get("routes")).and_then(Value::as_object).cloned().unwrap_or_default();
        fresh(routes.get(&key), disk_ttl, now)
            .or_else(|| fresh(routes.get(&provider_only), disk_ttl, now))
            .or_else(|| newest_provider_snapshot(routes.iter(), &provider_only, disk_ttl, now))
    }

    /// Drops every cached reading of one provider (memory and disk): a
    /// mutation that changes quota server-side must not keep serving the
    /// pre-mutation meters.
    pub async fn invalidate(&self, provider: &str) {
        let provider_only = provider.to_lowercase();
        if provider_only.is_empty() {
            return;
        }
        let owned = move |key: &str| {
            key == provider_only
                || key.starts_with(&format!("{provider_only}\u{1}"))
                || key.starts_with(&format!("{provider_only}\u{2}"))
        };
        self.caches().memory.retain(|k, _| !owned(k));
        // Dropped like Node's catch: the reset path must not fail on display state.
        let _ = self.update_disk_cache(move |routes| routes.retain(|k, _| !owned(k))).await;
    }

    // -- Codex ------------------------------------------------------------------------

    async fn codex_auth(&self, account_id: &str, force_refresh: bool) -> Result<Option<CodexAuth>, UsageError> {
        let auth = self.deps.source.ensure_auth("openai-oauth", account_id, force_refresh).await?;
        Ok(codex_auth_shape(auth.as_ref()))
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
        match self.codex_auth(account_id, false).await? {
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
        let Some(auth) = self.codex_auth(account_id, false).await? else {
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

    async fn fetch_codex_usage(&self, account_id: &str, force_refresh: bool) -> Result<Option<Value>, UsageError> {
        let Some(auth) = self.codex_auth(account_id, force_refresh).await? else { return Ok(None) };
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
        if let Some(resolved) = credits.ok().flatten().or(embedded) {
            if let Some(o) = usage.as_object_mut() {
                o.insert("resetCredits".into(), resolved);
            }
        }
        Ok(Some(usage))
    }

    // -- Anthropic -----------------------------------------------------------------------

    async fn fetch_anthropic_usage(&self, account_id: &str, force_refresh: bool) -> Result<Option<Value>, UsageError> {
        let auth = self.deps.source.ensure_auth("anthropic-oauth", account_id, force_refresh).await?;
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
        Ok(normalize_anthropic_usage(&res.json()?, "anthropic-oauth", now_ms()))
    }

    // -- Grok ------------------------------------------------------------------------------

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
    async fn probe_grok_billing(&self, headers: &[(String, String)], route: &RouteInfo) -> Option<Value> {
        for url in [
            "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
            "https://cli-chat-proxy.grok.com/v1/billing",
        ] {
            let Ok(res) = self.deps.http.get(url, headers, FETCH_TIMEOUT).await else { continue };
            if !res.ok() {
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

    async fn probe_grok_generic(&self, headers: &[(String, String)], route: &RouteInfo) -> Option<Value> {
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

    async fn fetch_grok_usage(
        &self,
        route: &RouteInfo,
        force_refresh: bool,
    ) -> Result<Option<Value>, UsageError> {
        let auth = self.deps.source.ensure_auth("grok-oauth", &route.account_id, force_refresh).await?;
        let Some(auth) = auth else { return Ok(None) };
        let Some(token) = clean_token(or_truthy(&auth, &["access_token", "accessToken", "key"])) else {
            return Ok(None);
        };
        let user_id = or_truthy(&auth, &["user_id", "userId", "principal_id", "principalId"])
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        self.deps.grok.warm().await;
        let cli = Self::grok_headers(&token, &user_id, self.deps.grok.headers());
        if let Some(billing) = self.probe_grok_billing(&cli, route).await {
            return Ok(Some(billing));
        }
        let generic = Self::grok_headers(&token, &user_id, vec![header("User-Agent", "xai-grok-build/mixdog")]);
        Ok(self.probe_grok_generic(&generic, route).await)
    }

    // -- measurement -------------------------------------------------------------------------

    async fn measure_usage(&self, route: &RouteInfo, force_refresh: bool) -> Result<Option<Value>, UsageError> {
        let provider = provider_key(route);
        match provider.as_str() {
            "openai-oauth" => self.fetch_codex_usage(&route.account_id, force_refresh).await,
            "anthropic-oauth" => self.fetch_anthropic_usage(&route.account_id, force_refresh).await,
            "grok-oauth" => self.fetch_grok_usage(route, force_refresh).await,
            "cursor-oauth" | "cursor-api" | "antigravity-oauth" | "muse-code-oauth" | "command-code-oauth"
            | "opencode-go-oauth" => self.deps.source.provider_snapshot(&provider, &route.account_id).await,
            _ => Ok(None),
        }
    }

    /// One measurement, retried once behind a forced credential refresh when
    /// the server rejected the token: the stored expiry is only what the
    /// server said at issue, a subscription change can revoke it earlier.
    async fn measure_with_auth_retry(&self, route: &RouteInfo) -> Result<Option<Value>, UsageError> {
        match self.measure_usage(route, false).await {
            Err(e) if e.auth_rejection() && self.deps.source.can_refresh(&provider_key(route)) => {
                self.measure_usage(route, true).await
            }
            other => other,
        }
    }

    /// The fallback after a failed measurement, and its bookkeeping. A
    /// credential the server refuses even after a forced refresh cannot vouch
    /// for the reading it last produced: the recorded quota goes with it.
    async fn usage_after_failure(&self, err: &UsageError, provider: &str, account_id: &str) -> Option<Value> {
        if err.auth_rejection() && ACCOUNT_PROVIDERS.contains(&provider) {
            if let Err(e) = self.deps.store.clear_quota_state(provider, account_id).await {
                self.log(&format!("Account usage could not be cleared: {e}"));
            }
        }
        self.warn_throttled(
            &format!("oauth-usage:{provider}"),
            &format!("gateway {provider} usage fetch unavailable: {err}"),
        );
        None
    }

    fn cache_negative(&self, key: &str) {
        let mut entry = Obj::new();
        entry.insert("empty".into(), Value::Bool(true));
        entry.insert("source".into(), "empty".into());
        entry.insert("cachedAt".into(), Value::from(now_ms()));
        self.caches().memory.insert(key.to_owned(), Value::Object(entry));
    }

    fn negative_fresh(&self, key: &str) -> bool {
        let c = self.caches();
        c.memory.get(key).is_some_and(|cur| {
            cur.get("empty") == Some(&Value::Bool(true))
                && ((now_ms() as f64) - num_or(cur.get("cachedAt"), 0.0)) < NEGATIVE_CACHE_TTL_MS as f64
        })
    }

    /// Caches the reading under the provider key and, when the route names a
    /// model, under the model-qualified key; returns the route's own view.
    async fn cache_snapshot(&self, snapshot: &Value, route: &RouteInfo, provider: &str, provider_only: &str) -> Value {
        let model = cache_model_id(Some(&Value::String(route.model.clone()))).or_else(|| cache_model_id(snapshot.get("model")));
        let mut provider_snapshot = snapshot.as_object().cloned().unwrap_or_default();
        let provider_name = if route.provider.is_empty() {
            clean_token(snapshot.get("provider")).unwrap_or_else(|| provider.to_owned())
        } else {
            route.provider.clone()
        };
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
        {
            let mut c = self.caches();
            for (k, v) in &updates {
                c.memory.insert(k.clone(), v.clone());
            }
        }
        // Dropped like Node's catch: usage display never affects the request path.
        let _ = self
            .update_disk_cache(move |routes| {
                for (k, v) in updates {
                    routes.insert(k, v);
                }
            })
            .await;
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
                        let reset_at =
                            w.get("resetAt").and_then(Value::as_f64).filter(|r| r.is_finite()).map(|r| r.round() as i64);
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

    async fn record_account_usage(&self, provider: &str, account_id: &str, snapshot: &Value) {
        let Some(windows) = snapshot.get("quotaWindows").and_then(Value::as_array) else { return };
        let strings = |v: Option<&Value>| {
            v.and_then(Value::as_array).map(|a| a.iter().map(|t| t.as_str().unwrap_or("").to_owned()).collect::<Vec<_>>())
        };
        let inputs: Vec<QuotaWindowInput> = windows
            .iter()
            .take(12)
            .map(|w| QuotaWindowInput {
                label: w.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
                used_pct: w.get("usedPct").and_then(Value::as_f64),
                reset_at: w.get("resetAt").and_then(Value::as_f64).map(|r| r as i64),
                models: strings(w.get("models")),
                except: strings(w.get("except")),
                limit: w.get("limit").and_then(Value::as_str).map(str::to_owned),
            })
            .collect();
        if let Err(e) = self.deps.store.record_usage(provider, account_id, inputs).await {
            self.log(&format!("Account usage could not be saved: {e}"));
        }
    }

    /// The reading for a route, measured when the cached one is not current;
    /// `None` for a provider that is not an OAuth account or that reports
    /// nothing (`fetchOAuthUsageSnapshot`). `force` bypasses the caches.
    pub async fn fetch_snapshot(self: &Arc<Self>, route: &RouteInfo, force: bool) -> Option<Value> {
        let provider = provider_key(route);
        if !provider.contains("oauth") && provider != "cursor-api" {
            return None;
        }
        let key = route_key(route);
        let provider_only = cache_provider_key(route);
        if !force {
            let now = now_ms();
            let cached = {
                let c = self.caches();
                fresh(c.memory.get(&key), LIVE_CACHE_TTL_MS, now)
                    .or_else(|| fresh(c.memory.get(&provider_only), LIVE_CACHE_TTL_MS, now))
            };
            if cached.is_some() {
                return cached;
            }
            if self.negative_fresh(&key) || self.negative_fresh(&provider_only) {
                return None;
            }
        }
        let task = {
            let mut c = self.caches();
            if let Some(running) = c.inflight.get(&key) {
                running.clone()
            } else {
                let this = Arc::clone(self);
                let (route, key2, provider_only2) = (route.clone(), key.clone(), provider_only.clone());
                let fut: BoxFuture<'static, Option<Value>> = async move {
                    let out = this.measure_and_cache(&route, &provider, &provider_only2).await;
                    this.caches().inflight.remove(&key2);
                    out
                }
                .boxed();
                let shared = fut.shared();
                c.inflight.insert(key.clone(), shared.clone());
                shared
            }
        };
        task.await
    }

    async fn measure_and_cache(&self, route: &RouteInfo, provider: &str, provider_only: &str) -> Option<Value> {
        let key = route_key(route);
        let snapshot = match self.measure_with_auth_retry(route).await {
            Ok(s) => s,
            Err(e) => self.usage_after_failure(&e, provider, &route.account_id).await,
        };
        let Some(snapshot) = snapshot.filter(contentful) else {
            self.cache_negative(&key);
            self.cache_negative(provider_only);
            return None;
        };
        if ACCOUNT_PROVIDERS.contains(&provider) {
            self.record_account_usage(provider, &route.account_id, &snapshot).await;
        }
        self.record_quota_history(provider, &route.account_id, &snapshot).await;
        Some(self.cache_snapshot(&snapshot, route, provider, provider_only).await)
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

#[cfg(test)]
mod tests;