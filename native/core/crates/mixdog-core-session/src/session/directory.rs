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

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadStartKind;
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
use mixdog_core_base::approvals::Lineage;

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
    mark: oneshot::Sender<serde_json::Map<String, Value>>,
    marked: oneshot::Receiver<Result<(), super::run::RunError>>,
}

impl DeleteHold {
    /// The thread's working folder (`cwd`), as it last stood.
    pub(crate) fn cwd(&self) -> Option<String> {
        self.handle.cell.header.load().get("cwd").and_then(Value::as_str).map(str::to_owned)
    }

    /// The thread's header as it stood when the close landed (the stored record `markSessionClosed`
    /// reads its `createdAt`, `agent` and `owner` from).
    pub(crate) fn header(&self) -> Arc<mixdog_store::schema::record::Header> {
        self.handle.cell.header.load_full()
    }

    /// Appends the delete mark and waits for its ack; the thread then leaves the directory,
    /// and a later open finds it gone. False when the mark was not applied.
    pub(crate) async fn mark(self, directory: &DirInner) -> bool {
        let mut set = serde_json::Map::new();
        set.insert(mixdog_store::summary::DELETED.into(), Value::Bool(true));
        self.append(directory, set).await
    }

    /// [`mark`](Self::mark) with another header change: an idle close's tombstone. The thread
    /// leaves the directory the same way (a closed thread unloads).
    pub(crate) async fn append(self, directory: &DirInner, set: serde_json::Map<String, Value>) -> bool {
        let _ = self.mark.send(set);
        let applied = matches!(self.marked.await, Ok(Ok(())));
        let id = &self.handle.id;
        let mut shard = lock(directory.shard(id));
        if matches!(shard.get(id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(h, &self.handle)) {
            shard.remove(id);
            #[cfg(any(test, feature = "test-support"))]
            directory.left.notify_waiters();
        }
        applied
    }
}

pub(crate) struct DirInner {
    pub(super) deps: Arc<SessionDeps>,
    shards: Box<[Mutex<HashMap<ThreadId, Slot_>>]>,
    me: std::sync::Weak<DirInner>,
    /// Opens begun, ever: a retention delete that read its tree's stored activity at one count
    /// and finds another knows a member may have been opened, used and unloaded in between.
    opens: std::sync::atomic::AtomicU64,
    /// Handles built, ever: each handle's `loaded_seq`.
    loads: std::sync::atomic::AtomicU64,
    /// Creates in flight (`getSessionCreatePromise()`): the idle probes of the background warm-ups read it.
    creating: std::sync::atomic::AtomicUsize,
    /// The threads' turn starts against the idle-only delete (`turn-gate.mjs`).
    gate: Arc<super::turn_gate::TurnGate>,
    /// `onGoalStatusChange`: each change goes to its loaded thread's Goal lane.
    goal_events: Mutex<Option<mixdog_core_goal::goal::Subscription>>,
    /// What each runtime's teardown does for the agents its session owns (`OwnerTeardown`).
    owner_teardown: std::sync::OnceLock<Arc<dyn OwnerTeardown>>,
    /// What each runtime's teardown does to its own session (`ExitClose`).
    exit_close: std::sync::OnceLock<Arc<dyn ExitClose>>,
    /// Cancels the staged-originals deadline timer when the directory goes.
    _prune: tokio_util::sync::DropGuard,
    /// Woken whenever a thread leaves the directory (a test waits on `handle(..)` turning `None`).
    #[cfg(any(test, feature = "test-support"))]
    pub(super) left: tokio::sync::Notify,
}

/// A thread to create (`thread/start`, `thread/fork`).
pub(crate) struct CreateSpec {
    pub id: Option<ThreadId>,
    pub header: Header,
    pub base: Option<Base>,
    pub op: Option<OpId>,
    pub method: Method,
    pub params: Value,
    /// What the thread's tool seed opened; the thread's actor owns it once the thread is published.
    pub seed: Option<super::seams::SeededThread>,
}

pub struct SessionDirectory {
    inner: Arc<DirInner>,
}

/// Counts a create while it runs.
struct CreateInFlight<'a>(&'a std::sync::atomic::AtomicUsize);

impl<'a> CreateInFlight<'a> {
    fn enter(count: &'a std::sync::atomic::AtomicUsize) -> Self {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(count)
    }
}

impl Drop for CreateInFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// `CLOSE_ALL_DEADLINE_MS` (`teardown.mjs`).
const CLOSE_ALL_DEADLINE: std::time::Duration = std::time::Duration::from_millis(5000);

/// `PROCESS_EXIT_REASON` (`teardown.mjs`): `/exit|quit|shutdown|sighup|sigint|sigterm/` on the
/// lower-cased reason. Only such a close closes the session's agents (`closeAll`); any other
/// close reaps only its own jobs.
pub fn is_process_exit_reason(reason: &str) -> bool {
    let reason = reason.to_lowercase();
    ["exit", "quit", "shutdown", "sighup", "sigint", "sigterm"].iter().any(|word| reason.contains(word))
}

/// What a runtime's teardown does for the agents its session owns: `agentTool.closeAll(reason,
/// { processExit: true })` through `__close_all` (`agent-tool-routing.mjs:26-47`,
/// `daemon-agent-control.mjs:75-82`), which closes the workers and then cancels the descendants.
#[async_trait]
pub trait OwnerTeardown: Send + Sync {
    async fn teardown(&self, owner: &ThreadId, reason: &str);
}

/// What a runtime's teardown does to the session it holds: `closeOwnSession` (`teardown/session-close.mjs:42-60`)
/// closes it with the teardown's reason, tombstoning an empty scratch session and detaching any other
/// (`closeSession(id, reason, { tombstone: isScratchSession(session) })`), which bumps the record's generation.
#[async_trait]
pub trait ExitClose: Send + Sync {
    async fn close_on_exit(&self, thread: &ThreadId, reason: &str);
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
        // Startup prune and the deadline timer for abandoned staged originals (`startStagedOriginalsPrune`).
        let prune = mixdog_rt::CancellationToken::new();
        deps.staged_originals.start_prune(deps.lanes.durability, deps.clock.clone(), prune.clone());
        let inner = Arc::new_cyclic(|me| DirInner {
            deps,
            shards: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
            me: me.clone(),
            opens: Default::default(),
            loads: Default::default(),
            creating: Default::default(),
            gate: Default::default(),
            goal_events: Mutex::new(None),
            owner_teardown: std::sync::OnceLock::new(),
            exit_close: std::sync::OnceLock::new(),
            _prune: prune.drop_guard(),
            #[cfg(any(test, feature = "test-support"))]
            left: Default::default(),
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

    /// Woken whenever a thread leaves the directory.
    #[cfg(any(test, feature = "test-support"))]
    pub fn left(&self) -> &tokio::sync::Notify {
        &self.inner.left
    }

    /// The production `ThreadOpGates` over this directory's threads. Build it once: its gates
    /// are what orders the ops of one thread, so every user of the thread scope shares this one.
    pub fn thread_ops(&self) -> Arc<super::thread_ops::ThreadOps> {
        super::thread_ops::ThreadOps::new(self.inner.clone())
    }

    /// `turnBotChainOf(session)`: the bot chain of the turn the loaded thread is in; empty for a
    /// thread not loaded.
    pub fn turn_bot_chain(&self, id: &ThreadId) -> Vec<String> {
        self.handle(id).map(|handle| handle.cell.turn_chain.bots()).unwrap_or_default()
    }

    /// The concrete handle of a loaded thread.
    pub fn handle(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
        self.inner.loaded(id)
    }

    /// The turn gate, for the tests that hold a start's admission or a delete's fence.
    #[cfg(test)]
    pub(crate) fn turn_gate(&self) -> &Arc<super::turn_gate::TurnGate> {
        self.inner.gate()
    }

    /// The loaded thread a run belongs to: a run exists only while its thread is loaded.
    fn running(&self, id: &ThreadId) -> Arc<SessionHandle> {
        self.inner.loaded(id).expect("a running thread is loaded")
    }

    /// `SessionSeams::live_header`: the thread's latest acked header, readable without waiting.
    pub fn live_header(&self, id: &ThreadId) -> Arc<dyn mixdog_core_ports::ports::gate::LiveHeader> {
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

    pub fn deps(&self) -> &Arc<SessionDeps> {
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
            let _ = handle.cell.abort(&run.turn, &mixdog_agent::cancel::Abort::abort_session_turn(id.as_str(), reason));
        }
        true
    }

    /// `abortSession({sessionId})` for the `session` tool's cancel: the user's interrupt of the
    /// turn running in the session. `true` when a turn was running and is now cancelled; a
    /// session that is not loaded or runs no turn is `false`.
    pub fn interrupt_running_turn(&self, id: &ThreadId) -> Result<bool, CoreError> {
        let Some(handle) = self.inner.loaded(id).filter(|handle| !handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst)) else {
            return Ok(false);
        };
        let Some(run) = handle.cell.run.load_full() else {
            return Ok(false);
        };
        handle.cell.interrupt(&run.turn, None)?;
        Ok(true)
    }

    /// A thread's model context (`session.messages`), read from the store; a thread need not be
    /// loaded.
    pub fn model_context(&self, id: &ThreadId) -> super::run::ModelContext {
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
        super::reads::history_items(&self.inner.deps, id).await
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

    /// `notifySessionUi(id, 'Desktop settings request', { kind: 'setup-ui', id: request })`, and
    /// whether the thread took it. Node's taker is the session runtime's own store, bound when
    /// the runtime is created whoever views it (`local-session-runtime.mjs:487`), so a thread
    /// loaded here takes it with or without subscribers; one not loaded has no runtime and does
    /// not. The thread shows the request until it is settled or `window` ends.
    pub async fn request_setup_ui(&self, id: &ThreadId, request: &str, window: std::time::Duration) -> bool {
        let Some(handle) = self.inner.loaded(id) else { return false };
        handle.inbox.send(Inbox::SetupUiRequest { id: request.to_owned(), window }).await.is_ok()
    }

    /// The desktop request `request` can no longer be claimed: the thread stops showing it.
    pub async fn settle_setup_ui(&self, id: &ThreadId, request: &str) {
        if let Some(handle) = self.inner.loaded(id) {
            let _ = handle.inbox.send(Inbox::SetupUiSettled { id: request.to_owned() }).await;
        }
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
        jobs: &dyn mixdog_core_run::run_host::progress::WaitedJobs,
    ) -> mixdog_agent::agent_tool::views::WorkerLive {
        self.handle(id).map(|handle| handle.cell.progress.borrow().live(now, jobs)).unwrap_or_default()
    }

    /// A session's header: the live one of a loaded thread, else the stored record read on the io
    /// lane. `None` when the session is unknown or deleted.
    pub async fn stored_header(&self, id: &ThreadId) -> Option<mixdog_store::schema::record::Header> {
        self.inner.stored_header(id).await
    }

    /// [`stored_header`](Self::stored_header) for a decision that must tell "no such session"
    /// (`Ok(None)`) from "the read never ran" (`Err`): a session whose record could not be read
    /// is not a deleted one.
    pub async fn try_stored_header(&self, id: &ThreadId) -> Result<Option<mixdog_store::schema::record::Header>, CoreError> {
        self.inner.try_stored_header(id).await
    }

    /// `deleteSession(id, { isSessionLive: treeChanged })` for a session not open in this
    /// process: `true` once it is gone. The thread's own admission rechecks, before it closes
    /// anything, that nobody opened or used the session since the pass read `activity`, that
    /// no other member of its tree (`peers`, each with the activity the pass read) is open or
    /// has moved, and that `cancel` (the sweep's shutdown) has not fired; any refuses with
    /// `false`.
    pub async fn delete_stored(
        &self,
        id: &str,
        activity: f64,
        peers: &[(String, f64)],
        cancel: &CancellationToken,
    ) -> Result<bool, CoreError> {
        let peers = peers.iter().map(|(peer, at)| (ThreadId::from(peer.as_str()), *at)).collect();
        let guard = super::control::DeleteGuard { activity, cancel: cancel.clone(), peers, opens: 0 };
        super::delete::delete_session(&self.inner, id, Some(guard)).await
    }

    /// `markSessionClosed(id, 'idle-sweep')` for a session not open in this process: `true` once
    /// its tombstone landed. Admitted exactly as [`delete_stored`](Self::delete_stored) is (see
    /// `close::close_idle`); any refusal is `false`.
    pub async fn close_stored(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, CoreError> {
        let guard = super::control::DeleteGuard { activity, cancel: cancel.clone(), peers: Vec::new(), opens: 0 };
        super::close::close_idle(&self.inner, id, guard).await
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

    /// Every loaded thread's handle, in the order the threads were loaded (Node's `_liveSessions`
    /// iteration order).
    pub fn loaded_handles(&self) -> Vec<Arc<SessionHandle>> {
        let mut handles: Vec<Arc<SessionHandle>> = self
            .inner
            .shards
            .iter()
            .flat_map(|shard| {
                lock(shard)
                    .values()
                    .filter_map(|slot| match slot {
                        Slot_::Loaded(handle) => Some(handle.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        handles.sort_by_key(|handle| handle.loaded_seq);
        handles
    }

    /// Whether a thread is being created now (`getSessionCreatePromise()`).
    pub fn creating(&self) -> bool {
        self.inner.creating.load(std::sync::atomic::Ordering::SeqCst) > 0
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
                seed: None,
            })
            .await
            .map(|_| ())
    }

    /// Creates a thread under a minted id with `header` as its first durable write (an internal
    /// `createSession`: nobody subscribes to it).
    pub async fn create_session(&self, header: Header, params: Value) -> Result<ThreadId, CoreError> {
        let spec = CreateSpec { id: None, header, base: None, op: None, method: Method("thread/start"), params, seed: None };
        self.inner.create(spec).await.map(|handle| handle.id.clone())
    }

    /// A session's title, agent, owner session and source type, from the index without loading
    /// it (today's `readStoredSessionMetadata`); `None` for a session the catalog does not list.
    pub async fn session_meta(&self, id: &ThreadId) -> Result<Option<super::seams::SessionMeta>, CoreError> {
        self.inner.deps.store.session_meta(id).await
    }

    /// Binds what a runtime's teardown does for the agents its session owns; once.
    pub fn set_owner_teardown(&self, hook: Arc<dyn OwnerTeardown>) -> Result<(), &'static str> {
        self.inner.owner_teardown.set(hook).map_err(|_| "the owner teardown is already bound")
    }

    /// Binds what a runtime's teardown does to its own session; once.
    pub fn set_exit_close(&self, hook: Arc<dyn ExitClose>) -> Result<(), &'static str> {
        self.inner.exit_close.set(hook).map_err(|_| "the exit close is already bound")
    }

    /// [`Self::shutdown_for`] with the reason of a daemon stop.
    pub async fn shutdown(&self) {
        self.shutdown_for("daemon shutdown").await;
    }

    /// Core shutdown (today's `teardown.mjs:192`): first, as each runtime's `close(reason)` does
    /// when the reason is a process exit (`teardown.mjs:226-237`), every loaded session's agents
    /// are closed (`OwnerTeardown`, bounded at `CLOSE_ALL_DEADLINE_MS`, 5000 ms, per session);
    /// then every loaded thread is closed as its runtime's own session ([`ExitClose`]); then every loaded thread stops (a live run is cancelled) and its memory ingest is awaited,
    /// all of them together bounded at 2500 ms.
    pub async fn shutdown_for(&self, reason: &str) {
        if is_process_exit_reason(reason)
            && let Some(hook) = self.inner.owner_teardown.get()
        {
            for owner in self.loaded_ids() {
                if tokio::time::timeout(CLOSE_ALL_DEADLINE, hook.teardown(&owner, reason)).await.is_err() {
                    tracing::warn!(owner = owner.as_str(), "agent teardown overran its deadline");
                }
            }
        }
        // Teardown's `closeOwnSession` (`teardown.mjs:258`), after the agents' close and for any reason: each runtime's
        // own session is closed with the stop's reason before the runtime stops.
        if let Some(hook) = self.inner.exit_close.get() {
            for owner in self.loaded_ids() {
                if tokio::time::timeout(CLOSE_ALL_DEADLINE, hook.close_on_exit(&owner, reason)).await.is_err() {
                    tracing::warn!(owner = owner.as_str(), "the session close at exit overran its deadline");
                }
            }
        }
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
        // Each runtime's teardown ends with `dispose()` of its side checkouts: no snapshot
        // cleanup runs on, and what is left is the prune's and the startup reconcile's.
        self.inner.deps.snapshots.dispose();
    }

    /// Opens (single-flight) and returns the concrete handle.
    pub async fn open_handle(
        &self,
        id: &ThreadId,
        ctx: &CallContext,
    ) -> Result<Arc<SessionHandle>, CoreError> {
        self.inner.open(id, ctx).await
    }

    /// `materializeSession` (session-turns.mjs): the thread is opened under daemon ownership for a
    /// caller that starts work on it (a Goal recovery, a quota resume), as an admitted turn start;
    /// `threadClosing` while an idle delete holds the thread.
    pub async fn open_admitted(&self, id: &ThreadId, ctx: &CallContext) -> Result<Arc<SessionHandle>, CoreError> {
        let _admitted = self.inner.gate().enter(id).ok_or_else(|| CoreError::ThreadClosing { thread_id: id.clone() })?;
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
        self.queue_notice(owner, surface, task_id, status, text, None).await;
    }

    /// `submitSession(.. mode: 'task-notification', origin: 'channel')` of the channel session
    /// router (`channel-session-router.mjs:19-29`): the text joins the thread's queue by the
    /// same path as a completion. A submit starts its turn on a thread it had to open too.
    /// False when the thread could not be opened or is gone.
    pub async fn queue_channel_notification(&self, owner: &ThreadId, text: String) -> bool {
        self.queue_notice(owner, "", "", "", text, Some(super::completions::ORIGIN_CHANNEL)).await
    }

    async fn queue_notice(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, text: String, origin: Option<&'static str>) -> bool {
        let msg = |live| Inbox::TaskNotification {
            surface: surface.to_owned(),
            task_id: task_id.to_owned(),
            status: status.to_owned(),
            text: text.clone(),
            origin,
            live,
        };
        if let Some(handle) = self.inner.loaded(owner) {
            return handle.inbox.send(msg(true)).await.is_ok();
        }
        let ctx = CallContext::internal("task-notification");
        match self.inner.open(owner, &ctx).await {
            Ok(handle) => handle.inbox.send(msg(origin.is_some())).await.is_ok(),
            Err(_) => false,
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
        // The check and the close are one transition of the admission word: an attach that
        // comes after it fails, one before it makes the close fail.
        if !ours || !cell.close_unattached() {
            return false;
        }
        shard.remove(id);
        #[cfg(any(test, feature = "test-support"))]
        self.left.notify_waiters();
        true
    }

    pub(crate) fn deps(&self) -> &Arc<SessionDeps> {
        &self.deps
    }

    pub(crate) fn gate(&self) -> &Arc<super::turn_gate::TurnGate> {
        &self.gate
    }

    /// A session's header: the live one of a loaded thread, else the stored record read on the io
    /// lane. `None` when the session is unknown or deleted.
    pub(super) async fn stored_header(&self, id: &ThreadId) -> Option<mixdog_store::schema::record::Header> {
        // For read-only views, where an unrun read can only read as unknown.
        self.try_stored_header(id).await.ok().flatten()
    }

    /// As [`stored_header`](Self::stored_header), but `Err` when the read job never ran.
    async fn try_stored_header(&self, id: &ThreadId) -> Result<Option<mixdog_store::schema::record::Header>, CoreError> {
        if let Some(handle) = self.loaded(id) {
            return Ok(Some(handle.cell.header.load_full().as_ref().clone()));
        }
        let (store, thread) = (self.deps.store.clone(), id.clone());
        let read = mixdog_core_base::support::on_lane(self.deps.lanes.io, &CancellationToken::new(), move |lane| store.read_header(lane, &thread)).await?;
        Ok(read.ok())
    }

    /// `treeChanged` for a delete, in the thread's own admission: a peer is open (or opening),
    /// or an open began since `opens`, the count the peers' stored activity was read at.
    pub(crate) fn peers_changed(&self, peers: &[(ThreadId, f64)], opens: u64) -> bool {
        self.opens.load(std::sync::atomic::Ordering::SeqCst) != opens
            || peers.iter().any(|(peer, _)| lock(self.shard(peer)).contains_key(peer))
    }

    /// Whether a peer is open or its stored activity is not what the sweep read (an unreadable
    /// record counts as moved), read at the open count `guard.opens` records.
    async fn peers_moved(&self, guard: &mut super::control::DeleteGuard) -> bool {
        guard.opens = self.opens.load(std::sync::atomic::Ordering::SeqCst);
        for (peer, read) in &guard.peers {
            if lock(self.shard(peer)).contains_key(peer) {
                return true;
            }
            let stored = match self.try_stored_header(peer).await {
                Ok(stored) => stored.map(|header| super::sub_agent_retention::activity_at(&header)),
                Err(_) => return true,
            };
            if stored != Some(*read) {
                return true;
            }
        }
        false
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
        abort: &mixdog_agent::cancel::Abort,
        idle: bool,
        mut guard: Option<super::control::DeleteGuard>,
    ) -> Result<Result<DeleteHold, &'static str>, CoreError> {
        let Some(handle) = self.delete_target(id).await? else {
            return Ok(Err("missing"));
        };
        // The tree's stored activity is read after the target is open (its own open is not a
        // peer's), and the thread's admission re-asks, synchronously, that nothing opened since.
        if let Some(guard) = guard.as_mut()
            && self.peers_moved(guard).await
        {
            return Ok(Err("changed"));
        }
        let (closed, closed_rx) = oneshot::channel();
        let (mark, mark_rx) = oneshot::channel();
        let (marked_tx, marked) = oneshot::channel();
        let delete = Ctl::Delete { abort: abort.clone(), idle, guard, closed, mark: mark_rx, marked: marked_tx };
        let closing = || CoreError::ThreadClosing { thread_id: id.clone() };
        handle.cell.ctl_tx.send(delete).await.map_err(|_| closing())?;
        match closed_rx.await.map_err(|_| closing())? {
            Ok(()) => Ok(Ok(DeleteHold { handle, mark, marked })),
            Err(refusal) => Ok(Err(refusal)),
        }
    }

    /// The thread a delete acts on: loaded, else opened for it (no effort prewarm); `None`
    /// when there is no such thread.
    pub(crate) async fn delete_target(&self, id: &ThreadId) -> Result<Option<Arc<SessionHandle>>, CoreError> {
        if let Some(handle) = self.loaded(id) {
            return Ok(Some(handle));
        }
        match self.open_with(id, &CallContext::internal("thread-delete"), false).await {
            Ok(handle) => Ok(Some(handle)),
            Err(CoreError::ThreadNotFound { .. }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The thread an op record is written through: loaded, else opened for it (no prewarm);
    /// `threadNotFound` when there is none.
    pub(crate) async fn op_target(&self, id: &ThreadId) -> Result<Arc<SessionHandle>, CoreError> {
        if let Some(handle) = self.loaded(id) {
            return Ok(handle);
        }
        self.open_with(id, &CallContext::internal("thread-op"), false).await
    }

    pub(super) fn loaded(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
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
                    self.opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    shard.insert(id.clone(), Slot_::Loading(rx.clone()));
                    let me = self.me.upgrade().expect("the directory is alive while used");
                    let thread = id.clone();
                    mixdog_rt::spawn("session-open", TaskClass::Work, async move {
                        let result = me.load(&thread, prewarm).await;
                        // `resumeSession`'s `_refreshResumedTools`: a thread opened for use (not
                        // for a delete or an op record) takes its tool surface as it resolves now,
                        // before any caller gets it.
                        if prewarm && let Ok(handle) = &result {
                            me.refresh_resumed_tools(handle).await;
                        }
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

    /// Writes the opened thread's refreshed tool surface ([`super::ResumedTools`]) as one header
    /// patch; a write that fails is logged and the stored surface stays, as an unresolvable one does.
    async fn refresh_resumed_tools(&self, handle: &Arc<SessionHandle>) {
        let header = handle.cell.header.load_full();
        let Some(change) = self.deps.resumed_tools.refreshed(&handle.id, &header).await else { return };
        if change.set.is_empty() && change.unset.is_empty() {
            return;
        }
        let request = CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": handle.id.as_str(), "set": change.set, "unset": change.unset }),
            op: None,
            ctx: CallContext::internal("resume-tools"),
        };
        if let Err(error) = mixdog_core_api::ThreadHandle::request(handle.as_ref(), request).await {
            tracing::warn!(?error, thread = handle.id.as_str(), "the resumed thread's tool surface was not written");
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
        let (store, thread) = (deps.store.clone(), id.clone());
        let fenced = deps
            .lanes
            .io
            .submit(&token, move |lane| store.fenced_ops(lane, &thread))?
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
            Init::Open { fenced },
        ))
    }

    /// P §8.3: a sub-agent's requests show on its parent's surface. A room member's requests show
    /// on its room's log (Node's room log carries the speaking member's `toolApproval`,
    /// `agent-room-turn.ts:278`, `agent-room-views.ts:89`), so a client on the log receives them
    /// and its response decides them in the member's thread (P §8.4).
    fn lineage_of(&self, id: &ThreadId, header: &Header) -> Lineage {
        if let Some(member) = mixdog_core_base::rooms::ids::room_member_of_session(id.as_str())
            && let Some(log) = mixdog_core_base::rooms::ids::room_session_id(&member.room_id)
        {
            return Lineage { surface: ThreadId::from(log), chain: Vec::new() };
        }
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
            turn_chain: Default::default(),
            queued: Default::default(),
            queue: arc_swap::ArcSwap::from_pointee(state.queue.clone()),
            approvals: Default::default(),
            shown_approval: Default::default(),
            takeover: Default::default(),
            view: arc_swap::ArcSwap::new(view),
            header: arc_swap::ArcSwap::from_pointee(state.header.clone()),
            surface: surface.subscribe(),
            progress: watch::Sender::new(Default::default()),
            turn_messages: watch::Sender::new(Default::default()),
            turn_listeners: Default::default(),
            agent_start: Default::default(),
            routine_starts: Default::default(),
            grants: Default::default(),
            ctl_tx,
            steer_cap: limits.steer_queue,
            subscribers: Default::default(),
            closed: Default::default(),
            turn_held: Default::default(),
            turn_pending: Default::default(),
            ui_busy: Default::default(),
            compacting: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            stepped: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            busy: Default::default(),
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
            submits: Default::default(),
            loaded_seq: self.loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
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
        // The create settling, whichever way, is a busy-state change (`rt.wakeDeferredWarmups`):
        // a warm parked on it re-checks.
        let _settled = super::prewarm_signals::WakeOnDrop(self.deps.code_graph_prewarm.clone());
        let _creating = CreateInFlight::enter(&self.creating);
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
                    seed: spec.seed,
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
    state.sections.title = super::state::title_of(&state.header);
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
                // The project the request names: its own path, else the new task's draft (`submitNewTask(prompt, options, draft)`).
                // The desktop's control session is its own kind, not inferred (Node: `ensureControlSession`): the task
                // workspace, no project, no classification.
                let control = params.kind == ThreadStartKind::Control;
                let project = if control {
                    None
                } else {
                    params
                        .project_path
                        .clone()
                        .or_else(|| params.draft.as_ref().and_then(|draft| draft.project_path.clone()))
                        .filter(|path| !path.trim().is_empty())
                };
                if let Some(path) = &project {
                    header.insert("cwd".into(), json!(path));
                } else if matches!(params.kind, ThreadStartKind::Task | ThreadStartKind::Control) {
                    // A task runs in the task workspace, resolved by the core as Node's host resolves it (`TaskWorkspace`);
                    // the tools below are composed for that folder.
                    let folder = self.inner.deps.task_workspace.path().await.map_err(|message| mixdog_core_base::support::failed("session", message))?;
                    header.insert("cwd".into(), json!(folder));
                }
                // A session the desktop creates for a new task or a project is classified by the project it names, as the host
                // writes it (`resolveSessionWorkspace`, session-host.ts:535-553, passed to `session.create`, stored by
                // `lifecycle.mjs:61`): `{classification:'project', projectPath}` or `{classification:'task', projectPath:null}`.
                // The control session is created with `desktopSession: null` (`ensureControlSession`): none is written.
                if !control && (project.is_some() || params.draft.is_some()) {
                    let classified = match &project {
                        Some(path) => json!({ "classification": "project", "projectPath": path }),
                        None => json!({ "classification": "task", "projectPath": null }),
                    };
                    header.insert("desktopSession".into(), classified);
                }
                // Node's `sessionOptions` always applies: with no options a Lead is `full`, denied the goal tools.
                super::session_options::write_header(&params.session.clone().unwrap_or_default(), &mut header);
                // `createSession`'s tool surface and `seedToolSurface`, for the id it will have.
                let id = ThreadId::from(new_id());
                // The route the thread begins on is settled first: the tools and the prompt below are
                // composed for it, as Node composes the session from `rt.route`.
                let pick = params.draft.as_ref().and_then(|draft| draft.route.as_ref()).map(super::new_route::draft_pick);
                // The control session is created before any model is chosen (`ensureControlSession`): its route is not refused for lacking one.
                let route = if control {
                    self.inner.deps.new_route.adopt_control(&id).await
                } else {
                    self.inner.deps.new_route.adopt(&id, pick.as_ref()).await
                }
                .map_err(|message| mixdog_core_base::support::failed("route", message))?;
                // The route keys only a created record carries (`presetName`, the wire id, the preset's chain …);
                // the route's own fields are seated once the thread exists.
                let created = super::new_route::create_keys(&route).map_err(|message| mixdog_core_base::support::failed("route", message))?;
                for (key, value) in created {
                    header.insert(key, value);
                }
                // Until the thread is published, any way out abandons the seed; the actor owns it after.
                let seeded = super::seams::SeededThread::new(self.inner.deps.new_tools.clone(), id.clone());
                let seeding = if params.kind == ThreadStartKind::Control {
                    self.inner.deps.new_tools.seed_control(&id, &header)
                } else {
                    self.inner.deps.new_tools.seed(&id, &header)
                };
                let header = seeding.await.map_err(|message| {
                    mixdog_core_base::support::failed("session", format!("session: tools: {message}"))
                })?;
                let handle = self
                    .inner
                    .create(CreateSpec {
                        id: Some(id),
                        header,
                        base: None,
                        op: req.op.clone(),
                        method: req.method,
                        params: req.params.clone(),
                        seed: Some(seeded),
                    })
                    .await?;
                self.inner.deps.new_route.seat(&handle.id).await.map_err(|message| mixdog_core_base::support::failed("route", message))?;
                // `contextTokens` is on a created record only when set; the seat writes the route's, null when none.
                if handle.cell.header.load().get("contextTokens") == Some(&Value::Null) {
                    handle
                        .request(CoreRequest {
                            method: Method("thread/header/patch"),
                            params: json!({ "threadId": handle.id, "set": {}, "unset": ["contextTokens"] }),
                            op: None,
                            ctx: CallContext::internal("route"),
                        })
                        .await?;
                }
                // The draft's worktree, entered before the first prompt (Node: after the draft's route, workflow and mode).
                // `cwd` becomes the managed worktree; the classification keeps the project.
                if let Some(worktree) = params.draft.as_ref().and_then(|draft| draft.worktree.as_ref()) {
                    let input = params.initial_input.as_ref().and_then(|input| serde_json::to_value(input).ok());
                    self.inner.deps.new_place.enter_worktree(&handle.id, worktree, input.as_ref(), &req.ctx.cancel).await?;
                }
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
            "thread/delete" => super::delete::serve(&self.inner, &req.params).await,
            method if super::reads::serves(method) => self.inner.serve_read(&req).await,
            "thread/inheritancePreflight" => self.inheritance_preflight(&req.params).await.map(Reply::Value),
            _ => Err(CoreError::InvalidParams {
                path: "method".into(),
                expected: "a session-directory method".into(),
            }),
        }
    }
}

#[cfg(test)]
mod create_count_tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::CreateInFlight;

    #[test]
    fn a_create_counts_while_its_guard_lives_and_two_count_twice() {
        let count = AtomicUsize::new(0);
        let first = CreateInFlight::enter(&count);
        let second = CreateInFlight::enter(&count);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        drop(first);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(second);
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
}