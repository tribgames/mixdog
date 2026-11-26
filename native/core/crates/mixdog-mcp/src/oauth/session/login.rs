//! The explicit browser sign-in: a port of Node's `createLoginFlow` (`oauth-login.mjs`) over the MCP SDK's `auth()`
//! (`client/auth.js`, 1.32.2) and the provider that Node gives it (`oauth-provider.mjs`).
//!
//! One login owns one abort (the cancel and the deadline, armed on entry before discovery) that every request,
//! the wait for the callback and the held browser page observe. Credentials changes go through one mode-aware
//! mechanism: a sign-in beside the stored one works on an in-memory copy and never writes the store until it is
//! committed; any other sign-in writes the stored entry as the provider's callbacks run.

use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use url::Url;

use super::Cache;
use super::Control;
use super::Entry;
use super::McpOAuth;
use super::Pending;
use super::Stop;
use crate::oauth::account::AccountMode;
use crate::oauth::account::identity_from_token_response;
use crate::oauth::account::set_query;
use crate::oauth::account::with_account_params;
use crate::oauth::callback::CALLBACK_PATH;
use crate::oauth::callback::Callback;
use crate::oauth::callback::Flush;
use crate::oauth::callback::PageOutcome;
use crate::oauth::callback::Stopper;
use crate::oauth::protocol::ClientCredentials;
use crate::oauth::protocol::Discovery;
use crate::oauth::protocol::TokenError;
use crate::oauth::protocol::pkce;
use crate::oauth::protocol::random_state;
use crate::oauth::shared::OAuthError;
use crate::oauth::shared::missing_scopes;
use mixdog_core_api::domain::login::LoginState;

/// The OAuth error codes the SDK maps to a typed error (`OAUTH_ERRORS`), but `server_error`: a refresh refused
/// with one of these ends the login, any other answer falls through to the browser.
const TYPED_ERRORS: [&str; 16] = [
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "access_denied",
    "temporarily_unavailable",
    "unsupported_response_type",
    "unsupported_token_type",
    "invalid_token",
    "method_not_allowed",
    "too_many_requests",
    "invalid_client_metadata",
    "insufficient_scope",
    "invalid_target",
];

/// Why a step of the SDK's `auth()` ended.
enum AuthError {
    /// The login was cancelled or its deadline passed.
    Stop(Stop),
    /// The token endpoint refused with a typed OAuth error.
    Rejected(String),
    /// Anything the SDK lets a refresh fall through on: a `ServerError`, an unknown code, a network failure.
    Soft,
    Failed(OAuthError),
}

impl From<Stop> for AuthError {
    fn from(stop: Stop) -> Self {
        Self::Stop(stop)
    }
}

impl From<OAuthError> for AuthError {
    fn from(error: OAuthError) -> Self {
        Self::Failed(error)
    }
}

impl AuthError {
    fn into_stop(self) -> Stop {
        match self {
            Self::Stop(stop) => stop,
            Self::Rejected(_) | Self::Soft => Stop::Failed(OAuthError::LoginFailed),
            Self::Failed(error) => Stop::Failed(error),
        }
    }
}

fn token_failure(error: TokenError) -> AuthError {
    match error {
        TokenError::Oauth(code) if TYPED_ERRORS.contains(&code.as_str()) => AuthError::Rejected(code),
        TokenError::Oauth(_) | TokenError::Failed => AuthError::Soft,
    }
}

enum Authorized {
    Tokens,
    Redirect,
}

/// What `invalidateCredentials(scope)` clears.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Invalidate {
    All,
    Tokens,
    Client,
}

/// Resolves when the login is cancelled or its deadline passes: Node's abort of the login signal.
/// Under a test that took the seams (`seam::take_control`) it is a fire of `seam::DEADLINE`.
enum Deadline {
    At(tokio::time::Instant),
    #[cfg(feature = "test-support")]
    Fired(usize),
}

impl Deadline {
    fn start() -> Self {
        #[cfg(feature = "test-support")]
        if crate::oauth::callback::seam::controlled() {
            return Self::Fired(crate::oauth::callback::seam::DEADLINE.count());
        }
        Self::At(tokio::time::Instant::now() + super::LOGIN_DEADLINE)
    }

    async fn passed(&self) {
        match self {
            Self::At(at) => mixdog_rt::time::sleep_until(*at).await,
            #[cfg(feature = "test-support")]
            Self::Fired(seen) => crate::oauth::callback::seam::DEADLINE.after(*seen).await,
        }
    }

    fn expired(&self) -> bool {
        match self {
            Self::At(at) => tokio::time::Instant::now() >= *at,
            #[cfg(feature = "test-support")]
            Self::Fired(seen) => crate::oauth::callback::seam::DEADLINE.count() > *seen,
        }
    }
}

struct Abort {
    cancel: CancellationToken,
    deadline: Arc<Deadline>,
}

impl Clone for Abort {
    fn clone(&self) -> Self {
        Self { cancel: self.cancel.clone(), deadline: Arc::clone(&self.deadline) }
    }
}

impl Abort {
    async fn fired(&self) -> Stop {
        tokio::select! {
            () = self.cancel.cancelled() => Stop::Cancelled,
            () = self.deadline.passed() => Stop::Expired,
        }
    }

    /// Node's `signal.throwIfAborted()`.
    fn check(&self) -> Result<(), Stop> {
        if self.cancel.is_cancelled() {
            return Err(Stop::Cancelled);
        }
        if self.deadline.expired() {
            return Err(Stop::Expired);
        }
        Ok(())
    }

    /// Runs `work` unless the login is aborted first, which drops it (and with it the request in flight).
    async fn guard<T>(&self, work: impl Future<Output = T>) -> Result<T, Stop> {
        tokio::select! {
            out = work => Ok(out),
            stop = self.fired() => Err(stop),
        }
    }
}

/// The browser page of a callback, held until the login reports its outcome: Node's `awaitCallback` `respond` and
/// the flush of the page last answered (`flushing`).
#[derive(Default)]
struct Held {
    responder: Mutex<Option<Responder>>,
    flushing: Mutex<Option<Flush>>,
    /// Begun once the held page took its outcome: Node's `respond(...)` writes the page synchronously.
    begun: Mutex<Option<CancellationToken>>,
}

struct Responder {
    tx: oneshot::Sender<PageOutcome>,
    begun: CancellationToken,
    flush: Flush,
}

impl Held {
    fn hold(&self, responder: Responder) {
        *self.responder.lock().unwrap_or_else(|e| e.into_inner()) = Some(responder);
    }

    /// Node's `settle(failure)`: answers the held page, if any, and returns its flush.
    async fn settle(&self, outcome: PageOutcome) -> Option<Flush> {
        let taken = self.responder.lock().unwrap_or_else(|e| e.into_inner()).take();
        let Some(responder) = taken else {
            // Answered already (by the abort): nothing to flush here, but the page is on its way before the caller
            // moves on to closing the listener.
            let begun = self.begun.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some(begun) = begun {
                begun.cancelled().await;
            }
            return None;
        };
        *self.begun.lock().unwrap_or_else(|e| e.into_inner()) = Some(responder.begun.clone());
        // Registered before the page is answered, so a listener shutdown that follows destroys the connections only
        // after the flush; the bound's deadline is fixed here, for the login's own wait and that shutdown alike.
        responder.flush.start();
        *self.flushing.lock().unwrap_or_else(|e| e.into_inner()) = Some(responder.flush.clone());
        let _ = responder.tx.send(outcome);
        responder.begun.cancelled().await;
        Some(responder.flush)
    }

    fn flushing(&self) -> Option<Flush> {
        self.flushing.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// The state Node keeps in `flow`, `creds` and the provider for one login.
struct Run<'a> {
    oauth: &'a Arc<McpOAuth>,
    ctl: &'a Control,
    mode: AccountMode,
    /// A sign-in beside the stored one: in memory until committed.
    in_memory: bool,
    abort: Abort,
    /// Node's `creds`: the stored entry as this login sees it, with the changes not written yet.
    creds: Entry,
    generation: Option<u64>,
    login_version: u64,
    verifier: Option<String>,
    state: String,
    browser_opened: bool,
    /// `flow.identity`: who the last token answer names.
    identity: Option<crate::oauth::account::Identity>,
    /// The challenge of the refused request: its `resource_metadata` and `scope`.
    challenge: crate::oauth::protocol::Challenge,
    redirect_url: String,
    callbacks: mpsc::UnboundedSender<Callback>,
    stopper: Stopper,
}

fn login_credentials(server: &str, stored: Option<&Entry>, in_memory: bool) -> Entry {
    let mut creds = Entry { url: server.to_owned(), ..Entry::default() };
    if let Some(stored) = stored {
        creds.revision = stored.revision.clone();
        creds.client_information = stored.client_information.clone();
        creds.redirect_url = stored.redirect_url.clone();
        creds.discovery = stored.discovery.clone();
        if !in_memory {
            creds.tokens = stored.tokens.clone();
            creds.grant = stored.grant.clone();
            creds.identity = stored.identity.clone();
        }
    }
    creds
}

/// Node's abort handler: the held page gets the generic failure now and the listener stops accepting at
/// once, whatever the login is doing (an exchange or a credential write may be stalled past the deadline).
fn spawn_abort_watcher(abort: Abort, held: Arc<Held>, stopper: Stopper) -> tokio::task::JoinHandle<()> {
    mixdog_rt::spawn("mcp.oauth.login.abort", mixdog_rt::TaskClass::Work, async move {
        abort.fired().await;
        held.settle(PageOutcome::Failed { scope_not_granted: false }).await;
        let flushing = held.flushing();
        stopper.shutdown(flushing).await;
    })
}

impl McpOAuth {
    pub(super) async fn run_login(
        self: &Arc<Self>,
        mode: AccountMode,
        transactional: bool,
        challenge: crate::oauth::protocol::Challenge,
        ctl: &Control,
    ) -> Result<Option<String>, Stop> {
        ctl.emit(LoginState::Starting);
        let abort = Abort { cancel: ctl.cancel.clone(), deadline: Arc::new(Deadline::start()) };
        let in_memory = mode == AccountMode::Switch || transactional;
        let server = &self.binding.url;
        let (stored, generation, login_version) = {
            let cache = abort.guard(self.load()).await??;
            (cache.entry.clone(), cache.generation, self.credential.login_version.load(Ordering::Relaxed))
        };
        let mut creds = login_credentials(server.as_str(), stored.as_ref(), in_memory);
        let state = random_state();
        let (callbacks, callback_rx) = mpsc::unbounded_channel();
        let port = creds.redirect_url.as_deref().and_then(|u| Url::parse(u).ok()).and_then(|u| u.port()).unwrap_or(0);
        let listener = super::super::callback::listen(port, state.clone(), self.binding.display_name.clone(), callbacks.clone())
            .await
            .map_err(|_| OAuthError::LoginFailed)?;
        let redirect_url = format!("http://127.0.0.1:{}{CALLBACK_PATH}", listener.port);
        creds.redirect_url = Some(redirect_url.clone());
        let stopper = listener.stopper();
        let held = Arc::new(Held::default());

        let watcher = spawn_abort_watcher(abort.clone(), Arc::clone(&held), stopper.clone());

        let mut run = Run {
            oauth: self,
            ctl,
            mode,
            in_memory,
            abort,
            creds,
            generation,
            login_version,
            verifier: None,
            state,
            browser_opened: false,
            identity: None,
            challenge,
            redirect_url,
            callbacks,
            stopper: stopper.clone(),
        };
        let mut code_received = false;
        let result = run.attempt(callback_rx, &held, &mut code_received).await;
        let result = match result {
            Ok(done) => Ok(done),
            Err(stop) => {
                let scope_not_granted = matches!(stop, Stop::Failed(OAuthError::ScopeNotGranted(_)));
                if run.abort.check().is_ok()
                    && let Some(flush) = held.settle(PageOutcome::Failed { scope_not_granted }).await
                {
                    flush.wait().await;
                }
                // A server that no longer knows our client_id answers the browser with an HTTP error nobody here
                // sees: register again next time.
                if run.browser_opened
                    && !code_received
                    && self.binding.client.is_none()
                    && let Ok(mut cache) = self.load().await
                    && run.require_current(cache.generation).is_ok()
                {
                    let _ = run.invalidate(&mut cache, Invalidate::Client).await;
                }
                Err(stop)
            }
        };
        if run.abort.check().is_err() {
            let _ = watcher.await;
        } else {
            watcher.abort();
        }
        ctl.pending.lock().unwrap_or_else(|e| e.into_inner()).take();
        stopper.shutdown(held.flushing()).await;
        drop(listener);
        result
    }
}

impl Run<'_> {
    async fn attempt(&mut self, mut callback_rx: mpsc::UnboundedReceiver<Callback>, held: &Held, code_received: &mut bool) -> Result<Option<String>, Stop> {
        self.abort.check()?;
        let authorized = self.auth(None).await.map_err(AuthError::into_stop)?;
        if let Authorized::Redirect = authorized {
            let callback = self.abort.guard(callback_rx.recv()).await?;
            self.ctl.pending.lock().unwrap_or_else(|e| e.into_inner()).take();
            let Callback { code, respond, begun, flushed } = callback.ok_or(OAuthError::LoginFailed)?;
            held.hold(Responder { tx: respond, begun, flush: flushed });
            let code = code.ok_or(OAuthError::LoginFailed)?;
            *code_received = true;
            self.abort.check()?;
            self.ctl.emit(LoginState::Waiting);
            if !matches!(self.auth(Some(&code)).await.map_err(AuthError::into_stop)?, Authorized::Tokens) {
                return Err(OAuthError::LoginFailed.into());
            }
        }
        let account = self.identity.as_ref().map(|i| i.account.clone()).filter(|a| !a.is_empty());
        if self.in_memory {
            self.commit().await?;
        }
        if let Some(flush) = held.settle(PageOutcome::Done).await {
            flush.wait().await;
        }
        Ok(account)
    }

    /// Stores the sign-in made beside the stored one, keeping what it replaced so it can be restored.
    async fn commit(&mut self) -> Result<(), Stop> {
        let mut entry = self.creds.clone();
        entry.url = self.oauth.binding.url.to_string();
        let mut cache = self.oauth.load().await?;
        self.require_current(cache.generation)?;
        self.abort.check()?;
        // What was stored, an entry bound to another address included: a rollback puts back what the sign-in replaced.
        let previous = cache.stored().cloned();
        let version = self.oauth.credential.login_version.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        self.oauth.replace(&mut cache, entry, false).await?;
        // A switch that was cancelled during its write must not escape the gate as a new grant.
        if let Err(stop) = self.abort.check() {
            match previous {
                Some(entry) => self.oauth.replace(&mut cache, entry, true).await?,
                None => self.oauth.erase(&mut cache).await?,
            }
            return Err(stop);
        }
        *self.oauth.switched_from.lock().unwrap_or_else(|e| e.into_inner()) = Some((version, previous));
        Ok(())
    }

    fn require_current(&self, generation: Option<u64>) -> Result<(), OAuthError> {
        // A switch can replace a grant that refreshed while the browser was open. It must not
        // replace a newer explicit sign-in or undo sign-out. A non-transactional login carries the
        // whole previous entry, so it must not overwrite even a concurrent refresh.
        if self.login_version != self.oauth.credential.login_version.load(Ordering::Relaxed) || (!self.in_memory && self.generation != generation) {
            return Err(OAuthError::LoginFailed);
        }
        Ok(())
    }

    /// Node's `provider.save`: the change reaches the stored entry now, unless the sign-in is in memory.
    async fn save(&mut self, cache: &mut Cache, rotated: bool, change: impl FnOnce(&mut Entry)) -> Result<(), AuthError> {
        change(&mut self.creds);
        if self.in_memory {
            return Ok(());
        }
        if !rotated {
            self.login_version = self.oauth.credential.login_version.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        }
        self.oauth.replace(cache, self.creds.clone(), rotated).await?;
        // The grant the write named is the one this login goes on storing.
        self.creds.grant = cache.entry.as_ref().and_then(|entry| entry.grant.clone());
        self.generation = cache.generation;
        Ok(())
    }

    /// Node's `provider.invalidateCredentials(scope)`.
    async fn invalidate(&mut self, cache: &mut Cache, scope: Invalidate) -> Result<(), AuthError> {
        if scope == Invalidate::All {
            self.verifier = None;
        }
        let change = |creds: &mut Entry| {
            if scope != Invalidate::Client {
                creds.tokens = None;
            }
            creds.client_information = None;
            if scope == Invalidate::All {
                creds.discovery = None;
            }
        };
        if scope == Invalidate::All {
            change(&mut self.creds);
            if !self.in_memory {
                self.login_version = self.oauth.credential.login_version.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
                self.oauth.erase(cache).await?;
                self.generation = cache.generation;
            }
            return Ok(());
        }
        self.save(cache, false, change).await
    }

    /// The SDK's `auth()`: a refused client or grant is invalidated and the attempt made once more.
    async fn auth(&mut self, code: Option<&str>) -> Result<Authorized, AuthError> {
        // Transport and explicit login share this gate from the read of the refresh token
        // through its exchange and storage. Never hold it while waiting for the browser.
        let oauth = Arc::clone(self.oauth);
        let mut cache = self.abort.guard(oauth.load()).await??;
        if code.is_none()
            && !self.in_memory
            && self.login_version == oauth.credential.login_version.load(Ordering::Relaxed)
            && self.generation != cache.generation
        {
            self.creds = cache.entry.clone().unwrap_or_else(|| Entry { url: oauth.binding.url.to_string(), ..Entry::default() });
            self.creds.redirect_url = Some(self.redirect_url.clone());
            self.generation = cache.generation;
        }
        self.require_current(cache.generation)?;
        self.abort.check()?;
        match self.auth_internal(&mut cache, code).await {
            Err(AuthError::Rejected(rejected)) if matches!(rejected.as_str(), "invalid_client" | "unauthorized_client") => {
                self.invalidate(&mut cache, Invalidate::All).await?;
                self.auth_internal(&mut cache, code).await
            }
            Err(AuthError::Rejected(rejected)) if rejected == "invalid_grant" => {
                self.invalidate(&mut cache, Invalidate::Tokens).await?;
                self.auth_internal(&mut cache, code).await
            }
            other => other,
        }
    }

    /// The client information as the provider gives it: the configured client, else the registered one.
    async fn client_information(&self) -> Result<Option<Value>, AuthError> {
        if self.oauth.binding.client.is_some() {
            let Some(credentials) = self.oauth.client_credentials(&self.creds).await? else { return Ok(None) };
            return Ok(Some(match &credentials.client_secret {
                Some(secret) => json!({"client_id": credentials.client_id, "client_secret": secret}),
                None => json!({"client_id": credentials.client_id}),
            }));
        }
        Ok(self.creds.client_information.clone())
    }

    /// The authorization request for a new browser sign-in: the PKCE challenge, the scope and resource, the configured client's own
    /// parameters, and the account-mode parameters.
    fn authorization_url(&self, endpoint: Url, challenge: &str, client_id: &str, scope: Option<&str>, discovery: &Discovery, server: &Url) -> Url {
        let static_client = self.oauth.binding.client.as_ref();
        let mut url = endpoint;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", client_id)
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("redirect_uri", &self.redirect_url)
                .append_pair("state", &self.state);
            if let Some(scope) = scope {
                query.append_pair("scope", scope);
            }
            if static_client.is_none()
                && let Some(resource) = discovery.resource(server)
            {
                query.append_pair("resource", &resource);
            }
        }
        if let Some(client) = static_client {
            for (key, value) in &client.auth_params {
                set_query(&mut url, key, value);
            }
        } else if let Some(scope) = scope
            && discovery.offers_scope("offline_access")
            && !scope.split(' ').any(|s| s == "offline_access")
        {
            // Without `offline_access` such a server issues no refresh token.
            set_query(&mut url, "scope", &format!("{scope} offline_access"));
            url.query_pairs_mut().append_pair("prompt", "consent");
        }
        with_account_params(&url, self.mode)
    }

    async fn auth_internal(&mut self, cache: &mut Cache, code: Option<&str>) -> Result<Authorized, AuthError> {
        let server = self.oauth.binding.url.clone();
        let static_client = self.oauth.binding.client.clone();

        let discovery = self.discover().await?;
        let issuer = discovery.authorization_server_url.clone();
        let resource = static_client.is_none().then(|| discovery.resource(&server)).flatten();
        // The scope the refusal asked for comes first (`auth(provider, { scope })` before the client's own).
        let scope = self
            .challenge
            .scope
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| static_client.as_ref().filter(|c| !c.scopes.is_empty()).map(|c| c.scopes.join(" ")))
            .or_else(|| discovery.resource_scopes());

        let (info, unstamped) = self.client_info(cache, &discovery, &issuer, scope.as_deref(), code.is_some()).await?;
        let credentials = ClientCredentials::from_info(&info).ok_or(OAuthError::LoginFailed)?;

        if let Some(code) = code {
            let verifier = self.verifier.clone().ok_or(OAuthError::LoginFailed)?;
            let form = vec![
                ("grant_type", "authorization_code".to_owned()),
                ("code", code.to_owned()),
                ("code_verifier", verifier),
                ("redirect_uri", self.redirect_url.clone()),
            ];
            let tokens = self.token(&discovery, &credentials, form, resource).await?;
            self.save_tokens(cache, tokens, &issuer, unstamped, false).await?;
            return Ok(Authorized::Tokens);
        }

        if self.refresh(cache, &discovery, &credentials, resource, &issuer, unstamped).await? {
            return Ok(Authorized::Tokens);
        }

        self.abort.check()?;
        let authorization_endpoint = discovery.authorization_endpoint().ok_or(OAuthError::LoginFailed)?;
        if !discovery.supports_s256() {
            return Err(OAuthError::LoginFailed.into());
        }
        let pair = pkce();
        let url = self.authorization_url(authorization_endpoint, &pair.challenge, &credentials.client_id, scope.as_deref(), &discovery, &server);
        self.verifier = Some(pair.verifier);
        if self.browser_opened {
            return Err(OAuthError::ReauthenticationRequired.into());
        }
        if static_client.is_some() {
            // The configured client is stored with this login's redirect, as a registration would be.
            self.save(cache, false, |c| c.client_information = Some(info)).await?;
        }
        self.browser_opened = true;
        *self.ctl.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(Pending {
            redirect_url: self.redirect_url.clone(),
            state: self.state.clone(),
            callbacks: self.callbacks.clone(),
            stopper: self.stopper.clone(),
        });
        self.ctl.emit(LoginState::Authorize { url: url.to_string(), manual_url: None });
        Ok(Authorized::Redirect)
    }

    async fn discover(&mut self) -> Result<Discovery, AuthError> {
        let oauth = Arc::clone(self.oauth);
        let server = &oauth.binding.url;
        let discovery = match self.creds.discovery.clone().filter(|d| !d.authorization_server_url.is_empty()) {
            Some(mut cached) => {
                if cached.authorization_server_metadata.is_none() {
                    let hint = self.challenge.resource_metadata_url.as_deref().or(cached.resource_metadata_url.as_deref());
                    let found = self.abort.guard(oauth.protocol.discover(server, hint)).await?.map_err(token_failure)?;
                    cached.authorization_server_metadata = found.authorization_server_metadata;
                    if cached.resource_metadata.is_none() {
                        cached.resource_metadata = found.resource_metadata;
                    }
                }
                cached
            }
            None => {
                let hint = self.challenge.resource_metadata_url.clone();
                let mut found = self.abort.guard(oauth.protocol.discover(server, hint.as_deref())).await?.map_err(token_failure)?;
                // The SDK keeps the challenge's URL, not the one it derived itself.
                found.resource_metadata_url = hint;
                found
            }
        };
        self.creds.discovery = Some(discovery.clone());
        Ok(discovery)
    }

    /// The client information for `issuer` (registered now when none is stored and no code is
    /// being exchanged), and the stored copy that carries no issuer stamp.
    async fn client_info(
        &mut self,
        cache: &mut Cache,
        discovery: &Discovery,
        issuer: &str,
        scope: Option<&str>,
        exchanging_code: bool,
    ) -> Result<(Value, Option<Value>), AuthError> {
        let info = discard_if_other_issuer(self.client_information().await?, issuer);
        let unstamped = info.clone().filter(|i| i.get("issuer").is_none_or(Value::is_null));
        if let Some(info) = info {
            return Ok((info, unstamped));
        }
        if exchanging_code {
            return Err(OAuthError::LoginFailed.into());
        }
        let oauth = Arc::clone(self.oauth);
        let redirect = self.redirect_url.clone();
        let mut registered = self.abort.guard(oauth.protocol.register(discovery, &redirect, scope)).await?.map_err(|_| OAuthError::LoginFailed)?;
        registered["issuer"] = Value::String(issuer.to_owned());
        let stored = registered.clone();
        self.save(cache, false, |c| c.client_information = Some(stored)).await?;
        Ok((registered, unstamped))
    }

    /// Renews the stored tokens; `false` when none can be renewed and the browser is the way on.
    async fn refresh(
        &mut self,
        cache: &mut Cache,
        discovery: &Discovery,
        credentials: &ClientCredentials,
        resource: Option<String>,
        issuer: &str,
        unstamped: Option<Value>,
    ) -> Result<bool, AuthError> {
        let refresh = self
            .creds
            .tokens
            .clone()
            .filter(|t| t.get("issuer").and_then(Value::as_str).is_none_or(|i| same_issuer(i, issuer)))
            .and_then(|t| t.get("refresh_token").and_then(Value::as_str).map(str::to_owned));
        let Some(refresh) = refresh else { return Ok(false) };
        self.abort.check()?;
        let form = vec![("grant_type", "refresh_token".to_owned()), ("refresh_token", refresh.clone())];
        // After issuing a refresh, finish the bounded exchange even if the dialog closes:
        // the provider may already have invalidated the previous refresh token.
        match self.oauth.protocol.token(discovery, credentials, form, resource).await.map_err(token_failure) {
            Ok(mut tokens) => {
                if tokens.get("refresh_token").is_none_or(Value::is_null) {
                    tokens["refresh_token"] = Value::String(refresh);
                }
                self.identity = identity_from_token_response(&tokens);
                self.save_tokens(cache, tokens, issuer, unstamped, true).await?;
                Ok(true)
            }
            Err(AuthError::Soft) => Ok(false),
            Err(other) => Err(other),
        }
    }

    /// One token request, bounded by the login's abort. Its answer names who the tokens belong to.
    async fn token(
        &mut self,
        discovery: &Discovery,
        credentials: &ClientCredentials,
        form: Vec<(&str, String)>,
        resource: Option<String>,
    ) -> Result<Value, AuthError> {
        let tokens = self.abort.guard(self.oauth.protocol.token(discovery, credentials, form, resource)).await?.map_err(token_failure)?;
        self.identity = identity_from_token_response(&tokens);
        Ok(tokens)
    }

    /// Node's `provider.saveTokens`.
    async fn save_tokens(&mut self, cache: &mut Cache, mut tokens: Value, issuer: &str, mut unstamped: Option<Value>, rotated: bool) -> Result<(), AuthError> {
        tokens["issuer"] = Value::String(issuer.to_owned());
        if !rotated {
            self.abort.check()?;
        }
        // A sign-in of a client with its own scopes must be granted all of them (a granular consent screen
        // lets the user uncheck some): nothing is stored, so the next connect asks again.
        if self.browser_opened
            && let Some(client) = &self.oauth.binding.client
        {
            let missing = missing_scopes(&client.scopes, tokens.get("scope").and_then(Value::as_str));
            if !missing.is_empty() {
                return Err(OAuthError::ScopeNotGranted(missing).into());
            }
        }
        let prior = self.creds.clone();
        if let Some(info) = &mut unstamped {
            info["issuer"] = Value::String(issuer.to_owned());
        }
        let identity = self.identity.clone();
        let browser_opened = self.browser_opened;
        self.save(cache, rotated, move |c| {
            c.tokens = Some(tokens);
            if let Some(info) = unstamped {
                c.client_information = Some(info);
            }
            // A browser sign-in may be another account: its identity replaces the stored one (null when the server
            // named nobody). A refresh keeps it unless the answer names the account again.
            if browser_opened || identity.is_some() {
                c.identity = Some(identity);
            }
        })
        .await?;
        // The login was reported failed while this write was outstanding: roll it back (same save path), so no
        // tokens outlive the reported failure.
        if !rotated && let Err(stop) = self.abort.check() {
            self.save(cache, false, move |c| *c = prior).await?;
            return Err(stop.into());
        }
        Ok(())
    }
}

fn same_issuer(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

/// The SDK's `discardIfIssuerMismatch`: a value stamped for another authorization server reads back as nothing.
fn discard_if_other_issuer(stored: Option<Value>, issuer: &str) -> Option<Value> {
    let stored = stored?;
    match stored.get("issuer") {
        Some(Value::String(stamped)) => same_issuer(stamped, issuer).then_some(stored),
        _ => Some(stored),
    }
}
