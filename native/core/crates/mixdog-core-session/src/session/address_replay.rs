//! Node's recording `fixtures/session-address/recording.json` (`record-session-address.mjs`, test file
//! `src/session-runtime/session-address.test.mjs`), read when the test runs and decoded with [`Exact`]. Node's addressed
//! runtime owns one conversation id; the core has no per-process address: every request names its thread and the
//! directory routes it there. Each recorded step is played through the calls a client makes on a real directory —
//! `thread/start`, the thread's open and `thread/resume` (Node's bind and resume), `thread/delete` (the core's
//! canonical close of a session a client asks for: its tombstone fences admission before the work stops) and
//! `TaskNotifier::finished` (a background job's completion) — and compared at what a client observes, as the
//! manifest's `exclusions` declare: each step's outcome (a value or a refusal), the runtime view `{addressedSessionId,
//! admission}` (`open`: the thread opens and resumes; `closing`: its open is refused while the close runs;
//! `terminal`: the closed thread is not there), the completion's queue entries and the turns it started.

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
use mixdog_testkit::exact::Exact;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::testing::Rig;
use super::testing::awaiting;
use super::testing::lock;
use super::tests::caught_up;
use super::tests::echo;
use super::tests::start_thread;

fn recording() -> Exact {
    let text = mixdog_testkit::fixture!("../../fixtures/session-address/recording.json");
    Exact::decode(&serde_json::from_str(text).expect("the recording is JSON")).expect("the recording decodes")
}

fn case(recording: &Exact, line: f64) -> Exact {
    recording.get("cases").as_array().iter().find(|case| case.get("testLine").as_f64() == line).cloned().unwrap_or_else(|| panic!("no case at line {line}"))
}

fn text(value: &str) -> Exact {
    Exact::String(value.to_owned())
}

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
    /// The store, as the fence a listing waits on for the index writes acknowledged before it.
    pub(super) threads: Arc<super::StoreThreads>,
    mark: Arc<MarkHold>,
    meta: Arc<MetaHold>,
    /// Whether each delete mark's durable write fails, and the marks written.
    pub(super) marks: Arc<MarkFail>,
    pub(super) data: super::testing::DataDir,
}

/// Each durable write of a delete mark asks `plan` whether it fails (rolled back, nothing applied: Node's failed unlink of
/// the session log) and is logged in `seen` with the answer.
#[derive(Default)]
pub(super) struct MarkFail {
    pub(super) plan: std::sync::Mutex<Option<Box<dyn FnMut(&str) -> bool + Send>>>,
    pub(super) seen: std::sync::Mutex<Vec<(String, bool)>>,
}

/// When armed, the next durable commit carrying the delete mark tells `.0` it was reached and waits for `.1` before it writes: Node's canonical close between its fence and the
/// durable close (`finishCanonicalClose`).
type MarkHold = std::sync::Mutex<Option<(Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>;

/// A delete held where it reads the session's catalog entry (`session_meta`, `delete_session`'s `isAvailableSession`):
/// after the client delete's detach landed, before the delete closes the thread.
type MetaHold = std::sync::Mutex<Option<(Arc<tokio::sync::Notify>, tokio::sync::oneshot::Receiver<()>)>>;

/// The real store, its session logs holding a commit while [`MarkHold`] is armed.
struct HeldStore {
    store: Arc<dyn super::ThreadStore>,
    mark: Arc<MarkHold>,
    meta: Arc<MetaHold>,
    marks: Arc<MarkFail>,
}

struct HeldLog {
    log: Box<dyn super::seams::SessionLog>,
    id: ThreadId,
    mark: Arc<MarkHold>,
    marks: Arc<MarkFail>,
}

impl super::seams::SessionLog for HeldLog {
    fn commit(&mut self, lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>, batch: &[super::seams::CommitRecord]) -> Result<Vec<u64>, super::seams::BarrierError> {
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
                return Err(super::seams::BarrierError::Failed { io_kind: "EACCES".into() });
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
    fn read_window(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, head: &super::seams::HeadRead) -> Result<super::seams::WindowRead, CoreError> {
        self.store.read_window(lane, id, head)
    }
    fn decode(&self, lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>, id: &ThreadId, head: super::seams::HeadRead, window: super::seams::WindowRead) -> Result<super::seams::OpenedLog, CoreError> {
        self.store.decode(lane, id, head, window)
    }
    fn user_rows(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<Vec<mixdog_store::schema::record::ItemRecord>, CoreError> {
        self.store.user_rows(lane, id)
    }
    fn history_rows(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<(u64, Vec<mixdog_store::schema::record::ItemRecord>), CoreError> {
        self.store.history_rows(lane, id)
    }
    fn thread_op(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, op: &str) -> Result<Option<super::seams::StoredOp>, CoreError> {
        self.store.thread_op(lane, id, op)
    }
    fn fenced_ops(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<Vec<String>, CoreError> {
        self.store.fenced_ops(lane, id)
    }
    fn history_row(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<(u64, mixdog_store::schema::record::ItemRecord)>, CoreError> {
        self.store.history_row(lane, id, iid)
    }
    fn compaction_entry(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, iid: &str) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        self.store.compaction_entry(lane, id, iid)
    }
    fn context_io(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, read: Option<super::seams::ContextRead>) -> Result<super::seams::ContextRead, CoreError> {
        self.store.context_io(lane, id, read)
    }
    fn context_len(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId) -> Result<usize, CoreError> {
        self.store.context_len(lane, id)
    }
    fn context_from_io(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, skip: usize) -> Result<super::seams::ContextRead, CoreError> {
        self.store.context_from_io(lane, id, skip)
    }
    fn history_window(&self, lane: &mixdog_rt::InLane<mixdog_rt::InteractiveIo>, id: &ThreadId, records: usize) -> Result<(u64, Vec<mixdog_store::schema::record::ItemRecord>, bool), CoreError> {
        self.store.history_window(lane, id, records)
    }
    fn session_meta(&self, id: &ThreadId) -> futures::future::BoxFuture<'static, Result<Option<super::seams::SessionMeta>, CoreError>> {
        let read = self.store.session_meta(id);
        let held = lock(&self.meta).take();
        Box::pin(async move {
            if let Some((reached, release)) = held {
                reached.notify_one();
                awaiting(|| "the held delete to be released".to_owned(), release).await.expect("the delete released");
            }
            read.await
        })
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
    fn context_cpu(&self, lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>, read: super::seams::ContextRead) -> Result<super::seams::ContextStep, CoreError> {
        self.store.context_cpu(lane, read)
    }
    fn open_log(&self, lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>, id: &ThreadId, at: super::seams::AppendPosition) -> Result<Box<dyn super::seams::SessionLog>, super::seams::BarrierError> {
        let log = self.store.open_log(lane, id, at)?;
        Ok(Box::new(HeldLog { log, id: id.clone(), mark: self.mark.clone(), marks: self.marks.clone() }))
    }
    fn create_log(&self, lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>, id: &ThreadId, session: &super::seams::CommitRecord) -> Result<(Box<dyn super::seams::SessionLog>, u64), super::seams::BarrierError> {
        let (log, ordinal) = self.store.create_log(lane, id, session)?;
        Ok((Box::new(HeldLog { log, id: id.clone(), mark: self.mark.clone(), marks: self.marks.clone() }), ordinal))
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
    let threads =
        Arc::new(super::StoreThreads::over_data_dir(data.path(), index.clone(), Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"));
    let store: Arc<dyn super::ThreadStore> = threads.clone();
    let mark = Arc::new(MarkHold::default());
    let marks = Arc::new(MarkFail::default());
    let rig = Rig::new();
    rig.set_script(echo());
    let meta = Arc::new(MetaHold::default());
    let directory = Arc::new(SessionDirectory::new(rig.deps_on(Arc::new(HeldStore { store, mark: mark.clone(), meta: meta.clone(), marks: marks.clone() }))));
    Real { directory, rig, index, threads, mark, meta, marks, data }
}

/// A client delete (`thread/delete`) held after its detach landed, before it closes the thread.
pub(super) struct HeldDelete {
    release: tokio::sync::oneshot::Sender<()>,
    delete: tokio::task::JoinHandle<Result<Reply, CoreError>>,
}

pub(super) async fn begin_delete(real: &Real, id: &ThreadId) -> HeldDelete {
    let (reached, (release, held)) = (Arc::new(tokio::sync::Notify::new()), tokio::sync::oneshot::channel());
    *lock(&real.meta) = Some((reached.clone(), held));
    let handle = real.directory.handle(id).expect("loaded");
    let params = json!({ "threadId": id, "opId": "op-delete" });
    let delete = tokio::spawn(async move { handle.request(request("thread/delete", params)).await });
    awaiting(|| "the delete's detach to land".to_owned(), reached.notified()).await;
    HeldDelete { release, delete }
}

impl HeldDelete {
    pub(super) async fn finish(self) -> bool {
        self.release.send(()).expect("the delete is held");
        let reply = awaiting(|| "the delete to finish".to_owned(), self.delete).await.expect("the delete task").expect("thread/delete");
        matches!(reply, Reply::Value(Value::Bool(true)))
    }
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

/// Node's `rt` snapshot as a client observes it: the thread a request names, and whether it admits work (`open`), is
/// refused while its close runs (`closing`) or is gone (`terminal`). The core keeps no per-runtime lifecycle counter
/// (`lifecycleGeneration`, excluded in the manifest).
async fn rt(directory: &SessionDirectory, id: &str) -> Exact {
    let admission = match resume(directory, id).await {
        Ok(_) => "open",
        Err(CoreError::ThreadClosing { .. }) => "closing",
        Err(CoreError::ThreadNotFound { .. }) => "terminal",
        Err(error) => panic!("the thread's open answered {error:?}"),
    };
    Exact::Object(vec![("addressedSessionId".into(), text(id)), ("admission".into(), text(admission))])
}

/// A recorded step at the fields the manifest names: the label, whether it answered or refused (`outcome`, where
/// compared), the runtime view, and the counters a step of a completion case carries (where compared).
fn recorded_step(step: &Exact, address: &str, actual: &str, outcome: bool, counts: bool) -> Exact {
    let mut fields = vec![("step".to_owned(), step.get("step").clone())];
    if outcome {
        let refused = step.try_get("error").is_some() || step.try_get("ok") == Some(&Exact::Bool(false));
        fields.push(("outcome".into(), text(if refused { "refused" } else { "answered" })));
    }
    if let Some(rt) = step.try_get("rt") {
        let named = rt.get("addressedSessionId").as_str();
        let id = if named == address { actual } else { named };
        fields.push(("rt".into(), Exact::Object(vec![("addressedSessionId".into(), text(id)), ("admission".into(), rt.get("admission").clone())])));
    }
    if counts {
        for key in ["enqueuedCount", "wakeCount"] {
            fields.push((key.into(), step.get(key).clone()));
        }
    }
    Exact::Object(fields)
}

fn step(label: &Exact, answered: Option<bool>, rt: Option<Exact>, counts: Option<(usize, usize)>) -> Exact {
    let mut fields = vec![("step".to_owned(), label.clone())];
    if let Some(answered) = answered {
        fields.push(("outcome".into(), text(if answered { "answered" } else { "refused" })));
    }
    if let Some(rt) = rt {
        fields.push(("rt".into(), rt));
    }
    if let Some((enqueued, woke)) = counts {
        fields.push(("enqueuedCount".into(), Exact::from(enqueued as f64)));
        fields.push(("wakeCount".into(), Exact::from(woke as f64)));
    }
    Exact::Object(fields)
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

/// `outcome(index)` and `counts(index)`: whether that step's outcome and counters are compared (the manifest names the
/// steps where they are not).
fn compare(label: &str, got: Vec<Exact>, recorded: &Exact, address: &str, actual: &str, outcome: impl Fn(usize) -> bool, counts: impl Fn(usize) -> bool) {
    let want: Vec<Exact> = recorded.get("steps").as_array().iter().enumerate().map(|(index, step)| recorded_step(step, address, actual, outcome(index), counts(index))).collect();
    assert_eq!(Exact::Array(got), Exact::Array(want), "{label}");
}

const COMPLETION: &str = "<task-notification><task-id>shell_1</task-id><status>cancelled</status></task-notification>";

/// Line 24: the thread a client opens answers as itself every time; another id is another thread (refused when there
/// is none), and a new session is a new thread, never this one re-keyed (step 3's outcome is not compared: Node refuses
/// `newSession` on its addressed runtime and tells the caller to create a new session entry, which is what the core's
/// `thread/start` is).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_24_a_thread_answers_as_itself_and_is_never_re_keyed() {
    let recording = recording();
    let case = case(&recording, 24.0);
    let steps = case.get("result").get("steps").as_array();
    let rig = rig();
    let directory = SessionDirectory::new(rig.deps());
    let a = start_thread(&directory).await.id.as_str().to_owned();
    let mut got = Vec::new();
    for (index, label) in steps.iter().map(|step| step.get("step")).enumerate() {
        let answered = match index {
            0 | 1 | 5 => Some(resume(&directory, &a).await.expect("the thread resumes") == a),
            2 | 4 => Some(resume(&directory, "sess_b").await.is_ok()),
            _ => {
                let other = start_thread(&directory).await.id.as_str().to_owned();
                assert_ne!(other, a, "a new session is another thread");
                None
            }
        };
        got.push(step(label, answered, Some(rt(&directory, &a).await), None));
    }
    compare("line 24", got, case.get("result"), "sess_a", &a, |index| index != 3, |_| false);
}

/// Line 35: the close fences the thread while it runs (its open is refused), lands durably and leaves the thread
/// terminal; a second close changes nothing (its answer is not compared: the core's delete of a thread already gone
/// answers false, Node's close of a terminal runtime true).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_35_the_close_fences_first_and_leaves_the_thread_terminal() {
    let recording = recording();
    let case = case(&recording, 35.0);
    let steps = case.get("result").get("steps").as_array();
    let real = real().await;
    let directory = &real.directory;
    let id = listed_thread(&real).await;
    let a = id.as_str().to_owned();
    let held = begin_close(&real, &id).await;
    let during = rt(directory, &a).await;
    assert_eq!(during.get("admission"), steps[0].get("managerCalls").as_array()[0].get("admission"), "the admission while the close runs");
    let closed = held.finish().await;
    let mut got = vec![step(steps[0].get("step"), Some(closed), Some(rt(directory, &a).await), None)];
    assert_eq!(Exact::Null, *steps[0].get("currentSession"));
    assert!(matches!(resume(directory, &a).await, Err(CoreError::ThreadNotFound { .. })), "no current session");
    delete(directory, &a).await.expect("thread/delete");
    got.push(step(steps[1].get("step"), None, Some(rt(directory, &a).await), None));
    compare("line 35", got, case.get("result"), "sess_a", &a, |index| index == 0, |_| false);
}

/// Line 65: a close whose durable write fails leaves the thread open and in place.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_65_a_failed_close_restores_admission_and_keeps_the_thread() {
    let recording = recording();
    let case = case(&recording, 65.0);
    let steps = case.get("result").get("steps").as_array();
    let rig = rig();
    let directory = SessionDirectory::new(rig.deps());
    let a = start_thread(&directory).await.id.as_str().to_owned();
    let mut got = Vec::new();
    for label in steps.iter().map(|step| step.get("step")) {
        rig.store.fail_next.store(true, std::sync::atomic::Ordering::SeqCst);
        let closed = delete(&directory, &a).await.unwrap_or(false);
        assert_eq!(resume(&directory, &a).await.expect("the thread is kept"), a, "the session is kept");
        got.push(step(label, Some(closed), Some(rt(&directory, &a).await), None));
    }
    compare("line 65", got, case.get("result"), "sess_a", &a, |_| true, |_| false);
}

/// Line 108: a completion reaches the open thread's client as its card; once the thread is closing, and once it is
/// closed, a completion is neither queued nor wakes it. Not compared: the notify steps' answers (Node's listeners,
/// which outlive the close; a deleted thread has no client) and the open step's counters (Node's listener delivers
/// the completion to the model itself; the core's card is display and its queue entry the model's copy).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_108_a_closed_owner_never_queues_or_wakes_a_completion() {
    let recording = recording();
    let case = case(&recording, 108.0);
    let steps = case.get("result").get("steps").as_array();
    let text = case.get("input").get("completionText").as_str().to_owned();
    let real = real().await;
    let (rig, directory) = (&real.rig, &real.directory);
    let id = listed_thread(&real).await;
    let a = id.as_str().to_owned();
    let before = seen(rig, directory, &id).await;
    finished(directory, &id, "shell_1", &text).await;
    let open = seen(rig, directory, &id).await;
    assert_eq!(open.cards - before.cards, 1, "the open thread's client sees the completion");
    let mut got = vec![step(steps[0].get("step"), None, Some(rt(directory, &a).await), None)];
    // What the open step left (its queue entry, and the turn that took it) is the baseline the later steps add to.
    let handle = directory.handle(&id).expect("loaded");
    // The completion wakes a turn once its queue entry is durable: settled when that turn started and ended.
    let woke = || rig.feeds.frames(id.as_str()).iter().filter(|(_, method, _)| method == "turn/started").count() > before.turns;
    crate::eventually_on!(&[&handle.cell.stepped], || (woke() && super::tests::idle(&handle) && handle.cell.queued.load().is_empty()).then_some(())).await;
    drop(handle);
    let base = seen(rig, directory, &id).await;
    let counts = |now: &Seen| (now.queued.saturating_sub(base.queued), now.turns - base.turns);
    let held = begin_close(&real, &id).await;
    got.push(step(steps[1].get("step"), Some(true), Some(rt(directory, &a).await), Some(counts(&seen(rig, directory, &id).await))));
    finished(directory, &id, "shell_2", &text).await;
    got.push(step(steps[2].get("step"), None, Some(rt(directory, &a).await), Some(counts(&seen(rig, directory, &id).await))));
    let closed = held.finish().await;
    got.push(step(steps[3].get("step"), Some(closed), Some(rt(directory, &a).await), Some(counts(&seen(rig, directory, &id).await))));
    for (index, execution) in [(4, "shell_3"), (5, "shell_4")] {
        finished(directory, &id, execution, &text).await;
        got.push(step(steps[index].get("step"), None, Some(rt(directory, &a).await), Some(counts(&seen(rig, directory, &id).await))));
    }
    compare("line 108", got, case.get("result"), "sess_a", &a, |index| index == 1 || index == 3, |index| index != 0);
    assert_eq!(case.get("result").get("enqueued"), &Exact::Array(Vec::new()));
    assert_eq!(case.get("result").get("woke"), &Exact::Array(Vec::new()));
}

/// Line 140: a completion for an owner that is closed is not delivered: nothing is queued and no turn starts.
/// (Line 150: one whose lifecycle moved on since the job was started; the core's completions carry no lifecycle
/// generation, so the owner that moved on is the closed one. Its `rt` is not compared: Node's runtime stays open under
/// a later generation; the core's thread is gone.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_140_a_completion_for_a_closed_owner_is_not_delivered() {
    completion_for_a_closed_owner(140.0).await;
}

/// Line 150: a completion for an owner whose lifecycle moved on since the job started is not delivered.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_150_a_completion_for_a_moved_on_owner_is_not_delivered() {
    completion_for_a_closed_owner(150.0).await;
}

async fn completion_for_a_closed_owner(line: f64) {
    let recording = recording();
    {
        let case = case(&recording, line);
        let steps = case.get("result").get("steps").as_array();
        let real = real().await;
        let (rig, directory) = (&real.rig, &real.directory);
        let id = listed_thread(&real).await;
        let a = id.as_str().to_owned();
        let closed = delete(directory, &a).await.expect("thread/delete");
        let base = seen(rig, directory, &id).await;
        let mut got = Vec::new();
        let mut want = Vec::new();
        for (index, recorded) in steps.iter().enumerate() {
            if line == 140.0 && index == 0 {
                got.push(step(recorded.get("step"), Some(closed), None, None));
            } else {
                finished(directory, &id, "shell_1", COMPLETION).await;
                let after = seen(rig, directory, &id).await;
                let delivered = after.queued + after.turns + after.cards > base.queued + base.turns + base.cards;
                let rt = if line == 150.0 { None } else { Some(rt(directory, &a).await) };
                got.push(step(recorded.get("step"), Some(delivered), rt, None));
            }
            let projected = recorded_step(recorded, "sess_bare", &a, true, false);
            want.push(match (line == 150.0, projected) {
                (true, Exact::Object(fields)) => Exact::Object(fields.into_iter().filter(|(key, _)| key != "rt").collect()),
                (_, projected) => projected,
            });
        }
        assert_eq!(Exact::Array(got), Exact::Array(want), "line {line}");
        assert_eq!(case.get("result").get("enqueued"), &Exact::Array(Vec::new()));
        assert_eq!(case.get("result").get("woke"), &Exact::Array(Vec::new()));
    }
}

/// Line 160: once the close has begun, a completion neither wakes the thread nor asks it anything. The core has no
/// delayed wake callback (an open idle thread's completion starts its turn at once, `x1`'s step is the open case of
/// line 108), so the steps compared are the fenced ones.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_160_a_fenced_owner_is_never_woken() {
    let recording = recording();
    let case = case(&recording, 160.0);
    let steps = case.get("result").get("steps").as_array();
    let real = real().await;
    let (rig, directory) = (&real.rig, &real.directory);
    let id = listed_thread(&real).await;
    let a = id.as_str().to_owned();
    let held = begin_close(&real, &id).await;
    assert_eq!(rt(directory, &a).await, *recorded_step(&steps[1], "sess_a", &a, false, false).get("rt"), "the close has begun");
    let before = seen(rig, directory, &id).await;
    finished(directory, &id, "x2", "<task-notification><task-id>x2</task-id><status>completed</status></task-notification>").await;
    let after = seen(rig, directory, &id).await;
    assert!(held.finish().await, "the close lands");
    let asks: Vec<Exact> = (before.turns..after.turns).map(|_| text("ask")).collect();
    assert_eq!(Exact::Array(asks.clone()), *steps[2].get("asks"), "the delayed wake asked nothing");
    assert_eq!(Exact::Array(asks), *case.get("result").get("asks"));
    assert_eq!(Exact::Bool(after.queued > before.queued || after.turns > before.turns), *steps[3].get("ok"), "the wake after the fence is refused");
}

/// Line 178: an open thread admits work; once its close begins, its admission is refused.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn line_178_a_fenced_thread_refuses_admission() {
    let recording = recording();
    let case = case(&recording, 178.0);
    let steps = case.get("result").get("steps").as_array();
    let real = real().await;
    let directory = &real.directory;
    let id = listed_thread(&real).await;
    let a = id.as_str().to_owned();
    let mut got = vec![step(steps[0].get("step"), Some(resume(directory, &a).await.is_ok()), Some(rt(directory, &a).await), None)];
    let held = begin_close(&real, &id).await;
    got.push(step(steps[1].get("step"), Some(true), Some(rt(directory, &a).await), None));
    let refused = resume(directory, &a).await;
    assert!(matches!(refused, Err(CoreError::ThreadClosing { .. })), "the closing thread's open is refused as closing: {refused:?}");
    got.push(step(steps[2].get("step"), Some(refused.is_ok()), Some(rt(directory, &a).await), None));
    assert!(held.finish().await);
    compare("line 178", got, case.get("result"), "sess_a", &a, |_| true, |_| false);
}

