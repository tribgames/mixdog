//! The channel bridge's own tools: `activate_channel_bridge`, `reload_config`,
//! `rename_schedule`. Results are the tool envelope `{content:[{type:"text",text}], isError?}`.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{Value, json};

use super::running::{RunningWork, WorkGuard};
use crate::scheduler::ScheduleError;

pub const ACTIVATE_TOOL: &str = "activate_channel_bridge";

#[async_trait]
pub trait ChannelLifecycle: Send + Sync {
    fn bridge_active(&self) -> bool;
    async fn set_bridge_active(&self, active: bool);
    async fn start_bridge(&self) -> Result<(), String>;
    async fn stop_owned_runtime(&self, reason: &str) -> Result<(), String>;
    /// Re-registers schedules, webhooks and events; returns the suffix naming any
    /// further reloaded parts (", agent providers/presets/maintenance") or "".
    async fn reload_config(&self) -> Result<String, String>;
    /// Moves a schedule row; the scheduler's owner calls `Scheduler::rename_locked`.
    async fn rename_schedule(&self, name: &str, def: &Value, timing_changed: bool) -> Result<Value, ScheduleError>;
}

pub fn text_result(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

pub fn error_result(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": true })
}

pub struct ToolDispatch {
    lifecycle: Arc<dyn ChannelLifecycle>,
    work: RunningWork,
    degraded: Box<dyn Fn() -> bool + Send + Sync>,
    /// Held while the bridge is active: an active channel keeps the core alive.
    active_guard: Mutex<Option<WorkGuard>>,
}

impl ToolDispatch {
    pub fn new(
        lifecycle: Arc<dyn ChannelLifecycle>,
        work: RunningWork,
        degraded: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        Self { lifecycle, work, degraded, active_guard: Mutex::new(None) }
    }

    pub async fn handle_tool_call(&self, name: &str, args: &Value) -> Value {
        if (self.degraded)() {
            return error_result(format!("[channels degraded] {name} unavailable — restart MCP to recover"));
        }
        match self.dispatch(name, args).await {
            Ok(result) => result,
            Err(err) => {
                let mut result = error_result(format!("{name} failed: {err}"));
                // A schedule refusal keeps its code and public name; nothing else crosses.
                if let Some((code, public_name)) = err.code_fields() {
                    result["code"] = code.into();
                    if let Some(n) = public_name.filter(|n| !n.is_empty()) {
                        result["details"] = json!({ "name": n });
                    }
                }
                result
            }
        }
    }

    async fn dispatch(&self, name: &str, args: &Value) -> Result<Value, ScheduleError> {
        match name {
            ACTIVATE_TOOL => {
                let active = args["active"] == Value::Bool(true);
                let was_active = self.lifecycle.bridge_active();
                self.lifecycle.set_bridge_active(active).await;
                *self.active_guard.lock().unwrap() = active.then(|| self.work.begin());
                if active {
                    if let Err(err) = self.lifecycle.start_bridge().await {
                        tracing::warn!("bridge activate refresh failed (non-fatal): {err}");
                    }
                } else if was_active
                    // Tear the owner side down so scheduler/webhook/event-pipeline do not
                    // keep running on a deactivated bridge.
                    && let Err(err) = self.lifecycle.stop_owned_runtime("bridge deactivated").await
                {
                    tracing::warn!("stop owned runtime on deactivate failed: {err}");
                }
                Ok(text_result(format!("channel bridge {}", if active { "activated" } else { "deactivated" })))
            }
            "reload_config" => {
                let suffix = self.lifecycle.reload_config().await.map_err(ScheduleError::Run)?;
                Ok(text_result(format!("config reloaded — schedules, webhooks, events{suffix} re-registered")))
            }
            "rename_schedule" => {
                let old = args["name"].as_str().unwrap_or_default();
                let saved =
                    self.lifecycle.rename_schedule(old, &args["def"], args["timingChanged"] == Value::Bool(true)).await?;
                Ok(text_result(saved.to_string()))
            }
            _ => Ok(error_result(format!("unknown tool: {name}"))),
        }
    }
}
