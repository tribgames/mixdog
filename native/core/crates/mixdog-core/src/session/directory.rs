//! The thread directory (`ThreadDirectory`): a sharded map of loaded threads. Lookups take
//! one shard's `std` lock for O(1) work. A cold open is single-flight (RL §7.3): the first
//! opener inserts `Loading` and spawns the load — open job J1, then J2 on io-interactive, then
//! one decode on cpu-interactive (SPEC R28) — and every concurrent opener waits on the same
//! result. The load runs as its own task, so a waiter that is cancelled stops waiting only.

use std::collections::HashMap;
use std::hash::Hash;
use std::hash::Hasher;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::Ordering::SeqCst;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadStartParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Subscribe;
use mixdog_core_api::feed::Window;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use mixdog_rt::CpuInteractive;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::bounded::Text;
use mixdog_store::schema::record::Base;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::SESSION_RECORD_VERSION;
use mixdog_store::schema::record::SessionRecord;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;

use super::SessionDeps;
use super::actor::ActorChannels;
use super::actor::Inbox;
use super::actor::Init;
use super::actor::SessionActor;
use super::control::ControlCell;
use super::control::Ctl;
use super::durability::DurabilityTask;
use super::durability::LogInit;
use super::handle::SessionHandle;
use super::new_epoch;
use super::new_id;
use super::seams::OpenedLog;
use super::state::Change;
use super::state::Display;
use super::state::SessionState;
use super::view::SessionView;
use crate::approvals::Lineage;

const SHARDS: usize = 64;

/// `INGEST_DEADLINE_MS` (`memory-ingest.mjs:4`): how long shutdown waits for the ingests.
const SHUTDOWN_INGEST_DEADLINE: std::time::Duration = std::time::Duration::from_millis(2500);

type Loaded = Result<Arc<SessionHandle>, CoreError>;

enum Slot_ {
    Loaded(Arc<SessionHandle>),
    Loading(watch::Receiver<Option<Loaded>>),
}

/// A thread `thread/delete` closed: it stays in the directory, taking no work, until marked.
pub(crate) struct DeleteHold {
    handle: Arc<SessionHandle>,
    mark: oneshot::Sender<()>,
    marked: oneshot::Receiver<Result<(), super::run::RunError>>,
}

impl DeleteHold {
    /// The thread's working folder (`cwd`), as it last stood.
    pub(crate) fn cwd(&self) -> Option<String> {
        self.handle.cell.header.load().get("cwd").and_then(Value::as_str).map(str::to_owned)
    }

    /// Appends the delete mark and waits for its ack; the thread then leaves the directory,
    /// and a later open finds it gone. False when the mark was not applied.
    pub(crate) async fn mark(self, directory: &DirInner) -> bool {
        let _ = self.mark.send(());
        let applied = matches!(self.marked.await, Ok(Ok(())));
        let id = &self.handle.id;
        let mut shard = lock(directory.shard(id));
        if matches!(shard.get(id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(h, &self.handle)) {
            shard.remove(id);
        }
        applied
    }
}

pub(crate) struct DirInner {
    deps: Arc<SessionDeps>,
    shards: Box<[Mutex<HashMap<ThreadId, Slot_>>]>,
    me: std::sync::Weak<DirInner>,
    /// `onGoalStatusChange`: each change goes to its loaded thread's Goal lane.
    goal_events: Mutex<Option<crate::goal::Subscription>>,
}

/// A thread to create (`thread/start`, `thread/fork`).
pub(crate) struct CreateSpec {
    pub id: Option<ThreadId>,
    pub header: Header,
    pub base: Option<Base>,
    pub op: Option<OpId>,
    pub method: Method,
    pub params: Value,
}

pub struct SessionDirectory {
    inner: Arc<DirInner>,
}

/// A loaded log as the actor starts from it.
struct Opened {
    state: SessionState,
    log_id: String,
    next_ordinal: u64,
    log: LogInit,
}

impl SessionDirectory {
    pub fn new(deps: Arc<SessionDeps>) -> Self {
        let inner = Arc::new_cyclic(|me| DirInner {
            deps,
            shards: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
            me: me.clone(),
            goal_events: Mutex::new(None),
        });
        let me = Arc::downgrade(&inner);
        let subscription = inner.deps.goals.on_goal_change(Box::new(move |event| {
            let Some(directory) = me.upgrade() else { return };
            if let Some(handle) = directory.loaded(&ThreadId::from(event.session_id.as_str())) {
                let _ = handle.inbox.try_send(Inbox::GoalChanged(event.goal.clone()));
            }
        }));
        *lock(&inner.goal_events) = Some(subscription);
        Self { inner }
    }

    /// The concrete handle of a loaded thread.
    pub fn handle(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
        self.inner.loaded(id)
    }

    /// The loaded thread a run belongs to: a run exists only while its thread is loaded.
    fn running(&self, id: &ThreadId) -> Arc<SessionHandle> {
        self.inner.loaded(id).expect("a running thread is loaded")
    }

    /// `SessionSeams::live_header`: the thread's latest acked header, readable without waiting.
    pub fn live_header(&self, id: &ThreadId) -> Arc<dyn crate::ports::gate::LiveHeader> {
        self.running(id).live_header()
    }

    /// `SessionSeams::grants`: the thread's "Allow for this session" grants.
    pub fn grants(&self, id: &ThreadId) -> Arc<mixdog_tools::policy::SessionGrants> {
        self.running(id).grants()
    }

    /// `RunSettings.thread_window`: the thread's compaction count.
    pub fn thread_window(&self, id: &ThreadId) -> u64 {
        self.running(id).thread_window()
    }

    pub(crate) fn deps(&self) -> &Arc<SessionDeps> {
        &self.inner.deps
    }

    /// `abortSessionTurn(id, reason)`: the turn running in a session no outer turn holds (a
    /// held request's `login-required`, a watchdog) ends with `abortSessionTurn (reason=…)`; the
    /// session stays as it is. False when the thread is not loaded or is closing.
    pub fn abort_session_turn(&self, id: &ThreadId, reason: &str) -> bool {
        let Some(handle) = self.inner.loaded(id).filter(|handle| !handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst)) else {
            return false;
        };
        if let Some(run) = handle.cell.run.load_full() {
            let _ = handle.cell.abort(&run.turn, &mixdog_agent::cancel::abort_session_turn_reason(id.as_str(), reason));
        }
        true
    }

    /// A thread's model context (`session.messages`), read from the store; a thread need not be
    /// loaded.
    pub(crate) fn model_context(&self, id: &ThreadId) -> super::run::ModelContext {
        super::run::ModelContext {
            store: self.inner.deps.store.clone(),
            lanes: self.inner.deps.lanes,
            thread: id.clone(),
            input: mixdog_core_api::ids::ItemId::from(String::new()),
        }
    }

    /// A thread's whole stored history as the transcript shows it, oldest first; a thread need
    /// not be loaded.
    pub(crate) async fn history_items(&self, id: &ThreadId) -> Result<Vec<mixdog_protocol::ThreadItem>, CoreError> {
        let deps = &self.inner.deps;
        let token = CancellationToken::new();
        let dropped = || CoreError::Internal { incident_id: "session-history-job-dropped".into() };
        let (store, thread) = (deps.store.clone(), id.clone());
        let rows = deps.lanes.io.submit(&token, move |lane| store.history_rows(lane, &thread))?.await.map_err(|_| dropped())??;
        let transcript = deps.transcript.clone();
        let items = deps.lanes.cpu.submit(&token, move |lane| {
            rows.iter()
                .flat_map(|row| transcript.items(lane, row))
                .filter_map(|shown| match shown {
                    super::seams::Shown::Item(item) => Some(item),
                    super::seams::Shown::Update(_) => None,
                })
                .collect()
        })?;
        items.await.map_err(|_| dropped())
    }

    /// The live history row `iid` with its ordinal, as the transcript reads it.
    pub(crate) async fn history_row(
        &self,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<(u64, mixdog_store::schema::record::ItemRecord)>, CoreError> {
        let deps = &self.inner.deps;
        let (store, thread, iid) = (deps.store.clone(), id.clone(), iid.to_owned());
        deps.lanes
            .io
            .submit(&CancellationToken::new(), move |lane| store.history_row(lane, &thread, &iid))?
            .await
            .map_err(|_| CoreError::Internal { incident_id: "session-history-job-dropped".into() })?
    }

    /// A completion handed to a live session's listeners (`notifySessionCompletion`): its card,
    /// when the card gates admit one. `false` when the session is not live here.
    pub(crate) async fn show_completion(&self, owner: &ThreadId, content: String, meta: Value) -> bool {
        let Some(handle) = self.inner.loaded(owner) else { return false };
        handle.inbox.send(Inbox::CompletionCard { content, meta }).await.is_ok()
    }

    /// The live compaction (ordinal and `cid`) whose replacement holds the entry `iid`.
    pub(crate) async fn compaction_entry(
        &self,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        let deps = &self.inner.deps;
        let (store, thread, iid) = (deps.store.clone(), id.clone(), iid.to_owned());
        deps.lanes
            .io
            .submit(&CancellationToken::new(), move |lane| store.compaction_entry(lane, &thread, &iid))?
            .await
            .map_err(|_| CoreError::Internal { incident_id: "session-history-job-dropped".into() })?
    }

    /// The agent the calling session's record names, as the agent-editor rule reads it:
    /// `assertAgentEditorAccess` takes `String(caller?.agent || '').trim()` of the record
    /// `getCallerSession` returns (`schedule-access.mjs:99`, `setup-tool/executor.mjs:928`), not
    /// `resolveSessionMode`. An agent-mode session carries its agent there from creation
    /// (`session-lifecycle.mjs:238`). Fills `SetupCallers::acting_agent`; a thread that cannot
    /// be opened is the open's error.
    pub async fn acting_agent(&self, thread: &ThreadId) -> Result<String, CoreError> {
        let handle = self.open_handle(thread, &CallContext::internal("acting-agent")).await?;
        let header = handle.cell.header.load_full();
        let agent = match header.get("agent") {
            None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
            Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f == 0.0 || f.is_nan()) => String::new(),
            Some(agent) => mixdog_js::value_to_string(agent),
        };
        Ok(mixdog_js::js_trim(&agent).to_owned())
    }

    /// The running state a worker's progress read is a function of (`Workers::live`): the
    /// cell's published progress at `now`; nothing for a thread this process does not host.
    pub fn worker_live(
        &self,
        id: &ThreadId,
        now: i64,
        jobs: &dyn crate::run_host::progress::WaitedJobs,
    ) -> mixdog_agent::agent_tool::views::WorkerLive {
        self.handle(id).map(|handle| handle.cell.progress.borrow().live(now, jobs)).unwrap_or_default()
    }

    /// The ids of every loaded thread (the threads this process hosts).
    pub fn loaded_ids(&self) -> Vec<ThreadId> {
        self.inner
            .shards
            .iter()
            .flat_map(|shard| {
                lock(shard)
                    .iter()
                    .filter(|(_, slot)| matches!(slot, Slot_::Loaded(_)))
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Creates the thread under a fixed `id` (agent homes and room sessions are derived keys, not
    /// minted ids) with `header` as its first durable write.
    pub async fn create_with_id(&self, id: ThreadId, header: Header, params: Value) -> Result<(), CoreError> {
        self.inner
            .create(CreateSpec {
                id: Some(id),
                header,
                base: None,
                op: None,
                method: Method("thread/start"),
                params,
            })
            .await
            .map(|_| ())
    }

    /// A session's title, agent, owner session and source type, from the index without loading
    /// it (today's `readStoredSessionMetadata`); `None` for a session the catalog does not list.
    pub async fn session_meta(&self, id: &ThreadId) -> Result<Option<super::seams::SessionMeta>, CoreError> {
        self.inner.deps.store.session_meta(id).await
    }

    /// Core shutdown (today's `teardown.mjs:192`): every loaded thread stops (a live run is
    /// cancelled) and its memory ingest is awaited, all of them together bounded at 2500 ms.
    pub async fn shutdown(&self) {
        let handles: Vec<Arc<SessionHandle>> = self
            .inner
            .shards
            .iter()
            .flat_map(|shard| {
                lock(shard)
                    .drain()
                    .filter_map(|(_, slot)| match slot {
                        Slot_::Loaded(handle) => Some(handle),
                        Slot_::Loading(_) => None,
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let mut ingests = Vec::new();
        for handle in handles {
            let (done, ingest) = tokio::sync::oneshot::channel();
            if handle.cell.ctl_tx.send(Ctl::Shutdown(done)).await.is_ok() {
                ingests.push(ingest);
            }
        }
        let all = futures::future::join_all(ingests.into_iter().map(|ingest| async move {
            if let Ok(ingest) = ingest.await {
                ingest.await;
            }
        }));
        let _ = tokio::time::timeout(SHUTDOWN_INGEST_DEADLINE, all).await;
    }

    /// Opens (single-flight) and returns the concrete handle.
    pub async fn open_handle(
        &self,
        id: &ThreadId,
        ctx: &CallContext,
    ) -> Result<Arc<SessionHandle>, CoreError> {
        self.inner.open(id, ctx).await
    }
}

/// A detached job's completion reaches its owner thread as a `task-notification` row; a thread
/// not loaded is opened for it.
#[async_trait::async_trait]
impl mixdog_tools::exec::TaskNotifier for SessionDirectory {
    /// `notifySessionCompletion`: the live session shows the completion's card as it arrives
    /// (its listeners), then it is queued for the model.
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        let meta = json!({ "execution_surface": surface, "execution_id": task_id, "status": status });
        self.show_completion(owner, notification.clone(), meta).await;
        self.queue_completion(owner, surface, task_id, status, notification).await;
    }
}

impl SessionDirectory {
    /// `enqueueCompletion`: the completion joins the owner's queue; a thread not loaded is
    /// opened for it (and, not live, is never woken by it).
    pub(crate) async fn queue_completion(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, text: String) {
        let msg = |live| Inbox::TaskNotification {
            surface: surface.to_owned(),
            task_id: task_id.to_owned(),
            status: status.to_owned(),
            text: text.clone(),
            live,
        };
        if let Some(handle) = self.inner.loaded(owner) {
            let _ = handle.inbox.send(msg(true)).await;
            return;
        }
        let ctx = CallContext::internal("task-notification");
        if let Ok(handle) = self.inner.open(owner, &ctx).await {
            let _ = handle.inbox.send(msg(false)).await;
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl DirInner {
    fn shard(&self, id: &ThreadId) -> &Mutex<HashMap<ThreadId, Slot_>> {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hasher);
        &self.shards[(hasher.finish() as usize) % SHARDS]
    }

    /// Drops the loaded thread whose cell is `cell` when it still has no subscriber, and
    /// closes the cell under the shard lock. False when a subscriber came back meanwhile.
    pub(crate) fn unload(&self, id: &ThreadId, cell: &Arc<ControlCell>) -> bool {
        let mut shard = lock(self.shard(id));
        let ours = matches!(shard.get(id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(&h.cell, cell));
        if !ours || cell.subscribers.load(SeqCst) != 0 {
            return false;
        }
        // An attach that counts itself after the check sees `closed` and fails.
        cell.closed.store(true, SeqCst);
        shard.remove(id);
        true
    }

    pub(crate) fn deps(&self) -> &Arc<SessionDeps> {
        &self.deps
    }

    pub(crate) fn loaded_handle(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
        self.loaded(id)
    }

    /// `thread/delete`'s `closeSession(id, reason)`: the thread (opened for it when not
    /// loaded) takes no more work and its turn ends; it stays in the directory, closed, until
    /// [`DeleteHold::mark`]. `Ok(Err(refusal))`: `missing` (no such thread, or another delete
    /// holds it), or with `idle` `busy`/`queued`, and nothing changed.
    pub(crate) async fn close_for_delete(
        &self,
        id: &ThreadId,
        reason: &str,
        idle: bool,
    ) -> Result<Result<DeleteHold, &'static str>, CoreError> {
        let handle = match self.loaded(id) {
            Some(handle) => handle,
            None => match self.open_with(id, &CallContext::internal("thread-delete"), false).await {
                Ok(handle) => handle,
                Err(CoreError::ThreadNotFound { .. }) => return Ok(Err("missing")),
                Err(error) => return Err(error),
            },
        };
        let (closed, closed_rx) = oneshot::channel();
        let (mark, mark_rx) = oneshot::channel();
        let (marked_tx, marked) = oneshot::channel();
        let delete = Ctl::Delete { reason: reason.to_owned(), idle, closed, mark: mark_rx, marked: marked_tx };
        let closing = || CoreError::ThreadClosing { thread_id: id.clone() };
        handle.cell.ctl_tx.send(delete).await.map_err(|_| closing())?;
        match closed_rx.await.map_err(|_| closing())? {
            Ok(()) => Ok(Ok(DeleteHold { handle, mark, marked })),
            Err(refusal) => Ok(Err(refusal)),
        }
    }

    fn loaded(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
        match lock(self.shard(id)).get(id) {
            Some(Slot_::Loaded(handle)) => Some(handle.clone()),
            _ => None,
        }
    }

    async fn open(&self, id: &ThreadId, ctx: &CallContext) -> Result<Arc<SessionHandle>, CoreError> {
        self.open_with(id, ctx, true).await
    }

    /// `prewarm`: the effort judge is prewarmed for the opened thread (not for a delete).
    async fn open_with(&self, id: &ThreadId, ctx: &CallContext, prewarm: bool) -> Result<Arc<SessionHandle>, CoreError> {
        let mut rx = {
            let mut shard = lock(self.shard(id));
            match shard.get(id) {
                Some(Slot_::Loaded(handle)) => return Ok(handle.clone()),
                Some(Slot_::Loading(rx)) => rx.clone(),
                None => {
                    let (tx, rx) = watch::channel(None);
                    shard.insert(id.clone(), Slot_::Loading(rx.clone()));
                    let me = self.me.upgrade().expect("the directory is alive while used");
                    let thread = id.clone();
                    mixdog_rt::spawn("session-open", TaskClass::Work, async move {
                        let result = me.load(&thread, prewarm).await;
                        {
                            let mut shard = lock(me.shard(&thread));
                            match &result {
                                Ok(handle) => {
                                    shard.insert(thread.clone(), Slot_::Loaded(handle.clone()));
                                }
                                Err(_) => {
                                    shard.remove(&thread);
                                }
                            }
                        }
                        tx.send_replace(Some(result));
                    });
                    rx
                }
            }
        };
        tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => Err(CoreError::ConnectionClosed),
            result = rx.wait_for(Option::is_some) => match result {
                Ok(value) => value.clone().expect("waited for Some"),
                Err(_) => Err(CoreError::ThreadClosing { thread_id: id.clone() }),
            },
        }
    }

    /// J1 and J2 on io-interactive, then one decode on cpu-interactive.
    async fn load(&self, id: &ThreadId, prewarm: bool) -> Loaded {
        let deps = self.deps.clone();
        let token = CancellationToken::new();
        let dropped = || CoreError::Internal {
            incident_id: "session-open-job-dropped".into(),
        };
        let (store, thread) = (deps.store.clone(), id.clone());
        let head = deps
            .lanes
            .io
            .submit(&token, move |lane| store.read_head(lane, &thread))?
            .await
            .map_err(|_| dropped())??;
        let (store, thread) = (deps.store.clone(), id.clone());
        let (head, window) = deps
            .lanes
            .io
            .submit(&token, move |lane| {
                let window = store.read_window(lane, &thread, &head);
                (head, window)
            })?
            .await
            .map_err(|_| dropped())?;
        let window = window?;
        let (decode_deps, thread) = (deps.clone(), id.clone());
        let opened = deps
            .lanes
            .cpu
            .submit(&token, move |lane| {
                let log = decode_deps.store.decode(lane, &thread, head, window)?;
                Ok::<_, CoreError>(fold_opened(lane, &decode_deps, log))
            })?
            .await
            .map_err(|_| dropped())??;
        let lineage = self.lineage_of(id, &opened.state.header);
        if prewarm {
            deps.effort.prewarm(id, &opened.state.header);
        }
        Ok(self.spawn(
            id.clone(),
            opened.state,
            lineage,
            opened.log_id,
            opened.next_ordinal,
            opened.log,
            Init::Open,
        ))
    }

    /// P §8.3: a sub-agent's requests show on its parent's surface.
    fn lineage_of(&self, id: &ThreadId, header: &Header) -> Lineage {
        let Some(parent) = header
            .get("parentSessionId")
            .and_then(Value::as_str)
            .filter(|parent| !parent.is_empty())
            .map(ThreadId::from)
        else {
            return Lineage::top_level(id);
        };
        match self.loaded(&parent) {
            Some(handle) => {
                let mut chain = handle.lineage.chain.clone();
                chain.push(parent);
                Lineage {
                    surface: handle.lineage.surface.clone(),
                    chain,
                }
            }
            None => Lineage {
                surface: parent.clone(),
                chain: vec![parent],
            },
        }
    }

    /// Starts the actor and its durability task for `id`.
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        id: ThreadId,
        state: SessionState,
        lineage: Lineage,
        log_id: String,
        next_ordinal: u64,
        log: LogInit,
        init: Init,
    ) -> Arc<SessionHandle> {
        let deps = &self.deps;
        let limits = deps.limits;
        let (ctl_tx, ctl_rx) = mpsc::channel(limits.control_lane);
        let (inbox_tx, inbox_rx) = mpsc::channel(limits.inbox);
        let (prod_tx, prod_rx) = mpsc::channel(limits.producer_lane);
        let (dur_tx, dur_in) = mpsc::channel(
            limits.window_records + limits.reserve_records + limits.control_lane + 1,
        );
        let (dur_out, dur_rx) = mpsc::channel(8);
        let epoch = new_epoch();
        let feed_id = FeedId::from(id.as_str());
        let view = Arc::new(SessionView::build(
            feed_id.clone(),
            deps.transcript.summary(&id, &state.header),
            &state,
            mixdog_app_protocol::v2::thread::StorageState::Ok,
            None,
        ));
        let feed = deps.feeds.thread_feed(feed_id, epoch.clone(), view.clone());
        let surface = watch::Sender::new(Arc::new(deps.surfaces.surface(&id, &state.header)));
        let cell = Arc::new(ControlCell {
            thread: id.clone(),
            run: Default::default(),
            queued: Default::default(),
            approvals: Default::default(),
            view: arc_swap::ArcSwap::new(view),
            header: arc_swap::ArcSwap::from_pointee(state.header.clone()),
            surface: surface.subscribe(),
            progress: watch::Sender::new(Default::default()),
            turn_messages: watch::Sender::new(Default::default()),
            turn_listeners: Default::default(),
            agent_start: Default::default(),
            grants: Default::default(),
            ctl_tx,
            steer_cap: limits.steer_queue,
            subscribers: Default::default(),
            ever_subscribed: Default::default(),
            closed: Default::default(),
        });
        let handle = Arc::new(SessionHandle {
            id: id.clone(),
            cell: cell.clone(),
            feed: feed.clone(),
            inbox: inbox_tx,
            producers: prod_tx.clone(),
            lineage: lineage.clone(),
            deps: deps.clone(),
            directory: self.me.clone(),
            reactions: Default::default(),
        });
        let durability = DurabilityTask::new(
            id.clone(),
            deps.store.clone(),
            deps.lanes.durability,
            limits.batch_bytes,
            log,
            dur_in,
            dur_out,
        );
        let actor = SessionActor::new(
            id,
            deps.clone(),
            cell,
            feed,
            epoch,
            lineage,
            log_id,
            next_ordinal,
            state,
            surface,
            ActorChannels {
                ctl_rx,
                inbox_rx,
                prod_tx,
                prod_rx,
                dur_tx,
                dur_rx,
                directory: self.me.clone(),
            },
        );
        mixdog_rt::spawn("session-durability", TaskClass::Work, durability.run());
        mixdog_rt::spawn("session-actor", TaskClass::Work, actor.run(init));
        handle
    }

    /// A new thread: its `session` record is its first durable write; the reply follows it.
    pub(crate) async fn create(&self, spec: CreateSpec) -> Result<Arc<SessionHandle>, CoreError> {
        let id = spec.id.unwrap_or_else(|| ThreadId::from(new_id()));
        let invalid = |path: &str| CoreError::InvalidParams {
            path: path.into(),
            expected: "a shorter value".into(),
        };
        let mut header = spec.header;
        header.insert("id".into(), Value::String(id.as_str().to_owned()));
        let log_id = uuid::Uuid::new_v4().simple().to_string()[..24].to_owned();
        let op = match &spec.op {
            Some(op) => Some(mixdog_store::schema::record::OpRef {
                id: Text::try_from(op.as_str()).map_err(|_| invalid("opId"))?,
                method: Text::try_from(spec.method.as_str()).map_err(|_| invalid("method"))?,
                digest: mixdog_store::schema::bounded::Digest::try_from(super::ops::digest(
                    &spec.params,
                ))
                .expect("digest is well formed"),
                result: None,
            }),
            None => None,
        };
        let session = Record::Session(SessionRecord {
            v: SESSION_RECORD_VERSION,
            id: Text::try_from(id.as_str()).map_err(|_| invalid("threadId"))?,
            log_id: Text::try_from(log_id.as_str()).expect("24 hex"),
            base: spec.base,
            origin: None,
            op,
            header: Slot::Inline(header.clone()),
        });
        let mut state = SessionState::new(self.deps.limits.view_items);
        state.header = header.clone();
        let lineage = self.lineage_of(&id, &header);
        let (tx, rx) = oneshot::channel();
        {
            let mut shard = lock(self.shard(&id));
            if shard.contains_key(&id) {
                return Err(CoreError::PreconditionFailed {
                    precondition: mixdog_core_api::error::Precondition::Revision {
                        expected: "absent".into(),
                        actual: "exists".into(),
                    },
                });
            }
            let handle = self.spawn(
                id.clone(),
                state,
                lineage,
                log_id,
                0,
                LogInit::Create,
                Init::Create {
                    session,
                    tx: Some(tx),
                    value: json!({}),
                },
            );
            shard.insert(id.clone(), Slot_::Loaded(handle));
        }
        self.deps.effort.prewarm(&id, &header);
        rx.await
            .map_err(|_| CoreError::ThreadClosing {
                thread_id: id.clone(),
            })?
            .map_err(|error| {
                lock(self.shard(&id)).remove(&id);
                error
            })?;
        self.loaded(&id).ok_or(CoreError::ThreadClosing { thread_id: id })
    }
}

/// The opened log folded into the state the actor starts from (cpu-interactive).
fn fold_opened(lane: &InLane<CpuInteractive>, deps: &SessionDeps, log: OpenedLog) -> Opened {
    let mut state = SessionState::new(deps.limits.view_items);
    state.header = log.header;
    state.sections.title = state
        .header
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned);
    state.history_rev = log.history_rev;
    state.lineage_start = log.lineage_start;
    state.has_older = log.has_older;
    state.prompt_session = log.prompts;
    let mut next_ordinal = log.next_ordinal;
    let mut apply = |state: &mut SessionState, ordinal: u64, record: Record| {
        let display = match &record {
            Record::Item(item) => Display::Items(deps.transcript.items(lane, item)),
            Record::Queue(queue) => match &queue.entry {
                Some(Slot::Inline(entry)) => {
                    Display::Queued(deps.transcript.queued(queue.qid.as_str(), entry))
                }
                _ => Display::None,
            },
            _ => Display::None,
        };
        next_ordinal = next_ordinal.max(ordinal + 1);
        state.apply(
            &Change::Record {
                record: Arc::new(record),
                display,
            },
            Some(ordinal),
        );
    };
    for (ordinal, run) in log.runs {
        apply(&mut state, ordinal, Record::Run(run));
    }
    for (ordinal, approval) in log.approvals {
        apply(&mut state, ordinal, Record::Approval(approval));
    }
    for (ordinal, queue) in log.queue {
        apply(&mut state, ordinal, Record::Queue(queue));
    }
    // Window rows were counted into `prompts` by the store; their fold must not re-add them.
    let prompts = std::mem::take(&mut state.prompt_session);
    let mut dividers = log.dividers.into_iter().peekable();
    let mut show_dividers = |state: &mut SessionState, before: usize| {
        while let Some(divider) = dividers.next_if(|divider| divider.before <= before) {
            let mut items = vec![super::transcript::divider_item(&divider.cid, divider.at)];
            items.extend(super::transcript::divider_model_switches(&divider.cid, &divider.model_switches));
            for item in items {
                state.push_shown(divider.ordinal, item);
            }
        }
    };
    for (index, (ordinal, item)) in log.window.into_iter().enumerate() {
        show_dividers(&mut state, index);
        apply(&mut state, ordinal, Record::Item(item));
    }
    show_dividers(&mut state, usize::MAX);
    state.prompt_session = prompts;
    state.has_older = log.has_older || state.has_older;
    for (ordinal, record) in log.tail {
        apply(&mut state, ordinal, record);
    }
    state.prompt_history =
        super::prompt_history::merge(&state.prompt_session, &state.prompt_persisted);
    Opened {
        state,
        log_id: log.log_id,
        next_ordinal,
        log: LogInit::Open(log.append),
    }
}

#[async_trait]
impl ThreadDirectory for SessionDirectory {
    fn get(&self, id: &ThreadId) -> Option<Arc<dyn ThreadHandle>> {
        self.inner
            .loaded(id)
            .map(|handle| handle as Arc<dyn ThreadHandle>)
    }

    async fn open(
        &self,
        id: &ThreadId,
        ctx: &CallContext,
    ) -> Result<Arc<dyn ThreadHandle>, CoreError> {
        self.inner
            .open(id, ctx)
            .await
            .map(|handle| handle as Arc<dyn ThreadHandle>)
    }

    async fn request(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "thread/start" => {
                let params: ThreadStartParams = serde_json::from_value(req.params.clone())
                    .map_err(|_| CoreError::InvalidParams {
                        path: "params".into(),
                        expected: "ThreadStartParams".into(),
                    })?;
                let now = self.inner.deps.clock.now_ms();
                let mut header = Header::new();
                header.insert("createdAt".into(), json!(now));
                header.insert("updatedAt".into(), json!(now));
                if let Some(path) = &params.project_path {
                    header.insert("cwd".into(), json!(path));
                }
                if let Some(options) = &params.session {
                    super::session_options::write_header(options, &mut header);
                }
                let handle = self
                    .inner
                    .create(CreateSpec {
                        id: None,
                        header,
                        base: None,
                        op: req.op.clone(),
                        method: req.method,
                        params: req.params.clone(),
                    })
                    .await?;
                let mut result = json!({ "thread": handle.cell.view.load_full().summary });
                if let Some(input) = params.initial_input {
                    let turn = handle
                        .request(CoreRequest {
                            method: Method("turn/start"),
                            params: json!({
                                "threadId": handle.id,
                                "opId": req.op.as_ref().map_or(String::new(), |op| format!("{op}:turn")),
                                "input": input,
                            }),
                            op: req.op.as_ref().map(|op| OpId::from(format!("{op}:turn"))),
                            ctx: req.ctx.clone(),
                        })
                        .await?;
                    if let Reply::Value(turn) = turn {
                        result["turn"] = turn;
                    }
                }
                let feed: Arc<dyn mixdog_core_api::FeedSource> = handle.feed.clone();
                Ok(Reply::Subscribe(Subscribe {
                    result,
                    feed,
                    window: Window::LastItems(200),
                    resume_from: None,
                }))
            }
            _ => Err(CoreError::InvalidParams {
                path: "method".into(),
                expected: "a session-directory method".into(),
            }),
        }
    }
}
