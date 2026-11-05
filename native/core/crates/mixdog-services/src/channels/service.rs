//! The `channel/` namespace: the admin methods of schedules, webhooks and their settings, and
//! `channel/call`, the bridge's tool call. Mutations carry an `opId`; the server's op index
//! makes them idempotent, so a handler runs once per op. Every method carries its arguments
//! flat in the request's `params`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::call::Caller;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::Admit;
use mixdog_core_api::{CoreError, CoreRequest, DomainService, Reply};
use mixdog_protocol::DomainErrorDetail;
use serde_json::Value;

use super::admin::{AdminError, ChannelAdmin};
use super::call::{CallDispatch, CallError, CallRequest, ChannelClient};

const DOMAIN: &str = "channel";
/// Any failure a person is shown verbatim.
pub const CHANNEL_FAILED: &str = "CHANNEL_FAILED";

fn invalid(path: &str, expected: &str) -> CoreError {
    CoreError::InvalidParams { path: path.into(), expected: expected.into() }
}

fn failed(message: String) -> CoreError {
    CoreError::DomainError {
        domain: DOMAIN.into(),
        code: Some(CHANNEL_FAILED.into()),
        message: Some(message.into()),
        detail: None,
    }
}

/// A coded schedule refusal keeps its code, its message and its public name; every other
/// failure is a message.
pub fn admin_error(error: AdminError) -> CoreError {
    if let AdminError::Schedule(schedule) = &error
        && let Some((code, name)) = schedule.code_fields()
    {
        return CoreError::DomainError {
            domain: DOMAIN.into(),
            code: Some(code.into()),
            message: Some(error.to_string().into()),
            detail: name.filter(|n| !n.is_empty()).and_then(|n| {
                let name = n.to_string();
                Some(Box::new(match code {
                    "SCHEDULE_NAME_TAKEN" => DomainErrorDetail::ScheduleNameTaken { name },
                    "SCHEDULE_RENAME_RUNNING" => DomainErrorDetail::ScheduleRenameRunning { name },
                    "SCHEDULE_RENAME_RELOAD_FAILED" => DomainErrorDetail::ScheduleRenameReloadFailed { name },
                    _ => return None,
                }))
            }),
        };
    }
    failed(error.to_string())
}

fn call_error(error: CallError) -> CoreError {
    match error {
        CallError::CallIdConflict(_) => CoreError::DomainError {
            domain: DOMAIN.into(),
            code: Some("ECALLIDCONFLICT".into()),
            message: None,
            detail: None,
        },
        CallError::Failed(message) => failed(message),
    }
}

fn text<'a>(params: &'a Value, key: &str) -> Result<&'a str, CoreError> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| invalid(key, "string"))
}

fn flag(params: &Value, key: &str) -> Result<bool, CoreError> {
    params.get(key).and_then(Value::as_bool).ok_or_else(|| invalid(key, "boolean"))
}

fn object<'a>(params: &'a Value, key: &str) -> Result<&'a Value, CoreError> {
    params.get(key).filter(|v| v.is_object()).ok_or_else(|| invalid(key, "object"))
}

pub struct ChannelService {
    admin: Arc<ChannelAdmin>,
    calls: Arc<CallDispatch>,
}

impl ChannelService {
    pub fn new(admin: Arc<ChannelAdmin>, calls: Arc<CallDispatch>) -> Self {
        Self { admin, calls }
    }

    async fn call_tool(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let name = text(&req.params, "name")?;
        let args = req.params.get("args").cloned().filter(|a| !a.is_null()).unwrap_or_else(|| Value::Object(Default::default()));
        if !args.is_object() {
            return Err(invalid("args", "object"));
        }
        let token = match &req.ctx.caller {
            Caller::Connection(id) => format!("connection:{id}"),
            Caller::Internal(who) => format!("internal:{who}"),
        };
        let client = ChannelClient { token, lead_pid: None };
        // The op id is the call's retry identity: a transport retry of one op awaits the
        // original run.
        let call = CallRequest { name: name.to_string(), args, call_id: req.op.as_ref().map(|op| op.as_str().to_string()) };
        self.calls.dispatch(client, call).await.map_err(call_error)
    }

    async fn dispatch(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let p = &req.params;
        let admin = &self.admin;
        let done = |r: Result<Value, AdminError>| r.map_err(admin_error);
        match req.method.as_str() {
            "channel/call" => self.call_tool(req).await,
            "channel/getChannelSettings" => Ok(admin.get_channel_settings(p.get("options").unwrap_or(&Value::Null))),
            "channel/getChannelSetup" => done(admin.get_channel_setup().await),
            "channel/getChannelWorkerStatus" => Ok(admin.get_channel_worker_status()),
            "channel/setWebhookConfig" => done(admin.set_webhook_config(object(p, "patch")?).await),
            "channel/saveSchedule" => done(admin.save_schedule(object(p, "entry")?).await),
            "channel/deleteSchedule" => done(admin.delete_schedule(text(p, "name")?).await),
            "channel/setScheduleEnabled" => done(admin.set_schedule_enabled(text(p, "name")?, flag(p, "enabled")?).await),
            "channel/runScheduleNow" => done(admin.run_schedule_now(text(p, "name")?).await),
            "channel/runWebhookNow" => done(admin.run_webhook_now(text(p, "name")?).await),
            "channel/saveWebhook" => done(admin.save_webhook(object(p, "entry")?).await),
            "channel/deleteWebhook" => done(admin.delete_webhook(text(p, "name")?).await),
            "channel/setWebhookEnabled" => done(admin.set_webhook_enabled(text(p, "name")?, flag(p, "enabled")?).await),
            "channel/testWebhook" => done(admin.test_webhook(text(p, "name")?).await),
            "channel/retryRoutineDelivery" => done(admin.retry_routine_delivery(text(p, "kind")?, text(p, "name")?).await),
            _ => Err(invalid("method", "channel/*")),
        }
    }
}

#[async_trait]
impl DomainService for ChannelService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        Ok(Reply::Value(self.dispatch(&req).await?))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "channel/call",
            "channel/getChannelSettings",
            "channel/getChannelSetup",
            "channel/getChannelWorkerStatus",
            "channel/setWebhookConfig",
            "channel/saveSchedule",
            "channel/deleteSchedule",
            "channel/setScheduleEnabled",
            "channel/runScheduleNow",
            "channel/runWebhookNow",
            "channel/saveWebhook",
            "channel/deleteWebhook",
            "channel/setWebhookEnabled",
            "channel/testWebhook",
            "channel/retryRoutineDelivery",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
