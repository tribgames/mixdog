//! The session store a terminal UI drives: the facade over `mixdog-app-server-client` that the Node terminal UI's session store was.
//!
//! - It opens a session (`thread/start`, or `thread/resume` of a stored one) and follows its feed with the session fold as the thread
//!   reducer (`connect`); `state()` is the projection the UI reads (`tests/fixtures/tui-state-fields.json`), published at most once
//!   per terminal frame: the app calls [`SessionStore::tick`] once per frame and a changed state is then published
//!   (`frame-batched-store.mjs`).
//! - `subscribe()` yields the [`StoreEvent`]s: the published state, the notices and toasts, the connection status, the setup
//!   tool's UI-open requests and a prompt handed back to the composer.
//! - `call(action, args)` is a session action (`action_route`, then `targets` for the actions with no router row); `intake` is the
//!   prompt surface (submit, steer, abort, restoreQueued, tool approvals), `oauth` the provider and MCP sign-in flows.
//! - A reconnect is invisible except through the connection status: the client library restores the subscription and the fold
//!   resumes from where it was.

mod feed;
mod intake;
mod oauth;
mod targets;

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_app_server_client::APP_FEED_ID;
use mixdog_app_server_client::CallOptions;
use mixdog_app_server_client::ClientError;
use mixdog_app_server_client::ClientEvent;
use mixdog_app_server_client::ConnectionStatus;
use mixdog_app_server_client::ProtocolClient;
use mixdog_app_server_client::ResumeWindow;
use mixdog_app_server_client::SectionName;
use mixdog_app_server_client::StoreChange;
use mixdog_app_server_client::ThreadId;
use serde_json::Value;
use serde_json::json;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

pub use self::feed::StoreFeed;
pub use self::intake::Submitted;
pub use self::intake::TurnStart;
pub use self::oauth::OAUTH_FLOW_TTL;
pub use self::oauth::OAUTH_POLL;
pub use self::oauth::OAuthKind;
use self::targets::Target;
use self::targets::target_of;
use crate::action_route::Resolved;
use crate::action_route::RouteContext;
use crate::action_route::RouteError;
use crate::action_route::resolve_action;
use crate::state::desktop_session_state;

/// How long `dispose` waits for the session to unsubscribe and the connection to close (`EXIT_WAIT_TIMEOUT_MS` of the Node UI).
pub const EXIT_WAIT: Duration = Duration::from_millis(2500);
/// The items of the transcript a session is attached with (the protocol's own bound, `ResumeWindow::LastItems`).
const RESUME_ITEMS: u16 = 512;
/// How long a session's first state may take to arrive after the core took the subscription.
const FIRST_STATE_WAIT: Duration = Duration::from_secs(30);
/// How long a read of a published section waits for the core to publish it.
const SECTION_WAIT: Duration = Duration::from_secs(15);
/// Events a slow subscriber may fall behind by; the state itself is always read with `state()`.
const EVENT_CAPACITY: usize = 256;

/// How the session is opened: the options the Node UI gave its `createSession`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StoreOptions {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tool_mode: Option<String>,
    /// The core is another machine's (reached through a tunnel or the relay): `isRemoteSession`.
    pub remote: bool,
    /// The worktree request (`{ mode: 'default' }`, a name, ...): the draft's `worktree`.
    pub worktree: Option<Value>,
    pub cwd: Option<String>,
    /// A stored session to resume (`/resume`, `--resume`): `thread/resume` instead of `thread/start`.
    pub resume: Option<String>,
}

/// The connection as a UI shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Ready,
    /// The socket closed; `attempt` counts the ladder's rounds since the last connection.
    Reconnecting { attempt: u32 },
    /// Terminal: the store was disposed or the core refused the version.
    Closed { reason: String },
}

/// What a store tells its subscribers.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreEvent {
    /// A state was published (at most one per [`SessionStore::tick`]).
    State(Arc<Value>),
    /// A message for the transcript or the notice line; `level` is `info`, `warn` or `error` (Node's tone).
    Notice { text: String, level: String },
    /// A toast that appeared in the state's `toasts` (the core owns its lifetime).
    Toast(Value),
    ConnectionStatus(ConnectionState),
    /// The setup tool asks this UI to run a settings command: `command` without its slash, `seq` rising with every request.
    UiOpenRequest { command: String, seq: u64 },
    /// A prompt handed back to this composer (`promptRestore` of the state, once per id).
    PromptRestore(Value),
    /// The core stopped following the session for this connection (its subscription could not be restored).
    SessionLost { reason: String },
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum StoreError {
    #[error("the session store has no session")]
    NoSession,
    #[error(transparent)]
    Route(#[from] RouteError),
    #[error(transparent)]
    Client(#[from] ClientError),
    #[error("{0}")]
    Protocol(String),
    #[error("the session's first state did not arrive")]
    FirstState,
    #[error("the {0} section is unavailable")]
    SectionUnavailable(String),
}

/// What the subscribers have heard of the published states, so each toast and restore is told once.
#[derive(Default)]
struct Heard {
    toasts: HashSet<String>,
    restore: Option<String>,
}

struct Inner {
    client: Arc<dyn ProtocolClient>,
    feed: Arc<StoreFeed>,
    options: StoreOptions,
    thread: Mutex<Option<String>>,
    published: Mutex<Arc<Value>>,
    dirty: AtomicBool,
    heard: Mutex<Heard>,
    oauth_flows: Mutex<Vec<(OAuthKind, String)>>,
    submissions: AtomicU64,
    disposed: AtomicBool,
}

/// A poisoned lock still holds consistent data here: every guarded value is replaced whole.
fn held<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Inner {
    fn emit(&self, event: StoreEvent) {
        self.feed.emit(event);
    }

    fn notice(&self, level: &str, text: String) {
        self.emit(StoreEvent::Notice { text, level: level.to_owned() });
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
    }

    fn thread_id(&self) -> Option<String> {
        held(&self.thread).clone()
    }

    fn is_bound(&self, thread_id: &str) -> bool {
        held(&self.thread).as_deref() == Some(thread_id)
    }

    /// The state of the bound thread's fold with the pending server requests and the host's shell jobs joined in; `None` before the
    /// thread's first snapshot has been folded.
    fn project(&self) -> Option<Value> {
        let id = self.thread_id()?;
        let store = self.client.store();
        let fold = store.thread(&id)?;
        let jobs = store.section(SectionName::HostShellJobs, None).map(|entry| entry.value).filter(|value| !value.is_null());
        Some(desktop_session_state(&fold, &self.client.pending_server_requests(), jobs.as_ref()))
    }

    /// Publishes the changed state once: what a tick is.
    fn publish(&self) -> bool {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return false;
        }
        let Some(state) = self.project() else {
            // The snapshot is not folded yet: the next change or tick publishes.
            self.mark_dirty();
            return false;
        };
        let state = Arc::new(state);
        let heard = self.hear(&state);
        *held(&self.published) = Arc::clone(&state);
        self.emit(StoreEvent::State(state));
        for event in heard {
            self.emit(event);
        }
        true
    }

    /// The toasts and the prompt restore the published state shows that the subscribers have not heard of.
    fn hear(&self, state: &Value) -> Vec<StoreEvent> {
        let mut heard = held(&self.heard);
        let mut out = Vec::new();
        let toasts = state["toasts"].as_array().map(Vec::as_slice).unwrap_or_default();
        let mut ids = HashSet::new();
        for toast in toasts {
            let id = toast["id"].to_string();
            if !heard.toasts.contains(&id) {
                out.push(StoreEvent::Toast(toast.clone()));
            }
            ids.insert(id);
        }
        heard.toasts = ids;
        match state["promptRestore"].as_object() {
            Some(restore) => {
                let id = restore.get("id").map(Value::to_string).unwrap_or_default();
                if heard.restore.as_deref() != Some(id.as_str()) {
                    out.push(StoreEvent::PromptRestore(state["promptRestore"].clone()));
                    heard.restore = Some(id);
                }
            }
            None => heard.restore = None,
        }
        out
    }

    fn on_client_event(&self, event: ClientEvent) {
        match event {
            ClientEvent::Status(status) => {
                self.emit(StoreEvent::ConnectionStatus(match status {
                    ConnectionStatus::Ready { .. } => ConnectionState::Ready,
                    ConnectionStatus::Reconnecting { attempt } => ConnectionState::Reconnecting { attempt },
                    ConnectionStatus::Closed { reason } => ConnectionState::Closed { reason: reason.to_string() },
                }));
                self.mark_dirty();
            }
            ClientEvent::ServerRequest(_) | ClientEvent::ServerRequestResolved(_) => self.mark_dirty(),
            ClientEvent::SubscriptionLost { thread_id, error } => {
                if self.is_bound(&thread_id) {
                    self.emit(StoreEvent::SessionLost { reason: error.to_string() });
                    self.notice("error", format!("the session is no longer followed: {error}"));
                } else if thread_id == APP_FEED_ID {
                    self.notice("warn", format!("the app feed is no longer followed: {error}"));
                }
            }
            ClientEvent::BlobUnavailable { error, .. } => self.notice("warn", format!("a stored text could not be read: {error}")),
            ClientEvent::ProtocolViolation(message) => self.notice("warn", format!("the core broke the protocol ({message}); reconnecting")),
            ClientEvent::Notification(_) => {}
        }
    }

    /// Cancels the sign-in flows still pending (`oauthFlows.cancelAll`).
    async fn cancel_oauth_flows(&self) {
        let flows: Vec<(OAuthKind, String)> = std::mem::take(&mut *held(&self.oauth_flows));
        for (kind, flow_id) in flows {
            let _ = self.client.call_raw(kind.cancel_method(), json!({ "flowId": flow_id }), CallOptions::default()).await;
        }
    }
}

/// Follows the client's folds and events until either ends.
async fn pump(inner: Arc<Inner>, mut changes: broadcast::Receiver<StoreChange>, mut events: broadcast::Receiver<ClientEvent>) {
    loop {
        tokio::select! {
            change = changes.recv() => match change {
                Ok(StoreChange::Thread { thread_id }) => {
                    if inner.is_bound(&thread_id) {
                        inner.mark_dirty();
                    }
                }
                Ok(StoreChange::Section { section, .. }) => {
                    if section == SectionName::HostShellJobs {
                        inner.mark_dirty();
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => inner.mark_dirty(),
                Err(broadcast::error::RecvError::Closed) => break,
            },
            event = events.recv() => match event {
                Ok(event) => inner.on_client_event(event),
                Err(broadcast::error::RecvError::Lagged(_)) => inner.mark_dirty(),
                Err(broadcast::error::RecvError::Closed) => break,
            },
        }
    }
}

pub struct SessionStore {
    inner: Arc<Inner>,
    pump: Mutex<Option<JoinHandle<()>>>,
}

impl SessionStore {
    /// The events' channel and thread reducer a client is connected with (`connect::connect_with` makes both).
    pub fn new_feed() -> Arc<StoreFeed> {
        StoreFeed::new(EVENT_CAPACITY)
    }

    /// Connects to the running core and opens the session.
    pub async fn connect(options: StoreOptions) -> Result<Self, StoreError> {
        crate::connect::connect_core(options).await
    }

    /// Opens the session `options` describe on a connected `client` whose thread reducer is `feed`'s.
    pub async fn open(client: Arc<dyn ProtocolClient>, feed: Arc<StoreFeed>, options: StoreOptions) -> Result<Self, StoreError> {
        let inner = Arc::new(Inner {
            client,
            feed,
            options,
            thread: Mutex::new(None),
            published: Mutex::new(Arc::new(json!({}))),
            dirty: AtomicBool::new(false),
            heard: Mutex::new(Heard::default()),
            oauth_flows: Mutex::new(Vec::new()),
            submissions: AtomicU64::new(0),
            disposed: AtomicBool::new(false),
        });
        let changes = inner.client.store().subscribe();
        let first = inner.client.store().subscribe();
        let events = inner.client.events();
        let pump = tokio::spawn(pump(Arc::clone(&inner), changes, events));
        let store = Self { inner, pump: Mutex::new(Some(pump)) };
        if let Err(error) = store.begin(first).await {
            store.inner.client.close().await;
            return Err(error);
        }
        Ok(store)
    }

    async fn begin(&self, mut folds: broadcast::Receiver<StoreChange>) -> Result<(), StoreError> {
        // The host's shell jobs ride the app feed: a core without it still serves the session.
        if let Err(error) = self.inner.client.subscribe_app().await {
            self.inner.notice("warn", format!("the app feed is not followed: {error}"));
        }
        let id = match self.inner.options.resume.clone() {
            Some(id) => id,
            None => self.start_thread().await?,
        };
        self.attach(&id).await?;
        self.wait_first_state(&id, &mut folds).await?;
        self.inner.mark_dirty();
        self.inner.publish();
        Ok(())
    }

    /// `thread/start` with the Node `createSession` options; the new thread's id.
    async fn start_thread(&self) -> Result<String, StoreError> {
        let options = &self.inner.options;
        let result = self.inner.client.call_raw("thread/start", start_params(options), CallOptions::default()).await?;
        let id = result["thread"]["id"].as_str().ok_or_else(|| StoreError::Protocol("thread/start answered without a thread id".to_owned()))?.to_owned();
        if let Some(route) = partial_route(options) {
            // A model without its provider (or the reverse) is the core's to resolve: it is applied once the thread exists, and a
            // refusal is a notice rather than a session that did not open.
            *held(&self.inner.thread) = Some(id.clone());
            if let Err(error) = self.call("setRoute", &[route]).await {
                self.inner.notice("warn", format!("the model route was not applied: {error}"));
            }
        }
        Ok(id)
    }

    /// Follows the thread `id` (`thread/resume`): its snapshot and notifications fold from here on.
    async fn attach(&self, id: &str) -> Result<(), StoreError> {
        *held(&self.inner.thread) = Some(id.to_owned());
        *held(&self.inner.heard) = Heard::default();
        self.inner.client.resume_thread(&ThreadId::from(id), ResumeWindow::LastItems { last_items: RESUME_ITEMS }).await?;
        self.inner.mark_dirty();
        Ok(())
    }

    async fn wait_first_state(&self, id: &str, folds: &mut broadcast::Receiver<StoreChange>) -> Result<(), StoreError> {
        let waiting = async {
            while self.inner.client.store().thread(id).is_none() {
                match folds.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return false,
                }
            }
            true
        };
        match mixdog_rt::time::timeout(FIRST_STATE_WAIT, waiting).await {
            Ok(true) => Ok(()),
            _ => Err(StoreError::FirstState),
        }
    }

    /// Moves this store to another stored session (`/resume`): the old one stops being followed (its work goes on in the core).
    pub async fn resume_session(&self, thread_id: &str) -> Result<(), StoreError> {
        let mut folds = self.inner.client.store().subscribe();
        let previous = self.inner.thread_id();
        self.attach(thread_id).await?;
        self.wait_first_state(thread_id, &mut folds).await?;
        if let Some(previous) = previous.filter(|previous| previous != thread_id) {
            // Never stops work (X10): the old thread only stops being followed.
            let _ = self.inner.client.unsubscribe_thread(&ThreadId::from(previous.as_str())).await;
        }
        self.inner.mark_dirty();
        self.inner.publish();
        Ok(())
    }

    /// The id of the session this store is bound to.
    pub fn thread_id(&self) -> Option<String> {
        self.inner.thread_id()
    }

    /// `isRemoteSession`.
    pub fn is_remote_session(&self) -> bool {
        self.inner.options.remote
    }

    /// The last published state.
    pub fn state(&self) -> Arc<Value> {
        Arc::clone(&held(&self.inner.published))
    }

    /// One terminal frame: publishes the state if anything changed since the last one. The app calls it once per frame (and may call
    /// it at once for an input echo or a turn boundary); returns whether a state was published.
    pub fn tick(&self) -> bool {
        !self.inner.disposed.load(Ordering::Acquire) && self.inner.publish()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<StoreEvent> {
        self.inner.feed.subscribe()
    }

    /// The protocol request a session action is for the session this store is bound to.
    pub fn route(&self, action: &str, args: &[Value]) -> Result<Resolved, RouteError> {
        let thread = self.inner.thread_id();
        resolve_action(action, args, &RouteContext { thread_id: thread.as_deref() })
    }

    /// Calls a session action: the router's request, or the target of an action it has no row for (a method, or a published section).
    pub async fn call(&self, action: &str, args: &[Value]) -> Result<Value, StoreError> {
        match self.route(action, args) {
            Ok(resolved) => self.send(resolved).await,
            Err(route_error) => {
                let thread = self.inner.thread_id();
                let fast_on = held(&self.inner.published).get("fast") == Some(&Value::Bool(true));
                match target_of(action, args, thread.as_deref(), fast_on) {
                    Some(Target::Method(resolved)) => self.send(resolved).await,
                    Some(Target::Section { section, key, refresh }) => {
                        if let Some(refresh) = refresh {
                            self.send(Resolved { method: "account/refreshProviderSetup".to_owned(), params: refresh }).await?;
                        }
                        self.read_section(section, key.as_deref()).await
                    }
                    None => Err(route_error.into()),
                }
            }
        }
    }

    async fn send(&self, request: Resolved) -> Result<Value, StoreError> {
        Ok(self.inner.client.call_raw(&request.method, request.params, CallOptions::default()).await?)
    }

    /// The value of a published section entry, waiting for the core to publish it (`readProtocolSection`).
    pub async fn read_section(&self, section: &str, key: Option<&str>) -> Result<Value, StoreError> {
        let name: SectionName = serde_json::from_value(json!(section)).map_err(|_| StoreError::SectionUnavailable(section.to_owned()))?;
        let store = self.inner.client.store();
        let mut changes = store.subscribe();
        let waiting = async {
            loop {
                if let Some(entry) = store.section(name, key) {
                    return Some(entry.value);
                }
                if matches!(self.inner.client.status(), ConnectionStatus::Closed { .. }) {
                    return None;
                }
                match changes.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        };
        match mixdog_rt::time::timeout(SECTION_WAIT, waiting).await {
            Ok(Some(value)) => Ok(value),
            _ => Err(StoreError::SectionUnavailable(section.to_owned())),
        }
    }

    /// `resolveOnboardingVerdict`: whether first-run setup is done. An unreadable status counts as done, so a transport hiccup cannot
    /// bring a dismissed wizard back.
    pub async fn onboarding_completed(&self) -> bool {
        match self.call("getOnboardingStatus", &[]).await {
            Ok(status) if status.is_object() => status["completed"] == true,
            _ => true,
        }
    }

    /// `bindLocalThemeMethods`' `setTheme`: the palette is the app's, applied locally first; this mirrors the switch to the core without
    /// persisting it (the core's theme epoch re-renders the other attached views). A failure is ignored: the local palette is applied.
    pub async fn mirror_theme(&self, id: &str, options: &Value) {
        let mut options = options.as_object().cloned().unwrap_or_default();
        options.insert("persist".to_owned(), Value::Bool(false));
        let _ = self.call("setTheme", &[json!(id), Value::Object(options)]).await;
    }

    /// Unsubscribes and closes, once; waits at most [`EXIT_WAIT`]. Pending OAuth flows this store began are cancelled. Returns whether it
    /// finished in time (a session that did not is still released: the connection is dropped with the client).
    pub async fn dispose(&self, _reason: &str) -> bool {
        if self.inner.disposed.load(Ordering::Acquire) {
            return true;
        }
        // Disposal is itself an immediate boundary: the final pending state is published once, while subscribers are still here.
        self.inner.mark_dirty();
        self.inner.publish();
        self.inner.disposed.store(true, Ordering::Release);
        if let Some(pump) = held(&self.pump).take() {
            pump.abort();
        }
        let inner = Arc::clone(&self.inner);
        let release = async move {
            inner.cancel_oauth_flows().await;
            if let Some(id) = inner.thread_id() {
                let _ = inner.client.unsubscribe_thread(&ThreadId::from(id.as_str())).await;
            }
            inner.client.close().await;
        };
        let finished = mixdog_rt::time::timeout(EXIT_WAIT, release).await.is_ok();
        if !finished {
            self.inner.notice("warn", "the session did not close in time".to_owned());
        }
        finished
    }
}

impl Drop for SessionStore {
    fn drop(&mut self) {
        if let Some(pump) = held(&self.pump).take() {
            pump.abort();
        }
    }
}

/// The `thread/start` params of the Node `createSession` options.
fn start_params(options: &StoreOptions) -> Value {
    let mut draft = serde_json::Map::new();
    if let (Some(provider), Some(model)) = (&options.provider, &options.model) {
        draft.insert("route".to_owned(), json!({ "provider": provider, "model": model }));
    }
    if let Some(worktree) = options.worktree.as_ref().filter(|worktree| !worktree.is_null()) {
        draft.insert("worktree".to_owned(), worktree.clone());
    }
    let mut session = serde_json::Map::new();
    session.insert("toolProfile".to_owned(), json!("interactive"));
    if let Some(mode) = &options.tool_mode {
        session.insert("toolMode".to_owned(), json!(mode));
    }
    let mut params = serde_json::Map::new();
    params.insert("kind".to_owned(), json!("task"));
    if let Some(cwd) = options.cwd.as_ref().filter(|cwd| !cwd.is_empty()) {
        params.insert("projectPath".to_owned(), json!(cwd));
    }
    if !draft.is_empty() {
        params.insert("draft".to_owned(), Value::Object(draft));
    }
    params.insert("session".to_owned(), Value::Object(session));
    Value::Object(params)
}

/// The route of an option set that names only a provider or only a model (`ModelSelection` needs both).
fn partial_route(options: &StoreOptions) -> Option<Value> {
    if options.provider.is_some() == options.model.is_some() {
        return None;
    }
    Some(json!({ "provider": options.provider.clone().unwrap_or_default(), "model": options.model.clone().unwrap_or_default() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_starts_with_the_createsession_options() {
        let options = StoreOptions {
            provider: Some("anthropic".to_owned()),
            model: Some("m".to_owned()),
            tool_mode: Some("readonly".to_owned()),
            worktree: Some(json!({ "mode": "default" })),
            cwd: Some("/w".to_owned()),
            ..StoreOptions::default()
        };
        assert_eq!(
            start_params(&options),
            json!({
                "kind": "task",
                "projectPath": "/w",
                "draft": { "route": { "provider": "anthropic", "model": "m" }, "worktree": { "mode": "default" } },
                "session": { "toolProfile": "interactive", "toolMode": "readonly" }
            })
        );
        assert_eq!(start_params(&StoreOptions::default()), json!({ "kind": "task", "session": { "toolProfile": "interactive" } }));
    }

    #[test]
    fn half_a_route_is_set_after_the_thread_exists() {
        let only_model = StoreOptions { model: Some("m".to_owned()), ..StoreOptions::default() };
        assert!(start_params(&only_model).get("draft").is_none());
        assert_eq!(partial_route(&only_model), Some(json!({ "provider": "", "model": "m" })));
        let both = StoreOptions { provider: Some("p".to_owned()), model: Some("m".to_owned()), ..StoreOptions::default() };
        assert_eq!(partial_route(&both), None);
    }
}
