//! The durability invariant, over generated sequences on the real store: for every interleaving of accepts (a turn's
//! rows, a room post, an import, a manual compaction, the recovery at open), failed writes (the log's barrier failing in
//! the real writer 0, 1, 2 or many times in a row, a draft file's replace or removal failing), new work meanwhile, a
//! value marked sensitive, closes (the last subscriber leaving, Node's detaching close, a delete) raced by an open of the
//! same session, and restarts: a close whose write fails does not complete, the session staying open (the racing open
//! finds it) with nothing it accepted given up; after every close or restart that completes, the log holds exactly the
//! accepted units in accept order, each once; every run the log starts ends once; and no file under the session's
//! directory holds a marked value once the session has had its chance to take it out (it is quiet, and the draft writes
//! it owes have been tried until they succeeded).
//!
//! Each sequence is drawn from its seed, so a failure names the seed and the steps that reproduce it.
#![allow(clippy::disallowed_methods, reason = "test oracle: reads the session's files on disk")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ItemId;
use mixdog_store::draft_file::DraftStep;
use mixdog_store::fsio::AppendStep;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::HeaderChange;
use mixdog_store::schema::record::MetaRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::RunPhase;
use serde_json::Value;
use serde_json::json;

use super::RunOutcome;
use super::SessionDirectory;
use super::SessionHandle;
use super::room_log::RoomLog;
use super::run::ItemCommit;
use super::testing::Rig;
use super::testing::lock;
use super::tests::caught_up;
use super::tests::idle;
use super::tests::request;
use super::tests::start_thread;

const SEEDS: u64 = 64;

/// Log barriers still to fail (the write stops half way and is rolled back, as the disk refusing it).
static LOG_FAILS: AtomicUsize = AtomicUsize::new(0);
/// Draft replaces and removals still to fail.
static DRAFT_FAILS: AtomicUsize = AtomicUsize::new(0);
/// Writes of a delete mark still to fail.
static MARK_FAILS: AtomicUsize = AtomicUsize::new(0);
/// Log barriers failed so far, and the signal of each.
static LOG_FAILED: AtomicUsize = AtomicUsize::new(0);
static FAILED: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn take(budget: &AtomicUsize) -> bool {
    budget.try_update(SeqCst, SeqCst, |left| left.checked_sub(1)).is_ok()
}

fn deletes(record: &Record) -> bool {
    matches!(record, Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) if change.set.get(mixdog_store::summary::DELETED) == Some(&Value::Bool(true)))
}

fn append_hook(step: AppendStep, records: &[Record]) -> std::io::Result<()> {
    if step == AppendStep::Write && ((records.iter().any(deletes) && take(&MARK_FAILS)) || take(&LOG_FAILS)) {
        LOG_FAILED.fetch_add(1, SeqCst);
        FAILED.notify_waiters();
        return Err(std::io::Error::other("EIO: injected"));
    }
    Ok(())
}

fn draft_hook(step: DraftStep, _: &str, _: Option<&Value>) -> std::io::Result<()> {
    if matches!(step, DraftStep::Replace | DraftStep::Remove) && take(&DRAFT_FAILS) {
        return Err(std::io::Error::other("EIO: injected"));
    }
    Ok(())
}

fn install_hooks() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        mixdog_store::fsio::set_append_hook(append_hook);
        mixdog_store::draft_file::set_draft_hook(draft_hook);
    });
}

/// The session's timers move only when the test advances them: a draft write tried again, a debounced save.
#[derive(Default)]
struct StepClock {
    due: Mutex<Vec<tokio::sync::oneshot::Sender<()>>>,
    armed: tokio::sync::Notify,
}

impl super::Clock for StepClock {
    fn now_ms(&self) -> i64 {
        1_000
    }

    fn sleep(&self, _after: std::time::Duration) -> futures::future::BoxFuture<'static, ()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        lock(&self.due).push(tx);
        self.armed.notify_waiters();
        Box::pin(async move {
            let _ = rx.await;
        })
    }
}

impl StepClock {
    fn pending(&self) -> bool {
        !lock(&self.due).is_empty()
    }

    fn advance(&self) {
        for due in std::mem::take(&mut *lock(&self.due)) {
            let _ = due.send(());
        }
    }
}

#[derive(Clone, Debug)]
enum Step {
    /// A turn: its input row and its answer; `drafted`: the run drafts the secret first; `fail`: the log's next writes fail
    /// from its answer on.
    Turn { drafted: bool, fail: usize },
    /// A room post of two rows (a unit kept whole for the next write when its own fails).
    Post,
    /// An imported conversation of three rows, appended as the importer appends it.
    Import,
    /// A manual compaction (refused, and never written, when its write fails).
    Compaction,
    FailLog(usize),
    FailDraft(usize),
    /// The secret is marked sensitive.
    Mark,
    /// The log's next `fails` writes fail (0, 1, 2 or many), and the session closes while an open of it races the close:
    /// its last subscriber leaves (`leave`), or Node's close detaches it (`closeSession(id, reason, { tombstone: false })`).
    Close { leave: bool, fails: usize },
    /// `thread/delete`, its delete mark's write failing.
    Delete,
    /// Core shutdown with the disk well, then the session opens in a new directory: the open recovers the runs whose
    /// end did not land.
    Restart,
}

/// xorshift64*: the steps of a seed.
fn steps(seed: u64) -> Vec<Step> {
    let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut below = |n: u64| {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        state.wrapping_mul(0x2545_F491_4F6C_DD1D) % n
    };
    let len = 6 + below(7);
    (0..len)
        .map(|_| match below(17) {
            0..=2 => Turn { drafted: below(2) == 0, fail: if below(2) == 0 { 0 } else { 1 + below(4) as usize } },
            3 | 4 => Step::Post,
            5 => Step::Import,
            6 => Step::Compaction,
            7 => Step::FailLog(1 + below(4) as usize),
            8 | 9 => Step::FailDraft(1 + below(3) as usize),
            10 | 11 => Step::Mark,
            12..=14 => Step::Close { leave: below(2) == 0, fails: [0, 1, 2, 50][below(4) as usize] },
            15 => Step::Delete,
            _ => Step::Restart,
        })
        .collect()
}
use Step::Turn;

#[derive(Clone)]
struct TurnPlan {
    answer: String,
    draft: Option<String>,
    fail: usize,
}

/// One accepted request's rows, by the token each row carries, and whether its caller was answered as accepted (a kept
/// unit whose write failed is accepted: it is written with the next write).
struct Unit {
    tokens: Vec<String>,
    accepted: bool,
}

/// One sequence's world. Fields drop in order: the directories before the databases and their folder.
struct World {
    seed: u64,
    steps: Vec<Step>,
    handle: Arc<SessionHandle>,
    directories: Vec<Arc<SessionDirectory>>,
    rig: Rig,
    threads: Arc<super::StoreThreads>,
    marks: Arc<super::store::SensitiveMarksOf>,
    clock: Arc<StepClock>,
    plans: Arc<Mutex<HashMap<String, TurnPlan>>>,
    answered: Arc<Mutex<HashSet<String>>>,
    secret: String,
    marked: bool,
    known: HashSet<String>,
    units: Vec<Unit>,
    /// The session left without its close completing: the sequence cannot go on.
    gone: bool,
    /// A crashed run's draft is recovered as its partial reply ([`DraftedCrash`]).
    drafted_crash: bool,
    failures: Vec<String>,
    data: super::testing::DataDir,
}

fn script(plans: Arc<Mutex<HashMap<String, TurnPlan>>>, answered: Arc<Mutex<HashSet<String>>>) -> super::testing::Script {
    Arc::new(move |run| {
        let (plans, answered) = (plans.clone(), answered.clone());
        Box::pin(async move {
            if run.port.input_durable().await.is_err() {
                return RunOutcome::Interrupted;
            }
            let prompt = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            let plan = lock(&plans).get(&prompt).cloned().expect("a planned turn");
            if let Some(draft) = plan.draft {
                let _ = run.port.draft(json!({ "text": draft })).await;
            }
            if plan.fail > 0 {
                LOG_FAILS.store(plan.fail, SeqCst);
            }
            let item = ItemCommit { iid: ItemId::from(format!("a-{}", run.turn)), role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": plan.answer }), prompt: None };
            if run.port.commit_item(item).await.is_ok() {
                lock(&answered).insert(plan.answer);
            }
            RunOutcome::Completed(Default::default())
        })
    })
}

impl World {
    async fn new(seed: u64, drafted_crash: bool) -> Self {
        use mixdog_core_api::domain::mock::MockOwnership;
        LOG_FAILS.store(0, SeqCst);
        DRAFT_FAILS.store(0, SeqCst);
        MARK_FAILS.store(0, SeqCst);
        let data = super::testing::DataDir::default();
        let tokens = mixdog_rt::testing::tokens();
        let root = data.path().to_path_buf();
        let index = mixdog_rt::LaneToken::submit(tokens.maintenance_io, &mixdog_rt::CancellationToken::new(), move |lane| {
            mixdog_store::sqlite::SqliteStore::open(lane, tokens.sqlite_writer_thread, tokens.interactive_io, &root)
        })
        .expect("lane")
        .await
        .expect("job ran")
        .expect("index");
        let index = data.index(index);
        let threads = Arc::new(super::StoreThreads::over_data_dir(data.path(), index, Arc::new(MockOwnership::default()), tokens.maintenance_io).await.expect("the thread store"));
        let rig = Rig::new();
        let marks = Arc::new(super::store::SensitiveMarksOf::new(rig.sensitive.clone()));
        assert!(threads.redact_with(marks.clone()).is_ok());
        let (plans, answered): (Arc<Mutex<HashMap<String, TurnPlan>>>, Arc<Mutex<HashSet<String>>>) = Default::default();
        rig.set_script(script(plans.clone(), answered.clone()));
        let clock = Arc::new(StepClock::default());
        let directory = directory(&rig, &threads, &marks, &clock, drafted_crash);
        let handle = start_thread(&directory).await;
        World {
            seed,
            steps: steps(seed),
            handle,
            directories: vec![directory],
            rig,
            threads,
            marks,
            clock,
            plans,
            answered,
            secret: format!("Kq7v{seed}wXz"),
            marked: false,
            known: HashSet::new(),
            units: Vec::new(),
            gone: false,
            drafted_crash,
            failures: Vec::new(),
            data,
        }
    }

    fn directory(&self) -> Arc<SessionDirectory> {
        self.directories.last().expect("a directory").clone()
    }

    fn fail(&mut self, what: String) {
        let failure = format!("seed {} {:?}: {what}", self.seed, self.steps);
        if !self.failures.contains(&failure) {
            self.failures.push(failure);
        }
    }

    /// Quiet: no run, nothing handed or unacknowledged, and the draft writes it owes done, the session's timers advanced
    /// for as long as it waits on them.
    async fn settle(&self) {
        let handle = &self.handle;
        loop {
            caught_up(handle).await;
            let settled = crate::eventually_on!(&[&handle.cell.stepped, &self.clock.armed], || {
                let quiet = idle(handle) && !handle.turn_busy() && handle.cell.handed.load(SeqCst) == 0 && handle.cell.unacked.load(SeqCst) == 0;
                if !quiet {
                    return None;
                }
                if handle.cell.drafts_settled.load(SeqCst) {
                    return Some(true);
                }
                self.clock.pending().then_some(false)
            })
            .await;
            if settled {
                return;
            }
            self.clock.advance();
        }
    }

    fn unit(&mut self, tokens: Vec<String>, accepted: bool) {
        self.known.extend(tokens.iter().cloned());
        self.units.push(Unit { tokens, accepted });
    }

    async fn turn(&mut self, n: usize, drafted: bool, fail: usize) {
        let (prompt, answer) = (format!("u{n}"), format!("t{n}"));
        let draft = drafted.then(|| format!("d{n} the code is {} ", self.secret));
        lock(&self.plans).insert(prompt.clone(), TurnPlan { answer: answer.clone(), draft, fail });
        let op = format!("op-{n}");
        let reply = self.handle.request(request("turn/start", json!({ "threadId": self.handle.id, "opId": op, "input": { "prompt": prompt } }), &op)).await;
        self.settle().await;
        let mut tokens = vec![prompt];
        if lock(&self.answered).contains(&answer) {
            tokens.push(answer);
        }
        self.unit(tokens, reply.is_ok());
    }

    async fn rows(&mut self, tokens: Vec<String>) {
        let rows: Vec<Value> = tokens
            .iter()
            .enumerate()
            .map(|(i, text)| json!({ "role": if i % 2 == 0 { "user" } else { "assistant" }, "content": text, "meta": { "transcript": { "messageId": text } } }))
            .collect();
        let posted = super::room_log::SessionRoomLog::new(self.directory()).append_rows(self.handle.id.as_str(), rows).await;
        self.settle().await;
        self.unit(tokens, matches!(posted, Ok(_) | Err(CoreError::BarrierFailed { .. })));
    }

    async fn compaction(&mut self, n: usize) {
        use super::run::Compaction;
        let tag = format!("c{n}");
        let directory = self.directory();
        let accepted = match directory.model_context(&self.handle.id).read().await {
            Ok(context) => {
                let snapshot = context.into_iter().map(|(iid, _)| iid).collect();
                let compaction = Compaction { replacement: vec![(ItemId::from(format!("s{n}")), json!({ "role": "user", "content": "summary" }))], at: 5, dropped_count: 1, dropped: None };
                let mut set = serde_json::Map::new();
                set.insert("compaction".into(), json!({ "compactCount": n, "lastStage": "manual", "tag": tag }));
                let header: super::turn_ops::CompactionHeader = Box::new(move |_, _| HeaderChange { set, unset: Vec::new() });
                matches!(directory.commit_compaction(&self.handle.id, snapshot, compaction, Some(header)).await, Ok(super::turn_ops::CompactionCommit::Applied))
            }
            Err(_) => false,
        };
        self.settle().await;
        self.unit(vec![tag], accepted);
    }

    async fn mark(&mut self) {
        let fill = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": self.secret } } });
        self.rig.sensitive.remember(self.handle.id.as_str(), &[fill]);
        self.marked = true;
        self.settle().await;
    }

    fn stops(&self) -> usize {
        let stopped = format!("stopped:{}", self.handle.id.as_str());
        lock(&self.rig.snapshots.0).iter().filter(|event| **event == stopped).count()
    }

    /// The log's next `fails` writes fail, and the session closes while an open of it races the close. A close that
    /// completes leaves everything accepted on disk once its actor ended, and the session is opened again; one whose write
    /// failed does not complete: the session stays open, the very one the racing open found, and nothing it accepted is
    /// given up (a later close or restart that completes finds all of it on disk).
    async fn close(&mut self, leave: bool, fails: usize) {
        LOG_FAILS.store(fails, SeqCst);
        let directory = self.directory();
        let (old, id) = (self.handle.clone(), self.handle.id.clone());
        let (stops, failed) = (self.stops(), LOG_FAILED.load(SeqCst));
        if leave {
            if !old.cell.subscribing() {
                self.fail(format!("the session is closed before its close (closed: {})", old.cell.closed.load(SeqCst)));
                self.gone = true;
                return;
            }
            old.cell.subscribed(true);
        }
        let closing = async {
            if leave {
                old.cell.unsubscribed();
                // Closed: the session left the directory. Failed: the write it gave what it holds failed, and it is loaded.
                crate::eventually_on!(&[&old.cell.stepped, directory.left(), &FAILED], || {
                    if !directory.handle(&id).is_some_and(|handle| Arc::ptr_eq(&handle.cell, &old.cell)) {
                        return Some(true);
                    }
                    (LOG_FAILED.load(SeqCst) > failed && old.cell.handed.load(SeqCst) == 0).then_some(false)
                })
                .await
            } else {
                close_of(&directory).detach(id.as_str(), "manual", false).await
            }
        };
        let ctx = CallContext::internal("test");
        let (closed, raced) = tokio::join!(closing, directory.open_handle(&id, &ctx));
        if closed {
            crate::eventually_on!(&[&self.rig.snapshots.1], || (self.stops() > stops).then_some(())).await;
            self.check_stored(if leave { "the last subscriber left" } else { "a detaching close" });
            self.open_again(&directory).await;
            return;
        }
        let kept = directory.handle(&id).is_some_and(|handle| Arc::ptr_eq(&handle.cell, &old.cell));
        let found = raced.as_ref().is_ok_and(|raced| Arc::ptr_eq(&raced.cell, &old.cell));
        if !kept || !found {
            self.fail(format!("a close whose write failed let the session go (still loaded: {kept}; the racing open found it: {found})"));
            self.gone = true;
            return;
        }
        self.settle().await;
    }

    /// `thread/delete` whose delete mark's write fails (or the detach before it, while the log's writes fail): the delete
    /// answers `false` and the session stays open with what it holds.
    async fn delete(&mut self, n: usize) {
        MARK_FAILS.store(1, SeqCst);
        let (directory, old) = (self.directory(), self.handle.clone());
        let op = format!("op-delete-{n}");
        let reply = mixdog_core_api::ThreadDirectory::request(&*directory, request("thread/delete", json!({ "threadId": old.id, "opId": op }), &op)).await;
        MARK_FAILS.store(0, SeqCst);
        if !matches!(reply, Ok(Reply::Value(Value::Bool(false)))) {
            self.fail(format!("a delete whose mark failed answered {:?}", reply.map(|_| "a reply other than false")));
        }
        if !directory.handle(&old.id).is_some_and(|handle| Arc::ptr_eq(&handle.cell, &old.cell)) {
            self.fail("a delete whose mark failed let the session go".to_owned());
            self.gone = true;
            return;
        }
        self.settle().await;
    }

    /// Core shutdown with the disk well (everything accepted is on disk once its actor ended), then an open in a new
    /// directory.
    async fn restart(&mut self) {
        LOG_FAILS.store(0, SeqCst);
        DRAFT_FAILS.store(0, SeqCst);
        let stops = self.stops();
        self.directory().shutdown().await;
        crate::eventually_on!(&[&self.rig.snapshots.1], || (self.stops() > stops).then_some(())).await;
        self.check_stored("a restart");
        let directory = directory(&self.rig, &self.threads, &self.marks, &self.clock, self.drafted_crash);
        self.directories.push(directory.clone());
        self.open_again(&directory).await;
    }

    async fn open_again(&mut self, directory: &Arc<SessionDirectory>) {
        let handle = directory.open_handle(&self.handle.id, &CallContext::internal("test")).await.expect("the thread opens");
        crate::eventually_on!(&[&handle.cell.stepped], || handle.recovered().then_some(())).await;
        self.handle = handle;
        self.settle().await;
    }

    /// Every record of the session's log, in order.
    fn records(&self) -> Vec<Record> {
        let dir = self.data.path().join("sessions").join(self.handle.id.as_str());
        let mut out = Vec::new();
        let mut ordinal = 0;
        for file_no in 0.. {
            let Ok(bytes) = std::fs::read(dir.join(mixdog_store::log::log_name(file_no))) else { break };
            let scan = mixdog_store::framing::scan(&bytes, 0, 0, ordinal);
            assert!(!scan.frames.is_empty() || bytes.is_empty(), "log file {file_no} holds no frame from ordinal {ordinal}");
            for frame in scan.frames {
                ordinal = frame.ordinal + 1;
                out.push(serde_json::from_slice(frame.payload(&bytes)).expect("a record"));
            }
        }
        out
    }

    fn token(&self, record: &Record) -> Option<String> {
        let text = match record {
            Record::Item(item) => match &item.body {
                Slot::Inline(body) => body.get("text").or_else(|| body.get("content")).and_then(Value::as_str),
                Slot::Blob(_) => None,
            },
            Record::Meta(MetaRecord { change: Slot::Inline(change), .. }) => change.set.get("compaction").and_then(|compaction| compaction.get("tag")).and_then(Value::as_str),
            _ => None,
        }?;
        self.known.contains(text).then(|| text.to_owned())
    }

    /// Once a close or restart completed and its actor ended: the log holds every accepted unit, in accept order, each once,
    /// and nothing else.
    fn check_stored(&mut self, what: &str) {
        let stored: Vec<String> = self.records().iter().filter_map(|record| self.token(record)).collect();
        let expected: Vec<String> = self.units.iter().filter(|unit| unit.accepted).flat_map(|unit| unit.tokens.iter().cloned()).collect();
        if stored != expected {
            self.fail(format!("after {what} the log holds {stored:?}; accepted in order: {expected:?}"));
        }
    }

    /// Every run the log starts ends there once.
    fn check_runs(&mut self) {
        let mut ends: HashMap<String, usize> = HashMap::new();
        for record in self.records() {
            if let Record::Run(run) = record {
                let count = ends.entry(run.rid.as_str().to_owned()).or_default();
                if matches!(run.phase, RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted) {
                    *count += 1;
                }
            }
        }
        let wrong: Vec<(String, usize)> = ends.into_iter().filter(|(_, count)| *count != 1).collect();
        if !wrong.is_empty() {
            self.fail(format!("runs not ended exactly once: {wrong:?}"));
        }
    }

    /// No file under the session's directory holds the marked value.
    fn check_secret(&mut self) {
        if !self.marked {
            return;
        }
        let holding = self.holding();
        if !holding.is_empty() {
            self.fail(format!("the marked value is in {holding:?}"));
        }
    }

    /// The files under the session's directory that hold the value.
    fn holding(&self) -> Vec<String> {
        let mut holding = Vec::new();
        let mut dirs = vec![self.data.path().join("sessions").join(self.handle.id.as_str())];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).expect("the session's directory").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                } else if std::fs::read(&path).is_ok_and(|bytes| bytes.windows(self.secret.len()).any(|window| window == self.secret.as_bytes())) {
                    holding.push(path.file_name().unwrap_or_default().to_string_lossy().into_owned());
                }
            }
        }
        holding
    }

    async fn run(mut self) -> Vec<String> {
        for (n, step) in self.steps.clone().into_iter().enumerate() {
            match step {
                Turn { drafted, fail } => self.turn(n, drafted, fail).await,
                Step::Post => self.rows(vec![format!("p{n}a"), format!("p{n}b")]).await,
                Step::Import => self.rows(vec![format!("i{n}a"), format!("i{n}b"), format!("i{n}c")]).await,
                Step::Compaction => self.compaction(n).await,
                Step::FailLog(count) => LOG_FAILS.store(count, SeqCst),
                Step::FailDraft(count) => DRAFT_FAILS.store(count, SeqCst),
                Step::Mark => self.mark().await,
                Step::Close { leave, fails } => self.close(leave, fails).await,
                Step::Delete => self.delete(n).await,
                Step::Restart => self.restart().await,
            }
            if self.gone {
                return std::mem::take(&mut self.failures);
            }
            // A session whose subscriber left unloads once quiet (a turn ended): a close that completed, so everything it
            // accepted is on disk.
            if self.handle.cell.closed.load(SeqCst) {
                self.check_stored("an unload once quiet");
                let directory = self.directory();
                self.open_again(&directory).await;
            }
            self.check_secret();
        }
        DRAFT_FAILS.store(0, SeqCst);
        self.close(true, 0).await;
        if !self.gone {
            self.restart().await;
            self.restart().await;
            self.check_runs();
            self.check_secret();
        }
        std::mem::take(&mut self.failures)
    }
}

/// The run host's finalization of a crashed run, as far as these tests read it: its draft's partial reply is the
/// assistant row it leaves.
struct DraftedCrash(Arc<super::testing::ScriptRuns>);

impl super::RunFactory for DraftedCrash {
    fn start(&self, run: super::RunStart) -> std::pin::Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
        super::RunFactory::start(&*self.0, run)
    }

    fn crashed(&self, run: super::CrashedRun) -> super::CrashedRows {
        let rows = Some(run.draft.text)
            .filter(|text| !text.is_empty())
            .map(|text| ItemCommit { iid: super::run::new_item_id(), role: Some("assistant".into()), model: true, visible: true, body: json!({ "role": "assistant", "content": text }), prompt: None })
            .into_iter()
            .collect();
        super::CrashedRows { rows, ..Default::default() }
    }
}

fn directory(rig: &Rig, threads: &Arc<super::StoreThreads>, marks: &Arc<super::store::SensitiveMarksOf>, clock: &Arc<StepClock>, drafted_crash: bool) -> Arc<SessionDirectory> {
    let mut deps = rig.deps_parts(threads.clone());
    deps.clock = clock.clone();
    deps.sensitive = marks.clone();
    if drafted_crash {
        deps.runs = Arc::new(DraftedCrash(rig.runs.clone()));
    }
    Arc::new(SessionDirectory::new(Arc::new(deps)))
}

/// Node's detaching close over the session directory (no providers, no shells).
fn close_of(directory: &Arc<SessionDirectory>) -> super::close::SessionClose {
    let providers = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(super::switch_replay::NoProviders)));
    super::close::SessionClose::new(directory.clone(), providers, Arc::new(super::switch_replay::NoShells), Arc::new(mixdog_tools::fs::ReadState::new(None)))
}

/// The failure budgets are the process's: one test of this module runs at a time.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generated_failure_schedules_keep_the_accepted_units_in_order_and_no_marked_value_on_disk() {
    let _serial = SERIAL.lock().await;
    install_hooks();
    let mut failures = Vec::new();
    for seed in 1..=SEEDS {
        failures.extend(World::new(seed, false).await.run().await);
    }
    assert!(failures.is_empty(), "{} failing sequences:\n{}", failures.len(), failures.join("\n"));
}

/// A run left open as its session ends (core shutdown while the log refuses every write: Node's exit drain fails and the
/// process exits), its draft holding in clear a value marked meanwhile (the draft's redaction and removal failed too):
/// the next open recovers the run from the draft, then removes the draft, and no file under the session's directory,
/// the log included, holds the value.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_draft_left_by_a_run_open_at_shutdown_is_recovered_then_removed_and_the_marked_value_is_in_no_file() {
    let _serial = SERIAL.lock().await;
    install_hooks();
    let mut world = World::new(0, true).await;
    world.turn(0, true, 50).await;
    DRAFT_FAILS.store(50, SeqCst);
    let fill = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": world.secret } } });
    world.rig.sensitive.remember(world.handle.id.as_str(), &[fill]);
    world.marked = true;
    // The draft's redaction failed, then its removal: it waits for its next round.
    crate::eventually_on!(&[&world.handle.cell.stepped, &world.clock.armed], || (world.clock.pending() && DRAFT_FAILS.load(SeqCst) == 48).then_some(())).await;
    let stops = world.stops();
    world.directory().shutdown().await;
    crate::eventually_on!(&[&world.rig.snapshots.1], || (world.stops() > stops).then_some(())).await;
    assert!(!world.holding().is_empty(), "the session ended with its draft holding the value in clear");
    let ended = world.records().iter().any(|record| matches!(record, Record::Run(run) if matches!(run.phase, RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted)));
    assert!(!ended, "the run's end is not on disk");

    LOG_FAILS.store(0, SeqCst);
    DRAFT_FAILS.store(0, SeqCst);
    let directory = directory(&world.rig, &world.threads, &world.marks, &world.clock, true);
    world.directories.push(directory.clone());
    world.open_again(&directory).await;
    let recovered = world.records().iter().any(|record| {
        matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body.get("content").and_then(Value::as_str).is_some_and(|text| text.starts_with("d0 the code is "))))
    });
    assert!(recovered, "the run is recovered from its draft");
    world.check_runs();
    world.check_secret();
    assert!(world.failures.is_empty(), "{}", world.failures.join("\n"));
}
