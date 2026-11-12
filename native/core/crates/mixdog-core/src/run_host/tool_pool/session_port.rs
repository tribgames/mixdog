//! `SessionPort` over the session directory: what the `session` and `agent` tools do to the
//! calling session and to another one, as Node's `session-runtime/internal-tool-executor/
//! workspace-tools.mjs` does it.
//!
//! The caller's own session (status, rename, fork, sidebar, project) is served from its header
//! and the `thread/*` requests; another session (`control`) from the same requests.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_agent::agent_tool::scope::resolve_path;
use mixdog_core_agents::agents::AgentDefinitions;
use mixdog_core_agents::agents::ContactIds;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_config::config::Config;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::threads::port_error;
use mixdog_protocol::ThreadItem;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::session_title::AiTitle;
use mixdog_core_session::session::session_title::StoredTitles;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneToken;
use mixdog_services::bots::beat::Change;
use mixdog_services::bots::beat::HeartbeatStore;
use mixdog_store::schema::record::Header;
use mixdog_tools::orch::session::ControlCall;
use mixdog_tools::orch::session::ProjectRow;
use mixdog_tools::orch::session::RenameError;
use mixdog_tools::orch::session::SessionCaller;
use mixdog_tools::orch::session::SessionPort;
use mixdog_tools::orch::session::SessionStatus;
use mixdog_tools::orch::session::SidebarFlag;
use mixdog_tools::orch::session::TaskOrigin;
use mixdog_tools::orch::util::PortError;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::callers::ThreadCallers;
use super::session_output::range_of;
use super::session_output::row_of;
use super::session_output::session_read_output;
use mixdog_js::js_trim;

/// Requests to a thread, open or not (`CallContext::internal`): the directory seen as the tools
/// see it.
#[async_trait]
pub trait ThreadRequests: Send + Sync {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError>;
    /// The user's interrupt of the turn running in `thread` (`abortSession`): whether one was.
    fn interrupt(&self, thread: &ThreadId) -> Result<bool, CoreError>;
    /// `rt.pendingCompactSessionIds.add(id)`: `thread` compacts once, when its running turn settles.
    fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), CoreError>;
    /// The stored transcript of `thread`, oldest first (`service.readSession({ transcriptRange })`'s rows).
    async fn transcript(&self, thread: &ThreadId) -> Result<Vec<ThreadItem>, CoreError>;
}

#[async_trait]
impl ThreadRequests for SessionDirectory {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let ctx = CallContext::internal("session-tool");
        let handle = self.open_handle(thread, &ctx).await?;
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        match handle.request(CoreRequest { method: Method(method), params, op: Some(op), ctx }).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Ok(Value::Null),
        }
    }

    fn interrupt(&self, thread: &ThreadId) -> Result<bool, CoreError> {
        self.interrupt_running_turn(thread)
    }

    fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), CoreError> {
        self.schedule_compact_after_turn(thread)
    }

    async fn transcript(&self, thread: &ThreadId) -> Result<Vec<ThreadItem>, CoreError> {
        self.transcript_items(thread).await
    }
}

/// The Settings switch of AI session titles (`rt.config?.aiSessionTitles !== false`).
pub trait AiTitleSetting: Send + Sync {
    fn enabled(&self) -> bool;
}

impl AiTitleSetting for Config {
    fn enabled(&self) -> bool {
        self.agent().get("aiSessionTitles") != Some(&Value::Bool(false))
    }
}

/// `listProjects()` (`runtime/shared/projects.mjs`): the projects the user registered.
#[async_trait]
pub trait ProjectList: Send + Sync {
    async fn list(&self) -> Vec<ProjectRow>;
}

/// The ids of the bots a send can reach besides Mixy: every contact agent (`defaultListBots`).
#[async_trait]
pub trait BotIds: Send + Sync {
    async fn ids(&self) -> Result<Vec<String>, String>;
}

/// [`BotIds`] over the agent definitions: each custom agent that is a contact, its kind read
/// afresh.
pub struct ContactBotIds {
    agents: Arc<AgentDefinitions>,
    contacts: Arc<ContactIds>,
}

impl ContactBotIds {
    pub fn new(agents: Arc<AgentDefinitions>, contacts: Arc<ContactIds>) -> Self {
        Self { agents, contacts }
    }
}

#[async_trait]
impl BotIds for ContactBotIds {
    async fn ids(&self) -> Result<Vec<String>, String> {
        let mut ids = Vec::new();
        for id in self.agents.custom_agent_ids().await.map_err(|e| e.to_string())? {
            if self.contacts.is_contact_bot(&id).await {
                ids.push(id);
            }
        }
        Ok(ids)
    }
}

/// Mixy's proposals to the user (`recordSuggestion`): kept so none repeats.
#[async_trait]
pub trait Suggestions: Send + Sync {
    /// The receipt of the record.
    async fn record(&self, key: &str, text: &str, dismissed: bool) -> Result<Value, String>;
}

/// [`Suggestions`] in the heartbeat state, stamped by `now_ms`.
pub struct HeartbeatSuggestions {
    store: Arc<HeartbeatStore>,
    now_ms: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl HeartbeatSuggestions {
    pub fn new(store: Arc<HeartbeatStore>, now_ms: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { store, now_ms }
    }
}

#[async_trait]
impl Suggestions for HeartbeatSuggestions {
    async fn record(&self, key: &str, text: &str, dismissed: bool) -> Result<Value, String> {
        self.store.update(Change::Suggest { key: key.to_owned(), text: text.to_owned(), dismissed, at: (self.now_ms)() }).await
    }
}

/// The unwired inputs of the port that name a process service.
pub struct SessionPortParts {
    pub callers: Arc<ThreadCallers>,
    pub threads: Arc<dyn ThreadState>,
    pub requests: Arc<dyn ThreadRequests>,
    pub titles: Arc<StoredTitles>,
    pub ai_titles: Arc<dyn AiTitleSetting>,
    pub projects: Arc<dyn ProjectList>,
    pub bots: Arc<dyn BotIds>,
    pub suggestions: Arc<dyn Suggestions>,
    pub io: InteractiveIo,
}

pub struct DirectorySessionPort {
    parts: SessionPortParts,
}

fn failed(message: impl Into<String>) -> PortError {
    PortError::Failed { capability: "session".to_owned(), message: message.into() }
}

fn core(error: CoreError) -> PortError {
    port_error(error)
}

/// A header field, `None` unless JS-truthy (`current?.title || null`).
fn field(header: &Header, key: &str) -> Option<String> {
    truthy(header.get(key)).then(|| mixdog_js::value_to_string(&header[key]))
}

fn nested(header: &Header, outer: &str, key: &str) -> Option<String> {
    header.get(outer).and_then(|o| o.get(key)).filter(|v| truthy(Some(v))).map(mixdog_js::value_to_string)
}

impl DirectorySessionPort {
    pub fn new(parts: SessionPortParts) -> Self {
        Self { parts }
    }

    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        self.parts.threads.header(thread).await
    }

    /// `session action=read` (`targetRequest` and `sessionReadOutput`): a window of another session's transcript, counted
    /// from its newest row, each row quoted with its own text window.
    async fn read(&self, call: &ControlCall) -> Result<Value, PortError> {
        let invalid = |field: &str, reason: &str| PortError::Invalid { field: field.to_owned(), reason: reason.to_owned() };
        let id = call.args.get("session_id").and_then(Value::as_str).map(js_trim).unwrap_or_default();
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return Err(invalid("session_id", "session: session_id is required for action=read"));
        }
        let given = |key: &str| call.args.get(key).filter(|v| !v.is_null());
        let whole = |value: &Value| value.as_f64().filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0);
        let limit = match given("limit") {
            None => 25.0,
            Some(value) => whole(value).filter(|n| (1.0..=100.0).contains(n)).ok_or_else(|| invalid("limit", "session: limit must be an integer from 1 to 100"))?,
        };
        let offset = match given("offset") {
            None => 0.0,
            Some(value) => whole(value).filter(|n| *n >= 0.0 && n + limit <= 9_007_199_254_740_991.0).ok_or_else(|| invalid("offset", "session: offset must be a nonnegative safe integer"))?,
        };
        let text_offset = match given("text_offset") {
            None => 0.0,
            Some(value) => whole(value).filter(|n| *n >= 0.0).ok_or_else(|| invalid("text_offset", "session: invalid text_offset"))?,
        };
        let item_id = given("item_id").map(mixdog_js::value_to_string).filter(|id| !id.is_empty());
        if given("text_offset").is_some() && (given("offset").is_none() || limit != 1.0 || item_id.is_none()) {
            return Err(invalid("text_offset", "session: text_offset requires offset, limit:1 and item_id from read"));
        }
        let target = ThreadId::from(id);
        self.header(&target).await?;
        let items = self.parts.requests.transcript(&target).await.map_err(core)?;
        let range = range_of(items.iter().filter_map(row_of).collect(), offset as u64, limit as u64);
        session_read_output(id, &range, text_offset as usize, item_id.as_deref()).map_err(failed)
    }
}

#[async_trait]
impl SessionPort for DirectorySessionPort {
    async fn caller(&self, thread: &ThreadId) -> SessionCaller {
        let mut caller = SessionCaller {
            ai_titles_enabled: self.parts.ai_titles.enabled(),
            is_mixy_chat: agent_home_session_id(MIXY_AGENT_ID).as_deref() == Some(thread.as_str()),
            ..SessionCaller::default()
        };
        let Ok(header) = self.header(thread).await else {
            return caller;
        };
        let mut record = header.clone();
        record.insert("id".to_owned(), json!(thread.as_str()));
        let (mode, agent) = mixdog_core_run::run_host::route_chain::resolve_session_mode(&Value::Object(record));
        if mode == "agent" {
            caller.acting_bot = agent.clone();
            // `attendedAgentOf`: only a conversation a person is in (not a delegated worker, a
            // task session or an unattended run).
            if !matches!(self.parts.callers.scope(thread).await, CallerScope::Headless | CallerScope::Agent { unattended: true, .. }) {
                caller.attended_agent = agent;
            }
        }
        caller.task_origin = header.get("taskOrigin").filter(|o| truthy(Some(o))).map(|o| TaskOrigin {
            session_id: o.get("sessionId").map(mixdog_js::value_to_string).unwrap_or_default(),
            agent_id: o.get("agentId").map(mixdog_js::value_to_string).unwrap_or_default(),
        });
        caller
    }

    fn is_task_origin(&self, target: &str, origin: &TaskOrigin) -> bool {
        target == origin.session_id || agent_id_of_home_session(target).unwrap_or_default() == origin.agent_id
    }

    async fn resolve_target(&self, target: &str) -> Result<String, PortError> {
        let Some(home) = agent_home_session_id(target) else {
            return Ok(target.to_owned());
        };
        let known = target == MIXY_AGENT_ID || self.parts.bots.ids().await.map_err(failed)?.iter().any(|id| id == target);
        Ok(if known { home } else { target.to_owned() })
    }

    async fn resolve_attachments(&self, _: &ThreadId, _: &Value, _: &AbsPath, _: &str) -> Result<Vec<Value>, PortError> {
        Err(PortError::Unavailable {
            capability: "attachments".to_owned(),
            message: "session: attachments cannot be resolved in this runtime".to_owned(),
        })
    }

    async fn control(&self, call: ControlCall) -> Result<Value, PortError> {
        let session_id = || call.args.get("session_id").map(mixdog_js::value_to_string).map(|s| mixdog_js::js_trim(&s).to_owned()).unwrap_or_default();
        match call.action.as_str() {
            "cancel" => {
                let target = ThreadId::from(session_id());
                let aborted = self.parts.requests.interrupt(&target).map_err(core)?;
                Ok(json!({ "sessionId": target.as_str(), "aborted": aborted }))
            }
            "delete" => {
                let target = ThreadId::from(session_id());
                let params = json!({ "threadId": target.as_str(), "opId": uuid::Uuid::now_v7().to_string() });
                let deleted = self.parts.requests.request(&target, "thread/delete", params).await.map_err(core)?;
                Ok(json!({ "sessionId": target.as_str(), "deleted": deleted == Value::Bool(true) }))
            }
            "read" => self.read(&call).await,
            other => Err(PortError::Unavailable {
                capability: "session-control".to_owned(),
                message: format!("session: action={other} is not available in this runtime"),
            }),
        }
    }

    async fn status(&self, thread: &ThreadId, cwd: &AbsPath) -> SessionStatus {
        let cwd = cwd.as_path().to_string_lossy().into_owned();
        let header = self.header(thread).await.unwrap_or_default();
        SessionStatus {
            session_id: Some(thread.as_str().to_owned()),
            title: field(&header, "title"),
            title_source: field(&header, "titleSource"),
            project: nested(&header, "workspace", "projectPath").or_else(|| nested(&header, "desktopSession", "projectPath")).unwrap_or_else(|| cwd.clone()),
            cwd,
            provider: field(&header, "provider"),
            model: field(&header, "model"),
            effort: field(&header, "effort"),
            auto_effort: header.get("autoEffort") != Some(&Value::Bool(false)),
            fast: header.get("fast") == Some(&Value::Bool(true)),
        }
    }

    async fn list_projects(&self) -> Vec<ProjectRow> {
        self.parts.projects.list().await
    }

    async fn set_project(&self, thread: &ThreadId, cwd: &AbsPath, raw_path: &str) -> Result<String, PortError> {
        let next = resolve_path(&cwd.as_path().to_string_lossy(), raw_path);
        let path = std::path::PathBuf::from(&next);
        let cancel = CancellationToken::new();
        let job = self
            .parts
            .io
            .submit(&cancel, move |lane| mixdog_statefile::metadata(lane, &path))
            .map_err(|_| PortError::Cancelled)?;
        let metadata = job
            .await
            .map_err(|_| PortError::Cancelled)?
            .map_err(|e| failed(format!("{}: {}", e.kind(), next)))?;
        if !metadata.is_dir() {
            return Err(PortError::Invalid { field: "path".to_owned(), reason: format!("session: not a directory: {next}") });
        }
        let params = json!({ "threadId": thread.as_str(), "opId": uuid::Uuid::now_v7().to_string(), "path": next });
        self.parts.requests.request(thread, "thread/setCwd", params).await.map_err(core)?;
        let header = self.header(thread).await?;
        Ok(field(&header, "cwd").map(|c| mixdog_js::js_trim(&c).to_owned()).filter(|c| !c.is_empty()).unwrap_or(next))
    }

    async fn rename(&self, thread: &ThreadId, title: &str) -> Result<String, RenameError> {
        let set = match self.parts.titles.update_ai_title(thread.as_str(), title).await.map_err(RenameError::Failed)? {
            AiTitle::Set(title) => title,
            AiTitle::UserTitle => return Err(RenameError::UserTitle),
            AiTitle::NotFound => return Err(RenameError::Failed("not-found".to_owned())),
            AiTitle::Empty => return Err(RenameError::Failed("empty-title".to_owned())),
        };
        // A manual rename that landed while the save was awaited wins.
        let stored = self.header(thread).await.map_err(|e| RenameError::Failed(format!("{e:?}")))?;
        if stored.get("titleSource").and_then(Value::as_str) == Some("user") {
            return Err(RenameError::UserTitle);
        }
        Ok(set)
    }

    async fn schedule_compact(&self, thread: &ThreadId) -> Result<(), PortError> {
        self.parts.requests.compact_after_turn(thread).map_err(core)
    }

    async fn fork(&self, thread: &ThreadId, compact: bool) -> Result<(String, bool), PortError> {
        let params = json!({ "threadId": thread.as_str(), "opId": uuid::Uuid::now_v7().to_string() });
        let reply = self.parts.requests.request(thread, "thread/fork", params).await.map_err(core)?;
        let id = reply
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| failed("session: the fork answered no thread"))?
            .to_owned();
        // A suffixed title tells the copy apart in session lists; locked as a model title so
        // auto-titling keeps it, renames still win.
        let copy = ThreadId::from(id.as_str());
        let heir = self.header(&copy).await?;
        if let Some(title) = field(&heir, "title").map(|t| mixdog_js::js_trim(&t).to_owned()).filter(|t| !t.is_empty()) {
            let set = serde_json::Map::from_iter([
                ("title".to_owned(), json!(format!("{title} (Fork)"))),
                ("titleLocked".to_owned(), json!(true)),
                ("titleSource".to_owned(), json!("ai")),
            ]);
            self.parts.threads.patch_header(&copy, set, Vec::new()).await?;
        }
        if !compact {
            return Ok((id, false));
        }
        // `inheritToNewSession({ compact: true })` summarises the heir's conversation even when it fits and refuses
        // (the heir is never left behind) when it cannot: the copy is compacted, and removed when that did not happen.
        let compacted = self
            .parts
            .requests
            .request(&copy, "thread/compact/start", json!({ "threadId": id, "opId": uuid::Uuid::now_v7().to_string() }))
            .await;
        let done = matches!(&compacted, Ok(result) if !truthy(result.get("skipped")) && result.get("changed") != Some(&Value::Bool(false)));
        if !done {
            let reason = match compacted {
                Ok(result) => result.get("reason").map(mixdog_js::value_to_string).unwrap_or_else(|| "nothing was compacted".to_owned()),
                Err(error) => format!("{error:?}"),
            };
            let removal = json!({ "threadId": id, "opId": uuid::Uuid::now_v7().to_string() });
            self.parts.requests.request(&copy, "thread/delete", removal).await.map_err(core)?;
            return Err(failed(format!("session: fork with compact failed ({reason})")));
        }
        Ok((id, true))
    }

    async fn sidebar(&self, thread: &ThreadId, flag: SidebarFlag, value: bool) -> Result<(), PortError> {
        let op = uuid::Uuid::now_v7().to_string();
        let (method, params) = match (flag, value) {
            (SidebarFlag::Favorite, value) => ("thread/metadata/update", json!({ "threadId": thread.as_str(), "opId": op, "favorite": value })),
            (SidebarFlag::Archived, true) => ("thread/archive", json!({ "threadId": thread.as_str(), "opId": op })),
            (SidebarFlag::Archived, false) => ("thread/unarchive", json!({ "threadId": thread.as_str(), "opId": op })),
        };
        self.parts.requests.request(thread, method, params).await.map(|_| ()).map_err(core)
    }

    async fn suggest(&self, key: &str, text: &str, dismissed: bool) -> Result<Value, PortError> {
        self.parts.suggestions.record(key, text, dismissed).await.map_err(failed)
    }
}
