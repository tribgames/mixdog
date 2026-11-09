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

use super::transcript::summary_of_list_row;

pub const LIST: &str = "thread/list";
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
}

impl RowOverlay {
    fn lay_over(self, row: &mut ThreadSummary) {
        row.working = self.working.or(row.working);
        row.agent_working = self.agent_working.or(row.agent_working);
        row.awaiting_approval = self.awaiting_approval.or(row.awaiting_approval);
        row.awaiting_question = self.awaiting_question.or(row.awaiting_question);
        row.handed_by = self.handed_by.or_else(|| row.handed_by.take());
    }
}

/// The host side of the overlay: the live facts of one session.
pub trait ListOverlay: Send + Sync {
    fn of(&self, thread: &ThreadId) -> RowOverlay;
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

    fn of(&self, thread: &ThreadId) -> RowOverlay {
        let mut overlay = RowOverlay::default();
        if let Some(handle) = self.directory.handle(thread) {
            if handle.cell.run.load().is_some() {
                overlay.working = Some(true);
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
}

/// `thread/list` over the catalog index.
pub struct ThreadListService {
    store: Arc<SqliteStore>,
    overlay: Arc<dyn ListOverlay>,
    rooms: Arc<dyn ListRooms>,
    /// Told of every row this service shows (see [`CatalogObserver`]).
    observer: OnceLock<Arc<dyn CatalogObserver>>,
}

impl ThreadListService {
    pub fn new(store: Arc<SqliteStore>, overlay: Arc<dyn ListOverlay>, rooms: Arc<dyn ListRooms>) -> Self {
        Self { store, overlay, rooms, observer: OnceLock::new() }
    }

    /// Connects the observer of the published catalog. Set once.
    pub fn observe(&self, observer: Arc<dyn CatalogObserver>) {
        let _ = self.observer.set(observer);
    }

    fn published(&self, ids: &[&str]) {
        if let Some(observer) = self.observer.get() {
            observer.published(ids);
        }
    }

    fn row_of(&self, id: &ThreadId, listed: &LeadRow) -> ThreadSummary {
        let mut row = summary_of_list_row(id, &serde_json::Value::Object(listed.row.clone()), listed.archived);
        self.overlay.of(id).lay_over(&mut row);
        row
    }

    async fn with_rooms(&self, rows: Vec<ThreadSummary>) -> Result<Vec<ThreadSummary>, CoreError> {
        self.rooms.with_rooms(rows).await.map_err(|error| failed(DOMAIN, error))
    }

    /// The row `thread/list` shows for `id`; `None` when the listing has none.
    pub async fn summary(&self, id: &ThreadId) -> Result<Option<ThreadSummary>, CoreError> {
        let listed = self.store.lead_row(id.as_str()).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        let Some(listed) = listed else { return Ok(None) };
        self.summary_of(id, &listed).await
    }

    /// The row `thread/list` shows for `id` over the listed row in hand (what the index held when it was written).
    pub(super) async fn summary_of(&self, id: &ThreadId, listed: &LeadRow) -> Result<Option<ThreadSummary>, CoreError> {
        let row = self.with_rooms(vec![self.row_of(id, listed)]).await?.pop();
        if let Some(row) = &row {
            self.published(&[row.id.as_str()]);
        }
        Ok(row)
    }

    async fn list(&self, params: ThreadListParams) -> Result<ThreadListResponse, CoreError> {
        if params.search_term.as_deref().is_some_and(|term| !term.is_empty()) {
            return Err(invalid("searchTerm", "absent: the listing has no text search (`thread/search` is the search)"));
        }
        if params.sort_key.is_some() {
            return Err(invalid("sortKey", "absent: the listing is in catalog order"));
        }
        if params.sort_direction.is_some_and(|direction| direction != SortDirection::Desc) {
            return Err(invalid("sortDirection", "desc: the listing is newest activity first"));
        }
        let limit = match params.limit.map(|limit| limit as usize) {
            Some(requested) if requested > 0 => requested.min(MAX_PAGE_LIMIT),
            _ => DEFAULT_PAGE_LIMIT,
        };
        let after = decode_catalog_cursor(params.cursor.as_deref())
            .map_err(|error| coded(DOMAIN, "EINVALIDCURSOR", error.to_string()))?;
        let filter = LeadFilter { archived: params.archived, cwd: params.cwd };
        let page = self.store.lead_page(after, filter, limit).await.map_err(|error| failed(DOMAIN, error.to_string()))?;
        let next_cursor = if page.more { page.rows.last().map(|row| encode_catalog_cursor(&row.row)) } else { None };
        let rows = page
            .rows
            .iter()
            .map(|listed| {
                let id = ThreadId::from(listed.row.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned());
                self.row_of(&id, listed)
            })
            .collect();
        let data = self.with_rooms(rows).await?;
        self.published(&data.iter().map(|row| row.id.as_str()).collect::<Vec<_>>());
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
}

impl RoomSummaries {
    pub fn new(
        list: Arc<ThreadListService>,
        app: Arc<mixdog_core_base::state::SectionFeedState>,
        directory: Arc<super::SessionDirectory>,
    ) -> Arc<Self> {
        Arc::new(Self { list, app, directory, pass: mixdog_rt::SerialChain::new() })
    }

    /// The room service's republish input (`SessionRoomHost::new(.., republish)`): starts a pass,
    /// without waiting for it.
    pub fn republish(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move { this.publish().await });
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
        match self.list.summary(room_thread).await {
            Ok(Some(thread)) => self.app.notify(SUMMARY_UPDATED, &ThreadSummaryUpdatedParams { thread }),
            Ok(None) => {}
            Err(error) => tracing::warn!(?error, thread = room_thread.as_str(), "room summaries: the row could not be read"),
        }
    }

    /// One pass: every room's log row, published.
    pub async fn publish(&self) {
        let _pass = self.pass.acquire().await;
        let threads = match self.list.rooms.room_threads().await {
            Ok(threads) => threads,
            Err(error) => {
                tracing::warn!(%error, "room summaries: the rooms could not be read");
                return;
            }
        };
        for id in threads {
            match self.list.summary(&id).await {
                Ok(Some(thread)) => self.app.notify(SUMMARY_UPDATED, &ThreadSummaryUpdatedParams { thread }),
                // A log thread with no listed row (not stored yet, or deleted) has nothing to show.
                Ok(None) => {}
                Err(error) => tracing::warn!(?error, thread = id.as_str(), "room summaries: the row could not be read"),
            }
        }
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

    async fn service(data: &std::path::Path, golden: &Value) -> ThreadListService {
        let tokens = mixdog_rt::testing::tokens();
        let root = data.to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let store = Arc::new(index);
        for entry in golden["sessions"].as_array().expect("sessions") {
            let mut header = entry["record"].as_object().expect("record").clone();
            header.shift_remove("messages");
            let id = header["id"].as_str().expect("id").to_owned();
            store.upsert(CatalogHead { session: id, log_id: "L".into(), base_session: None, header }, DirtyMark::Clear).await.expect("upsert");
        }
        ThreadListService::new(store, Arc::new(Busy), Arc::new(NoRooms))
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

    /// Every page `listStoredSessionSummaryPage` answered over Node's crafted records (the limit
    /// rules, the order, `nextCursor`), and the rows of those pages as Node's `_sessionSummary` built
    /// them. A limit the protocol cannot carry (negative, fractional) is refused by the wire type
    /// before it reaches the handler, so only the in-range limits run here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pages_equal_nodes() {
        let golden = golden();
        let data = tempfile::tempdir().expect("data dir");
        let service = service(data.path(), &golden).await;
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
    }

    /// A republish pass sends each room's log row, stamped as `thread/list` shows it, on the app
    /// feed as `thread/summary/updated`; a room whose log has no listed row sends nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_republish_sends_each_rooms_log_row_on_the_app_feed() {
        use mixdog_core_api::FeedSource;
        use mixdog_core_api::mock::MockConnection;
        use mixdog_core_api::mock::MockFeed;
        use mixdog_core_api::mock::MockLimits;

        let golden = golden();
        let data = tempfile::tempdir().expect("data dir");
        let store = service(data.path(), &golden).await.store;
        let header = json!({ "id": "sess_room_room01", "title": "log", "cwd": "C:\\Tasks", "createdAt": 1000, "updatedAt": 1000 });
        let head = CatalogHead { session: "sess_room_room01".into(), log_id: "L".into(), base_session: None, header: header.as_object().unwrap().clone() };
        store.upsert(head, DirtyMark::Clear).await.expect("upsert");
        let list = Arc::new(ThreadListService::new(store, Arc::new(Busy), Arc::new(Stamp)));

        let limits = MockLimits::default();
        let feed = Arc::new(MockFeed::new("app".into(), mixdog_core_api::mock::epoch(1), Arc::new(mixdog_core_api::mock::EchoView), limits));
        let app = MockConnection::new(ConnectionId(1), limits);
        let source: Arc<dyn FeedSource> = feed.clone();
        let attached = mixdog_core_api::feed::subscribe(&source, "app".into(), mixdog_core_api::feed::Window::Fixed, None, &app).unwrap();
        mixdog_core_api::sink::ConnectionSink::send_control_release(&app, bytes::Bytes::from_static(b"{}"), attached.release).unwrap();
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(crate::session::SessionDirectory::new(rig.deps()));
        let summaries = RoomSummaries::new(list, Arc::new(mixdog_core_base::state::SectionFeedState::new(feed)), directory);

        summaries.publish().await;
        let sent: Vec<String> = app.drain_text().into_iter().filter(|text| text.contains(SUMMARY_UPDATED)).collect();
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert!(sent[0].contains(r#""id":"sess_room_room01""#) && sent[0].contains(r#""agentRoom":{"id":"room01"}"#), "{}", sent[0]);
        assert!(sent[0].contains(r#""title":"Room one""#), "{}", sent[0]);
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
        let data = tempfile::tempdir().expect("data dir");
        let list = Arc::new(ThreadListService::new(service(data.path(), &golden).await.store, Arc::new(Busy), Arc::new(NoRooms)));
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
        let data = tempfile::tempdir().expect("data dir");
        let service = service(data.path(), &golden).await;
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
        let data = tempfile::tempdir().expect("data dir");
        let service = service(data.path(), &golden).await;
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

    /// A cursor that does not decode is Node's `EINVALIDCURSOR` failure; a text search or another
    /// ordering is not served by this listing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refusals() {
        let golden = golden();
        let data = tempfile::tempdir().expect("data dir");
        let service = service(data.path(), &golden).await;
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
