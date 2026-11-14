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
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::support::{FsFailure, FsStep, io_failure};
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_core_base::rooms::ids::agent_id_of_home_session;
use mixdog_core_base::rooms::ids::room_id_of_session;
use mixdog_core_config::config::Config;
use mixdog_core_config::workflow::ids::truthy;
use mixdog_core_ports::ports::setup_actions::CallerScope;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_ports::ports::threads::port_error;
use mixdog_protocol::ThreadItem;
use mixdog_core_session::session::SessionDirectory;
use mixdog_core_session::session::session_title::AiTitle;
use mixdog_core_session::session::session_title::StoredTitles;
use mixdog_core_session::session::thread_settings::ThreadSettings;
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

use mixdog_app_protocol::v2::thread::ThreadItemsListResponse;
use mixdog_core_session::session::transcript_row;

use super::callers::ThreadCallers;
use super::session_output::ListPage;
use super::session_output::range_of;
use super::session_output::row_of;
use super::session_output::session_read_output;

mod actions;
mod bots;

pub use bots::BotRow;
pub use bots::BotWorld;

/// The session catalog as the `session` tool's list reads it (`service.listThreadCatalog`, `readStoredThreadCatalogRow`,
/// `storedLiveWork`): Node's catalog rows, newest activity first, with the live `working` and `agentWorking` laid over.
#[async_trait]
pub trait ThreadCatalog: Send + Sync {
    /// At most `limit` rows after `cursor`, and the cursor that continues after the last one when more follow.
    async fn page(&self, cursor: Option<&str>, limit: usize) -> Result<ListPage, CoreError>;
    /// The row of `id`, `None` when the catalog would not list it.
    async fn row(&self, id: &str) -> Result<Option<Value>, CoreError>;
    /// The sessions with live work now.
    fn live(&self) -> LiveWork;
    /// What the live overlay says of one session besides its turn: the bots whose sends run in it (`handedBy`) and whether it
    /// shows an approval (`liveSessionAwaitingApproval`).
    fn work_of(&self, id: &str) -> SessionWork;
}

/// [`ThreadCatalog::work_of`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionWork {
    pub handed_by: Vec<String>,
    pub awaiting_approval: bool,
}

/// `storedLiveWork`: `own`, the sessions with a turn in flight; `agents`, the Leads an Agent session in flight works for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveWork {
    pub own: Vec<String>,
    pub agents: Vec<String>,
}

#[async_trait]
impl ThreadCatalog for mixdog_core_session::session::thread_list::ThreadListService {
    async fn page(&self, cursor: Option<&str>, limit: usize) -> Result<ListPage, CoreError> {
        let (sessions, next_cursor) = self.catalog_page(cursor, limit).await?;
        Ok(ListPage { sessions, next_cursor })
    }

    async fn row(&self, id: &str) -> Result<Option<Value>, CoreError> {
        self.catalog_row(id).await
    }

    fn live(&self) -> LiveWork {
        let work = self.live_work();
        LiveWork { own: work.own.iter().map(|id| id.as_str().to_owned()).collect(), agents: work.agents.iter().map(|id| id.as_str().to_owned()).collect() }
    }

    fn work_of(&self, id: &str) -> SessionWork {
        let overlay = self.overlay_of(&ThreadId::from(id));
        SessionWork { handed_by: overlay.handed_by.unwrap_or_default(), awaiting_approval: overlay.awaiting_approval == Some(true) }
    }
}
use super::session_control;
use super::session_control::SessionListing;

/// Requests to a thread, open or not (`CallContext::internal`): the directory seen as the tools
/// see it.
#[async_trait]
pub trait ThreadRequests: Send + Sync {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError>;
    /// The Lead's own `session set-project` call (`setCallerCwd`) on `thread`, at the resolved folder `path`: the folder the
    /// session runs in afterwards.
    async fn set_caller_cwd(&self, thread: &ThreadId, path: &str) -> Result<String, CoreError>;
    /// The user's interrupt of the turn running in `thread` (`abortSession`): whether one was.
    fn interrupt(&self, thread: &ThreadId) -> Result<bool, CoreError>;
    /// `rt.pendingCompactSessionIds.add(id)`: `thread` compacts once, when its running turn settles.
    fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), CoreError>;
    /// The stored transcript of `thread`, oldest first (`service.readSession({ transcriptRange })`'s rows).
    async fn transcript(&self, thread: &ThreadId) -> Result<Vec<ThreadItem>, CoreError>;
    /// `service.submitSession({ sessionId, prompt: content, options: { id, mode: 'prompt', transcriptMeta: { sender: 'lead',
    /// fromAgent?, hop?, botChain? } } })`: `content` runs in `thread` at once when it is idle, else queues behind the running
    /// turn. Whether the thread took it.
    async fn submit(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, bot_chain: &[String], from_agent: Option<&str>) -> Result<bool, CoreError>;
    /// A `thread/start` (a directory request, answered with the new thread's row under `thread`).
    async fn start(&self, params: Value) -> Result<Value, CoreError>;
    /// `turnHopOf(session)` and `turnBotChainOf(session)`: the bot-to-bot depth and chain of the turn `thread` is in.
    fn turn_state(&self, thread: &ThreadId) -> (u32, Vec<String>);
}

/// The product's route of the tools' thread requests: the thread settings service answers its own methods (`thread/setCwd`,
/// `thread/metadata/update`, `thread/archive`, `thread/unarchive`, which are not the thread actor's), the directory every other.
pub struct SettingsRequests {
    directory: Arc<SessionDirectory>,
    settings: Arc<ThreadSettings>,
}

impl SettingsRequests {
    pub fn new(directory: Arc<SessionDirectory>, settings: Arc<ThreadSettings>) -> Self {
        Self { directory, settings }
    }
}

#[async_trait]
impl ThreadRequests for SettingsRequests {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        let ctx = CallContext::internal("session-tool");
        let op = OpId::from(params.get("opId").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| uuid::Uuid::now_v7().to_string()));
        let request = CoreRequest { method: Method(method), params, op: Some(op), ctx: ctx.clone() };
        let reply = if mixdog_core_session::session::thread_settings::METHODS.contains(&method) {
            self.settings.call(request).await?
        } else {
            return directory_request(&self.directory, thread, request).await;
        };
        match reply {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Ok(Value::Null),
        }
    }

    async fn set_caller_cwd(&self, thread: &ThreadId, path: &str) -> Result<String, CoreError> {
        self.settings.set_caller_cwd(thread, path).await
    }

    fn interrupt(&self, thread: &ThreadId) -> Result<bool, CoreError> {
        self.directory.interrupt_running_turn(thread)
    }

    fn compact_after_turn(&self, thread: &ThreadId) -> Result<(), CoreError> {
        self.directory.schedule_compact_after_turn(thread)
    }

    async fn transcript(&self, thread: &ThreadId) -> Result<Vec<ThreadItem>, CoreError> {
        self.directory.transcript_items(thread).await
    }

    async fn submit(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, bot_chain: &[String], from_agent: Option<&str>) -> Result<bool, CoreError> {
        Ok(self.directory.submit_session_message(thread, content, id, hop, bot_chain, from_agent).await)
    }

    async fn start(&self, params: Value) -> Result<Value, CoreError> {
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        let request = CoreRequest { method: Method("thread/start"), params, op: Some(op), ctx: CallContext::internal("session-tool") };
        match mixdog_core_api::ThreadDirectory::request(&*self.directory, request).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(started) => Ok(started.result),
        }
    }

    fn turn_state(&self, thread: &ThreadId) -> (u32, Vec<String>) {
        (self.directory.turn_hop(thread), self.directory.turn_bot_chain(thread))
    }
}

/// The directory alone, without the thread settings service: every method goes to the thread's actor, and a `session set-project`
/// call, which the settings service answers, is refused.
#[async_trait]
impl ThreadRequests for SessionDirectory {
    async fn request(&self, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
        directory_call(self, thread, method, params).await
    }

    async fn set_caller_cwd(&self, _thread: &ThreadId, _path: &str) -> Result<String, CoreError> {
        Err(mixdog_core_base::support::failed("session", "the thread settings service is not bound to these requests"))
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

    async fn submit(&self, thread: &ThreadId, content: &Value, id: &str, hop: u32, bot_chain: &[String], from_agent: Option<&str>) -> Result<bool, CoreError> {
        Ok(self.submit_session_message(thread, content, id, hop, bot_chain, from_agent).await)
    }

    async fn start(&self, params: Value) -> Result<Value, CoreError> {
        let op = OpId::from(uuid::Uuid::now_v7().to_string());
        let request = CoreRequest { method: Method("thread/start"), params, op: Some(op), ctx: CallContext::internal("session-tool") };
        match mixdog_core_api::ThreadDirectory::request(self, request).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(started) => Ok(started.result),
        }
    }

    fn turn_state(&self, thread: &ThreadId) -> (u32, Vec<String>) {
        (self.turn_hop(thread), self.turn_bot_chain(thread))
    }
}

/// A request to a thread through the directory: the thread's actor answers it, the thread opened for it when it is not loaded.
pub(super) async fn directory_request(directory: &SessionDirectory, thread: &ThreadId, request: CoreRequest) -> Result<Value, CoreError> {
    // A transcript page (`service.readSession({ transcriptRange })` of `session action=read`) is the directory's own read
    // (`reads::serve_read`), answered from the store whether the thread is loaded or not; the thread's actor refuses it.
    if request.method.as_str() == "thread/items/list" {
        return match mixdog_core_api::ThreadDirectory::request(directory, request).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Ok(Value::Null),
        };
    }
    let handle = directory.open_handle(thread, &request.ctx).await?;
    match handle.request(request).await? {
        Reply::Value(value) => Ok(value),
        Reply::Subscribe(_) => Ok(Value::Null),
    }
}

/// [`directory_request`] for a `method` with its `params`, as an internal call of the session tool.
pub(super) async fn directory_call(directory: &SessionDirectory, thread: &ThreadId, method: &'static str, params: Value) -> Result<Value, CoreError> {
    let op = OpId::from(params.get("opId").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| uuid::Uuid::now_v7().to_string()));
    directory_request(directory, thread, CoreRequest { method: Method(method), params, op: Some(op), ctx: CallContext::internal("session-tool") }).await
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
    /// `agentDisplayName(id)`: the name a bot goes by in the envelope of its messages (Mixy's name, else the definition's,
    /// else the id).
    async fn name(&self, id: &str) -> String;
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

    async fn name(&self, id: &str) -> String {
        if id == MIXY_AGENT_ID {
            return match self.agents.lead_status().await {
                Ok(status) if !status.name.is_empty() => status.name,
                _ => "Mixy".to_owned(),
            };
        }
        let named = match self.agents.load(id).await {
            Ok(Some(definition)) => definition.name.split_whitespace().collect::<Vec<_>>().join(" "),
            _ => String::new(),
        };
        if named.is_empty() { id.to_owned() } else { named }
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
    /// What `list` reads: the catalog, bound once the thread list exists.
    pub catalog: Arc<dyn ThreadCatalog>,
    /// The bots, routines, held requests and report watches `session bots` reads.
    pub world: Arc<dyn BotWorld>,
    /// The queue of turns waiting for their provider quota to reset: what a status reads as a session's `quotaResume`.
    pub quota: Arc<mixdog_core_base::quota_resume::QuotaResumeStore>,
    pub clock: Arc<dyn mixdog_agent::env::Clock>,
    /// The session catalog `session action=list` pages.
    pub listing: Arc<dyn SessionListing>,
    /// What `session action=send` queues and reports through.
    pub send: Arc<super::session_send::LateSend>,
    /// What `session action=bots` reads besides the catalog.
    pub bot_sources: Arc<dyn super::session_bots::BotSources>,
    pub io: InteractiveIo,
}

pub struct DirectorySessionPort {
    parts: SessionPortParts,
    /// What resolves a call's `attachments`; unbound until [`Self::with_attachments`] names a bound cell.
    attachments: Arc<super::session_attachments::LateAttachments>,
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
        Self { parts, attachments: Arc::default() }
    }

    /// The port with the resolver of a call's `attachments`, bound once the session directory exists.
    pub fn with_attachments(mut self, attachments: Arc<super::session_attachments::LateAttachments>) -> Self {
        self.attachments = attachments;
        self
    }

    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError> {
        self.parts.threads.header(thread).await
    }

    /// `session action=read` (`targetRequest` and `sessionReadOutput`): a window of another session's transcript, counted
    /// from its newest row, each row quoted with its own text window.
    async fn read(&self, call: &ControlCall) -> Result<Value, PortError> {
        let request = actions::target_request(call, "read")?;
        let target = ThreadId::from(request.id.as_str());
        self.target_header(&target).await?;
        let items = self.parts.requests.transcript(&target).await.map_err(core)?;
        let range = range_of(items.iter().filter_map(row_of).collect(), request.offset as u64, request.limit as u64);
        session_read_output(&request.id, &range, request.text_offset as usize, request.item_id.as_deref()).map_err(failed)
    }

    /// The cross-session actions (`createSessionControl`'s `control`), each request checked as
    /// `targetRequest` checks it.
    async fn cross_session(&self, call: &ControlCall) -> Result<Value, PortError> {
        let action = call.action.as_str();
        // `agentTasks.create(args, context)`: no target to check.
        if action == "create" {
            let attended = matches!(self.parts.callers.scope(&call.caller_thread).await, CallerScope::Human | CallerScope::Agent { unattended: false, .. });
            return self.parts.send.get().map_err(failed)?.create(call, attended).await.map_err(failed);
        }
        // `botStatus(args, { callerScope })`: no target to check either.
        if action == "bots" {
            let own = session_control::scoped_bot(&self.parts.callers.scope(&call.caller_thread).await, call.caller_thread.as_str());
            return super::session_bots::status(self.parts.bot_sources.as_ref(), self.parts.listing.as_ref(), &call.args, own).await.map_err(failed);
        }
        if !matches!(action, "list" | "read" | "send" | "cancel" | "delete" | "status") {
            return Err(PortError::Unavailable {
                capability: "session-control".to_owned(),
                message: format!("session: action={action} is not available in this runtime"),
            });
        }
        let caller = call.caller_thread.as_str();
        let target = session_control::target_request(&call.args, action, caller).map_err(failed)?;
        let thread = ThreadId::from(target.session_id.as_str());
        // The service refuses a cancel or delete of a session it does not hold (`abortSession`, `configureSession`); a group room's log
        // is the room host's. A send is checked where it reaches the service ([`SessionSend::send`]), after its effort.
        if matches!(action, "cancel" | "delete") && room_id_of_session(&target.session_id).is_none() && self.parts.callers.header(&thread).await?.is_none() {
            return Err(failed(format!("session {} is not available", target.session_id)));
        }
        match action {
            "list" => {
                let own = session_control::scoped_bot(&self.parts.callers.scope(&call.caller_thread).await, caller);
                session_control::list(self.parts.listing.as_ref(), &call.args, own.as_deref(), target.limit).await.map_err(failed)
            }
            "read" => {
                let Some((rows, has_older)) = self.transcript(&thread, target.offset + target.limit).await? else {
                    return Err(failed(format!("session {} is not available", target.session_id)));
                };
                session_control::read(&target.session_id, &rows, has_older, &target, call.args.get("item_id")).map_err(failed)
            }
            "send" => self.parts.send.get().map_err(failed)?.send(call, &target.session_id).await.map_err(failed),
            "status" => {
                let Some(header) = self.parts.callers.header(&thread).await? else {
                    return Err(failed(format!("session {} is not available", target.session_id)));
                };
                // `service.readSession(...).full`: whether a turn runs (the runtime's in-flight activity) and what quota resume
                // waits (the queue's entry, as `session bots` reads it).
                let busy = self.parts.listing.live_sources().await.map_err(failed)?.working.iter().any(|id| id == thread.as_str());
                let quota_resume = self.parts.quota.entry(thread.as_str()).map_or(Value::Null, |entry| entry.public());
                // `taskSessionPendingWork(sessionId)`.
                let send = self.parts.send.get().map_err(failed)?;
                let agents_working = mixdog_services::task_reports::follow::FollowHost::pending_work(&**send.tasks.host(), thread.as_str(), None).await;
                Ok(session_control::status(thread.as_str(), &header, busy, agents_working, quota_resume))
            }
            "cancel" => {
                let aborted = self.parts.requests.interrupt(&thread).map_err(core)?;
                Ok(json!({ "sessionId": thread.as_str(), "aborted": aborted }))
            }
            _ => {
                let params = json!({ "threadId": thread.as_str(), "opId": uuid::Uuid::now_v7().to_string() });
                let deleted = self.parts.requests.request(&thread, "thread/delete", params).await.map_err(core)?;
                Ok(json!({ "sessionId": thread.as_str(), "deleted": deleted == Value::Bool(true) }))
            }
        }
    }

    /// At least the newest `newest + 1` rows of `thread` (all when it holds fewer), oldest first,
    /// as Node transcript rows, and whether older rows exist; `None` for a session that does not
    /// exist.
    async fn transcript(&self, thread: &ThreadId, newest: usize) -> Result<Option<(Vec<Value>, bool)>, PortError> {
        if self.parts.callers.header(thread).await?.is_none() {
            return Ok(None);
        }
        let mut rows: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let limit = (newest + 1).saturating_sub(rows.len()).clamp(1, 512);
            let mut params = json!({ "threadId": thread.as_str(), "opId": uuid::Uuid::now_v7().to_string(), "limit": limit, "sortDirection": "desc" });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let reply = self.parts.requests.request(thread, "thread/items/list", params).await.map_err(core)?;
            let page: ThreadItemsListResponse = serde_json::from_value(reply).map_err(|e| failed(format!("session: unreadable transcript page ({e})")))?;
            let mut older: Vec<Value> = page.data.iter().map(transcript_row).collect();
            older.append(&mut rows);
            rows = older;
            cursor = page.next_cursor.filter(|_| page.has_older && rows.len() <= newest);
            if cursor.is_none() {
                return Ok(Some((rows, page.has_older)));
            }
        }
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

    async fn unknown_bot(&self, target: &str) -> Result<Option<String>, PortError> {
        self.unknown_bot_text(target).await
    }

    /// `callerAttachmentParts(rt, args, callerCwd, surface)`: against the caller's own conversation and folders.
    async fn resolve_attachments(&self, thread: &ThreadId, names: &Value, cwd: &AbsPath, surface: &str) -> Result<Vec<Value>, PortError> {
        let Some(attachments) = self.attachments.get() else {
            return Err(PortError::Unavailable {
                capability: "attachments".to_owned(),
                message: format!("{surface}: attachments cannot be resolved in this runtime"),
            });
        };
        // `rt.session`: a caller whose record cannot be read has no folders but the call's own.
        let header = self.header(thread).await.unwrap_or_default();
        attachments
            .resolve(thread, &header, names, &cwd.as_path().to_string_lossy(), surface)
            .await
            .map_err(|message| PortError::Failed { capability: "attachments".to_owned(), message })
    }

    async fn control(&self, call: ControlCall) -> Result<Value, PortError> {
        let error = match self.cross_session(&call).await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        // A bot id is resolved to its home chat before this, so a bot-shaped id no session
        // answers is no bot either: say which ids are.
        let target = call.args.get("session_id").and_then(Value::as_str).map(|s| mixdog_js::js_trim(s).to_owned()).unwrap_or_default();
        match &error {
            PortError::Failed { message, .. } if session_control::is_unknown_bot(&call.action, &target, message) => {
                let bots = self.parts.bots.ids().await.map_err(failed)?;
                Err(failed(session_control::unknown_bot_error(&target, &bots)))
            }
            _ => Err(error),
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
            .map_err(|error| {
                // Node's `statSync` throws its `fs` text: `ENOENT: no such file or directory, stat '<path>'`.
                let failure = FsFailure { error, step: FsStep::Stat(std::path::PathBuf::from(&next)) };
                match io_failure("session", &failure) {
                    CoreError::DomainError { message: Some(message), .. } => failed(message.to_string()),
                    other => failed(other.to_string()),
                }
            })?;
        if !metadata.is_dir() {
            return Err(PortError::Invalid { field: "path".to_owned(), reason: format!("session: not a directory: {next}") });
        }
        let cwd = self.parts.requests.set_caller_cwd(thread, &next).await.map_err(core)?;
        Ok(Some(mixdog_js::js_trim(&cwd)).filter(|c| !c.is_empty()).map_or(next, str::to_owned))
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
        // `rt.pendingCompactSessionIds.add(sessionId)`: the session's actor runs it once the turn settles.
        let params = json!({ "threadId": thread.as_str() });
        self.parts.requests.request(thread, "thread/compact/schedule", params).await.map_err(core)?;
        Ok(())
    }

    async fn fork(&self, thread: &ThreadId, compact: bool) -> Result<(String, bool), PortError> {
        // `inheritToNewSession(sessionId, { compact })`: `thread/fork` creates the heir and carries the conversation into
        // it, compacted for the heir when asked; it answers whether the carry was compacted.
        let params = json!({ "threadId": thread.as_str(), "opId": uuid::Uuid::now_v7().to_string(), "compact": compact });
        // A refused inheritance answers its own message, as Node's `inheritToNewSession` throws it.
        let reply = self.parts.requests.request(thread, "thread/fork", params).await.map_err(|error| match error {
            CoreError::DomainError { message: Some(message), .. } => failed(message.as_ref()),
            other => core(other),
        })?;
        let id = reply
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or_else(|| failed("session: the fork answered no thread"))?
            .to_owned();
        let compacted = reply.get("compacted") == Some(&Value::Bool(true));
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
        Ok((id, compacted))
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
