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
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::watch;

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

#[derive(Default)]
struct Binding {
    remote_acquired: bool,
    pinned_session_id: Option<String>,
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
    /// Serializes the binding tool; the guarded state is the one remote-control binding.
    binding: tokio::sync::Mutex<Binding>,
}

fn is_soft_error(result: &Value) -> bool {
    result["isError"] == Value::Bool(true)
}

impl CallDispatch {
    pub fn new(handler: Arc<dyn ChannelCallHandler>, work: RunningWork) -> Arc<Self> {
        Self::with_ttl(handler, work, CALL_CACHE_TTL)
    }

    pub fn with_ttl(handler: Arc<dyn ChannelCallHandler>, work: RunningWork, ttl: Duration) -> Arc<Self> {
        Arc::new(Self { handler, work, ttl, cache: Default::default(), binding: Default::default() })
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
        let mut binding = self.binding.lock().await;
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
        let result = self.plain(client, req).await;
        // A soft `isError` envelope is a failed call: it must leave the binding as it was.
        match &result {
            Ok(value) if !is_soft_error(value) => {
                if deactivating {
                    *binding = Binding::default();
                } else if activating {
                    *binding = Binding { remote_acquired: true, pinned_session_id: session };
                }
            }
            _ => {}
        }
        result
    }
}
