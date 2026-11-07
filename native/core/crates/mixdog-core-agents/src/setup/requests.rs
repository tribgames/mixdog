//! The desktop-host setup requests (`setup-tool/ui-requests.mjs`): one addressed request, one
//! desktop claimant, one receipt. A request nobody claims in time changes nothing and answers
//! [`DesktopAnswer::Unclaimed`] (`SETUP_DESKTOP_UNCLAIMED`), so a caller with a runtime-only route may still take
//! it. The three `config/*SetupRequest` methods are the claimant's side.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;
use tokio::sync::oneshot;
use tokio::time::Instant;

use super::DesktopAnswer;
use super::SetupDesktop;

/// The two ways `ui-requests.mjs` leaves a request unclaimed, with its message.
const NO_SURFACE: &str = "setup: no attached Desktop surface; nothing was changed";
const NOT_CLAIMED: &str = "setup: no Desktop window claimed the request; nothing was changed";

/// `notifySessionUi(sessionId, 'Desktop settings request', { kind: 'setup-ui', id })`: whether
/// the session took the notice. The session shows the request to every window, a late one
/// included, until it is settled or `window` (its claim window) ends.
#[async_trait]
pub trait SetupUiSurface: Send + Sync {
    async fn notify(&self, thread: &ThreadId, request_id: &str, window: Duration) -> bool;
    /// The request can no longer be claimed (a window claimed it, or it ended unclaimed): the
    /// session stops showing it.
    async fn settled(&self, thread: &ThreadId, request_id: &str);
    /// `open`: asks the app attached to the session to go to a surface, as Node's
    /// `notifySessionUi(sessionId, 'Open /<command>', { kind: 'ui-open', command })` does; whether one
    /// took it. No attached UI is the default.
    async fn open(&self, _thread: &ThreadId, _command: &str) -> bool {
        false
    }
}

pub const CLAIM_TIMEOUT: Duration = Duration::from_secs(15);
pub const EXECUTION_TIMEOUT: Duration = Duration::from_secs(900);

type Outcome = Result<Value, String>;

struct Entry {
    args: Value,
    thread: ThreadId,
    owner: Option<String>,
    claim_by: Instant,
    deadline: Instant,
    done: Option<oneshot::Sender<Outcome>>,
    /// Woken by the claim, which moves the deadline; a stored permit keeps a wake that comes early.
    claimed: Arc<tokio::sync::Notify>,
}

pub struct SetupRequests {
    surface: Arc<dyn SetupUiSurface>,
    claim_timeout: Duration,
    execution_timeout: Duration,
    pending: Mutex<HashMap<String, Entry>>,
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Removes the entry when the request future is dropped (the call was cancelled).
struct Pending<'a> {
    requests: &'a SetupRequests,
    id: String,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.requests.pending.lock().expect("setup requests").remove(&self.id);
    }
}

impl SetupRequests {
    pub fn new(surface: Arc<dyn SetupUiSurface>) -> Self {
        Self::with_timeouts(surface, CLAIM_TIMEOUT, EXECUTION_TIMEOUT)
    }

    pub fn with_timeouts(surface: Arc<dyn SetupUiSurface>, claim: Duration, execution: Duration) -> Self {
        Self { surface, claim_timeout: claim, execution_timeout: execution, pending: Mutex::new(HashMap::new()) }
    }

    fn finish(&self, id: &str, outcome: Outcome) -> bool {
        let entry = self.pending.lock().expect("setup requests").remove(id);
        match entry.and_then(|entry| entry.done) {
            Some(done) => {
                let _ = done.send(outcome);
                true
            }
            None => false,
        }
    }

    /// `isSetupRequestActive(id, owner)` for the calling thread.
    pub fn is_active(&self, thread: &ThreadId, id: &str, owner: &str) -> bool {
        let pending = self.pending.lock().expect("setup requests");
        pending.get(id).is_some_and(|entry| entry.owner.as_deref() == Some(owner) && &entry.thread == thread)
    }

    /// `claimSetupRequest(id, owner)`: `{ id, args, scope }` for the first claimant on the
    /// request's own thread; the claim moves the deadline to the execution window.
    pub fn claim(&self, thread: &ThreadId, id: &str, owner: &str) -> Option<Value> {
        let mut pending = self.pending.lock().expect("setup requests");
        let entry = pending.get_mut(id)?;
        if entry.owner.is_some()
            || entry.claim_by <= Instant::now()
            || mixdog_js::js_trim(owner).is_empty()
            || &entry.thread != thread
        {
            return None;
        }
        entry.owner = Some(owner.to_owned());
        entry.deadline = Instant::now() + self.execution_timeout;
        entry.claimed.notify_one();
        Some(json!({ "id": id, "args": entry.args, "scope": "desktop-host" }))
    }

    /// `completeSetupRequest(id, owner, receipt)`: `false` for an unknown request or another
    /// owner; a receipt that is not an object is an error.
    pub fn complete(&self, id: &str, owner: &str, receipt: &Value) -> Result<bool, PortError> {
        {
            let pending = self.pending.lock().expect("setup requests");
            match pending.get(id) {
                Some(entry) if entry.owner.as_deref() == Some(owner) => {}
                _ => return Ok(false),
            }
        }
        // `typeof receipt === 'object'` holds for an array too, which has neither key.
        let (error, result) = match receipt {
            Value::Object(map) => (map.get("error"), map.get("result")),
            Value::Array(_) => (None, None),
            _ => return Err(PortError::Failed { capability: "setup".into(), message: "setup receipt is required".into() }),
        };
        let outcome = match error.filter(|e| truthy(e)) {
            Some(error) => Err(mixdog_js::value_to_string(error)),
            None => Ok(result.cloned().unwrap_or(Value::Null)),
        };
        Ok(self.finish(id, outcome))
    }

    /// `dispose()`: every open request fails.
    pub fn dispose(&self) {
        let ids: Vec<String> = self.pending.lock().expect("setup requests").keys().cloned().collect();
        for id in ids {
            self.finish(&id, Err("setup: session closed before Desktop confirmed the operation".into()));
        }
    }
}

#[async_trait]
impl SetupDesktop for SetupRequests {
    async fn request(&self, thread: &ThreadId, args: &Value) -> Result<DesktopAnswer, PortError> {
        let id = uuid::Uuid::new_v4().to_string();
        let (done, outcome) = oneshot::channel();
        let claimed = Arc::new(tokio::sync::Notify::new());
        let now = Instant::now();
        self.pending.lock().expect("setup requests").insert(
            id.clone(),
            Entry {
                args: args.clone(),
                thread: thread.clone(),
                owner: None,
                claim_by: now + self.claim_timeout,
                deadline: now + self.claim_timeout,
                done: Some(done),
                claimed: claimed.clone(),
            },
        );
        let _guard = Pending { requests: self, id: id.clone() };
        if !self.surface.notify(thread, &id, self.claim_timeout).await {
            return Ok(DesktopAnswer::Unclaimed(NO_SURFACE.into()));
        }
        tokio::pin!(outcome);
        // Whether the session was told the request can no longer be claimed.
        let mut settled = false;
        let answer = loop {
            let (deadline, is_claimed) = {
                let pending = self.pending.lock().expect("setup requests");
                // Finished while this task was not polling: its outcome is already sent.
                pending.get(&id).map_or((Instant::now(), false), |entry| (entry.deadline, entry.owner.is_some()))
            };
            tokio::select! {
                biased;
                result = &mut outcome => {
                    break match result {
                        Ok(Ok(value)) => Ok(DesktopAnswer::Done(value)),
                        Ok(Err(message)) => Err(PortError::Failed { capability: "setup".into(), message }),
                        Err(_) => Ok(DesktopAnswer::Unclaimed(NOT_CLAIMED.into())),
                    };
                }
                // A claim moved the deadline: the session stops showing the request, and the
                // wait goes on to the new deadline.
                () = claimed.notified() => {
                    if !settled {
                        self.surface.settled(thread, &id).await;
                        settled = true;
                    }
                    continue;
                }
                () = tokio::time::sleep_until(deadline) => {
                    let (now_claimed, now_deadline) = {
                        let pending = self.pending.lock().expect("setup requests");
                        pending.get(&id).map_or((is_claimed, deadline), |e| (e.owner.is_some(), e.deadline))
                    };
                    if now_deadline > Instant::now() {
                        continue;
                    }
                    if now_claimed {
                        break Err(PortError::Failed {
                            capability: "setup".into(),
                            message: "setup: Desktop did not return a receipt. The operation may still be running; inspect its state before retrying.".into(),
                        });
                    }
                    break Ok(DesktopAnswer::Unclaimed(NOT_CLAIMED.into()));
                }
            }
        };
        if !settled {
            self.surface.settled(thread, &id).await;
        }
        answer
    }
}

/// The claimant's side as the three `config/*SetupRequest` methods, over the broker the setup
/// tool's desktop requests go through. The request belongs to the thread the call names.
pub struct SetupRequestsService {
    requests: Arc<SetupRequests>,
}

const SETUP_REQUEST_METHODS: &[&str] =
    &["config/isSetupRequestActive", "config/claimSetupRequest", "config/completeSetupRequest"];

impl SetupRequestsService {
    pub fn new(requests: Arc<SetupRequests>) -> Self {
        Self { requests }
    }
}

fn text(params: &Value, key: &'static str) -> Result<String, CoreError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CoreError::InvalidParams { path: format!("params.{key}").into(), expected: "string".into() })
}

#[async_trait]
impl DomainService for SetupRequestsService {
    fn methods(&self) -> &'static [&'static str] {
        SETUP_REQUEST_METHODS
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let params = &req.params;
        let id = text(params, "id")?;
        let owner = text(params, "owner")?;
        // A call without a thread has no session: the broker's `getSessionId()` is empty and no
        // request belongs to it.
        let thread = params.get("threadId").and_then(Value::as_str).map(ThreadId::from);
        let value = match req.method.as_str() {
            "config/isSetupRequestActive" => {
                json!(thread.is_some_and(|thread| self.requests.is_active(&thread, &id, &owner)))
            }
            "config/claimSetupRequest" => {
                thread.and_then(|thread| self.requests.claim(&thread, &id, &owner)).unwrap_or(Value::Null)
            }
            "config/completeSetupRequest" => {
                let receipt = params.get("receipt").cloned().unwrap_or(Value::Null);
                match self.requests.complete(&id, &owner, &receipt) {
                    Ok(done) => json!(done),
                    Err(PortError::Failed { message, .. }) => {
                        return Err(mixdog_core_base::support::failed("config", message));
                    }
                    Err(other) => unreachable!("complete fails only on the receipt: {other:?}"),
                }
            }
            other => return Err(mixdog_core_base::support::wrong_method("setup requests", other)),
        };
        Ok(Reply::Value(value))
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
