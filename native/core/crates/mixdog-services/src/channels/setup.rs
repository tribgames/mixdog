//! The `setup` tool's automation actions (`save_automation`, `delete_automation`,
//! `set_automation_enabled`, `run_automation`, `set_webhook_config`): the chat-facing door of
//! [`ChannelAdmin`], ported from `setup-tool/extended-actions.mjs`, with the access rules of
//! `services/schedule-access.mjs`. [`AutomationSetup::run`] has the shape of the core's
//! `SetupActions::run`, so the composition root registers it with a six-line adapter.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use mixdog_protocol::ThreadId;
use mixdog_tools::orch::util::PortError;
use serde_json::{Map, Value, json};

use super::admin::ChannelAdmin;
use crate::bots::ids::MIXY_AGENT_ID;

pub const AUTOMATION_ACTIONS: &[&str] =
    &["save_automation", "delete_automation", "set_automation_enabled", "run_automation", "set_webhook_config"];

/// `SETUP_EXTENDED_PROPERTIES.entry.properties`, in declaration order: the keys an automation
/// entry carries (the order is the order of the result's keys).
const ENTRY_KEYS: [&str; 15] = [
    "name", "newName", "description", "instructions", "time", "at", "timezone", "days", "parser", "cwd",
    "attachments", "enabled", "owner", "executorAgentId", "overwrite",
];

/// `scheduleCallerScope` of the calling session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessScope {
    Human,
    Agent { agent_id: String },
    RoomMember,
    Headless,
}

/// `listAgents`: the ids of the agents that exist, where a human may move an automation.
#[async_trait]
pub trait AgentDirectory: Send + Sync {
    async fn agent_ids(&self) -> Vec<String>;
}

/// The runtime calls the handlers make (`rt.*` of the Node handlers). `enabled` and `patch`
/// are passed as the caller gave them (absent = `None`), exactly like Node's `args.enabled`.
#[async_trait]
pub trait AutomationAdmin: Send + Sync {
    async fn get_channel_setup(&self) -> Result<Value, String>;
    async fn save_schedule(&self, entry: &Value) -> Result<Value, String>;
    async fn save_webhook(&self, entry: &Value) -> Result<Value, String>;
    async fn delete_schedule(&self, name: &str) -> Result<Value, String>;
    async fn delete_webhook(&self, name: &str) -> Result<Value, String>;
    async fn set_schedule_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String>;
    async fn set_webhook_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String>;
    async fn run_schedule_now(&self, name: &str) -> Result<Value, String>;
    async fn run_webhook_now(&self, name: &str) -> Result<Value, String>;
    async fn set_webhook_config(&self, patch: Option<&Value>) -> Result<Value, String>;
}

#[async_trait]
impl AutomationAdmin for ChannelAdmin {
    async fn get_channel_setup(&self) -> Result<Value, String> {
        ChannelAdmin::get_channel_setup(self).await.map_err(|e| e.to_string())
    }
    async fn save_schedule(&self, entry: &Value) -> Result<Value, String> {
        ChannelAdmin::save_schedule(self, entry).await.map_err(|e| e.to_string())
    }
    async fn save_webhook(&self, entry: &Value) -> Result<Value, String> {
        ChannelAdmin::save_webhook(self, entry).await.map_err(|e| e.to_string())
    }
    async fn delete_schedule(&self, name: &str) -> Result<Value, String> {
        ChannelAdmin::delete_schedule(self, name).await.map_err(|e| e.to_string())
    }
    async fn delete_webhook(&self, name: &str) -> Result<Value, String> {
        ChannelAdmin::delete_webhook(self, name).await.map_err(|e| e.to_string())
    }
    async fn set_schedule_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
        ChannelAdmin::set_schedule_enabled(self, name, enabled != Some(&Value::Bool(false))).await.map_err(|e| e.to_string())
    }
    async fn set_webhook_enabled(&self, name: &str, enabled: Option<&Value>) -> Result<Value, String> {
        ChannelAdmin::set_webhook_enabled(self, name, enabled != Some(&Value::Bool(false))).await.map_err(|e| e.to_string())
    }
    async fn run_schedule_now(&self, name: &str) -> Result<Value, String> {
        ChannelAdmin::run_schedule_now(self, name).await.map_err(|e| e.to_string())
    }
    async fn run_webhook_now(&self, name: &str) -> Result<Value, String> {
        ChannelAdmin::run_webhook_now(self, name).await.map_err(|e| e.to_string())
    }
    async fn set_webhook_config(&self, patch: Option<&Value>) -> Result<Value, String> {
        ChannelAdmin::set_webhook_config(self, patch.unwrap_or(&Value::Null)).await.map_err(|e| e.to_string())
    }
}

pub struct AutomationSetup {
    admin: Arc<dyn AutomationAdmin>,
    agents: Arc<dyn AgentDirectory>,
}

fn own(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|o| o.contains_key(key))
}

/// `String(value ?? '')`.
fn text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

fn failed(message: String) -> PortError {
    PortError::Failed { capability: "setup".into(), message }
}

fn error(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "setup".into(), message: message.into() }
}

fn denied(message: impl Into<String>) -> PortError {
    PortError::Denied(message.into())
}

/// `pick(value, keys)`: the own keys of `value` among `keys`, in `keys` order.
fn pick(value: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter().filter_map(|k| value.get(*k).map(|v| ((*k).to_string(), v.clone()))).collect()
}

/// `publicAutomation`: the entry keys plus the derived timing and secret flag; an attachment
/// is shown by kind, name, type and size only.
fn public_automation(row: &Value) -> Map<String, Value> {
    let mut out = pick(row, &ENTRY_KEYS);
    out.extend(pick(row, &["whenAt", "whenCron", "secretSet"]));
    if let Some(Value::Array(items)) = out.get("attachments").cloned() {
        let shown = items.iter().map(|a| {
            let mut m = pick(a, &["kind", "name", "mimeType"]);
            m.insert("stored".into(), Value::Bool(true));
            let data = match a.get("data") {
                None | Some(Value::Null) => String::new(),
                Some(Value::Bool(false)) => "false".into(),
                Some(d) => mixdog_js::value_to_string(d),
            };
            m.insert("size".into(), mixdog_js::utf16_len(&data).into());
            Value::Object(m)
        });
        out.insert("attachments".into(), Value::Array(shown.collect()));
    }
    out
}

/// `assertAutomationAccess`.
pub(crate) fn assert_access(
    scope: &AccessScope,
    kind: &str,
    action: &str,
    current: Option<&Value>,
    owner: &str,
    agent_ids: &[String],
) -> Result<(), PortError> {
    let (AccessScope::Human | AccessScope::Agent { .. }) = scope else {
        return Err(denied(if *scope == AccessScope::RoomMember {
            format!("A group-room member cannot {action} {kind}s")
        } else {
            format!("A background run cannot {action} {kind}s")
        }));
    };
    let requested = mixdog_js::js_trim(owner);
    let saved = current
        .map(|c| c.get("owner").and_then(Value::as_str).filter(|o| !o.is_empty()).unwrap_or(MIXY_AGENT_ID))
        .unwrap_or("");
    if let AccessScope::Agent { agent_id } = scope {
        if let Some(c) = current
            && saved != agent_id
        {
            let label = if kind == "webhook" { "Webhook" } else { "Schedule" };
            let name = c.get("name").map(mixdog_js::value_to_string).unwrap_or_default();
            return Err(denied(format!(
                "{label} \"{name}\" belongs to another agent; this thread manages only its own {kind}s"
            )));
        }
        if !requested.is_empty() && requested != agent_id {
            return Err(denied(format!("This thread cannot give a {kind} to another agent")));
        }
        return Ok(());
    }
    if !requested.is_empty()
        && requested != saved
        && requested != MIXY_AGENT_ID
        && !agent_ids.iter().any(|id| id == requested)
    {
        return Err(denied(format!("Agent \"{requested}\" does not exist")));
    }
    Ok(())
}

/// `new Date(whenAt).toISOString()`.
fn iso(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|t| t.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true))
}

impl AutomationSetup {
    pub fn new(admin: Arc<dyn AutomationAdmin>, agents: Arc<dyn AgentDirectory>) -> Self {
        Self { admin, agents }
    }

    pub fn actions(&self) -> &'static [&'static str] {
        AUTOMATION_ACTIONS
    }

    /// `automationRow`: the listed row of the named automation.
    async fn row(&self, kind: &str, name: &str) -> Result<Option<Value>, PortError> {
        let setup = self.admin.get_channel_setup().await.map_err(failed)?;
        let rows = setup[if kind == "schedule" { "schedules" } else { "webhooks" }].as_array().cloned().unwrap_or_default();
        Ok(rows.into_iter().find(|row| row["name"] == name))
    }

    /// `authorizeAutomation`.
    async fn authorize(
        &self,
        scope: &AccessScope,
        kind: &str,
        action: &str,
        current: Option<&Value>,
        owner: &str,
    ) -> Result<(), PortError> {
        let transfer = mixdog_js::js_trim(owner);
        let agents = if !transfer.is_empty() && *scope == AccessScope::Human { self.agents.agent_ids().await } else { Vec::new() };
        assert_access(scope, kind, action, current, transfer, &agents)
    }

    /// One setup action. `thread` is the calling session's id, `scope` its `scheduleCallerScope`.
    pub async fn run(&self, action: &str, args: &Value, thread: &ThreadId, scope: &AccessScope) -> Result<Value, PortError> {
        let kind = text(args.get("automationKind"));
        let name = text(args.get("name"));
        match action {
            "save_automation" => self.save(thread, scope, &kind, args.get("entry").unwrap_or(&Value::Null)).await,
            "delete_automation" => {
                let current = self.row(&kind, &name).await?.ok_or_else(|| error("Automation entry not found"))?;
                self.authorize(scope, &kind, "delete", Some(&current), "").await?;
                let result = if kind == "schedule" { self.admin.delete_schedule(&name).await } else { self.admin.delete_webhook(&name).await };
                let mut out = result.map_err(failed)?.as_object().cloned().unwrap_or_default();
                out.insert("recovery".into(), "The automation record is deleted; recreating it requires its definition.".into());
                Ok(Value::Object(out))
            }
            "set_automation_enabled" => {
                let current = self.row(&kind, &name).await?.ok_or_else(|| error("Automation entry not found"))?;
                let enabled = args.get("enabled");
                let verb = if enabled == Some(&Value::Bool(false)) { "pause" } else { "resume" };
                self.authorize(scope, &kind, verb, Some(&current), "").await?;
                let result = if kind == "schedule" {
                    self.admin.set_schedule_enabled(&name, enabled).await
                } else {
                    self.admin.set_webhook_enabled(&name, enabled).await
                };
                result.map_err(failed)
            }
            "run_automation" => {
                let current = self.row(&kind, &name).await?.ok_or_else(|| error("Automation entry not found"))?;
                self.authorize(scope, &kind, "run", Some(&current), "").await?;
                if kind == "webhook" && current["hasLastPayload"] != Value::Bool(true) {
                    return Err(error(format!("webhook \"{name}\" has not received a payload yet")));
                }
                // Starts the run and returns at once: the run is its own session.
                let admin = Arc::clone(&self.admin);
                let run_name = name.clone();
                // The outcome is dropped: the result posts into the owner's thread.
                let is_webhook = kind == "webhook";
                tokio::spawn(async move {
                    let _ = if is_webhook { admin.run_webhook_now(&run_name).await } else { admin.run_schedule_now(&run_name).await };
                });
                Ok(json!({
                    "name": args.get("name").cloned().unwrap_or(Value::Null),
                    "started": true,
                    "note": "The run is its own session; its result posts into the owning agent's thread when it finishes."
                }))
            }
            "set_webhook_config" => {
                self.admin.set_webhook_config(args.get("webhook")).await.map_err(failed)?;
                let status = self.admin.get_channel_setup().await.map_err(failed)?;
                Ok(json!({"webhook": Value::Object(pick(&status["webhook"], &["enabled", "port", "domain"]))}))
            }
            other => Err(PortError::Unavailable {
                capability: format!("setup.{other}"),
                message: format!("setup {other} is not served by the automation owner"),
            }),
        }
    }

    async fn save(&self, thread: &ThreadId, scope: &AccessScope, kind: &str, input: &Value) -> Result<Value, PortError> {
        if kind == "webhook" && ["time", "at", "timezone", "days"].iter().any(|k| own(input, k)) {
            return Err(error("Schedule fields (timing) are not accepted for webhooks"));
        }
        if kind == "webhook" && own(input, "newName") {
            return Err(error("newName (rename) is schedule-only"));
        }
        if kind == "schedule" && own(input, "parser") {
            return Err(error("parser is a webhook-only field"));
        }
        let overwrite = input.get("overwrite").is_some_and(crate::channels::ports::is_truthy);
        let mut previous = Value::Object(Map::new());
        if overwrite {
            let name = text(input.get("name"));
            previous = self.row(kind, &name).await?.ok_or_else(|| error(format!("{kind} \"{name}\" does not exist")))?;
        }
        let owner = text(input.get("owner"));
        self.authorize(scope, kind, if overwrite { "edit" } else { "create" }, overwrite.then_some(&previous), &owner).await?;

        let mut next = pick(&previous, &ENTRY_KEYS);
        if let Some(fields) = input.as_object() {
            next.extend(fields.clone());
        }
        // Omitted keeps the saved executor without checking it again.
        if !own(input, "executorAgentId") {
            next.shift_remove("executorAgentId");
        }
        if kind == "schedule" {
            if let Some(when) = previous.get("whenAt").and_then(Value::as_str).filter(|w| !w.is_empty())
                && !own(input, "time")
                && !own(input, "at")
            {
                let at = iso(when).ok_or_else(|| error("Invalid time value"))?;
                next.insert("at".into(), at.into());
                next.shift_remove("time");
            }
            if own(input, "time") && !own(input, "at") {
                next.shift_remove("at");
            }
            if own(input, "at") && !own(input, "time") {
                next.shift_remove("time");
            }
        }
        // An automation created from an agent's home thread belongs to that agent.
        if !overwrite && !own(input, "owner") {
            let home = mixdog_store::agent_mode::agent_id_of_home_session(thread.as_str());
            if !home.is_empty() {
                next.insert("owner".into(), home.into());
            }
        }
        let next = Value::Object(next);
        let result = if kind == "schedule" { self.admin.save_schedule(&next).await } else { self.admin.save_webhook(&next).await };
        let mut out = public_automation(&result.map_err(failed)?);
        if kind == "webhook" {
            out.insert("secretSet".into(), Value::Bool(true));
            out.insert(
                "credentialHandoff".into(),
                "The signing secret is never returned here or shown again. Open the Webhooks panel, edit this webhook, press Regenerate secret, copy the new value, and save."
                    .into(),
            );
        }
        Ok(Value::Object(out))
    }
}
