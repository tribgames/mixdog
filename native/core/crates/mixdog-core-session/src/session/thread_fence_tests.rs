use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;
use super::testing::awaiting;
use super::testing::lock;
use super::tests::caught_up;
use super::tests::echo;
use super::tests::start_thread;

/// A rig whose catalog lists every thread: a delete closes only a session the catalog lists (`isAvailableSession`).
fn rig() -> Rig {
    let rig = Rig::new();
    rig.store.listed.store(true, std::sync::atomic::Ordering::SeqCst);
    rig
}

pub(super) fn client() -> CallContext {
    CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, CancellationToken::new())
}

pub(super) fn request(method: &'static str, params: Value) -> CoreRequest {
    let op = params.get("opId").and_then(Value::as_str).map(OpId::from);
    CoreRequest { method: Method(method), params, op, ctx: client() }
}

/// The thread's open, `thread/resume` and the attach of its subscription, as a client resumes it: the id the thread
/// answers, or the refusal. The attach `FeedSource::attach` makes is refused (`threadClosing`) once a close has closed
/// the thread's cell; the cell's `closed` flag is that refusal read without attaching, so the probe leaves no subscriber.
async fn resume(directory: &SessionDirectory, id: &str) -> Result<String, CoreError> {
    let thread = ThreadId::from(id);
    let handle = directory.open_handle(&thread, &client()).await?;
    let answered = match handle.request(request("thread/resume", json!({ "threadId": id, "window": { "lastItems": 10 } }))).await? {
        Reply::Subscribe(subscribe) => subscribe.result["thread"]["id"].as_str().expect("the thread id").to_owned(),
        Reply::Value(_) => panic!("thread/resume subscribes"),
    };
    if handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(CoreError::ThreadClosing { thread_id: thread });
    }
    Ok(answered)
}

/// A directory over the real thread store in a scratch data folder: a delete removes the thread, so its open after the
/// close answers that it is not there. Fields drop in order: the directory before the databases and their folder.
pub(super) struct Real {
    pub(super) directory: Arc<SessionDirectory>,
    pub(super) rig: Rig,
    pub(super) index: mixdog_store::sqlite::SqliteStore,
    mark: Arc<MarkHold>,
    _data: super::testing::DataDir,
}

/// Each durable write of a delete mark asks `plan` whether it fails (rolled back, nothing applied: a log that cannot be written
/// to) and is logged in `seen` with the answer.
#[derive(Default)]
pub(super) struct MarkFail {
    pub(super) plan: std::sync::Mutex<Option<Box<dyn FnMut(&str) -> bool + Send>>>,
    pub(super) seen: std::sync::Mutex<Vec<(String, bool)>>,
}

/// When armed, the next durable commit carrying the delete mark tells `.0` it was reached and waits for `.1` before it writes:
/// the close between its fence and the durable close.
type MarkHold = std::sync::Mutex<Option<(Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>;

/// The real store, its session logs holding a commit while [`MarkHold`] is armed.
struct HeldStore {
    store: Arc<dyn super::ThreadStore>,
    mark: Arc<MarkHold>,
    marks: Arc<MarkFail>,
}

struct HeldLog {
    log: Box<dyn super::seams::SessionLog>,
    id: ThreadId,
    mark: Arc<MarkHold>,
    marks: Arc<MarkFail>,
}

impl super::seams::SessionLog for HeldLog {
    fn commit(
        &mut self,
        lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
        batch: &[super::seams::CommitRecord],
    ) -> Result<Vec<u64>, super::seams::BarrierError> {
        use mixdog_store::schema::record::{MetaRecord, Record};
        let marks = batch.iter().any(|commit| {
            matches!(&*commit.record, Record::Meta(MetaRecord { change: mixdog_store::schema::blob::Slot::Inline(change), .. })
                if change.set.contains_key(mixdog_store::summary::DELETED))
        });
        let held = if marks { lock(&self.mark).take() } else { None };
        if let Some((reached, release)) = held {
            reached.notify_one();
            let wait = move || release.recv().expect("the mark released");
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::task::block_in_place(wait);
            } else {
                wait();
            }
        }
        if marks {
            let fails = lock(&self.marks.plan).as_mut().is_some_and(|plan| plan(self.id.as_str()));
            lock(&self.marks.seen).push((self.id.as_str().to_owned(), fails));
            if fails {
                return Err(super::seams::BarrierError::failed("EACCES"));
            }
        }
        self.log.commit(lane, batch)
    }

    fn retry(&mut self, lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>) -> Result<(), super::seams::BarrierError> {
        self.log.retry(lane)
    }
}

impl super::ThreadStore for HeldStore {
    fn read_head(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<super::seams::HeadRead, CoreError> {
        self.store.read_head(lane, id)
    }
    fn read_header(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<mixdog_store::schema::record::Header, CoreError> {
        self.store.read_header(lane, id)
    }
    fn read_log_id(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<String, CoreError> {
        self.store.read_log_id(lane, id)
    }
    fn read_window(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>,
        id: &ThreadId,
        head: &super::seams::HeadRead,
    ) -> Result<super::seams::WindowRead, CoreError> {
        self.store.read_window(lane, id, head)
    }
    fn decode(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>,
        id: &ThreadId,
        head: super::seams::HeadRead,
        window: super::seams::WindowRead,
    ) -> Result<super::seams::OpenedLog, CoreError> {
        self.store.decode(lane, id, head, window)
    }
    fn user_rows(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<Vec<mixdog_store::schema::record::ItemRecord>, CoreError> {
        self.store.user_rows(lane, id)
    }
    fn history_rows(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>,
        id: &ThreadId,
    ) -> Result<(u64, Vec<mixdog_store::schema::record::ItemRecord>), CoreError> {
        self.store.history_rows(lane, id)
    }
    fn thread_op(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<super::seams::StoredOp>, CoreError> {
        self.store.thread_op(lane, id, op)
    }
    fn committed_op(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<super::seams::StoredOp>, CoreError> {
        self.store.committed_op(lane, id, op)
    }
    fn fenced_ops(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError> {
        self.store.fenced_ops(lane, id)
    }
    fn history_row(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<(u64, mixdog_store::schema::record::ItemRecord)>, CoreError> {
        self.store.history_row(lane, id, iid)
    }
    fn rewind_targets(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>,
        id: &ThreadId,
        before: Option<u64>,
        limit: usize,
    ) -> Result<(u64, Vec<mixdog_store::sqlite::rewind::RewindTarget>), CoreError> {
        self.store.rewind_targets(lane, id, before, limit)
    }
    fn rewind_target(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>,
        id: &ThreadId,
        shown: &str,
    ) -> Result<Option<crate::session::seams::StoredRewind>, CoreError> {
        self.store.rewind_target(lane, id, shown)
    }
    fn compaction_entry(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        self.store.compaction_entry(lane, id, iid)
    }
    fn context_io(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>,
        id: &ThreadId,
        read: Option<super::seams::ContextRead>,
    ) -> Result<super::seams::ContextRead, CoreError> {
        self.store.context_io(lane, id, read)
    }
    fn context_len(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<usize, CoreError> {
        self.store.context_len(lane, id)
    }
    fn context_from_io(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, skip: usize) -> Result<super::seams::ContextRead, CoreError> {
        self.store.context_from_io(lane, id, skip)
    }
    fn session_meta(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<Option<super::seams::SessionMeta>, CoreError>> {
        self.store.session_meta(id)
    }
    fn archived_agent_parents(&self, child: &ThreadId) -> futures::future::BoxFuture<'static, Result<Vec<ThreadId>, CoreError>> {
        self.store.archived_agent_parents(child)
    }
    fn copies_of(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<super::seams::OffloadCopies, CoreError>> {
        self.store.copies_of(id)
    }
    fn record_offload_scan(&self, session: &str, ordinal: i64, sources: Vec<String>) -> futures::future::BoxFuture<'static, Result<(), CoreError>> {
        self.store.record_offload_scan(session, ordinal, sources)
    }
    fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>> {
        self.store.purge_deleted()
    }
    fn context_cpu(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>,
        read: super::seams::ContextRead,
    ) -> Result<super::seams::ContextStep, CoreError> {
        self.store.context_cpu(lane, read)
    }
    fn open_log(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
        id: &ThreadId,
        at: super::seams::AppendPosition,
    ) -> Result<Box<dyn super::seams::SessionLog>, super::seams::BarrierError> {
        let log = self.store.open_log(lane, id, at)?;
        Ok(Box::new(HeldLog { log, id: id.clone(), mark: self.mark.clone(), marks: self.marks.clone() }))
    }
    fn create_log(
        &self,
        lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>,
        id: &ThreadId,
        session: &super::seams::CommitRecord,
    ) -> Result<(Box<dyn super::seams::SessionLog>, u64), super::seams::BarrierError> {
        let (log, ordinal) = self.store.create_log(lane, id, session)?;
        Ok((Box::new(HeldLog { log, id: id.clone(), mark: self.mark.clone(), marks: self.marks.clone() }), ordinal))
    }
    fn draft_write(&self, lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>, id: &ThreadId, write: &super::turn_draft::DraftWrite) -> Result<(), CoreError> {
        self.store.draft_write(lane, id, write)
    }
}

/// A thread whose delete is held at its mark: the close has fenced the thread and its durable write has not landed.
pub(super) struct HeldMark {
    release: std::sync::mpsc::Sender<()>,
    delete: tokio::task::JoinHandle<Result<Reply, CoreError>>,
}

pub(super) async fn begin_close(real: &Real, id: &ThreadId) -> HeldMark {
    let (reached, (release, held)) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel());
    *lock(&real.mark) = Some((reached.clone(), held));
    let handle = real.directory.handle(id).expect("loaded");
    let params = json!({ "threadId": id, "opId": "op-close" });
    let delete = tokio::spawn(async move { handle.request(request("thread/delete", params)).await });
    awaiting(|| "the close to reach its mark".to_owned(), reached.notified()).await;
    HeldMark { release, delete }
}

impl HeldMark {
    pub(super) async fn finish(self) -> bool {
        self.release.send(()).expect("the mark is held");
        let reply = awaiting(|| "the close to finish".to_owned(), self.delete).await.expect("the delete task").expect("thread/delete");
        matches!(reply, Reply::Value(Value::Bool(true)))
    }
}

pub(super) async fn real() -> Real {
    use mixdog_core_api::domain::mock::MockOwnership;
    use mixdog_store::sqlite::SqliteStore;
    let data = super::testing::DataDir::default();
    let tokens = mixdog_rt::testing::tokens();
    let root = data.path().to_path_buf();
    let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &CancellationToken::new(), move |lane| {
        SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
    })
    .expect("lane")
    .await
    .expect("job ran")
    .expect("index");
    let index = data.index(index);
    let threads = Arc::new(
        super::StoreThreads::over_data_dir(data.path(), index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io)
            .await
            .expect("the thread store"),
    );
    let store: Arc<dyn super::ThreadStore> = threads.clone();
    let mark = Arc::new(MarkHold::default());
    let marks = Arc::new(MarkFail::default());
    let rig = Rig::new();
    rig.set_script(echo());
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(Arc::new(HeldStore { store, mark: mark.clone(), marks: marks.clone() }))));
    Real { directory, rig, index, mark, _data: data }
}

/// A thread whose first turn landed, so the catalog lists it (a close acts on a listed session, `isAvailableSession`),
/// settled: no turn runs and nothing is queued.
async fn listed_thread(real: &Real) -> ThreadId {
    let handle = start_thread(&real.directory).await;
    super::tests::turn(&handle, "hello", "op-1").await;
    let id = handle.id.clone();
    let index = real.index.clone();
    crate::eventually_on!(&[&handle.cell.stepped], || {
        (super::tests::idle(&handle) && futures::executor::block_on(index.summary(id.as_str())).expect("summary").is_some()).then_some(())
    })
    .await;
    id
}

/// A client's delete: each call its own op, as a client issues a new op per request.
pub(super) async fn delete(directory: &SessionDirectory, id: &str) -> Result<bool, CoreError> {
    static OPS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let op = format!("op-delete-{}", OPS.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
    let reply = directory.request(request("thread/delete", json!({ "threadId": id, "opId": op }))).await?;
    Ok(matches!(reply, Reply::Value(Value::Bool(true))))
}

/// What a completion reached: the thread's queue entries and the turns it started, once its actor took it.
struct Seen {
    queued: usize,
    turns: usize,
    cards: usize,
}

async fn seen(rig: &Rig, directory: &SessionDirectory, id: &ThreadId) -> Seen {
    if let Some(handle) = directory.handle(id) {
        caught_up(&handle).await;
    }
    let frames = rig.feeds.frames(id.as_str());
    Seen {
        queued: directory.handle(id).map_or(0, |handle| handle.cell.queued.load().len()),
        turns: frames.iter().filter(|(_, method, _)| method == "turn/started").count(),
        cards: frames.iter().filter(|(_, method, _)| method == "item/completed").count(),
    }
}

async fn finished(directory: &SessionDirectory, id: &ThreadId, execution: &str, text: &str) {
    mixdog_tools::exec::TaskNotifier::finished(directory, id, "shell", execution, "cancelled", text.to_owned()).await;
}

const COMPLETION: &str = "<task-notification><task-id>shell_1</task-id><status>cancelled</status></task-notification>";

/// What a client sees of admission to the thread: the thread opens (`open`), is refused while its close runs (`closing`) or is
/// gone (`terminal`).
async fn admission(directory: &SessionDirectory, id: &str) -> &'static str {
    match resume(directory, id).await {
        Ok(_) => "open",
        Err(CoreError::ThreadClosing { .. }) => "closing",
        Err(CoreError::ThreadNotFound { .. }) => "terminal",
        Err(error) => panic!("the thread's open answered {error:?}"),
    }
}

/// The thread a client opens answers as itself every time; another id is another thread (refused when there is none), and a
/// new session is a new thread, never this one re-keyed.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_thread_answers_as_itself_and_is_never_re_keyed() {
    let rig = rig();
    let directory = SessionDirectory::new(rig.deps());
    let a = start_thread(&directory).await.id.as_str().to_owned();
    for _ in 0..3 {
        assert_eq!(resume(&directory, &a).await.expect("the thread resumes"), a);
    }
    assert!(resume(&directory, "sess_b").await.is_err(), "another id is no thread here");
    let other = start_thread(&directory).await.id.as_str().to_owned();
    assert_ne!(other, a, "a new session is another thread");
    assert_eq!(resume(&directory, &a).await.expect("still itself"), a);
}

/// A close fences the thread while it runs (its open is refused), lands durably and leaves the thread terminal; a second
/// close changes nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_close_fences_first_and_leaves_the_thread_terminal() {
    let real = real().await;
    let directory = &real.directory;
    let id = listed_thread(&real).await;
    let a = id.as_str().to_owned();
    assert_eq!(admission(directory, &a).await, "open");
    let held = begin_close(&real, &id).await;
    assert_eq!(admission(directory, &a).await, "closing", "the admission while the close runs");
    assert!(held.finish().await, "the close lands");
    assert_eq!(admission(directory, &a).await, "terminal");
    assert!(matches!(resume(directory, &a).await, Err(CoreError::ThreadNotFound { .. })));
    assert!(!delete(directory, &a).await.unwrap_or(false), "a thread already gone is not closed again");
    assert_eq!(admission(directory, &a).await, "terminal");
}

/// A close whose durable write fails leaves the thread open and in place.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_close_restores_admission_and_keeps_the_thread() {
    let rig = rig();
    let directory = SessionDirectory::new(rig.deps());
    let a = start_thread(&directory).await.id.as_str().to_owned();
    for _ in 0..2 {
        rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(!delete(&directory, &a).await.unwrap_or(false), "the close failed");
        assert_eq!(resume(&directory, &a).await.expect("the thread is kept"), a);
        assert_eq!(admission(&directory, &a).await, "open");
    }
}

/// A completion reaches the open thread's client as its card; once the thread is closing, and once it is closed, a completion
/// is neither queued nor wakes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_owner_never_queues_or_wakes_a_completion() {
    let real = real().await;
    let (rig, directory) = (&real.rig, &real.directory);
    let id = listed_thread(&real).await;
    let before = seen(rig, directory, &id).await;
    // The card shows once its record is stored: a row of no turn, unlike the rows of the turn the completion wakes.
    let turnless = |frames: &[(u64, String, Value)]| {
        frames.iter().filter(|(_, method, params)| method == "item/completed" && params["turnId"].as_str().is_none_or(str::is_empty)).count()
    };
    let before_cards = turnless(&rig.feeds.frames(id.as_str()));
    finished(directory, &id, "shell_1", COMPLETION).await;
    let handle = directory.handle(&id).expect("loaded");
    crate::eventually_on!(&[&handle.cell.stepped], || (turnless(&rig.feeds.frames(id.as_str())) > before_cards).then_some(())).await;
    assert_eq!(turnless(&rig.feeds.frames(id.as_str())) - before_cards, 1, "the open thread's client sees the completion");
    // The completion wakes a turn once its queue entry is durable: settled when that turn started and ended.
    let woke = || rig.feeds.frames(id.as_str()).iter().filter(|(_, method, _)| method == "turn/started").count() > before.turns;
    crate::eventually_on!(&[&handle.cell.stepped], || (woke() && super::tests::idle(&handle) && handle.cell.queued.load().is_empty()).then_some(())).await;
    drop(handle);
    let base = seen(rig, directory, &id).await;
    let nothing_new = |now: &Seen| now.queued <= base.queued && now.turns == base.turns && now.cards == base.cards;

    let held = begin_close(&real, &id).await;
    finished(directory, &id, "shell_2", COMPLETION).await;
    assert!(nothing_new(&seen(rig, directory, &id).await), "a closing thread takes no completion");
    assert!(held.finish().await);
    for execution in ["shell_3", "shell_4"] {
        finished(directory, &id, execution, COMPLETION).await;
        assert!(nothing_new(&seen(rig, directory, &id).await), "a closed thread takes no completion");
    }
}

/// A completion for an owner that is already closed is not delivered: nothing is queued and no turn starts.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_completion_for_a_closed_owner_is_not_delivered() {
    let real = real().await;
    let (rig, directory) = (&real.rig, &real.directory);
    let id = listed_thread(&real).await;
    assert!(delete(directory, id.as_str()).await.expect("thread/delete"));
    let base = seen(rig, directory, &id).await;
    finished(directory, &id, "shell_1", COMPLETION).await;
    let after = seen(rig, directory, &id).await;
    assert_eq!((after.queued, after.turns, after.cards), (base.queued, base.turns, base.cards));
}

/// An open thread admits work; once its close begins, its admission is refused as closing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_fenced_thread_refuses_admission() {
    let real = real().await;
    let directory = &real.directory;
    let id = listed_thread(&real).await;
    let a = id.as_str().to_owned();
    assert!(resume(directory, &a).await.is_ok());
    let held = begin_close(&real, &id).await;
    let refused = resume(directory, &a).await;
    assert!(matches!(refused, Err(CoreError::ThreadClosing { .. })), "the closing thread's open is refused as closing: {refused:?}");
    assert!(held.finish().await);
}

fn close_of(real: &Real) -> super::close::SessionClose {
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(super::testing::NoProviders)));
    super::close::SessionClose::new(real.directory.clone(), providers, Arc::new(super::testing::NoShells), Arc::new(mixdog_tools::fs::ReadState::new(None)))
}

type Stored = serde_json::Map<String, Value>;

async fn stored(real: &Real, id: &ThreadId) -> Stored {
    real.directory.stored_header(id).await.expect("the record is stored")
}

fn generation(header: &Stored) -> f64 {
    header.get("generation").and_then(Value::as_f64).unwrap_or(0.0)
}

fn at_clock(real: &Real, ms: u64) {
    real.rig.clock.0.store(ms as _, std::sync::atomic::Ordering::SeqCst);
}

/// A detach bumps the session's generation, stamps its time and records why; a second detach bumps again and replaces the reason.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_detach_bumps_the_generation_each_time_and_records_its_reason() {
    let real = real().await;
    let id = listed_thread(&real).await;
    let close = close_of(&real);
    let first = generation(&stored(&real, &id).await);
    at_clock(&real, 2000);
    assert!(close.detach(id.as_str(), "no live session clients", false).await);
    let once = stored(&real, &id).await;
    assert_eq!((generation(&once), &once["detachedReason"], &once["updatedAt"]), (first + 1.0, &json!("no live session clients"), &json!(2000)));
    assert_ne!(once.get("closed"), Some(&json!(true)), "a detach does not close");
    at_clock(&real, 3000);
    assert!(close.detach(id.as_str(), "SIGTERM", false).await);
    let twice = stored(&real, &id).await;
    assert_eq!((generation(&twice), &twice["detachedReason"], &twice["updatedAt"]), (first + 2.0, &json!("SIGTERM"), &json!(3000)));
}

/// A detach for the owner's own close also stamps when the owner closed it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_owner_close_detach_stamps_when_the_owner_closed_it() {
    let real = real().await;
    let id = listed_thread(&real).await;
    at_clock(&real, 2000);
    assert!(close_of(&real).detach(id.as_str(), "cli-agent-close", true).await);
    let header = stored(&real, &id).await;
    assert_eq!((&header["detachedReason"], &header["ownerClosedAt"]), (&json!("cli-agent-close"), &json!(2000)));
}

/// A close bumps the generation, marks the session closed with its reason and time; after a detach it bumps again; closing again
/// keeps the generation and the time and replaces the reason; a cancel's reason also records the cancellation.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_close_marks_the_session_closed_once_and_a_re_close_only_replaces_its_reason() {
    let real = real().await;
    let id = listed_thread(&real).await;
    let close = close_of(&real);
    let first = generation(&stored(&real, &id).await);
    at_clock(&real, 2000);
    assert!(close.detach(id.as_str(), "cli-exit", false).await);
    at_clock(&real, 3000);
    assert!(close.close(id.as_str(), "manual").await);
    let closed = stored(&real, &id).await;
    assert_eq!(generation(&closed), first + 2.0, "the detach and the close each bump");
    assert_eq!(
        (&closed["closed"], &closed["closedReason"], &closed["status"], &closed["updatedAt"]),
        (&json!(true), &json!("manual"), &json!("closed"), &json!(3000))
    );

    at_clock(&real, 4000);
    assert!(close.close(id.as_str(), "desktop-session-delete").await);
    let again = stored(&real, &id).await;
    assert_eq!((generation(&again), &again["closedReason"], &again["updatedAt"]), (first + 2.0, &json!("desktop-session-delete"), &json!(3000)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_for_an_agent_task_cancel_records_the_cancellation() {
    let real = real().await;
    let id = listed_thread(&real).await;
    at_clock(&real, 2000);
    assert!(close_of(&real).close(id.as_str(), "agent-task-cancel").await);
    let header = stored(&real, &id).await;
    assert_eq!((&header["closedReason"], &header["cancelStatus"], &header["cancelledAt"]), (&json!("agent-task-cancel"), &json!("cancelled"), &json!(2000)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_save_is_dropped_only_when_the_record_moved_past_the_ownership_it_was_issued_for() {
    #[derive(Clone, Copy)]
    enum State {
        Fresh,
        DetachedOnce,
        DetachedTwice,
        Closed,
    }
    use State::*;
    let rows: [(State, Option<i32>, &str); 19] = [
        (Fresh, None, "saved"),
        (Fresh, Some(0), "saved"),
        (Fresh, Some(1), "saved"),
        (DetachedOnce, None, "saved"),
        (DetachedOnce, Some(0), "dropped"),
        (DetachedOnce, Some(1), "saved"), // equal generations on an open record: not past
        (DetachedOnce, Some(2), "saved"),
        (DetachedTwice, None, "saved"),
        (DetachedTwice, Some(0), "dropped"),
        (DetachedTwice, Some(1), "dropped"),
        (DetachedTwice, Some(2), "saved"),
        (Closed, None, "saved"), // no generation: never dropped, even after a close
        (Closed, Some(0), "dropped"),
        (Closed, Some(1), "dropped"), // equal generations on a closed record: the tombstone is as new
        (Closed, Some(2), "saved"),
        (Fresh, Some(-1), "dropped"),
        (DetachedOnce, Some(3), "saved"),
        (Closed, Some(3), "saved"),
        (DetachedTwice, Some(3), "saved"),
    ];
    for (state, offset, want) in rows {
        let real = real().await;
        let id = listed_thread(&real).await;
        let close = close_of(&real);
        let first = generation(&stored(&real, &id).await);
        match state {
            Fresh => {}
            DetachedOnce => assert!(close.detach(id.as_str(), "detach 1", false).await),
            DetachedTwice => {
                assert!(close.detach(id.as_str(), "detach 1", false).await);
                assert!(close.detach(id.as_str(), "detach 2", false).await);
            }
            Closed => assert!(close.close(id.as_str(), "manual").await),
        }
        let expected = offset.map(|offset| first + f64::from(offset));
        let outcome = save_fenced(&real, &id, expected, [("late".to_owned(), json!(true))].into_iter().collect(), Vec::new()).await;
        assert_eq!(outcome, want, "{offset:?}");
        assert_eq!(stored(&real, &id).await.contains_key("late"), want == "saved", "{offset:?}: what the store holds");
    }
}

/// A save for a session that was deleted is dropped (`deleteSession(id, { fenceWrites: true })`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_save_for_a_deleted_session_is_dropped() {
    let real = real().await;
    let id = listed_thread(&real).await;
    assert!(delete(&real.directory, id.as_str()).await.expect("thread/delete"));
    for expected in [None, Some(0.0), Some(5.0)] {
        assert_eq!(save_fenced(&real, &id, expected, [("late".to_owned(), json!(true))].into_iter().collect(), Vec::new()).await, "dropped", "{expected:?}");
    }
}

/// A save issued for `expected` generation: the fenced header patch the delegation rebind sends.
async fn save_fenced(real: &Real, id: &ThreadId, expected: Option<f64>, set: Stored, unset: Vec<String>) -> &'static str {
    let threads = super::thread_state::SessionThreads::new(real.directory.clone());
    match threads.patch_header_fenced(id, expected, set, unset).await.expect("the save") {
        super::close::Saved::Written => "saved",
        super::close::Saved::Dropped => "dropped",
    }
}

/// A detach or close that comes after a delete answers true (no such session: nothing is left to do) and writes nothing back (the record is not recreated by a late
/// lifecycle write); a delete that comes after a detach removes the record all the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lifecycle_write_after_a_delete_finds_no_session_and_a_delete_after_a_detach_deletes() {
    let real = real().await;
    let close = close_of(&real);
    let detached_first = listed_thread(&real).await;
    assert!(close.detach(detached_first.as_str(), "cli-exit", false).await);
    assert!(delete(&real.directory, detached_first.as_str()).await.expect("thread/delete"), "a detached session is still deleted");
    assert!(real.directory.stored_header(&detached_first).await.is_none(), "and its record is gone");

    let deleted_first = listed_thread(&real).await;
    assert!(delete(&real.directory, deleted_first.as_str()).await.expect("thread/delete"));
    assert!(close.detach(deleted_first.as_str(), "cli-exit", false).await, "no such session: nothing is left to detach");
    assert!(close.close(deleted_first.as_str(), "manual").await, "no such session: nothing is left to close");
    assert!(real.directory.stored_header(&deleted_first).await.is_none(), "the late writes did not bring the record back");
}

/// "Allow for this session" lasts as long as its conversation: a close or a delete of the session ends its grants, and another session keeps its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_or_deleting_a_session_ends_its_session_grants_and_no_other() {
    let real = real().await;
    let close = close_of(&real);
    let grants = real.directory.deps().session_grants.clone();
    let tool = mixdog_tools::policy::GrantKey::tool("mcp__gmail__send_email").expect("a tool key");
    let (closed, deleted, kept) = (listed_thread(&real).await, listed_thread(&real).await, listed_thread(&real).await);
    for id in [&closed, &deleted, &kept] {
        assert!(grants.grant(id.as_str(), "bot", &tool, "life-1"));
    }
    assert!(close.close(closed.as_str(), "manual").await);
    assert!(!grants.has(closed.as_str(), "bot", &tool, "life-1"), "a closed session's grant is gone");
    assert!(delete(&real.directory, deleted.as_str()).await.expect("thread/delete"));
    assert!(!grants.has(deleted.as_str(), "bot", &tool, "life-1"), "a deleted session's grant is gone");
    assert_eq!(grants.held(closed.as_str()) + grants.held(deleted.as_str()), 0, "nothing of either stays in memory");
    assert!(grants.has(kept.as_str(), "bot", &tool, "life-1"), "another session keeps its own");
}
