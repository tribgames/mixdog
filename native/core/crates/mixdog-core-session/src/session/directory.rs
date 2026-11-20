//! The thread directory (`ThreadDirectory`): a sharded map of loaded threads. Lookups take
//! one shard's `std` lock for O(1) work. A cold open is single-flight (RL §7.3): the first
//! opener inserts `Loading` and spawns the load — open job J1, then J2 on io-interactive, then
//! one decode on cpu-interactive (SPEC R28) — and every concurrent opener waits on the same
//! result. The load runs as its own task, so a waiter that is cancelled stops waiting only.

// Transparent names for existing callback/record shapes; no ownership or ordering change.
type ThreadWriteVersions = (ThreadId, [(Arc<mixdog_rt::WriteMarks>, u64); 2]);

use std::collections::HashMap;
use std::hash::Hash;
use std::hash::Hasher;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadStartKind;
use mixdog_app_protocol::v2::thread::ThreadStartParams;
use mixdog_app_protocol::v2::thread::TurnInput;
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
use super::control::Liveness;
use super::durability::DurabilityTask;
use super::durability::LogInit;
use super::handle::SessionHandle;
use super::new_epoch;
use super::seams::OpenedLog;
use super::state::Change;
use super::state::Display;
use super::state::SessionState;
use super::view::SessionView;
use mixdog_core_base::approvals::Lineage;

const SHARDS: usize = 64;

type Loaded = Result<Arc<SessionHandle>, CoreError>;

/// [`SessionDirectory::durability_settled`]: each thread loaded at the call with its stores' [`mixdog_rt::WriteMarks`] and
/// the accepted count of each taken then — the thread's records, then its prompt-history appends.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone)]
pub struct DurabilitySettling {
    threads: Vec<ThreadWriteVersions>,
}

#[cfg(any(test, feature = "test-support"))]
impl DurabilitySettling {
    /// How many threads were loaded at the call, once every store of each committed what it accepted before; an error naming
    /// the thread and the store when one of those writes failed (a thread that ended first fails what it had not written).
    pub fn wait(&self) -> impl std::future::Future<Output = Result<usize, String>> + Send + 'static {
        let threads = self.threads.clone();
        async move {
            let waits = threads.iter().flat_map(|(id, marks)| {
                marks.iter().map(move |(marks, mark)| async move { marks.reached(*mark).await.map_err(|error| format!("thread {}: {error}", id.as_str())) })
            });
            futures::future::try_join_all(waits).await?;
            Ok(threads.len())
        }
    }

    /// The thread and store of each write from before the call still neither committed nor failed.
    pub fn pending(&self) -> Vec<String> {
        self.threads
            .iter()
            .flat_map(|(id, marks)| {
                marks.iter().filter(|(marks, mark)| marks.check(*mark).is_none()).map(move |(marks, _)| format!("thread {}: {}", id.as_str(), marks.store()))
            })
            .collect()
    }
}

/// Threads that are listed before they are there: the sessions of the earlier version, which convert behind the serving
/// core. One that is opened is asked for ahead of the rest, and its open waits for it.
pub trait ArrivingThreads: Send + Sync {
    /// The wait for `thread` to be there, when it is still to arrive; `None` for every other thread.
    fn arriving(&self, thread: &ThreadId) -> Option<futures::future::BoxFuture<'static, ()>>;
}

/// Counts work while it runs: a create, an in-core start waiting out the core's hold ([`super::SessionHandle`]'s `deferring`).
pub(super) struct InFlight<'a>(&'a std::sync::atomic::AtomicUsize);

impl<'a> InFlight<'a> {
    pub(super) fn enter(count: &'a std::sync::atomic::AtomicUsize) -> Self {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(count)
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
/// An open that takes this long is logged with the time of each of its steps.
const SLOW_OPEN_MS: i64 = 500;

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
    control: bool,
    log_id: String,
    next_ordinal: u64,
    log: LogInit,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The members of `header` named in `fields`, in the header's own order (all of it for `None`).
fn keep_fields(header: &mixdog_store::schema::record::Header, fields: Option<&[&str]>) -> mixdog_store::schema::record::Header {
    match fields {
        None => header.clone(),
        Some(fields) => header.iter().filter(|(key, _)| fields.contains(&key.as_str())).map(|(key, value)| (key.clone(), value.clone())).collect(),
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
        if log.archived.contains(&ordinal) {
            // The rows the record just showed: `archived` in their `ext` is what a client shows as 1.4.5's archived row.
            for row in state.window.iter_mut().rev().take_while(|row| row.ordinal == Some(ordinal)) {
                super::view::meta_mut(Arc::make_mut(&mut row.item)).ext.insert("archived".into(), serde_json::Value::Bool(true));
            }
        }
    }
    show_dividers(&mut state, usize::MAX);
    state.prompt_session = prompts;
    state.has_older = log.has_older || state.has_older;
    for (ordinal, record) in log.tail {
        apply(&mut state, ordinal, record);
    }
    for (rid, draft) in log.drafts {
        if let Some(run) = state.runs.get_mut(&rid) {
            run.restore(draft);
        }
    }
    state.prompt_history =
        super::prompt_history::merge(&state.prompt_session, &state.prompt_persisted);
    Opened {
        state,
        control: log.control,
        log_id: log.log_id,
        next_ordinal,
        log: LogInit::Open(log.append),
    }
}

#[cfg(test)]
mod shutdown_ingest_tests {
    use std::time::Duration;

    use super::wait_without_cancelling;

    #[tokio::test(start_paused = true)]
    async fn an_ingest_past_the_deadline_is_no_longer_waited_for_but_still_finishes() {
        mixdog_rt::testing::tokens();
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let (finish, finished) = tokio::sync::oneshot::channel::<()>();
        let began = tokio::time::Instant::now();
        wait_without_cancelling(Duration::from_millis(2500), async move {
            let _ = held.await;
            let _ = finish.send(());
        })
        .await;
        assert_eq!(began.elapsed(), Duration::from_millis(2500), "the wait ends at the deadline");
        release.send(()).expect("the ingest is still waiting for its release");
        assert!(finished.await.is_ok(), "the ingest was cancelled with the wait instead of going on");
    }
}


#[cfg(test)]
mod create_count_tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use super::InFlight;

    #[test]
    fn a_create_counts_while_its_guard_lives_and_two_count_twice() {
        let count = AtomicUsize::new(0);
        let first = InFlight::enter(&count);
        let second = InFlight::enter(&count);
        assert_eq!(count.load(Ordering::SeqCst), 2);
        drop(first);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        drop(second);
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
}


/// `INGEST_DEADLINE_MS` (`memory-ingest.mjs:4`): how long shutdown waits for the ingests.
const SHUTDOWN_INGEST_DEADLINE: std::time::Duration = std::time::Duration::from_millis(2500);
/// `SHUTDOWN_BUDGET_MS` (`daemon.mjs:254`, the forced exit at `:288-291`): how long shutdown waits for the new-task attempts it cut.
const NEW_TASK_SHUTDOWN_BOUND: std::time::Duration = std::time::Duration::from_millis(15_000);
/// Every slot is removed only by the owner of its identity (the handle's cell, the open's `Arc`, the start's mark), so a
/// slot another create or open put under the same id since is never taken.
enum Slot_ {
    Loaded(Arc<SessionHandle>),
    /// An open in flight; only that open publishes or drops it.
    Loading(Arc<watch::Receiver<Option<Loaded>>>),
    /// A control `thread/start` before its create ([`Starting`]); its liveness is the identity, and the created thread's.
    Starting(Arc<Liveness>),
}
/// A control `thread/start`'s hold on its minted id, taken before the thread's route is first resolved (the route cell is
/// created from the config of that moment, as Node's runtime takes its route at construction and is subscribed from then
/// on) and replaced by the thread when its create publishes it. While held, the thread is among the control threads the
/// config's adoption syncs, so no config adopted between the route's resolution and the create is missed. Dropped (the
/// start failed or its request was cancelled), it removes its own slot only, and the start ends. A start its create took over
/// does not end: its liveness is the created thread's.
pub(crate) struct Starting {
    directory: std::sync::Weak<DirInner>,
    id: ThreadId,
    mark: Arc<Liveness>,
}
impl Drop for Starting {
    fn drop(&mut self) {
        let Some(directory) = self.directory.upgrade() else { return };
        let mut shard = lock(directory.shard(&self.id));
        if matches!(shard.get(&self.id), Some(Slot_::Starting(mark)) if Arc::ptr_eq(mark, &self.mark)) {
            *self.mark.ending() = true;
            shard.remove(&self.id);
        }
    }
}
/// The actor's hold on the slot its thread is published in. The actor owns it (`SessionActor::hold`), so the slot is released
/// however the actor ends: it returns, it unwinds, or its task is dropped before it ran. Only the slot of the actor's own
/// cell is removed, never one another create or open put under the id since.
pub(crate) struct SlotLease {
    directory: std::sync::Weak<DirInner>,
    id: ThreadId,
    cell: Arc<ControlCell>,
}
impl Drop for SlotLease {
    fn drop(&mut self) {
        if let Some(directory) = self.directory.upgrade() {
            directory.release(&self.id, &self.cell);
        }
    }
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
    /// and a later open finds it gone. False when the mark was not applied: the close failed, and the thread stays
    /// open with what it holds (`SessionActor::close_undone`).
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
        if applied && matches!(shard.get(id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(h, &self.handle)) {
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
    /// Creates begun, ever: an archive preparation that read its tree at one count and finds another at its commit knows a
    /// sub-agent session may have joined the tree.
    created: std::sync::atomic::AtomicU64,
    /// The agent-only sessions this process created, under each session they name as owner or parent: a tree read joins them to
    /// the catalog's rows, which may not hold them yet.
    created_links: Mutex<HashMap<String, Vec<String>>>,
    /// The threads' turn starts against the idle-only delete (`turn-gate.mjs`).
    gate: Arc<super::turn_gate::TurnGate>,
    /// `onGoalStatusChange`: each change goes to its loaded thread's Goal lane.
    goal_events: Mutex<Option<mixdog_core_goal::goal::Subscription>>,
    /// `subscribeQuotaResume`: each change of the quota-resume queue goes to the loaded thread it names.
    quota_events: Mutex<Option<mixdog_core_base::quota_resume::Subscription>>,
    /// What each runtime's teardown does for the agents its session owns (`OwnerTeardown`).
    owner_teardown: std::sync::OnceLock<Arc<dyn OwnerTeardown>>,
    /// What each runtime's teardown does to its own session (`ExitClose`).
    exit_close: std::sync::OnceLock<Arc<dyn ExitClose>>,
    /// The threads that are listed before they are there (`ArrivingThreads`).
    arriving: std::sync::OnceLock<Arc<dyn ArrivingThreads>>,
    /// Where a thread's moved live facts republish its roster row (every cell holds it).
    live_rows: super::control::LiveRowsCell,
    /// The identities a user Stop froze from outside a thread's actor (every cell holds it).
    stop_latches: Arc<super::control::StopLatches>,
    /// The shutdown began: the session service is closed.
    closed: std::sync::atomic::AtomicBool,
    /// The close work of each unloaded runtime still running, by thread: the next open of the thread waits for it.
    teardowns: Mutex<HashMap<ThreadId, watch::Receiver<()>>>,
    /// The control thread paired phones share (`SessionDirectory::remote_control`); `None` until one starts it.
    remote_control: tokio::sync::Semaphore,
    /// The thread `remote_control` holds, written only under that gate.
    remote_thread: Mutex<Option<ThreadId>>,
    /// Woken whenever a thread leaves the directory (a test waits on `handle(..)` turning `None`).
    #[cfg(any(test, feature = "test-support"))]
    pub(super) left: tokio::sync::Notify,
    /// A test's gate between the adoption's listing of the control threads and its writes: it tells `.0` it arrived, then
    /// waits for `.1`.
    #[cfg(any(test, feature = "test-support"))]
    pub(super) adoption_gate: Mutex<Option<(Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>,
}
/// The outcome of [`DirInner::admit_attach`].
pub(super) enum AttachAdmission {
    Admitted,
    Unloaded,
    Closed,
}
/// A thread to create (`thread/start`, `thread/fork`).
pub(crate) struct CreateSpec {
    pub id: Option<ThreadId>,
    pub header: Header,
    pub base: Option<Base>,
    pub op: Option<OpId>,
    pub op_audience: Option<mixdog_store::schema::bounded::Digest>,
    pub method: Method,
    pub params: Value,
    /// What the thread's tool seed opened; the thread's actor owns it once the thread is published.
    pub seed: Option<super::seams::SeededThread>,
    /// The saved configuration's change counter as it stood when the creation began: a settings change the creation itself makes (the draft's
    /// route saved) reaches the new thread's `setupChanged`, as the change a Node session sees after `client.create`. `None`: it follows the
    /// counter from its install.
    pub settings: Option<super::actor::SettingsFollow>,
    /// The control start's hold on `id`: the create takes the id over from it, and is refused when the hold lost its slot.
    pub starting: Option<Starting>,
}
pub struct SessionDirectory {
    inner: Arc<DirInner>,
}
impl DirInner {
    /// The directory over this shared state, while it lives (the thread requests of a step that runs here).
    pub(super) fn outer(&self) -> Option<SessionDirectory> {
        self.me.upgrade().map(SessionDirectory::over)
    }

    /// A new thread's id, minted at the directory's clock (`mintSessionId`).
    pub(super) fn mint_session_id(&self) -> ThreadId {
        ThreadId::from(super::new_session_id(self.deps.clock.now_ms()))
    }
}
impl SessionDirectory {
    /// The directory a thread's handle reaches back to (it holds the shared state, [`SessionHandle::directory`]).
    pub(super) fn over(inner: Arc<DirInner>) -> Self {
        Self { inner }
    }
}
/// `CLOSE_ALL_DEADLINE_MS` (`teardown.mjs`).
const CLOSE_ALL_DEADLINE: std::time::Duration = std::time::Duration::from_millis(5000);

/// The wait before a carried mark's thread, refused while it owes a rewrite from the start, is opened again.
const CARRIED_RETRY: std::time::Duration = std::time::Duration::from_millis(500);

/// What `open` answers once it is no longer refused for a rewrite owed since the start (the thread's own, or a base's):
/// asked again after [`CARRIED_RETRY`] until then. A rewrite that failed answers so (`sensitiveRewriteFailed`) and is not
/// asked again; its mark stays journaled for the next start. Nothing waits on this but the caller's own task. Once
/// `closed` holds (the shutdown began, and a stopped rewriter releases nothing more) the refusal is the answer.
pub(super) async fn once_released<T, F, Fut>(closed: impl Fn() -> bool, mut open: F) -> Result<T, CoreError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, CoreError>>,
{
    loop {
        match open().await {
            Err(CoreError::CoreMigrating { kind, .. }) if &*kind == "sensitiveRewrite" && !closed() => {
                mixdog_rt::time::sleep(CARRIED_RETRY).await;
            }
            answer => return answer,
        }
    }
}
/// A detached job's completion reaches its owner thread as a `task-notification` row; a thread
/// not loaded is opened for it.
#[async_trait::async_trait]
impl mixdog_tools::exec::TaskNotifier for SessionDirectory {
    /// `notifySessionCompletion`: the live session shows the completion's card as it arrives
    /// (its listeners), then it is queued for the model.
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        self.finished_at_hop(owner, surface, task_id, status, notification, 0).await;
    }

    /// The same, for a job the turn at bot-chain `hop` started: the card's meta and the queued entry carry the hop, and the
    /// completion returns at it (`toolCompletionMeta`, `ctx.hop`).
    async fn finished_at_hop(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String, hop: u32) {
        let mut meta = json!({ "execution_surface": surface, "execution_id": task_id, "status": status });
        if hop > 0 {
            meta["hop"] = json!(hop);
        }
        self.show_completion(owner, notification.clone(), meta).await;
        self.queue_notice(owner, surface, task_id, status, notification, None, None, hop).await;
    }
}
impl SessionDirectory {
    /// `enqueueCompletion`: the completion joins the owner's queue; a thread not loaded is
    /// opened for it (and, not live, is never woken by it).
    pub(crate) async fn queue_completion(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, text: String) {
        self.queue_notice(owner, surface, task_id, status, text, None, None, 0).await;
    }

    /// [`Self::queue_completion`], answered once the queued entry is durable (`enqueuePendingMessage` then
    /// `settlePendingMessageWrites`): an error when the owner could not take it or its record was not stored. The same
    /// execution queued again is one entry, so a retry under the same id is told once.
    pub(crate) async fn queue_completion_durably(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, text: String) -> Result<(), String> {
        let (durable, stored) = tokio::sync::oneshot::channel();
        if !self.queue_notice(owner, surface, task_id, status, text, None, Some(durable), 0).await {
            return Err(format!("the notification was refused by {}", owner.as_str()));
        }
        match stored.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(format!("the notification for {} was not stored: {error:?}", owner.as_str())),
            Err(_) => Err(format!("the notification for {} was not stored: its thread stopped", owner.as_str())),
        }
    }

    /// `submitSession(.. mode: 'task-notification', origin: 'channel')` of the channel session
    /// router (`channel-session-router.mjs:19-29`): the text joins the thread's queue by the
    /// same path as a completion. A submit starts its turn on a thread it had to open too.
    /// False when the thread could not be opened or is gone.
    pub async fn queue_channel_notification(&self, owner: &ThreadId, text: String) -> bool {
        self.queue_notice(owner, "", "", "", text, Some(super::completions::ORIGIN_CHANNEL), None, 0).await
    }

    #[allow(clippy::too_many_arguments)]
    async fn queue_notice(
        &self,
        owner: &ThreadId,
        surface: &str,
        task_id: &str,
        status: &str,
        text: String,
        origin: Option<&'static str>,
        durable: Option<tokio::sync::oneshot::Sender<Result<(), super::run::RunError>>>,
        hop: u32,
    ) -> bool {
        let msg = |live, durable| Inbox::TaskNotification {
            surface: surface.to_owned(),
            task_id: task_id.to_owned(),
            status: status.to_owned(),
            text: text.clone(),
            origin,
            hop,
            live,
            durable,
        };
        if let Some(handle) = self.inner.loaded(owner) {
            return handle.inbox.send(msg(true, durable)).await.is_ok();
        }
        let ctx = CallContext::internal("task-notification");
        match self.inner.open(owner, &ctx).await {
            Ok(handle) => handle.inbox.send(msg(origin.is_some(), durable)).await.is_ok(),
            Err(_) => false,
        }
    }
}
/// The refusal of a create whose id is taken.
fn exists() -> CoreError {
    CoreError::PreconditionFailed {
        precondition: mixdog_core_api::error::Precondition::Revision {
            expected: "absent".into(),
            actual: "exists".into(),
        },
    }
}
impl DirInner {
    fn shard(&self, id: &ThreadId) -> &Mutex<HashMap<ThreadId, Slot_>> {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hasher);
        &self.shards[(hasher.finish() as usize) % SHARDS]
    }

    /// The thread of `cell` ends here: its actor ended ([`SlotLease`]), or its first record failed (the actor). It takes no
    /// more work, and its slot goes if it is still this thread's. Closing the cell under the shard lock is what an open that
    /// is about to publish the handle checks ([`Self::publish_opened`]).
    pub(crate) fn release(&self, id: &ThreadId, cell: &Arc<ControlCell>) {
        let mut shard = lock(self.shard(id));
        cell.close();
        if matches!(shard.get(id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(&h.cell, cell)) {
            shard.remove(id);
            #[cfg(any(test, feature = "test-support"))]
            self.left.notify_waiters();
        }
    }

    /// A close of the thread of `cell` failed on a write (`SessionActor::close_undone`): while its slot is still this
    /// thread's, the thread is open again, under the shard lock, and the session stays loaded. False when the directory
    /// let it go (shutdown, a failed create).
    pub(crate) fn reopen(&self, id: &ThreadId, cell: &Arc<ControlCell>) -> bool {
        let shard = lock(self.shard(id));
        let ours = matches!(shard.get(id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(&h.cell, cell));
        if ours {
            cell.reopen();
        }
        ours
    }

    /// Holds the minted `id` of a control start ([`Starting`]).
    fn start(&self, id: &ThreadId) -> Result<Starting, CoreError> {
        let mut shard = lock(self.shard(id));
        if shard.contains_key(id) || lock(&self.teardowns).contains_key(id) {
            return Err(exists());
        }
        let mark = Arc::new(Liveness::default());
        shard.insert(id.clone(), Slot_::Starting(mark.clone()));
        Ok(Starting { directory: self.me.clone(), id: id.clone(), mark })
    }

    /// What an open loaded enters the directory through the open's own `Loading` slot, and only with an actor that still
    /// runs. A handle that is not published (its actor ended while it opened, or the slot was let go at shutdown) takes no work.
    fn publish_opened(&self, id: &ThreadId, opening: &Arc<watch::Receiver<Option<Loaded>>>, result: Loaded) -> Loaded {
        let mut shard = lock(self.shard(id));
        let ours = matches!(shard.get(id), Some(Slot_::Loading(slot)) if Arc::ptr_eq(slot, opening));
        match result {
            Ok(handle) if ours && !handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst) => {
                shard.insert(id.clone(), Slot_::Loaded(handle.clone()));
                Ok(handle)
            }
            result => {
                if ours {
                    shard.remove(id);
                }
                result?.cell.close();
                Err(CoreError::ThreadClosing { thread_id: id.clone() })
            }
        }
    }

    /// Admits one attach of `handle`'s feed now, under the shard lock [`Self::unload`] closes and removes the slot under, so the
    /// two never both succeed: `Unloaded` when the slot is no longer this handle's (an unload came first; the next open loads the
    /// thread again), `Closed` when the thread is closed to attaches for good (a delete, the shutdown).
    pub(super) fn admit_attach(&self, handle: &Arc<SessionHandle>) -> AttachAdmission {
        let shard = lock(self.shard(&handle.id));
        if !matches!(shard.get(&handle.id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(h, handle)) {
            return AttachAdmission::Unloaded;
        }
        if handle.cell.subscribing() { AttachAdmission::Admitted } else { AttachAdmission::Closed }
    }

    /// Drops the loaded thread whose cell is `cell` when it still has no subscriber, and
    /// closes the cell under the shard lock. `None` when a subscriber came back meanwhile.
    /// The actor signals its own disposal before the close work runs; a reopen waits for both.
    pub(crate) fn unload(
        &self,
        id: &ThreadId,
        cell: &Arc<ControlCell>,
        teardown: futures::future::BoxFuture<'static, ()>,
    ) -> Option<oneshot::Sender<()>> {
        let mut shard = lock(self.shard(id));
        let ours = matches!(shard.get(id), Some(Slot_::Loaded(h)) if Arc::ptr_eq(&h.cell, cell));
        // The check and the close are one transition of the admission word: an attach that
        // comes after it fails, one before it makes the close fail.
        if !ours || !cell.close_unattached() {
            return None;
        }
        let (done, finished) = watch::channel(());
        let (stop, stopped) = oneshot::channel();
        lock(&self.teardowns).insert(id.clone(), finished);
        shard.remove(id);
        struct PendingTeardown {
            directory: std::sync::Weak<DirInner>,
            thread: ThreadId,
            // Dropping the sender wakes both reopen and shutdown after unregistering.
            _done: watch::Sender<()>,
        }
        impl Drop for PendingTeardown {
            fn drop(&mut self) {
                if let Some(directory) = self.directory.upgrade() {
                    // Reopen waits on this registration and fixed-id creation cannot pass it.
                    lock(&directory.teardowns).remove(&self.thread);
                }
            }
        }
        let pending = PendingTeardown { directory: self.me.clone(), thread: id.clone(), _done: done };
        tokio::spawn(async move {
            let _ = stopped.await;
            teardown.await;
            drop(pending);
        });
        #[cfg(any(test, feature = "test-support"))]
        self.left.notify_waiters();
        Some(stop)
    }

    /// The next runtime cannot open while the previous one still closes. Keep the registration
    /// visible while waiting so shutdown can also join it.
    async fn settle_teardowns(&self, id: &ThreadId) {
        let pending = lock(&self.teardowns).get(id).cloned();
        if let Some(mut finished) = pending {
            let _ = finished.changed().await;
        }
    }

    pub(crate) fn deps(&self) -> &Arc<SessionDeps> {
        &self.deps
    }

    /// Thread `id` was deleted: its Stop latches go ([`super::control::StopLatches::forget`]).
    pub(crate) fn forget_stop_latches(&self, id: &ThreadId) {
        self.stop_latches.forget(id);
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

    /// [`stored_header`](Self::stored_header) holding only the members named in `fields`: of a loaded thread they are
    /// picked from the live header, which is not copied.
    pub(super) async fn stored_fields(&self, id: &ThreadId, fields: &'static [&'static str]) -> Option<mixdog_store::schema::record::Header> {
        if let Some(handle) = self.loaded(id) {
            return Some(keep_fields(handle.cell.header.load_full().as_ref(), Some(fields)));
        }
        self.deps.store.unheld().await;
        let (store, thread) = (self.deps.store.clone(), id.clone());
        let read = mixdog_core_base::support::on_lane(self.deps.lanes.io, &CancellationToken::new(), move |lane| {
            store.read_header(lane, &thread).map(|header| header.into_iter().filter(|(key, _)| fields.contains(&key.as_str())).collect())
        })
        .await;
        read.ok()?.ok()
    }

    /// As [`stored_header`](Self::stored_header), but `Err` when the read job never ran.
    async fn try_stored_header(&self, id: &ThreadId) -> Result<Option<mixdog_store::schema::record::Header>, CoreError> {
        if let Some(handle) = self.loaded(id) {
            return Ok(Some(handle.cell.header.load_full().as_ref().clone()));
        }
        self.deps.store.unheld().await;
        let (store, thread) = (self.deps.store.clone(), id.clone());
        let read = mixdog_core_base::support::on_lane(self.deps.lanes.io, &CancellationToken::new(), move |lane| store.read_header(lane, &thread)).await?;
        Ok(read.ok())
    }

    /// The header a listing reads of a session it does not open (the Agents pool reads every worker the index names): the
    /// live one of a loaded thread, else the stored record. It answers what an open would have read without loading the
    /// session: the read waits out a full lane, and a session kept only to host a worker row has no record (`None`, as
    /// for an unknown or unreadable one).
    ///
    /// A session of the earlier version that is still to be converted has no record yet and reads as `None`: a listing
    /// names hundreds of sessions, and asking for each ahead of the rest would put them all before the one a person
    /// opens. The worker rows come from converted sessions only, so this is a worker's owner at most, until it is converted.
    ///
    /// `fields` names the header members the caller reads (`None`: all). A header carries the session's prompt and tool catalog
    /// (about 190 KB of JSON, several MB decoded), so a listing of hundreds of sessions that took whole headers held a copy
    /// of every one of them at once; the members are picked where the header is read and the rest is dropped there.
    async fn listed_header(&self, id: &ThreadId, fields: Option<&'static [&'static str]>) -> Option<mixdog_store::schema::record::Header> {
        self.listed_headers(std::slice::from_ref(id), fields).await.pop().flatten()
    }

    /// [`listed_header`](Self::listed_header) of every session of a listing, in order. The sessions that are not loaded
    /// are read from the index in one read; only one the index cannot answer for has its record read.
    async fn listed_headers(&self, ids: &[ThreadId], fields: Option<&'static [&'static str]>) -> Vec<Option<mixdog_store::schema::record::Header>> {
        let mut out: Vec<Option<Option<mixdog_store::schema::record::Header>>> =
            ids.iter().map(|id| self.loaded(id).map(|handle| Some(keep_fields(handle.cell.header.load_full().as_ref(), fields)))).collect();
        let stored: Vec<usize> = (0..ids.len()).filter(|&at| out[at].is_none()).collect();
        if stored.is_empty() {
            return out.into_iter().flatten().collect();
        }
        self.deps.store.unheld().await;
        // The members the catalog row holds are read from it: no log is opened to list a session.
        if let Some(fields) = fields.filter(|fields| fields.iter().all(|field| mixdog_store::worker::LISTED_FIELDS.contains(field))) {
            let asked: Vec<ThreadId> = stored.iter().map(|&at| ids[at].clone()).collect();
            let store = self.deps.store.clone();
            // The one read waits for room in the lane. A read that never ran (the lane refused it as overloaded, is
            // wedged or shut down) or failed answers nothing for these sessions, as a record read refused the same way
            // does: a record is read only for a session the index itself answers it cannot vouch for, never because
            // the index could not be asked.
            let rows = mixdog_core_base::support::on_lane_wait(self.deps.lanes.io, &CancellationToken::new(), move |lane| store.listed_rows(lane, &asked)).await;
            let Ok(Ok(rows)) = rows else {
                return out.into_iter().map(Option::flatten).collect();
            };
            for (&at, row) in stored.iter().zip(rows) {
                out[at] = row.map(|listed| listed.map(|header| keep_fields(&header, Some(fields))));
            }
        }
        let records = futures::future::join_all(ids.iter().zip(&out).filter(|(_, answer)| answer.is_none()).map(|(id, _)| self.read_listed_record(id, fields))).await;
        let mut records = records.into_iter();
        out.into_iter().map(|answer| answer.unwrap_or_else(|| records.next().flatten())).collect()
    }

    /// The listed header of a stored session from its record.
    async fn read_listed_record(&self, id: &ThreadId, fields: Option<&'static [&'static str]>) -> Option<mixdog_store::schema::record::Header> {
        let (store, thread) = (self.deps.store.clone(), id.clone());
        mixdog_core_base::support::on_lane_wait(self.deps.lanes.io, &CancellationToken::new(), move |lane| {
            if let Some(fields) = fields {
                return store.read_header_fields(lane, &thread, fields);
            }
            let header = store.read_header(lane, &thread)?;
            let row_only = header.get(mixdog_store::archived_agent::WORKER_ROW_ONLY_KEY).and_then(Value::as_bool) == Some(true);
            Ok::<_, CoreError>((!row_only).then(|| keep_fields(&header, fields)))
        })
        .await
        .ok()?
        .ok()?
    }

    /// `treeChanged` for a delete, in the thread's own admission: a peer is open (or opening),
    /// or an open began since `opens`, the count the peers' stored activity was read at.
    pub(crate) fn peers_changed(&self, peers: &[(ThreadId, f64)], opens: u64) -> bool {
        // An open elsewhere matters only to a tree with other members: a delete that names no peers is not refused for it.
        (!peers.is_empty() && self.opens.load(std::sync::atomic::Ordering::SeqCst) != opens)
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

    /// The thread a delete acts on: loaded, else opened for it; `None`
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

    /// The thread an op record is written through: loaded, else opened for it;
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

    /// `for_use`: the thread is opened for use, not for a delete or an op record.
    async fn open_with(&self, id: &ThreadId, ctx: &CallContext, for_use: bool) -> Result<Arc<SessionHandle>, CoreError> {
        let mut rx = {
            let mut shard = lock(self.shard(id));
            match shard.get(id) {
                Some(Slot_::Loaded(handle)) => return Ok(handle.clone()),
                Some(Slot_::Loading(rx)) => (**rx).clone(),
                // A control start's minted id has no thread yet.
                Some(Slot_::Starting(_)) => return Err(CoreError::ThreadNotFound { thread_id: id.clone() }),
                None => {
                    let (tx, rx) = watch::channel(None);
                    self.opens.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let opening = Arc::new(rx.clone());
                    shard.insert(id.clone(), Slot_::Loading(opening.clone()));
                    let me = self.me.upgrade().expect("the directory is alive while used");
                    let thread = id.clone();
                    mixdog_rt::spawn("session-open", TaskClass::Work, async move {
                        let began = me.deps.clock.now_ms();
                        me.settle_teardowns(&thread).await;
                        // A session of the earlier version that is listed and not yet converted is converted now, ahead of the rest.
                        if let Some(there) = me.arriving.get().and_then(|arriving| arriving.arriving(&thread)) {
                            there.await;
                        }
                        let waited = me.deps.clock.now_ms();
                        let result = me.load(&thread).await;
                        let loaded = me.deps.clock.now_ms();
                        // `resumeSession`'s `_refreshResumedTools`: a thread opened for use (not
                        // for a delete or an op record) takes its tool surface as it resolves now,
                        // before any caller gets it.
                        if for_use && let Ok(handle) = &result {
                            me.refresh_resumed_tools(handle).await;
                            // `resume`'s `setRoute(resumedRoute)`: the runtime takes the route its session holds.
                            me.deps.new_route.boot(&thread, &handle.cell.header.load_full());
                            // `resume`'s `routePreparation`: the booted route takes its effort fields once the provider's catalog
                            // answers; the open does not wait for it.
                            let route = me.deps.new_route.clone();
                            let prepared = thread.clone();
                            drop(mixdog_rt::spawn("route-prepare", TaskClass::Work, async move { route.prepare(&prepared).await }));
                        }
                        // An open a person waits for: one that took long says which step did.
                        let ended = me.deps.clock.now_ms();
                        if ended - began >= SLOW_OPEN_MS {
                            tracing::warn!(thread = thread.as_str(), before_ms = waited - began, load_ms = loaded - waited, tools_ms = ended - loaded, "slow session open");
                        }
                        let result = me.publish_opened(&thread, &opening, result);
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
    async fn load(&self, id: &ThreadId) -> Loaded {
        use mixdog_core_base::support::on_lane_wait;
        let deps = self.deps.clone();
        let token = CancellationToken::new();
        // An open (for a turn, a carried mark, a worker's report) waits out full lanes rather than failing on them.
        deps.store.unheld().await;
        let (store, thread) = (deps.store.clone(), id.clone());
        let head = on_lane_wait(deps.lanes.io, &token, move |lane| store.read_head(lane, &thread)).await??;
        deps.store.unheld().await;
        let (store, thread) = (deps.store.clone(), id.clone());
        let (head, window) = on_lane_wait(deps.lanes.io, &token, move |lane| {
            let window = store.read_window(lane, &thread, &head);
            (head, window)
        })
        .await?;
        let window = window?;
        let (decode_deps, thread) = (deps.clone(), id.clone());
        let opened = on_lane_wait(deps.lanes.cpu, &token, move |lane| {
            let log = decode_deps.store.decode(lane, &thread, head, window)?;
            Ok::<_, CoreError>(fold_opened(lane, &decode_deps, log))
        })
        .await??;
        deps.store.unheld().await;
        let (store, thread) = (deps.store.clone(), id.clone());
        let fenced = on_lane_wait(deps.lanes.io, &token, move |lane| store.fenced_ops(lane, &thread)).await??;
        let lineage = self.lineage_of(id, &opened.state.header);
        let (ready, recovered) = tokio::sync::oneshot::channel();
        let (handle, launch) = self.spawn(
            id.clone(),
            opened.state,
            opened.control,
            Arc::default(),
            lineage,
            opened.log_id,
            opened.next_ordinal,
            opened.log,
            Init::Open { fenced, ready },
        );
        // The gate shuts before the actor can take a send; the history's images are imported in the background and it opens
        // when each has a verdict.
        handle.image_gate.begin();
        launch();
        // Node recovers an interrupted turn before the session is returned (`turn-checkpoint-recovery.mjs:131`):
        // the first read sees the recovered conversation. A dropped actor ends the wait too.
        let _ = recovered.await;
        // The history is read for its images once the recovery has settled it, never beside the recovery's own read.
        drop(mixdog_rt::spawn("image-gate", mixdog_rt::TaskClass::Work, image_gate_run(deps.clone(), id.clone(), handle.image_gate.clone())));
        Ok(handle)
    }

    /// P §8.3: a sub-agent's requests show on its parent's surface. A room member's requests show
    /// on its room's log (Node's room log carries the speaking member's `toolApproval`,
    /// `agent-room-turn.ts:278`, `agent-room-views.ts:89`), so a client on the log receives them
    /// and its response decides them in the member's thread (P §8.4).
    fn lineage_of(&self, id: &ThreadId, header: &Header) -> Lineage {
        if let Some(log) = super::delegation::room_log_surface(id.as_str()) {
            return Lineage { surface: log, chain: Vec::new() };
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

    /// Builds the handle, actor and durability task for `id`; the returned launch starts the tasks, the actor's with its
    /// [`SlotLease`]. A create calls it under the shard lock and launches after the lock is let go, so a task dropped at
    /// once (a runtime shutting down) releases its slot without that lock held.
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        id: ThreadId,
        state: SessionState,
        control: bool,
        liveness: Arc<Liveness>,
        lineage: Lineage,
        log_id: String,
        next_ordinal: u64,
        log: LogInit,
        init: Init,
    ) -> (Arc<SessionHandle>, impl FnOnce() + use<>) {
        let deps = &self.deps;
        let limits = deps.limits;
        // The strip is part of the state the first view and the feed's first snapshot are built from: a session shown on its open
        // carries its shell pane at once.
        let mut state = state;
        if let Some(strip) = deps.shell_strips.strip(&id) {
            state.sections.shell_jobs = Some(strip);
        }
        let (ctl_tx, ctl_rx) = mpsc::channel(limits.control_lane);
        let (inbox_tx, inbox_rx) = mpsc::channel(limits.inbox);
        let (prod_tx, prod_rx) = mpsc::channel(limits.producer_lane);
        let (dur_tx, dur_in) = mpsc::channel(
            limits.window_records + limits.reserve_records + limits.control_lane + 1,
        );
        let (dur_out, dur_rx) = mpsc::channel(8);
        #[cfg(feature = "replay-settled")]
        let settled = super::replay_settled::Lane::register(id.as_str(), &ctl_tx, &inbox_tx, &prod_tx);
        let epoch = new_epoch();
        let feed_id = FeedId::from(id.as_str());
        let mut view = SessionView::build(
            feed_id.clone(),
            deps.transcript.summary(&id, &super::archive_trees::resolved_header(&deps.archive, id.as_str(), &state.header)),
            &state,
            mixdog_app_protocol::v2::thread::StorageState::Ok,
            None,
        );
        // Node's store holds the agent scope from its first state (`initial-state.mjs:57`), and the scope needs only the header: a
        // `thread/read` answered before the actor's first publish shows it too (the actor publishes it as its load's first change).
        let agents = view.state.agents.take().unwrap_or_default();
        view.state.agents = Some(mixdog_app_protocol::v2::thread::ThreadAgents {
            agent_scope: Some(super::agent_registry::status_rows::agent_scope(&id, &state.header)),
            ..agents
        });
        let view = Arc::new(view);
        let feed = deps.feeds.thread_feed(feed_id, epoch.clone(), view.clone());
        let surface = watch::Sender::new(Arc::new(deps.surfaces.surface(&id, &state.header)));
        let cell = Arc::new(ControlCell {
            thread: id.clone(),
            liveness,
            run: Default::default(),
            turn_chain: Default::default(),
            queued: Default::default(),
            queue: arc_swap::ArcSwap::from_pointee(state.queue.clone()),
            approvals: Default::default(),
            shown_approval: Default::default(),
            shown_changed: tokio::sync::watch::Sender::new(0),
            takeover: Default::default(),
            view: arc_swap::ArcSwap::new(view),
            header: arc_swap::ArcSwap::from_pointee(state.header.clone()),
            surface: surface.subscribe(),
            progress: watch::Sender::new(Default::default()),
            turn_messages: watch::Sender::new(Default::default()),
            turn_listeners: Default::default(),
            agent_start: Default::default(),
            routine_starts: Default::default(),
            grants: Arc::new(mixdog_tools::policy::SessionGrants::of(deps.session_grants.clone(), id.as_str())),
            ctl_tx,
            steer_cap: limits.steer_queue,
            subscribers: Default::default(),
            closed: Default::default(),
            session_ended: Default::default(),
            turn_held: Default::default(),
            turn_pending: Default::default(),
            ui_busy: Default::default(),
            compacting: Default::default(),
            live_rows: self.live_rows.clone(),
            stop_latches: self.stop_latches.clone(),
            #[cfg(any(test, feature = "test-support"))]
            start_fences: Default::default(),
            compaction_cancel: Default::default(),
            pending_compact: Default::default(),
            gated: Default::default(),
            deferring: Default::default(),
            retention: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            stepped: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            unacked: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            handed: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            busy: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            retry_blocked: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            goal_pending: Default::default(),
            #[cfg(test)]
            ask_marked: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            prompt_timers: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            recovered: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            drafts_settled: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            gate_holds: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            drain_passes: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            stop_ledger: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            prompt_marks: Arc::new(mixdog_rt::WriteMarks::new("the prompt history")),
            #[cfg(any(test, feature = "test-support"))]
            record_marks: Arc::new(mixdog_rt::WriteMarks::new("the thread's records")),
        });
        let handle = Arc::new(SessionHandle {
            id: id.clone(),
            control,
            cell: cell.clone(),
            feed: feed.clone(),
            subscriptions: Arc::new(super::handle::CountedFeed::new(cell.clone(), feed.clone())),
            inbox: inbox_tx,
            producers: prod_tx.clone(),
            lineage: lineage.clone(),
            deps: deps.clone(),
            directory: self.me.clone(),
            reactions: Default::default(),
            submits: Default::default(),
            image_gate: Default::default(),
            loaded_seq: self.loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
        });
        let lease = SlotLease { directory: self.me.clone(), id: id.clone(), cell: cell.clone() };
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
                #[cfg(feature = "replay-settled")]
                settled,
            },
        );
        let mut actor = actor;
        let launch = move || {
            actor.hold(lease);
            mixdog_rt::spawn("session-durability", TaskClass::Work, durability.run());
            mixdog_rt::spawn("session-actor", TaskClass::Work, actor.run(init));
        };
        (handle, launch)
    }

    /// A new thread: its `session` record is its first durable write; the reply follows it.
    pub(crate) async fn create(&self, spec: CreateSpec) -> Result<Arc<SessionHandle>, CoreError> {
        // The create settling, whichever way, is a busy-state change (`rt.wakeDeferredWarmups`):
        // a warm parked on it re-checks.
        let _settled = super::prewarm_signals::WakeOnDrop(self.deps.code_graph_prewarm.clone());
        let _creating = InFlight::enter(&self.creating);
        let id = spec.id.unwrap_or_else(|| self.mint_session_id());
        let invalid = |path: &str| CoreError::InvalidParams {
            path: path.into(),
            expected: "a shorter value".into(),
        };
        let mut header = spec.header;
        header.insert("id".into(), Value::String(id.as_str().to_owned()));
        // Joined to its tree before the count moves: a preparation that reads the count after this finds the link.
        if mixdog_store::summary::session_visibility(&header) == "agent-only" {
            let mut links = lock(&self.created_links);
            for parent in super::sub_agent_retention::parent_ids(&header, id.as_str()) {
                links.entry(parent).or_default().push(id.as_str().to_owned());
            }
        }
        self.created.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // A new thread names no other session's sidecars yet: its reference set is known from its first record (Node's
        // `withOffloadSources` at its first save), not left unknown for every prune to scan. A fork reading a base's
        // rows names what they name: it holds none, and its transcript is scanned.
        if spec.base.is_none() && !mixdog_store::offload_sources::holds_set(&header) {
            let held = mixdog_store::offload_sources::sources(&header);
            mixdog_store::offload_sources::set_sources(&mut header, held);
        }
        let log_id = uuid::Uuid::new_v4().simple().to_string()[..24].to_owned();
        let op = match &spec.op {
            Some(op) => Some(mixdog_store::schema::record::OpRef {
                id: Text::try_from(op.as_str()).map_err(|_| invalid("opId"))?,
                method: Text::try_from(spec.method.as_str()).map_err(|_| invalid("method"))?,
                digest: mixdog_store::schema::bounded::Digest::try_from(super::ops::digest(
                    &spec.params,
                ))
                .expect("digest is well formed"),
                audience: spec.op_audience,
                result: None,
            }),
            None => None,
        };
        // Only a control start holds its id before the create.
        let control = spec.starting.is_some();
        let session = Record::Session(SessionRecord {
            v: SESSION_RECORD_VERSION,
            id: Text::try_from(id.as_str()).map_err(|_| invalid("threadId"))?,
            log_id: Text::try_from(log_id.as_str()).expect("24 hex"),
            base: spec.base,
            origin: None,
            op,
            control,
            header: Slot::Inline(header.clone()),
        });
        let mut state = SessionState::new(self.deps.limits.view_items);
        state.header = header.clone();
        let lineage = self.lineage_of(&id, &header);
        let (tx, rx) = oneshot::channel();
        let (handle, launch) = {
            let mut shard = lock(self.shard(&id));
            match (shard.get(&id), &spec.starting) {
                (None, None) if !lock(&self.teardowns).contains_key(&id) => {}
                (Some(Slot_::Starting(mark)), Some(starting)) if Arc::ptr_eq(mark, &starting.mark) => {}
                // The start's hold was let go (shutdown drains every slot).
                (None, Some(_)) => return Err(CoreError::ThreadClosing { thread_id: id.clone() }),
                _ => return Err(exists()),
            }
            // A control start's liveness goes on as the thread's: an adoption that listed the start syncs the thread.
            let liveness = spec.starting.as_ref().map_or_else(Arc::default, |starting| starting.mark.clone());
            let (handle, launch) = self.spawn(
                id.clone(),
                state,
                control,
                liveness,
                lineage,
                log_id,
                0,
                LogInit::Create,
                Init::Create {
                    session,
                    tx: Some(tx),
                    value: json!({}),
                    seed: spec.seed,
                    settings: spec.settings,
                    kept: spec.method.as_str() == "thread/fork",
                },
            );
            shard.insert(id.clone(), Slot_::Loaded(handle.clone()));
            (handle, launch)
        };
        launch();
        // The slot is the actor's from here: a failed first record, an unwind or any other end of the actor releases it
        // (`release`), whether or not this caller is still waiting, so no way out of this wait removes anything.
        rx.await.map_err(|_| CoreError::ThreadClosing { thread_id: id.clone() })??;
        match self.loaded(&id) {
            Some(loaded) if Arc::ptr_eq(&loaded, &handle) => Ok(loaded),
            _ => Err(CoreError::ThreadClosing { thread_id: id }),
        }
    }
}
impl SessionDirectory {
    /// The `thread/start` thread up to its seated route (`createSession`, `seedToolSurface`, the draft's route): under `id` when one is
    /// given (a new task's address comes from its receipt), else under a minted one. A new task's attempt passes its `attempt`, whose
    /// step enters the draft step where the draft's workflow, orchestration mode (when `configure`: Node's `configureDraft` runs on a
    /// `reserved` receipt only) and route are applied (Node's `setWorkflow`, `setOrchestrationMode`, `setRoute`, awaited in that order
    /// after `client.create` returned, session-host-lifecycle.ts:765-779).
    pub(super) async fn begin_thread(&self, req: &CoreRequest, params: &ThreadStartParams, id: Option<ThreadId>, attempt: Option<(&super::new_task::StepCell, bool)>) -> Result<Arc<SessionHandle>, CoreError> {
        let now = self.inner.deps.clock.now_ms();
        let mut header = Header::new();
        header.insert("createdAt".into(), json!(now));
        header.insert("updatedAt".into(), json!(now));
        header.insert("lastUsedAt".into(), json!(now));
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
                // `requiredNewTaskDraft` kept the draft's path trimmed.
                .or_else(|| params.draft.as_ref().and_then(|draft| draft.project_path.as_deref()).map(|path| mixdog_js::js_trim(path).to_owned()))
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
        // A new task's address is given (`client.create` at the reserved address).
        let reserved = id.is_some();
        let id = id.unwrap_or_else(|| self.inner.mint_session_id());
        // The control session is followed by the config's adoption from before its route is first resolved.
        let starting = if control { Some(self.inner.start(&id)?) } else { None };
        // The route the thread begins on is settled first: the tools and the prompt below are
        // composed for it, as Node composes the session from `rt.route`.
        let pick = params.draft.as_ref().and_then(|draft| draft.route.as_ref()).map(super::new_route::draft_pick);
        // A draft's route is saved after the session exists in Node (`configureDraft`), so the session is created against the config as
        // it is before it. A thread of a narrowed profile is created on its route: Node boots a headless or heartbeat runtime with
        // the route (`createHeadlessSessionRuntime`), and no `setRoute` follows.
        if pick.is_some() && !control && super::session_options::header_tool_profile(&header).is_none() {
            self.inner.deps.new_tools.creating(&id);
        }
        // Node's session exists before the draft's `setRoute` saves the route: the thread follows the settings counter from here.
        let settings = self.inner.deps.compaction.settings_changes(&id).map(super::actor::SettingsFollow::begin);
        // The control session is created before any model is chosen (`ensureControlSession`): its route is not refused for lacking one.
        let route = if control {
            self.inner.deps.new_route.adopt_control(&id).await
        } else {
            if let Some((step, configure)) = attempt {
                let closing = self.inner.deps.new_tasks.closing();
                let draft = params.draft.as_ref();
                let settings = &self.inner.deps.draft_settings;
                // `requiredNewTaskDraft` kept the draft's workflow id trimmed.
                if let Some(workflow) = draft.and_then(|draft| draft.workflow_id.as_deref()).map(mixdog_js::js_trim).filter(|workflow| configure && !workflow.is_empty()) {
                    step.set(super::new_task::Step::Configuring);
                    super::new_task::quit_gate("setWorkflow", &closing).await;
                    if let Err(error) = settings.set_workflow(&id, workflow).await {
                        // A draft can remember a workflow deleted since; it starts on the built-in Default (:770-772).
                        if !super::new_task::workflow_not_found(&error) {
                            return Err(error);
                        }
                        settings.set_workflow(&id, "default").await?;
                    }
                }
                let mode = draft.and_then(|draft| draft.orchestration_mode).and_then(|mode| serde_json::to_value(mode).ok());
                if let Some(Value::String(mode)) = mode.filter(|_| configure) {
                    step.set(super::new_task::Step::Configuring);
                    super::new_task::quit_gate("setOrchestrationMode", &closing).await;
                    settings.set_orchestration_mode(&id, &mode).await?;
                }
                if pick.is_some() {
                    step.set(super::new_task::Step::Configuring);
                    super::new_task::quit_gate("setRoute", &closing).await;
                }
            }
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
                op_audience: req.op.as_ref().map(|_| {
                    mixdog_store::schema::bounded::Digest::try_from(mixdog_core_base::ops::replay_audience(&req.ctx).as_str().to_owned())
                        .expect("audience digest is well formed")
                }),
                method: req.method,
                params: req.params.clone(),
                seed: Some(seeded),
                settings,
                starting,
            })
            .await?;
        // A test build of a new task may end here: the record is written and the creation has not returned (Node's daemon made
        // the session and its answer to `client.create` was lost).
        if reserved {
            super::new_task::crash_gate("created");
        }
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
        self.session_started(&handle, &req.ctx).await;
        Ok(handle)
    }

    /// `dispatchSessionStart(deps, reason, signal)` (`session-create.mjs` `buildSession`, right after `materializeSession`): the
    /// runtime's new session fires `SessionStart` before anything else uses it, and the context its handlers add is stored
    /// ahead of the first user turn as a reminder and its ack (`rt.session.messages.push(..)`, `updatedAt` stamped with
    /// them). Best-effort: a hook problem, or rows that could not be stored, never fail the creation; a caller that gave
    /// up stops the wait (`runAbortable(signal, ..)`).
    async fn session_started(&self, handle: &Arc<SessionHandle>, ctx: &CallContext) {
        let header = handle.cell.header.load_full();
        let context = tokio::select! {
            context = self.inner.deps.lifecycle.session_start(&handle.id, &header) => context,
            () = ctx.cancel.cancelled() => return,
        };
        let Some(rows) = super::lifecycle_hooks::session_start_rows(&context) else { return };
        // Model context only, never displayed: rows of no turn.
        let rows: Vec<Value> = rows.into_iter().map(|body| json!({ "body": body, "visible": false })).collect();
        let commit = CoreRequest { method: Method("thread/roomRows/commit"), params: json!({ "rows": rows }), op: None, ctx: CallContext::internal("session-start-hook") };
        if let Err(error) = handle.request(commit).await {
            tracing::warn!("session {}: the SessionStart hook context was not stored: {error}", handle.id.as_str());
        }
    }

    /// The draft's worktree, entered before the first prompt (Node: after the draft's route, workflow and mode).
    /// `cwd` becomes the managed worktree; the classification keeps the project. The control session has
    /// no draft (`ensureControlSession`, not `createNewTask`): whatever draft a control start names enters nothing.
    pub(super) async fn enter_draft_worktree(&self, handle: &Arc<SessionHandle>, req: &CoreRequest, params: &ThreadStartParams) -> Result<(), CoreError> {
        if let Some(worktree) = params.draft.as_ref().and_then(|draft| draft.worktree.as_ref()).filter(|_| params.kind != ThreadStartKind::Control) {
            let input = params.initial_input.as_ref().and_then(|input| serde_json::to_value(input).ok());
            self.inner.deps.new_place.enter_worktree(&handle.id, worktree, input.as_ref(), &req.ctx.cancel).await?;
        }
        Ok(())
    }

    /// The first prompt of a started thread, as `turn/start`; the turn's answer. A first prompt the session refuses leaves no
    /// thread behind.
    pub(super) async fn first_turn(&self, handle: &Arc<SessionHandle>, req: &CoreRequest, input: TurnInput) -> Result<Option<Value>, CoreError> {
        let started = handle
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
            .await;
        if matches!(&started, Err(CoreError::DomainError { code: Some(code), .. }) if code.as_ref() == super::actor::SUBMIT_REFUSED) {
            let _ = super::delete::delete_session(&self.inner, handle.id.as_str(), None).await;
        }
        Ok(match started? {
            Reply::Value(turn) => Some(turn),
            Reply::Subscribe(_) => None,
        })
    }

    /// The reply of a `thread/start`: the thread's feed from its last items, its subscription counted ([`super::handle::CountedFeed`]).
    pub(super) fn subscribed(&self, handle: &Arc<SessionHandle>, result: Value) -> Subscribe {
        let feed: Arc<dyn mixdog_core_api::FeedSource> = handle.subscriptions.clone();
        Subscribe { result, feed, window: Window::LastItems(200), resume_from: None }
    }

    /// The control `thread/start` of a paired phone: the one control thread every relay connection is answered with, as Node's
    /// host answered every phone call that named no session from its one control session (`ensureControlSession`,
    /// session-host-transport.ts:235 at v1.4.5). Each connection subscribes it on its own (the reply's feed); a reload or another
    /// phone gets the same thread for as long as it exists, and a new one is started once it does not (deleted, or swept as a
    /// blank record an hour after the last phone left). The starts are serialized, so phones arriving together share one.
    ///
    /// The reply's attach is admitted before the reply is made ([`DirInner::admit_attach`], under the shard lock an unload takes),
    /// so no close is admitted between the lookup and the attach: an unload that came first left the slot, and the thread is opened
    /// again; a close for good (a delete, the shutdown) makes the next thread the phones'. The caller never retries.
    async fn remote_control(&self, req: &CoreRequest, params: &ThreadStartParams) -> Result<Reply, CoreError> {
        let _turn = self.inner.remote_control.acquire().await.expect("the remote-control gate is never closed");
        let get = || self.inner.remote_thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        let put = |value: Option<ThreadId>| *self.inner.remote_thread.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = value;
        loop {
            let handle = match get() {
                Some(id) => match self.inner.open(&id, &req.ctx).await {
                    Ok(handle) => handle,
                    Err(CoreError::ThreadNotFound { .. } | CoreError::ThreadClosing { .. }) => {
                        put(None);
                        continue;
                    }
                    Err(error) => return Err(error),
                },
                None => {
                    let handle = self.begin_thread(req, params, None, None).await?;
                    put(Some(handle.id.clone()));
                    handle
                }
            };
            match self.inner.admit_attach(&handle) {
                AttachAdmission::Admitted => {
                    let result = json!({ "thread": handle.cell.view.load_full().summary });
                    let feed: Arc<dyn mixdog_core_api::FeedSource> = Arc::new(super::handle::AdmittedFeed::new(handle.subscriptions.clone()));
                    return Ok(Reply::Subscribe(Subscribe { result, feed, window: Window::LastItems(200), resume_from: None }));
                }
                AttachAdmission::Unloaded => continue,
                AttachAdmission::Closed => put(None),
            }
        }
    }

    /// A handle onto the same directory, for work that outlives the request that began it.
    pub(super) fn share(&self) -> SessionDirectory {
        Self::over(self.inner.clone())
    }

    /// Ends an unclaimed thread: its record and everything that follows it (`thread/delete`).
    pub(super) async fn discard(&self, id: &ThreadId) {
        let _ = super::delete::delete_session(&self.inner, id.as_str(), None).await;
    }
}
#[async_trait]
impl ThreadDirectory for SessionDirectory {
    fn stop_room(&self, id: &ThreadId) -> Option<mixdog_core_api::thread::RoomStopped> {
        let room = mixdog_core_base::rooms::ids::room_id_of_session(id.as_str())?;
        self.inner.deps.room_members.stop_room(&room)
    }

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
                if super::new_task::starts_new_task(&req.params) {
                    return self.start_new_task(req, params).await;
                }
                if params.kind == ThreadStartKind::Control && req.ctx.origin == mixdog_protocol::Origin::Relay {
                    return self.remote_control(&req, &params).await;
                }
                let handle = self.begin_thread(&req, &params, None, None).await?;
                self.enter_draft_worktree(&handle, &req, &params).await?;
                let mut result = json!({ "thread": handle.cell.view.load_full().summary });
                if let Some(input) = params.initial_input
                    && let Some(turn) = self.first_turn(&handle, &req, input).await?
                {
                    result["turn"] = turn;
                }
                Ok(Reply::Subscribe(self.subscribed(&handle, result)))
            }
            "thread/delete" => super::delete::serve(&self.inner, &req.params, &req.ctx.cancel).await,
            "thread/fork" => {
                // `inheritFrom` (`lifecycle/inheritance.mjs`): "a daemon-created heir is still only RESERVED when the desktop calls
                // this": the session is created first (`createCurrentSession('inherit')`), and only then is the source looked up,
                // so a source that is not there refuses with the heir already created.
                // The source is named first (`if (!id) throw TypeError('inheritFrom: source session id is required')`): a request
                // that names none leaves the reservation as it is.
                let source = req
                    .params
                    .get("threadId")
                    .and_then(Value::as_str)
                    .map(mixdog_js::js_trim)
                    .filter(|id| !id.is_empty())
                    .map(|id| ThreadId::from(id.to_owned()))
                    .ok_or_else(|| CoreError::InvalidParams { path: "threadId".into(), expected: "a thread id".into() })?;
                if let Some(heir) = req.params.get("intoThreadId").and_then(Value::as_str) {
                    self.seat_session(&ThreadId::from(heir)).await?;
                }
                self.inner.open(&source, &req.ctx).await?.request(req).await
            }
            method if super::reads::serves(method) => self.inner.serve_read(&req).await,
            "thread/inheritancePreflight" => self.inheritance_preflight(&req.params).await.map(Reply::Value),
            "thread/approval/answerNotification" => self.answer_approval_notification(&req).await,
            "thread/approval/answer" => self.answer_approval(&req).await,
            _ => Err(CoreError::InvalidParams {
                path: "method".into(),
                expected: "a session-directory method".into(),
            }),
        }
    }

    async fn read_vanished(&self, id: &ThreadId, _req: CoreRequest) -> Result<Reply, CoreError> {
        self.inner.read_archived(id).await
    }
}
impl mixdog_core_domains::domains::ai_admin::route_service::LiveControls for SessionDirectory {
    /// The threads listed now, each synced under its [`Liveness`]: one that ended since it was listed (closed, deleted,
    /// unloaded, its actor ended, its start abandoned) is skipped, and one that ends while it is synced ends after.
    fn sync_live(&self, sync: &mut dyn FnMut(&ThreadId)) {
        let listed = self.controls();
        #[cfg(any(test, feature = "test-support"))]
        if let Some((arrived, go)) = lock(&self.inner.adoption_gate).take() {
            arrived.notify_one();
            go.recv().expect("the test lets the adoption go on");
        }
        for (id, liveness) in listed {
            liveness.while_live(|| sync(&id));
        }
    }
}
/// Node's `withTeardownDeadline` (`memory-ingest.mjs:40`): stops waiting for `work` after `deadline`, and `work` goes on running (the insert is not
/// rolled back; it ends with its pool). Dropping `work` would cancel it, so it runs as a task and only the wait is bounded.
/// The restore gate's work: read the history's rows, import every image they hold that no image choice already covers (left
/// out, replaced, or before a new start) into the vault, and open (or name what needs repair in) the thread's
/// [`super::image_gate::ImageGate`]. Choices that cannot be read cover nothing: the send then says so and offers the new start
/// that replaces them.
async fn image_gate_run(deps: Arc<SessionDeps>, id: ThreadId, gate: Arc<super::image_gate::ImageGate>) {
    let overlay = super::image_overlay_store::load(deps.user_cwd.data_dir(), id.as_str()).unwrap_or_default();
    let (sensitive, thread) = (deps.sensitive.clone(), id.clone());
    // Scan the model lineage (including compaction replacements), not the display transcript.
    let scan = super::run::fold_context(&deps.store, &deps.lanes, &id, 0, move |scan: &mut super::image_gate::ImageScan, mut rows| {
        rows.retain(|(id, _)| !id.as_str().is_empty());
        sensitive.held(&thread, &mut rows);
        scan.page(rows, &overlay);
    }).await;
    let (run_items, pending) = match scan {
        Ok(scan) => scan.finish(),
        Err(error) => {
            tracing::warn!(?error, "the restored history could not be read for its images");
            gate.finish(&[], &mixdog_image_vault::migration::Report { results: Vec::new(), cancelled: false });
            return;
        }
    };
    if run_items.is_empty() {
        gate.finish(&pending, &mixdog_image_vault::migration::Report { results: Vec::new(), cancelled: false });
        return;
    }
    gate.progress(mixdog_image_vault::migration::Progress { done: 0, total: run_items.len() });
    let vault = mixdog_image_vault::ImageVault::for_blobs(deps.attachments.0.clone());
    let run_gate = gate.clone();
    let report = mixdog_core_base::support::on_lane_wait(deps.lanes.io, &CancellationToken::new(), move |lane| {
        mixdog_image_vault::migration::migrate(&vault, lane, &run_items, &mixdog_image_egress::admission::Cancel::default(), &mut |progress| run_gate.progress(progress))
    })
    .await;
    match report {
        Ok(report) => gate.finish(&pending, &report),
        Err(_) => gate.finish(&pending, &mixdog_image_vault::migration::Report { results: pending.iter().map(|item| (item.key.clone(), mixdog_image_vault::migration::ItemResult::NotRun)).collect(), cancelled: true }),
    }
}

async fn wait_without_cancelling(deadline: std::time::Duration, work: impl std::future::Future<Output = ()> + Send + 'static) {
    let task = mixdog_rt::spawn("core-session.shutdown-ingest", TaskClass::Work, work);
    let _ = mixdog_rt::time::timeout(deadline, task).await;
}


impl SessionDirectory {
    pub fn new(deps: Arc<SessionDeps>) -> Self {
        #[cfg(feature = "replay-settled")]
        super::replay_settled::start();
        let inner = Arc::new_cyclic(|me| DirInner {
            deps,
            shards: (0..SHARDS).map(|_| Mutex::new(HashMap::new())).collect(),
            me: me.clone(),
            opens: Default::default(),
            loads: Default::default(),
            creating: Default::default(),
            created: Default::default(),
            created_links: Mutex::default(),
            gate: Default::default(),
            goal_events: Mutex::new(None),
            quota_events: Mutex::new(None),
            owner_teardown: std::sync::OnceLock::new(),
            exit_close: std::sync::OnceLock::new(),
            arriving: std::sync::OnceLock::new(),
            live_rows: Default::default(),
            stop_latches: Default::default(),
            closed: Default::default(),
            teardowns: Default::default(),
            remote_control: tokio::sync::Semaphore::new(1),
            remote_thread: Mutex::default(),
            #[cfg(any(test, feature = "test-support"))]
            left: Default::default(),
            #[cfg(any(test, feature = "test-support"))]
            adoption_gate: Default::default(),
        });
        let me = Arc::downgrade(&inner);
        let subscription = inner.deps.goals.on_goal_change(Box::new(move |event| {
            let Some(directory) = me.upgrade() else { return };
            if let Some(handle) = directory.loaded(&ThreadId::from(event.session_id.as_str())) {
                let _ = handle.inbox.try_send(Inbox::GoalChanged(event.goal.clone()));
            }
        }));
        *lock(&inner.goal_events) = Some(subscription);
        // A change that names no session changed every entry: each loaded thread reads its own again.
        let me = Arc::downgrade(&inner);
        let subscription = inner.deps.quota.goals.subscribe(move |session| {
            let Some(directory) = me.upgrade() else { return };
            let handles: Vec<Arc<SessionHandle>> = match session {
                Some(id) => directory.loaded(&ThreadId::from(id)).into_iter().collect(),
                None => SessionDirectory::over(directory).loaded_handles(),
            };
            for handle in handles {
                let _ = handle.inbox.try_send(Inbox::QuotaResumeChanged);
            }
        });
        *lock(&inner.quota_events) = Some(subscription);
        let me = Arc::downgrade(&inner);
        inner.deps.sensitive.on_carried(Box::new(move |thread| {
            let Some(directory) = me.upgrade() else { return };
            let thread = thread.clone();
            drop(mixdog_rt::spawn("sensitive-carried", mixdog_rt::TaskClass::Work, async move {
                SessionDirectory::over(directory).carried(&thread).await;
            }));
        }));
        Self { inner }
    }

    /// A value marked in a session whose text `thread` holds reached it (`SensitiveMarks::carry`): the thread rewrites what
    /// it stored as for a mark of its own; one not loaded is opened for it (its files hold the text).
    async fn carried(&self, thread: &ThreadId) {
        let context = CallContext::internal("sensitive-carried");
        let opened = once_released(
            || self.is_closed(),
            || async {
                match self.inner.loaded(thread) {
                    Some(handle) => Ok(handle),
                    None => self.inner.open(thread, &context).await,
                }
            },
        )
        .await;
        match opened {
            Ok(handle) => {
                let _ = handle.inbox.send(Inbox::SensitiveCarried).await;
            }
            Err(error) => tracing::warn!(%thread, "a carried sensitive value could not open the thread that holds it: {error:?}"),
        }
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

    /// `turnHopOf(session)`: the hop of the turn the loaded thread is in; 0 for a thread not loaded.
    pub fn turn_hop(&self, id: &ThreadId) -> u32 {
        self.handle(id).map_or(0, |handle| handle.cell.turn_chain.hop())
    }

    /// The concrete handle of a loaded thread.
    pub fn handle(&self, id: &ThreadId) -> Option<Arc<SessionHandle>> {
        self.inner.loaded(id)
    }

    /// Run the restore check of a loaded thread's images again: the gate shuts and the history's images are imported in the
    /// background, as when the thread was opened. A thread that is not loaded has nothing to recheck (it is checked when opened).
    pub fn recheck_image_gate(&self, id: &ThreadId) {
        if let Some(handle) = self.handle(id) {
            handle.image_gate.begin();
            drop(mixdog_rt::spawn("image-gate", mixdog_rt::TaskClass::Work, image_gate_run(self.deps().clone(), id.clone(), handle.image_gate.clone())));
        }
    }

    /// Node's `stop()` sets `closed` first (`session-service.mjs:257`), before it tears the entries down: every session call
    /// then answers `session service is closed`. [`Self::shutdown_for`] does it as its first step.
    pub(super) fn begin_close(&self) {
        self.inner.closed.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Whether the shutdown began (Node's session service `isClosed()`).
    pub fn is_closed(&self) -> bool {
        self.inner.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The turn gate, for the tests that hold a start's admission or a delete's fence.
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
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

    /// The stored transcript of a thread, loaded or not, oldest first: what `session action=read` quotes.
    pub async fn transcript_items(&self, id: &ThreadId) -> Result<Vec<mixdog_protocol::ThreadItem>, CoreError> {
        super::reads::history_items(&self.inner.deps, id).await
    }

    /// `rt.pendingCompactSessionIds.add(id)` of the `session` tool's compact: the loaded thread compacts
    /// when its turn settles (once, whatever the turn's outcome). A thread that is not loaded has no turn to wait for.
    pub fn schedule_compact_after_turn(&self, id: &ThreadId) -> Result<(), CoreError> {
        let Some(handle) = self.inner.loaded(id).filter(|handle| !handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst)) else {
            return Err(mixdog_core_base::support::failed("session", format!("session: {} is not loaded", id.as_str())));
        };
        handle.cell.pending_compact.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
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

    /// A user Stop of exactly the work session `id` holds under `submissions` (a room Stop of its exchange's member submissions):
    /// the session is opened if it is not loaded, each submission is frozen wherever it is (or tombstoned before it arrives) under
    /// a cancelled `work_stop`, and this answers once every record is durable, else the storage failure. Unrelated work in the
    /// session is neither aborted nor waited for.
    pub async fn stop_work(&self, id: &ThreadId, submissions: Vec<String>) -> Result<(), CoreError> {
        self.latch_work(id, &submissions);
        let handle = self.open_handle(id, &CallContext::internal("room-stop")).await?;
        handle.stop_work(submissions).await
    }

    /// The synchronous half of [`Self::stop_work`], at the Stop's linearization point: session `id`'s actor treats the work
    /// submitted under `submissions` as terminal from now on (no drain, injection, admission or late start runs it), before and
    /// independent of any storage wait and whether or not the session is loaded. A run already running one of them is aborted
    /// at once with the user's cancel (the start gate, [`super::control::StopLatches`]). The durable record follows with
    /// `stop_work`.
    pub fn latch_work(&self, id: &ThreadId, submissions: &[String]) {
        let identities = submissions.iter().filter(|id| !id.is_empty()).map(|id| mixdog_store::work_stops::submission(id));
        let abort = mixdog_agent::cancel::Abort::runtime_abort(id.as_str(), mixdog_agent::cancel::USER_CANCEL);
        self.inner.stop_latches.latch(id, identities, &abort);
    }

    /// A thread's model context (`session.messages`), read from the store; a thread need not be
    /// loaded.
    pub fn model_context(&self, id: &ThreadId) -> super::run::ModelContext {
        super::run::ModelContext {
            store: self.inner.deps.store.clone(),
            sensitive: self.inner.deps.sensitive.clone(),
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
        deps.store.unheld().await;
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
        deps.store.unheld().await;
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

    /// The members named in `fields` of a loaded thread's live header, which is not copied; `None` for a thread that is
    /// not loaded.
    pub fn loaded_fields(&self, id: &ThreadId, fields: &'static [&'static str]) -> Option<mixdog_store::schema::record::Header> {
        self.inner.loaded(id).map(|handle| keep_fields(handle.cell.header.load_full().as_ref(), Some(fields)))
    }

    /// [`stored_header`](Self::stored_header) holding only the members named in `fields`.
    pub async fn stored_fields(&self, id: &ThreadId, fields: &'static [&'static str]) -> Option<mixdog_store::schema::record::Header> {
        self.inner.stored_fields(id, fields).await
    }

    /// The header a listing reads of a session it does not open: what an open would have read, without loading the session.
    pub async fn listed_header(&self, id: &ThreadId) -> Option<mixdog_store::schema::record::Header> {
        self.inner.listed_header(id, None).await
    }

    /// [`listed_header`](Self::listed_header) holding only the members named in `fields`.
    pub async fn listed_fields(&self, id: &ThreadId, fields: &'static [&'static str]) -> Option<mixdog_store::schema::record::Header> {
        self.inner.listed_header(id, Some(fields)).await
    }

    /// [`listed_fields`](Self::listed_fields) of every session of a listing, in order.
    pub async fn listed_fields_of(&self, ids: &[ThreadId], fields: &'static [&'static str]) -> Vec<Option<mixdog_store::schema::record::Header>> {
        self.inner.listed_headers(ids, Some(fields)).await
    }

    /// [`stored_header`](Self::stored_header) for a decision that must tell "no such session"
    /// (`Ok(None)`) from "the read never ran" (`Err`): a session whose record could not be read
    /// is not a deleted one.
    pub async fn try_stored_header(&self, id: &ThreadId) -> Result<Option<mixdog_store::schema::record::Header>, CoreError> {
        self.inner.try_stored_header(id).await
    }

    /// What is known of a stored session (`storedSessionPresence`): `Some(true)` present, `Some(false)` known to be gone
    /// (`threadNotFound`), `None` when its record could not be read or the read never ran — never proof it is gone.
    pub async fn stored_presence(&self, id: &ThreadId) -> Option<bool> {
        if self.inner.loaded(id).is_some() {
            return Some(true);
        }
        let (store, thread) = (self.inner.deps.store.clone(), id.clone());
        match mixdog_core_base::support::on_lane(self.inner.deps.lanes.io, &CancellationToken::new(), move |lane| store.read_header(lane, &thread)).await {
            Ok(Ok(_)) => Some(true),
            Ok(Err(CoreError::ThreadNotFound { .. })) => Some(false),
            _ => None,
        }
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
        let judged = self.deps().archive.snapshot().entry(mixdog_js::js_trim(id));
        self.delete_stored_judged(id, activity, peers, cancel, judged).await
    }

    /// [`delete_stored`](Self::delete_stored) admitted against the archive entry the caller judged (`judged`, none for a state
    /// only a header gave): held from before the close to the end of the delete, so a restore committed since refuses it and one
    /// after it fails whole ([`mixdog_store::archive_state::ArchiveStates::claim_delete`]).
    pub async fn delete_stored_judged(
        &self,
        id: &str,
        activity: f64,
        peers: &[(String, f64)],
        cancel: &CancellationToken,
        judged: Option<mixdog_store::archive_state::ArchiveEntry>,
    ) -> Result<bool, CoreError> {
        let peers = peers.iter().map(|(peer, at)| (ThreadId::from(peer.as_str()), *at)).collect();
        let guard = super::control::DeleteGuard { activity, cancel: cancel.clone(), peers, opens: 0 };
        super::delete::delete_session(&self.inner, id, Some((guard, judged))).await
    }

    /// `markSessionClosed(id, 'idle-sweep')` for a session not open in this process: `true` once
    /// its tombstone landed. Admitted exactly as [`delete_stored`](Self::delete_stored) is (see
    /// `close::close_idle`); any refusal is `false`.
    pub async fn close_stored(&self, id: &str, activity: f64, cancel: &CancellationToken) -> Result<bool, CoreError> {
        let guard = super::control::DeleteGuard { activity, cancel: cancel.clone(), peers: Vec::new(), opens: 0 };
        super::close::close_idle(&self.inner, id, guard).await
    }

    /// The live control threads, what the config's adoption keeps synced: a control start from before its route is first
    /// resolved ([`Starting`]), and a loaded thread whose `session` record names it the control session
    /// ([`SessionHandle::control`]) while it takes work. A thread whose actor ended, that was closed, deleted or unloaded, or
    /// whose create failed, has no slot or a closed cell.
    pub fn control_ids(&self) -> Vec<ThreadId> {
        self.controls().into_iter().map(|(id, _)| id).collect()
    }

    /// Holds the next adoption between its listing and its writes ([`DirInner::adoption_gate`]).
    #[cfg(any(test, feature = "test-support"))]
    #[cfg_attr(not(test), allow(dead_code, reason = "used by this crate's unit tests; compiled for test-support so the hooks around it behave as in a test build"))]
    pub(super) fn gate_adoption(&self, arrived: Arc<tokio::sync::Notify>, go: std::sync::mpsc::Receiver<()>) {
        *lock(&self.inner.adoption_gate) = Some((arrived, go));
    }

    /// [`Self::control_ids`] with each one's [`Liveness`].
    fn controls(&self) -> Vec<(ThreadId, Arc<Liveness>)> {
        self.inner
            .shards
            .iter()
            .flat_map(|shard| {
                lock(shard)
                    .iter()
                    .filter_map(|(id, slot)| match slot {
                        Slot_::Starting(mark) => Some((id.clone(), mark.clone())),
                        Slot_::Loaded(handle) if handle.control && !handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst) => {
                            Some((id.clone(), handle.cell.liveness.clone()))
                        }
                        Slot_::Loaded(_) | Slot_::Loading(_) => None,
                    })
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    /// Lets go of a loaded thread that nothing watches or runs, now rather than at its idle deadline (the deadline's own decision:
    /// a thread that is watched, working, busy or held by an archive preparation stays loaded). For a caller that loaded a thread
    /// only to read or change its record; resolves once the decision is made: the thread stays, or it has left the directory.
    pub async fn release(&self, id: &ThreadId) {
        let Some(handle) = self.handle(id) else { return };
        let (ack, decided) = tokio::sync::oneshot::channel();
        if handle.inbox.send(super::actor::Inbox::IdleRelease(ack)).await.is_ok() {
            // An actor that ended dropped the answer: it is gone.
            let _ = decided.await;
        }
    }

    /// The thread for an archive preparation: loaded, else opened for it (not for use: no tool surface, no route); `None` when
    /// there is no such thread. `.1`: this call loaded it.
    pub(crate) async fn retain(&self, id: &ThreadId) -> Result<Option<(Arc<SessionHandle>, bool)>, CoreError> {
        if let Some(handle) = self.handle(id) {
            return Ok(Some((handle, false)));
        }
        Ok(self.inner.delete_target(id).await?.map(|handle| (handle, true)))
    }

    /// How many creates have begun ([`DirInner::created`]).
    pub(crate) fn created_count(&self) -> u64 {
        self.inner.created.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The agent-only sessions this process created, under each owner or parent they name.
    pub(crate) fn created_links(&self) -> HashMap<String, Vec<String>> {
        lock(&self.inner.created_links).clone()
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

    /// Whether the thread is loaded and not closing: a thread closed, deleted or shut down is refused work.
    pub fn is_open(&self, id: &ThreadId) -> bool {
        self.inner.loaded(id).is_some_and(|handle| !handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst))
    }

    /// Replay-only (the core's `replay/storesSettled` control): the positions of every thread loaded now, taken here, without
    /// the actors — each one's durable records accepted ([`super::control::ControlCell::record_marks`]) and prompt-history
    /// appends pushed ([`super::control::ControlCell::prompt_marks`]). [`DurabilitySettling::wait`] then waits for each to be
    /// committed: what is accepted later neither holds nor hastens it, and a thread loaded later is not asked.
    #[cfg(any(test, feature = "test-support"))]
    pub fn durability_settled(&self) -> DurabilitySettling {
        let threads = self
            .loaded_handles()
            .into_iter()
            .map(|handle| {
                let cell = &handle.cell;
                let marks = [cell.record_marks.clone(), cell.prompt_marks.clone()].map(|marks| {
                    let mark = marks.accepted();
                    (marks, mark)
                });
                (handle.id.clone(), marks)
            })
            .collect();
        DurabilitySettling { threads }
    }

    /// Whether a thread is being created now (`getSessionCreatePromise()`).
    pub fn creating(&self) -> bool {
        self.inner.creating.load(std::sync::atomic::Ordering::SeqCst) > 0
    }

    /// `createCurrentSession` for a thread that has none yet (a control session started before any model was chosen): the
    /// route it holds is readied and seated on its record, as a started task's is. This is what every Node trigger of a
    /// session does - a turn, a goal, `selectBranch` and a provisioning `requestWorktree`, an inherit into the thread - and
    /// the route change that only moves the route is none. A thread that has its session, or is not there, is left alone;
    /// a route that names no model is refused as `prepareRoute` refuses it (the start, which Node's reservation catches,
    /// is the one place that takes it as it is).
    pub(super) async fn seat_session(&self, id: &ThreadId) -> Result<(), CoreError> {
        if self.try_stored_header(id).await?.is_none() || self.holds_session(id).await? {
            return Ok(());
        }
        let refused = |message: String| mixdog_core_base::support::failed("route", message);
        let routes = &self.inner.deps.new_route;
        routes.adopt(id, None).await.map_err(refused)?;
        routes.seat(id).await.map_err(refused)
    }

    /// The thread's committed messages hold a user conversation message (`hasUserConversationMessage(session.messages)`): a
    /// turn that has settled leaves nothing in the live turn, so only the stored rows tell an idle session's conversation.
    pub async fn holds_user_conversation(&self, id: &ThreadId) -> Result<bool, CoreError> {
        Ok(super::route_session::has_user_conversation(&self.committed_rows(id).await?))
    }

    /// The thread holds conversation messages, committed or in the running turn (`session-view.mjs`).
    pub async fn holds_conversation(&self, id: &ThreadId) -> Result<bool, CoreError> {
        let mut rows = self.committed_rows(id).await?;
        if let Some(handle) = self.handle(id) {
            rows.extend(handle.turn_messages_snapshot().iter().cloned());
        }
        Ok(super::thread_settings::has_conversation_messages(&rows))
    }

    async fn committed_rows(&self, id: &ThreadId) -> Result<Vec<Value>, CoreError> {
        Ok(self.model_context(id).read().await?.into_iter().map(|(_, body)| body).collect())
    }

    /// Whether the stored thread has its session (`getSession()?.id`).
    pub(super) async fn holds_session(&self, id: &ThreadId) -> Result<bool, CoreError> {
        let Some(header) = self.try_stored_header(id).await? else { return Ok(false) };
        let rows = if mixdog_core_ports::ports::route::header_names_session(&header) { Vec::new() } else { self.rows_of(id.as_str()).await? };
        Ok(mixdog_core_ports::ports::route::has_session(&header, &rows))
    }

    /// Creates the thread under a fixed `id` with `header` as its first durable write, unseeded: the
    /// header is the record as it is, with no tool surface, prompt identity or MCP scope added.
    pub async fn create_with_id(&self, id: ThreadId, header: Header, params: Value) -> Result<(), CoreError> {
        self.inner
            .create(CreateSpec {
                id: Some(id),
                header,
                base: None,
                op: None,
                op_audience: None,
                method: Method("thread/start"),
                params,
                seed: None,
                settings: None,
                starting: None,
            })
            .await
            .map(|_| ())
    }

    /// [`create_with_id`](Self::create_with_id) over a `header` carrying a session's options (`session_options::write_header`):
    /// a home or room session is a Node `createSession` too, so it begins with its tool surface seeded, as `thread/start`'s.
    /// A header that names its route (a task session, a heartbeat run) boots the thread's live route on it first, so the
    /// seed composes for it, as Node boots the session's runtime with its creator's route (`createRuntime`).
    pub async fn create_seeded_with_id(&self, id: ThreadId, header: Header, params: Value) -> Result<(), CoreError> {
        self.inner.deps.new_route.boot(&id, &header);
        let seeded = super::seams::SeededThread::new(self.inner.deps.new_tools.clone(), id.clone());
        let header = self
            .inner
            .deps
            .new_tools
            .seed(&id, &header)
            .await
            .map_err(|message| mixdog_core_base::support::failed("session", format!("session: tools: {message}")))?;
        self.inner
            .create(CreateSpec {
                id: Some(id),
                header,
                base: None,
                op: None,
                op_audience: None,
                method: Method("thread/start"),
                params,
                seed: Some(seeded),
                settings: None,
                starting: None,
            })
            .await
            .map(|_| ())
    }

    /// [`create_session`](Self::create_session) for an agent-owned session (a delegated worker, `createAgentChild`): its
    /// header begins with the tool surface and prompt identity Node's `createSession` gives it
    /// (`NewThreadTools::seed_agent`), so its first turn composes its prompt and sends its tools. Without them the
    /// worker's requests carried no system prompt and no tools.
    pub async fn create_agent_session(&self, header: Header, params: Value) -> Result<ThreadId, CoreError> {
        let id = self.inner.mint_session_id();
        // Its runtime is booted with the agent's route (`createAgentChild`'s `createSession({ provider, model, … })`).
        self.inner.deps.new_route.boot(&id, &header);
        let header = self
            .inner
            .deps
            .new_tools
            .seed_agent(&id, &header)
            .await
            .map_err(|message| mixdog_core_base::support::failed("session", format!("session: tools: {message}")))?;
        let spec = CreateSpec { id: Some(id), header, base: None, op: None, op_audience: None, method: Method("thread/start"), params, seed: None, settings: None, starting: None };
        self.inner.create(spec).await.map(|handle| handle.id.clone())
    }

    /// Creates a thread under a minted id with `header` as its first durable write (an internal
    /// `createSession`: nobody subscribes to it). The session service's `createSession` boots a runtime of the
    /// session's own, so the thread is seeded as [`create_seeded_with_id`](Self::create_seeded_with_id) seeds it: its
    /// tool surface, its prompt identity and an MCP scope of its own, which its close or delete releases.
    pub async fn create_session(&self, header: Header, params: Value) -> Result<ThreadId, CoreError> {
        let id = self.inner.mint_session_id();
        self.create_seeded_with_id(id.clone(), header, params).await?;
        Ok(id)
    }

    /// [`create_session`](Self::create_session) for an imported conversation (`createImportedSession`): Node makes it with
    /// the manager's `createSession`, so its header begins with the tool surface and prompt a new thread's does
    /// (`NewThreadTools::seed_imported`), in no MCP scope of its own: nothing is abandoned with it. Without them its turns
    /// carried no system prompt and no tools.
    pub async fn create_imported_session(&self, header: Header, params: Value) -> Result<ThreadId, CoreError> {
        let id = self.inner.mint_session_id();
        // Node's `createSession` boots the imported session's runtime on the route its options name.
        self.inner.deps.new_route.boot(&id, &header);
        let header = self
            .inner
            .deps
            .new_tools
            .seed_imported(&id, &header)
            .await
            .map_err(|message| mixdog_core_base::support::failed("session", format!("session: tools: {message}")))?;
        self.create_with_id(id.clone(), header, params).await?;
        Ok(id)
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

    /// Binds the threads that are listed before they are there; once.
    pub fn set_arriving(&self, arriving: Arc<dyn ArrivingThreads>) -> Result<(), &'static str> {
        self.inner.arriving.set(arriving).map_err(|_| "the arriving threads are already bound")
    }

    /// Binds what a runtime's teardown does to its own session; once.
    pub fn set_exit_close(&self, hook: Arc<dyn ExitClose>) -> Result<(), &'static str> {
        self.inner.exit_close.set(hook).map_err(|_| "the exit close is already bound")
    }

    /// Binds where a thread's moved live facts (its turn, the approval it shows) republish its roster row; once.
    pub fn set_live_rows(&self, rows: Arc<super::thread_edges::LiveRows>) -> Result<(), &'static str> {
        self.inner.live_rows.set(rows).map_err(|_| "the live rows are already bound")
    }

    /// Reconciles a single-thread restore made outside the public `thread/unarchive` operation.
    pub async fn publish_restored_row(&self, thread: &ThreadId) {
        if let Some(rows) = self.inner.live_rows.get() {
            rows.restored(thread).await;
        }
    }

    /// A stop was requested: the new-task attempts in flight end now, each as Node's attempt ends at the call it was awaiting when its
    /// host is disposed ([`super::new_task::NewTaskReceipts::cut`]); [`Self::shutdown_for`] later waits for the writes they began.
    pub fn cut_new_tasks(&self) {
        self.inner.deps.new_tasks.cut();
    }

    /// [`Self::shutdown_for`] with the reason of a daemon stop.
    pub async fn shutdown(&self) {
        self.shutdown_for("daemon shutdown").await;
    }

    /// Core shutdown (today's `teardown.mjs:192`): first, as each runtime's `close(reason)` does
    /// when the reason is a process exit (`teardown.mjs:226-237`), every loaded session's agents
    /// are closed (`OwnerTeardown`, bounded at `CLOSE_ALL_DEADLINE_MS`, 5000 ms, per session);
    /// then every loaded thread is closed as its runtime's own session ([`ExitClose`]); then every loaded thread stops (a live run is cancelled) and its memory ingest is awaited,
    /// all of them together bounded at 2500 ms. Before all of it, the new-task attempts in flight are cut ([`super::new_task::NewTaskReceipts::shutdown`]).
    pub async fn shutdown_for(&self, reason: &str) {
        // The new-task attempts in flight are cut first, as a process ending leaves them, before the directory refuses their
        // next step (a refusal would mark their receipts refused).
        // Under Node's shutdown budget, within which its session service stop awaits the call a cut attempt awaits and the attempt
        // then ends: a call or receipt write that outlives it cannot hold the rest of the teardown.
        if let Err(overrun) = self.inner.deps.new_tasks.shutdown(NEW_TASK_SHUTDOWN_BOUND).await {
            tracing::error!(%overrun, "the new-task receipts did not shut down in time");
        }
        self.begin_close();
        if is_process_exit_reason(reason)
            && let Some(hook) = self.inner.owner_teardown.get()
        {
            // All owners together, each under its own deadline: Node's per-session 5 s bound, which one after another let a quit with many sessions
            // loaded outlast the launcher's wait before the agents of the last ones were finalised.
            futures::future::join_all(self.loaded_ids().into_iter().map(|owner| async move {
                if mixdog_rt::time::timeout(CLOSE_ALL_DEADLINE, hook.teardown(&owner, reason)).await.is_err() {
                    tracing::warn!(owner = owner.as_str(), "agent teardown overran its deadline");
                }
            }))
            .await;
        }
        // Teardown's `closeOwnSession` (`teardown.mjs:258`), after the agents' close and for any reason: each runtime's
        // own session is closed with the stop's reason before the runtime stops.
        if let Some(hook) = self.inner.exit_close.get() {
            futures::future::join_all(self.loaded_ids().into_iter().map(|owner| async move {
                if mixdog_rt::time::timeout(CLOSE_ALL_DEADLINE, hook.close_on_exit(&owner, reason)).await.is_err() {
                    tracing::warn!(owner = owner.as_str(), "the session close at exit overran its deadline");
                }
            }))
            .await;
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
                        // The start's create is refused from here (`ThreadClosing`): it ends now.
                        Slot_::Starting(mark) => {
                            *mark.ending() = true;
                            None
                        }
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
        let pending: Vec<_> = lock(&self.inner.teardowns).values().cloned().collect();
        wait_without_cancelling(SHUTDOWN_INGEST_DEADLINE, async move {
            let loaded = futures::future::join_all(ingests.into_iter().map(|ingest| async move {
                if let Ok(ingest) = ingest.await {
                    ingest.await;
                }
            }));
            let unloaded = futures::future::join_all(pending.into_iter().map(|mut finished| async move {
                let _ = finished.changed().await;
            }));
            futures::join!(loaded, unloaded);
        })
        .await;
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
