//! The production [`ResumeHost`] of the quota-resume clock: what Node's scheduler
//! (`standalone/session-service/quota-resume.mjs` `resumeDueEntry`) asks of the session service
//! (`materializeSession`), of the session runtime (`getState()`'s route, `fireQuotaResume`) and of
//! the daemon (`readQuotaUsable`, `daemon.mjs:1163`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use tokio::sync::oneshot;

use super::SessionDirectory;
use super::actor::Inbox;
use super::quota_lane::failure_text;
use super::quota_resume_scheduler::FireOutcome;
use super::quota_resume_scheduler::ResumeHost;
use super::quota_resume_scheduler::SessionRoute;
use super::quota_resume_scheduler::UsageError;

/// `readQuotaUsable(provider, model)` (`providerQuotaUsable`, `quota-reading.mjs`): a forced usage
/// reading per account decides whether `provider` can serve `model` now. A disconnected PC in
/// proxy mode is [`UsageError::ProxyUnavailable`].
#[async_trait]
pub trait QuotaUsage: Send + Sync {
    async fn usable(&self, provider: &str, model: &str) -> Result<bool, UsageError>;
}

pub struct SessionResumeHost {
    directory: Arc<SessionDirectory>,
    usage: Arc<dyn QuotaUsage>,
}

impl SessionResumeHost {
    pub fn new(directory: Arc<SessionDirectory>, usage: Arc<dyn QuotaUsage>) -> Self {
        Self { directory, usage }
    }
}

fn caller() -> CallContext {
    CallContext::internal("quota-resume")
}

fn closed() -> String {
    "the session closed".to_owned()
}

#[async_trait]
impl ResumeHost for SessionResumeHost {
    /// `materializeSession(sessionId)`: the session is loaded under daemon ownership.
    async fn materialize(&self, session_id: &str) -> Result<(), String> {
        self.directory.open_admitted(&ThreadId::from(session_id), &caller()).await.map(drop).map_err(|error| failure_text(&error))
    }

    /// The route the session's next turn runs on: its header's `provider` / `model` (a route
    /// change rewrites them at once); an empty one falls back to the entry's in the scheduler.
    async fn route(&self, session_id: &str) -> SessionRoute {
        let header = self.directory.handle(&ThreadId::from(session_id)).map(|handle| handle.cell.header.load_full());
        let field = |key: &str| header.as_ref().and_then(|header| header.get(key)).and_then(Value::as_str).unwrap_or_default().to_owned();
        SessionRoute { provider: field("provider"), model: field("model") }
    }

    async fn usable(&self, provider: &str, model: &str) -> Result<bool, UsageError> {
        self.usage.usable(provider, model).await
    }

    /// `runtime.fireQuotaResume({ generation })` on the session's own lane. A generation the
    /// session already answered is `Stale` on every repeat.
    async fn fire(&self, session_id: &str, generation: u64) -> Result<FireOutcome, String> {
        let handle = self.directory.open_handle(&ThreadId::from(session_id), &caller()).await.map_err(|error| failure_text(&error))?;
        let (tx, rx) = oneshot::channel();
        handle.inbox.send(Inbox::QuotaResumeFire { generation, tx }).await.map_err(|_| closed())?;
        rx.await.map_err(|_| closed())?
    }
}
