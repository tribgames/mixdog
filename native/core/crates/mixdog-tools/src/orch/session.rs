//! `session`: inspect sessions or control another by exact id. Lead-only: the calling thread
//! must be a top-level (Lead or bot chat) thread. Cross-session actions go to
//! [`SessionPort::control`]; actions on the current session are small typed operations on the
//! same port. Replies are the JSON texts the model reads today.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use serde::Serialize;
use serde_json::Value;

use super::ports::CallerFacts;
use super::ports::HEARTBEAT_NO_HANDOFF;
use super::util::PortError;
use super::util::clean;
use super::util::compact;
use super::util::denied;
use super::util::action_failed;
use super::util::field;
use super::util::invalid;
use super::util::pretty;
use super::util::refused;
use super::util::spec_from_def;
use super::util::text;

const USER_TITLE_ERROR: &str = "session: the user already titled this session; the title was not changed";
/// Actions a heartbeat turn may take: read sessions and bots, record proposals.
const HEARTBEAT_ACTIONS: [&str; 5] = ["read", "status", "list", "bots", "suggest"];
const CONTROL_ACTIONS: [&str; 7] = ["list", "bots", "read", "send", "cancel", "delete", "create"];
/// Actions whose `session_id` may name a bot (its home chat).
const BOT_TARGET_ACTIONS: [&str; 5] = ["status", "read", "send", "bots", "list"];

/// A thread the session tool acts for: a top-level conversation, never a delegated worker.
fn is_top_level(surface: SurfaceKind) -> bool {
    matches!(surface, SurfaceKind::Lead | SurfaceKind::Bot)
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct TaskOrigin {
    pub session_id: String,
    pub agent_id: String,
}

/// Who is calling, from the session actor's own state.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SessionCaller {
    /// The bot whose attended conversation gets results reported back (empty otherwise).
    pub attended_agent: String,
    /// The bot the caller acts as, attended or not.
    pub acting_bot: String,
    pub task_origin: Option<TaskOrigin>,
    pub ai_titles_enabled: bool,
    /// Mixy's own chat, the only one `suggest` belongs to.
    pub is_mixy_chat: bool,
}

/// Everything a cross-session control action needs from the call.
#[derive(Clone, PartialEq, Debug)]
pub struct ControlCall {
    pub action: String,
    /// The call's arguments without `attachments`; `session_id` already resolved from a bot id.
    pub args: Value,
    pub caller_thread: ThreadId,
    pub caller: SessionCaller,
    pub cwd: String,
    /// Resolved attachments of `send` / `create`, as stored prompt parts.
    pub attachment_parts: Vec<Value>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum RenameError {
    UserTitle,
    Failed(String),
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub session_id: Option<String>,
    pub title: Option<String>,
    pub title_source: Option<String>,
    pub cwd: String,
    pub project: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub auto_effort: bool,
    pub fast: bool,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct ProjectRow {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SidebarFlag {
    Favorite,
    Archived,
}

#[async_trait]
pub trait SessionPort: Send + Sync {
    async fn caller(&self, thread: &ThreadId) -> SessionCaller;
    /// Whether `target` is the task's originating session or that agent's home chat.
    fn is_task_origin(&self, target: &str, origin: &TaskOrigin) -> bool;
    /// A bot id names that bot's home chat; every check and the control run on the chat it
    /// resolves to. Other ids come back unchanged.
    async fn resolve_target(&self, target: &str) -> Result<String, PortError>;
    /// `attachments` as stored prompt parts, resolved against the caller's conversation and
    /// folders; secret files are refused.
    async fn resolve_attachments(
        &self,
        thread: &ThreadId,
        names: &Value,
        cwd: &AbsPath,
        surface: &str,
    ) -> Result<Vec<Value>, PortError>;
    /// list, bots, read, send, cancel, delete, create and status of a target.
    async fn control(&self, call: ControlCall) -> Result<Value, PortError>;
    async fn status(&self, thread: &ThreadId, cwd: &AbsPath) -> SessionStatus;
    async fn list_projects(&self) -> Vec<ProjectRow>;
    /// Resolves `raw_path` against `cwd`, checks it is a directory and switches the Project;
    /// returns the new working directory.
    async fn set_project(&self, thread: &ThreadId, cwd: &AbsPath, raw_path: &str) -> Result<String, PortError>;
    async fn rename(&self, thread: &ThreadId, title: &str) -> Result<String, RenameError>;
    /// Compaction runs right after the current turn finishes.
    async fn schedule_compact(&self, thread: &ThreadId) -> Result<(), PortError>;
    /// Returns the new session id and whether the copy was compacted.
    async fn fork(&self, thread: &ThreadId, compact: bool) -> Result<(String, bool), PortError>;
    async fn sidebar(&self, thread: &ThreadId, flag: SidebarFlag, value: bool) -> Result<(), PortError>;
    /// Mixy's proposal to the user, kept so none repeats; returns the receipt fields.
    async fn suggest(&self, key: &str, text: &str, dismissed: bool) -> Result<Value, PortError>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Renamed<'a> {
    action: &'a str,
    session_id: &'a str,
    title: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Forked<'a> {
    action: &'a str,
    source_session_id: &'a str,
    session_id: &'a str,
    compacted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Compacting<'a> {
    action: &'a str,
    session_id: &'a str,
    scheduled: bool,
    note: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Projects<'a> {
    cwd: &'a str,
    projects: &'a [ProjectRow],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Switched<'a> {
    cwd: &'a str,
    session_id: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Sidebar<'a> {
    action: &'a str,
    session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    favorite: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archived: Option<bool>,
}

#[derive(Serialize)]
struct Suggested<'a> {
    action: &'a str,
    #[serde(flatten)]
    receipt: &'a Value,
}

pub struct SessionTool {
    spec: ToolSpec,
    port: Arc<dyn SessionPort>,
    facts: Arc<dyn CallerFacts>,
}

impl SessionTool {
    pub fn new(port: Arc<dyn SessionPort>, facts: Arc<dyn CallerFacts>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/session.json"), false, &[]), port, facts }
    }

    async fn control(&self, ctx: &ToolContext, args: &Value, action: &str, target: &str) -> ToolOutcome {
        let caller = self.port.caller(&ctx.thread_id).await;
        if action == "create" && caller.attended_agent.is_empty() {
            return Err(denied(
                "session: create belongs to a bot conversation; delegated workers, agent task sessions and schedule/webhook runs cannot create agent task sessions",
            ));
        }
        let resolved = if BOT_TARGET_ACTIONS.contains(&action) && !target.is_empty() {
            self.port.resolve_target(target).await?
        } else {
            target.to_owned()
        };
        // A task session reaches its agent only through its reported result.
        if action == "send"
            && let Some(origin) = &caller.task_origin
            && self.port.is_task_origin(&resolved, origin)
        {
            return Err(refused("task-origin", "session: a task session reports to its agent only through its result"));
        }
        let mut rest = args.clone();
        let attachments = rest.as_object_mut().and_then(|o| o.shift_remove("attachments"));
        if attachments.is_some() && action != "send" && action != "create" {
            return Err(invalid("attachments", format!("session: attachments apply to send and create, not action={action}")));
        }
        let attachment_parts = match &attachments {
            Some(names) => self.port.resolve_attachments(&ctx.thread_id, names, &ctx.cwd, "session").await?,
            None => Vec::new(),
        };
        if resolved != target
            && let Some(o) = rest.as_object_mut()
        {
            o.insert("session_id".to_owned(), Value::String(resolved));
        }
        let value = self
            .port
            .control(ControlCall {
                action: action.to_owned(),
                args: rest,
                caller_thread: ctx.thread_id.clone(),
                caller,
                cwd: ctx.cwd.as_path().to_string_lossy().into_owned(),
                attachment_parts,
            })
            .await?;
        text(compact(&value))
    }
}

#[async_trait]
impl Tool for SessionTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let thread = &ctx.thread_id;
        let target = field(&args, "session_id");
        let raw_action = field(&args, "action");
        let action = if raw_action.is_empty() {
            if field(&args, "path").is_empty() { "status" } else { "set-project" }.to_owned()
        } else {
            raw_action.to_lowercase()
        };
        let action = action.as_str();
        if self.facts.is_heartbeat(thread).await && !HEARTBEAT_ACTIONS.contains(&action) {
            let why = if matches!(action, "create" | "send") {
                HEARTBEAT_NO_HANDOFF.to_owned()
            } else {
                format!("a heartbeat turn only reads sessions and bots and records proposals; action={action} is refused")
            };
            return Err(refused("heartbeat", format!("session: {why}")));
        }
        let lead = || {
            if is_top_level(ctx.surface) {
                Ok(())
            } else {
                Err(denied(format!("session: {action} belongs to the Lead session")))
            }
        };
        if CONTROL_ACTIONS.contains(&action) || (action == "status" && !target.is_empty()) {
            lead()?;
            return self.control(ctx, &args, action, &target).await;
        }
        if action == "suggest" {
            lead()?;
            let caller = self.port.caller(thread).await;
            if !caller.is_mixy_chat && !self.facts.is_heartbeat(thread).await {
                return Err(denied("session: suggest belongs to Mixy's chat"));
            }
            let receipt = self
                .port
                .suggest(&field(&args, "key"), &field(&args, "title"), args.get("value") == Some(&Value::Bool(false)))
                .await?;
            return text(pretty(&Suggested { action, receipt: &receipt }));
        }
        if !target.is_empty() {
            lead()?;
            if target != thread.as_str() {
                return Err(denied(format!("session: action={action} only applies to the current session")));
            }
        }
        let session_id = thread.as_str();
        match action {
            "favorite" | "archive" => {
                lead()?;
                let Some(value) = args.get("value").and_then(Value::as_bool) else {
                    return Err(invalid("value", format!("session: value (boolean) is required for action={action}")));
                };
                let flag = if action == "favorite" { SidebarFlag::Favorite } else { SidebarFlag::Archived };
                self.port
                    .sidebar(thread, flag, value)
                    .await
                    .map_err(|e| action_failed("session", format!("session: {action} failed ({})", port_reason(&e))))?;
                let (favorite, archived) = match flag {
                    SidebarFlag::Favorite => (Some(value), None),
                    SidebarFlag::Archived => (None, Some(value)),
                };
                text(pretty(&Sidebar { action, session_id, favorite, archived }))
            }
            "rename" => {
                lead()?;
                if !self.port.caller(thread).await.ai_titles_enabled {
                    return Err(refused("ai-titles", "session: AI session titles are disabled in settings"));
                }
                let title = field(&args, "title");
                if title.is_empty() {
                    return Err(invalid("title", "session: title is required for action=rename"));
                }
                match self.port.rename(thread, &title).await {
                    Ok(stored) => text(pretty(&Renamed { action, session_id, title: &stored })),
                    Err(RenameError::UserTitle) => Err(refused("user-title", USER_TITLE_ERROR)),
                    Err(RenameError::Failed(reason)) => Err(action_failed("session", format!("session: rename failed ({reason})"))),
                }
            }
            "compact" => {
                lead()?;
                self.port.schedule_compact(thread).await?;
                text(pretty(&Compacting {
                    action,
                    session_id,
                    scheduled: true,
                    note: "Compaction runs right after the current turn finishes.",
                }))
            }
            "fork" => {
                lead()?;
                let (new_id, compacted) = self.port.fork(thread, args.get("compact") == Some(&Value::Bool(true))).await?;
                text(pretty(&Forked { action, source_session_id: session_id, session_id: &new_id, compacted }))
            }
            "status" => {
                lead()?;
                text(pretty(&self.port.status(thread, &ctx.cwd).await))
            }
            "list-projects" => {
                lead()?;
                let projects = self.port.list_projects().await;
                text(pretty(&Projects { cwd: &ctx.cwd.as_path().to_string_lossy(), projects: &projects }))
            }
            "set-project" => {
                lead()?;
                let raw = clean(args.get("path"));
                if raw.is_empty() {
                    return Err(invalid("path", "session: path is required for action=set-project"));
                }
                let cwd = self.port.set_project(thread, &ctx.cwd, &raw).await?;
                text(pretty(&Switched { cwd: &cwd, session_id }))
            }
            other => Err(invalid("action", format!("session: unknown action \"{other}\""))),
        }
    }
}

fn port_reason(error: &PortError) -> String {
    match error {
        PortError::Failed { message: m, .. } | PortError::Denied(m) => m.clone(),
        PortError::Refused { message, .. } | PortError::Unavailable { message, .. } | PortError::NotFound { message, .. } => message.clone(),
        PortError::Invalid { reason, .. } => reason.clone(),
        PortError::Cancelled => "cancelled".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_keep_the_documented_key_order() {
        assert_eq!(
            pretty(&Forked { action: "fork", source_session_id: "a", session_id: "b", compacted: false }),
            "{\n  \"action\": \"fork\",\n  \"sourceSessionId\": \"a\",\n  \"sessionId\": \"b\",\n  \"compacted\": false\n}"
        );
        assert_eq!(
            pretty(&Sidebar { action: "archive", session_id: "s", favorite: None, archived: Some(true) }),
            "{\n  \"action\": \"archive\",\n  \"sessionId\": \"s\",\n  \"archived\": true\n}"
        );
        assert_eq!(
            compact(&Switched { cwd: "C:/p", session_id: "s" }),
            "{\"cwd\":\"C:/p\",\"sessionId\":\"s\"}"
        );
    }

    #[test]
    fn delegated_workers_are_not_top_level() {
        assert!(is_top_level(SurfaceKind::Lead) && is_top_level(SurfaceKind::Bot));
        assert!(!is_top_level(SurfaceKind::Agent) && !is_top_level(SurfaceKind::Readonly));
    }
}
