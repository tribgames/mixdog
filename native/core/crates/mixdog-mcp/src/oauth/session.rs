//! One server's sign-in: the stored credentials (cached, written through the secret store and
//! the marker files), the renewal of a refused token, and the explicit browser login.
//!
//! The daemon is the single owner of the keychain entry, so no cross-process lock or revision
//! polling is needed; the revision marker is still written for the status readers.

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
#[cfg(not(feature = "test-support"))]
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::login::LoginTarget;
use mixdog_rt::DurabilityIo;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use super::account::identity_from_token_response;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::account::AccountMode;
use super::account::Identity;
use super::callback::Callback;
use super::callback::Pasted;
use super::callback::parse_pasted;
use super::protocol::ClientCredentials;
use super::protocol::Discovery;
use super::protocol::Protocol;
use super::protocol::TokenError;
use super::protocol::parse_challenge;
use super::shared::OAuthError;
use super::store::MarkerFiles;
use super::store::SecretStore;
use super::store::StoredIdentity;
use crate::config::OAuthBinding;
use crate::transport::Authorizer;
use crate::transport::TransportError;

mod login;

/// A sign-in nobody finishes ends here (Node's `MCP_OAUTH_TIMEOUT_MS`).
#[cfg(not(feature = "test-support"))]
const LOGIN_DEADLINE: Duration = Duration::from_secs(5 * 60);


/// Where sign-ins are stored.
#[derive(Clone)]
pub struct OAuthEnv {
    pub store: Arc<dyn SecretStore>,
    /// `<plugin data>`; the marker files go under `mcp-oauth/`.
    pub plugin_data: std::path::PathBuf,
    pub io: DurabilityIo,
}

/// The stored value, field-compatible with the entries the Node product wrote.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(default)]
    url: String,
    #[serde(default)]
    revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tokens: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_information: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redirect_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    discovery: Option<Discovery>,
    /// `Some(None)`: stored as `null`, which a browser sign-in whose answer named nobody leaves.
    #[serde(default, deserialize_with = "some_null", skip_serializing_if = "Option::is_none")]
    identity: Option<Option<Identity>>,
}

fn some_null<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<Identity>>, D::Error> {
    Ok(Some(Option::<Identity>::deserialize(deserializer)?))
}

fn access_token(entry: &Entry) -> Option<String> {
    entry.tokens.as_ref()?.get("access_token")?.as_str().map(str::to_owned)
}

fn refresh_token(entry: &Entry) -> Option<String> {
    entry.tokens.as_ref()?.get("refresh_token")?.as_str().map(str::to_owned)
}

#[derive(Default)]
struct Cache {
    loaded: bool,
    entry: Option<Entry>,
}

/// Exclusive use of the cache, which may be held across awaits. The data moves out of the
/// std mutex for the guard's life and back on drop, so no async lock is needed.
struct CacheGuard<'a> {
    owner: &'a Mutex<Cache>,
    data: Cache,
    _permit: tokio::sync::SemaphorePermit<'a>,
}

impl std::ops::Deref for CacheGuard<'_> {
    type Target = Cache;
    fn deref(&self) -> &Cache {
        &self.data
    }
}

impl std::ops::DerefMut for CacheGuard<'_> {
    fn deref_mut(&mut self) -> &mut Cache {
        &mut self.data
    }
}

impl Drop for CacheGuard<'_> {
    fn drop(&mut self) {
        *self.owner.lock().unwrap_or_else(|e| e.into_inner()) = std::mem::take(&mut self.data);
    }
}

pub struct McpOAuth {
    binding: OAuthBinding,
    protocol: Protocol,
    store: Arc<dyn SecretStore>,
    files: MarkerFiles,
    account: String,
    cache: Mutex<Cache>,
    /// Held while the cache is checked out (see [`CacheGuard`]).
    cache_gate: tokio::sync::Semaphore,
    /// Every token this connection held: an error echoing one stays scrubbed after a refresh.
    held: Mutex<HashSet<String>>,
    /// One refresh at a time: later callers see the token the first one stored.
    renew_gate: tokio::sync::Semaphore,
    active_login: Mutex<Option<CancellationToken>>,
    /// The entry a committed account switch replaced (`Some(None)`: there was none).
    switched_from: Mutex<Option<Option<Entry>>>,
    /// The server refused the token and the sign-in could not renew it: the user must sign in.
    /// Cleared when a sign-in is stored.
    sign_in_required: std::sync::atomic::AtomicBool,
}

/// The secret-store account of a sign-in: a digest of its key, nothing else.
pub fn account_of(credential_key: &str) -> String {
    let digest = Sha256::digest(credential_key.as_bytes());
    format!("mcp-oauth.{}", digest.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// Why a login ended without tokens.
enum Stop {
    Cancelled,
    Expired,
    Failed(OAuthError),
}

impl From<OAuthError> for Stop {
    fn from(error: OAuthError) -> Self {
        Self::Failed(error)
    }
}

fn store_error(error: super::store::StoreError) -> OAuthError {
    if error.unrun { OAuthError::Unavailable } else { OAuthError::Store(error.message) }
}

impl McpOAuth {
    pub fn new(binding: OAuthBinding, env: &OAuthEnv) -> Result<Arc<Self>, String> {
        Ok(Arc::new(Self {
            account: account_of(&binding.credential_key),
            binding,
            protocol: Protocol::new()?,
            store: Arc::clone(&env.store),
            files: MarkerFiles::new(env.plugin_data.clone(), env.io),
            cache: Mutex::new(Cache::default()),
            cache_gate: tokio::sync::Semaphore::new(1),
            held: Mutex::new(HashSet::new()),
            renew_gate: tokio::sync::Semaphore::new(1),
            active_login: Mutex::new(None),
            switched_from: Mutex::new(None),
            sign_in_required: std::sync::atomic::AtomicBool::new(false),
        }))
    }

    /// Whether the last refused token could not be renewed, so the server needs a sign-in.
    pub fn sign_in_required(&self) -> bool {
        self.sign_in_required.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn binding(&self) -> &OAuthBinding {
        &self.binding
    }

    /// Every token this connection held, for scrubbing errors and results.
    pub fn secrets(&self) -> Vec<String> {
        self.held.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }

    /// Whether tokens are stored, from the marker file without a keychain read.
    pub async fn has_stored_tokens(&self) -> Result<bool, super::store::StoreError> {
        self.files.has_tokens(&self.account).await
    }

    /// Who the stored sign-in belongs to, without a keychain read.
    pub async fn stored_identity(&self) -> Result<Option<StoredIdentity>, super::store::StoreError> {
        self.files.identity(&self.account).await
    }

    fn hold(&self, entry: Option<&Entry>) {
        let Some(tokens) = entry.and_then(|e| e.tokens.as_ref()) else { return };
        let mut held = self.held.lock().unwrap_or_else(|e| e.into_inner());
        for key in ["access_token", "refresh_token"] {
            if let Some(token) = tokens.get(key).and_then(Value::as_str) {
                held.insert(token.to_owned());
            }
        }
    }

    /// Checks the cache out for exclusive use across awaits; it is put back when the guard drops.
    async fn lock_cache(&self) -> CacheGuard<'_> {
        let permit = self.cache_gate.acquire().await.expect("the gate is never closed");
        let data = std::mem::take(&mut *self.cache.lock().unwrap_or_else(|e| e.into_inner()));
        CacheGuard { owner: &self.cache, data, _permit: permit }
    }

    async fn load(&self) -> Result<CacheGuard<'_>, OAuthError> {
        let mut cache = self.lock_cache().await;
        if !cache.loaded {
            let saved = self.store.get(&self.account).await.map_err(store_error)?;
            let entry = match saved {
                Some(text) => {
                    let entry: Entry = serde_json::from_str(&text).map_err(|_| OAuthError::ReauthenticationRequired)?;
                    // An entry of another URL is never used for this server.
                    if entry.url != self.binding.url.as_str() {
                        return Err(OAuthError::ReauthenticationRequired);
                    }
                    Some(entry)
                }
                None => None,
            };
            self.hold(entry.as_ref());
            cache.entry = entry;
            cache.loaded = true;
        }
        Ok(cache)
    }

    async fn write_entry(&self, entry: &Entry) -> Result<(), OAuthError> {
        let has_tokens = entry.tokens.is_some();
        self.files.write_revision(&self.account, Some(&entry.revision), has_tokens).await.map_err(store_error)?;
        let text = serde_json::to_string(entry).map_err(|e| OAuthError::Store(e.to_string()))?;
        self.store.set(&self.account, &text).await.map_err(store_error)?;
        let endpoint = entry.discovery.as_ref().and_then(Discovery::authorization_endpoint_text);
        let identity = entry.identity.clone().flatten().unwrap_or_default();
        let who = has_tokens.then_some((&identity, endpoint.as_deref()));
        self.files.write_identity(&self.account, who).await.map_err(store_error)
    }

    /// The only writer of the stored entry: applies `change` with a fresh revision.
    async fn persist(&self, cache: &mut Cache, change: impl FnOnce(&mut Entry)) -> Result<(), OAuthError> {
        let mut entry = cache
            .entry
            .clone()
            .unwrap_or_else(|| Entry { url: self.binding.url.to_string(), ..Entry::default() });
        change(&mut entry);
        entry.revision = rand::random::<[u8; 16]>().iter().map(|b| format!("{b:02x}")).collect();
        self.write_entry(&entry).await?;
        self.hold(Some(&entry));
        cache.entry = Some(entry);
        self.sign_in_required.store(false, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    async fn erase(&self, cache: &mut Cache) -> Result<(), OAuthError> {
        self.files.write_revision(&self.account, None, false).await.map_err(store_error)?;
        self.store.delete(&self.account).await.map_err(store_error)?;
        self.files.write_identity(&self.account, None).await.map_err(store_error)?;
        cache.entry = None;
        Ok(())
    }

    /// The client requests are made as: the pre-registered one (its secret lives in the secret
    /// store), else the one registered dynamically.
    ///
    /// `Err` when the secret read never ran: a client that lost its secret is refused by the
    /// provider (`invalid_client`), which erases the stored sign-in. A read that ran and failed
    /// is "no secret", as before.
    async fn client_credentials(&self, entry: &Entry) -> Result<Option<ClientCredentials>, OAuthError> {
        if let Some(client) = &self.binding.client {
            let secret = match &client.inline_secret {
                Some(inline) => Some(inline.0.clone()),
                None => match self.store.get(&client.secret_account).await {
                    Ok(secret) => secret.filter(|s| !s.is_empty()),
                    Err(error) if error.unrun => return Err(store_error(error)),
                    Err(_) => None,
                },
            };
            return Ok(Some(ClientCredentials { client_id: client.client_id.clone(), client_secret: secret }));
        }
        Ok(entry.client_information.as_ref().and_then(ClientCredentials::from_info))
    }

    /// Renews a refused token from the refresh token. A failure that needs the user is
    /// `ReauthenticationRequired`.
    async fn refresh(&self, rejected: Option<String>, challenge: Option<&str>) -> Result<(), OAuthError> {
        // A store that never answered is not a sign-in that needs renewing by the user.
        let mut cache = self.load().await.map_err(|error| match error {
            OAuthError::Unavailable => error,
            _ => OAuthError::ReauthenticationRequired,
        })?;
        let entry = cache.entry.clone().ok_or(OAuthError::ReauthenticationRequired)?;
        // Another request already renewed it.
        if access_token(&entry).is_some() && access_token(&entry) != rejected {
            return Ok(());
        }
        let refresh_token = refresh_token(&entry).ok_or(OAuthError::ReauthenticationRequired)?;
        let client = self.client_credentials(&entry).await?.ok_or(OAuthError::ReauthenticationRequired)?;
        let discovery = match entry.discovery.clone() {
            Some(d) if d.token_endpoint().is_some() => d,
            _ => self.protocol.discover(&self.binding.url, parse_challenge(challenge).resource_metadata_url.as_deref()).await,
        };
        // A pre-registered client's provider issues tokens for its own APIs: no resource indicator.
        let resource = self.binding.client.is_none().then(|| discovery.resource(&self.binding.url));
        let form = vec![("grant_type", "refresh_token".to_owned()), ("refresh_token", refresh_token.clone())];
        match self.protocol.token(&discovery, &client, form, resource).await {
            Ok(mut tokens) => {
                if tokens.get("refresh_token").is_none_or(|t| t.is_null()) {
                    tokens["refresh_token"] = Value::String(refresh_token);
                }
                let identity = identity_from_token_response(&tokens);
                self.persist(&mut cache, |e| {
                    e.tokens = Some(tokens);
                    e.discovery = Some(discovery);
                    if identity.is_some() {
                        e.identity = Some(identity);
                    }
                })
                .await?;
                Ok(())
            }
            Err(TokenError::Oauth(code)) if matches!(code.as_str(), "invalid_client" | "unauthorized_client") => {
                self.erase(&mut cache).await?;
                Err(OAuthError::ReauthenticationRequired)
            }
            Err(TokenError::Oauth(code)) if code == "invalid_grant" => {
                // The grant is gone. The registration goes too: an authorization server that
                // forgot its clients would fail every later sign-in at the authorization endpoint.
                self.persist(&mut cache, |e| {
                    e.tokens = None;
                    e.client_information = None;
                })
                .await?;
                Err(OAuthError::ReauthenticationRequired)
            }
            // Any other answer invalidates nothing (the SDK's `auth()` recovers only from the two above).
            Err(TokenError::Oauth(_) | TokenError::Failed) => Err(OAuthError::ReauthenticationRequired),
        }
    }

    /// Signs out: forgets the stored sign-in, first revoking the grant at the authorization
    /// server where it documents a revocation endpoint. True when the server confirmed it.
    pub async fn sign_out(&self, revoke: bool) -> Result<bool, OAuthError> {
        let _gate = self.renew_gate.acquire().await.expect("the gate is never closed");
        let mut cache = self.lock_cache().await;
        let saved = self.store.get(&self.account).await.map_err(store_error)?;
        let entry: Option<Entry> = saved.as_deref().and_then(|text| serde_json::from_str(text).ok());
        let mut revoked = false;
        if revoke && let Some(entry) = &entry {
            let endpoint = entry.discovery.as_ref().and_then(Discovery::revocation_endpoint);
            let token = refresh_token(entry).or_else(|| access_token(entry));
            if let (Some(endpoint), Some(token), Some(client)) =
                (endpoint, token, entry.client_information.as_ref().and_then(ClientCredentials::from_info))
            {
                revoked = self.protocol.revoke(&endpoint, &token, refresh_token(entry).is_some(), &client).await;
            }
        }
        self.erase(&mut cache).await?;
        cache.loaded = true;
        Ok(revoked)
    }

    /// Restores the sign-in an account switch replaced (the new one failed to connect).
    pub async fn rollback_switch(&self) -> Result<(), OAuthError> {
        let Some(previous) = self.switched_from.lock().unwrap_or_else(|e| e.into_inner()).take() else { return Ok(()) };
        let mut cache = self.lock_cache().await;
        match previous {
            Some(entry) => {
                self.write_entry(&entry).await?;
                cache.entry = Some(entry);
            }
            None => self.erase(&mut cache).await?,
        }
        Ok(())
    }

    /// The sign-in flow of this server, as the login mechanism runs it.
    pub fn login_flow(self: &Arc<Self>, server: &str, mode: AccountMode) -> McpLoginFlow {
        McpLoginFlow { oauth: Arc::clone(self), target: LoginTarget::McpServer(server.to_owned()), mode, transactional: false, hint: None }
    }

    /// A sign-in beside the stored one, in any mode (an account of a multi-account connector):
    /// like a switch it keeps what it replaced, so [`rollback_switch`](Self::rollback_switch)
    /// can put it back.
    pub fn login_flow_beside(self: &Arc<Self>, server: &str, mode: AccountMode) -> McpLoginFlow {
        McpLoginFlow { transactional: true, ..self.login_flow(server, mode) }
    }
}

#[async_trait]
impl Authorizer for McpOAuth {
    async fn token(&self) -> Result<Option<String>, TransportError> {
        // An unreadable keychain must not block a server that needs no authentication.
        let Ok(cache) = self.load().await else { return Ok(None) };
        Ok(cache.entry.as_ref().and_then(access_token))
    }

    async fn renew(&self, rejected: Option<String>, challenge: Option<String>) -> Result<(), TransportError> {
        let _gate = self.renew_gate.acquire().await.expect("the gate is never closed");
        let renewed = self.refresh(rejected, challenge.as_deref()).await;
        self.sign_in_required.store(matches!(renewed, Err(OAuthError::ReauthenticationRequired)), std::sync::atomic::Ordering::SeqCst);
        renewed.map_err(Into::into)
    }
}

// ---- the explicit login ------------------------------------------------------------------

struct Pending {
    redirect_url: String,
    state: String,
    callbacks: mpsc::UnboundedSender<Callback>,
    /// Closes the listener, as a pasted callback does before the exchange runs.
    stopper: super::callback::Stopper,
}

struct Control {
    current: Mutex<LoginState>,
    /// States not yet delivered through `next`.
    queue: Mutex<std::collections::VecDeque<LoginState>>,
    queued: tokio::sync::Notify,
    cancel: CancellationToken,
    pending: Mutex<Option<Pending>>,
}

impl Control {
    fn emit(&self, state: LoginState) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = state.clone();
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).push_back(state);
        self.queued.notify_one();
    }
}

pub struct McpLoginFlow {
    oauth: Arc<McpOAuth>,
    target: LoginTarget,
    mode: AccountMode,
    transactional: bool,
    /// The `resource_metadata` URL of the `WWW-Authenticate` challenge that asked for the sign-in.
    hint: Option<String>,
}

impl McpLoginFlow {
    /// The challenge of the request the server refused: discovery asks the resource metadata URL it names.
    #[must_use]
    pub fn with_challenge(mut self, challenge: Option<&str>) -> Self {
        self.hint = parse_challenge(challenge).resource_metadata_url;
        self
    }
}

struct Session {
    control: Arc<Control>,
    delivered_terminal: std::sync::atomic::AtomicBool,
}

fn failure_of(error: OAuthError) -> LoginFailure {
    let message = error.to_string();
    let code = match error {
        OAuthError::ReauthenticationRequired => "reauthenticationRequired",
        OAuthError::LoginFailed => "loginFailed",
        OAuthError::ScopeNotGranted(_) => "scopeNotGranted",
        OAuthError::Store(_) | OAuthError::Unavailable => "store",
    };
    LoginFailure::Failed { code: code.to_owned(), message }
}

#[async_trait]
impl LoginFlow for McpLoginFlow {
    fn target(&self) -> &LoginTarget {
        &self.target
    }

    async fn start(&self) -> Result<Box<dyn LoginSession>, LoginError> {
        let cancel = CancellationToken::new();
        // One sign-in per server: a new one replaces the pending one.
        if let Some(previous) = self.oauth.active_login.lock().unwrap_or_else(|e| e.into_inner()).replace(cancel.clone()) {
            previous.cancel();
        }
        let control = Arc::new(Control {
            current: Mutex::new(LoginState::Starting),
            queue: Mutex::new(std::collections::VecDeque::new()),
            queued: tokio::sync::Notify::new(),
            cancel,
            pending: Mutex::new(None),
        });
        let (oauth, mode, transactional, hint, task_control) = (Arc::clone(&self.oauth), self.mode, self.transactional, self.hint.clone(), Arc::clone(&control));
        mixdog_rt::spawn("mcp.oauth.login", mixdog_rt::TaskClass::Work, async move {
            let last = match oauth.run_login(mode, transactional, hint, &task_control).await {
                Ok(account) => LoginState::Done { account },
                Err(Stop::Cancelled) => LoginState::Cancelled,
                Err(Stop::Expired) => LoginState::Failed(LoginFailure::Expired),
                Err(Stop::Failed(error)) => LoginState::Failed(failure_of(error)),
            };
            task_control.emit(last);
        });
        Ok(Box::new(Session { control, delivered_terminal: false.into() }))
    }
}

#[async_trait]
impl LoginSession for Session {
    fn state(&self) -> LoginState {
        self.control.current.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    async fn next(&self) -> Option<LoginState> {
        use std::sync::atomic::Ordering;
        if self.delivered_terminal.load(Ordering::SeqCst) {
            return None;
        }
        let state = loop {
            // `notify_one` stores a permit, so a state pushed between the pop and the wait is not lost.
            if let Some(state) = self.control.queue.lock().unwrap_or_else(|e| e.into_inner()).pop_front() {
                break state;
            }
            self.control.queued.notified().await;
        };
        if state.is_terminal() {
            self.delivered_terminal.store(true, Ordering::SeqCst);
        }
        Some(state)
    }

    async fn provide(&self, input: LoginInput) -> Result<(), LoginError> {
        let LoginInput::AuthorizationCode(pasted) = input;
        if self.state().is_terminal() {
            return Err(LoginError::Finished);
        }
        let (waiting, parsed) = {
            let mut pending = self.control.pending.lock().unwrap_or_else(|e| e.into_inner());
            let Some(waiting) = pending.as_ref() else { return Err(LoginError::InputNotExpected) };
            let parsed = parse_pasted(&pasted, &waiting.redirect_url, &waiting.state).map_err(|message| {
                LoginError::Failed(LoginFailure::Failed { code: "invalidCallback".to_owned(), message: message.to_owned() })
            })?;
            // The same answer the loopback would give; an invalid paste above leaves the login pending.
            (pending.take().ok_or(LoginError::InputNotExpected)?, parsed)
        };
        // Node stops listening before it answers the callback: while the exchange runs, the browser is refused.
        waiting.stopper.shutdown(None).await;
        let code = match parsed {
            Pasted::Code(code) => Some(code),
            Pasted::Denied => None,
        };
        let _ = waiting.callbacks.send(Callback::unheld(code));
        Ok(())
    }

    fn cancel(&self) {
        self.control.cancel.cancel();
    }
}
