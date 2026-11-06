//! The early (header-only) agent-task completion preview: the running → completed transition
//! an owner sees before the worker's session is persisted (Node `notify/early-completion.mjs`).
//! The body-carrying delivery stays with the board's `notifyTaskCompletion`, so notifications
//! stay exact-once with no duplicate body.

use std::sync::Arc;

use serde_json::Value;
use serde_json::json;

use super::notify::NotifyContext;
use super::reconcile::JobHandle;
use super::result::WorkerResult;
use super::seams::OwnerNotify;
use crate::agent_tool::board::JobMeta;
use crate::agent_tool::scope::clean_str;
use crate::agent_tool::stamp::iso_from_ms;
use crate::env::Clock;

pub struct EarlyNotice {
    owner: Arc<dyn OwnerNotify>,
    clock: Arc<dyn Clock>,
}

/// The task meta lines a card shows (`publicTaskMeta`), in the order Node built the meta: a
/// spawn's pending meta, then the host pid, then what the prepared spawn added; a send's whole
/// meta, then the host pid. A null or empty value is not shown; `false` is.
fn meta_lines(meta: &JobMeta, operation: &str, host_pid: Option<u64>) -> Vec<String> {
    let mut lines = Vec::new();
    let mut put = |key: &str, value: Option<String>| {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            lines.push(format!("{key}: {value}"));
        }
    };
    let flag = |on: bool| on.then(|| "true".to_owned());
    let text = |value: &Option<String>| value.clone();
    let pid = host_pid.map(|p| p.to_string());
    let fast = meta.fast.map(|f| f.to_string());
    let auto_effort = meta.auto_effort_off.then(|| "false".to_owned());
    if operation == "send" {
        put("tag", text(&meta.tag));
        put("sessionId", text(&meta.session_id));
        put("agent", text(&meta.agent));
        put("provider", text(&meta.provider));
        put("model", text(&meta.model));
        put("preset", text(&meta.preset));
        put("effort", text(&meta.effort));
        put("fast", fast);
        put("autoEffort", auto_effort);
        put("resumed", flag(meta.resumed));
        put("clientHostPid", pid);
    } else {
        put("respawned", flag(meta.respawned));
        put("resumed", flag(meta.resumed));
        put("tag", text(&meta.tag));
        put("sessionId", text(&meta.session_id));
        put("agent", text(&meta.agent));
        put("preset", text(&meta.preset));
        put("provider", text(&meta.provider));
        put("model", text(&meta.model));
        put("effort", text(&meta.effort));
        put("fast", fast);
        put("clientHostPid", pid);
        put("autoEffort", auto_effort);
    }
    lines
}

impl EarlyNotice {
    pub fn new(owner: Arc<dyn OwnerNotify>, clock: Arc<dyn Clock>) -> Self {
        Self { owner, clock }
    }

    /// `notifyOwnerAgentCompletionEarly`: `true` when the preview reached the owner.
    pub fn notify(&self, job: &JobHandle, value: &WorkerResult, context: &NotifyContext) -> bool {
        if job.early_notified() {
            return false;
        }
        let Some(task) = job.snapshot() else { return false };
        let owner = [&context.caller_session_id, &context.owner_session_id]
            .into_iter()
            .flatten()
            .find(|s| !s.is_empty())
            .map(|s| clean_str(s))
            .unwrap_or_default();
        if owner.is_empty() {
            return false;
        }
        // An abnormal-empty finish carries an `error`: the preview must not present it as a
        // benign `completed` card ahead of the `failed` reconcile.
        let status = if value.error.is_some() { "failed" } else { "completed" };
        let mut lines = vec!["background task".to_owned(), format!("task_id: {}", task.task_id), "surface: agent".to_owned()];
        if task.operation != "agent" {
            lines.push(format!("operation: {}", task.operation));
        }
        if let Some(label) = task.label.as_deref().filter(|l| !l.is_empty()) {
            lines.push(format!("label: {label}"));
        }
        lines.push(format!("status: {status}"));
        lines.push(format!("started: {}", iso_from_ms(task.started_ms)));
        lines.push(format!("finished: {}", iso_from_ms(self.clock.now_ms())));
        if let Some(error) = value.error.as_deref().filter(|e| !e.is_empty()) {
            lines.push(format!("error: {error}"));
        }
        lines.extend(meta_lines(&task.meta, &task.operation, job.host_pid()));
        let mut meta = json!({
            "type": "agent_task_result",
            "model_visible": false,
            "execution_surface": "agent",
            "execution_id": task.task_id,
            "status": status,
            "instruction": format!("Agent \"{}\" {status}", task.task_id),
        });
        meta["caller_session_id"] = Value::String(owner.clone());
        let delivered = self.owner.notify(&owner, &lines.join("\n"), &meta);
        if delivered {
            // Only a header-only preview fired; the board still owns the single body-carrying
            // notification.
            job.mark_early_notified();
        }
        delivered
    }
}
