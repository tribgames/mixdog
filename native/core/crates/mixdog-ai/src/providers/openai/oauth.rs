//! The `openai-oauth` credential: the stored ChatGPT login (`openai-oauth.json`)
//! as an adapter [`CredentialSource`]. The access token is refreshed ahead of
//! its expiry and after a 401, once at a time per process (a rotated refresh
//! token is single-use) and across processes (the lease beside the file, under
//! which the file is read again and a newer pair adopted), and a refresh only
//! replaces the stored pair if the file still holds the pair it read, so
//! another process's newer login is never overwritten.

#![allow(clippy::result_large_err, reason = "the frozen provider error type is returned unboxed")]

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde::Deserialize;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::adapter::Credential;
use super::adapter::CredentialSource;
use crate::accounts::validity::normalize_expires_at_ms;
use crate::oauth::RefreshFailure;
use crate::oauth::classify_refresh_failure;
use crate::oauth::CredentialFile;
use crate::oauth::Pace;
use crate::oauth::Probe;
use crate::oauth::SystemPace;
use crate::oauth::lease::LockProcess;
use crate::oauth::lease::REFRESH_LEASE;
use crate::oauth::lease::lease_error;
use crate::oauth::lease::refresh_lock_path;
use crate::transport::HttpSend;
use crate::transport::deadlines::TOKEN_OPENAI;

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
/// A token this close to its expiry is refreshed before use.
pub const REFRESH_SKEW_MS: u64 = 5 * 60_000;
pub(super) const AUTH_CLAIM: &str = "https://api.openai.com/auth";
/// The failure of an exchange whose new pair could not be written: the rotated refresh token is lost.
const UNSTORED: &str = "the refreshed ChatGPT login could not be stored";

#[derive(Deserialize, Clone, Debug)]
#[serde(from = "StoredDocument")]
struct Stored {
    access_token: String,
    refresh_token: Option<String>,
    /// Milliseconds since the epoch; 0 when unknown.
    expires_at: u64,
    account_id: Option<String>,
}

/// The stored document as it reads: `_normalizeExpiresAt(own.expires_at ?? own.expiresAt)`; both spellings may be
/// present, and what is written back is `expires_at` alone (Node's `saveTokens`).
#[derive(Deserialize)]
struct StoredDocument {
    access_token: String,
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<Value>,
    #[serde(default, rename = "expiresAt")]
    expires_at_camel: Option<Value>,
    account_id: Option<String>,
}

impl From<StoredDocument> for Stored {
    fn from(document: StoredDocument) -> Self {
        // An empty refresh token or account id is none (Node's `||`): it names no login, so it establishes no identity.
        Self {
            access_token: document.access_token,
            refresh_token: document.refresh_token.filter(|token| !token.is_empty()),
            expires_at: crate::accounts::validity::stated_expiry(document.expires_at, document.expires_at_camel),
            account_id: document.account_id.filter(|account| !account.is_empty()),
        }
    }
}

impl Stored {
    fn credential(&self) -> Credential {
        Credential { bearer: self.access_token.clone(), account_id: self.account_id.clone() }
    }

    fn usable_at(&self, now: u64, skew: u64) -> bool {
        self.expires_at == 0 || self.expires_at > now + skew
    }
}

/// `adoptableDiskTokens` (openai-oauth-tokens.mjs:289): the stored token supersedes the one the caller holds when it
/// is not the one just rejected and still clears the refresh skew (none after a rejection: that caller already saw its
/// token refused).
fn adoptable(stored: &Stored, rejected: Option<&str>) -> bool {
    let newer = rejected.is_none_or(|bearer| bearer != stored.access_token);
    newer && stored.usable_at(now_ms(), if rejected.is_some() { 0 } else { REFRESH_SKEW_MS })
}

/// A refusal that needs a new sign-in (openai-oauth-tokens.mjs:252): a 401, or a typed refresh-token code anywhere in
/// the body of a refused exchange. A bare 400, 429 or 5xx is no evidence the refresh token is dead.
fn permanent_refusal(status: Option<u16>, body: &[u8]) -> bool {
    static CODES: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)invalid_grant|revoked|reused|refresh_token_(?:expired|invalidated)").expect("a static pattern"));
    status.is_some_and(|s| !(200..300).contains(&s) && (s == 401 || CODES.is_match(&String::from_utf8_lossy(body))))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The claims object of a JWT (any base64 alphabet, padded or not), if it has one.
pub(super) fn claims_of(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = parts[1].trim_end_matches('=').replace('+', "-").replace('/', "_");
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    claims.is_object().then_some(claims)
}

/// The ChatGPT account id an access token's claims name.
pub(super) fn account_of(token: &str) -> Option<String> {
    Some(claims_of(token)?.get(AUTH_CLAIM)?.get("chatgpt_account_id")?.as_str()?.to_owned())
}

fn login_required(message: &str) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    err.reauth_required = true;
    err.message = message.to_owned();
    err
}

fn refresh_failed(cause: &str) -> String {
    format!("OpenAI OAuth token refresh failed ({cause}). Re-authenticate via provider login.")
}

/// How a refresh ended, so no caller infers it from the bearer it was handed.
#[derive(Clone)]
enum Refreshed {
    /// This flight's own exchange produced the pair now stored.
    Exchanged(Credential),
    /// A pair another writer stored was taken without an exchange.
    Adopted(Credential),
    /// The exchange did not run or failed and the token still in date keeps serving.
    Coasted(Credential),
}

impl Refreshed {
    fn credential(self) -> Credential {
        match self {
            Self::Exchanged(credential) | Self::Adopted(credential) | Self::Coasted(credential) => credential,
        }
    }
}

type Refreshing = Shared<BoxFuture<'static, Result<Refreshed, ProviderError>>>;

struct Inner {
    file: CredentialFile,
    http: Arc<dyn HttpSend>,
    /// The refreshes of this file running or queued, oldest first; each starts once the one published before it ended.
    inflight: Mutex<Vec<Pending>>,
    flights: AtomicU64,
    /// The refresh token a confirmed permanent refusal named: it is not presented again until the stored one is a
    /// different token (another process refreshed, or the user signed in). In this credential object only.
    refused: Mutex<Option<String>>,
    /// The access token a failed preemptive refresh left serving, and until when no new refresh is tried for it
    /// (`_refreshFallbackUntil`): every turn in that window must not rerun the failing exchange.
    coast: Mutex<Option<(String, u64)>>,
    /// The process as the refresh lease's lock protocol sees it, and its clock and waits.
    process: Arc<LockProcess>,
    pace: Arc<dyn Pace>,
}

/// A published refresh.
struct Pending {
    /// The id of the [`Flight`] that owns the entry.
    id: u64,
    /// The account and refresh token of the login it renews, as read when it was published: what [`Pending::renews`]
    /// tells that login by.
    account: Option<String>,
    refresh: Option<String>,
    /// The bearer it was forced for after a 401; none for a preemptive refresh.
    forced: Option<String>,
    running: Refreshing,
}

impl Pending {
    /// Whether it renews the login `stored` holds, known to be the same one: the same account (which a rotation does not
    /// change), or the same refresh token. Two logins naming no account are not known to be the same.
    fn renews(&self, stored: &Stored) -> bool {
        (self.account.is_some() && self.account == stored.account_id) || (self.refresh.is_some() && self.refresh == stored.refresh_token)
    }
}

/// What a caller does about the refreshes published.
enum Turn {
    /// Await this refresh's result.
    Join(Refreshing),
    /// Await the end of a refresh of a login not known to be the caller's, without its result, then look again.
    WaitOut(Refreshing),
    /// Run a refresh of its own, after `prior` (the file's latest refresh) ended.
    Start(Flight, tokio::sync::oneshot::Sender<tokio::task::JoinHandle<Result<Refreshed, ProviderError>>>, Refreshing, Option<Refreshing>),
}

/// The one cleanup owner of a published flight: it is built before the refresh task is spawned and moved into it, so
/// the entry is cleared however the task ends (return, error, panic, cancellation, a runtime dropped with the task never
/// polled). A later flight's entry is never cleared by an earlier one's.
struct Flight {
    inner: Arc<Inner>,
    id: u64,
}

impl Drop for Flight {
    fn drop(&mut self) {
        let mut inflight = self.inner.inflight.lock().unwrap_or_else(PoisonError::into_inner);
        inflight.retain(|pending| pending.id != self.id);
    }
}

pub struct OpenAiOAuth {
    inner: Arc<Inner>,
}

impl OpenAiOAuth {
    pub fn new(file: CredentialFile, http: Arc<dyn HttpSend>) -> Self {
        Self::in_process(file, http, LockProcess::this_process())
    }

    /// A credential whose refresh lease is taken as `process`: a second one over the same file excludes this one as
    /// another process does.
    pub fn in_process(file: CredentialFile, http: Arc<dyn HttpSend>, process: Arc<LockProcess>) -> Self {
        Self { inner: Arc::new(Inner {
            file,
            http,
            inflight: Mutex::new(Vec::new()),
            flights: AtomicU64::new(0),
            refused: Mutex::new(None),
            coast: Mutex::new(None),
            process,
            pace: Arc::new(SystemPace),
        }) }
    }
}

impl Inner {
    async fn stored(&self) -> Result<Stored, ProviderError> {
        match self.file.load::<Stored>().await {
            Probe::Present(mut stored) => {
                self.file.keep(&[&stored.access_token, stored.refresh_token.as_deref().unwrap_or_default()]);
                // `_normalizeExpiresAt(own.expires_at ?? own.expiresAt) || expiryFromAccessToken(own.access_token)`.
                stored.expires_at = crate::accounts::validity::expiry_or_claim(stored.expires_at, &stored.access_token);
                Ok(stored)
            }
            Probe::Absent => Err(login_required("not signed in to ChatGPT")),
            Probe::Unreadable => {
                let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                err.message = "the stored ChatGPT login cannot be read right now".into();
                Err(err)
            }
        }
    }

    /// What a stored pair gets when its refresh token is the one a permanent refusal named; `None` when it is a
    /// different token (nothing was refused for it). No exchange is made for it: a usable access token keeps serving
    /// (never past its real expiry, and not after a rejection), else sign-in is asked.
    fn refused_grant(&self, stored: &Stored, force: bool) -> Option<Result<Refreshed, ProviderError>> {
        let refused = self.refused.lock().unwrap_or_else(PoisonError::into_inner);
        if refused.is_none() || refused.as_deref() != stored.refresh_token.as_deref() {
            return None;
        }
        drop(refused);
        Some(if !force && stored.usable_at(now_ms(), 0) {
            Ok(Refreshed::Coasted(stored.credential()))
        } else {
            Err(login_required(&refresh_failed("OpenAI OAuth token refresh refused earlier (invalid_grant)")))
        })
    }

    /// A usable credential: the stored one when it is newer than `rejected`
    /// and not expiring, otherwise a refreshed one.
    async fn renew(self: Arc<Self>, rejected: Option<String>) -> Result<Refreshed, ProviderError> {
        let stored = self.stored().await?;
        if adoptable(&stored, rejected.as_deref()) {
            return Ok(Refreshed::Adopted(stored.credential()));
        }
        // The refresh token is single-use: the exchange runs holding the cross-process lease beside the credential
        // file (`withFileLock(refresh.lock)`, openai-oauth-tokens.mjs:403), so another process (or another handle in
        // this one) that refreshes first has stored its pair before this one reads the file, and this one never spends
        // the old token.
        let held = self.exchange(rejected);
        self.file.lease(&refresh_lock_path(self.file.path()), &self.process, &*self.pace, REFRESH_LEASE, held).await.map_err(lease_error)?
    }

    /// `refreshUnderLock` (openai-oauth-tokens.mjs:306): under the lease the file is read again, and a token another
    /// writer stored meanwhile is adopted without an exchange.
    async fn exchange(&self, rejected: Option<String>) -> Result<Refreshed, ProviderError> {
        let stored = self.stored().await?;
        if adoptable(&stored, rejected.as_deref()) {
            mixdog_rt::node_stderr!("[openai-oauth] Reloaded tokens from disk");
            return Ok(Refreshed::Adopted(stored.credential()));
        }
        let Some(refresh_token) = stored.refresh_token.clone().filter(|t| !t.is_empty()) else {
            // `reusableCurrentTokens` (openai-oauth-tokens.mjs:318): no refresh token, but a token that is not past its
            // real expiry keeps serving; sign-in is asked when nothing usable is left (and always after a rejection).
            if rejected.is_none() && stored.usable_at(now_ms(), 0) {
                return Ok(Refreshed::Coasted(stored.credential()));
            }
            return Err(login_required("the stored ChatGPT login has no refresh token"));
        };
        // Under the lease the stored refresh token is compared with the one a permanent refusal named: unchanged means
        // no exchange (a usable access token keeps serving, else sign-in is asked).
        if let Some(outcome) = self.refused_grant(&stored, rejected.is_some()) {
            return outcome;
        }
        // `refreshUnderLock` (openai-oauth-tokens.mjs:337): the reason is the rejection's status, or the token's expiry.
        mixdog_rt::node_stderr!("[openai-oauth] Token {}, refreshing...", if rejected.is_some() { "401" } else { "preemptive" });
        // The serializer is not `Send`: it is finished before the await.
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", &refresh_token)
            .append_pair("client_id", CLIENT_ID)
            .finish()
            .into_bytes();
        let response = self
            .http
            .send(
                WireRequest {
                    transport: TransportKind::Http1,
                    method: "POST".into(),
                    url: TOKEN_URL.into(),
                    headers: vec![(
                        "Content-Type".into(),
                        "application/x-www-form-urlencoded".into(),
                    )],
                    body,
                },
                TOKEN_OPENAI,
            )
            .await;
        let (status, body, unanswered) = match response {
            // A body that cannot be read is an exchange that gave no tokens (`res.json()` rejects, `:242`), so the
            // token still in date keeps serving like any other failed refresh.
            Ok(response) => {
                let head = response.status;
                match response.read_all().await {
                    Ok(read) => (read.status, read.body, None),
                    // The head's status stands: a broken 200 body is a failed exchange the valid token outlives, a broken 401
                    // body is still the refresh token's refusal.
                    Err(error) => (Some(head), Vec::new(), Some(error)),
                }
            }
            Err(error) => (None, Vec::new(), Some(error)),
        };
        // `res.json()` of a 2xx answer: UTF-8 decoded without its BOM, then `JSON.parse`.
        let decoded = String::from_utf8_lossy(&body);
        let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
        let json = status.filter(|s| (200..300).contains(s)).map(|_| mixdog_js::json_parse(text));
        let Some(tokens) = json
            .as_ref()
            .and_then(|parsed| parsed.as_ref().ok())
            .and_then(|v| v.get("access_token")?.as_str().filter(|a| !a.is_empty()).map(|a| (v, a.to_owned())))
        else {
            // `json.access_token` of what `res.json()` gave: a body that is no JSON rejects with the parser's own
            // message, `null` with the property read's, anything else without a token is `refresh returned null`.
            let unusable = json.map(|parsed| match parsed {
                Err(_) => mixdog_js::v8_json_parse_error(text).unwrap_or_else(|| unreachable!("the parser refused a text V8 accepts")),
                Ok(Value::Null) => "Cannot read properties of null (reading 'access_token')".to_owned(),
                Ok(_) => "refresh returned null".to_owned(),
            });
            // A refusal for a token the file no longer holds (another writer stored a newer pair while this exchange was
            // in flight) is not about the stored one: a usable stored pair is adopted.
            if permanent_refusal(status, &body)
                && let Ok(latest) = self.stored().await
                && latest.refresh_token.as_deref() != Some(refresh_token.as_str())
                && latest.usable_at(now_ms(), 0)
            {
                return Ok(Refreshed::Adopted(latest.credential()));
            }
            return self.failed(&stored, &refresh_token, rejected.is_some(), status, &body, unanswered.as_ref(), unusable);
        };
        let (json, access_token) = tokens;
        let granted = |key: &str| json.get(key).and_then(Value::as_str).unwrap_or_default();
        self.file.keep(&[&access_token, granted("refresh_token"), &refresh_token, granted("id_token")]);
        // `_normalizeExpiresAt(json.expires_at ?? json.expiresAt) || (typeof json.expires_in === 'number' ? now + expires_in * 1000 : 0)`
        let stated = normalize_expires_at_ms(["expires_at", "expiresAt"].iter().find_map(|key| json.get(*key).filter(|v| !v.is_null())));
        let expires_at = if stated > 0.0 {
            stated as u64
        } else {
            json.get("expires_in").filter(|v| v.is_number()).and_then(Value::as_f64).map_or(0, |secs| (now_ms() as f64 + secs * 1000.0).max(0.0) as u64)
        };
        // `Math.round(((expires_at || Date.now()) - Date.now()) / 1000)` (openai-oauth-tokens.mjs:343).
        let left_ms = if expires_at == 0 { 0 } else { expires_at.saturating_sub(now_ms()) };
        mixdog_rt::node_stderr!("[openai-oauth] Token refreshed, expires in {}s", (left_ms + 500) / 1000);
        let mut update = Map::new();
        update.insert("access_token".into(), json!(access_token));
        update.insert(
            "refresh_token".into(),
            json!(json.get("refresh_token").and_then(Value::as_str).unwrap_or(&refresh_token)),
        );
        update.insert("expires_at".into(), json!(expires_at));
        // `account_id: extractAccountId(json.access_token)`: the refreshed token's own claim, and none when it names
        // none (Node stores the refreshed tokens in place of the old document, `publishRefreshedTokens`).
        update.insert("account_id".into(), account_of(&access_token).map_or(Value::Null, |account| json!(account)));
        let expected = refresh_token.clone();
        let published = self
            .file
            // `expires_at` is the one spelling Node writes: an imported `expiresAt` does not stay beside it.
            .replace_if_without(
                move |doc| doc.get("refresh_token").and_then(Value::as_str) == Some(expected.as_str()),
                update,
                &["expiresAt"],
            )
            .await
            .map_err(|_| {
                let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
                err.message = UNSTORED.into();
                err
            })?;
        // Published or not, the file now holds the live pair: when another
        // process refreshed first, its pair wins.
        let _ = published;
        Ok(Refreshed::Exchanged(self.stored().await?.credential()))
    }

    /// A refresh that did not produce tokens. A dead grant needs a new login;
    /// anything else coasts on the current token while it still has life, unless `force` (the token was just rejected:
    /// `reusableCurrentTokens`, `openai-oauth-tokens.mjs:306`).
    #[allow(clippy::too_many_arguments, reason = "the refusal's whole account: the pair read, the token spent and the answer")]
    fn failed(
        &self,
        stored: &Stored,
        spent: &str,
        force: bool,
        status: Option<u16>,
        body: &[u8],
        unanswered: Option<&ProviderError>,
        unusable: Option<String>,
    ) -> Result<Refreshed, ProviderError> {
        // Node's rule alone decides what is permanent here; the shared classifier only tells a transient fault from an
        // unstated refusal for the error's kind.
        let verdict = if permanent_refusal(status, body) {
            RefreshFailure::Definitive
        } else {
            match classify_refresh_failure(status, body) {
                RefreshFailure::Definitive => RefreshFailure::Unknown,
                other => other,
            }
        };
        // A confirmed permanent refusal is remembered before anything is returned: the token it named is not presented
        // again. Only that classification counts; transient and unstated failures are not remembered.
        if verdict == RefreshFailure::Definitive {
            *self.refused.lock().unwrap_or_else(PoisonError::into_inner) = Some(spent.to_owned());
        }
        // The classification says whether the grant is dead; whether the user is asked to sign in now depends on whether a
        // usable token remains (`reusableCurrentTokens` is checked after a permanent refusal too, `:344-349`).
        if !force && stored.usable_at(now_ms(), 0) {
            return Ok(Refreshed::Coasted(stored.credential()));
        }
        match verdict {
            RefreshFailure::Definitive => {
                // Node's confirmed refusal (`openai-oauth-tokens.mjs:252`), wrapped as it wraps every failure (`:354`).
                let mut err = login_required(&refresh_failed(&format!("OpenAI OAuth token refresh {} (invalid_grant)", status.unwrap_or_default())));
                err.status = status;
                Err(err)
            }
            verdict => {
                let kind = if verdict == RefreshFailure::Transient {
                    ErrorKind::Transient
                } else {
                    ErrorKind::Auth
                };
                let mut err = ProviderError::new(kind, DeliveryState::NotSent);
                // Node's wrapper (`openai-oauth-tokens.mjs:354`) words every failure; its cause is the timer's own
                // text (`:276`, the bare-`setTimeout` abort) or the fetch's for a request that got no answer, and
                // `refresh returned null` (`:258`, `:262`) for an answer that is no token: no status travels with it. A 2xx
                // body that cannot be read as one says why (`unusable`).
                let cause = match unanswered {
                    Some(fault) if fault.timed_out => {
                        format!("OpenAI OAuth token refresh timed out after {}ms", TOKEN_OPENAI.liveness.head_deadline().map_or(0, |wait| wait.as_millis()))
                    }
                    Some(fault) => fault.message.clone(),
                    None => unusable.unwrap_or_else(|| "refresh returned null".into()),
                };
                err.message = refresh_failed(&cause);
                Err(err)
            }
        }
    }
}

impl OpenAiOAuth {
    /// The refresh of the credential held now, shared by every caller holding the same one. When the file holds another
    /// login by the time it settles, the caller gets that login's credential: the roster row is the identity, as in Node
    /// 1.4.5, so this is the rule and not a leak.
    ///
    /// A caller whose bearer was rejected joins the refresh forced for that bearer, running or queued, whatever the stored
    /// tokens rotated to meanwhile; failing one, it publishes one queued behind the file's latest refresh, so no preemptive
    /// refresh can hand the rejected bearer back (`refreshStoredTokens`, openai-oauth-tokens.mjs:376-386). A preemptive
    /// caller joins a preemptive refresh of its own login, else that login's latest forced one; any refresh it awaited
    /// that fails leaves it the token it holds while that is in date, as its own preemptive refresh would
    /// (`reusableCurrentTokens`). While only refreshes of logins not known to be its own run, it is handed none of their
    /// results: it waits for them to end and returns `None`, so the file is read again and the login found there served.
    async fn renewed(&self, rejected: Option<String>) -> Option<Result<Refreshed, ProviderError>> {
        let unfinished = || {
            let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
            err.message = "the ChatGPT token refresh did not finish".into();
            err
        };
        let stored = match self.inner.stored().await {
            Ok(stored) => stored,
            Err(err) => return Some(Err(err)),
        };
        let turn = {
            let mut inflight = self.inner.inflight.lock().unwrap_or_else(PoisonError::into_inner);
            let joined = match &rejected {
                Some(_) => inflight.iter().find(|pending| pending.forced == rejected).map(|pending| Turn::Join(pending.running.clone())),
                None => {
                    let own = || inflight.iter().filter(|pending| pending.renews(&stored));
                    own()
                        .find(|pending| pending.forced.is_none())
                        .or_else(|| inflight.iter().rev().find(|pending| pending.renews(&stored)))
                        .or_else(|| inflight.last())
                        .map(|pending| if pending.renews(&stored) { Turn::Join(pending.running.clone()) } else { Turn::WaitOut(pending.running.clone()) })
                }
            };
            match joined {
                Some(turn) => turn,
                None => {
                    let prior = inflight.last().map(|pending| pending.running.clone());
                    // The refresh runs to its end (exchange, persistence, lease release) as a task of its own, as Node's
                    // promise does, whether or not a caller still waits: callers only await its result. The flight's
                    // cleanup owner is built here and moved into the task; the task is spawned after this lock is
                    // released (a runtime that has shut down drops it where it is spawned, and that drop takes the lock).
                    let id = self.inner.flights.fetch_add(1, Ordering::SeqCst);
                    let guard = Flight { inner: self.inner.clone(), id };
                    let (started, task) = tokio::sync::oneshot::channel::<tokio::task::JoinHandle<Result<Refreshed, ProviderError>>>();
                    let flight: Refreshing = async move {
                        match task.await {
                            Ok(task) => task.await.unwrap_or_else(|_| Err(unfinished())),
                            Err(_) => Err(unfinished()),
                        }
                    }
                    .boxed()
                    .shared();
                    inflight.push(Pending {
                        id,
                        account: stored.account_id.clone(),
                        refresh: stored.refresh_token.clone(),
                        forced: rejected.clone(),
                        running: flight.clone(),
                    });
                    Turn::Start(guard, started, flight, prior)
                }
            }
        };
        let ordinary = rejected.is_none();
        let shared = match turn {
            Turn::Join(shared) => shared,
            Turn::WaitOut(running) => {
                let _ = running.await;
                return None;
            }
            Turn::Start(guard, started, shared, prior) => {
                let inner = self.inner.clone();
                let task = tokio::spawn(async move {
                    // Dropped last: after the refresh released its lease and its turn on the process's line.
                    let _flight = guard;
                    // The refresh token is single-use: the file's refresh published before this one ends first, and what it
                    // stored is adopted (or its rejected bearer exchanged) under the lease.
                    if let Some(prior) = prior {
                        let _ = prior.await;
                    }
                    if let Some(bearer) = &rejected {
                        // A forced refresh lifts the holdoff of the bearer it was rejected for (`_refreshFallbackUntil = 0`).
                        let mut coast = inner.coast.lock().unwrap_or_else(PoisonError::into_inner);
                        if coast.as_ref().is_some_and(|(coasting, _)| coasting == bearer) {
                            *coast = None;
                        }
                    }
                    let outcome = inner.clone().renew(rejected).await;
                    // The flight arms the holdoff itself, once and before any caller is handed its result, for the credential
                    // it coasted on (the one read under the lease): a waiter only adopts the result (`coastOnCurrent`), and a
                    // successful exchange or adoption needs none.
                    if let Ok(Refreshed::Coasted(credential)) = &outcome {
                        *inner.coast.lock().unwrap_or_else(PoisonError::into_inner) = Some((credential.bearer.clone(), now_ms() + REFRESH_SKEW_MS));
                    }
                    outcome
                });
                let _ = started.send(task);
                shared
            }
        };
        // Whatever refresh an ordinary caller awaited, its failure leaves that caller the bearer it holds while that is in
        // date (`reusableCurrentTokens`): a refresh run for another bearer of the login never takes it down. A rejected
        // bearer has no such licence.
        Some(match shared.await {
            Err(err) if ordinary && stored.usable_at(now_ms(), 0) => {
                if err.message == UNSTORED {
                    tracing::warn!("[openai-oauth] The refreshed login could not be stored, so its rotated refresh token was not saved; serving the still-valid current token, and the next refresh may need a new sign-in");
                }
                Ok(Refreshed::Coasted(stored.credential()))
            }
            outcome => outcome,
        })
    }
}

#[async_trait]
impl CredentialSource for OpenAiOAuth {
    async fn current(&self) -> Result<Credential, ProviderError> {
        // Read again after waiting out a refresh of a login not known to be the one read.
        loop {
            let stored = self.inner.stored().await?;
            if stored.usable_at(now_ms(), REFRESH_SKEW_MS) {
                return Ok(stored.credential());
            }
            // A refresh token a permanent refusal named is not presented again: nothing is spawned, nothing is sent.
            if let Some(outcome) = self.inner.refused_grant(&stored, false) {
                return outcome.map(Refreshed::credential);
            }
            let held = {
                let coast = self.inner.coast.lock().unwrap_or_else(PoisonError::into_inner);
                coast.as_ref().is_some_and(|(bearer, until)| *bearer == stored.access_token && now_ms() < *until && stored.usable_at(now_ms(), 0))
            };
            if held {
                return Ok(stored.credential());
            }
            if let Some(outcome) = self.renewed(None).await {
                return Ok(outcome?.credential());
            }
        }
    }

    async fn after_rejection(&self, rejected: &Credential) -> Result<Option<Credential>, ProviderError> {
        // The refresh joined was forced for this bearer: the rejected bearer comes back only from its own exchange, which is
        // final and not run again. A forced caller always joins or starts one, so it is never sent to read again.
        let next = loop {
            if let Some(outcome) = self.renewed(Some(rejected.bearer.clone())).await {
                break outcome?.credential();
            }
        };
        Ok((next != *rejected).then_some(next))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oauth::CredentialIo;
    use crate::oauth::http::testing::Scripted;
    use crate::transport::site_probe::TimingOut;
    use crate::transport::site_probe::assert_thrown;
    use crate::transport::site_probe::assert_transport;

    /// `own.expires_at ?? own.expiresAt`: both spellings present is a document Node reads, not an error.
    #[test]
    fn a_document_with_both_expiry_spellings_reads_with_nodes_precedence() {
        let read = |text: &str| serde_json::from_str::<Stored>(text).expect("a stored document");
        assert_eq!(read(r#"{"access_token":"a","expires_at":1893456000000,"expiresAt":1}"#).expires_at, 1_893_456_000_000);
        assert_eq!(read(r#"{"access_token":"a","expires_at":null,"expiresAt":1893456000}"#).expires_at, 1_893_456_000_000);
        assert_eq!(read(r#"{"access_token":"a","expiresAt":"2030-01-01T00:00:00Z"}"#).expires_at, 1_893_456_000_000);
    }


    /// The refresh that outlives its timer reads as the real Node function did (`sites.openaiRefresh`): the bare-`setTimeout`
    /// abort, worded by the refresh's own catch and wrapped by the caller.
    #[tokio::test(start_paused = true)]
    async fn a_refresh_that_outlives_its_timer_reads_as_nodes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openai-oauth.json");
        tokio::fs::write(&path, r#"{"access_token":"a","refresh_token":"r","expires_at":1}"#).await.unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path, CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let transport = TimingOut::new();
        let error = OpenAiOAuth::new(file, transport.clone()).current().await.expect_err("never answers");
        assert_transport("openaiRefresh", &transport);
        assert_thrown("openaiRefresh", &error.message);
    }
    /// A flight's guard clears its own entry however its task ends, including a task dropped before it was ever polled,
    /// and never an entry a later flight published.
    #[cfg(node_twin)]
    #[tokio::test]
    async fn a_flight_guard_clears_only_its_own_entry_however_its_task_ends() {
        let dir = tempfile::tempdir().unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(dir.path().join("openai-oauth.json"), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let oauth = OpenAiOAuth::new(file, TimingOut::new());
        let inner = oauth.inner.clone();
        let entry = |id: u64| Pending { id, account: Some("acct".to_owned()), refresh: Some("r".to_owned()), forced: None, running: futures::future::ready(Err(login_required("x"))).boxed().shared() };
        let held = |inner: &Arc<Inner>| !inner.inflight.lock().unwrap().is_empty();

        *inner.inflight.lock().unwrap() = vec![entry(1)];
        let task = {
            let guard = Flight { inner: inner.clone(), id: 1 };
            async move {
                let _flight = guard;
            }
        };
        assert!(held(&inner), "the entry stands while the task lives");
        drop(task);
        assert!(!held(&inner), "a task dropped before its first poll cleaned up");

        *inner.inflight.lock().unwrap() = vec![entry(2)];
        drop(Flight { inner: inner.clone(), id: 1 });
        assert!(held(&inner), "an earlier flight does not clear a later one's entry");
        drop(Flight { inner: inner.clone(), id: 2 });
        assert!(!held(&inner));
    }

    /// A stored pair whose access token is in date but inside the refresh skew.
    fn near_expiry(access: &str) -> String {
        json!({"access_token": access, "refresh_token": "r1", "expires_at": now_ms() + 60_000}).to_string()
    }

    async fn coasting(access: &str, replies: &[(u16, &str)]) -> (tempfile::TempDir, std::path::PathBuf, Arc<Scripted>, OpenAiOAuth) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openai-oauth.json");
        tokio::fs::write(&path, near_expiry(access)).await.unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let endpoint = Scripted::new(replies);
        let oauth = OpenAiOAuth::new(file, endpoint.clone());
        (dir, path, endpoint, oauth)
    }

    /// A 401 caller joins a preemptive refresh that fails transiently and coasts on the rejected bearer; before it resumes,
    /// a preemptive caller that found no holdoff armed and no refresh in flight refreshes again. The 401 caller is answered
    /// by a forced exchange of its own, never by the second preemptive refresh handing the rejected bearer back.
    #[tokio::test]
    async fn a_rejected_bearer_is_answered_only_by_a_forced_exchange() {
        let (_dir, _path, endpoint, oauth) = coasting("a", &[(503, "{}"), (503, "{}"), (503, "{}")]).await;
        let rejected = Credential { bearer: "a".into(), account_id: None };
        let mut first = Box::pin(oauth.current());
        assert!(futures::poll!(first.as_mut()).is_pending());
        let preemptive = oauth.inner.inflight.lock().unwrap().last().map(|pending| pending.running.clone()).expect("a preemptive flight");
        drop(first);
        let mut forced = Box::pin(oauth.after_rejection(&rejected));
        assert!(futures::poll!(forced.as_mut()).is_pending(), "the 401 caller waits while the preemptive refresh runs");
        let coasted = preemptive.await;
        assert!(matches!(&coasted, Ok(Refreshed::Coasted(credential)) if credential.bearer == "a"));
        // The second preemptive caller runs once nothing is in flight (the forced refresh, if one is, has ended and lifted
        // the holdoff), and before the 401 caller resumes.
        for _ in 0..1_000 {
            if oauth.inner.inflight.lock().unwrap().is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(oauth.inner.inflight.lock().unwrap().is_empty(), "every flight ended");
        let mut second = Box::pin(oauth.current());
        assert!(futures::poll!(second.as_mut()).is_pending(), "the second preemptive caller refreshes again");
        let error = forced.await.expect_err("the forced exchange's own failure, not the rejected bearer handed back");
        assert!(!error.reauth_required);
        assert_eq!(second.await.unwrap().bearer, "a", "the retried preemptive refresh coasts");
        assert_eq!(endpoint.seen.lock().unwrap().len(), 3, "the preemptive, the forced and the retried preemptive exchange");
    }

    /// An ordinary caller holding a token still in date never fails because of another caller's forced refresh: arriving
    /// while a preemptive refresh runs with a forced one queued behind it, it joins the preemptive one; arriving while only a
    /// forced one is in flight, it joins that and keeps its token when the forced exchange fails.
    #[tokio::test]
    async fn an_ordinary_caller_never_fails_because_of_another_callers_forced_refresh() {
        let rejected = Credential { bearer: "a".into(), account_id: None };

        let (_dir, _path, endpoint, oauth) = coasting("a", &[(503, "{}"), (503, "{}")]).await;
        let mut first = Box::pin(oauth.current());
        assert!(futures::poll!(first.as_mut()).is_pending());
        let mut forced = Box::pin(oauth.after_rejection(&rejected));
        assert!(futures::poll!(forced.as_mut()).is_pending());
        let mut ordinary = Box::pin(oauth.current());
        assert!(futures::poll!(ordinary.as_mut()).is_pending(), "the preemptive refresh is still running");
        assert_eq!(first.await.unwrap().bearer, "a");
        assert!(forced.await.is_err(), "the forced exchange failed");
        assert_eq!(ordinary.await.unwrap().bearer, "a", "the ordinary caller has the preemptive refresh's outcome");
        assert_eq!(endpoint.seen.lock().unwrap().len(), 2);

        let (_dir, _path, endpoint, oauth) = coasting("a", &[(503, "{}")]).await;
        let mut forced = Box::pin(oauth.after_rejection(&rejected));
        assert!(futures::poll!(forced.as_mut()).is_pending());
        let mut ordinary = Box::pin(oauth.current());
        assert!(futures::poll!(ordinary.as_mut()).is_pending(), "only the forced refresh is in flight");
        assert!(forced.await.is_err(), "the forced exchange failed");
        assert_eq!(ordinary.await.unwrap().bearer, "a", "the ordinary caller keeps the token still in date");
        assert_eq!(endpoint.seen.lock().unwrap().len(), 1);
    }

    /// A 401 joins the forced refresh for its own bearer wherever it sits: with one for `a` running and a late 401 for an
    /// older bearer queued behind it, a second 401 for `a` shares the running exchange and does not spend the rotated
    /// refresh token again.
    #[tokio::test]
    async fn a_401_joins_the_forced_refresh_for_its_bearer_wherever_it_is_queued() {
        let (_dir, _path, endpoint, oauth) = coasting(
            "a",
            &[
                (200, r#"{"access_token":"a","refresh_token":"r2","expires_in":3600}"#),
                (200, r#"{"access_token":"a3","refresh_token":"r3","expires_in":3600}"#),
            ],
        )
        .await;
        let (a, b) = (Credential { bearer: "a".into(), account_id: None }, Credential { bearer: "b".into(), account_id: None });
        let mut first = Box::pin(oauth.after_rejection(&a));
        assert!(futures::poll!(first.as_mut()).is_pending());
        let mut late = Box::pin(oauth.after_rejection(&b));
        assert!(futures::poll!(late.as_mut()).is_pending());
        let mut again = Box::pin(oauth.after_rejection(&a));
        assert!(futures::poll!(again.as_mut()).is_pending());
        let first = first.await.unwrap().map(|next| next.bearer);
        assert_eq!(late.await.unwrap().map(|next| next.bearer), Some("a".to_owned()), "the older bearer adopts the stored one");
        assert_eq!(again.await.unwrap().map(|next| next.bearer), first, "the second 401 for a shares the first one's exchange");
        assert_eq!(endpoint.seen.lock().unwrap().len(), 1, "the rotated refresh token is not spent again");
    }

    /// A token endpoint that answers one request per permit the test hands it, in script order.
    struct Gated {
        replies: Mutex<std::collections::VecDeque<(u16, &'static str)>>,
        seen: Mutex<usize>,
        gate: tokio::sync::Semaphore,
    }

    impl Gated {
        fn new(replies: &[(u16, &'static str)]) -> Arc<Self> {
            Arc::new(Self { replies: Mutex::new(replies.iter().copied().collect()), seen: Mutex::new(0), gate: tokio::sync::Semaphore::new(0) })
        }
    }

    struct Body(Option<bytes::Bytes>);

    #[async_trait]
    impl crate::transport::BodyStream for Body {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            self.0.take().map(Ok)
        }
    }

    #[async_trait]
    impl HttpSend for Gated {
        async fn send(&self, _request: WireRequest, _exchange: crate::transport::Exchange) -> Result<crate::transport::HttpResponse, ProviderError> {
            *self.seen.lock().unwrap() += 1;
            self.gate.acquire().await.expect("an open gate").forget();
            let (status, body) = self.replies.lock().unwrap().pop_front().expect("a scripted reply");
            Ok(crate::transport::HttpResponse { status, headers: Vec::new(), body: Box::new(Body(Some(bytes::Bytes::from(body)))) })
        }
    }

    /// A login document; `expires_in_ms` is from now, negative for one already past.
    fn login(access: &str, refresh: &str, account: Value, expires_in_ms: i64) -> String {
        json!({"access_token": access, "refresh_token": refresh, "account_id": account, "expires_at": now_ms() as i64 + expires_in_ms}).to_string()
    }

    /// A credential over `document` whose refreshes are answered through a gate the test opens.
    async fn gated(document: String, replies: &[(u16, &'static str)]) -> (tempfile::TempDir, std::path::PathBuf, Arc<Gated>, OpenAiOAuth) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openai-oauth.json");
        tokio::fs::write(&path, document).await.unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let endpoint = Gated::new(replies);
        let oauth = OpenAiOAuth::new(file, endpoint.clone());
        (dir, path, endpoint, oauth)
    }

    /// Yields until `count` requests reached the endpoint (each having read the file under the lease).
    async fn reached(endpoint: &Gated, count: usize) {
        for _ in 0..1_000 {
            if *endpoint.seen.lock().unwrap() == count {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("{count} requests never reached the endpoint");
    }

    /// An empty account id or refresh token names no login: it is read as none, and two logins sharing one are not the
    /// same login.
    #[test]
    fn an_empty_account_id_or_refresh_token_establishes_no_identity() {
        let read = |text: &str| serde_json::from_str::<Stored>(text).expect("a stored document");
        let a = read(r#"{"access_token":"a","refresh_token":"","account_id":""}"#);
        let b = read(r#"{"access_token":"b","refresh_token":"","account_id":""}"#);
        assert_eq!((a.refresh_token.as_deref(), a.account_id.as_deref()), (None, None));
        let pending = Pending {
            id: 0,
            account: a.account_id.clone(),
            refresh: a.refresh_token.clone(),
            forced: None,
            running: futures::future::ready(Err(login_required("x"))).boxed().shared(),
        };
        assert!(!pending.renews(&b));
    }

    /// Login `b` replaces login `a` while `a`'s preemptive refresh is at the endpoint, neither naming an account (absent or
    /// empty). A caller holding `b` is not handed `a`'s result: `a`'s refresh fails transiently and coasts on `a`, and the
    /// `b` caller, having waited it out, reads the file again and is served `b` by a refresh of its own.
    #[tokio::test]
    async fn a_caller_never_gets_the_credential_of_a_login_not_known_to_be_its_own() {
        for account in [Value::Null, json!("")] {
            let (_dir, path, endpoint, oauth) = gated(login("a", "r1", account.clone(), 60_000), &[(503, "{}"), (503, "{}")]).await;
            let mut first = Box::pin(oauth.current());
            assert!(futures::poll!(first.as_mut()).is_pending());
            reached(&endpoint, 1).await;
            std::fs::write(&path, login("b", "rb", account.clone(), 60_000)).unwrap();
            let mut other = Box::pin(oauth.current());
            assert!(futures::poll!(other.as_mut()).is_pending(), "b's caller waits while a's refresh runs ({account})");
            endpoint.gate.add_permits(2);
            assert_eq!(first.await.unwrap().bearer, "a", "a's refresh coasts on a ({account})");
            assert_eq!(other.await.unwrap().bearer, "b", "b's caller is served b, never a ({account})");
            assert_eq!(*endpoint.seen.lock().unwrap(), 2, "b's refresh ran on its own ({account})");
        }
    }

    /// A preemptive refresh for an expired `a` is at the endpoint when another writer stores `b`, still in date but inside
    /// the refresh skew, for the same account. `b`'s caller joins that refresh; when it fails, `b`'s caller keeps `b`
    /// rather than taking `a`'s failure.
    #[tokio::test]
    async fn a_failed_refresh_a_caller_joined_leaves_it_the_bearer_it_holds_in_date() {
        let (_dir, path, endpoint, oauth) = gated(login("a", "r1", json!("acct"), -1_000), &[(503, "{}")]).await;
        let mut first = Box::pin(oauth.current());
        assert!(futures::poll!(first.as_mut()).is_pending());
        reached(&endpoint, 1).await;
        std::fs::write(&path, login("b", "r2", json!("acct"), 60_000)).unwrap();
        let mut other = Box::pin(oauth.current());
        assert!(futures::poll!(other.as_mut()).is_pending(), "b's caller joined a's refresh");
        endpoint.gate.add_permits(1);
        assert!(first.await.is_err(), "nothing in date is left to a's caller");
        assert_eq!(other.await.unwrap().bearer, "b", "b's caller keeps its bearer");
        assert_eq!(*endpoint.seen.lock().unwrap(), 1, "b's caller shared a's exchange");
    }

    /// A forced refresh for `a` is queued behind a preemptive one, which rotates the refresh token and hands `a` back. A
    /// second 401 for `a`, arriving while the forced refresh is still pending, finds it by its bearer under the rotated
    /// token and shares it: one forced exchange, not a second spend of the rotated token.
    #[tokio::test]
    async fn a_401_finds_the_forced_refresh_for_its_bearer_after_the_refresh_token_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openai-oauth.json");
        tokio::fs::write(&path, near_expiry("a")).await.unwrap();
        let rt = mixdog_rt::testing::tokens();
        let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let endpoint = Gated::new(&[
            (200, r#"{"access_token":"a","refresh_token":"r2","expires_in":60}"#),
            (503, "{}"),
            (200, r#"{"access_token":"a4","refresh_token":"r4","expires_in":3600}"#),
        ]);
        let oauth = OpenAiOAuth::new(file, endpoint.clone());
        let a = Credential { bearer: "a".into(), account_id: None };

        let mut preemptive = Box::pin(oauth.current());
        assert!(futures::poll!(preemptive.as_mut()).is_pending());
        let rotating = oauth.inner.inflight.lock().unwrap().last().map(|pending| pending.running.clone()).expect("a preemptive flight");
        let mut first = Box::pin(oauth.after_rejection(&a));
        assert!(futures::poll!(first.as_mut()).is_pending(), "the forced refresh is queued behind the preemptive one");
        endpoint.gate.add_permits(1);
        assert!(matches!(rotating.await, Ok(Refreshed::Exchanged(credential)) if credential.bearer == "a"));
        assert!(tokio::fs::read_to_string(&path).await.unwrap().contains("\"r2\""), "the refresh token rotated");
        assert!(!oauth.inner.inflight.lock().unwrap().is_empty(), "the forced refresh is still pending");
        let mut again = Box::pin(oauth.after_rejection(&a));
        assert!(futures::poll!(again.as_mut()).is_pending());
        endpoint.gate.add_permits(2);
        assert_eq!(preemptive.await.unwrap().bearer, "a");
        assert!(first.await.is_err(), "the forced exchange failed");
        assert!(again.await.is_err(), "the second 401 shares the forced exchange's outcome");
        assert_eq!(*endpoint.seen.lock().unwrap(), 2, "the preemptive and one forced exchange");
    }

    /// Another writer replaces the coasting token with a still-valid near-expiry one before the refresh reads the file
    /// under its lease: the failed refresh serves the new token and holds the new token off, so the next turn does not
    /// rerun the failing exchange.
    #[tokio::test]
    async fn the_holdoff_is_for_the_token_the_failed_refresh_served() {
        let (_dir, path, endpoint, oauth) = coasting("a", &[(503, "{}"), (503, "{}")]).await;
        let mut first = Box::pin(oauth.current());
        assert!(futures::poll!(first.as_mut()).is_pending(), "the caller read a and its refresh is in flight");
        assert!(!oauth.inner.inflight.lock().unwrap().is_empty());
        std::fs::write(&path, near_expiry("b")).unwrap();
        assert_eq!(first.await.unwrap().bearer, "b", "the failed refresh serves the token it read under the lease");
        assert_eq!(oauth.current().await.unwrap().bearer, "b");
        assert_eq!(endpoint.seen.lock().unwrap().len(), 1, "the outage is not retried for the token that coasts");
    }
}
