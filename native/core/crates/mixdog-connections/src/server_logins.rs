//! The provider logins stored on a server whose daemon runs models with the server's own logins. Every call runs on that
//! server's attached core (this PC's sign-ins are never read or sent). A subscription login starts on the server and is
//! opened in this PC's browser (the address is returned, the renderer opens it); while it is pending the provider's
//! localhost callback port is forwarded from this PC to the server over ssh, so the browser's redirect reaches the server.
//! Pasting the redirected address completes it otherwise. A login that ends on this PC's side without the user finishing it
//! (the link goes, the model login changes, this service closes) is cancelled on the server, now when it can be reached,
//! else once it is attached again.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{
    SshCredentialSource, SshKeychainIssue, SshModelLogin, SshServerLogin, SshServerLoginFlow, SshServerLoginFlowState,
    SshServerLoginKind, SshServerLogins,
};
use mixdog_app_server_client::api::{CallOptions, ClientError, ConnectionStatus, ProtocolClient, SectionName};
use mixdog_rt::time::{sleep, timeout, Instant};
use mixdog_rt::{CancellationToken, TaskClass};
use mixdog_ssh::callback_forward::{open_callback_forward, CallbackForward};
use mixdog_ssh::command::parse_ssh_target;
use mixdog_ssh::context::{AttemptContext, HostSettings, SshEnv};
use mixdog_ssh::diagnostics::diagnostics_key_for;
use serde_json::{json, Map, Value};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use url::Url;

use crate::host_store::{SshHostRecord, SshHostStore};
use crate::link::LinkPool;
use crate::link_machine::{LinkState, ModelLogin};

/// Longest a pending login keeps its callback forward.
pub const MAX_FORWARD: Duration = Duration::from_secs(15 * 60);
/// Longest an ending login waits for the server to take its cancel.
pub const CANCEL_TIMEOUT: Duration = Duration::from_secs(3);
/// Most cancels kept for a server that cannot be reached yet (the oldest go first).
const MAX_QUEUED_CANCELS: usize = 32;
/// How long the server keeps a login before it drops it itself: a cancel for an older login has nothing left to do.
const SERVER_FLOW_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_KEY_LENGTH: usize = 8_192;
const MAX_URL_LENGTH: usize = 16_384;
const UPDATE_CAPACITY: usize = 16;

/// A refused or failed request, safe to show: it never carries a key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoginError(pub String);

impl fmt::Display for LoginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LoginError {}

type LoginResult<T> = Result<T, LoginError>;

fn fail<T>(message: impl Into<String>) -> LoginResult<T> {
    Err(LoginError(message.into()))
}

/// The server's own words for a failed call.
fn server_message(error: &ClientError) -> String {
    match error {
        ClientError::Rpc(body) => body.message.clone(),
        other => other.to_string(),
    }
}

fn call_failed(error: &ClientError) -> LoginError {
    LoginError(server_message(error))
}

/// `message` with each of `secrets` (plain and JSON-escaped) replaced by `[redacted]`.
fn redact_secrets(message: &str, secrets: &[&str]) -> String {
    let mut safe = message.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        let quoted = Value::String((*secret).to_owned()).to_string();
        let escaped = &quoted[1..quoted.len() - 1];
        safe = safe.replace(secret, "[redacted]");
        if escaped != *secret {
            safe = safe.replace(escaped, "[redacted]");
        }
    }
    safe
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---------------------------------------------------------------------------------------------
// What the logins reach outside themselves
// ---------------------------------------------------------------------------------------------

/// An attached server connection, as the logins use it.
#[async_trait]
pub(crate) trait LoginServer: Send + Sync {
    fn model_login(&self) -> ModelLogin;
    fn client(&self) -> Arc<dyn ProtocolClient>;
    /// Sessions running a turn on the server; `None` when unknown.
    fn busy_sessions(&self) -> Option<u32>;
    /// Resolves once this attachment stops running models with the server's logins: it is closed or replaced, or its model
    /// login changed; at once when it already has.
    async fn ended(&self);
}

pub(crate) trait LoginServers: Send + Sync {
    /// The attached connection of a saved server; `None` when it is not attached.
    fn attached(&self, id: &str) -> Option<Arc<dyn LoginServer>>;
    /// The id of a server each time its connection is attached again.
    fn on_attach(&self) -> broadcast::Receiver<String>;
}

/// A forward of one callback port; closing it stops its ssh children.
#[async_trait]
pub(crate) trait Forward: Send + Sync {
    async fn close(&self);
}

#[async_trait]
pub(crate) trait CallbackForwarder: Send + Sync {
    /// Forwards 127.0.0.1:`port` on this PC to 127.0.0.1:`port` on the server; resolves once this PC listens there, fails
    /// when the port is taken here (a login of this PC's own may hold it).
    async fn open(&self, host: &SshHostRecord, port: u16) -> Result<Arc<dyn Forward>, String>;
}

struct PoolServer {
    pool: LinkPool,
    link: Arc<crate::link::ServerLink>,
}

#[async_trait]
impl LoginServer for PoolServer {
    fn model_login(&self) -> ModelLogin {
        self.link.model_login()
    }

    fn client(&self) -> Arc<dyn ProtocolClient> {
        self.link.client()
    }

    fn busy_sessions(&self) -> Option<u32> {
        let running = self.link.feed().sessions().borrow().iter().filter(|session| session.running).count();
        u32::try_from(running).ok()
    }

    async fn ended(&self) {
        let client = self.link.client();
        let mut events = client.events();
        let mut view = self.link.view();
        loop {
            let replaced = self.pool.get(self.link.id()).is_none_or(|current| !Arc::ptr_eq(&current, &self.link));
            if replaced || self.link.model_login() != ModelLogin::Server || matches!(client.status(), ConnectionStatus::Closed { .. }) {
                return;
            }
            tokio::select! {
                event = events.recv() => {
                    if matches!(event, Err(broadcast::error::RecvError::Closed)) {
                        return;
                    }
                }
                changed = view.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

struct PoolServers(LinkPool);

impl LoginServers for PoolServers {
    fn attached(&self, id: &str) -> Option<Arc<dyn LoginServer>> {
        let link = self.0.get(id)?;
        let connected = matches!(link.view().borrow().state, LinkState::Connected);
        connected.then(|| Arc::new(PoolServer { pool: self.0.clone(), link }) as Arc<dyn LoginServer>)
    }

    fn on_attach(&self) -> broadcast::Receiver<String> {
        self.0.on_attach()
    }
}

#[async_trait]
impl Forward for CallbackForward {
    async fn close(&self) {
        CallbackForward::close(self).await;
    }
}

struct SshForwarder(SshEnv);

#[async_trait]
impl CallbackForwarder for SshForwarder {
    async fn open(&self, host: &SshHostRecord, port: u16) -> Result<Arc<dyn Forward>, String> {
        let target = parse_ssh_target(&host.target).map_err(|error| error.0)?;
        let settings = host.settings.as_ref().map(|saved| HostSettings {
            identity_file: saved.identity_file.clone(),
            auto_reconnect: saved.auto_reconnect,
            ..HostSettings::default()
        });
        let context = AttemptContext { settings, diagnostics_key: Some(diagnostics_key_for(&target)), ..AttemptContext::default() };
        let forward = open_callback_forward(self.0.clone(), Some(context), target, port).await.map_err(|error| error.to_string())?;
        Ok(Arc::new(forward))
    }
}

/// What the logins read of this PC.
pub struct ServerLoginStores {
    pub hosts: Arc<SshHostStore>,
}

// ---------------------------------------------------------------------------------------------
// The server's words, read
// ---------------------------------------------------------------------------------------------

fn opt_text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn entries(value: Option<&Value>) -> Vec<&Map<String, Value>> {
    value.and_then(Value::as_array).map(|rows| rows.iter().filter_map(Value::as_object).collect()).unwrap_or_default()
}

fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// The port of an IPv4 loopback `http://localhost:<port>/...` redirect_uri in an authorization URL: the server's callback
/// listener for this login. An IPv6 `[::1]` redirect is refused (`None`): the forward is IPv4-only, so such a login completes by
/// pasting the redirected address.
pub fn callback_port_of(auth_url: Option<&str>) -> Option<u16> {
    let auth = Url::parse(auth_url?).ok()?;
    let raw = auth.query_pairs().find(|(name, _)| name == "redirect_uri").map(|(_, value)| value.into_owned()).filter(|value| !value.is_empty())?;
    let redirect = Url::parse(&raw).ok()?;
    if redirect.scheme() != "http" || !matches!(redirect.host_str(), Some("localhost" | "127.0.0.1")) {
        return None;
    }
    redirect.port().filter(|port| *port > 0)
}

fn login_rows(setup: &Value) -> Vec<SshServerLogin> {
    let row = |entry: &Map<String, Value>, kind: SshServerLoginKind| -> Option<SshServerLogin> {
        let id = opt_text(entry.get("id"))?;
        let api = kind == SshServerLoginKind::Api;
        let custom = is_true(entry.get("custom"));
        // Reported as the server states it; the actions follow `from_environment` alone.
        let credential_source = if api {
            match entry.get("credentialSource").and_then(Value::as_str) {
                Some("keychain") => Some(SshCredentialSource::Keychain),
                Some("private-file") => Some(SshCredentialSource::PrivateFile),
                Some("environment") => Some(SshCredentialSource::Environment),
                _ => None,
            }
        } else {
            None
        };
        // An environment key with nothing stored is read-only; a stored key can still be changed or logged out. A custom
        // provider with a key variable takes no key saved here.
        let from_environment =
            api && ((is_true(entry.get("env")) && !is_true(entry.get("stored"))) || (custom && opt_text(entry.get("apiKeyEnv")).is_some()));
        Some(SshServerLogin {
            name: opt_text(entry.get("name")).unwrap_or_else(|| id.clone()),
            id,
            kind,
            signed_in: is_true(entry.get("authenticated")),
            credential_source,
            from_environment: from_environment.then_some(true),
            stored_in_private_file: (api && entry.get("detail").and_then(Value::as_str) == Some("stored in private file")).then_some(true),
            custom: (api && custom).then_some(true),
            keyless: (api && custom && entry.get("auth").and_then(Value::as_str) == Some("none")).then_some(true),
            identity: None,
        })
    };
    let rows: Vec<SshServerLogin> = entries(setup.get("oauth"))
        .into_iter()
        .filter_map(|entry| row(entry, SshServerLoginKind::Oauth))
        .chain(entries(setup.get("api")).into_iter().filter_map(|entry| row(entry, SshServerLoginKind::Api)))
        .collect();
    // Signed-in logins first; each group keeps the server's order.
    let (signed_in, signed_out): (Vec<_>, Vec<_>) = rows.into_iter().partition(|entry| entry.signed_in);
    signed_in.into_iter().chain(signed_out).collect()
}

/// The server's credential-storage issue from its setup, reduced to plain bounded text; `None` without one.
fn keychain_issue_of(setup: &Value) -> Option<SshKeychainIssue> {
    let issue = setup.get("keychain")?;
    let bounded = |name: &str, max: usize| {
        opt_text(issue.get(name)).filter(|found| found.chars().count() <= max && !found.chars().any(|c| c.is_ascii_control()))
    };
    let state = bounded("state", 40)?;
    let message = bounded("message", 400)?;
    Some(SshKeychainIssue { state, kind: bounded("kind", 40), message, path: bounded("path", 1_024) })
}

/// The selected account of a server's subscription roster as it names itself (its email).
fn account_identity(roster: &Value) -> Option<String> {
    let accounts = entries(roster.get("accounts"));
    let account = accounts.iter().find(|entry| entry.get("id") == roster.get("selectedId")).or(accounts.first())?;
    opt_text(account.get("email")).or_else(|| opt_text(account.get("identity")))
}

/// The server's answer to a login start or status, with the provider's manual page beside the public flow.
struct Flow {
    public: SshServerLoginFlow,
    manual_url: Option<String>,
}

fn flow_of(value: &Value, forwarded: bool) -> LoginResult<Flow> {
    let flow_id = opt_text(value.get("flowId")).map_or_else(|| fail("The server did not start a login."), Ok)?;
    let state = match value.get("state") {
        None | Some(Value::Null | Value::Bool(false)) => SshServerLoginFlowState::Pending,
        Some(Value::String(text)) => match text.as_str() {
            "" | "pending" => SshServerLoginFlowState::Pending,
            "complete" => SshServerLoginFlowState::Complete,
            "cancelled" => SshServerLoginFlowState::Cancelled,
            "expired" => SshServerLoginFlowState::Expired,
            _ => SshServerLoginFlowState::Failed,
        },
        Some(_) => SshServerLoginFlowState::Failed,
    };
    let manual_url = opt_text(value.get("manualUrl"));
    Ok(Flow {
        public: SshServerLoginFlow {
            flow_id,
            provider: value.get("provider").and_then(Value::as_str).unwrap_or_default().to_owned(),
            state,
            url: opt_text(value.get("url")).or_else(|| manual_url.clone()),
            error: opt_text(value.get("error")),
            forwarded,
            user_code: opt_text(value.get("userCode")),
            manual_code_supported: value.get("manualCodeSupported").and_then(Value::as_bool),
            open_url: None,
        },
        manual_url,
    })
}

fn is_http_url(url: Option<&str>) -> bool {
    url.and_then(|url| Url::parse(url).ok()).is_some_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn text<'a>(value: &'a str, what: &str) -> LoginResult<&'a str> {
    if value.is_empty() { fail(format!("{what} must be a non-empty string.")) } else { Ok(value) }
}

fn provider_id(value: &str) -> LoginResult<&str> {
    let value = text(value, "provider")?;
    let mut chars = value.chars();
    let valid = value.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid { Ok(value) } else { fail("The provider id is not valid.") }
}

/// A custom provider's generated id: `custom-` and a lower-case UUID.
fn is_custom_provider(id: &str) -> bool {
    let Some(uuid) = id.strip_prefix("custom-") else { return false };
    let groups: Vec<&str> = uuid.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, len)| group.len() == len && group.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')))
}

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

type Key = (String, String);

/// A login pending on the server (forwarded or not), with the watch on the attachment that started it.
struct Pending {
    host_id: String,
    flow_id: String,
    provider: String,
    /// When the login started.
    started_at: Instant,
    /// The saved server's removal count when the login started: once the server is removed, no cancel for this login is kept.
    generation: u64,
    server: Arc<dyn LoginServer>,
    /// Stops the watch on the attachment.
    stop: CancellationToken,
}

/// A cancel the server has not taken yet; `started_at` tells which login it is for.
#[derive(Clone)]
struct Queued {
    host_id: String,
    flow_id: String,
    started_at: Instant,
}

struct OpenForward {
    forward: Arc<dyn Forward>,
    /// Stops the time cap.
    stop: CancellationToken,
}

#[derive(Default)]
struct State {
    /// The callback forward of a pending login: no longer than the login, the cap and the attachment that started it.
    forwards: HashMap<Key, OpenForward>,
    pending: HashMap<Key, Arc<Pending>>,
    /// Cancels to send once their server is reachable again, oldest first: kept only for the server's flow lifetime, at most
    /// `MAX_QUEUED_CANCELS` of them.
    queued: Vec<(Key, Queued)>,
    /// Queued cancels being sent now, so two attaches never send one twice.
    replaying: HashSet<Key>,
    /// Host id -> how many times that saved server was removed: a cancel still in flight when its server is removed (or this
    /// service closed) must not queue itself afterwards.
    removals: HashMap<String, u64>,
    disposed: bool,
}

struct Inner {
    servers: Arc<dyn LoginServers>,
    hosts: Arc<SshHostStore>,
    forwarder: Arc<dyn CallbackForwarder>,
    state: Mutex<State>,
    updates: broadcast::Sender<(String, SshServerLoginFlow)>,
}

pub struct ServerLogins {
    inner: Arc<Inner>,
    attach_task: JoinHandle<()>,
}

impl Drop for ServerLogins {
    fn drop(&mut self) {
        self.attach_task.abort();
    }
}

impl ServerLogins {
    pub fn new(pool: LinkPool, stores: ServerLoginStores, env: SshEnv) -> Self {
        Self::with_parts(Arc::new(PoolServers(pool)), stores.hosts, Arc::new(SshForwarder(env)))
    }

    pub(crate) fn with_parts(servers: Arc<dyn LoginServers>, hosts: Arc<SshHostStore>, forwarder: Arc<dyn CallbackForwarder>) -> Self {
        let (updates, _) = broadcast::channel(UPDATE_CAPACITY);
        let inner = Arc::new(Inner { servers, hosts, forwarder, state: Mutex::new(State::default()), updates });
        // Subscribed before the task runs, so no attach after this call is missed.
        let mut attached = inner.servers.on_attach();
        let replay = inner.clone();
        let attach_task = mixdog_rt::spawn("server-login-replay", TaskClass::Control, async move {
            loop {
                match attached.recv().await {
                    Ok(host_id) => replay.flush_queued_cancels(&host_id).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
        Self { inner, attach_task }
    }

    /// Each flow that ended on this PC's side without the user finishing it (its attachment went), with the saved server's id.
    pub fn updates(&self) -> broadcast::Receiver<(String, SshServerLoginFlow)> {
        self.inner.updates.subscribe()
    }

    /// The server's logins as the settings dialog shows them.
    pub async fn list(&self, id: &str) -> LoginResult<SshServerLogins> {
        let host = self.inner.saved_host(id)?;
        let Some(server) = self.inner.servers.attached(&host.id) else {
            return Ok(SshServerLogins { connected: false, model_login: None, busy_sessions: None, providers: None, keychain: None });
        };
        let busy_sessions = server.busy_sessions();
        if server.model_login() != ModelLogin::Server {
            return Ok(SshServerLogins {
                connected: true,
                model_login: Some(SshModelLogin::Pc),
                busy_sessions,
                providers: None,
                keychain: None,
            });
        }
        let client = server.client();
        client.call_raw("account/refreshProviderSetup", json!({ "force": true }), CallOptions::default()).await.map_err(|e| call_failed(&e))?;
        let setup = client.store().section(SectionName::ProviderSetup, None).map_or(Value::Null, |entry| entry.value);
        let mut providers = login_rows(&setup);
        for row in providers.iter_mut().filter(|row| row.kind == SshServerLoginKind::Oauth && row.signed_in) {
            let roster = client.store().section(SectionName::ProviderAccounts, Some(&row.id));
            row.identity = roster.and_then(|entry| account_identity(&entry.value));
        }
        Ok(SshServerLogins {
            connected: true,
            model_login: Some(SshModelLogin::Server),
            busy_sessions,
            providers: Some(providers),
            keychain: keychain_issue_of(&setup),
        })
    }

    /// Starts a subscription login on the server. `open_url` is the address to open in this PC's browser: the provider's
    /// own page when the callback port is forwarded, its manual page (it shows a code to paste) when it is not.
    pub async fn begin(&self, id: &str, provider: &str) -> LoginResult<SshServerLoginFlow> {
        let inner = &self.inner;
        let (host, server) = inner.server_connection(id)?;
        let provider = provider_id(provider)?;
        // The server never opens a browser of its own: this PC's does.
        let params = json!({ "providerId": provider, "options": { "openBrowser": false } });
        let started = flow_of(&call(&*server, "account/beginOAuthProviderLogin", params).await?, false)?;
        let flow_id = started.public.flow_id.clone();
        let key: Key = (host.id.clone(), flow_id.clone());
        let pending = started.public.state == SshServerLoginFlowState::Pending;
        let port = if pending { callback_port_of(started.public.url.as_deref()) } else { None };
        // A disconnect, a quit or a changed model login ends the login on this PC: its forward closes and the server is told
        // to drop it.
        let mut own = None;
        if pending {
            let login = {
                let mut state = locked(&inner.state);
                let login = Arc::new(Pending {
                    host_id: host.id.clone(),
                    flow_id: flow_id.clone(),
                    provider: started.public.provider.clone(),
                    started_at: Instant::now(),
                    generation: state.removals.get(&host.id).copied().unwrap_or(0),
                    server: server.clone(),
                    stop: CancellationToken::new(),
                });
                // A cancel queued for an older login that had this id is stale now.
                state.queued.retain(|(queued, _)| *queued != key);
                state.pending.insert(key.clone(), login.clone());
                login
            };
            inner.watch(key.clone(), login.clone());
            own = Some(login);
        }
        let mut forward = None;
        if let Some(port) = port {
            // The port is taken here or ssh refused the forward: the pasted redirect address completes the login instead.
            forward = inner.forwarder.open(&host, port).await.ok();
        }
        // The login ended while the forward was being made (a disconnect, a quit): that forward is closed at once.
        if let Some(login) = &own {
            if !locked(&inner.state).pending.get(&key).is_some_and(|current| Arc::ptr_eq(current, login)) {
                if let Some(forward) = forward {
                    forward.close().await;
                }
                return Ok(SshServerLoginFlow { state: SshServerLoginFlowState::Cancelled, url: None, forwarded: false, ..started.public });
            }
        }
        let forwarded = forward.is_some();
        if let Some(forward) = forward {
            inner.keep_forward(key, forward);
        }
        // Without the forward the browser cannot reach the server's listener: a provider's manual page (it shows a code to
        // paste) serves better.
        let opened = if forwarded { started.public.url.clone() } else { started.manual_url.clone().or_else(|| started.public.url.clone()) };
        let open_url = is_http_url(opened.as_deref()).then(|| opened.clone()).flatten();
        Ok(SshServerLoginFlow { url: opened, forwarded, open_url, ..started.public })
    }

    /// The login's state on the server; a login that ended no longer needs its forward. A status nobody can read (the server
    /// went, the call failed) ends the dialog's polling: the forward goes with it, and the server is told to drop the login.
    pub async fn status(&self, id: &str, flow_id: &str) -> LoginResult<SshServerLoginFlow> {
        let inner = &self.inner;
        let key = inner.flow_key(id, flow_id)?;
        let read = async {
            let (_, server) = inner.server_connection(id)?;
            let value = call(&*server, "account/getOAuthProviderLoginStatus", json!({ "flowId": flow_id })).await?;
            inner.settle(&key, &value).await
        };
        match read.await {
            Ok(flow) => Ok(flow),
            Err(error) => {
                let login = inner.forget_login(&key);
                inner.close_forward(&key).await;
                if let Some(login) = login {
                    // Not awaited: the error must not wait for a dead link.
                    let inner = inner.clone();
                    drop(mixdog_rt::spawn("server-login-cancel", TaskClass::Control, async move {
                        inner.cancel_or_queue(&login, None).await;
                    }));
                }
                Err(error)
            }
        }
    }

    /// Completes a login with the redirected address the user pasted.
    pub async fn complete(&self, id: &str, flow_id: &str, redirect_url: &str) -> LoginResult<SshServerLoginFlow> {
        let inner = &self.inner;
        let (host, server) = inner.server_connection(id)?;
        let flow = text(flow_id, "flowId")?;
        let pasted = text(redirect_url, "redirectUrl")?.trim();
        if pasted.is_empty() || pasted.encode_utf16().count() > MAX_URL_LENGTH || pasted.chars().any(|c| c.is_ascii_control()) {
            return fail("The pasted address is not valid.");
        }
        let value = call(&*server, "account/completeOAuthProviderLogin", json!({ "flowId": flow, "callbackUrl": pasted })).await?;
        inner.settle(&(host.id, flow.to_owned()), &value).await
    }

    /// Ends a login: the forward closes at once, whatever the server answers or when; the cancel is bounded and kept for the
    /// next attach when the server did not take it.
    pub async fn cancel(&self, id: &str, flow_id: &str) -> LoginResult<()> {
        let inner = &self.inner;
        let host = inner.saved_host(id)?;
        let flow = text(flow_id, "flowId")?;
        let key: Key = (host.id.clone(), flow.to_owned());
        let pending = inner.forget_login(&key);
        let closing = inner.close_forward(&key);
        let on_server = async {
            let server = inner.servers.attached(&host.id);
            match (server, pending) {
                (Some(server), pending) if server.model_login() == ModelLogin::Server => match pending {
                    Some(login) => inner.cancel_or_queue(&login, Some(&server)).await,
                    None => {
                        inner.cancel_on_server(&*server, flow).await;
                    }
                },
                // Not attached: the dialog's last read failed, and the server still holds it.
                (None, Some(login)) => inner.queue_cancel(&login),
                _ => {}
            }
        };
        tokio::join!(closing, on_server);
        Ok(())
    }

    /// Saves an API key on the server. A custom provider's key is replaced on its own, so the provider's other settings are
    /// never rewritten from a stale read. A failure never carries the key.
    pub async fn save_key(&self, id: &str, provider: &str, key: &str) -> LoginResult<()> {
        let (_, server) = self.inner.server_connection(id)?;
        let secret = text(key, "key")?.trim();
        if secret.is_empty() || secret.encode_utf16().count() > MAX_KEY_LENGTH || secret.chars().any(|c| c.is_ascii_control()) {
            return fail("The API key is not valid.");
        }
        let provider = provider_id(provider)?;
        let method = if is_custom_provider(provider) { "account/saveCustomProviderKey" } else { "account/saveProviderApiKey" };
        call(&*server, method, json!({ "providerId": provider, "secret": secret }))
            .await
            .map(|_| ())
            .map_err(|error| LoginError(redact_secrets(&error.0, &[secret])))
    }

    pub async fn logout(&self, id: &str, provider: &str) -> LoginResult<()> {
        let (_, server) = self.inner.server_connection(id)?;
        call(&*server, "account/forgetProviderAuth", json!({ "providerId": provider_id(provider)? })).await.map(|_| ())
    }

    /// Deletes a custom provider (and its models) on the server: only the explicit Delete asks for it.
    pub async fn remove_custom(&self, id: &str, provider: &str) -> LoginResult<()> {
        let (_, server) = self.inner.server_connection(id)?;
        let provider = provider_id(provider)?;
        if !is_custom_provider(provider) {
            return fail("The provider id is not valid.");
        }
        call(&*server, "account/removeCustomProvider", json!({ "providerId": provider })).await.map(|_| ())
    }

    /// A saved server was removed: the cancels still waiting for it are dropped.
    pub fn forget_host(&self, id: &str) {
        let mut state = locked(&self.inner.state);
        *state.removals.entry(id.to_owned()).or_insert(0) += 1;
        state.queued.retain(|(_, queued)| queued.host_id != id);
    }

    /// Closes every callback forward still open and cancels the logins pending.
    pub async fn dispose(&self) {
        let keys: HashSet<Key> = {
            let mut state = locked(&self.inner.state);
            state.disposed = true;
            state.pending.keys().chain(state.forwards.keys()).cloned().collect()
        };
        self.attach_task.abort();
        let mut ending = tokio::task::JoinSet::new();
        for key in keys {
            let inner = self.inner.clone();
            ending.spawn(async move { inner.end_login(&key, None).await });
        }
        while ending.join_next().await.is_some() {}
        // Nothing is left to attach to: what could not be sent is dropped.
        locked(&self.inner.state).queued.clear();
    }
}

async fn call(server: &dyn LoginServer, method: &str, params: Value) -> LoginResult<Value> {
    server.client().call_raw(method, params, CallOptions::default()).await.map_err(|error| call_failed(&error))
}

impl Inner {
    fn flow_key(&self, id: &str, flow_id: &str) -> LoginResult<Key> {
        Ok((text(id, "id")?.to_owned(), text(flow_id, "flowId")?.to_owned()))
    }

    fn saved_host(&self, id: &str) -> LoginResult<SshHostRecord> {
        self.hosts.get(text(id, "id")?).map_or_else(|| fail("This SSH server is no longer saved."), Ok)
    }

    /// The attached server, running models with its own logins: the only place any of these calls may go.
    fn server_connection(&self, id: &str) -> LoginResult<(SshHostRecord, Arc<dyn LoginServer>)> {
        let host = self.saved_host(id)?;
        let Some(server) = self.servers.attached(&host.id) else {
            return fail(format!("Connect to {} to manage its logins.", host.name));
        };
        if server.model_login() != ModelLogin::Server {
            return fail(format!("{} uses this PC's accounts. Switch it to server accounts to manage its logins.", host.name));
        }
        Ok((host, server))
    }

    /// A status answer: a login that ended no longer needs its forward.
    async fn settle(&self, key: &Key, value: &Value) -> LoginResult<SshServerLoginFlow> {
        let forwarded = locked(&self.state).forwards.contains_key(key);
        let mut flow = flow_of(value, forwarded)?.public;
        if flow.state != SshServerLoginFlowState::Pending {
            self.forget_login(key);
            self.close_forward(key).await;
            flow.forwarded = false;
        }
        Ok(flow)
    }

    fn keep_forward(self: &Arc<Self>, key: Key, forward: Arc<dyn Forward>) {
        let stop = CancellationToken::new();
        locked(&self.state).forwards.insert(key.clone(), OpenForward { forward, stop: stop.clone() });
        let inner = self.clone();
        drop(mixdog_rt::spawn("server-login-forward-cap", TaskClass::Control, async move {
            tokio::select! {
                () = stop.cancelled() => {}
                () = sleep(MAX_FORWARD) => inner.close_forward(&key).await,
            }
        }));
    }

    async fn close_forward(&self, key: &Key) {
        let open = locked(&self.state).forwards.remove(key);
        if let Some(open) = open {
            open.stop.cancel();
            open.forward.close().await;
        }
    }

    /// The login is over on the server too (or being cancelled separately).
    fn forget_login(&self, key: &Key) -> Option<Arc<Pending>> {
        let login = locked(&self.state).pending.remove(key)?;
        login.stop.cancel();
        Some(login)
    }

    /// Ends the login on this PC's side when its attachment ends.
    fn watch(self: &Arc<Self>, key: Key, login: Arc<Pending>) {
        let inner = self.clone();
        drop(mixdog_rt::spawn("server-login-watch", TaskClass::Control, async move {
            tokio::select! {
                () = login.stop.cancelled() => {}
                () = login.server.ended() => {
                    let ended = inner.end_login(&key, Some(&login)).await;
                    if ended {
                        let flow = SshServerLoginFlow {
                            flow_id: login.flow_id.clone(),
                            provider: login.provider.clone(),
                            state: SshServerLoginFlowState::Cancelled,
                            url: None,
                            error: None,
                            forwarded: false,
                            user_code: None,
                            manual_code_supported: None,
                            open_url: None,
                        };
                        let _ = inner.updates.send((login.host_id.clone(), flow));
                    }
                }
            }
        }));
    }

    fn prune_queued(state: &mut State) {
        state.queued.retain(|(_, queued)| queued.started_at.elapsed() < SERVER_FLOW_LIFETIME);
    }

    fn queue_cancel(&self, login: &Pending) {
        let mut state = locked(&self.state);
        if state.disposed || login.generation != state.removals.get(&login.host_id).copied().unwrap_or(0) {
            return;
        }
        Self::prune_queued(&mut state);
        if login.started_at.elapsed() >= SERVER_FLOW_LIFETIME {
            return;
        }
        let key: Key = (login.host_id.clone(), login.flow_id.clone());
        state.queued.retain(|(queued, _)| *queued != key);
        state.queued.push((key, Queued { host_id: login.host_id.clone(), flow_id: login.flow_id.clone(), started_at: login.started_at }));
        let over = state.queued.len().saturating_sub(MAX_QUEUED_CANCELS);
        state.queued = state.queued.split_off(over);
    }

    /// True when the server took the cancel (a flow it no longer knows is refused: false).
    async fn cancel_on_server(&self, server: &dyn LoginServer, flow_id: &str) -> bool {
        let sent = call(server, "account/cancelOAuthProviderLogin", json!({ "flowId": flow_id }));
        matches!(timeout(CANCEL_TIMEOUT, sent).await, Ok(Ok(_)))
    }

    /// The PC side of a pending login ends without the user finishing it: the server drops its listener, now when it can be
    /// reached, else once it can.
    async fn cancel_or_queue(&self, login: &Pending, server: Option<&Arc<dyn LoginServer>>) {
        let server = server.unwrap_or(&login.server);
        if !self.cancel_on_server(&**server, &login.flow_id).await {
            self.queue_cancel(login);
        }
    }

    /// Ends a login (`only`: that very login, not a later one reusing its id); true when a login was ended.
    async fn end_login(&self, key: &Key, only: Option<&Arc<Pending>>) -> bool {
        if let Some(only) = only {
            if !locked(&self.state).pending.get(key).is_some_and(|current| Arc::ptr_eq(current, only)) {
                return false;
            }
        }
        let login = self.forget_login(key);
        self.close_forward(key).await;
        match login {
            Some(login) => {
                self.cancel_or_queue(&login, None).await;
                true
            }
            None => false,
        }
    }

    /// Sends the cancels queued for a server that is reachable again. One the server did not take stays for the next attach
    /// until it expires.
    async fn flush_queued_cancels(self: &Arc<Self>, host_id: &str) {
        let Some(server) = self.servers.attached(host_id) else { return };
        let due: Vec<(Key, Queued)> = {
            let mut state = locked(&self.state);
            Self::prune_queued(&mut state);
            state.queued.iter().filter(|(_, queued)| queued.host_id == host_id).cloned().collect()
        };
        let mut sending = tokio::task::JoinSet::new();
        for (key, queued) in due {
            let (inner, server) = (self.clone(), server.clone());
            sending.spawn(async move {
                {
                    let mut state = locked(&inner.state);
                    // A server back on this PC's logins runs no login of its own; a live login that owns the id now is a newer
                    // one, which a stale cancel must never end.
                    if server.model_login() != ModelLogin::Server || state.pending.contains_key(&key) {
                        state.queued.retain(|(held, _)| *held != key);
                        return;
                    }
                    if !state.replaying.insert(key.clone()) {
                        return;
                    }
                }
                let taken = inner.cancel_on_server(&*server, &queued.flow_id).await;
                let mut state = locked(&inner.state);
                if taken {
                    // Only the entry that was sent: a newer entry of the same id stays.
                    state.queued.retain(|(held, entry)| !(*held == key && entry.started_at == queued.started_at));
                }
                state.replaying.remove(&key);
            });
        }
        while sending.join_next().await.is_some() {}
    }
}

#[cfg(test)]
#[path = "server_logins_tests.rs"]
mod tests;
