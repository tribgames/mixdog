//! `thread/list`: the stored-session summary listing (`listStoredSessionSummaryPage`,
//! `store-summary-reader.mjs`, behind `listSessions({ page })`). It reads the catalog index's
//! list rows only (the header-only summaries `_sessionSummary` built), never a session's log,
//! and answers a page of the lead-visible rows in catalog order (newest activity first, ties by
//! id): `limit` rows (`Math.floor(limit)`, default 50, at most 1000) after the keyset `cursor`,
//! with a `nextCursor` naming the last row only when more follow.
//!
//! The runtime overlay `daemon-stored-session-views.mjs` (`withRuntimeActivity`) and
//! `session-action.mjs` (`withApprovalWaits`) lay over a row is the host's ([`RowOverlay`]).
//! What only the v2 protocol names (`searchTerm`, `sortKey`, `sortDirection`) is decided in
//! `decisions.md` (D-list-*).

use std::sync::Arc;
use std::sync::OnceLock;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::SortDirection;
use mixdog_app_protocol::v2::thread::ThreadListParams;
use mixdog_app_protocol::v2::thread::ThreadListResponse;
use mixdog_app_protocol::v2::thread::ThreadRoomView;
use mixdog_app_protocol::v2::thread::ThreadSummaryUpdatedParams;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_api::state::CatalogObserver;
use mixdog_core_base::support::coded;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_protocol::ThreadSummary;
use mixdog_store::sqlite::SqliteStore;
use mixdog_store::sqlite::lead::LeadFilter;
use mixdog_store::sqlite::lead::LeadRow;
use mixdog_store::sqlite::lead::decode_catalog_cursor;
use mixdog_store::sqlite::lead::encode_catalog_cursor;

use super::TaskWorkspace;
use super::thread_edges::on_roster;
use super::transcript::summary_of_list_row;

pub const LIST: &str = "thread/list";
const STARTED: &str = "thread/started";
const SUMMARY_UPDATED: &str = "thread/summary/updated";
const DOMAIN: &str = "thread list";

/// `DEFAULT_PAGE_LIMIT` and `MAX_PAGE_LIMIT` (`store-summary-reader.mjs`).
const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 1000;

/// What the running daemon knows of a listed session that storage does not: the fields
/// `withRuntimeActivity` (`working`, `agentWorking`) and `withApprovalWaits` (`awaitingApproval`,
/// `awaitingQuestion`, `handedBy`) add to a row. A field the session has no fact for stays `None`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RowOverlay {
    pub working: Option<bool>,
    pub agent_working: Option<bool>,
    pub awaiting_approval: Option<bool>,
    pub awaiting_question: Option<bool>,
    pub handed_by: Option<Vec<String>>,
    /// Context rows the running turn committed that Node's catalog row counts only once the turn settles
    /// (`ActiveRun::unsaved_messages`).
    pub unsaved_messages: u64,
}

impl RowOverlay {
    fn lay_over(self, row: &mut ThreadSummary) {
        row.message_count = (row.message_count - self.unsaved_messages as i64).max(0);
        // The roster's projection (`desktop-state.ts`): `leadWorking` is the session's own turn, `working` that or an agent's.
        row.lead_working = self.working.or(row.lead_working);
        row.working = (self.working.or(self.agent_working)).or(row.working);
        row.agent_working = self.agent_working.or(row.agent_working);
        row.awaiting_approval = self.awaiting_approval.or(row.awaiting_approval);
        row.awaiting_question = self.awaiting_question.or(row.awaiting_question);
        row.handed_by = self.handed_by.or_else(|| row.handed_by.take());
    }
}

/// The sessions with live work now (`storedLiveWork`, `daemon-session-control.mjs`): `own`, those with a turn in flight
/// here, and `agents`, the Leads an Agent session in flight works for.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LiveWork {
    pub own: Vec<ThreadId>,
    pub agents: Vec<ThreadId>,
}

/// The host side of the overlay: the live facts of one session.
pub trait ListOverlay: Send + Sync {
    fn of(&self, thread: &ThreadId) -> RowOverlay;
    /// Every session with live work now.
    fn live_work(&self) -> LiveWork {
        LiveWork::default()
    }
}

/// [`ListOverlay`] over the threads this process hosts and the bots' owned work:
/// - `working`: the thread's own turn is in flight (`inFlightSessionActivity().working`);
/// - `agentWorking`: an agent session whose root owner is the thread has a turn in flight (its
///   `ownerSessionId || parentSessionId`, with `owner: 'agent'` or an agent other than `lead`);
/// - `awaitingApproval` / `awaitingQuestion`: the approval the thread shows now, a question when
///   it is `ask_user`'s (`awaitingApprovalSessionKinds`, `kind === 'question'`);
/// - `handedBy`: the bots whose sent work runs in the thread (`botWorkBySession`).
pub struct LiveListOverlay {
    directory: Arc<super::SessionDirectory>,
    bot_work: Arc<mixdog_services::task_reports::host::BotWork>,
}

impl LiveListOverlay {
    pub fn new(directory: Arc<super::SessionDirectory>, bot_work: Arc<mixdog_services::task_reports::host::BotWork>) -> Self {
        Self { directory, bot_work }
    }
}

/// JavaScript truthiness of a stored value.
fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(flag) => *flag,
        serde_json::Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        serde_json::Value::String(text) => !text.is_empty(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => true,
    }
}

/// `String(value || '').trim()` (with `.toLowerCase()` when `lower`).
fn clean_text(value: Option<&serde_json::Value>, lower: bool) -> String {
    let text = value.filter(|v| truthy(v)).map(mixdog_js::value_to_string).unwrap_or_default();
    let text = mixdog_js::js_trim(&text).to_owned();
    if lower { text.to_lowercase() } else { text }
}

impl ListOverlay for LiveListOverlay {
    fn live_work(&self) -> LiveWork {
        let mut live = LiveWork::default();
        for id in self.directory.loaded_ids() {
            let Some(handle) = self.directory.handle(&id) else { continue };
            if handle.cell.run.load().is_none() {
                continue;
            }
            live.own.push(id.clone());
            let header = handle.cell.header.load();
            let owner = clean_text(header.get("ownerSessionId").filter(|v| truthy(v)).or_else(|| header.get("parentSessionId")), false);
            let agent = clean_text(header.get("agent"), true);
            if !owner.is_empty() && (clean_text(header.get("owner"), true) == "agent" || (!agent.is_empty() && agent != "lead")) && !live.agents.iter().any(|known| known.as_str() == owner) {
                live.agents.push(ThreadId::from(owner));
            }
        }
        live
    }

    fn of(&self, thread: &ThreadId) -> RowOverlay {
        let mut overlay = RowOverlay::default();
        if let Some(handle) = self.directory.handle(thread) {
            if let Some(run) = handle.cell.run.load().as_ref() {
                overlay.working = Some(true);
                overlay.unsaved_messages = run.unsaved_messages.load(std::sync::atomic::Ordering::SeqCst);
            }
            if let Some(shown) = handle.cell.shown_approval.load().as_ref() {
                overlay.awaiting_approval = Some(true);
                if shown.ask.tool.as_deref() == Some("ask_user") {
                    overlay.awaiting_question = Some(true);
                }
            }
        }
        let agent_working = self.directory.loaded_ids().into_iter().filter(|id| id != thread).any(|id| {
            let Some(handle) = self.directory.handle(&id) else { return false };
            if handle.cell.run.load().is_none() {
                return false;
            }
            let header = handle.cell.header.load();
            let owner = clean_text(header.get("ownerSessionId").filter(|v| truthy(v)).or_else(|| header.get("parentSessionId")), false);
            let agent = clean_text(header.get("agent"), true);
            owner == thread.as_str() && (clean_text(header.get("owner"), true) == "agent" || (!agent.is_empty() && agent != "lead"))
        });
        if agent_working {
            overlay.agent_working = Some(true);
        }
        overlay.handed_by = self.bot_work.by_session().into_iter().find(|(session, _)| session == thread.as_str()).map(|(_, bots)| bots);
        overlay
    }
}

/// The rooms' side of the listing (`agentRooms.withRooms`, `agent-room-views.ts`
/// `catalogWithRooms`).
#[async_trait]
pub trait ListRooms: Send + Sync {
    /// `rows` with each room's log row stamped (the room's name, its last message time, the room
    /// summary as `agentRoom`), and both member sessions and the log rows of rooms that no longer
    /// exist left out.
    async fn with_rooms(&self, rows: Vec<ThreadSummary>) -> Result<Vec<ThreadSummary>, String>;
    /// The log thread of every room.
    async fn room_threads(&self) -> Result<Vec<ThreadId>, String>;
    /// The rows the catalog makes up for rooms whose log thread (`logs`) has no row in it
    /// (`catalogWithRooms`' `unlisted`), in the rooms' order.
    async fn unlisted(&self, logs: &[ThreadId]) -> Result<Vec<ThreadSummary>, String> {
        let _ = logs;
        Ok(Vec::new())
    }
}

/// `thread/list` over the catalog index.
pub struct ThreadListService {
    store: Arc<SqliteStore>,
    overlay: Arc<dyn ListOverlay>,
    rooms: Arc<dyn ListRooms>,
    /// The host's task workspace, which decides a legacy row's classification (the roster's `taskWorkspace` input).
    task_workspace: Arc<dyn TaskWorkspace>,
    /// Told of every row this service shows (see [`CatalogObserver`]).
    observer: OnceLock<Arc<dyn CatalogObserver>>,
    /// The index writes still queued behind the barriers already acknowledged (see [`ListFence`]).
    fence: OnceLock<Arc<dyn ListFence>>,
    /// Node's `sessionCatalogLoaded` (`session-host.ts:146,807`): set once a listing has been answered.
    loaded: std::sync::atomic::AtomicBool,
    /// The row last sent on the app feed per thread: Node hands a catalog only when it differs from the one its listener holds
    /// (`CatalogChannel.publish`, `session-host-publication.ts:141`), so a row that did not change is not sent again.
    announced: std::sync::Mutex<std::collections::HashMap<String, ThreadSummary>>,
}

/// The longest a list waits for the projections queued before it: the interactive lane's job lease (`mixdog-rt` `lane_lease`,
/// `exec.rs:130`), after which the runtime itself counts a read of the list as wedged. Past it the list answers what the index
/// holds, as a list issued just before the write would have.
pub const FENCE_BOUND: std::time::Duration = std::time::Duration::from_secs(10);

/// What makes a list no older than the writes whose reply or notification has been sent: Node's list is built from live state
/// synchronously with its writes, and the index here is written behind the acknowledged barrier.
pub trait ListFence: Send + Sync {
    /// `None` when no projection is pending (the idle list pays one atomic load); otherwise the wait until the index holds
    /// every projection already queued.
    fn pending(&self) -> Option<futures::future::BoxFuture<'static, ()>>;
}

impl ThreadListService {
    pub fn new(store: Arc<SqliteStore>, overlay: Arc<dyn ListOverlay>, rooms: Arc<dyn ListRooms>, task_workspace: Arc<dyn TaskWorkspace>) -> Self {
        Self { store, overlay, rooms, task_workspace, observer: OnceLock::new(), fence: OnceLock::new(), loaded: false.into(), announced: Default::default() }
    }

    /// Sends `thread` on the app feed, as `thread/started` when `started`, else as `thread/summary/updated`, unless it is the row
    /// last sent for that thread. Every send of a thread row goes through here, so the baseline is what the feed's listeners hold.
    pub fn announce(&self, app: &mixdog_core_base::state::SectionFeedState, thread: ThreadSummary, started: bool) {
        let mut announced = self.announced.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if announced.get(thread.id.as_str()) == Some(&thread) {
            return;
        }
        announced.insert(thread.id.as_str().to_owned(), thread.clone());
        if started {
            app.notify(STARTED, &mixdog_app_protocol::v2::thread::ThreadStartedParams { thread });
        } else {
            app.notify(SUMMARY_UPDATED, &ThreadSummaryUpdatedParams { thread });
        }
    }

    /// A thread left the catalog: its next row is news again.
    pub fn forget(&self, thread: &ThreadId) {
        self.announced.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(thread.as_str());
    }

    /// Whether a listing has been answered (Node's `sessionCatalogLoaded`), which decides how a room call publishes the catalog.
    pub fn catalog_loaded(&self) -> bool {
        self.loaded.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Connects the observer of the published catalog. Set once.
    pub fn observe(&self, observer: Arc<dyn CatalogObserver>) {
        let _ = self.observer.set(observer);
    }

    /// Connects the fence of the index writes. Set once.
    pub fn fence(&self, fence: Arc<dyn ListFence>) {
        let _ = self.fence.set(fence);
    }

    /// Waits, at most [`FENCE_BOUND`], for the projections queued before this call; it holds no lock while it waits.
    async fn caught_up(&self) {
        let Some(wait) = self.fence.get().and_then(|fence| fence.pending()) else { return };
        if mixdog_rt::time::timeout(FENCE_BOUND, wait).await.is_err() {
            tracing::warn!("thread/list: the index has not taken the writes acknowledged before this list within {FENCE_BOUND:?}; answering what it holds");
        }
    }

    fn published(&self, ids: &[&str]) {
        if let Some(observer) = self.observer.get() {
            observer.published(ids);
        }
    }

    /// The roster row of a listed row (desktopSessionSummaries over the catalog's row), with the live overlay.
    fn row_of(&self, id: &ThreadId, listed: &LeadRow, workspace: &str) -> ThreadSummary {
        let mut row = on_roster(summary_of_list_row(id, &serde_json::Value::Object(listed.row.clone()), listed.archived), &listed.row, workspace);
        self.overlay.of(id).lay_over(&mut row);
        row
    }

    async fn with_rooms(&self, rows: Vec<ThreadSummary>) -> Result<Vec<ThreadSummary>, CoreError> {
        self.rooms.with_rooms(rows).await.map_err(|error| failed(DOMAIN, error))
    }

    /// The row `thread/list` shows for `id`; `None` when the listing has none.
    pub async fn summary(&self, id: &ThreadId) -> Result<Option<ThreadSummary>, CoreError> {
        let workspace = self.workspace().await?;
        self.caught_up().await;
        let listed = self.store.lead_row(id.as_str()).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        let Some(listed) = listed else { return Ok(None) };
        self.summary_of(id, &listed, &workspace).await
    }

    /// The row a room publication carries for the room log `id`, as Node's in-memory catalog has it inside the call
    /// (`session-host.ts:354` `sessionCatalog()` → `catalogWithRooms`, `agent-room-views.ts:116-152`): the indexed row stamped with
    /// the room when the index holds the log, else the row made up from the saved room alone. It waits for no projection, so
    /// the saved room is always carried; `None` only for a log that is no room's. Node's in-call publication reads nothing (its rows
    /// are the last listing's), so a read that fails here does not fail it: the room goes out as the row made from the saved room,
    /// as Node's does when its last listing did not hold the log (recorded: `fixtures/room-catalog-states/loaded-failing.json`).
    async fn room_row(&self, id: &ThreadId) -> Result<Option<ThreadSummary>, CoreError> {
        let indexed = match self.workspace().await {
            Ok(workspace) => match self.store.lead_row(id.as_str()).await {
                Ok(listed) => listed.map(|listed| (listed, workspace)),
                Err(error) => {
                    tracing::warn!(%error, thread = id.as_str(), "room publication: the log's row could not be read; the saved room goes out");
                    None
                }
            },
            Err(error) => {
                tracing::warn!(?error, thread = id.as_str(), "room publication: the task workspace could not be read; the saved room goes out");
                None
            }
        };
        if let Some((listed, workspace)) = indexed {
            return self.summary_of(id, &listed, &workspace).await;
        }
        let row = self.rooms.unlisted(std::slice::from_ref(id)).await.map_err(|error| failed(DOMAIN, error))?.pop();
        if let Some(row) = &row {
            self.published(&[row.id.as_str()]);
        }
        Ok(row)
    }

    /// The whole catalog as Node's `listSessions` lists it for `publishCatalogs`: one unpaged `session.list`
    /// (`session-host.ts:797-804`), so one read of the index as it is at one moment, never pages a session could move between.
    /// Marked loaded only once it is in hand, as Node marks it after its listing answered (`:807`).
    async fn whole_listing(&self) -> Result<Vec<ThreadSummary>, CoreError> {
        let whole = ThreadListParams { cursor: None, limit: None, sort_key: None, sort_direction: None, archived: None, cwd: None, search_term: None };
        let rows = self.page_of(whole, usize::MAX).await?.data;
        self.loaded.store(true, std::sync::atomic::Ordering::SeqCst);
        self.published(&rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>());
        Ok(rows)
    }

    /// `service.listSessionCatalog({ page: { limit, cursor } })` as the `session` tool's list reads it: the index's own list
    /// rows (Node's catalog rows) after `cursor`, each with the live `working` / `agentWorking` laid over and `archived` set
    /// for the archived ones, and the cursor that continues after the last row when more follow.
    pub async fn catalog_page(&self, cursor: Option<&str>, limit: usize) -> Result<(Vec<serde_json::Value>, Option<String>), CoreError> {
        let after = decode_catalog_cursor(cursor).map_err(|error| coded(DOMAIN, "EINVALIDCURSOR", error.to_string()))?;
        self.caught_up().await;
        let page = self.store.lead_page(after, LeadFilter::default(), limit).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        let next = if page.more { page.rows.last().map(|row| encode_catalog_cursor(&row.row)) } else { None };
        Ok((page.rows.into_iter().map(|row| self.catalog_row_of(row)).collect(), next))
    }

    /// The catalog row of `id` read by id (`readStoredSessionCatalogRow`), `None` when the listing would not show it.
    pub async fn catalog_row(&self, id: &str) -> Result<Option<serde_json::Value>, CoreError> {
        self.caught_up().await;
        let listed = self.store.lead_row(id).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        Ok(listed.map(|row| self.catalog_row_of(row)))
    }

    fn catalog_row_of(&self, listed: LeadRow) -> serde_json::Value {
        let mut row = listed.row;
        let id = ThreadId::from(row.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned());
        let overlay = self.overlay.of(&id);
        if overlay.working == Some(true) {
            row.insert("working".to_owned(), serde_json::Value::Bool(true));
        }
        if overlay.agent_working == Some(true) {
            row.insert("agentWorking".to_owned(), serde_json::Value::Bool(true));
        }
        if listed.archived {
            row.insert("archived".to_owned(), serde_json::Value::Bool(true));
        }
        serde_json::Value::Object(row)
    }

    /// The sessions with live work now.
    pub fn live_work(&self) -> LiveWork {
        self.overlay.live_work()
    }

    /// The live facts of one session (the overlay a listed row carries).
    pub fn overlay_of(&self, id: &ThreadId) -> RowOverlay {
        self.overlay.of(id)
    }

    /// The host's task workspace; a lookup that fails fails the listing (`listSessions` asks the host first, `session-host.ts:793`).
    async fn workspace(&self) -> Result<String, CoreError> {
        self.task_workspace.path().await.map_err(|error| failed(DOMAIN, error))
    }

    /// The row `thread/list` shows for `id` over the listed row in hand (what the index held when it was written).
    pub(super) async fn summary_of(&self, id: &ThreadId, listed: &LeadRow, workspace: &str) -> Result<Option<ThreadSummary>, CoreError> {
        let row = self.with_rooms(vec![self.row_of(id, listed, workspace)]).await?.pop();
        if let Some(row) = &row {
            self.published(&[row.id.as_str()]);
        }
        Ok(row)
    }

    async fn list(&self, params: ThreadListParams) -> Result<ThreadListResponse, CoreError> {
        let response = self.page(params).await?;
        // Loaded once the listing is in hand, before anything hears of it (`session-host.ts:807` precedes `sessionCatalog()`).
        self.loaded.store(true, std::sync::atomic::Ordering::SeqCst);
        self.published(&response.data.iter().map(|row| row.id.as_str()).collect::<Vec<_>>());
        Ok(response)
    }

    /// One page of the listing, of the size the caller asked for within the listing's bounds.
    async fn page(&self, params: ThreadListParams) -> Result<ThreadListResponse, CoreError> {
        let limit = match params.limit.map(|limit| limit as usize) {
            Some(requested) if requested > 0 => requested.min(MAX_PAGE_LIMIT),
            _ => DEFAULT_PAGE_LIMIT,
        };
        self.page_of(params, limit).await
    }

    /// At most `limit` rows of the listing after `params.cursor`, read from the index in one read.
    async fn page_of(&self, params: ThreadListParams, limit: usize) -> Result<ThreadListResponse, CoreError> {
        if params.search_term.as_deref().is_some_and(|term| !term.is_empty()) {
            return Err(invalid("searchTerm", "absent: the listing has no text search (`thread/search` is the search)"));
        }
        if params.sort_key.is_some() {
            return Err(invalid("sortKey", "absent: the listing is in catalog order"));
        }
        if params.sort_direction.is_some_and(|direction| direction != SortDirection::Desc) {
            return Err(invalid("sortDirection", "desc: the listing is newest activity first"));
        }
        let after = decode_catalog_cursor(params.cursor.as_deref())
            .map_err(|error| coded(DOMAIN, "EINVALIDCURSOR", error.to_string()))?;
        let workspace = self.workspace().await?;
        // Node's catalog is whole: the rooms it makes up rows for lead it, so they belong to the unfiltered first page.
        let whole = after.is_none() && params.archived.is_none() && params.cwd.is_none();
        let filter = LeadFilter { archived: params.archived, cwd: params.cwd };
        self.caught_up().await;
        let page = self.store.lead_page(after, filter, limit).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        let next_cursor = if page.more { page.rows.last().map(|row| encode_catalog_cursor(&row.row)) } else { None };
        let rows = page
            .rows
            .iter()
            .map(|listed| {
                let id = ThreadId::from(listed.row.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned());
                self.row_of(&id, listed, &workspace)
            })
            .collect();
        let mut data = self.with_rooms(rows).await?;
        if whole {
            let mut missing = Vec::new();
            for log in self.rooms.room_threads().await.map_err(|error| failed(DOMAIN, error))? {
                if self.store.lead_row(log.as_str()).await.map_err(|error| failed(DOMAIN, error.to_string()))?.is_none() {
                    missing.push(log);
                }
            }
            if !missing.is_empty() {
                let mut made_up = self.rooms.unlisted(&missing).await.map_err(|error| failed(DOMAIN, error))?;
                made_up.append(&mut data);
                data = made_up;
            }
        }
        Ok(ThreadListResponse { data, next_cursor, backwards_cursor: None })
    }
}

/// `republishCatalog` for the rooms: each room's log row goes out again on the app feed
/// (`thread/summary/updated`) as `thread/list` shows it now. One pass at a time, and each pass reads
/// the rooms when it starts, so the last pass carries the last change.
pub struct RoomSummaries {
    list: Arc<ThreadListService>,
    app: Arc<mixdog_core_base::state::SectionFeedState>,
    /// The room log threads, whose `roomView` section a room's republish sets.
    directory: Arc<super::SessionDirectory>,
    /// One pass at a time, in the order they were asked for.
    pass: Arc<mixdog_rt::SerialChain>,
    /// The index writes' notifications ([`Self::follow`]): a pass sends what it read only once every write it may have read is
    /// published.
    edges: std::sync::OnceLock<Arc<super::thread_edges::ThreadEdges>>,
    /// The background listings started by [`Self::republish_catalog`], and the republishes of [`Self::republish`], that have not
    /// ended (a test's step boundary).
    #[cfg(any(test, feature = "test-support"))]
    background: tokio::sync::watch::Sender<usize>,
    /// Told when a listing has its rows in hand, before it waits to publish them (see [`Self::listing_in_hand`]).
    #[cfg(any(test, feature = "test-support"))]
    in_hand: tokio::sync::Notify,
}

/// One background listing started and not yet ended; counted down when dropped, run or not.
#[cfg(any(test, feature = "test-support"))]
struct Background(tokio::sync::watch::Sender<usize>);

#[cfg(any(test, feature = "test-support"))]
impl Drop for Background {
    fn drop(&mut self) {
        self.0.send_modify(|open| *open -= 1);
    }
}

impl RoomSummaries {
    pub fn new(
        list: Arc<ThreadListService>,
        app: Arc<mixdog_core_base::state::SectionFeedState>,
        directory: Arc<super::SessionDirectory>,
    ) -> Arc<Self> {
        Arc::new(Self {
            list,
            app,
            directory,
            pass: mixdog_rt::SerialChain::new(),
            edges: std::sync::OnceLock::new(),
            #[cfg(any(test, feature = "test-support"))]
            background: tokio::sync::watch::Sender::new(0),
            #[cfg(any(test, feature = "test-support"))]
            in_hand: tokio::sync::Notify::new(),
        })
    }

    /// The index writes' notifications this publisher's passes follow: the edge task and a pass both send a written row, and a
    /// pass that read the row before its write's `thread/started` went out would send `thread/summary/updated` for a row the
    /// client has not been told of. Each pass reads, then waits for every write counted by then, which is every write whose row
    /// it read (Node sends one catalog for both).
    pub fn follow(&self, edges: Arc<super::thread_edges::ThreadEdges>) {
        drop(self.edges.set(edges));
    }

    /// Every index write counted so far, published: after a read, every write the read could see.
    async fn written(&self) {
        if let Some(edges) = self.edges.get() {
            edges.settled().await;
        }
    }

    /// Waits until a listing has had its rows in hand since the last such wait (a test forcing the listing ahead of a reply).
    #[cfg(any(test, feature = "test-support"))]
    pub async fn listing_in_hand(&self) {
        self.in_hand.notified().await;
    }

    /// Waits until every background listing started so far has ended, published or failed (a replay's step boundary, as
    /// Node's recorder awaits the background listing a call started before the next step: `record-room-catalog-states.mjs`).
    #[cfg(any(test, feature = "test-support"))]
    pub async fn background_ended(&self) {
        let mut open = self.background.subscribe();
        open.wait_for(|open| *open == 0).await.expect("the sender is held by the summaries");
    }

    /// `deps.republishCatalog` as a room call makes it (`session-host.ts:353-356`). Once a listing has been answered (Node's
    /// `sessionCatalogLoaded`) the pass runs inside the call, and its error is the call's (`agent-rooms.ts:289` lets the
    /// synchronous publish throw, the room already saved). Before that a whole listing starts here and is not awaited, as Node's
    /// `void publishCatalogs()` runs `listSessions` (`session-host-catalog.ts:217-238`): it reads at once, and a listing that
    /// answers marks the catalog loaded (`session-host.ts:807`); its rows go out once `publish` is cancelled, which the call
    /// decides (Node's rows wait for the daemon's `session.list` reply, `session-host.ts:797`, so they never overtake an answer
    /// the call makes with no I/O after the start). A failed listing is dropped (`() => undefined`). The answer is the listing's
    /// end, for a call that joins it as Node's deletion joins the listing in flight (`session-host.ts:790`).
    pub async fn republish_catalog(
        self: &Arc<Self>,
        publish: mixdog_rt::CancellationToken,
    ) -> Result<Option<futures::future::BoxFuture<'static, ()>>, CoreError> {
        if self.list.catalog_loaded() {
            return self.publish_rooms().await.map(|()| None);
        }
        let this = self.clone();
        #[cfg(any(test, feature = "test-support"))]
        let open = {
            self.background.send_modify(|open| *open += 1);
            Background(self.background.clone())
        };
        let listing = tokio::spawn(async move {
            drop(this.publish_listing(publish.cancelled_owned()).await);
            #[cfg(any(test, feature = "test-support"))]
            drop(open);
        });
        Ok(Some(Box::pin(async move {
            if let Err(error) = listing.await
                && error.is_panic()
            {
                std::panic::resume_unwind(error.into_panic());
            }
        })))
    }

    /// Node's `publishCatalogs` awaited, as a room log's rename does (`session-host-lifecycle.ts:225-233` `renameSession`): the whole
    /// listing (which marks the catalog loaded) and its room rows; a failed listing is dropped (`session-host-catalog.ts:231-238`).
    pub async fn publish_catalogs(&self) {
        drop(self.publish_listing(std::future::ready(())).await);
    }

    /// The listing's pass: the whole listing, every row of it published once `publish` is ready, as Node's `publishCatalogs`
    /// publishes the catalog its listing returned (`session-host-catalog.ts:231-238`); one pass in the chain, so a call that the
    /// listing made loaded publishes after it.
    async fn publish_listing(&self, publish: impl std::future::Future<Output = ()>) -> Result<(), CoreError> {
        let _pass = self.pass.acquire().await;
        let rows = self.list.whole_listing().await?;
        #[cfg(any(test, feature = "test-support"))]
        self.in_hand.notify_one();
        self.written().await;
        publish.await;
        for thread in rows {
            self.list.announce(&self.app, thread, false);
        }
        Ok(())
    }

    /// `deps.republishCatalog` as a room's exchange or post makes it (`session-host.ts:353-356`, `agent-room-exchange.ts:138`,
    /// `agent-room-log.ts:71`), not awaited: with the catalog loaded (Node's `sessionCatalogLoaded`) a pass; before that a whole
    /// listing, as Node's `void publishCatalogs()`, which marks the catalog loaded (`session-host.ts:807`); a failed one is dropped.
    pub fn republish(self: &Arc<Self>) {
        let this = self.clone();
        #[cfg(any(test, feature = "test-support"))]
        let open = {
            self.background.send_modify(|open| *open += 1);
            Background(self.background.clone())
        };
        tokio::spawn(async move {
            this.republish_now().await;
            #[cfg(any(test, feature = "test-support"))]
            drop(open);
        });
    }

    /// [`Self::republish`] to its end, as the start-up's recovery awaits it (`agent-rooms.ts:479`): a pass, or before any listing
    /// answered a whole listing.
    pub async fn republish_now(&self) {
        if self.list.catalog_loaded() {
            self.publish().await;
        } else {
            self.publish_catalogs().await;
        }
    }

    /// `deps.republish(roomSessionId)`: the room view of one room changed (a member started or
    /// stopped speaking, the speaking member's approval came or went, the handed-off questions
    /// moved). Node publishes the room log's session state decorated with it
    /// (`session-host.ts` `snapshotWithShellJobs` → `agentRooms.decorate`, pushed on
    /// `mixdog:session-state`); here the decoration is the log thread's `roomView` section
    /// (`thread/roomView/updated`, in every snapshot), which the client lays over the thread's
    /// own fields. A view is set on the log thread, loaded for it, so a later subscriber reads it
    /// from the snapshot; a cleared view goes only to a loaded log (a fresh load has none). The
    /// log row goes out again too, carrying the room summary as it stands. Serialized with
    /// [`Self::publish`].
    pub async fn publish_room(&self, room_thread: &ThreadId, view: Option<ThreadRoomView>) {
        let _pass = self.pass.acquire().await;
        let handle = match &view {
            Some(_) => match self.directory.open_handle(room_thread, &mixdog_core_api::call::CallContext::internal("room-view")).await {
                Ok(handle) => Some(handle),
                Err(error) => {
                    tracing::warn!(?error, thread = room_thread.as_str(), "room view: the room log could not be opened");
                    None
                }
            },
            None => self.directory.handle(room_thread),
        };
        if let Some(handle) = handle
            && let Err(error) = handle.set_section(mixdog_core_ports::ports::threads::Section::RoomView(view)).await
        {
            tracing::warn!(?error, thread = room_thread.as_str(), "room view: not published");
        }
        let row = self.list.room_row(room_thread).await;
        self.written().await;
        match row {
            Ok(Some(thread)) => self.list.announce(&self.app, thread, false),
            Ok(None) => {}
            Err(error) => tracing::warn!(?error, thread = room_thread.as_str(), "room summaries: the row could not be read"),
        }
    }

    /// One pass: every room's log row, published.
    pub async fn publish(&self) {
        if let Err(error) = self.publish_rooms().await {
            tracing::warn!(?error, "room summaries: not published");
        }
    }

    /// The pass; the rooms that could not be read, or else the first row that could not be, is the error (after the other rows
    /// went out). It holds the pass chain while it reads, and waits for no projection: each room goes out from its saved state
    /// ([`ThreadListService::room_row`]).
    async fn publish_rooms(&self) -> Result<(), CoreError> {
        let _pass = self.pass.acquire().await;
        let threads = self.list.rooms.room_threads().await.map_err(|error| failed(DOMAIN, error))?;
        let mut first = None;
        let mut rows = Vec::new();
        for id in threads {
            match self.list.room_row(&id).await {
                Ok(Some(thread)) => rows.push(thread),
                // A log whose room is gone, or a member's log the rooms leave out, has nothing to show.
                Ok(None) => {}
                Err(error) => {
                    first.get_or_insert(error);
                }
            }
        }
        self.written().await;
        for thread in rows {
            self.list.announce(&self.app, thread, false);
        }
        first.map_or(Ok(()), Err)
    }
}

#[async_trait]
impl DomainService for ThreadListService {
    fn methods(&self) -> &'static [&'static str] {
        &[LIST]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            LIST => {
                let response = self.list(decode(&req)?).await?;
                Ok(Reply::Value(serde_json::to_value(response).map_err(|error| failed(DOMAIN, error.to_string()))?))
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn notify(&self, _method: Method, _params: serde_json::Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::value;
    use mixdog_store::sqlite::DirtyMark;
    use mixdog_store::summary::CatalogHead;
    use serde_json::Value;
    use serde_json::json;

    use super::*;

    /// The overlay of the golden run: `s_a` has a turn in flight.
    struct Busy;
    impl ListOverlay for Busy {
        fn of(&self, thread: &ThreadId) -> RowOverlay {
            if thread.as_str() == "s_a" {
                RowOverlay { working: Some(true), ..RowOverlay::default() }
            } else {
                RowOverlay::default()
            }
        }
    }

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/session-list/golden.json")).expect("golden json")
    }

    async fn service(data: &crate::session::testing::DataDir, golden: &Value) -> ThreadListService {
        let tokens = mixdog_rt::testing::tokens();
        let root = data.path().to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let store = Arc::new(data.index(index));
        for entry in golden["sessions"].as_array().expect("sessions") {
            let mut header = entry["record"].as_object().expect("record").clone();
            header.shift_remove("messages");
            let id = header["id"].as_str().expect("id").to_owned();
            store.upsert(CatalogHead { session: id, log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
        }
        ThreadListService::new(store, Arc::new(Busy), Arc::new(NoRooms), Arc::new(crate::session::testing::FixedTaskWorkspace("/tasks")))
    }

    /// No rooms: every row passes as listed.
    struct NoRooms;
    #[async_trait]
    impl ListRooms for NoRooms {
        async fn with_rooms(&self, rows: Vec<ThreadSummary>) -> Result<Vec<ThreadSummary>, String> {
            Ok(rows)
        }
        async fn room_threads(&self) -> Result<Vec<ThreadId>, String> {
            Ok(Vec::new())
        }
    }

    /// The fence of a projection held at a gate: it opens once the write has been committed behind it.
    struct Gate(std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>);
    impl ListFence for Gate {
        fn pending(&self) -> Option<futures::future::BoxFuture<'static, ()>> {
            let (reached, held) = self.0.lock().unwrap().take()?;
            Some(Box::pin(async move {
                let _ = reached.send(());
                drop(held.await);
            }))
        }
    }

    /// A projection that never reaches the index (a stuck writer) does not hold a list: the list waits for it up to [`FENCE_BOUND`],
    /// one tick before the bound it is still waiting, and at the bound it answers what the index holds, the same page an
    /// unfenced list answers.
    #[tokio::test(start_paused = true)]
    async fn a_list_behind_a_stuck_projection_answers_what_the_index_holds_at_the_bound() {
        let golden = golden();
        let data = crate::session::testing::DataDir::default();
        let service = service(&data, &golden).await;
        let (_never_opened, held) = tokio::sync::oneshot::channel();
        let (reached, waiting) = tokio::sync::oneshot::channel();
        service.fence(Arc::new(Gate(std::sync::Mutex::new(Some((reached, held))))));
        let listing = value(&service, request(LIST, json!({ "limit": 100 }), None));
        tokio::pin!(listing);
        assert!(polled(&mut listing).await.is_pending(), "the list did not wait for the queued projection");
        waiting.await.expect("the list is at the fence");
        tokio::time::advance(FENCE_BOUND - std::time::Duration::from_millis(1)).await;
        assert!(polled(&mut listing).await.is_pending(), "the list stopped waiting before the bound");
        tokio::time::advance(std::time::Duration::from_millis(1)).await;
        let std::task::Poll::Ready(listed) = polled(&mut listing).await else { panic!("the list still waits at the bound") };
        let unfenced = value(&service, request(LIST, json!({ "limit": 100 }), None)).await.expect("thread/list");
        assert_eq!(listed.expect("thread/list at the bound"), unfenced);
    }

    /// One poll of `future`, whatever it answers; the index reads here run inline, so one poll runs a list to the fence or to its
    /// answer.
    async fn polled<F: std::future::Future>(future: &mut std::pin::Pin<&mut F>) -> std::task::Poll<F::Output> {
        std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx))).await
    }

    /// A list issued while a committed write is still behind the projector answers with that write once the projector has applied
    /// it, never with the row from before (Node builds its list from live state, so a list after a reply cannot be older than it).
    /// A write acknowledged after the list read the projector's count is concurrent with the list, as it is in Node.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_list_waits_for_the_projection_queued_before_it_was_issued() {
        let golden = golden();
        let data = crate::session::testing::DataDir::default();
        let service = Arc::new(service(&data, &golden).await);
        let (open, held) = tokio::sync::oneshot::channel();
        let (reached, waiting) = tokio::sync::oneshot::channel();
        service.fence(Arc::new(Gate(std::sync::Mutex::new(Some((reached, held))))));
        let entry = &golden["sessions"][0];
        let id = entry["record"]["id"].as_str().expect("id").to_owned();
        let listing = {
            let service = service.clone();
            tokio::spawn(async move { value(&*service, request(LIST, json!({ "limit": 100 }), None)).await.expect("thread/list") })
        };
        // The list has to be at the gate before the projector applies the write, or it could read either row.
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), waiting)
            .await
            .expect("the list never waited for the pending projection")
            .expect("gate");
        // The projector applies the write, then lets the waiting list go.
        let mut header = entry["record"].as_object().expect("record").clone();
        header.shift_remove("messages");
        header.insert("title".into(), json!("after-the-write"));
        service.store.upsert(CatalogHead { session: id.clone(), log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
        open.send(()).expect("the list is waiting at the gate");
        let listed = listing.await.expect("list task");
        let row = listed["data"].as_array().expect("data").iter().find(|row| row["id"] == id.as_str()).expect("the row is listed");
        assert!(row.to_string().contains("after-the-write"), "{row}");
    }
    /// Every page `listStoredSessionSummaryPage` answered over Node's crafted records (the limit
    /// rules, the order, `nextCursor`), and the rows of those pages as Node's `_sessionSummary` built
    /// them. A limit the protocol cannot carry (negative, fractional) is refused by the wire type
    /// before it reaches the handler, so only the in-range limits run here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pages_equal_nodes() {
        let golden = golden();
        let data = crate::session::testing::DataDir::default();
        let service = service(&data, &golden).await;
        let summaries: std::collections::HashMap<&str, &Value> =
            golden["sessions"].as_array().expect("sessions").iter().map(|s| (s["record"]["id"].as_str().expect("id"), &s["summary"])).collect();
        let mut walked = 0;
        for walk in golden["walks"].as_array().expect("walks") {
            let limit = walk["limit"].as_f64();
            if limit.is_some_and(|l| l.fract() != 0.0 || l < 0.0) {
                continue;
            }
            for page in walk["pages"].as_array().expect("pages") {
                let mut params = json!({});
                if let Some(limit) = limit {
                    params["limit"] = json!(limit as u64);
                }
                if let Some(cursor) = page["cursor"].as_str() {
                    params["cursor"] = json!(cursor);
                }
                let answer = value(&service, request(LIST, params, None)).await.expect("list");
                let ids: Vec<&str> = answer["data"].as_array().expect("data").iter().map(|row| row["id"].as_str().expect("id")).collect();
                let want: Vec<&str> = page["ids"].as_array().expect("ids").iter().map(|id| id.as_str().expect("id")).collect();
                assert_eq!(ids, want, "limit {} cursor {}", walk["limit"], page["cursor"]);
                assert_eq!(answer["nextCursor"].as_str(), page["nextCursor"].as_str());
                for row in answer["data"].as_array().expect("data") {
                    let node = summaries[row["id"].as_str().expect("id")];
                    for field in ["title", "updatedAt", "messageCount", "cwd", "preview"] {
                        assert_eq!(row[field], node[field], "{field} of {}", row["id"]);
                    }
                    assert_eq!(row["working"] == json!(true), row["id"] == "s_a");
                }
                walked += 1;
            }
        }
        assert!(walked > 8);
    }

    /// Rooms `room01` (listed) and `gone01` (no listed row): a room's log row gets its `agentRoom`.
    struct Stamp;
    #[async_trait]
    impl ListRooms for Stamp {
        async fn with_rooms(&self, rows: Vec<ThreadSummary>) -> Result<Vec<ThreadSummary>, String> {
            Ok(rows
                .into_iter()
                .map(|mut row| {
                    if row.id.as_str().starts_with("sess_room_") {
                        row.title = "Room one".into();
                        row.agent_room = Some(json!({ "id": "room01" }));
                    }
                    row
                })
                .collect())
        }
        async fn room_threads(&self) -> Result<Vec<ThreadId>, String> {
            Ok(vec![ThreadId::from("sess_room_room01".to_owned()), ThreadId::from("sess_room_gone01".to_owned())])
        }
        /// The row made from the saved room alone (`catalogWithRooms`' `unlisted`).
        async fn unlisted(&self, logs: &[ThreadId]) -> Result<Vec<ThreadSummary>, String> {
            Ok(logs
                .iter()
                .filter(|log| log.as_str() == "sess_room_gone01")
                .map(|log| {
                    serde_json::from_value(json!({ "id": log.as_str(), "preview": "", "title": "Gone", "updatedAt": 5, "messageCount": 0, "cwd": "",
                        "classification": "task", "projectPath": null, "agentRoom": { "id": "gone01" } }))
                    .expect("row")
                })
                .collect())
        }
    }

    /// The app feed and the room publisher over `list`, with what the feed has sent.
    fn room_rig(list: Arc<ThreadListService>) -> (Arc<RoomSummaries>, mixdog_core_api::mock::MockConnection) {
        let (summaries, app, _) = room_rig_on(list);
        (summaries, app)
    }

    /// [`room_rig`] with the app feed's section, for the index writes' notifications to share it.
    fn room_rig_on(list: Arc<ThreadListService>) -> (Arc<RoomSummaries>, mixdog_core_api::mock::MockConnection, Arc<mixdog_core_base::state::SectionFeedState>) {
        use mixdog_core_api::FeedSource;
        use mixdog_core_api::mock::MockConnection;
        use mixdog_core_api::mock::MockFeed;
        use mixdog_core_api::mock::MockLimits;

        let limits = MockLimits::default();
        let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
        let app = MockConnection::new(ConnectionId(1), limits);
        let source: Arc<dyn FeedSource> = feed.clone();
        let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).unwrap();
        mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(crate::session::SessionDirectory::new(rig.deps()));
        let section = Arc::new(mixdog_core_base::state::SectionFeedState::new(feed));
        (RoomSummaries::new(list, section.clone(), directory), app, section)
    }

    /// The edges' task workspace lookup, with a stop in front of the next one where a test arms it: the lookup says it arrived and
    /// answers once the test opens it.
    #[derive(Default)]
    struct HeldLookup(std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, tokio::sync::oneshot::Receiver<()>)>>);
    #[async_trait]
    impl super::super::TaskWorkspace for HeldLookup {
        async fn path(&self) -> Result<String, String> {
            let stop = self.0.lock().unwrap().take();
            if let Some((reached, held)) = stop {
                let _ = reached.send(());
                let _ = held.await;
            }
            Ok("/tasks".into())
        }
    }

    /// A listing that reads a row whose write committed while it waited for the projections (its index write made after the
    /// listing began) sends that row only after the write's own `thread/started`: the write's notification held at its lookup,
    /// the listing, which has read the row, waits for it; let go, the row's first frame is `thread/started`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_listing_sends_a_row_it_read_only_after_its_write_is_announced() {
        const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
        let data = crate::session::testing::DataDir::default();
        let list = room_list(&data).await;
        let (summaries, app, section) = room_rig_on(list.clone());
        let lookup = Arc::new(HeldLookup::default());
        let deletions = super::super::thread_edges::ThreadDeletions::new(section.clone());
        let edges = super::super::thread_edges::ThreadEdges::start(super::super::thread_edges::ThreadEdgePublisher::new(list.clone(), section, deletions, lookup.clone()));
        list.store.observe_rows(edges.clone()).expect("the row sink");
        summaries.follow(edges.clone());
        drop(app.drain_text());

        // The listing stops in front of the projections it waits for, before it reads.
        let (open_fence, held) = tokio::sync::oneshot::channel();
        let (reached, at_fence) = tokio::sync::oneshot::channel();
        list.fence(Arc::new(Gate(std::sync::Mutex::new(Some((reached, held))))));
        let mut listing = {
            let summaries = summaries.clone();
            tokio::spawn(async move { summaries.publish_catalogs().await })
        };
        mixdog_rt::time::timeout(DEADLINE, at_fence).await.expect("the listing never waited for the projections").expect("gate");

        // The row's write commits there; its notification stops at its lookup.
        let (open_edge, held) = tokio::sync::oneshot::channel();
        let (reached, at_edge) = tokio::sync::oneshot::channel();
        *lookup.0.lock().unwrap() = Some((reached, held));
        let id = "sess_written_late";
        let header = json!({ "id": id, "title": "Written late", "cwd": "C:\\Tasks", "desktopSession": { "classification": "task", "projectPath": null }, "createdAt": 9_000_000_000_000_i64, "updatedAt": 9_000_000_000_000_i64 });
        let head = CatalogHead { session: id.into(), log_id: "L".into(), base_session: None, header: header.as_object().expect("object").clone() };
        list.store.upsert(head, DirtyMark::Clear).await.expect("upsert");
        mixdog_rt::time::timeout(DEADLINE, at_edge).await.expect("the write was never announced").expect("stop");

        // The listing reads the row; it may not send it while the row's `thread/started` is held.
        let mut waits = edges.waits();
        let before = *waits.borrow_and_update();
        open_fence.send(()).expect("the listing waits at the fence");
        mixdog_rt::time::timeout(DEADLINE, async {
            tokio::select! {
                waited = waits.wait_for(|waits| *waits > before) => drop(waited.expect("the waits are held by the edges")),
                ended = &mut listing => ended.expect("the listing's task"),
            }
        })
        .await
        .expect("the listing neither ended nor waited for the write's announcement");
        open_edge.send(()).expect("the announcement waits at the stop");
        if !listing.is_finished() {
            mixdog_rt::time::timeout(DEADLINE, listing).await.expect("the listing never ended").expect("the listing's task");
        }
        mixdog_rt::time::timeout(DEADLINE, edges.settled()).await.expect("the write was never published");

        let frames: Vec<String> = app
            .drain_text()
            .into_iter()
            .map(|text| serde_json::from_str::<Value>(&text[text.find('{').expect("json body")..]).expect("frame"))
            .filter(|frame| frame["params"]["thread"]["id"] == id)
            .map(|frame| frame["method"].as_str().expect("method").to_owned())
            .collect();
        // The listing's copy of the row is the one the `thread/started` carried: Node hands a catalog its listener already holds once.
        assert_eq!(frames, ["thread/started"], "the late row's frames");
    }

    /// The index holds the log of `room01` and not that of `gone01`.
    async fn room_list(data: &crate::session::testing::DataDir) -> Arc<ThreadListService> {
        let golden = golden();
        let store = service(data, &golden).await.store;
        let header = json!({ "id": "sess_room_room01", "title": "log", "cwd": "C:\\Tasks", "createdAt": 1000, "updatedAt": 1000 });
        let head = CatalogHead { session: "sess_room_room01".into(), log_id: "L".into(), base_session: None, header: header.as_object().unwrap().clone() };
        store.upsert(head, DirtyMark::Clear).await.expect("upsert");
        Arc::new(ThreadListService::new(store, Arc::new(Busy), Arc::new(Stamp), Arc::new(crate::session::testing::FixedTaskWorkspace("/tasks"))))
    }

    /// A publication carries every saved room as Node's in-memory catalog does inside the call (`catalogWithRooms`): the log
    /// the index holds stamped with its room, and the room whose log the index does not hold as the row made from the saved
    /// room. No projection decides it: with a projection held pending for good, the pass answers at its first poll.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_publication_carries_every_saved_room_whether_or_not_the_index_holds_its_log() {
        let data = crate::session::testing::DataDir::default();
        let list = room_list(&data).await;
        let (_never_opened, held) = tokio::sync::oneshot::channel();
        let (reached, _waiting) = tokio::sync::oneshot::channel();
        list.fence(Arc::new(Gate(std::sync::Mutex::new(Some((reached, held))))));
        let (summaries, app) = room_rig(list);

        let pass = summaries.publish();
        tokio::pin!(pass);
        assert!(polled(&mut pass).await.is_ready(), "the publication waited for the index");
        let sent: Vec<String> = app.drain_text().into_iter().filter(|text| text.contains(SUMMARY_UPDATED)).collect();
        assert_eq!(sent.len(), 2, "{sent:?}");
        assert!(sent[0].contains(r#""id":"sess_room_room01""#) && sent[0].contains(r#""agentRoom":{"id":"room01"}"#), "{}", sent[0]);
        assert!(sent[0].contains(r#""title":"Room one""#), "{}", sent[0]);
        assert!(sent[1].contains(r#""id":"sess_room_gone01""#) && sent[1].contains(r#""agentRoom":{"id":"gone01"}"#), "{}", sent[1]);
    }

    /// Node's catalog channel hands a listener only a catalog that differs from the one it holds
    /// (`session-host-publication.ts:141`): a second pass over unchanged rooms sends nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_pass_over_unchanged_rows_sends_nothing() {
        let data = crate::session::testing::DataDir::default();
        let list = room_list(&data).await;
        let (summaries, app) = room_rig(list);
        summaries.publish().await;
        let first = app.drain_text().into_iter().filter(|text| text.contains(SUMMARY_UPDATED)).count();
        assert_eq!(first, 2, "the first pass sends both room rows");
        summaries.publish().await;
        let again: Vec<String> = app.drain_text().into_iter().filter(|text| text.contains(SUMMARY_UPDATED)).collect();
        assert!(again.is_empty(), "an unchanged row was sent again: {again:?}");
    }

    /// Tells a waiter when a listing is published.
    struct Listed(std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>);
    impl mixdog_core_api::state::CatalogObserver for Listed {
        fn published(&self, _ids: &[&str]) {
            if let Some(told) = self.0.lock().unwrap().take() {
                let _ = told.send(());
            }
        }
    }

    /// A room call before any listing starts Node's background `publishCatalogs`: a whole listing that marks the catalog loaded
    /// (`session-host-catalog.ts:231`, `session-host.ts:807`), so the next room call publishes inside the call.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_room_call_before_any_listing_lists_in_the_background_and_the_next_call_is_loaded() {
        let data = crate::session::testing::DataDir::default();
        let list = room_list(&data).await;
        let (told, listed) = tokio::sync::oneshot::channel();
        list.observe(Arc::new(Listed(std::sync::Mutex::new(Some(told)))));
        let (summaries, app) = room_rig(list.clone());

        assert!(!list.catalog_loaded());
        let publish = mixdog_rt::CancellationToken::new();
        publish.cancel();
        let ended = summaries.republish_catalog(publish.clone()).await.expect("the first call answers without the publication").expect("a background listing");
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), listed).await.expect("the background publication never listed").expect("told");
        mixdog_rt::time::timeout(std::time::Duration::from_secs(10), ended).await.expect("the background listing never ended");
        assert!(list.catalog_loaded(), "the background publication left the catalog unloaded");
        assert!(summaries.republish_catalog(publish).await.expect("the second call publishes inside the call").is_none(), "the second call is loaded");
        // Every row of the background listing went out once; the second call's pass (inside the call, as its `None` shows) sent
        // the two room rows the listing had sent already, which Node's catalog channel does not hand again.
        let sent = app.drain_text().into_iter().filter(|text| text.contains(SUMMARY_UPDATED)).count();
        let whole = list.whole_listing().await.expect("the whole listing").len();
        assert_eq!(sent, whole, "a row that did not change was sent again");
    }

    /// A room's republish sets its log thread's `roomView` (opening the log for it), so the
    /// thread feed carries `thread/roomView/updated` and every later snapshot the view; a cleared
    /// view removes it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_room_republish_sets_the_room_view_on_its_log_thread() {
        use mixdog_core_api::mock::MockFeed;
        use mixdog_core_api::mock::MockLimits;
        use mixdog_store::schema::record::Header;

        let golden = golden();
        let data = crate::session::testing::DataDir::default();
        let list = Arc::new(ThreadListService::new(service(&data, &golden).await.store, Arc::new(Busy), Arc::new(NoRooms), Arc::new(crate::session::testing::FixedTaskWorkspace("/tasks"))));
        let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), MockLimits::default()));
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(crate::session::SessionDirectory::new(rig.deps()));
        let thread = ThreadId::from("sess_room_room09".to_owned());
        let mut header = Header::new();
        header.insert("createdAt".into(), json!(1));
        header.insert("updatedAt".into(), json!(1));
        directory.create_with_id(thread.clone(), header, json!({})).await.expect("room log");
        let summaries = RoomSummaries::new(list, Arc::new(mixdog_core_base::state::SectionFeedState::new(feed)), directory.clone());

        let view = ThreadRoomView {
            busy: true,
            tool_approval: Some(json!({ "id": "7", "name": "ask_user", "kind": "question" })),
            typing: Some(json!({ "kind": "notice", "id": "room-typing-n1", "tone": "info", "text": "Git Hub…", "room": { "kind": "typing", "speaker": "gh.bot", "name": "Git Hub" } })),
            handoff_questions: None,
        };
        let log = directory.handle(&thread).expect("loaded");
        summaries.publish_room(&thread, Some(view.clone())).await;
        let shown = crate::eventually_on!(&[&log.cell.stepped], || {
            directory.handle(&thread).and_then(|handle| handle.cell.view.load_full().state.room_view.clone())
        })
        .await;
        assert_eq!(shown, view);
        let sent: Vec<Value> =
            rig.feeds.frames(thread.as_str()).into_iter().filter(|(_, method, _)| method == "thread/roomView/updated").map(|(_, _, params)| params["value"].clone()).collect();
        assert_eq!(sent, vec![serde_json::to_value(&view).unwrap()]);

        summaries.publish_room(&thread, None).await;
        crate::eventually_on!(&[&log.cell.stepped], || {
            directory.handle(&thread).filter(|handle| handle.cell.view.load_full().state.room_view.is_none()).map(drop)
        })
        .await;
    }

    /// Node's control session is created empty (`desktopSession: null`, no message) and never listed: `isLeadVisibleRow`
    /// drops "a previewless zero-message row with no title" (`lead.rs`), and the app feed's `thread/summary/updated` is
    /// published from the row `summary` answers. The desktop's control thread (`thread/start{kind:"task"}`) is such a row
    /// until it holds a message or a title, with no flag of its own; the same row with a title is listed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_task_thread_with_no_message_and_no_title_is_never_listed() {
        let golden = golden();
        let data = crate::session::testing::DataDir::default();
        let service = service(&data, &golden).await;
        let id = "sess_control_probe";
        // What `thread/start` writes: the creation times, no title, no preview, no message.
        let header = json!({ "id": id, "createdAt": 9_000_000_000_000_i64, "updatedAt": 9_000_000_000_000_i64 });
        let head = |header: &Value| CatalogHead { session: id.into(), log_id: "L".into(), base_session: None, header: header.as_object().expect("object").clone() };
        let listed = |answer: &Value| answer["data"].as_array().expect("data").iter().any(|row| row["id"] == id);
        service.store.upsert(head(&header), DirtyMark::Clear).await.expect("upsert");
        let answer = value(&service, request(LIST, json!({ "limit": 1000 }), None)).await.expect("list");
        assert!(!listed(&answer), "an empty untitled thread is listed");
        assert!(service.summary(&ThreadId::from(id.to_owned())).await.expect("summary").is_none(), "its row is published");

        let mut titled = header.clone();
        titled["title"] = json!("Probe");
        service.store.upsert(head(&titled), DirtyMark::Clear).await.expect("upsert");
        let answer = value(&service, request(LIST, json!({ "limit": 1000 }), None)).await.expect("list");
        assert!(listed(&answer), "the rule is the emptiness rule, not the id");
        assert!(service.summary(&ThreadId::from(id.to_owned())).await.expect("summary").is_some());
    }

    /// A stored `desktopSession` classifies the listed row as `_desktopSessionSummary` does, in the page and in the row the
    /// app feed publishes (`summary`): a task has no project path, a project names its own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stored_desktop_session_classifies_the_listed_thread() {
        let golden = golden();
        let data = crate::session::testing::DataDir::default();
        let service = service(&data, &golden).await;
        let rows = [
            ("sess_class_task", json!({ "classification": "task", "projectPath": null }), "C:\\Tasks"),
            ("sess_class_project", json!({ "classification": "project", "projectPath": "C:\\Repo" }), "C:\\Repo"),
        ];
        for (id, desktop, cwd) in &rows {
            let header = json!({ "id": id, "title": "Classified", "cwd": cwd, "desktopSession": desktop, "createdAt": 9_000_000_000_000_i64, "updatedAt": 9_000_000_000_000_i64 });
            let head = CatalogHead { session: (*id).into(), log_id: "L".into(), base_session: None, header: header.as_object().expect("object").clone() };
            service.store.upsert(head, DirtyMark::Clear).await.expect("upsert");
        }
        let answer = value(&service, request(LIST, json!({ "limit": 1000 }), None)).await.expect("list");
        let row_of = |id: &str| answer["data"].as_array().expect("data").iter().find(|row| row["id"] == id).cloned().expect("listed");
        for (id, desktop, _) in &rows {
            let listed = row_of(id);
            assert_eq!(listed["classification"], desktop["classification"], "{id}");
            assert_eq!(listed["projectPath"], desktop["projectPath"], "{id}");
            let published = service.summary(&ThreadId::from((*id).to_owned())).await.expect("summary").expect("row");
            let published = serde_json::to_value(published).expect("summary json");
            assert_eq!(published["classification"], desktop["classification"], "{id}");
            assert_eq!(published["projectPath"], desktop["projectPath"], "{id}");
        }
    }

    use crate::session::seams::AppendPosition;
    use crate::session::seams::BarrierError;
    use crate::session::seams::CommitRecord;
    use crate::session::seams::SessionLog;
    use crate::session::seams::ThreadStore;
    use mixdog_rt::DurabilityIo;
    use mixdog_rt::InLane;
    use mixdog_rt::InteractiveIo;

    /// The gate between a room post's two writes: a commit that stores a message row without the post's stamp (`updatedAt`
    /// 5000) says so once it is stored, and returns once the test lets it go, so whatever its projection publishes is seen
    /// before the stamp can be stored.
    type Split = std::sync::Mutex<Option<(tokio::sync::oneshot::Sender<()>, std::sync::mpsc::Receiver<()>)>>;

    fn stamped(record: &mixdog_store::schema::record::Record) -> bool {
        use mixdog_store::schema::blob::Slot;
        use mixdog_store::schema::record::MetaRecord;
        use mixdog_store::schema::record::Record;
        matches!(record, Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) if change.set.get("updatedAt") == Some(&json!(5000)))
    }

    struct GatedLog {
        inner: Box<dyn SessionLog>,
        split: Arc<Split>,
    }
    impl SessionLog for GatedLog {
        fn commit(&mut self, lane: &InLane<DurabilityIo>, batch: &[CommitRecord]) -> Result<Vec<u64>, BarrierError> {
            let ordinals = self.inner.commit(lane, batch)?;
            let row = batch.iter().any(|c| matches!(&*c.record, mixdog_store::schema::record::Record::Item(_)));
            if row && !batch.iter().any(|c| stamped(&c.record)) {
                let stop = self.split.lock().unwrap().take();
                if let Some((reached, held)) = stop {
                    let _ = reached.send(());
                    let _ = held.recv();
                }
            }
            Ok(ordinals)
        }
        fn retry(&mut self, lane: &InLane<DurabilityIo>) -> Result<(), BarrierError> {
            self.inner.retry(lane)
        }
    }

    /// The store, its logs behind [`GatedLog`].
    struct GatedStore {
        inner: Arc<dyn ThreadStore>,
        split: Arc<Split>,
    }
    impl ThreadStore for GatedStore {
        fn read_head(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<crate::session::seams::HeadRead, CoreError> {
            self.inner.read_head(lane, id)
        }
        fn read_header(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<mixdog_store::schema::record::Header, CoreError> {
            self.inner.read_header(lane, id)
        }
        fn read_log_id(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<String, CoreError> {
            self.inner.read_log_id(lane, id)
        }
        fn read_window(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, head: &crate::session::seams::HeadRead) -> Result<crate::session::seams::WindowRead, CoreError> {
            self.inner.read_window(lane, id, head)
        }
        fn decode(&self, lane: &InLane<mixdog_rt::CpuInteractive>, id: &ThreadId, head: crate::session::seams::HeadRead, window: crate::session::seams::WindowRead) -> Result<crate::session::seams::OpenedLog, CoreError> {
            self.inner.decode(lane, id, head, window)
        }
        fn user_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<mixdog_store::schema::record::ItemRecord>, CoreError> {
            self.inner.user_rows(lane, id)
        }
        fn history_rows(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<(u64, Vec<mixdog_store::schema::record::ItemRecord>), CoreError> {
            self.inner.history_rows(lane, id)
        }
        fn thread_op(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<crate::session::seams::StoredOp>, CoreError> {
            self.inner.thread_op(lane, id, op)
        }
        fn fenced_ops(&self, lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError> {
            self.inner.fenced_ops(lane, id)
        }
        fn history_row(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<(u64, mixdog_store::schema::record::ItemRecord)>, CoreError> {
            self.inner.history_row(lane, id, iid)
        }
        fn compaction_entry(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
            self.inner.compaction_entry(lane, id, iid)
        }
        fn context_io(&self, lane: &InLane<InteractiveIo>, id: &ThreadId, read: Option<crate::session::seams::ContextRead>) -> Result<crate::session::seams::ContextRead, CoreError> {
            self.inner.context_io(lane, id, read)
        }
        fn session_meta(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<Option<crate::session::seams::SessionMeta>, CoreError>> {
            self.inner.session_meta(id)
        }
        fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>> {
            self.inner.purge_deleted()
        }
        fn copies_of(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<crate::session::seams::OffloadCopies, CoreError>> {
            self.inner.copies_of(id)
        }
        fn record_offload_scan(&self, session: &str, ordinal: i64, sources: Vec<String>) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
            self.inner.record_offload_scan(session, ordinal, sources)
        }
        fn context_cpu(&self, lane: &InLane<mixdog_rt::CpuInteractive>, read: crate::session::seams::ContextRead) -> Result<crate::session::seams::ContextStep, CoreError> {
            self.inner.context_cpu(lane, read)
        }
        fn open_log(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, at: AppendPosition) -> Result<Box<dyn SessionLog>, BarrierError> {
            let inner = self.inner.open_log(lane, id, at)?;
            Ok(Box::new(GatedLog { inner, split: self.split.clone() }))
        }
        fn create_log(&self, lane: &InLane<DurabilityIo>, id: &ThreadId, session: &CommitRecord) -> Result<(Box<dyn SessionLog>, u64), BarrierError> {
            let (inner, ordinal) = self.inner.create_log(lane, id, session)?;
            Ok((Box::new(GatedLog { inner, split: self.split.clone() }), ordinal))
        }
    }

    /// A room post's rows and the `updatedAt` it stamps (`thread/roomRows/commit`) change the room's row in one step, as Node's
    /// one save of the log does: a client of the app feed is never handed the room log with a message newer than its
    /// `updatedAt` (its `messageCount` up, its `updatedAt` not). A commit that stores the rows without the stamp is held, once
    /// stored, until what its projection publishes is seen: the point where the rows alone reach the client.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_room_post_changes_the_rooms_row_and_its_updated_at_in_one_step() {
        use mixdog_core_api::FeedSource;
        use mixdog_core_api::mock::MockConnection;
        use mixdog_core_api::mock::MockFeed;
        use mixdog_core_api::mock::MockLimits;
        use mixdog_store::schema::record::Header;
        use std::sync::atomic::Ordering::SeqCst;

        use crate::session::room_log::RoomLog;

        const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
        let data = crate::session::testing::DataDir::default();
        let tokens = mixdog_rt::testing::tokens();
        let root = data.path().to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let index = data.index(index);
        let list = Arc::new(ThreadListService::new(Arc::new(index.clone()), Arc::new(Busy), Arc::new(NoRooms), Arc::new(crate::session::testing::FixedTaskWorkspace("/tasks"))));
        let threads = Arc::new(
            crate::session::StoreThreads::over_data_dir(data.path(), index, Arc::new(mixdog_core_api::domain::mock::MockOwnership::default()), tokens.maintenance_io)
                .await
                .expect("the thread store"),
        );
        list.fence(threads.clone());
        let rig = crate::session::testing::Rig::new();
        let split = Arc::new(Split::default());
        let deps = rig.deps_parts(Arc::new(GatedStore { inner: threads, split: split.clone() }));
        let directory = Arc::new(crate::session::SessionDirectory::new(Arc::new(deps)));

        let limits = MockLimits::default();
        let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
        let app = MockConnection::new(ConnectionId(1), limits);
        let source: Arc<dyn FeedSource> = feed.clone();
        let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).unwrap();
        mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
        let section = Arc::new(mixdog_core_base::state::SectionFeedState::new(feed));
        let deletions = super::super::thread_edges::ThreadDeletions::new(section.clone());
        let edges = super::super::thread_edges::ThreadEdges::start(super::super::thread_edges::ThreadEdgePublisher::new(
            list.clone(),
            section,
            deletions,
            Arc::new(crate::session::testing::FixedTaskWorkspace("/tasks")),
        ));
        list.store.observe_rows(edges.clone()).expect("the row sink");

        let thread = ThreadId::from("sess_room_post01".to_owned());
        let mut header = Header::new();
        header.insert("title".into(), json!("Room"));
        header.insert("cwd".into(), json!("/tasks"));
        header.insert("createdAt".into(), json!(1000));
        header.insert("updatedAt".into(), json!(1000));
        directory.create_with_id(thread.clone(), header, json!({})).await.expect("room log");
        value(list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("the log is projected");
        tokio::time::timeout(DEADLINE, edges.settled()).await.expect("the log's row was never published");

        rig.clock.0.store(5000, SeqCst);
        let (reached, mut stored_alone) = tokio::sync::oneshot::channel();
        let (open, held) = std::sync::mpsc::channel();
        *split.lock().unwrap() = Some((reached, held));
        let mut posting = {
            let room_log = crate::session::room_log::SessionRoomLog::new(directory.clone());
            let id = thread.as_str().to_owned();
            tokio::spawn(async move {
                room_log.append_rows(&id, vec![json!({ "role": "assistant", "content": "posted", "meta": { "transcript": { "messageId": "m1" } } })]).await
            })
        };
        // Either the post answers (its rows and stamp stored together), or its rows were stored alone: then what they publish
        // is taken before the stamp may follow.
        let answered = tokio::time::timeout(DEADLINE, async {
            tokio::select! {
                answer = &mut posting => Some(answer),
                Ok(()) = &mut stored_alone => None,
            }
        })
        .await
        .expect("the post neither answered nor stored its rows");
        let answered = match answered {
            Some(answer) => answer,
            None => {
                value(list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("the rows are projected");
                tokio::time::timeout(DEADLINE, edges.settled()).await.expect("the rows' row was never published");
                open.send(()).expect("the commit waits at its stop");
                tokio::time::timeout(DEADLINE, posting).await.expect("the post never answered")
            }
        };
        drop(open);
        assert_eq!(answered.expect("the post's task").expect("the post"), 1);
        value(list.as_ref(), request(LIST, json!({ "limit": 1000 }), None)).await.expect("the post is projected");
        tokio::time::timeout(DEADLINE, edges.settled()).await.expect("the post's row was never published");

        let rows: Vec<Value> = app
            .drain_text()
            .into_iter()
            // A control release carries no JSON body.
            .filter_map(|text| text.find('{').map(|at| serde_json::from_str::<Value>(&text[at..]).expect("frame")))
            .filter(|frame| frame["params"]["thread"]["id"] == thread.as_str())
            .map(|frame| frame["params"]["thread"].clone())
            .collect();
        let posted: Vec<&Value> = rows.iter().filter(|row| row["messageCount"] == 1).collect();
        assert!(!posted.is_empty(), "the post's row was never published: {rows:?}");
        for row in &posted {
            assert_eq!(row["updatedAt"], 5000, "a row with the posted message and an older updatedAt was published: {row}");
        }
    }

    /// A cursor that does not decode is Node's `EINVALIDCURSOR` failure; a text search or another
    /// ordering is not served by this listing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refusals() {
        let golden = golden();
        let data = crate::session::testing::DataDir::default();
        let service = service(&data, &golden).await;
        let refused = |params: Value| {
            let service = &service;
            async move { value(service, request(LIST, params, None)).await.expect_err("refused") }
        };
        match refused(json!({ "cursor": "!!!" })).await {
            CoreError::DomainError { code, message, .. } => {
                assert_eq!(code.as_deref(), Some("EINVALIDCURSOR"));
                assert_eq!(message.as_deref(), Some("invalid session catalog cursor"));
            }
            other => panic!("{other:?}"),
        }
        for params in [json!({ "searchTerm": "x" }), json!({ "sortKey": "createdAt" }), json!({ "sortDirection": "asc" })] {
            assert!(matches!(refused(params).await, CoreError::InvalidParams { .. }));
        }
    }
}
