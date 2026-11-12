//! The durability invariant, over generated sequences on the real store: for every interleaving of accepts (a turn's
//! rows, a room post, an import, a manual compaction, the recovery at open), failed writes (the log's barrier failing in
//! the real writer, a draft file's replace or removal failing), new work meanwhile, a value marked sensitive, a close
//! while writes fail and a reopen, the log holds exactly the accepted units in accept order, each once, less what the
//! session was told it lost at a close, which is always everything after what landed; every run the log starts ends
//! once; and no file under the session's directory holds a marked value once the session has had its chance to take it
//! out (it is quiet, and the draft writes it owes have been tried until they succeeded).
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
/// Log barriers failed so far, and the signal of each.
static LOG_FAILED: AtomicUsize = AtomicUsize::new(0);
static FAILED: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn take(budget: &AtomicUsize) -> bool {
    budget.try_update(SeqCst, SeqCst, |left| left.checked_sub(1)).is_ok()
}

fn append_hook(step: AppendStep, _: &[Record]) -> std::io::Result<()> {
    if step == AppendStep::Write && take(&LOG_FAILS) {
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
    /// The session closes (`failing`: while every write fails), then opens again with the disk well: the open recovers the
    /// runs whose end did not land.
    Close { failing: bool },
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
        .map(|_| match below(14) {
            0..=2 => Turn { drafted: below(2) == 0, fail: if below(2) == 0 { 0 } else { 1 + below(4) as usize } },
            3 | 4 => Step::Post,
            5 => Step::Import,
            6 => Step::Compaction,
            7 => Step::FailLog(1 + below(4) as usize),
            8 | 9 => Step::FailDraft(1 + below(3) as usize),
            10 | 11 => Step::Mark,
            _ => Step::Close { failing: below(2) == 0 },
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
    /// Lost reports read so far, and the tokens they named.
    told: usize,
    lost: Vec<String>,
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
    async fn new(seed: u64) -> Self {
        use mixdog_core_api::domain::mock::MockOwnership;
        LOG_FAILS.store(0, SeqCst);
        DRAFT_FAILS.store(0, SeqCst);
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
        let directory = directory(&rig, &threads, &marks, &clock);
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
            told: 0,
            lost: Vec::new(),
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

    /// Closes the session and waits for its actor to end. A close while writes fail gets that failure; one that keeps
    /// writing after it is given the disk back after its third failed write, so it ends (and is caught by the check).
    async fn close(&mut self, failing: bool) {
        if failing {
            LOG_FAILS.store(50, SeqCst);
            DRAFT_FAILS.store(50, SeqCst);
        }
        let (stops, failed) = (self.stops(), LOG_FAILED.load(SeqCst));
        self.directory().shutdown().await;
        crate::eventually_on!(&[&self.rig.snapshots.1, &FAILED], || (self.stops() > stops || LOG_FAILED.load(SeqCst) >= failed + 3).then_some(())).await;
        LOG_FAILS.store(0, SeqCst);
        DRAFT_FAILS.store(0, SeqCst);
        crate::eventually_on!(&[&self.rig.snapshots.1], || (self.stops() > stops).then_some(())).await;
        self.check_closed();
    }

    async fn reopen(&mut self) {
        let directory = directory(&self.rig, &self.threads, &self.marks, &self.clock);
        let handle = directory.open_handle(&self.handle.id, &CallContext::internal("test")).await.expect("the thread opens");
        crate::eventually_on!(&[&handle.cell.stepped], || handle.recovered().then_some(())).await;
        self.directories.push(directory);
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

    /// At a close, once its actor ended: the log holds every unit accepted and not lost before, in accept order, up to
    /// where the session was told the rest is lost, and the rest is exactly what it was told, in order.
    fn check_closed(&mut self) {
        let stored: Vec<String> = self.records().iter().filter_map(|record| self.token(record)).collect();
        let id = self.handle.id.as_str().to_owned();
        let (told, reports) = {
            let reports = lock(&self.rig.notices.2);
            let told: Vec<String> =
                reports[self.told..].iter().filter(|(session, _)| *session == id).flat_map(|(_, records)| records.iter().filter_map(|record| self.token(record)).collect::<Vec<_>>()).collect();
            (told, reports.len())
        };
        self.told = reports;
        let before: HashSet<String> = self.lost.iter().cloned().collect();
        self.lost.extend(told.iter().cloned());
        let lost: HashSet<String> = self.lost.iter().cloned().collect();
        let expected: Vec<String> = self
            .units
            .iter()
            .filter(|unit| unit.accepted || unit.tokens.iter().any(|token| lost.contains(token)))
            .flat_map(|unit| unit.tokens.iter().cloned())
            .filter(|token| !before.contains(token))
            .collect();
        let mut seen = stored.clone();
        seen.extend(told.iter().cloned());
        if seen != expected {
            self.fail(format!("the log holds {stored:?} and the close told {told:?} lost; accepted in order: {expected:?}"));
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
        if !holding.is_empty() {
            self.fail(format!("the marked value is in {holding:?}"));
        }
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
                Step::Close { failing } => {
                    self.close(failing).await;
                    self.reopen().await;
                }
            }
            self.check_secret();
        }
        LOG_FAILS.store(0, SeqCst);
        DRAFT_FAILS.store(0, SeqCst);
        self.close(false).await;
        self.reopen().await;
        self.close(false).await;
        self.check_runs();
        self.check_secret();
        std::mem::take(&mut self.failures)
    }
}

fn directory(rig: &Rig, threads: &Arc<super::StoreThreads>, marks: &Arc<super::store::SensitiveMarksOf>, clock: &Arc<StepClock>) -> Arc<SessionDirectory> {
    let mut deps = rig.deps_parts(threads.clone());
    deps.clock = clock.clone();
    deps.sensitive = marks.clone();
    Arc::new(SessionDirectory::new(Arc::new(deps)))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generated_failure_schedules_keep_the_accepted_units_in_order_and_no_marked_value_on_disk() {
    install_hooks();
    let mut failures = Vec::new();
    for seed in 1..=SEEDS {
        failures.extend(World::new(seed).await.run().await);
    }
    assert!(failures.is_empty(), "{} failing sequences:\n{}", failures.len(), failures.join("\n"));
}
