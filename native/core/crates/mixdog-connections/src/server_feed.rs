//! What the server's window needs to know of a connected server, read from one attached protocol client: the sessions the server
//! lists, the state changes of the threads this client follows, the agent pool, the approvals the server waits on, and a turn's
//! final answer. The feed only observes: a held approval is never answered here (the window's own card answers it).
//!
//! Sources (the ones `ServerNotifierSources` and `ReattachReportSources` of the desktop's main process took from the service client):
//! - sessions: `thread/list` pages, then the app feed's `thread/started`, `thread/summary/updated`, `thread/deleted`,
//!   `thread/archived` and `thread/unarchived`, laid over the listing as the roster feed of the phone laid them (an edge outranks
//!   the listing it overlaps); listed again after every reconnect.
//! - session states: the client store's thread folds, one change per fold, in fold order, with the host's shell jobs and remote
//!   channel laid over each (and said again when either changes).
//! - agent pool: the `agentPool` section, or `agent/pool/list` while the section is stubbed or absent.
//! - approvals: the requests the client holds (`pending_server_requests`).
//! - final answer: `thread/finalAnswer/read`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mixdog_app_server_client::api::{
    CallOptions, ClientError, ClientEvent, ConnectionStatus, FoldStore, Json, ProtocolClient, RequestId, RpcNotification,
    SectionName, ServerRequest, StoreChange,
};
use mixdog_protocol::ThreadSummary;
use mixdog_rt::CancellationToken;
use serde_json::json;
use tokio::sync::{broadcast, watch};
use tokio::task::JoinHandle;

/// The largest `thread/list` page the core answers.
const LIST_PAGE_LIMIT: u64 = 1000;
/// The catalog clock of the phone's roster feed: an edge republishes the list after this debounce, no sooner than `REFRESH_MIN_GAP`
/// after the last such refresh; edges meanwhile join the one pending refresh.
const REFRESH_DEBOUNCE: Duration = Duration::from_millis(400);
const REFRESH_MIN_GAP: Duration = Duration::from_secs(2);
/// Room for the state changes a slow reader may lag behind.
const STATE_CHANNEL_CAPACITY: usize = 256;

/// One row of the server's session list.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionSummaryLite {
    pub id: String,
    pub title: String,
    pub preview: String,
    /// The session's turn is running (the row's `working`).
    pub running: bool,
    pub updated_at: i64,
    /// The row's activity time (`activityAt`, else `updatedAt`); the list is ordered by it.
    pub activity_at: i64,
    pub message_count: i64,
    pub archived: bool,
    pub agent_session: bool,
    pub awaiting_approval: bool,
    pub awaiting_question: bool,
    pub agent_home: Option<String>,
    /// The whole row as the server sent it: the notifier's conversation kind and turn tracker read more of it (`leadWorking`,
    /// `agentWorking`, `agentRoom`, `taskAgent`, `sessionMode`, ...).
    pub summary: ThreadSummary,
}

impl SessionSummaryLite {
    fn of(row: &ThreadSummary) -> Self {
        Self {
            id: row.id.as_str().to_owned(),
            title: row.title.clone(),
            preview: row.preview.clone(),
            running: row.working == Some(true),
            updated_at: row.updated_at,
            activity_at: activity_of(row),
            message_count: row.message_count,
            archived: row.archived == Some(true),
            agent_session: row.agent_session == Some(true),
            awaiting_approval: row.awaiting_approval == Some(true),
            awaiting_question: row.awaiting_question == Some(true),
            agent_home: row.agent_home.clone(),
            summary: row.clone(),
        }
    }
}

fn activity_of(row: &ThreadSummary) -> i64 {
    row.activity_at.filter(|at| *at != 0).unwrap_or(row.updated_at)
}

/// What a followed thread is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRunState {
    Running,
    Idle,
    /// The server no longer has the thread for this connection (deleted, or it refused to restore the subscription).
    Gone,
}

/// One state change of a followed thread.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionStateChange {
    pub session_id: String,
    pub state: SessionRunState,
    /// When the latest turn started (epoch ms): the fold's own `turnStartedAt`, else when this feed saw it begin. Kept while the
    /// thread is idle, so a final answer can be read for the turn that just ended.
    pub started_at: Option<i64>,
    /// The folded thread state this change is of; `null` for `Gone`.
    pub snapshot: Json,
}

/// One row of the agent pool; `row` is the whole row as the server sent it.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRowLite {
    pub tag: String,
    pub session_id: String,
    pub owner_session_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub title: Option<String>,
    pub status: String,
    pub stage: String,
    /// The owner closed the agent (its status is unchanged).
    pub released: bool,
    pub row: Json,
}

impl AgentRowLite {
    fn of(row: &Json) -> Option<Self> {
        let fields = row.as_object()?;
        let text = |key: &str| fields.get(key).and_then(Json::as_str).map(str::to_owned);
        Some(Self {
            tag: text("tag").unwrap_or_default(),
            session_id: text("sessionId").unwrap_or_default(),
            owner_session_id: text("ownerSessionId"),
            parent_session_id: text("parentSessionId"),
            title: text("title"),
            status: text("status").unwrap_or_default(),
            stage: text("stage").unwrap_or_default(),
            released: fields.get("released").and_then(Json::as_bool) == Some(true),
            row: row.clone(),
        })
    }
}

/// What a held request asks of the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKind {
    Tool,
    /// An `ask_user` question.
    Question,
    Permissions,
    Browser,
    Computer,
}

/// An approval the server waits on, held by the client until the server resolves it.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingApproval {
    pub request_id: RequestId,
    /// The chat that shows it (a sub-agent's request shows in its surface thread).
    pub session_id: String,
    pub kind: ApprovalKind,
    pub requested_at: i64,
    pub order: u64,
}

fn approval_of(request: &ServerRequest) -> Option<PendingApproval> {
    let (kind, envelope) = match request {
        ServerRequest::ToolRequestApproval { params, .. } => (ApprovalKind::Tool, &params.envelope),
        ServerRequest::ToolRequestUserInput { params, .. } => (ApprovalKind::Question, &params.envelope),
        ServerRequest::PermissionsRequestApproval { params, .. } => (ApprovalKind::Permissions, &params.envelope),
        ServerRequest::BrowserRequestApproval { params, .. } => (ApprovalKind::Browser, &params.envelope),
        ServerRequest::ComputerRequestApproval { params, .. } => (ApprovalKind::Computer, &params.envelope),
        _ => return None,
    };
    let session = envelope.surface_thread_id.as_ref().unwrap_or(&envelope.thread_id);
    Some(PendingApproval {
        request_id: request.id().clone(),
        session_id: session.as_str().to_owned(),
        kind,
        requested_at: envelope.requested_at,
        order: envelope.order,
    })
}

/// A turn's answer, as the server reads it from the transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct FinalAnswer {
    /// The turn's `turndone` item id.
    pub id: Json,
    pub at: i64,
    pub status: FinalAnswerStatus,
    pub text: String,
    /// The turn answered with a reaction on the user's message alone: done, with no text.
    pub reacted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalAnswerStatus {
    Done,
    Failed,
    Cancelled,
}

impl FinalAnswer {
    fn parse(value: &Json) -> Option<Self> {
        let fields = value.as_object()?;
        let status = match fields.get("status")?.as_str()? {
            "done" => FinalAnswerStatus::Done,
            "failed" => FinalAnswerStatus::Failed,
            "cancelled" => FinalAnswerStatus::Cancelled,
            _ => return None,
        };
        let at = fields.get("at")?;
        let at = at.as_i64().or_else(|| at.as_f64().map(|n| n as i64))?;
        Some(Self {
            id: fields.get("id").cloned().unwrap_or(Json::Null),
            at,
            status,
            text: fields.get("text").and_then(Json::as_str).unwrap_or_default().to_owned(),
            reacted: fields.get("reacted").and_then(Json::as_bool) == Some(true),
        })
    }
}

/// The server says the session record is gone (deleted, never persisted): no later read can produce its answer, so waiting is
/// pointless. The wording is the session service's `session <id> is not available`, also inside a wrapper message.
pub fn is_session_missing(error: &ClientError) -> bool {
    let text = error.to_string().to_lowercase();
    let is_session = |word: &str| word.trim_matches(|c: char| !c.is_alphanumeric()) == "session";
    let mut from = 0;
    while let Some(found) = text[from..].find("is not available") {
        let at = from + found;
        let before: Vec<&str> = text[..at].split_whitespace().rev().take(2).collect();
        if before.first().is_some_and(|w| is_session(w)) || before.get(1).is_some_and(|w| is_session(w)) {
            return true;
        }
        from = at + 1;
    }
    false
}

/// The sessions the server lists as this process holds them: the listing and the edges that arrived while it was read.
#[derive(Default)]
struct Roster {
    held: HashMap<String, ThreadSummary>,
    known: bool,
    reading: bool,
    /// Edges since the read began (or, before any read, since the feed attached): they outrank the listing.
    edges: HashMap<String, Option<ThreadSummary>>,
    /// An archive change whose row the listing has not brought yet.
    pending_archive: HashMap<String, bool>,
}

struct RunMark {
    busy: bool,
    started_at: Option<i64>,
}

#[derive(Default)]
struct RefreshClock {
    pending: bool,
    refreshed_at: Option<Instant>,
}

struct Shared {
    client: Arc<dyn ProtocolClient>,
    store: Arc<dyn FoldStore>,
    roster: Mutex<Roster>,
    runs: Mutex<HashMap<String, RunMark>>,
    refresh: Mutex<RefreshClock>,
    pool_generation: AtomicU64,
    sessions: watch::Sender<Vec<SessionSummaryLite>>,
    pool: watch::Sender<Vec<AgentRowLite>>,
    approvals: watch::Sender<Vec<PendingApproval>>,
    states: broadcast::Sender<SessionStateChange>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The one session the remote channel serves (`remoteSessionIdOf`): an id of at most 256 characters of letters, digits, `_` and `-`.
fn remote_session_id(state: &Json) -> Option<String> {
    let id = state.get("sessionId").and_then(Json::as_str)?;
    let valid = !id.is_empty() && id.len() <= 256 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    valid.then(|| id.to_owned())
}

fn set_if_changed<T: PartialEq>(sender: &watch::Sender<T>, next: T) {
    sender.send_if_modified(|current| {
        if *current == next {
            return false;
        }
        *current = next;
        true
    });
}

impl Shared {
    // ── sessions ──

    /// `always`: a full listing is published even when it equals the last list (a reattach report waits for the list read
    /// after the reconnect); an edge that changes nothing is not.
    fn publish_sessions(&self, rows: &HashMap<String, ThreadSummary>, always: bool) {
        let mut ordered: Vec<&ThreadSummary> = rows.values().collect();
        // Catalog order: newest activity first, ties by id in code-unit order.
        ordered.sort_by(|a, b| activity_of(b).cmp(&activity_of(a)).then_with(|| a.id.as_str().cmp(b.id.as_str())));
        let next: Vec<SessionSummaryLite> = ordered.into_iter().map(SessionSummaryLite::of).collect();
        if always {
            self.sessions.send_replace(next);
        } else {
            set_if_changed(&self.sessions, next);
        }
    }

    async fn read_listing(&self) -> Result<HashMap<String, ThreadSummary>, ClientError> {
        let mut listed = HashMap::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut params = json!({ "limit": LIST_PAGE_LIMIT });
            if let Some(cursor) = &cursor {
                params["cursor"] = json!(cursor);
            }
            let page = self.client.call_raw("thread/list", params, CallOptions::default()).await?;
            for row in page.get("data").and_then(Json::as_array).into_iter().flatten() {
                if let Ok(row) = serde_json::from_value::<ThreadSummary>(row.clone()) {
                    listed.insert(row.id.as_str().to_owned(), row);
                }
            }
            match page.get("nextCursor").and_then(Json::as_str) {
                Some(next) if !next.is_empty() => cursor = Some(next.to_owned()),
                _ => return Ok(listed),
            }
        }
    }

    /// Lists the sessions in full and lays the edges that arrived meanwhile over the listing. A read already running is the answer.
    async fn list(&self) {
        {
            let mut roster = self.roster.lock().unwrap();
            if roster.reading {
                return;
            }
            roster.reading = true;
        }
        let listing = self.read_listing().await;
        let mut roster = self.roster.lock().unwrap();
        roster.reading = false;
        // A connection that ends mid-read is read again by the next reconnect; the edges wait for that read.
        let Ok(mut listed) = listing else { return };
        let edges = std::mem::take(&mut roster.edges);
        for (id, archived) in std::mem::take(&mut roster.pending_archive) {
            // An edge for the row outranks an archive change that arrived before it.
            if edges.contains_key(&id) {
                continue;
            }
            if let Some(row) = listed.get_mut(&id) {
                row.archived = Some(archived);
            }
        }
        for (id, row) in edges {
            match row {
                Some(row) => {
                    listed.insert(id, row);
                }
                None => {
                    listed.remove(&id);
                }
            }
        }
        roster.held = listed;
        roster.known = true;
        self.publish_sessions(&roster.held, true);
    }

    fn on_edge(self: &Arc<Self>, method: &str, params: &Json) {
        let archive_flag = match method {
            "thread/archived" => Some(true),
            "thread/unarchived" => Some(false),
            _ => None,
        };
        let thread = params.get("thread").and_then(|t| serde_json::from_value::<ThreadSummary>(t.clone()).ok());
        let id = if method == "thread/deleted" || archive_flag.is_some() {
            params.get("threadId").and_then(Json::as_str).unwrap_or_default().to_owned()
        } else {
            thread.as_ref().map(|t| t.id.as_str().to_owned()).unwrap_or_default()
        };
        if id.is_empty() {
            return;
        }
        let row = if method == "thread/deleted" { None } else { thread };
        let mut guard = self.roster.lock().unwrap();
        let roster = &mut *guard;
        if roster.reading || !roster.known {
            match archive_flag {
                None => {
                    roster.edges.insert(id, row);
                }
                Some(flag) => match roster.edges.get_mut(&id) {
                    Some(Some(edge)) => edge.archived = Some(flag),
                    Some(None) => {}
                    None => {
                        roster.pending_archive.insert(id, flag);
                    }
                },
            }
            return;
        }
        match archive_flag {
            None => match row {
                Some(row) => {
                    roster.held.insert(id, row);
                }
                None => {
                    roster.held.remove(&id);
                }
            },
            Some(flag) => match roster.held.get_mut(&id) {
                Some(held) => held.archived = Some(flag),
                None => return,
            },
        }
        drop(guard);
        self.schedule_refresh();
    }

    /// Publishes the rows held now (nothing is heard when they equal the last list).
    fn publish_held(&self) {
        let roster = self.roster.lock().unwrap();
        self.publish_sessions(&roster.held, false);
    }

    /// An edge reaches the list after `REFRESH_DEBOUNCE`, no sooner than `REFRESH_MIN_GAP` after the last refresh; one timer serves
    /// every edge that arrives while it runs.
    fn schedule_refresh(self: &Arc<Self>) {
        let delay = {
            let mut clock = self.refresh.lock().unwrap();
            if clock.pending {
                return;
            }
            clock.pending = true;
            let since = clock.refreshed_at.map(|at| at.elapsed()).unwrap_or(REFRESH_MIN_GAP);
            REFRESH_DEBOUNCE.max(REFRESH_MIN_GAP.saturating_sub(since))
        };
        let shared = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut clock = shared.refresh.lock().unwrap();
                clock.pending = false;
                clock.refreshed_at = Some(Instant::now());
            }
            shared.publish_held();
        });
    }

    // ── session states ──

    /// The folded thread state with what the host adds to a session's state: the shell jobs of the host (`hostShellJobs`) and
    /// whether the remote channel is on for this session (`hostState` key `remoteSession`: `{ enabled, sessionId, cwd }`). A held
    /// approval is not laid over it: approvals are their own watch.
    fn snapshot_of(&self, mut state: Json) -> Json {
        let Some(fields) = state.as_object_mut() else { return state };
        if let Some(jobs) = self.store.section(SectionName::HostShellJobs, None).map(|entry| entry.value).filter(|v| !v.is_null()) {
            fields.insert("hostShellJobs".to_owned(), jobs);
        }
        // Every state says it (`withRemoteSession`): off, with a null id, while the host holds no remote channel.
        let id = self.store.section(SectionName::HostState, Some("remoteSession")).and_then(|remote| remote_session_id(&remote.value));
        fields.insert("remoteEnabled".to_owned(), json!(id.is_some()));
        fields.insert("remoteSessionId".to_owned(), id.map_or(Json::Null, Json::from));
        state
    }

    /// The host's shell jobs or remote channel changed: every followed thread's state is said again.
    fn republish_states(&self) {
        let followed: Vec<String> = self.runs.lock().unwrap().keys().cloned().collect();
        for id in followed {
            self.on_thread_change(&id);
        }
    }

    fn on_thread_change(&self, thread_id: &str) {
        let Some(fold) = self.store.thread(thread_id) else { return };
        let flag = |key: &str| {
            let set = |state: &Json| state.get(key).and_then(Json::as_bool) == Some(true);
            set(&fold.state) || fold.state.get("runtime").is_some_and(set)
        };
        let busy = flag("busy") || flag("commandBusy");
        let reported = fold.state.get("turnStartedAt").and_then(Json::as_i64);
        let started_at = {
            let mut runs = self.runs.lock().unwrap();
            let mark = runs.entry(thread_id.to_owned()).or_insert(RunMark { busy: false, started_at: None });
            if busy && (!mark.busy || reported.is_some()) {
                mark.started_at = reported.or_else(|| Some(now_ms()));
            }
            mark.busy = busy;
            mark.started_at
        };
        let _ = self.states.send(SessionStateChange {
            session_id: thread_id.to_owned(),
            state: if busy { SessionRunState::Running } else { SessionRunState::Idle },
            started_at,
            snapshot: self.snapshot_of(fold.state),
        });
    }

    fn on_thread_gone(&self, thread_id: &str) {
        self.runs.lock().unwrap().remove(thread_id);
        let _ = self.states.send(SessionStateChange {
            session_id: thread_id.to_owned(),
            state: SessionRunState::Gone,
            started_at: None,
            snapshot: Json::Null,
        });
    }

    // ── agent pool ──

    async fn refresh_pool(&self) {
        let generation = self.pool_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let inline = self.store.section(SectionName::AgentPool, None).map(|entry| entry.value).filter(|value| !value.is_null());
        let value = match inline {
            Some(value) => value,
            // A stubbed or absent section is read with the list method.
            None => match self.client.call_raw("agent/pool/list", json!({}), CallOptions::default()).await {
                Ok(value) => value,
                Err(_) => return,
            },
        };
        if self.pool_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let rows = match &value {
            Json::Array(rows) => rows.as_slice(),
            other => other.get("rows").and_then(Json::as_array).map(Vec::as_slice).unwrap_or_default(),
        };
        set_if_changed(&self.pool, rows.iter().filter_map(AgentRowLite::of).collect());
    }

    // ── approvals ──

    /// The held requests that ask the user for something. `arriving` is a request the client has just delivered and `resolved` one
    /// it has just dropped: the event is ahead of what the client's own list shows by no more than that one.
    fn refresh_approvals(&self, arriving: Option<&ServerRequest>, resolved: Option<&RequestId>) {
        let mut rows: Vec<PendingApproval> = self.client.pending_server_requests().iter().filter_map(approval_of).collect();
        if let Some(row) = arriving.and_then(approval_of) {
            if !rows.iter().any(|held| held.request_id == row.request_id) {
                rows.push(row);
            }
        }
        if let Some(id) = resolved {
            rows.retain(|row| &row.request_id != id);
        }
        set_if_changed(&self.approvals, rows);
    }

    // ── the client's events ──

    async fn resync(&self) {
        self.list().await;
        self.refresh_pool().await;
        self.refresh_approvals(None, None);
    }

    fn on_notification(self: &Arc<Self>, notification: &RpcNotification) {
        let method = notification.method.as_str();
        let params = notification.params.clone().unwrap_or(Json::Null);
        match method {
            "thread/started" | "thread/summary/updated" | "thread/archived" | "thread/unarchived" => self.on_edge(method, &params),
            "thread/deleted" => {
                self.on_edge(method, &params);
                if let Some(id) = params.get("threadId").and_then(Json::as_str) {
                    self.on_thread_gone(id);
                }
            }
            _ => {}
        }
    }
}

async fn run(shared: Arc<Shared>, mut events: broadcast::Receiver<ClientEvent>, mut changes: broadcast::Receiver<StoreChange>) {
    {
        let shared = shared.clone();
        tokio::spawn(async move {
            // The client restores the subscription after a reconnect; a failure here is the next Ready's to repair.
            let _ = shared.client.subscribe_app().await;
            shared.resync().await;
        });
    }
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(ClientEvent::Notification(notification)) => shared.on_notification(&notification),
                Ok(ClientEvent::ServerRequest(request)) => shared.refresh_approvals(Some(&request), None),
                Ok(ClientEvent::ServerRequestResolved(done)) => shared.refresh_approvals(None, Some(&done.request_id)),
                Ok(ClientEvent::SubscriptionLost { thread_id, .. }) => shared.on_thread_gone(&thread_id),
                Ok(ClientEvent::Status(ConnectionStatus::Ready { .. })) => {
                    let shared = shared.clone();
                    tokio::spawn(async move { shared.resync().await });
                }
                Ok(ClientEvent::Status(_)) => {
                    shared.roster.lock().unwrap().known = false;
                    shared.refresh_approvals(None, None);
                }
                Ok(_) => {}
                // Events were missed: what they carried is read again.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    shared.roster.lock().unwrap().known = false;
                    let shared = shared.clone();
                    tokio::spawn(async move { shared.resync().await });
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            change = changes.recv() => match change {
                Ok(StoreChange::Thread { thread_id }) => shared.on_thread_change(&thread_id),
                Ok(StoreChange::Section { section: SectionName::AgentPool, .. }) => {
                    let shared = shared.clone();
                    tokio::spawn(async move { shared.refresh_pool().await });
                }
                Ok(StoreChange::Section { section: SectionName::HostShellJobs, .. }) => shared.republish_states(),
                Ok(StoreChange::Section { section: SectionName::HostState, key }) if key.as_deref() == Some("remoteSession") => {
                    shared.republish_states()
                }
                Ok(StoreChange::Section { .. }) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            },
        }
    }
}

/// The four sources of a server window's notifier and reattach report, from one attached client.
pub struct ServerFeed {
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}

impl ServerFeed {
    /// Starts watching `client` (the app feed is subscribed and the sessions listed in the background). Must be called inside a
    /// tokio runtime. Nothing is answered or sent on the user's behalf.
    pub fn attach(client: Arc<dyn ProtocolClient>) -> ServerFeed {
        let store = client.store();
        let events = client.events();
        let changes = store.subscribe();
        let shared = Arc::new(Shared {
            client,
            store,
            roster: Mutex::new(Roster::default()),
            runs: Mutex::new(HashMap::new()),
            refresh: Mutex::new(RefreshClock::default()),
            pool_generation: AtomicU64::new(0),
            sessions: watch::channel(Vec::new()).0,
            pool: watch::channel(Vec::new()).0,
            approvals: watch::channel(Vec::new()).0,
            states: broadcast::channel(STATE_CHANNEL_CAPACITY).0,
        });
        // The requests a client that is already connected holds.
        shared.refresh_approvals(None, None);
        let task = tokio::spawn(run(shared.clone(), events, changes));
        ServerFeed { shared, task }
    }

    /// The complete session list, newest activity first; each value replaces the last.
    pub fn sessions(&self) -> watch::Receiver<Vec<SessionSummaryLite>> {
        self.shared.sessions.subscribe()
    }

    /// Publishes the rows held now, without waiting for the pending refresh (for a caller that has just changed the catalog itself).
    pub fn flush(&self) {
        self.shared.publish_held();
    }

    /// Every state change of a followed thread from now on, in the order the client folded them.
    pub fn session_states(&self) -> broadcast::Receiver<SessionStateChange> {
        self.shared.states.subscribe()
    }

    pub fn agent_pool(&self) -> watch::Receiver<Vec<AgentRowLite>> {
        self.shared.pool.subscribe()
    }

    /// The approvals and questions the server is waiting on, as the client holds them.
    pub fn pending_approvals(&self) -> watch::Receiver<Vec<PendingApproval>> {
        self.shared.approvals.subscribe()
    }

    /// The answer of the turn that started at `started_at`; `Ok(None)` while it is pending or when `cancel` fires. An error is the
    /// read's own (`is_session_missing` tells a session that is gone, for which waiting is pointless).
    pub async fn read_final_answer_result(
        &self,
        session_id: &str,
        started_at: i64,
        cancel: &CancellationToken,
    ) -> Result<Option<FinalAnswer>, ClientError> {
        let params = json!({ "threadId": session_id, "startedAt": started_at });
        let read = self.shared.client.call_raw("thread/finalAnswer/read", params, CallOptions::default());
        tokio::select! {
            () = cancel.cancelled() => Ok(None),
            answer = read => Ok(FinalAnswer::parse(&answer?)),
        }
    }

    /// `read_final_answer_result` for a caller that treats a failed read as no answer yet.
    pub async fn read_final_answer(&self, session_id: &str, started_at: i64, cancel: &CancellationToken) -> Option<FinalAnswer> {
        self.read_final_answer_result(session_id, started_at, cancel).await.ok().flatten()
    }
}

impl Drop for ServerFeed {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
#[path = "server_feed_tests.rs"]
mod tests;
