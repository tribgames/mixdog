//! The desktop-host setup requests (`setup-tool/ui-requests.mjs`): one addressed request, one
//! desktop claimant, one receipt. A request nobody claims in time changes nothing and answers
//! [`DesktopAnswer::Unclaimed`] (`SETUP_DESKTOP_UNCLAIMED`), so a caller with a runtime-only route may still take
//! it. The three `config/*SetupRequest` methods are the claimant's side.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
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

/// `notifySessionUi(sessionId, 'Desktop settings request', { kind: 'setup-ui', id })`: whether a
/// desktop surface is attached to the session and took the notice.
#[async_trait]
pub trait SetupUiSurface: Send + Sync {
    async fn notify(&self, thread: &ThreadId, request_id: &str) -> bool;
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
        let Some(map) = receipt.as_object() else {
            return Err(PortError::Failed { capability: "setup".into(), message: "setup receipt is required".into() });
        };
        let outcome = match map.get("error").filter(|e| truthy(e)) {
            Some(error) => Err(mixdog_js::value_to_string(error)),
            None => Ok(map.get("result").cloned().unwrap_or(Value::Null)),
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
            },
        );
        let _guard = Pending { requests: self, id: id.clone() };
        if !self.surface.notify(thread, &id).await {
            return Ok(DesktopAnswer::Unclaimed(NO_SURFACE.into()));
        }
        tokio::pin!(outcome);
        loop {
            let (deadline, claimed) = {
                let pending = self.pending.lock().expect("setup requests");
                let Some(entry) = pending.get(&id) else { break };
                (entry.deadline, entry.owner.is_some())
            };
            tokio::select! {
                result = &mut outcome => {
                    return match result {
                        Ok(Ok(value)) => Ok(DesktopAnswer::Done(value)),
                        Ok(Err(message)) => Err(PortError::Failed { capability: "setup".into(), message }),
                        Err(_) => Ok(DesktopAnswer::Unclaimed(NOT_CLAIMED.into())),
                    };
                }
                () = tokio::time::sleep_until(deadline) => {
                    let (now_claimed, now_deadline) = {
                        let pending = self.pending.lock().expect("setup requests");
                        pending.get(&id).map_or((claimed, deadline), |e| (e.owner.is_some(), e.deadline))
                    };
                    if now_deadline > Instant::now() {
                        continue;
                    }
                    if now_claimed {
                        return Err(PortError::Failed {
                            capability: "setup".into(),
                            message: "setup: Desktop did not return a receipt. The operation may still be running; inspect its state before retrying.".into(),
                        });
                    }
                    return Ok(DesktopAnswer::Unclaimed(NOT_CLAIMED.into()));
                }
            }
        }
        Ok(DesktopAnswer::Unclaimed(NOT_CLAIMED.into()))
    }
}

#[cfg(test)]
mod tests;
