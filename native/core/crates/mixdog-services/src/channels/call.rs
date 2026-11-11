//! One `channel/call` of the bridge: the callId idempotency cache and the binding-aware
//! run of `activate_channel_bridge`.
//!
//! Calls are independent tasks: nothing queues behind another client's call. Only the
//! binding tool is serialized (it moves the one remote-control binding). A retried call
//! with the same callId awaits the original run, so a transport retry never repeats a
//! side effect; the cache entry's TTL starts when the call settles, not when it starts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_rt::Scope;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::intent::{IntentFile, RemoteIntent, normalize_intent};
use super::running::RunningWork;
use super::tools::ACTIVATE_TOOL;

pub const CALL_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelClient {
    pub token: String,
    pub lead_pid: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct CallRequest {
    pub name: String,
    pub args: Value,
    pub call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// The callId was reused with a different payload.
    CallIdConflict(String),
    Failed(String),
}

impl CallError {
    pub fn code(&self) -> Option<&'static str> {
        matches!(self, Self::CallIdConflict(_)).then_some("ECALLIDCONFLICT")
    }
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CallIdConflict(id) => write!(f, "callId '{id}' was reused with a different payload"),
            Self::Failed(m) => f.write_str(m),
        }
    }
}
impl std::error::Error for CallError {}

pub type CallResult = Result<Value, CallError>;

#[async_trait]
pub trait ChannelCallHandler: Send + Sync {
    async fn call(&self, name: &str, args: &Value, client: &ChannelClient) -> Result<Value, String>;
}

/// The session id a binding call addresses: an explicit `sessionId`, else the stem of
/// `transcriptPath`; only `[A-Za-z0-9_-]+` counts.
pub fn remote_session_id_from_binding(name: &str, args: &Value) -> Option<String> {
    if name != ACTIVATE_TOOL || !args.is_object() {
        return None;
    }
    let valid = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let explicit = mixdog_js::js_trim(args["sessionId"].as_str().unwrap_or_default());
    if valid(explicit) {
        return Some(explicit.to_string());
    }
    let path = mixdog_js::js_trim(args["transcriptPath"].as_str().unwrap_or_default());
    let file = path.rsplit(['/', '\\']).next().unwrap_or_default();
    let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
    valid(stem).then(|| stem.to_string())
}

/// Scheduling owner of a call: the addressed session, else the lead process, else the client.
pub fn owner_key(client: &ChannelClient, req: &CallRequest) -> String {
    let addressed = mixdog_js::js_trim(req.args["sessionId"].as_str().unwrap_or_default()).to_string();
    let addressed = if addressed.is_empty() {
        remote_session_id_from_binding(&req.name, &req.args).unwrap_or_default()
    } else {
        addressed
    };
    if !addressed.is_empty() {
        format!("session:{addressed}")
    } else if let Some(pid) = client.lead_pid {
        format!("pid:{pid}")
    } else {
        format!("client:{}", client.token)
    }
}

/// Retry identity belongs to the calling process and survives its reconnecting with a new token.
fn call_owner(client: &ChannelClient) -> String {
    match client.lead_pid {
        Some(pid) => format!("pid:{pid}"),
        None => format!("client:{}", client.token),
    }
}

/// serde_json maps are ordered by key, so equal payloads hash equal.
fn call_signature(name: &str, args: &Value) -> String {
    let canonical = json!({ "name": name, "args": if args.is_null() { json!({}) } else { args.clone() } });
    Sha256::digest(canonical.to_string().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// The binding as it is announced (`publishRemoteState`).
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteState<'a> {
    pub acquired: bool,
    pub pinned_session_id: Option<&'a str>,
    /// The pinned intent's working directory: the core's clients send none, so Node's `pointerClient.cwd` is always
    /// absent and its fallback `remoteIntent.cwd` is the value.
    pub cwd: Option<&'a str>,
}

impl RemoteState<'_> {
    /// The state a client reads (`remote-state.mjs`): `{enabled, sessionId, cwd}`.
    pub fn to_value(&self) -> Value {
        let session = self.pinned_session_id.filter(|id| self.acquired && !id.is_empty());
        json!({ "enabled": session.is_some(), "sessionId": session, "cwd": self.cwd })
    }
}

/// Hears the binding after each change.
pub type BindingObserver = Arc<dyn Fn(&RemoteState<'_>) + Send + Sync>;

#[derive(Clone, Default, PartialEq)]
struct Binding {
    remote_acquired: bool,
    pinned_session_id: Option<String>,
    /// The persisted intent the pin came from or was saved as (`state.remoteIntent`); a restore
    /// applies only while it is still this one.
    intent: Option<Arc<RemoteIntent>>,
}

impl Binding {
    fn state(&self) -> RemoteState<'_> {
        RemoteState { acquired: self.remote_acquired, pinned_session_id: self.pinned_session_id.as_deref(), cwd: self.intent.as_ref().and_then(|i| i.cwd.as_deref()) }
    }
}

struct Entry {
    signature: String,
    result: watch::Receiver<Option<CallResult>>,
}

pub struct CallDispatch {
    handler: Arc<dyn ChannelCallHandler>,
    work: RunningWork,
    ttl: Duration,
    cache: Arc<Mutex<HashMap<String, Arc<Entry>>>>,
    /// The one remote-control binding; held for a few instructions, never across the call.
    binding: Mutex<Binding>,
    /// Told `(enabled, pinned session)` after each change of the binding (`onRemoteStateChange`).
    on_binding: Mutex<Option<BindingObserver>>,
    /// Orders the binding tool's calls: a call reads the binding, runs, then records its outcome.
    binding_turn: mixdog_rt::Gate,
    /// Ends every wait on `binding_turn` and every binding call in flight ([`Self::close`]).
    cancel: CancellationToken,
    /// Where a manual Remote ON is persisted for the next start ([`Self::load_intent`]).
    intent_file: std::sync::OnceLock<IntentFile>,
    /// What is known of a stored session ([`Self::bind_session_presence`]); the restore drops a pin only to one known gone.
    session_presence: std::sync::OnceLock<SessionPresence>,
    /// The session a manual ON in flight is activating: announced as acquired when the bridge connects
    /// ([`Self::bridge_connected`]), not before.
    activating: Mutex<Option<String>>,
}

/// What is known of the stored session with this id: `Some(true)` present, `Some(false)` known to be gone, `None`
/// when its record could not be read.
pub type SessionPresence = Arc<dyn Fn(String) -> futures::future::BoxFuture<'static, Option<bool>> + Send + Sync>;

fn is_soft_error(result: &Value) -> bool {
    result["isError"] == Value::Bool(true)
}

impl CallDispatch {
    pub fn new(handler: Arc<dyn ChannelCallHandler>, work: RunningWork) -> Arc<Self> {
        Self::with_ttl(handler, work, CALL_CACHE_TTL)
    }

    pub fn with_ttl(handler: Arc<dyn ChannelCallHandler>, work: RunningWork, ttl: Duration) -> Arc<Self> {
        Arc::new(Self {
            handler,
            work,
            ttl,
            cache: Default::default(),
            binding: Default::default(),
            on_binding: Default::default(),
            binding_turn: mixdog_rt::Gate::new(),
            cancel: CancellationToken::new(),
            intent_file: std::sync::OnceLock::new(),
            session_presence: std::sync::OnceLock::new(),
            activating: Mutex::new(None),
        })
    }

    /// Hears `runtime`'s bridge connect ([`Self::bridge_connected`]).
    pub fn hear_bridge(self: &Arc<Self>, runtime: &super::runtime::ChannelRuntime) {
        let calls = Arc::downgrade(self);
        runtime.on_bridge_connected(Arc::new(move || {
            if let Some(calls) = calls.upgrade() {
                calls.bridge_connected();
            }
        }));
    }

    /// The bridge connected (`activateBridge` → `notifyRemoteAcquired`, owned-start.mjs:53-56): the manual ON in
    /// flight is announced as acquired now, after the bridge connected and before its providers initialise.
    pub fn bridge_connected(&self) {
        let Some(session) = self.activating.lock().unwrap().clone() else { return };
        let intent = self.binding.lock().unwrap().intent.clone();
        self.set_binding(Binding { remote_acquired: true, pinned_session_id: Some(session), intent });
    }

    /// Binds the stored-session lookup the restore asks before it activates a pin.
    pub fn bind_session_presence(&self, presence: SessionPresence) {
        let _ = self.session_presence.set(presence);
    }

    /// Binds the intent file and pins the session it holds (`createChannelTransport`'s boot read).
    /// The pin is not a live binding until [`Self::restore_intent`] activates it.
    pub async fn load_intent(&self, file: IntentFile) {
        let intent = file.load().await;
        if self.intent_file.set(file).is_err() {
            return;
        }
        if let Some(intent) = intent {
            let mut binding = self.binding.lock().unwrap();
            binding.pinned_session_id = Some(intent.session_id.clone());
            binding.intent = Some(Arc::new(intent));
        }
    }

    /// The pinned session, live or waiting for its restore (`remoteIntentSessionId`).
    pub fn pinned_session(&self) -> Option<String> {
        self.binding.lock().unwrap().pinned_session_id.clone()
    }

    /// The session remote control is bound to (`remoteSessionId`).
    pub fn remote_session(&self) -> Option<String> {
        let binding = self.binding.lock().unwrap();
        binding.pinned_session_id.clone().filter(|_| binding.remote_acquired)
    }

    /// `restoreRemoteIntent`: activates the bridge for the persisted session, in turn with the
    /// manual binding calls. `true` when the session is bound.
    pub async fn restore_intent(&self) -> bool {
        let (Some(file), Some(intent)) = (self.intent_file.get(), self.binding.lock().unwrap().intent.clone()) else {
            return false;
        };
        if self.cancel.is_cancelled() {
            return false;
        }
        if self.binding.lock().unwrap().remote_acquired {
            return true;
        }
        let Ok(_turn) = self.binding_turn.enter(&self.cancel).await else { return false };
        let current = |binding: &Binding| {
            binding.intent.as_ref().is_some_and(|i| Arc::ptr_eq(i, &intent)) && binding.pinned_session_id.as_deref() == Some(&intent.session_id)
        };
        if !current(&self.binding.lock().unwrap()) {
            return false;
        }
        // A pin outlives the session it names: binding Remote to a deleted session would announce Remote enabled
        // for a session no list shows, so such a pin is dropped and the log says so. Only a session known to be gone
        // drops it: a record that could not be read is no proof, so the pin is kept and restored, and the log says so.
        if let Some(presence) = self.session_presence.get() {
            let known = presence(intent.session_id.clone()).await;
            if known == Some(false) {
                {
                    let mut binding = self.binding.lock().unwrap();
                    if !current(&binding) {
                        return false;
                    }
                    *binding = Binding::default();
                }
                file.log(&format!("remote intent restore skipped session={}: the session no longer exists", intent.session_id));
                file.clear("pinned session deleted").await;
                self.binding_changed();
                return false;
            }
            if !current(&self.binding.lock().unwrap()) {
                return false;
            }
            if known.is_none() {
                file.log(&format!("remote intent restore kept session={}: the session record could not be read", intent.session_id));
            }
        }
        let args = json!({"active": true, "sessionId": intent.session_id, "transcriptPath": intent.transcript_path, "restore": true});
        // Node's restore has no client (`clientToken: null`).
        let client = ChannelClient { token: String::new(), lead_pid: None };
        let Some(result) = Scope::new().cancel(&self.cancel).run(self.handler.call(ACTIVATE_TOOL, &args, &client)).await.done() else {
            return false;
        };
        let failure = match result {
            Ok(value) if is_soft_error(&value) => value["content"][0]["text"].as_str().filter(|t| !t.is_empty()).unwrap_or("restored activation failed").to_string(),
            Ok(_) => {
                {
                    let mut binding = self.binding.lock().unwrap();
                    if !current(&binding) {
                        return false;
                    }
                    binding.remote_acquired = true;
                }
                file.log(&format!("remote intent restored session={}", intent.session_id));
                self.binding_changed();
                return true;
            }
            Err(message) => message,
        };
        file.log(&format!("remote intent restore failed session={}: {failure}", intent.session_id));
        false
    }

    /// Registers who hears the binding change, and tells it the binding now.
    pub fn observe_binding(&self, observer: BindingObserver) {
        let binding = self.binding.lock().unwrap().clone();
        observer(&binding.state());
        *self.on_binding.lock().unwrap() = Some(observer);
    }

    fn binding_changed(&self) {
        let binding = self.binding.lock().unwrap().clone();
        if let Some(observer) = self.on_binding.lock().unwrap().as_ref() {
            observer(&binding.state());
        }
    }

    /// Moves the binding; an unchanged one is not re-announced (`remote-state.mjs` signature).
    fn set_binding(&self, next: Binding) {
        let changed = {
            let mut binding = self.binding.lock().unwrap();
            let changed = *binding != next;
            *binding = next;
            changed
        };
        if changed {
            self.binding_changed();
        }
    }

    /// Shutdown: queued binding calls and the one in flight end as dropped calls.
    pub fn close(&self) {
        self.cancel.cancel();
    }

    pub fn cached_calls(&self) -> usize {
        self.cache.lock().unwrap().len()
    }

    pub async fn dispatch(self: &Arc<Self>, client: ChannelClient, req: CallRequest) -> CallResult {
        let Some(call_id) = req.call_id.clone().filter(|c| !c.is_empty()) else {
            return self.run_counted(client, req).await;
        };
        let key = format!("{}\0{call_id}", call_owner(&client));
        let signature = call_signature(&req.name, &req.args);
        let entry = {
            let mut cache = self.cache.lock().unwrap();
            if let Some(existing) = cache.get(&key) {
                if existing.signature != signature {
                    return Err(CallError::CallIdConflict(call_id));
                }
                Arc::clone(existing)
            } else {
                let (tx, rx) = watch::channel(None);
                let entry = Arc::new(Entry { signature, result: rx });
                cache.insert(key.clone(), Arc::clone(&entry));
                // The run is its own task: a caller giving up must not cancel a side effect
                // that a retry is waiting on.
                let this = Arc::clone(self);
                let run_entry = Arc::clone(&entry);
                tokio::spawn(async move {
                    let result = this.run_counted(client, req).await;
                    let _ = tx.send(Some(result));
                    tokio::time::sleep(this.ttl).await;
                    let mut cache = this.cache.lock().unwrap();
                    if cache.get(&key).is_some_and(|e| Arc::ptr_eq(e, &run_entry)) {
                        cache.remove(&key);
                    }
                });
                entry
            }
        };
        let mut rx = entry.result.clone();
        match rx.wait_for(Option::is_some).await {
            Ok(done) => done.clone().expect("waited for a settled result"),
            Err(_) => Err(CallError::Failed("channel call dropped".into())),
        }
    }

    async fn run_counted(&self, client: ChannelClient, req: CallRequest) -> CallResult {
        let _busy = self.work.begin();
        self.run_call(&client, &req).await
    }

    async fn plain(&self, client: &ChannelClient, req: &CallRequest) -> CallResult {
        self.handler.call(&req.name, &req.args, client).await.map_err(CallError::Failed)
    }

    async fn run_call(&self, client: &ChannelClient, req: &CallRequest) -> CallResult {
        if req.name != ACTIVATE_TOOL {
            return self.plain(client, req).await;
        }
        let session = remote_session_id_from_binding(&req.name, &req.args);
        let activating = req.args["active"] == Value::Bool(true);
        let deactivating = req.args["active"] == Value::Bool(false);
        let dropped = || CallError::Failed("channel call dropped".into());
        let _turn = self.binding_turn.enter(&self.cancel).await.map_err(|_| dropped())?;
        let binding = self.binding.lock().unwrap().clone();
        // Automatic activation is retired: a valid manual ON always names its session.
        if activating && (req.args["claimIfVacant"] == Value::Bool(true) || session.is_none()) {
            return Ok(json!({
                "content": [{"type":"text","text":"channel bridge claim skipped: manual ON required"}],
                "claimSkipped": true
            }));
        }
        let pinned_match = session.is_some() && binding.remote_acquired && binding.pinned_session_id == session;
        if deactivating && !pinned_match {
            return Ok(json!({
                "content": [{"type":"text","text":"channel bridge release skipped: session is not pinned"}],
                "releaseSkipped": true
            }));
        }
        if activating {
            // Remote shows acquired once the bridge connects, before it initialises its providers, as Node's daemon on
            // the worker's `notifications/mixdog/remote` (`owned-start.mjs:53-56`, `remote-pointer.mjs` `acquireRemoteState`).
            *self.activating.lock().unwrap() = session.clone();
        }
        let result = Scope::new().cancel(&self.cancel).run(self.plain(client, req)).await.done();
        self.activating.lock().unwrap().take();
        // A soft `isError` envelope is a failed call: it must leave the binding as it was.
        match &result {
            Some(Ok(value)) if !is_soft_error(value) => {
                if deactivating {
                    self.set_binding(Binding::default());
                    if let Some(file) = self.intent_file.get() {
                        file.clear("explicit Remote OFF").await;
                    }
                } else if activating {
                    // Announced when the bridge connected; a bridge that was connected already is announced now.
                    self.set_binding(Binding { remote_acquired: true, pinned_session_id: session.clone(), intent: binding.intent.clone() });
                    self.pin(session.expect("a manual ON names its session"), &req.args).await;
                }
            }
            _ => self.set_binding(binding),
        }
        result.ok_or_else(dropped)?
    }

    /// `writeRemoteIntent`: the session is pinned; the intent is saved only when its transcript
    /// is named after it, and otherwise the saved one stays as it was.
    async fn pin(&self, session: String, args: &Value) {
        let Some(file) = self.intent_file.get() else {
            let mut binding = self.binding.lock().unwrap();
            binding.remote_acquired = true;
            binding.pinned_session_id = Some(session);
            return;
        };
        // The core's clients send no working directory with a call.
        let candidate = json!({"sessionId": session, "transcriptPath": args.get("transcriptPath").cloned().unwrap_or(Value::Null), "cwd": null, "updatedAt": file.now()});
        let intent = normalize_intent(&candidate, file.now()).map(Arc::new);
        {
            let mut binding = self.binding.lock().unwrap();
            binding.remote_acquired = true;
            binding.pinned_session_id = Some(session.clone());
            if let Some(intent) = &intent {
                binding.intent = Some(intent.clone());
            }
        }
        match intent {
            Some(intent) => file.write(&intent).await,
            None => file.log(&format!("remote intent not persisted: session/transcript mismatch session={session}")),
        }
    }
}
