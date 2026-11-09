//! Test doubles for the session seams: an in-memory thread store whose logs share one record
//! list per thread (so a second directory reopens what the first wrote), a JSON codec, a
//! minimal transcript projection, scripted runs, and a feed that records what it publishes.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_app_protocol::v2::thread::TurnInput;
use mixdog_core_api::CoreError;
use mixdog_core_api::Feed;
use mixdog_core_api::FeedSource;
use mixdog_core_api::FeedView;
use mixdog_core_api::domain::approval::ApprovalId;
use mixdog_core_api::feed::AttachDecision;
use mixdog_core_api::feed::AttachRequest;
use mixdog_core_api::feed::FeedFrame;
use mixdog_core_api::feed::FeedPosition;
use mixdog_core_api::feed::PublishError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedEpoch;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::SubscriptionId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockFeed;
use mixdog_core_api::mock::MockServerRequests;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::ItemMeta;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::PromptContent;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ThreadSummary;
use mixdog_protocol::UserInput;
use mixdog_rt::CpuInteractive;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::Record;
use mixdog_tools::policy::SessionSurface;
use serde_json::Value;
use serde_json::json;

use super::Clock;
use super::SessionDeps;
use super::SessionLanes;
use super::SessionLimits;
use super::prompt_history::FilePromptHistory;
use super::seams::AppendPosition;
use super::seams::BarrierError;
use super::seams::CommitRecord;
use super::seams::ContextRead;
use super::seams::ContextStep;
use super::seams::FeedFactory;
use super::seams::HeadRead;
use super::seams::OpenedLog;
use super::seams::RunFactory;
use super::seams::RunOutcome;
use super::seams::RunStart;
use super::seams::SessionLog;
use super::seams::Shown;
use super::seams::ThreadStore;
use super::seams::ToolSurfaceSource;
use super::seams::Transcript;
use super::seams::WindowRead;
/// The stored-record transcript, which shows a room message as its room line (the rig's own transcript shows every row as a message).
pub use super::transcript::RecordTranscript;
use mixdog_core_base::approvals::ApprovalIds;
use mixdog_core_base::approvals::DeviceInfo;
use mixdog_core_base::approvals::Devices;

/// The compaction engine: `result` answers each compaction; `calls` keeps the order the host
/// was called in.
#[derive(Default)]
pub struct TestCompaction {
    pub result: Mutex<Option<Value>>,
    pub calls: Mutex<Vec<String>>,
    /// A compaction waits on it before answering, when set.
    pub hold: Mutex<Option<Arc<tokio::sync::Notify>>>,
    /// The `compaction` record the saved configuration gives a thread, when it has one.
    pub synced: Mutex<Option<Value>>,
    /// Each sync asked for: whether it was the session's installation.
    pub sync_calls: Mutex<Vec<bool>>,
    /// Each `prepare_books`: the provider and the number of messages.
    pub prepared: Mutex<Vec<(String, usize)>>,
    /// The configured route values (`route_config`).
    pub route: Mutex<mixdog_app_protocol::v2::thread::ThreadRoute>,
    /// The saved configuration's settings-change counter, when the test follows one.
    pub settings: Mutex<Option<tokio::sync::watch::Receiver<u64>>>,
    /// What `compact_for_heir` answers (the rows of the compacted conversation), and each ask: the budget and `summarize`.
    pub heir_rows: Mutex<Option<Vec<Value>>>,
    pub heir_asked: Mutex<Vec<(u64, bool)>>,
    /// `compact_for_heir` fails (the compactor threw).
    pub heir_fails: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl super::turn_ops::ManualCompaction for TestCompaction {
    async fn compact_for_heir(&self, _: &ThreadId, budget_tokens: u64, summarize: bool) -> Result<Option<Vec<Value>>, mixdog_core_api::CoreError> {
        lock(&self.heir_asked).push((budget_tokens, summarize));
        if self.heir_fails.load(Ordering::SeqCst) {
            return Err(mixdog_core_api::CoreError::Internal { incident_id: "compactor-failed".into() });
        }
        Ok(lock(&self.heir_rows).clone())
    }
    async fn compact(&self, _: &ThreadId, trigger: &str, require_reduction: bool) -> Result<Option<Value>, mixdog_core_api::CoreError> {
        lock(&self.calls).push(format!("compact {trigger} {require_reduction}"));
        let hold = lock(&self.hold).clone();
        if let Some(hold) = hold {
            hold.notified().await;
        }
        Ok(lock(&self.result).clone())
    }
    async fn post_compact(&self, _: &ThreadId, trigger: &str) {
        lock(&self.calls).push(format!("post {trigger}"));
    }
    async fn rearm(&self, _: &ThreadId) {
        lock(&self.calls).push("rearm".into());
    }
    fn recover_workers(&self, _: &ThreadId) {
        lock(&self.calls).push("recover".into());
    }
    fn invalidate_context_status(&self, _: &ThreadId) {
        lock(&self.calls).push("invalidate".into());
    }
    fn books(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> Option<super::turn_ops::Books> {
        None
    }
    async fn prepare_books(&self, _: &ThreadId, provider: &str, messages: &[mixdog_agent::message::AgentMessage]) {
        lock(&self.prepared).push((provider.to_owned(), messages.len()));
    }
    fn synced_compaction(&self, _: &mixdog_store::schema::record::Header, install: bool) -> Option<Value> {
        lock(&self.sync_calls).push(install);
        lock(&self.synced).clone()
    }
    fn route_config(&self, _: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
        lock(&self.route).clone()
    }
    fn settings_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        lock(&self.settings).clone()
    }
}

/// The heir-route policy: `basis` answers every measurement (the targets and message counts it
/// was asked about are kept); `None` is an unmeasurable route.
#[derive(Default)]
pub struct TestInherit {
    pub basis: Mutex<Option<(u64, u64, bool)>>,
    pub asked: Mutex<Vec<(String, String, Option<u64>, Option<ThreadId>, usize)>>,
    /// `inheritanceCompactionPlan(target).budgetTokens`; `None` is a route with no boundary to compact toward.
    pub budget: Mutex<Option<u64>>,
    /// What a conversation of that many messages measures (`limit`, `used`, `compactable`), before `basis` answers.
    pub measured: Mutex<std::collections::HashMap<usize, (u64, u64, bool)>>,
}

#[async_trait::async_trait]
impl super::inheritance::InheritanceFit for TestInherit {
    async fn basis(&self, target: &super::inheritance::InheritTarget, messages: &[Value]) -> Option<super::inheritance::FitBasis> {
        lock(&self.asked).push((target.provider.clone(), target.model.clone(), target.selected_context_window, target.tools_of.clone(), messages.len()));
        let (limit, used, compactable) = lock(&self.measured).get(&messages.len()).copied().or(*lock(&self.basis))?;
        Some(super::inheritance::FitBasis { limit, used, compactable })
    }
    async fn compaction_budget(&self, _: &super::inheritance::InheritTarget) -> Option<u64> {
        *lock(&self.budget)
    }
}

/// A side-question store: a session has a request once `request` is set; `send` answers `reply`
/// (or waits for the cancel when `reply` is `None`); each send's prompt and the begins are kept.
#[derive(Default)]
pub struct TestSide {
    pub request: std::sync::atomic::AtomicBool,
    pub reply: Mutex<Option<Result<super::turn_ops::SideReply, super::turn_ops::SideFailure>>>,
    pub prompts: Mutex<Vec<String>>,
    pub begins: std::sync::atomic::AtomicUsize,
    /// Every `forget(thread, cancel)`, in order.
    pub forgets: Mutex<Vec<(String, bool)>>,
    active: Mutex<Option<mixdog_rt::CancellationToken>>,
}

#[async_trait::async_trait]
impl super::turn_ops::SideQuestions for TestSide {
    async fn has_request(&self, _: &ThreadId) -> bool {
        self.request.load(Ordering::SeqCst)
    }
    fn begin(&self, _: &ThreadId) -> super::turn_ops::SideRun {
        self.begins.fetch_add(1, Ordering::SeqCst);
        let cancel = mixdog_rt::CancellationToken::new();
        if let Some(previous) = lock(&self.active).replace(cancel.clone()) {
            previous.cancel();
        }
        super::turn_ops::SideRun { cancel, end: Box::new(()) }
    }
    fn cancel(&self, _: &ThreadId) -> bool {
        lock(&self.active).take().map(|token| token.cancel()).is_some()
    }
    fn forget(&self, thread: &ThreadId, cancel: bool) {
        lock(&self.forgets).push((thread.as_str().to_owned(), cancel));
    }
    async fn send(&self, _: &ThreadId, prompt: &str, _: &str, cancel: &mixdog_rt::CancellationToken) -> Result<super::turn_ops::SideReply, super::turn_ops::SideFailure> {
        let scripted = lock(&self.reply).take();
        lock(&self.prompts).push(prompt.to_owned());
        match scripted {
            Some(reply) => reply,
            None => {
                cancel.cancelled().await;
                Err(super::turn_ops::SideFailure::Aborted)
            }
        }
    }
}

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Log = Arc<Mutex<Vec<(u64, Record)>>>;

/// Every thread's records in ordinal order.
#[derive(Default)]
pub struct MemStore {
    logs: Mutex<HashMap<ThreadId, Log>>,
    pub head_reads: AtomicU64,
    /// The next barrier fails (rolled back).
    pub fail_next: Arc<AtomicBool>,
    /// The next read of a thread's model context fails.
    pub fail_context: AtomicBool,
    /// The catalog lists every session (session_meta answers a bare row, not None).
    pub listed: AtomicBool,
    /// The next `create_log` tells `.0` it arrived, then waits for `.1` before it commits.
    pub create_gate: Mutex<Option<(Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>,
    /// The next commit to an open log tells `.0` it arrived, then waits for `.1` before it commits.
    pub commit_gate: CommitGate,
}

impl MemStore {
    pub fn records(&self, id: &ThreadId) -> Vec<(u64, Record)> {
        lock(&self.logs)
            .get(id)
            .map(|log| lock(log).clone())
            .unwrap_or_default()
    }

    fn log(&self, id: &ThreadId) -> Log {
        lock(&self.logs).entry(id.clone()).or_default().clone()
    }
}

/// The next commit tells `.0` it arrived, then waits for `.1` before it commits.
type CommitGate = Arc<Mutex<Option<(Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>>;

struct MemLog {
    log: Log,
    fail_next: Arc<AtomicBool>,
    commit_gate: CommitGate,
}

impl SessionLog for MemLog {
    fn commit(
        &mut self,
        _lane: &InLane<DurabilityIo>,
        batch: &[CommitRecord],
    ) -> Result<Vec<u64>, BarrierError> {
        let gate = lock(&self.commit_gate).take();
        if let Some((arrived, go)) = gate {
            arrived.notify_one();
            let _ = go.recv();
        }
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err(BarrierError::Failed {
                io_kind: "test".into(),
            });
        }
        let mut log = lock(&self.log);
        let mut next = log.last().map_or(0, |(ordinal, _)| ordinal + 1);
        let mut out = Vec::new();
        for commit in batch {
            log.push((next, (*commit.record).clone()));
            out.push(next);
            next += 1;
        }
        Ok(out)
    }

    fn retry(&mut self, _lane: &InLane<DurabilityIo>) -> Result<(), BarrierError> {
        Ok(())
    }
}

impl ThreadStore for MemStore {
    fn read_head(&self, _lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<HeadRead, CoreError> {
        self.head_reads.fetch_add(1, Ordering::SeqCst);
        let records = self.records(id);
        if records.is_empty() {
            return Err(CoreError::ThreadNotFound {
                thread_id: id.clone(),
            });
        }
        Ok(HeadRead(Box::new(records)))
    }

    /// The header of the session record, as `decode` takes it.
    fn read_header(&self, _lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<Header, CoreError> {
        let records = self.records(id);
        let Some((_, Record::Session(session))) = records.first() else {
            return Err(CoreError::ThreadNotFound { thread_id: id.clone() });
        };
        let mut header = match &session.header {
            Slot::Inline(header) => header.clone(),
            _ => Header::new(),
        };
        // The header fold: each change removes its `unset` keys, then merges its `set`.
        for (_, record) in &records {
            let Record::Meta(meta) = record else { continue };
            let Slot::Inline(change) = &meta.change else { continue };
            for key in &change.unset {
                header.shift_remove(key);
            }
            for (key, value) in &change.set {
                header.insert(key.clone(), value.clone());
            }
        }
        Ok(header)
    }

    fn read_log_id(&self, _lane: &InLane<InteractiveIo>, id: &ThreadId) -> Result<String, CoreError> {
        match self.records(id).first() {
            Some((_, Record::Session(session))) => Ok(session.log_id.as_str().to_owned()),
            _ => Err(CoreError::ThreadNotFound { thread_id: id.clone() }),
        }
    }

    fn read_window(
        &self,
        _lane: &InLane<InteractiveIo>,
        _id: &ThreadId,
        _head: &HeadRead,
    ) -> Result<WindowRead, CoreError> {
        Ok(WindowRead(Box::new(())))
    }

    /// No checkpoint: every record is tail, folded by the session's own fold.
    fn decode(
        &self,
        _lane: &InLane<CpuInteractive>,
        _id: &ThreadId,
        head: HeadRead,
        _window: WindowRead,
    ) -> Result<OpenedLog, CoreError> {
        let records = *head.0.downcast::<Vec<(u64, Record)>>().expect("MemStore head");
        let (header, control, log_id) = match records.first() {
            Some((_, Record::Session(session))) => (
                match &session.header {
                    Slot::Inline(header) => header.clone(),
                    _ => Header::new(),
                },
                session.control,
                session.log_id.as_str().to_owned(),
            ),
            _ => (Header::new(), false, String::new()),
        };
        Ok(OpenedLog {
            header,
            control,
            history_rev: 0,
            lineage_start: 0,
            runs: Vec::new(),
            approvals: Vec::new(),
            queue: Vec::new(),
            window: Vec::new(),
            dividers: Vec::new(),
            has_older: false,
            prompts: Vec::new(),
            log_id,
            next_ordinal: records.last().map_or(0, |(ordinal, _)| ordinal + 1),
            tail: records,
            append: AppendPosition(Box::new(())),
        })
    }

    fn session_meta(
        &self,
        _id: &ThreadId,
    ) -> futures::future::BoxFuture<'static, Result<Option<super::seams::SessionMeta>, CoreError>> {
        let listed = self.listed.load(Ordering::SeqCst);
        Box::pin(async move { Ok(listed.then(super::seams::SessionMeta::default)) })
    }

    fn purge_deleted(&self) -> futures::future::BoxFuture<'static, Result<Vec<String>, CoreError>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn context_io(
        &self,
        _lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        _read: Option<ContextRead>,
    ) -> Result<ContextRead, CoreError> {
        if self.fail_context.swap(false, Ordering::SeqCst) {
            return Err(CoreError::Internal { incident_id: "context-read-failed".into() });
        }
        Ok(ContextRead(Box::new(self.records(id))))
    }

    /// One page: the last compaction's replacement, then the model rows after it.
    fn context_cpu(
        &self,
        _lane: &InLane<CpuInteractive>,
        read: ContextRead,
    ) -> Result<ContextStep, CoreError> {
        let records = *read.0.downcast::<Vec<(u64, Record)>>().expect("MemStore context");
        let mut out = Vec::new();
        for (_, record) in records {
            match record {
                Record::Compacted(compacted) => {
                    out = match compacted.replacement {
                        Slot::Inline(entries) => entries
                            .into_iter()
                            .map(|e| (ItemId::from(e.iid), e.body))
                            .collect(),
                        _ => Vec::new(),
                    };
                }
                Record::Item(item) if item.model => {
                    if let Slot::Inline(body) = item.body {
                        out.push((ItemId::from(item.iid.as_str().to_owned()), body));
                    }
                }
                // An amended row reads as its amend body, as the real store's context rows do.
                Record::Amend(amend) => {
                    if let (Slot::Inline(body), Some(row)) = (amend.body, out.iter_mut().find(|(iid, _)| iid.as_str() == amend.iid.as_str())) {
                        row.1 = body;
                    }
                }
                _ => {}
            }
        }
        Ok(ContextStep::Done(out))
    }

    fn open_log(
        &self,
        _lane: &InLane<DurabilityIo>,
        id: &ThreadId,
        _at: AppendPosition,
    ) -> Result<Box<dyn SessionLog>, BarrierError> {
        Ok(Box::new(MemLog {
            log: self.log(id),
            fail_next: self.fail_next.clone(),
            commit_gate: self.commit_gate.clone(),
        }))
    }

    fn create_log(
        &self,
        lane: &InLane<DurabilityIo>,
        id: &ThreadId,
        session: &CommitRecord,
    ) -> Result<(Box<dyn SessionLog>, u64), BarrierError> {
        let gate = lock(&self.create_gate).take();
        if let Some((arrived, go)) = gate {
            arrived.notify_one();
            let _ = go.recv();
        }
        let mut log = MemLog {
            log: self.log(id),
            fail_next: self.fail_next.clone(),
            commit_gate: self.commit_gate.clone(),
        };
        let ordinal = log.commit(lane, std::slice::from_ref(session))?[0];
        Ok((Box::new(log), ordinal))
    }

    /// Rewinds cut the lineage, as the real store reads it.
    fn user_rows(
        &self,
        _lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<Vec<ItemRecord>, CoreError> {
        let mut rows: Vec<(u64, ItemRecord)> = Vec::new();
        for (ordinal, record) in self.records(id) {
            match record {
                Record::Item(item) if item.role.as_ref().is_some_and(|r| r.as_str() == "user") => {
                    rows.push((ordinal, item));
                }
                Record::Rewind(rewind) => rows.retain(|(o, _)| *o < rewind.to_ordinal),
                _ => {}
            }
        }
        Ok(rows.into_iter().map(|(_, row)| row).collect())
    }

    fn fenced_ops(&self, _lane: &InLane<InteractiveIo>, _id: &ThreadId) -> Result<Vec<String>, CoreError> {
        Ok(Vec::new())
    }

    /// The in-memory store keeps no op index.
    fn thread_op(&self, _lane: &InLane<InteractiveIo>, _id: &ThreadId, _op: &str) -> Result<Option<super::seams::StoredOp>, CoreError> {
        Ok(None)
    }

    fn history_rows(
        &self,
        _lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<(u64, Vec<ItemRecord>), CoreError> {
        let records = self.records(id);
        if records.is_empty() {
            return Err(CoreError::ThreadNotFound { thread_id: id.clone() });
        }
        let mut rows: Vec<(u64, ItemRecord)> = Vec::new();
        let mut rev = 0;
        for (ordinal, record) in records {
            match record {
                Record::Item(item) => rows.push((ordinal, item)),
                Record::Amend(amend) => amend_row(&mut rows, &amend),
                Record::Rewind(rewind) => {
                    rev += 1;
                    rows.retain(|(o, _)| *o < rewind.to_ordinal);
                }
                _ => {}
            }
        }
        Ok((rev, rows.into_iter().map(|(_, row)| row).collect()))
    }

    fn history_row(
        &self,
        _lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<(u64, ItemRecord)>, CoreError> {
        Ok(self.live_row(id, iid))
    }

    /// The newest compaction a rewind left live with the entry inline, as the real reader.
    fn compaction_entry(
        &self,
        _lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        iid: &str,
    ) -> Result<Option<mixdog_store::sqlite::CompactionEntry>, CoreError> {
        let mut frames: Vec<mixdog_store::sqlite::CompactionEntry> = Vec::new();
        for (ordinal, record) in self.records(id) {
            match record {
                Record::Compacted(c) => {
                    if matches!(&c.replacement, Slot::Inline(entries) if entries.iter().any(|e| e.iid == iid)) {
                        frames.push(mixdog_store::sqlite::CompactionEntry { ordinal, cid: c.cid.as_str().to_owned() });
                    }
                }
                Record::Rewind(rewind) => frames.retain(|f| f.ordinal < rewind.to_ordinal),
                _ => {}
            }
        }
        Ok(frames.pop())
    }
}

/// An amend replaces the body (and blob refs) of its live row, as the real store's readers see it.
fn amend_row(rows: &mut [(u64, ItemRecord)], amend: &mixdog_store::schema::record::AmendRecord) {
    if let Some((_, row)) = rows.iter_mut().find(|(_, row)| row.iid.as_str() == amend.iid.as_str()) {
        row.body = amend.body.clone();
    }
}

impl MemStore {
    /// The live item `iid` with its ordinal, its boundaries folded in as the real reader does.
    fn live_row(&self, id: &ThreadId, iid: &str) -> Option<(u64, ItemRecord)> {
        let mut rows: Vec<(u64, ItemRecord)> = Vec::new();
        let mut switches = Vec::new();
        for (ordinal, record) in self.records(id) {
            match record {
                Record::Item(item) => rows.push((ordinal, item)),
                Record::Amend(amend) => amend_row(&mut rows, &amend),
                Record::Rewind(rewind) => rows.retain(|(o, _)| *o < rewind.to_ordinal),
                Record::ModelSwitch(switch) => switches.push(switch),
                _ => {}
            }
        }
        let (ordinal, mut row) = rows.into_iter().find(|(_, row)| row.iid.as_str() == iid)?;
        let entries: Vec<_> = switches
            .into_iter()
            .filter(|s| s.anchor.ordinal == ordinal && s.anchor.iid.as_str() == iid)
            .filter_map(|s| match s.entry {
                Slot::Inline(entry) => Some(entry),
                Slot::Blob(_) => None,
            })
            .collect();
        super::transcript::fold_model_switches(&mut row, &entries);
        Some((ordinal, row))
    }

    /// Seeds a log with records as if a writer had committed them.
    pub fn seed(&self, id: &ThreadId, records: Vec<Record>) {
        let log = self.log(id);
        let mut log = lock(&log);
        let mut next = log.last().map_or(0, |(ordinal, _)| ordinal + 1);
        for record in records {
            log.push((next, record));
            next += 1;
        }
    }
}


/// User rows show `{text}` bodies as a text part; every other row as an agent message.
pub struct TextTranscript;

impl Transcript for TextTranscript {
    /// The test rows are their items' own JSON.
    fn rows(&self, lane: &InLane<CpuInteractive>, record: &ItemRecord) -> Vec<(ThreadItem, usize)> {
        self.items(lane, record)
            .into_iter()
            .filter_map(|shown| match shown {
                Shown::Item(item) => {
                    let bytes = serde_json::to_vec(&item).expect("protocol types serialize").len();
                    Some((item, bytes))
                }
                Shown::Update(_) => None,
            })
            .collect()
    }

    /// A `{toolCallId, text}` body updates the call `call:<toolCallId>` a `{toolCalls}` body
    /// showed.
    fn items(&self, _lane: &InLane<CpuInteractive>, record: &ItemRecord) -> Vec<Shown> {
        let Slot::Inline(body) = &record.body else {
            return Vec::new();
        };
        if let Some(call) = body["toolCallId"].as_str() {
            return vec![Shown::Update(ThreadItem::ToolCall {
                id: format!("call:{call}").as_str().into(),
                name: String::new(),
                input: Value::Null,
                output: None,
                run: Box::new(mixdog_protocol::ToolRun {
                    call_id: Some(call.to_owned()),
                    result: Some(MaybeBlob::Inline(
                        body["text"].as_str().unwrap_or_default().to_owned(),
                    )),
                    ..Default::default()
                }),
                meta: ItemMeta::default(),
            })];
        }
        let mut shown: Vec<Shown> = text_item(record, body).map(Shown::Item).into_iter().collect();
        for call in body["toolCalls"].as_array().into_iter().flatten() {
            shown.push(Shown::Item(ThreadItem::ToolCall {
                id: format!("call:{}", call["id"].as_str().unwrap_or_default()).as_str().into(),
                name: call["name"].as_str().unwrap_or_default().to_owned(),
                input: call["arguments"].clone(),
                output: None,
                run: Box::new(mixdog_protocol::ToolRun { call_id: call["id"].as_str().map(str::to_owned), ..Default::default() }),
                meta: ItemMeta::default(),
            }));
        }
        shown
    }

    fn queued(&self, qid: &str, entry: &Value) -> Value {
        json!({ "id": qid, "text": entry["message"] })
    }

    fn user_message(&self, input: &TurnInput) -> Value {
        match &input.prompt {
            PromptContent::Text(text) => json!({ "role": "user", "content": text }),
            PromptContent::Parts(_) => json!({ "role": "user", "content": "" }),
        }
    }

    fn summary(&self, id: &ThreadId, header: &Header) -> ThreadSummary {
        serde_json::from_value(json!({
            "id": id,
            "preview": "",
            "title": header.get("title").and_then(Value::as_str).unwrap_or_default(),
            "updatedAt": 0,
            "messageCount": 0,
            "cwd": header.get("cwd").and_then(Value::as_str).unwrap_or_default(),
            "classification": {},
            "projectPath": null,
        }))
        .expect("summary shape")
    }
}

/// A `{text}` body's item: a user message for a user row, else an agent message; none for an
/// empty non-user text.
fn text_item(record: &ItemRecord, body: &Value) -> Option<ThreadItem> {
    {
        let text = body["text"].as_str().or(body["content"].as_str()).unwrap_or_default().to_owned();
        if record.role.as_ref().map(|r| r.as_str()) != Some("user") && text.is_empty() {
            return None;
        }
        let meta = ItemMeta {
            turn_id: record.turn.as_ref().map(|turn| TurnId::from(turn.as_str())),
            ..ItemMeta::default()
        };
        let id = record.iid.as_str().into();
        Some(match record.role.as_ref().map(|role| role.as_str()) {
            Some("user") => ThreadItem::UserMessage {
                id,
                content: vec![UserInput::Text { text: text.clone() }],
                device: None,
                client_submission_id: None,
                checkpoint_id: None,
                applied_skills: None,
                display_text: text,
                counts_for_prompt_history: true,
                details: Default::default(),
                meta,
            },
            _ => ThreadItem::AgentMessage {
                id,
                text: MaybeBlob::Inline(text),
                imported_tool_runs: Vec::new(),
                meta,
            },
        })
    }
}

pub type Script =
    Arc<dyn Fn(RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> + Send + Sync>;

/// Runs whose body the test sets.
pub struct ScriptRuns {
    pub script: Mutex<Script>,
}

impl RunFactory for ScriptRuns {
    fn start(&self, run: RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
        let script = lock(&self.script).clone();
        script(run)
    }
}

/// A [`MockFeed`] that also keeps every published frame, decoded.
pub struct RecFeed {
    inner: MockFeed,
    pub frames: Mutex<Vec<(u64, Value)>>,
    published: Arc<tokio::sync::Notify>,
    gate: PublishGate,
    /// This feed's place among the thread's feed instances (one per incarnation), and the shared event log it tells each new toast to.
    instance: usize,
    timeline: Timeline,
    shown: Mutex<std::collections::HashSet<String>>,
}

/// A test's ordered event log, shared by the sources it wants in one sequence.
pub type EventLog = Arc<Mutex<Vec<Value>>>;
pub type Timeline = Arc<Mutex<Option<EventLog>>>;

/// The next publication that carries a toast with this text tells `.1` it arrived, then waits for `.2` before the frames are recorded.
type PublishGate = Arc<Mutex<Option<(String, Arc<tokio::sync::Notify>, std::sync::mpsc::Receiver<()>)>>>;

fn carries_toast(frame: &Value, text: &str) -> bool {
    frame["method"] == "thread/runtime/updated"
        && frame["params"]["value"]["toasts"].as_array().is_some_and(|toasts| toasts.iter().any(|toast| toast["text"] == text))
}

impl FeedSource for RecFeed {
    fn feed_id(&self) -> FeedId {
        self.inner.feed_id()
    }

    fn attach(&self, req: AttachRequest) -> Result<AttachDecision, CoreError> {
        self.inner.attach(req)
    }

    fn detach(&self, sub: SubscriptionId) {
        self.inner.detach(sub)
    }
}

impl Feed for RecFeed {
    fn position(&self) -> FeedPosition {
        self.inner.position()
    }

    fn publish(&self, frames: &[FeedFrame], view: Option<Arc<dyn FeedView>>) -> Result<(), PublishError> {
        let decoded: Vec<(u64, Value)> =
            frames.iter().map(|f| (f.seq, serde_json::from_slice(&f.bytes).expect("frames are JSON"))).collect();
        let held = {
            let mut gate = lock(&self.gate);
            match gate.as_ref() {
                Some((text, ..)) if decoded.iter().any(|(_, frame)| carries_toast(frame, text)) => gate.take(),
                _ => None,
            }
        };
        if let Some((_, arrived, go)) = held {
            arrived.notify_one();
            let _ = go.recv();
        }
        if let Some(log) = lock(&self.timeline).clone() {
            let mut shown = lock(&self.shown);
            for (_, frame) in &decoded {
                if frame["method"] != "thread/runtime/updated" {
                    continue;
                }
                for toast in frame["params"]["value"]["toasts"].as_array().into_iter().flatten() {
                    if shown.insert(toast["id"].as_str().unwrap_or_default().to_owned()) {
                        let label = char::from(b'A' + self.instance as u8).to_string();
                        lock(&log).push(json!({ "notice": { "text": toast["text"], "tone": toast["tone"] }, "incarnation": label }));
                    }
                }
            }
        }
        lock(&self.frames).extend(decoded);
        let published = self.inner.publish(frames, view);
        self.published.notify_waiters();
        published
    }
}

/// The turns' workspace admissions: `admit:<thread>` when one is admitted, `release:<thread>`
/// when its guard drops; `refuse` answers the next admission with that failure instead.
#[derive(Default)]
pub struct TestAdmission {
    pub seen: Arc<Mutex<Vec<String>>>,
    pub refuse: Mutex<Option<mixdog_scm::error::ScmFailure>>,
}

struct Released(Arc<Mutex<Vec<String>>>, String);

impl Drop for Released {
    fn drop(&mut self) {
        lock(&self.0).push(format!("release:{}", self.1));
    }
}

#[async_trait::async_trait]
impl super::worktree::TurnAdmission for TestAdmission {
    async fn admit(
        &self,
        thread: &str,
        _cwd: super::worktree::Cwd,
        _cancel: &mixdog_rt::CancellationToken,
    ) -> Result<Box<dyn Send>, mixdog_scm::error::ScmFailure> {
        if let Some(failure) = lock(&self.refuse).take() {
            return Err(failure);
        }
        lock(&self.seen).push(format!("admit:{thread}"));
        Ok(Box::new(Released(self.seen.clone(), thread.to_owned())))
    }
}

#[derive(Default)]
pub struct RecFeeds {
    pub feeds: Mutex<HashMap<FeedId, Vec<Arc<RecFeed>>>>,
    /// Wakes whenever any feed took frames: the signal a test waits on instead of polling the clock
    /// (`tests::eventually_on`).
    pub published: Arc<tokio::sync::Notify>,
    /// The next publication of any feed that carries a toast with `.0`'s text tells `.1` it arrived, then waits for `.2`.
    pub publish_gate: PublishGate,
    /// When set, each toast a feed publishes for the first time is told to this log as `{notice: {text, tone}, incarnation}`.
    pub timeline: Timeline,
}

impl RecFeeds {
    /// Every frame of `id`'s feeds in publication order, as `(seq, decoded frame)`: append-only, whatever the newest state is.
    pub fn history(&self, id: &str) -> Vec<(u64, Value)> {
        self.histories(id).into_iter().flatten().collect()
    }

    /// The frames of each feed instance of `id` (one per incarnation of the thread), oldest instance first.
    pub fn histories(&self, id: &str) -> Vec<Vec<(u64, Value)>> {
        let feeds = lock(&self.feeds);
        feeds.get(&FeedId::from(id)).into_iter().flatten().map(|feed| lock(&feed.frames).clone()).collect()
    }

    /// Frames of the newest feed instance of `id`, as `(seq, method, params)`.
    pub fn frames(&self, id: &str) -> Vec<(u64, String, Value)> {
        let feeds = lock(&self.feeds);
        let Some(feed) = feeds.get(&FeedId::from(id)).and_then(|all| all.last()) else {
            return Vec::new();
        };
        lock(&feed.frames)
            .iter()
            .map(|(seq, frame)| {
                (
                    *seq,
                    frame["method"].as_str().unwrap_or_default().to_owned(),
                    frame["params"].clone(),
                )
            })
            .collect()
    }
}

impl FeedFactory for RecFeeds {
    fn thread_feed(&self, id: FeedId, epoch: FeedEpoch, view: Arc<dyn FeedView>) -> Arc<dyn Feed> {
        let instance = lock(&self.feeds).get(&id).map_or(0, Vec::len);
        let feed = Arc::new(RecFeed {
            instance,
            timeline: self.timeline.clone(),
            shown: Mutex::default(),
            inner: MockFeed::new(id.clone(), epoch, view, MockLimits::default()),
            frames: Mutex::new(Vec::new()),
            published: self.published.clone(),
            gate: self.publish_gate.clone(),
        });
        lock(&self.feeds).entry(id).or_default().push(feed.clone());
        feed
    }
}

#[derive(Default)]
pub struct Counter(AtomicU64);

#[async_trait::async_trait]
impl ApprovalIds for Counter {
    async fn next(&self) -> Result<ApprovalId, CoreError> {
        Ok(ApprovalId(self.0.fetch_add(1, Ordering::SeqCst) + 1))
    }
}

pub struct NamedDevices;

impl Devices for NamedDevices {
    fn describe(&self, connection: ConnectionId) -> DeviceInfo {
        DeviceInfo {
            device: format!("desktop-{connection}"),
            kind: ConnectionKind::Desktop,
        }
    }
}

pub struct FixedClock(pub AtomicU64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst) as i64
    }
}

/// The surface follows the header's persisted `disallowedTools`.
pub struct HeaderSurfaces;

/// A new thread keeps the header it was started with (no tool pool behind it).
pub struct KeepHeader;

#[async_trait::async_trait]
impl super::NewThreadTools for KeepHeader {
    async fn seed(&self, _: &ThreadId, header: &Header) -> Result<Header, String> {
        Ok(header.clone())
    }
}

/// An emptied thread's surface is always rebuilt (no surface host behind it).
pub struct NoEmptySurface;

#[async_trait::async_trait]
impl super::EmptyToolSurface for NoEmptySurface {
    async fn refresh_empty(&self, _: &ThreadId) -> Result<bool, String> {
        Ok(true)
    }
}

/// A new thread begins with no route of its own (no route service behind it).
pub struct NoRoute;

#[async_trait::async_trait]
impl super::NewThreadRoute for NoRoute {
    async fn adopt(&self, _: &ThreadId, _: Option<&serde_json::Map<String, serde_json::Value>>) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        Ok(serde_json::Map::new())
    }

    async fn adopt_control(&self, _: &ThreadId) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        Ok(serde_json::Map::new())
    }

    async fn seat(&self, _: &ThreadId) -> Result<(), String> {
        Ok(())
    }
}

/// A task workspace that is a fixed path (no folder is made).
pub struct FixedTaskWorkspace(pub &'static str);

#[async_trait::async_trait]
impl super::TaskWorkspace for FixedTaskWorkspace {
    async fn path(&self) -> Result<String, String> {
        Ok(self.0.to_owned())
    }
}

/// A new-thread place with fixed Projects that records the worktree steps it is asked for (thread, worktree, input).
#[derive(Default)]
pub struct RecordingPlace {
    pub projects: Vec<String>,
    pub entered: std::sync::Mutex<Vec<(String, Value, Option<Value>)>>,
}

#[async_trait::async_trait]
impl super::NewThreadPlace for RecordingPlace {
    async fn projects(&self) -> Result<Vec<String>, String> {
        Ok(self.projects.clone())
    }

    async fn enter_worktree(
        &self,
        thread: &ThreadId,
        worktree: &Value,
        input: Option<&Value>,
        _: &mixdog_rt::CancellationToken,
    ) -> Result<(), mixdog_core_api::CoreError> {
        self.entered.lock().expect("entered").push((thread.as_str().to_owned(), worktree.clone(), input.cloned()));
        Ok(())
    }
}

/// The rooms whose members' handed-off questions moved, and the member approvals resolved
/// (`room:approval`), in order.
#[derive(Default)]
pub struct TestRoomMembers {
    pub moved: Mutex<Vec<String>>,
    pub resolved: Mutex<Vec<String>>,
}

impl super::RoomMemberEvents for TestRoomMembers {
    fn questions_moved(&self, room_id: &str) {
        lock(&self.moved).push(room_id.to_owned());
    }
    fn approval_resolved(&self, room_id: &str, approval_id: &str) {
        lock(&self.resolved).push(format!("{room_id}:{approval_id}"));
    }
}

/// The resumed-thread tool refreshes the rig was asked for, and the change it answers each with.
#[derive(Default)]
pub struct TestResumedTools {
    pub asked: Mutex<Vec<String>>,
    pub change: Mutex<Option<mixdog_store::schema::record::HeaderChange>>,
}

#[async_trait::async_trait]
impl super::ResumedTools for TestResumedTools {
    async fn refreshed(&self, thread: &ThreadId, _: &Header) -> Option<mixdog_store::schema::record::HeaderChange> {
        lock(&self.asked).push(thread.as_str().to_owned());
        lock(&self.change).clone()
    }
}

impl ToolSurfaceSource for HeaderSurfaces {
    fn surface(&self, _thread: &ThreadId, header: &Header) -> SessionSurface {
        SessionSurface {
            disallowed: header
                .get("disallowedTools")
                .and_then(Value::as_array)
                .map(|names| {
                    names
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            ..SessionSurface::default()
        }
    }
}

/// The Goal runtime's clock in the test runtime's time domain: wall time from when the Rig was
/// built, advanced by the tokio clock (paused or not), paired with the same clock as its
/// monotonic reading, so a suspend is never inferred.
struct RigGoalClock {
    wall_ms: f64,
    start: tokio::time::Instant,
}

impl RigGoalClock {
    fn new() -> Self {
        let wall_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |since| since.as_secs_f64() * 1000.0);
        Self { wall_ms, start: tokio::time::Instant::now() }
    }
}

impl mixdog_core_goal::goal::GoalClock for RigGoalClock {
    fn now(&self) -> f64 {
        self.wall_ms + self.start.elapsed().as_secs_f64() * 1000.0
    }

    fn monotonic(&self) -> Option<f64> {
        Some(self.start.elapsed().as_secs_f64() * 1000.0)
    }
}

/// The Goal runtime's deadlines as tasks of the runtime that arms them: they follow that runtime's
/// clock and die with it, and no callback runs inside another test's runtime.
pub(crate) struct RigGoalTimers;

impl mixdog_core_goal::goal::GoalTimers for RigGoalTimers {
    fn after(&self, _kind: mixdog_core_goal::goal::TimerKind, delay_ms: f64, callback: Box<dyn FnOnce() + Send>) -> mixdog_core_goal::goal::Timer {
        let cancel = mixdog_rt::CancellationToken::new();
        let stop = cancel.clone();
        let delay = std::time::Duration::from_secs_f64(delay_ms.max(0.0) / 1000.0);
        drop(tokio::spawn(async move {
            tokio::select! {
                () = stop.cancelled() => {}
                () = tokio::time::sleep(delay) => callback(),
            }
        }));
        mixdog_core_goal::goal::Timer::new(move || cancel.cancel())
    }
}

/// One wired session stack over shared doubles.
pub struct Rig {
    pub store: Arc<MemStore>,
    /// The real file store over a temp data dir.
    pub prompts: Arc<FilePromptHistory>,
    /// Holds the temp data dir for the rig's lifetime.
    pub _data: tempfile::TempDir,
    pub runs: Arc<ScriptRuns>,
    pub feeds: Arc<RecFeeds>,
    pub sink: Arc<MockServerRequests>,
    pub clock: Arc<FixedClock>,
    pub turn_starts: Arc<super::LateTurnStarts>,
    /// Every turn's workspace admission and its release, in order.
    pub admissions: Arc<TestAdmission>,
    pub wakes: Arc<mixdog_tools::exec::WakeHub>,
    pub prewarms: Arc<Prewarms>,
    /// The warmer's turn notes: each turn's `cacheWarmTurnKind` input, and how many ended.
    pub warms: Arc<RecWarmth>,
    /// The built-in skill names the turns read (None: the status cannot be read).
    pub builtin_skills: Arc<TestBuiltinSkills>,
    pub ingests: Arc<Ingests>,
    pub closes: Arc<Closes>,
    pub sensitive: Arc<mixdog_services::memory::sensitive::SensitiveStore>,
    /// What deletes did outside the session, in order.
    pub deletes: Arc<Deletes>,
    /// The snapshot releases, stops and the dispose, in order.
    pub snapshots: Arc<TestSnapshots>,
    /// The notice events, in order.
    pub notices: Arc<TestNotices>,
    /// The real Goal runtime over the temp data dir.
    pub goals: mixdog_core_goal::goal::GoalRuntime,
    /// The session's todo list, and the background work it waits on, as a Goal continuation
    /// reads them.
    pub todos: Arc<TestTodos>,
    pub work: Arc<TestWork>,
    /// The agent status every session reads after a job of it changed.
    pub agents: Arc<TestAgents>,
    /// The code-graph prewarm calls the actors made, in order.
    pub code_graph: Arc<TestCodeGraphPrewarm>,
    /// The resumed-thread tool refreshes (`SessionDeps.resumed_tools`).
    pub resumed: Arc<TestResumedTools>,
    /// `SessionDeps.room_members`.
    pub room_members: Arc<TestRoomMembers>,
    /// The agent-status signals the actors emitted, in order.
    pub signals: Arc<TestSignals>,
    /// The side-question store `thread/askSide` reads.
    pub side: Arc<TestSide>,
    /// The heir-route policy `thread/inheritancePreflight` measures on.
    pub inherit: Arc<TestInherit>,
    /// The compaction engine `thread/compact/start` calls.
    pub compaction: Arc<TestCompaction>,
    /// The quota-resume queue over the temp data dir.
    pub quota: Arc<mixdog_core_base::quota_resume::QuotaResumeStore>,
    /// The route change a clear reads its environment reset from.
    pub route_change: Arc<ResetRouteChange>,
}

/// The host's route change as far as a clear reads it: no route change of its own, and the
/// environment reset a clear writes.
pub struct ResetRouteChange;

#[async_trait::async_trait]
impl super::route_session::RouteChange for ResetRouteChange {
    fn route_change(&self, _: &Header, _: &mixdog_core_ports::ports::route::Route, _: &mixdog_core_ports::ports::route::Route, _: bool, _: &super::route_session::RouteLookups) -> mixdog_store::schema::record::HeaderChange {
        mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: Vec::new() }
    }

    fn environment_reset(&self, _: &Header) -> mixdog_store::schema::record::HeaderChange {
        let mut set = serde_json::Map::new();
        set.insert("promptEnv".into(), json!("tail"));
        set.insert("sessionStartMetaInjected".into(), json!(false));
        mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }
    }
}

/// An in-memory todo list shared by every thread of the rig.
#[derive(Default)]
pub struct TestTodos(pub Mutex<mixdog_tools::state::todo::TodoList>);

#[async_trait::async_trait]
impl mixdog_tools::state::todo::TodoStore for TestTodos {
    async fn read(&self, _: &ThreadId) -> mixdog_tools::state::todo::TodoList {
        lock(&self.0).clone()
    }

    async fn update(
        &self,
        _: &ThreadId,
        _: &mut mixdog_tools::state::todo::TodoEdit<'_>,
    ) -> Result<(), String> {
        Err("the rig's list is set directly".into())
    }

    fn note_user_wait(&self, _: &ThreadId) {}

    fn user_waiting(&self, _: &ThreadId) -> bool {
        false
    }

    fn turn_started(&self, _: &ThreadId) {}
}

/// Whether a background task is running: every session waits on it while set.
#[derive(Default)]
pub struct TestWork(pub AtomicBool);

#[async_trait::async_trait]
impl mixdog_core_run::run_host::guards::RunningWork for TestWork {
    async fn has_active(&self, _: &str, surface: &str, _: bool, _: Option<u64>) -> bool {
        surface == "agent" && self.0.load(Ordering::SeqCst)
    }
}

/// The agent-status signals, in order: `approval:<id>`, `record:<id>`.
#[derive(Default)]
pub struct TestSignals(pub Mutex<Vec<String>>);

impl super::agent_activity::AgentSignals for TestSignals {
    fn approval_wait(&self, session: &str) {
        lock(&self.0).push(format!("approval:{session}"));
    }
    fn session_record(&self, session: &str) {
        lock(&self.0).push(format!("record:{session}"));
    }
}

/// The code-graph prewarm calls, in order: `wake`, `schedule:<reason>:<delay ms|default>`;
/// `lazy` answers `lazy()`.
#[derive(Default)]
pub struct TestCodeGraphPrewarm {
    pub calls: Mutex<Vec<String>>,
    pub lazy: AtomicBool,
}

impl super::prewarm_signals::CodeGraphPrewarmSignals for TestCodeGraphPrewarm {
    fn schedule(&self, delay: Option<std::time::Duration>, reason: &'static str) {
        let delay = delay.map_or_else(|| "default".to_owned(), |d| d.as_millis().to_string());
        lock(&self.calls).push(format!("schedule:{reason}:{delay}"));
    }
    fn wake(&self) {
        lock(&self.calls).push("wake".to_owned());
    }
    fn lazy(&self) -> bool {
        self.lazy.load(Ordering::SeqCst)
    }
}

/// The agent status the rig answers, and the threads it was read for, in order.
#[derive(Default)]
pub struct TestAgents {
    pub status: Mutex<mixdog_app_protocol::v2::thread::ThreadAgents>,
    pub reads: Mutex<Vec<ThreadId>>,
}

#[async_trait::async_trait]
impl super::agent_activity::AgentStatus for TestAgents {
    async fn status(&self, thread: &ThreadId) -> mixdog_app_protocol::v2::thread::ThreadAgents {
        lock(&self.reads).push(thread.clone());
        lock(&self.status).clone()
    }
}

/// The delete seams and purge hooks, recording each call as `<step>:<session>[:<detail>]`; the
/// sessions whose MCP scope was released are kept apart, in order. The last three are what the
/// idle delete asks of its runtime: the session it has current, whether the caller gave no
/// `isHostedBusy` guard, and whether a hosting runtime holds input for the session.
#[derive(Default)]
pub struct Deletes(
    pub Mutex<Vec<String>>,
    pub tokio::sync::Notify,
    pub Mutex<Vec<String>>,
    pub Mutex<Option<String>>,
    pub Mutex<bool>,
    pub Mutex<bool>,
);

impl Deletes {
    fn note(&self, step: String) {
        lock(&self.0).push(step);
        self.1.notify_waiters();
    }
}

struct Hook(&'static str, Arc<Deletes>);

impl super::delete::PurgeHook for Hook {
    fn purge(&self, session_id: &str, cwds: &[String]) -> futures::future::BoxFuture<'static, ()> {
        self.1.note(format!("{}:{session_id}:{}", self.0, cwds.join(",")));
        Box::pin(std::future::ready(()))
    }
}

#[async_trait::async_trait]
impl super::delete::DeleteSeams for Deletes {
    async fn release_session_work(&self, session_id: &str, reason: &str) {
        self.note(format!("releaseSessionWork:{session_id}:{reason}"));
    }
    fn session_closed(&self, session_id: &str, reason: &str, _: &mixdog_store::schema::record::Header, _: i64) {
        self.note(format!("sessionClosed:{session_id}:{reason}"));
    }
    fn release_mcp_scope(&self, session_id: &str) {
        lock(&self.2).push(session_id.to_owned());
    }
    fn forget_session_search(&self, session_id: &str) {
        self.note(format!("forgetSessionSearch:{session_id}"));
    }
    async fn release_deleted_worktree(&self, session_id: &str) {
        self.note(format!("releaseDeletedWorktree:{session_id}"));
    }
    fn thread_deleted(&self, thread: &ThreadId) {
        self.note(format!("thread/deleted:{thread}"));
    }
    fn current_session(&self) -> Option<String> {
        lock(&self.3).clone()
    }
    fn hosted_busy(&self, _: &str) -> Option<bool> {
        (!*lock(&self.4)).then(|| *lock(&self.5))
    }
}

impl Rig {
    fn purge_hooks(&self) -> super::delete::PurgeHooks {
        let hook = |name: &'static str| -> Arc<dyn super::delete::PurgeHook> { Arc::new(Hook(name, self.deletes.clone())) };
        super::delete::PurgeHooks {
            transcript_export: hook("transcriptExport"),
            tool_result_offload: hook("toolResultOffload"),
            transcripts: hook("transcripts"),
            cache_warm: hook("cacheWarm"),
            read_cache: hook("readCache"),
            provider_connections: hook("providerConnections"),
            connector_accounts: hook("connectorAccounts"),
            worker_turns: hook("workerTurns"),
            agent_status: hook("agentStatus"),
            compaction_archive: hook("compactionArchive"),
            scratch_dir: hook("scratchDir"),
            retention: hook("retention"),
        }
    }
}

/// The close-time memory ingests, in order; each waits `delay` before it records.
#[derive(Default)]
pub struct Closes {
    pub seen: Arc<Mutex<Vec<(ThreadId, Vec<Value>)>>>,
    pub delay: Mutex<std::time::Duration>,
    /// When set, each ingest tells this log `{teardown: "done"}` as it ends.
    pub timeline: Mutex<Option<EventLog>>,
    /// Told (one permit each) as an ingest ends.
    pub ended: Arc<tokio::sync::Notify>,
}

impl super::CloseIngest for Closes {
    fn ingest(&self, id: &ThreadId, _cwd: &str, messages: Vec<Value>) -> futures::future::BoxFuture<'static, ()> {
        let (seen, id, delay, timeline) = (self.seen.clone(), id.clone(), *lock(&self.delay), lock(&self.timeline).clone());
        let ended = self.ended.clone();
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            lock(&seen).push((id, messages));
            if let Some(log) = timeline {
                lock(&log).push(json!({ "teardown": "done" }));
            }
            ended.notify_one();
        })
    }
}

/// The session-search ingests, in order: each thread and its messages.
#[derive(Default)]
pub struct Ingests(pub Mutex<Vec<(ThreadId, Vec<Value>)>>);

impl super::TurnIngest for Ingests {
    fn ingest_turn(&self, id: &ThreadId, _header: &Header, messages: Vec<Value>) {
        lock(&self.0).push((id.clone(), messages));
    }
}

/// Each turn the warmer was told of.
#[derive(Default)]
pub struct RecWarmth {
    pub begun: Mutex<Vec<(ThreadId, Value, Option<Value>)>>,
    pub ended: Arc<std::sync::atomic::AtomicUsize>,
}

struct Ended(Arc<std::sync::atomic::AtomicUsize>);

impl Drop for Ended {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// The built-in skills the rig reports.
#[derive(Default)]
pub struct TestBuiltinSkills(pub Mutex<Option<std::collections::HashSet<String>>>);

impl super::BuiltinSkills for TestBuiltinSkills {
    fn names(&self) -> Option<std::collections::HashSet<String>> {
        lock(&self.0).clone()
    }
}

impl super::turn_warm::TurnWarmth for RecWarmth {
    fn begin(&self, thread: &ThreadId, input: &Value, messages: Option<&Value>) -> Box<dyn Send> {
        lock(&self.begun).push((thread.clone(), input.clone(), messages.cloned()));
        Box::new(Ended(self.ended.clone()))
    }
}

/// The threads the effort judge was prewarmed for, in order.
#[derive(Default)]
pub struct Prewarms(pub Mutex<Vec<ThreadId>>);

impl super::EffortPrewarm for Prewarms {
    fn prewarm(&self, thread: &ThreadId, _header: &Header) {
        lock(&self.0).push(thread.clone());
    }
}

/// The turn snapshot calls, in order: `settled:<thread>`, `stopped:<thread>`, `dispose`.
#[derive(Default)]
pub struct TestSnapshots(pub Mutex<Vec<String>>);

impl super::turn_snapshots::TurnSnapshots for TestSnapshots {
    fn turn_settled(&self, thread: &ThreadId) {
        lock(&self.0).push(format!("settled:{}", thread.as_str()));
    }

    fn runtime_stopped(&self, thread: &ThreadId) {
        lock(&self.0).push(format!("stopped:{}", thread.as_str()));
    }

    fn dispose(&self) {
        lock(&self.0).push("dispose".to_owned());
    }
}

/// The notice events, in order: `completed:<provider>`, `failed:<provider>:<kind>`, `save-failed`.
#[derive(Default)]
pub struct TestNotices(pub Mutex<Vec<String>>);

impl super::notices::SessionNotices for TestNotices {
    fn turn_completed(&self, provider: &str) {
        lock(&self.0).push(format!("completed:{provider}"));
    }

    fn turn_failed(&self, provider: &str, kind: Option<&str>) {
        lock(&self.0).push(format!("failed:{provider}:{}", kind.unwrap_or("-")));
    }

    fn save_failed(&self) {
        lock(&self.0).push("save-failed".to_owned());
    }
}

impl Rig {
    pub fn new() -> Self {
        let store = Arc::new(MemStore::default());
        let idle: Script = Arc::new(|_run| Box::pin(async { RunOutcome::Completed(Default::default()) }));
        let data = tempfile::tempdir().expect("temp data dir");
        // The goal runtime's time and timers are the test runtime's own (`GoalEnv::system` would
        // use std time and the process-global ticker, which belongs to whichever test runtime
        // first touched it).
        let goals = mixdog_core_goal::goal::GoalRuntime::new(
            mixdog_core_goal::goal::GoalConfig::new(data.path().join("goals").to_string_lossy().into_owned()),
            mixdog_core_goal::goal::GoalEnv {
                clock: Arc::new(RigGoalClock::new()),
                timers: Arc::new(RigGoalTimers),
                ..mixdog_core_goal::goal::GoalEnv::system(mixdog_rt::testing::tokens().durability_io)
            },
        );
        // The open is one lane job, which runs on the lane's own thread.
        let quota = futures::executor::block_on(mixdog_core_base::quota_resume::QuotaResumeStore::open(
            data.path(),
            mixdog_rt::testing::tokens().durability_io,
            mixdog_rt::CancellationToken::new(),
        ))
        .expect("quota-resume store");
        Self {
            quota: Arc::new(quota),
            route_change: Arc::new(ResetRouteChange),
            goals,
            todos: Arc::default(),
            work: Arc::default(),
            agents: Arc::default(),
            code_graph: Arc::default(),
            resumed: Arc::default(),
            room_members: Arc::default(),
            signals: Arc::default(),
            side: Arc::default(),
            inherit: Arc::default(),
            compaction: Arc::default(),
            prompts: Arc::new(FilePromptHistory::new(data.path())),
            _data: data,
            store,
            runs: Arc::new(ScriptRuns {
                script: Mutex::new(idle),
            }),
            feeds: Arc::new(RecFeeds::default()),
            sink: Arc::new(MockServerRequests::default()),
            clock: Arc::new(FixedClock(AtomicU64::new(1000))),
            turn_starts: Arc::default(),
            admissions: Arc::default(),
            wakes: mixdog_tools::exec::WakeHub::new(),
            prewarms: Arc::default(),
            warms: Arc::default(),
            builtin_skills: Arc::default(),
            ingests: Arc::default(),
            closes: Arc::default(),
            sensitive: Arc::default(),
            deletes: Arc::default(),
            snapshots: Arc::default(),
            notices: Arc::default(),
        }
    }

    pub fn set_script(&self, script: Script) {
        *lock(&self.runs.script) = script;
    }

    pub fn deps(&self) -> Arc<SessionDeps> {
        self.deps_on(self.store.clone())
    }

    /// The stack over another thread store (the real one over a temp data dir).
    pub fn deps_on(&self, store: Arc<dyn ThreadStore>) -> Arc<SessionDeps> {
        Arc::new(self.deps_parts(store))
    }

    /// The stack's parts, for a test that swaps one of them.
    pub fn deps_parts(&self, store: Arc<dyn ThreadStore>) -> SessionDeps {
        let tokens = mixdog_rt::testing::tokens();
        SessionDeps {
            store,
            codec: Arc::new(super::store::StoreCodec),
            transcript: Arc::new(TextTranscript),
            prompts: self.prompts.clone(),
            runs: self.runs.clone(),
            surfaces: Arc::new(HeaderSurfaces),
            new_tools: Arc::new(KeepHeader),
            surface: mixdog_core_base::surface::SurfaceGeneration::default(),
            new_route: Arc::new(NoRoute),
            empty_surface: Arc::new(NoEmptySurface),
            task_workspace: Arc::new(FixedTaskWorkspace("/tasks")),
            new_place: Arc::new(RecordingPlace::default()),
            resumed_tools: self.resumed.clone(),
            room_members: self.room_members.clone(),
            wakes: self.wakes.clone(),
            effort: self.prewarms.clone(),
            search: self.ingests.clone(),
            memory: self.closes.clone(),
            sensitive: Arc::new(super::store::SensitiveMarksOf(self.sensitive.clone())),
            user_cwd: super::UserCwd::new(self._data.path(), tokens.interactive_io),
            attachments: super::user_facts::AttachmentStore(self._data.path().to_path_buf()),
            staged_originals: Arc::new(super::staged_originals::StagedOriginals::new(self._data.path())),
            feeds: self.feeds.clone(),
            turn_admission: self.admissions.clone(),
            server_requests: self.sink.clone(),
            approval_ids: Arc::new(Counter::default()),
            devices: Arc::new(NamedDevices),
            clock: self.clock.clone(),
            turn_starts: self.turn_starts.clone(),
            runtime_hooks: Arc::new(super::runtime_hooks::NoRuntimeHooks),
            snapshots: self.snapshots.clone(),
            notices: self.notices.clone(),
            turn_review: Arc::new(mixdog_core_review::turn_review::testing::test_review(&self._data.path().join("turn-review"))),
            route_change: self.route_change.clone(),
            deletion: self.deletes.clone(),
            purge: self.purge_hooks(),
            goals: Arc::new(self.goals.clone()),
            todos: self.todos.clone(),
            work: self.work.clone(),
            agent_status: self.agents.clone(),
            code_graph_prewarm: self.code_graph.clone(),
            agent_signals: self.signals.clone(),
            side: self.side.clone(),
            inherit: self.inherit.clone(),
            compaction: self.compaction.clone(),
            cycles: Arc::default(),
            quota: super::quota_lane::SessionQuota {
                goals: mixdog_core_goal::goal::quota::GoalQuotaResume::new(self.quota.clone(), Arc::new(self.goals.clone())),
                auto_resume: Arc::new(|| true),
            },
            lanes: SessionLanes {
                cpu: tokens.cpu_interactive,
                io: tokens.interactive_io,
                durability: tokens.durability_io,
            },
            limits: SessionLimits::default(),
            warm: self.warms.clone(),
            builtin_skills: self.builtin_skills.clone(),
        }
    }
}

/// A run's failure on exhausted provider quota with the reset the provider named (epoch milliseconds), built as the run host
/// builds a provider's refusal (`provider_turn_error`).
pub fn quota_error(reset_at: u64) -> mixdog_protocol::TurnError {
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;

    let mut error = ProviderError::new(ErrorKind::QuotaExhausted, DeliveryState::Accepted);
    error.status = Some(429);
    error.code = Some("usage_limit_reached".into());
    error.message = "Usage limit reached".into();
    error.reset_at = Some(std::time::UNIX_EPOCH + std::time::Duration::from_millis(reset_at));
    super::failure_record::provider_turn_error(&error, "anthropic-oauth", Value::Null)
}
