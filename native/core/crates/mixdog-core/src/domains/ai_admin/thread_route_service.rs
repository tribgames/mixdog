//! The thread methods of the route and quota-card actions: `thread/continueInModel`
//! (`continueSessionInModel`, model-route/set-route.mjs) and `thread/quotaResume/schedule` /
//! `thread/quotaResume/cancel` (`scheduleQuotaResume` / `cancelQuotaResume`,
//! tui/session/quota-resume.mjs). The app-server hands these to the domain that claims them
//! instead of the thread's actor: they act on the route and the daemon-wide quota-resume store,
//! and only read the thread through [`QuotaResumeSessions`] (WP-SESSION).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::{ThreadContinueInModelParams, ThreadOpParams};
use mixdog_core_api::call::{CoreRequest, Reply};
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::{ConnectionId, Method, ThreadId};
use mixdog_core_api::service::{Admit, DomainService};
use serde_json::{Number, Value, json};

use super::route_service::RouteService;
use crate::domains::support::{OpScopes, decode, failed, wrong_method};
use crate::quota_resume::QuotaResumeStore;

pub const CONTINUE_IN_MODEL: &str = "thread/continueInModel";
pub const QUOTA_RESUME_SCHEDULE: &str = "thread/quotaResume/schedule";
pub const QUOTA_RESUME_CANCEL: &str = "thread/quotaResume/cancel";

const DOMAIN: &str = "route";

/// The failed turn that ended a transcript on exhausted provider quota
/// (`latestQuotaFailure(items)`).
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaFailure {
    pub turn_key: String,
    pub provider: String,
    pub model: String,
    /// `None` when the provider gave no reset time.
    pub reset_at: Option<Number>,
}

/// What `scheduleQuotaResume` reads of the addressed session.
#[derive(Clone, Debug, PartialEq)]
pub struct QuotaFacts {
    /// `latestQuotaFailure(getState().items)`.
    pub failure: Option<QuotaFailure>,
    /// `hasResumeInput(failure.turnKey)`; false when there is no failure.
    pub resumable: bool,
    /// The session's own route (`sessionRoute()`): `routeProvider`, `routeModel`.
    pub route_provider: String,
    pub route_model: String,
}

/// The session side of the quota card (WP-SESSION): its transcript and the cancel epoch of its
/// resume lane.
#[async_trait]
pub trait QuotaResumeSessions: Send + Sync {
    async fn facts(&self, thread: &ThreadId) -> Result<QuotaFacts, CoreError>;
    /// `cancelEpoch += 1`: a cancel landing inside a failed turn's settlement also keeps the
    /// settlement from recording the Goal it suspended.
    async fn cancelled(&self, thread: &ThreadId) -> Result<(), CoreError>;
}

pub struct ThreadRouteService {
    pub routes: Arc<RouteService>,
    pub quota: Arc<QuotaResumeStore>,
    pub sessions: Arc<dyn QuotaResumeSessions>,
    pub ops: OpScopes,
}

impl ThreadRouteService {
    /// `continueSessionInModel(sessionId, next)`: the selection is adopted and the conversation
    /// switched in place.
    async fn continue_in_model(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: ThreadContinueInModelParams = decode(req)?;
        let route = req.params.get("route").and_then(Value::as_object).cloned().unwrap_or_default();
        let thread = params.thread_id;
        self.routes.continue_session_in_model(&thread, thread.as_str(), &route).await.map_err(|message| failed(DOMAIN, message))
    }

    /// `scheduleQuotaResume(sessionId)`.
    async fn schedule(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: ThreadOpParams = decode(req)?;
        let facts = self.sessions.facts(&params.thread_id).await?;
        let Some((failure, reset_at)) = facts.failure.and_then(|f| f.reset_at.clone().map(|at| (f, at))) else {
            return Err(failed(DOMAIN, "latest turn did not fail on exhausted provider quota with a known reset time"));
        };
        if !facts.resumable {
            return Err(failed(DOMAIN, "This turn cannot be resumed automatically. Send a new message to continue."));
        }
        let request = json!({
            "sessionId": params.thread_id.as_str(), "turnKey": failure.turn_key, "provider": failure.provider,
            "model": failure.model, "resetAt": reset_at, "routeProvider": facts.route_provider, "routeModel": facts.route_model,
        });
        self.quota.schedule(&request).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        Ok(Value::Bool(true))
    }

    /// `cancelQuotaResume(sessionId)`.
    async fn cancel(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: ThreadOpParams = decode(req)?;
        self.sessions.cancelled(&params.thread_id).await?;
        self.quota.cancel(params.thread_id.as_str(), None).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        Ok(Value::Bool(true))
    }
}

#[async_trait]
impl DomainService for ThreadRouteService {
    fn methods(&self) -> &'static [&'static str] {
        &[CONTINUE_IN_MODEL, QUOTA_RESUME_SCHEDULE, QUOTA_RESUME_CANCEL]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let method = req.method.as_str();
        // A duplicate op answers what the first one did; none of the three answers too much to
        // store, so a result that was not kept is the plain acknowledgement.
        let reproduce = || async { Ok(Value::Bool(true)) };
        match method {
            CONTINUE_IN_MODEL => self.ops.run(&req, None, || self.continue_in_model(&req), reproduce).await,
            QUOTA_RESUME_SCHEDULE => self.ops.run(&req, None, || self.schedule(&req), reproduce).await,
            QUOTA_RESUME_CANCEL => self.ops.run(&req, None, || self.cancel(&req), reproduce).await,
            other => Err(wrong_method("thread route", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
