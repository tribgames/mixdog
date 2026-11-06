//! The `notify` domain: `notify/test` sends one notification now, past every preference, to this
//! PC's desktop host, to one paired device or to all of them. The engine plans it; the sinks
//! deliver (`host/notification/show` to the host claimant, a relay push per device).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::NotifyTestParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::host::HostCapability;
use mixdog_core_api::host::HostChannel;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use serde_json::{Value, json};

use super::engine::{Audience, NotificationEngine, Plan, PushRequest, TestTarget};
use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::coded;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::wrong_method;

/// `target` of `notify/test` that names this PC (`NOTIFICATION_PC_DEVICE_ID`).
const PC_DEVICE: &str = "pc";
const SHOW: Method = Method("host/notification/show");
const NO_RELAY: &str = "This PC is not connected to the relay, so paired devices cannot be reached.";

/// Who is listening right now: the attached hosts, the paired devices and their preferences.
#[async_trait]
pub trait AudienceSource: Send + Sync {
    /// The audience of a notification about `thread_id` (a device that shows it is foreground).
    async fn audience(&self, thread_id: &str) -> Audience;
}

/// The relay push of one planned request. `Err` is the sentence shown to the user.
#[async_trait]
pub trait PushSink: Send + Sync {
    async fn push(&self, request: &PushRequest) -> Result<(), String>;
    /// Whether this PC is connected to a relay at all.
    fn connected(&self) -> bool;
}

pub struct NotifyService {
    engine: Arc<NotificationEngine>,
    audience: Arc<dyn AudienceSource>,
    host: Arc<dyn HostChannel>,
    push: Arc<dyn PushSink>,
    ops: OpScopes,
}

impl NotifyService {
    pub fn new(
        engine: Arc<NotificationEngine>,
        audience: Arc<dyn AudienceSource>,
        host: Arc<dyn HostChannel>,
        push: Arc<dyn PushSink>,
        ops: OpScopes,
    ) -> Self {
        Self { engine, audience, host, push, ops }
    }

    async fn deliver(&self, plan: Plan) -> Value {
        let mut problems = Vec::new();
        for (_, toast) in &plan.toasts {
            let sent = serde_json::to_value(toast)
                .map_err(|e| e.to_string())
                .and_then(|params| self.host.notify(HostCapability::Notifications, SHOW, params).map_err(|e| format!("{e:?}")));
            if let Err(message) = sent {
                problems.push(message);
            }
        }
        for request in &plan.pushes {
            if let Err(message) = self.push.push(request).await {
                problems.push(message);
            }
        }
        match problems.into_iter().next() {
            Some(message) => json!({ "ok": false, "message": message }),
            None => json!({ "ok": true }),
        }
    }

    async fn test(&self, target: Option<&str>) -> Value {
        let target = match target {
            None | Some("") | Some("all") => TestTarget::All,
            Some(PC_DEVICE) => TestTarget::Desktop,
            Some(id) => TestTarget::Device(id.to_owned()),
        };
        if matches!(target, TestTarget::Device(_)) && !self.push.connected() {
            return json!({ "ok": false, "message": NO_RELAY });
        }
        let plan = self.engine.test(&target, &self.audience.audience("").await);
        if plan.toasts.is_empty() && plan.pushes.is_empty() {
            let message = match target {
                TestTarget::Desktop => "No desktop is attached to show a notification.",
                _ => "That device is not paired.",
            };
            return json!({ "ok": false, "message": message });
        }
        self.deliver(plan).await
    }
}

#[async_trait]
impl DomainService for NotifyService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != "notify/test" {
            return Err(wrong_method("notify", req.method.as_str()));
        }
        let params: NotifyTestParams = decode(&req)?;
        let target = params.target.clone().unwrap_or_default();
        let outcome = self
            .ops
            .run(
                &req,
                Some(("notification", target.clone())),
                || async { Ok(self.test(params.target.as_deref()).await) },
                || async { Ok(json!({ "ok": true })) },
            )
            .await;
        outcome.map_err(|error| match error {
            CoreError::DomainError { .. } => error,
            other => coded("notify", "testFailed", format!("{other:?}")),
        })
    }

    fn methods(&self) -> &'static [&'static str] {
        &["notify/test"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
