//! The production ports under [`OAuthUsage`]: the usage endpoints' HTTP over the routed
//! [`HttpSend`], the Grok CLI version headers, and the per-account credential of the providers whose
//! usage endpoints need a token (`providerObj.ensureAuth` of `fetchOAuthUsageSnapshot`).
//!
//! The quota history port lives with the ledger (`mixdog-core`'s `run_host/quota_history.rs`).
//!
//! Not here: the `getUsageSnapshot()` of cursor, antigravity, muse-code, command-code and
//! opencode-go. Those providers report plan usage through their own clients; [`ProviderUsageSource`]
//! answers them with an error (the measurement then reads as nothing, as Node's does when the
//! provider call fails) until each is ported.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::oauth_usage::GrokClient;
use super::oauth_usage::UsageError;
use super::oauth_usage::UsageHttp;
use super::oauth_usage::UsageResponse;
use super::oauth_usage::UsageSource;
use crate::accounts::AccountStore;
use crate::client_versions::ClientVersions;
use crate::client_versions::Dialect;
use crate::oauth::CredentialFile;
use crate::providers::anthropic::OAuthSession;
use crate::providers::grok::auth::GrokCredential;
use crate::providers::openai::adapter::CredentialSource;
use crate::providers::openai::oauth::OpenAiOAuth;
use crate::providers::connect::rewrite::Credential as _;
use crate::transport::Exchange;
use crate::transport::Redirect;
use crate::transport::http::HttpSend;
use mixdog_rt::Liveness;

/// What a transport failure reads as: Node's `fetch` rejects with this `TypeError`, whatever the cause
/// (a refused connection, a redirect under `redirect: 'error'`).
const FETCH_FAILED: &str = "fetch failed";
/// `AbortSignal.timeout(ms)`'s `TimeoutError` message.
const TIMED_OUT: &str = "The operation was aborted due to timeout";

/// [`UsageHttp`] over the routed link. The exchange is Node's `fetchOptions`: a redirect is a network
/// error (`redirect: 'error'`) and the timeout covers the head and the body (`AbortSignal.timeout`),
/// both enforced by the transport.
pub struct RoutedUsageHttp {
    http: Arc<dyn HttpSend>,
}

impl RoutedUsageHttp {
    pub fn new(http: Arc<dyn HttpSend>) -> Self {
        Self { http }
    }

    async fn exchange(&self, method: &str, url: &str, headers: &[(String, String)], body: Vec<u8>, timeout: Duration) -> Result<UsageResponse, UsageError> {
        let request = WireRequest {
            transport: TransportKind::Http1,
            method: method.to_owned(),
            url: url.to_owned(),
            headers: headers.to_vec(),
            body,
        };
        let exchange = Exchange::new(Liveness::unary(timeout), Redirect::Error);
        let failed = |error: ProviderError| {
            // The transport names a missed deadline; every other refusal reads as Node's `fetch failed`.
            UsageError::new(if error.message.contains("timed out") { TIMED_OUT } else { FETCH_FAILED })
        };
        let head = self.http.send(request, exchange).await.map_err(failed)?;
        let status = head.status;
        let whole = head.read_all().await.map_err(failed)?;
        Ok(UsageResponse { status, body: String::from_utf8_lossy(&whole.body).into_owned() })    }
}

#[async_trait]
impl UsageHttp for RoutedUsageHttp {
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration) -> Result<UsageResponse, UsageError> {
        self.exchange("GET", url, headers, Vec::new(), timeout).await
    }

    async fn post_json(&self, url: &str, headers: &[(String, String)], body: &Value, timeout: Duration) -> Result<UsageResponse, UsageError> {
        // `JSON.stringify(body)`: compact, in insertion order.
        let bytes = serde_json::to_vec(body).map_err(|e| UsageError::new(e.to_string()))?;
        self.exchange("POST", url, headers, bytes, timeout).await
    }
}

/// [`GrokClient`] over the process's client versions (`grok-client-version.mjs`): the version is
/// read at every call, so a minimum learned from a 426 reaches the next request.
pub struct GrokVersionHeaders {
    versions: Arc<ClientVersions>,
}

impl GrokVersionHeaders {
    pub fn new(versions: Arc<ClientVersions>) -> Self {
        Self { versions }
    }
}

#[async_trait]
impl GrokClient for GrokVersionHeaders {
    async fn warm(&self) {
        self.versions.warm(Dialect::Grok).await;
    }

    /// `grokClientVersionHeaders()`.
    fn headers(&self) -> Vec<(String, String)> {
        let version = self.versions.grok();
        vec![("x-grok-client-version".to_owned(), version.clone()), ("User-Agent".to_owned(), format!("xai-grok-build/{version}"))]
    }
}

fn failure(error: ProviderError) -> UsageError {
    UsageError { status: error.status, message: error.message }
}

#[derive(Clone)]
enum Held {
    OpenAi(Arc<OpenAiOAuth>),
    Anthropic(Arc<OAuthSession>),
    Grok(Arc<GrokCredential>),
}

/// [`UsageSource`] over the account store: each account's credential file, one credential object per
/// (provider, account) so a refresh in flight is shared by the readings that wait on it.
pub struct ProviderUsageSource {
    accounts: AccountStore,
    http: Arc<dyn HttpSend>,
    held: Mutex<HashMap<(String, String), Held>>,
}

impl ProviderUsageSource {
    pub fn new(accounts: AccountStore, http: Arc<dyn HttpSend>) -> Self {
        Self { accounts, http, held: Mutex::new(HashMap::new()) }
    }

    fn file(&self, provider: &str, account_id: &str) -> Result<CredentialFile, UsageError> {
        self.accounts.credential_file(provider, account_id).map_err(|e| UsageError::new(e.to_string()))
    }

    fn held(&self, provider: &str, account_id: &str) -> Result<Option<Held>, UsageError> {
        let key = (provider.to_owned(), account_id.to_owned());
        if let Some(known) = self.held.lock().unwrap_or_else(PoisonError::into_inner).get(&key) {
            return Ok(Some(known.clone()));
        }
        let made = match provider {
            "openai-oauth" => Held::OpenAi(Arc::new(OpenAiOAuth::new(self.file(provider, account_id)?, self.http.clone()))),
            "anthropic-oauth" => Held::Anthropic(Arc::new(OAuthSession::new(self.file(provider, account_id)?, self.http.clone()))),
            "grok-oauth" => Held::Grok(Arc::new(GrokCredential::new(self.http.clone(), self.file(provider, account_id)?))),
            _ => return Ok(None),
        };
        // Two builders racing keep the first: both read the same file.
        Ok(Some(self.held.lock().unwrap_or_else(PoisonError::into_inner).entry(key).or_insert(made).clone()))
    }
}

#[async_trait]
impl UsageSource for ProviderUsageSource {
    /// The credential as Node's `ensureAuth` returns it (`access_token`/`accessToken`, `account_id`,
    /// `user_id`); `force_refresh` is the retry behind a refused token, and exchanges the refresh
    /// token when the file still holds the one that was refused.
    async fn ensure_auth(&self, provider: &str, account_id: &str, force_refresh: bool) -> Result<Option<Value>, UsageError> {
        let Some(held) = self.held(provider, account_id)? else { return Ok(None) };
        let auth = match held {
            Held::OpenAi(oauth) => {
                let current = oauth.current().await.map_err(failure)?;
                let credential = if force_refresh { oauth.after_rejection(&current).await.map_err(failure)?.unwrap_or(current) } else { current };
                let mut doc = json!({ "access_token": credential.bearer });
                if let Some(id) = credential.account_id {
                    doc["account_id"] = Value::String(id);
                }
                doc
            }
            Held::Anthropic(session) => {
                let token = session.access_token().await.map_err(failure)?;
                let token = if force_refresh { session.token_after_rejection(&token).await.map_err(failure)? } else { token };
                json!({ "accessToken": token })
            }
            Held::Grok(credential) => {
                let header = credential.header(force_refresh).await.map_err(failure)?;
                let token = header.and_then(|(_, value)| value.strip_prefix("Bearer ").map(str::to_owned));
                let Some(token) = token else { return Ok(None) };
                let mut doc = json!({ "access_token": token });
                if let Some(user) = credential.user_id() {
                    doc["user_id"] = Value::String(user);
                }
                doc
            }
        };
        Ok(Some(auth))
    }

    async fn provider_snapshot(&self, provider: &str, _account_id: &str) -> Result<Option<Value>, UsageError> {
        Err(UsageError::new(format!("{provider} plan usage is not available from this build")))
    }
}

#[cfg(test)]
#[path = "usage_ports_tests.rs"]
mod tests;
