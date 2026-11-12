//! The API-key providers' balance and usage lookups (`providers/api-usage.mjs`): DeepSeek's balance,
//! OpenAI's credit grants / dashboard billing / organization costs / completion usage, Anthropic's cost
//! report, Gemini's key probe and xAI's prepaid balance, with the snapshot cache file
//! (`api-usage-cache.json`, 5 minutes live, 1 hour stale).
//!
//! The requests follow redirects (Node's `fetch` default) and wait 6.5 s. A lookup the provider
//! refuses (401, 403, 404) is an "unavailable" snapshot that is not cached; any other failure is the
//! caller's error.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use chrono::DateTime;
use mixdog_js::slice_utf16;
use serde_json::Map;
use serde_json::Value;

use super::oauth_usage::UsageError;
use super::oauth_usage::UsageHttp;
use super::oauth_usage::read_json_file;
use super::oauth_usage::update_json_atomic;
use super::usage_normalize::jn;
use super::usage_normalize::num;
use super::usage_normalize::num_or;
use super::usage_normalize::round;
use crate::oauth::CredentialIo;
use crate::registry::keys::ApiKeyStore;
use crate::registry::keys::Environment;
use crate::registry::keys::SecretVault;

const CACHE_FILE: &str = "api-usage-cache.json";
const LIVE_TTL_MS: i64 = 5 * 60_000;
const STALE_TTL_MS: i64 = 60 * 60_000;
/// Billing/usage reports cover the trailing 31 days.
const USAGE_LOOKBACK_MS: i64 = 31 * 24 * 60 * 60_000;
const FETCH_TIMEOUT: Duration = Duration::from_millis(6_500);
/// `JsonMemoryCache`'s default: the file is not read again inside a second.
const MEMO_MS: i64 = 1_000;
const OPENAI_USAGE_SESSION_KEY_ACCOUNT: &str = "agent.openai.usageSessionKey";

/// A failed lookup: what Node's `fetchJson` throws (`status`, `body`) or a transport error.
#[derive(Clone, Debug)]
pub struct ApiError {
    pub status: Option<u16>,
    pub message: String,
    pub body: Option<Value>,
}

impl ApiError {
    fn plain(message: &str) -> Self {
        Self { status: None, message: message.to_owned(), body: None }
    }

    /// 401, 403 and 404 end a lookup as "unavailable".
    fn refused(&self) -> bool {
        matches!(self.status, Some(401 | 403 | 404))
    }
}

type Lookup = Result<Option<Value>, ApiError>;

pub struct ApiUsageService {
    http: Arc<dyn UsageHttp>,
    keys: ApiKeyStore,
    vault: Arc<dyn SecretVault>,
    env: Arc<dyn Environment>,
    io: CredentialIo,
    data_dir: PathBuf,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    memo: Mutex<Option<(i64, Value)>>,
}

fn cache_key(provider: &str) -> String {
    mixdog_js::js_trim(provider).to_lowercase()
}

fn object(pairs: Vec<(&str, Value)>) -> Value {
    Value::Object(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

/// `uniqueValues`: trimmed, non-empty, first occurrence.
fn unique_values(values: Vec<Option<String>>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values.into_iter().flatten() {
        let text = mixdog_js::js_trim(&value).to_owned();
        if !text.is_empty() && !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

/// `URLSearchParams` serialization (`application/x-www-form-urlencoded`).
fn form_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(byte as char),
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `encodeURIComponent`.
fn uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn url_with(base: &str, pairs: &[(&str, String)]) -> String {
    let query: Vec<String> = pairs.iter().map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v))).collect();
    format!("{base}?{}", query.join("&"))
}

/// `ymd`: the UTC day of a millisecond time.
fn ymd(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms).map_or_else(String::new, |d| d.format("%Y-%m-%d").to_string())
}

fn auth_headers(key: &str, extra: Vec<(&str, &str)>) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = extra.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect();
    headers.push(("Authorization".to_owned(), format!("Bearer {key}")));
    headers
}

fn accept() -> Vec<(&'static str, &'static str)> {
    vec![("Accept", "application/json")]
}

fn first_present<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| value.get(*key).filter(|v| !v.is_null()))
}

/// `moneyNumber`: a dollar amount from a number, text such as "$1,234.50", or an object naming one.
fn money_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => None,
        Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        Value::String(text) if text.is_empty() => None,
        Value::String(text) => {
            let stripped: String = text.chars().filter(|c| *c != '$' && *c != ',' && !mixdog_js::is_js_space(*c)).collect();
            num(Some(&Value::String(stripped)), None)
        }
        object @ (Value::Object(_) | Value::Array(_)) => {
            let direct = first_present(
                object,
                &["usd", "dollars", "amountUsd", "amount_usd", "availableUsd", "available_usd", "balanceUsd", "balance_usd", "amount", "value", "balance", "available", "total"],
            );
            if let Some(parsed) = money_number(direct) {
                return Some(parsed);
            }
            num(first_present(object, &["cents", "amountCents", "amount_cents", "usd_cents"]), None).map(|cents| cents / 100.0)
        }
        Value::Bool(_) => None,
    }
}

/// `errorMessage`: the body's error text, else the error's own, as a string.
fn error_message(error: &ApiError) -> String {
    let body = error.body.as_ref();
    let from_body = body
        .and_then(|b| b.get("error").and_then(|e| e.get("message")).filter(|m| !m.is_null()))
        .or_else(|| body.and_then(|b| b.get("error")).filter(|e| !e.is_null()))
        .or_else(|| body.and_then(|b| b.get("message")).filter(|m| !m.is_null()));
    match from_body {
        Some(Value::String(text)) => mixdog_js::js_trim(text).to_owned(),
        Some(value @ (Value::Object(_) | Value::Array(_))) => slice_utf16(&value.to_string(), 300),
        Some(_) => String::new(),
        None => mixdog_js::js_trim(&error.message).to_owned(),
    }
}

impl ApiUsageService {
    pub fn new(
        http: Arc<dyn UsageHttp>,
        keys: ApiKeyStore,
        vault: Arc<dyn SecretVault>,
        env: Arc<dyn Environment>,
        io: CredentialIo,
        data_dir: PathBuf,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self { http, keys, vault, env, io, data_dir, now, memo: Mutex::new(None) }
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    fn cache_path(&self) -> PathBuf {
        self.data_dir.join(CACHE_FILE)
    }

    fn env_text(&self, name: &str) -> Option<String> {
        self.env.key_var(name).filter(|v| !v.is_empty())
    }

    /// `getAgentApiKey`: the environment key, else the stored one (never in the remote-client mode).
    async fn agent_key(&self, provider: &str) -> Option<String> {
        self.keys.get(provider).await.ok().flatten()
    }

    /// `getOpenAIUsageSessionKey`.
    async fn usage_session_key(&self) -> Option<String> {
        for name in ["OPENAI_USAGE_SESSION_KEY", "OPENAI_DASHBOARD_SESSION_KEY", "OPENAI_SESSION_KEY", "MIXDOG_OPENAI_USAGE_SESSION_KEY", "MIXDOG_AGENT_OPENAI_USAGESESSIONKEY"] {
            if let Some(value) = self.env_text(name) {
                return Some(value);
            }
        }
        let stored = self.vault.get(OPENAI_USAGE_SESSION_KEY_ACCOUNT).await.ok().flatten().filter(|v| !v.is_empty());
        crate::oauth::carried::keep(&crate::registry::keys::keychain_source(&self.vault.identity(), OPENAI_USAGE_SESSION_KEY_ACCOUNT), &stored.as_deref().into_iter().collect::<Vec<_>>());
        stored
    }

    // -- the cache file ------------------------------------------------------------------

    /// `diskJsonCache.read`: the file, not read again inside a second.
    async fn read_cache_file(&self) -> Option<Value> {
        let now = self.now();
        if let Some((at, value)) = self.memo.lock().unwrap_or_else(PoisonError::into_inner).as_ref()
            && now - at < MEMO_MS
        {
            return Some(value.clone());
        }
        let path = self.cache_path();
        let value = self.io.read_job(move |_| Ok(read_json_file(&path))).await.ok().flatten()?;
        *self.memo.lock().unwrap_or_else(PoisonError::into_inner) = Some((now, value.clone()));
        Some(value)
    }

    fn fresh_snapshot(&self, snapshot: Option<&Value>, ttl_ms: i64) -> Option<Value> {
        let snapshot = snapshot?;
        let cached_at = num_or(snapshot.get("cachedAt"), 0.0);
        if cached_at == 0.0 || (self.now() as f64) - cached_at > ttl_ms as f64 {
            return None;
        }
        let truthy = |key: &str| snapshot.get(key).is_some_and(|v| !v.is_null() && *v != Value::Bool(false));
        (truthy("balance") || snapshot.get("quotaWindows").is_some_and(Value::is_array) || truthy("tokenUsage") || truthy("unavailable")).then(|| snapshot.clone())
    }

    /// `readCachedApiUsageSnapshot`.
    pub async fn cached(&self, provider: &str, allow_stale: bool) -> Option<Value> {
        let raw = self.read_cache_file().await;
        let snapshot = raw.as_ref().and_then(|r| r.get("snapshots")).and_then(|s| s.get(cache_key(provider)));
        self.fresh_snapshot(snapshot, if allow_stale { STALE_TTL_MS } else { LIVE_TTL_MS })
    }

    /// `writeCachedApiUsageSnapshot`: the read-modify-write under the file's lock; best effort.
    async fn write_cache(&self, provider: &str, snapshot: &Value) {
        let (key, snapshot, now) = (cache_key(provider), snapshot.clone(), self.now());
        let path = self.cache_path();
        let written: Arc<Mutex<Option<Value>>> = Arc::default();
        let sink = written.clone();
        let result = self
            .io
            .write_job(move |lane| {
                update_json_atomic(lane, &path, |current| {
                    let mut snapshots = current.as_ref().and_then(|c| c.get("snapshots")).and_then(Value::as_object).cloned().unwrap_or_default();
                    snapshots.insert(key, snapshot);
                    let mut doc = Map::new();
                    doc.insert("version".into(), Value::from(1));
                    doc.insert("updatedAt".into(), Value::from(now));
                    doc.insert("snapshots".into(), Value::Object(snapshots));
                    let doc = Value::Object(doc);
                    *sink.lock().unwrap_or_else(PoisonError::into_inner) = Some(doc.clone());
                    doc
                })
            })
            .await;
        if result.is_ok()
            && let Some(next) = written.lock().unwrap_or_else(PoisonError::into_inner).take()
        {
            *self.memo.lock().unwrap_or_else(PoisonError::into_inner) = Some((now, next));
        }
    }

    // -- one request ---------------------------------------------------------------------

    /// `fetchJson`: the parsed body (null when empty or not JSON); a non-2xx answer is an error
    /// carrying its status and parsed body.
    async fn fetch_json(&self, url: &str, headers: Vec<(String, String)>) -> Result<Value, ApiError> {
        // The deadline is an `AbortController`; the transport's `Surface::FetchAborted` words its abort.
        let reply = self.http.get(url, &headers, FETCH_TIMEOUT).await.map_err(|UsageError { message, .. }| ApiError { status: None, message, body: None })?;
        let data = if reply.body.is_empty() { Value::Null } else { serde_json::from_str(&reply.body).unwrap_or(Value::Null) };
        if !(200..300).contains(&reply.status) {
            return Err(ApiError { status: Some(reply.status), message: format!("usage fetch failed ({})", reply.status), body: Some(data) });
        }
        Ok(data)
    }

    fn unavailable(&self, provider: &str, error: &ApiError) -> Value {
        object(vec![
            ("provider", provider.into()),
            ("source", "provider-api-unavailable".into()),
            ("unavailable", object(vec![("status", error.status.map_or(Value::Null, Value::from)), ("message", error_message(error).into())])),
            ("cachedAt", self.now().into()),
        ])
    }

    fn unavailable_message(&self, provider: &str, message: &str) -> Value {
        self.unavailable(provider, &ApiError::plain(message))
    }

    // -- DeepSeek ------------------------------------------------------------------------

    async fn deepseek(&self) -> Lookup {
        let Some(key) = self.agent_key("deepseek").await else { return Ok(None) };
        let data = self.fetch_json("https://api.deepseek.com/user/balance", auth_headers(&key, accept())).await?;
        let usd = data.get("balance_infos").and_then(Value::as_array).and_then(|rows| {
            rows.iter().find(|row| row.get("currency").map_or(String::new(), mixdog_js::value_to_string).to_uppercase() == "USD")
        });
        let Some(remaining) = num(usd.and_then(|u| u.get("total_balance")), None) else { return Ok(None) };
        Ok(Some(object(vec![
            ("provider", "deepseek".into()),
            ("source", "deepseek-balance".into()),
            ("balance", object(vec![("remainingUsd", jn(round(remaining, 4))), ("currency", "USD".into()), ("source", "deepseek-balance".into())])),
            ("available", Value::Bool(data.get("is_available") == Some(&Value::Bool(true)))),
            ("cachedAt", self.now().into()),
        ])))
    }

    // -- OpenAI --------------------------------------------------------------------------

    fn parse_openai_credit_grants(&self, data: &Value) -> Option<Value> {
        let remaining = num(first_present(data, &["total_available", "totalAvailable", "available"]), None)?;
        let used = num(first_present(data, &["total_used", "totalUsed"]), None);
        let limit = num(first_present(data, &["total_granted", "totalGranted"]), None);
        let grants = data.get("grants").and_then(|g| g.get("data")).and_then(Value::as_array).cloned().unwrap_or_default();
        let expiries: Vec<f64> = grants
            .iter()
            .filter_map(|grant| num(first_present(grant, &["expires_at", "expiresAt"]), None))
            .filter(|v| *v > 0.0)
            .map(|v| if v < 10_000_000_000.0 { v * 1000.0 } else { v })
            .collect();
        let next_expiry = expiries.iter().copied().reduce(f64::min);
        let round_usd = |v: Option<f64>| v.map_or(Value::Null, |v| jn(round(v, 4)));
        let mut out = vec![
            ("provider", Value::from("openai")),
            ("source", "openai-credit-grants".into()),
            ("balance", object(vec![("remainingUsd", jn(round(remaining, 4))), ("currency", "USD".into()), ("source", "openai-credit-grants".into())])),
            ("cachedAt", self.now().into()),
        ];
        if used.is_some() || limit.is_some() {
            out.push(("creditGrants", object(vec![("usedUsd", round_usd(used)), ("limitUsd", round_usd(limit)), ("nextExpiry", next_expiry.map_or(Value::Null, jn))])));
        }
        Some(object(out))
    }

    async fn openai_credit_grants(&self, api_key: Option<&str>) -> Option<Value> {
        // OpenAI does not expose an official remaining-credit endpoint; this dashboard route is optional.
        let keys = unique_values(vec![self.usage_session_key().await, api_key.map(str::to_owned)]);
        for key in keys {
            let Ok(data) = self.fetch_json("https://api.openai.com/dashboard/billing/credit_grants", auth_headers(&key, accept())).await else { continue };
            if let Some(snapshot) = self.parse_openai_credit_grants(&data) {
                return Some(snapshot);
            }
        }
        None
    }

    async fn openai_dashboard(&self, session_key: Option<&str>) -> Option<Value> {
        let session_key = session_key?;
        let headers = auth_headers(session_key, accept());
        let subscription = self.fetch_json("https://api.openai.com/dashboard/billing/subscription", headers.clone()).await.ok();
        let now = self.now();
        let url = format!("https://api.openai.com/dashboard/billing/usage?start_date={}&end_date={}", ymd(now - USAGE_LOOKBACK_MS), ymd(now));
        let usage = self.fetch_json(&url, headers).await.ok();
        let used = num(usage.as_ref().and_then(|u| first_present(u, &["total_usage", "totalUsage"])), None).map(|cents| cents / 100.0);
        let limit = num(
            subscription.as_ref().and_then(|s| first_present(s, &["hard_limit_usd", "hardLimitUsd", "system_hard_limit_usd", "systemHardLimitUsd", "soft_limit_usd", "softLimitUsd"])),
            None,
        );
        if used.is_none() && limit.is_none() {
            return None;
        }
        let mut balance = Map::new();
        balance.insert("source".into(), "openai-dashboard-billing".into());
        if let Some(used) = used {
            balance.insert("usedUsd".into(), jn(round(used, 4)));
        }
        if let Some(limit) = limit {
            balance.insert("limitUsd".into(), jn(round(limit, 4)));
        }
        if let (Some(used), Some(limit)) = (used, limit) {
            balance.insert("remainingUsd".into(), jn(round((limit - used).max(0.0), 4)));
        }
        Some(object(vec![("provider", "openai".into()), ("source", "openai-dashboard-billing".into()), ("balance", Value::Object(balance)), ("cachedAt", self.now().into())]))
    }

    async fn openai_costs(&self, api_key: Option<&str>) -> Lookup {
        let Some(key) = api_key else { return Ok(None) };
        let start = (self.now() - USAGE_LOOKBACK_MS).div_euclid(1000);
        let url = url_with("https://api.openai.com/v1/organization/costs", &[("start_time", start.to_string()), ("limit", "31".into())]);
        let data = self.fetch_json(&url, auth_headers(key, accept())).await?;
        let mut used = 0.0;
        let mut seen = false;
        for bucket in data.get("data").and_then(Value::as_array).into_iter().flatten() {
            let mut total = 0.0;
            let mut bucket_seen = false;
            for item in bucket.get("results").and_then(Value::as_array).into_iter().flatten() {
                let amount = item.get("amount");
                let value = amount.and_then(|a| a.get("value")).filter(|v| !v.is_null()).or_else(|| amount.and_then(|a| a.get("usd")).filter(|v| !v.is_null())).or(amount);
                if let Some(amount) = num(value, None) {
                    total += amount;
                    bucket_seen = true;
                }
            }
            if bucket_seen {
                used += total;
                seen = true;
            }
        }
        if !seen {
            return Ok(None);
        }
        Ok(Some(object(vec![
            ("provider", "openai".into()),
            ("source", "openai-organization-costs".into()),
            ("balance", object(vec![("usedUsd", jn(round(used, 4))), ("source", "openai-organization-costs".into())])),
            ("cachedAt", self.now().into()),
        ])))
    }

    async fn openai_completion_usage(&self, api_key: Option<&str>) -> Lookup {
        let Some(key) = api_key else { return Ok(None) };
        let start = (self.now() - USAGE_LOOKBACK_MS).div_euclid(1000);
        let url = url_with("https://api.openai.com/v1/organization/usage/completions", &[("start_time", start.to_string()), ("bucket_width", "1d".into()), ("limit", "31".into())]);
        let data = self.fetch_json(&url, auth_headers(key, accept())).await?;
        let buckets = data.get("data").and_then(Value::as_array);
        let (mut input, mut output, mut cached, mut requests) = (0.0, 0.0, 0.0, 0.0);
        for result in buckets.into_iter().flatten().flat_map(|b| b.get("results").and_then(Value::as_array).into_iter().flatten()) {
            input += num_or(result.get("input_tokens"), 0.0);
            output += num_or(result.get("output_tokens"), 0.0);
            cached += num_or(result.get("input_cached_tokens"), 0.0);
            requests += num_or(result.get("num_model_requests"), 0.0);
        }
        // A `data` array, even an empty one, is a reading.
        if buckets.is_none() {
            return Ok(None);
        }
        Ok(Some(object(vec![
            ("provider", "openai".into()),
            ("source", "openai-organization-usage-completions".into()),
            (
                "tokenUsage",
                object(vec![
                    ("inputTokens", jn(input)),
                    ("outputTokens", jn(output)),
                    ("cachedInputTokens", jn(cached)),
                    ("requests", jn(requests)),
                    ("source", "openai-organization-usage-completions".into()),
                ]),
            ),
            ("cachedAt", self.now().into()),
        ])))
    }

    async fn openai(&self) -> Lookup {
        let key = self.agent_key("openai").await;
        if let Some(credit) = self.openai_credit_grants(key.as_deref()).await {
            return Ok(Some(credit));
        }
        let session = self.usage_session_key().await;
        if let Some(dashboard) = self.openai_dashboard(session.as_deref()).await {
            return Ok(Some(dashboard));
        }
        match self.openai_costs(key.as_deref()).await {
            Ok(Some(costs)) => return Ok(Some(costs)),
            Ok(None) => {}
            Err(error) if error.refused() => {}
            Err(error) => return Err(error),
        }
        self.openai_completion_usage(key.as_deref()).await
    }

    // -- Anthropic -----------------------------------------------------------------------

    async fn anthropic(&self) -> Lookup {
        let stored = self.agent_key("anthropic").await;
        let keys = unique_values(vec![
            self.env_text("ANTHROPIC_ADMIN_API_KEY"),
            self.env_text("MIXDOG_ANTHROPIC_ADMIN_API_KEY"),
            self.env_text("ANTHROPIC_ADMIN_KEY"),
            stored,
        ]);
        if keys.is_empty() {
            return Ok(Some(self.unavailable_message("anthropic", "Set ANTHROPIC_ADMIN_API_KEY for usage/cost report")));
        }
        let start = DateTime::from_timestamp_millis(self.now() - USAGE_LOOKBACK_MS).map_or_else(String::new, |d| d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string());
        let url = url_with("https://api.anthropic.com/v1/organizations/cost_report", &[("starting_at", start), ("bucket_width", "1d".into()), ("limit", "31".into())]);
        let mut first_auth_error: Option<ApiError> = None;
        for key in &keys {
            for bearer in [true, false] {
                let mut headers = vec![("Accept".to_owned(), "application/json".to_owned()), ("anthropic-version".to_owned(), "2023-06-01".to_owned())];
                headers.push(if bearer { ("Authorization".to_owned(), format!("Bearer {key}")) } else { ("x-api-key".to_owned(), key.clone()) });
                match self.fetch_json(&url, headers).await {
                    Ok(data) => {
                        return Ok(Some(self.parse_anthropic_cost_report(&data).unwrap_or_else(|| self.unavailable_message("anthropic", "Anthropic cost report returned no usage data"))));
                    }
                    Err(error) if error.refused() => {
                        first_auth_error.get_or_insert(error);
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        let error = first_auth_error.unwrap_or_else(|| ApiError::plain("Anthropic Admin API usage/cost auth failed"));
        Ok(Some(self.unavailable("anthropic", &error)))
    }

    fn parse_anthropic_cost_report(&self, data: &Value) -> Option<Value> {
        let buckets = data.get("data").and_then(Value::as_array)?;
        let mut used = 0.0;
        for item in buckets.iter().flat_map(|b| b.get("results").and_then(Value::as_array).into_iter().flatten()) {
            let currency = item.get("currency").filter(|c| !c.is_null()).map_or_else(|| "USD".to_owned(), mixdog_js::value_to_string).to_uppercase();
            if !currency.is_empty() && currency != "USD" {
                continue;
            }
            if let Some(cents) = num(item.get("amount"), None) {
                used += cents / 100.0;
            }
        }
        // A `data` array, even an empty one, is a reading.
        Some(object(vec![
            ("provider", "anthropic".into()),
            ("source", "anthropic-cost-report".into()),
            ("balance", object(vec![("usedUsd", jn(round(used, 4))), ("source", "anthropic-cost-report".into())])),
            ("cachedAt", self.now().into()),
        ]))
    }

    // -- Gemini --------------------------------------------------------------------------

    async fn gemini(&self) -> Lookup {
        let Some(key) = self.agent_key("gemini").await else { return Ok(None) };
        let url = format!("https://generativelanguage.googleapis.com/v1beta/models?key={}", uri_component(&key));
        Ok(Some(match self.fetch_json(&url, vec![("Accept".to_owned(), "application/json".to_owned())]).await {
            Ok(_) => self.unavailable_message("gemini", "Gemini API key valid; balance/usage is AI Studio or Cloud Billing only"),
            Err(error) => self.unavailable("gemini", &error),
        }))
    }

    // -- xAI -----------------------------------------------------------------------------

    fn parse_xai_prepaid_balance(&self, data: &Value) -> Option<Value> {
        let remaining = money_number(first_present(data, &["total", "availableCredits", "available_credits", "creditBalance", "credit_balance", "balance", "credits"]))?;
        Some(object(vec![
            ("provider", "xai".into()),
            ("source", "xai-management-prepaid-balance".into()),
            ("balance", object(vec![("remainingUsd", jn(round(remaining, 4))), ("currency", "USD".into()), ("source", "xai-management-prepaid-balance".into())])),
            ("cachedAt", self.now().into()),
        ]))
    }

    async fn xai(&self) -> Lookup {
        let key = self.env_text("XAI_MANAGEMENT_API_KEY");
        let team = self.env.var("XAI_TEAM_ID").filter(|v| !v.is_empty());
        let (Some(key), Some(team)) = (key, team) else {
            return Ok(Some(match self.xai_public().await {
                Some(snapshot) => snapshot,
                None => self.unavailable_message("xai", "Set XAI_MANAGEMENT_API_KEY and XAI_TEAM_ID for prepaid balance"),
            }));
        };
        let url = format!("https://management-api.x.ai/v1/billing/teams/{}/prepaid/balance", uri_component(&team));
        let data = self.fetch_json(&url, auth_headers(&key, accept())).await?;
        Ok(self.parse_xai_prepaid_balance(&data))
    }

    async fn xai_public(&self) -> Option<Value> {
        let key = self.agent_key("xai").await?;
        let mut first_error: Option<ApiError> = None;
        for url in ["https://api.x.ai/v1/usage", "https://api.x.ai/v1/rate_limits"] {
            match self.fetch_json(url, auth_headers(&key, accept())).await {
                Ok(data) => {
                    return Some(match self.parse_xai_prepaid_balance(&data) {
                        Some(Value::Object(mut parsed)) => {
                            parsed.insert("source".into(), "xai-public-usage-probe".into());
                            if let Some(Value::Object(balance)) = parsed.get_mut("balance") {
                                balance.insert("source".into(), "xai-public-usage-probe".into());
                            }
                            Value::Object(parsed)
                        }
                        _ => self.unavailable_message("xai", &format!("xAI public usage probe returned unsupported data from {url}")),
                    });
                }
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        Some(match first_error {
            Some(error) => self.unavailable("xai", &error),
            None => self.unavailable_message("xai", "xAI public usage probes failed"),
        })
    }

    // -- the entry point -----------------------------------------------------------------

    /// `fetchApiUsageSnapshot`.
    pub async fn fetch(&self, provider: &str, force: bool) -> Lookup {
        let id = cache_key(provider);
        if !force && let Some(fresh) = self.cached(&id, false).await {
            return Ok(Some(fresh));
        }
        let looked_up = match id.as_str() {
            "deepseek" => self.deepseek().await,
            "openai" => self.openai().await,
            "anthropic" => self.anthropic().await,
            "gemini" => self.gemini().await,
            "xai" => self.xai().await,
            _ => Ok(None),
        };
        let snapshot = match looked_up {
            Ok(snapshot) => snapshot,
            Err(error) if error.refused() => return Ok(Some(self.unavailable(&id, &error))),
            Err(error) => return Err(error),
        };
        if let Some(snapshot) = &snapshot {
            self.write_cache(&id, snapshot).await;
        }
        Ok(snapshot)
    }
}

#[cfg(test)]
#[path = "api_usage_tests.rs"]
mod tests;
