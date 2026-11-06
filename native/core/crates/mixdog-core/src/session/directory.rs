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

pub(crate) struct DirInner {
    deps: Arc<SessionDeps>,
    shards: Box<[Mutex<HashMap<ThreadId, Slot_>>]>,
    me: std::sync::Weak<DirInner>,
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
        Self {
            inner: Arc::new_cyclic(|me| DirInner {
                deps,
                shards: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
                me: me.clone(),
            }),
        }
    }

    /// The concrete handle of a loaded thread.
    pub fn handle(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
        self.inner.loaded(id)
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
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        let msg = |live| Inbox::TaskNotification {
            surface: surface.to_owned(),
            task_id: task_id.to_owned(),
            status: status.to_owned(),
            text: notification.clone(),
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

    fn loaded(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
        match lock(self.shard(id)).get(id) {
            Some(Slot_::Loaded(handle)) => Some(handle.clone()),
            _ => None,
        }
    }

    async fn open(&self, id: &ThreadId, ctx: &CallContext) -> Result<Arc<SessionHandle>, CoreError> {
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
                        let result = me.load(&thread).await;
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
    async fn load(&self, id: &ThreadId) -> Loaded {
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
        deps.effort.prewarm(id, &opened.state.header);
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
    for (ordinal, item) in log.window {
        apply(&mut state, ordinal, Record::Item(item));
    }
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
