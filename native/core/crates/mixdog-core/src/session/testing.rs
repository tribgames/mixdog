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
use crate::approvals::ApprovalIds;
use crate::approvals::DeviceInfo;
use crate::approvals::Devices;

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Log = Arc<Mutex<Vec<(u64, Record)>>>;

/// Every thread's records in ordinal order.
#[derive(Default)]
pub(crate) struct MemStore {
    logs: Mutex<HashMap<ThreadId, Log>>,
    pub head_reads: AtomicU64,
    /// The next barrier fails (rolled back).
    pub fail_next: Arc<AtomicBool>,
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

struct MemLog {
    log: Log,
    fail_next: Arc<AtomicBool>,
}

impl SessionLog for MemLog {
    fn commit(
        &mut self,
        _lane: &InLane<DurabilityIo>,
        batch: &[CommitRecord],
    ) -> Result<Vec<u64>, BarrierError> {
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
        let (header, log_id) = match records.first() {
            Some((_, Record::Session(session))) => (
                match &session.header {
                    Slot::Inline(header) => header.clone(),
                    _ => Header::new(),
                },
                session.log_id.as_str().to_owned(),
            ),
            _ => (Header::new(), String::new()),
        };
        Ok(OpenedLog {
            header,
            history_rev: 0,
            lineage_start: 0,
            runs: Vec::new(),
            approvals: Vec::new(),
            queue: Vec::new(),
            window: Vec::new(),
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
        Box::pin(async { Ok(None) })
    }

    fn context_io(
        &self,
        _lane: &InLane<InteractiveIo>,
        id: &ThreadId,
        _read: Option<ContextRead>,
    ) -> Result<ContextRead, CoreError> {
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
        }))
    }

    fn create_log(
        &self,
        lane: &InLane<DurabilityIo>,
        id: &ThreadId,
        session: &CommitRecord,
    ) -> Result<(Box<dyn SessionLog>, u64), BarrierError> {
        let mut log = MemLog {
            log: self.log(id),
            fail_next: self.fail_next.clone(),
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

    fn history_rows(
        &self,
        _lane: &InLane<InteractiveIo>,
        id: &ThreadId,
    ) -> Result<Vec<ItemRecord>, CoreError> {
        let records = self.records(id);
        if records.is_empty() {
            return Err(CoreError::ThreadNotFound { thread_id: id.clone() });
        }
        let mut rows: Vec<(u64, ItemRecord)> = Vec::new();
        for (ordinal, record) in records {
            match record {
                Record::Item(item) => rows.push((ordinal, item)),
                Record::Rewind(rewind) => rows.retain(|(o, _)| *o < rewind.to_ordinal),
                _ => {}
            }
        }
        Ok(rows.into_iter().map(|(_, row)| row).collect())
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
    ) -> Result<Option<u64>, CoreError> {
        let mut frames: Vec<u64> = Vec::new();
        for (ordinal, record) in self.records(id) {
            match record {
                Record::Compacted(c) => {
                    if matches!(&c.replacement, Slot::Inline(entries) if entries.iter().any(|e| e.iid == iid)) {
                        frames.push(ordinal);
                    }
                }
                Record::Rewind(rewind) => frames.retain(|o| *o < rewind.to_ordinal),
                _ => {}
            }
        }
        Ok(frames.last().copied())
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
pub(crate) struct TextTranscript;

impl Transcript for TextTranscript {
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
                run: Default::default(),
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

pub(crate) type Script =
    Arc<dyn Fn(RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> + Send + Sync>;

/// Runs whose body the test sets.
pub(crate) struct ScriptRuns {
    pub script: Mutex<Script>,
}

impl RunFactory for ScriptRuns {
    fn start(&self, run: RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
        let script = lock(&self.script).clone();
        script(run)
    }
}

/// A [`MockFeed`] that also keeps every published frame, decoded.
pub(crate) struct RecFeed {
    inner: MockFeed,
    pub frames: Mutex<Vec<(u64, Value)>>,
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
        lock(&self.frames).extend(
            frames
                .iter()
                .map(|f| (f.seq, serde_json::from_slice(&f.bytes).expect("frames are JSON"))),
        );
        self.inner.publish(frames, view)
    }
}

#[derive(Default)]
pub(crate) struct RecFeeds {
    pub feeds: Mutex<HashMap<FeedId, Vec<Arc<RecFeed>>>>,
}

impl RecFeeds {
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
        let feed = Arc::new(RecFeed {
            inner: MockFeed::new(id.clone(), epoch, view, MockLimits::default()),
            frames: Mutex::new(Vec::new()),
        });
        lock(&self.feeds).entry(id).or_default().push(feed.clone());
        feed
    }
}

#[derive(Default)]
pub(crate) struct Counter(AtomicU64);

#[async_trait::async_trait]
impl ApprovalIds for Counter {
    async fn next(&self) -> Result<ApprovalId, CoreError> {
        Ok(ApprovalId(self.0.fetch_add(1, Ordering::SeqCst) + 1))
    }
}

pub(crate) struct NamedDevices;

impl Devices for NamedDevices {
    fn describe(&self, connection: ConnectionId) -> DeviceInfo {
        DeviceInfo {
            device: format!("desktop-{connection}"),
            kind: ConnectionKind::Desktop,
        }
    }
}

pub(crate) struct FixedClock(pub AtomicU64);

impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst) as i64
    }
}

/// The surface follows the header's persisted `disallowedTools`.
pub(crate) struct HeaderSurfaces;

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

/// One wired session stack over shared doubles.
pub(crate) struct Rig {
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
    pub wakes: Arc<mixdog_tools::exec::WakeHub>,
    pub prewarms: Arc<Prewarms>,
    pub ingests: Arc<Ingests>,
    pub closes: Arc<Closes>,
    pub sensitive: Arc<mixdog_services::memory::sensitive::SensitiveStore>,
}

/// The close-time memory ingests, in order; each waits `delay` before it records.
#[derive(Default)]
pub(crate) struct Closes {
    pub seen: Arc<Mutex<Vec<(ThreadId, Vec<Value>)>>>,
    pub delay: Mutex<std::time::Duration>,
}

impl super::CloseIngest for Closes {
    fn ingest(&self, id: &ThreadId, _cwd: &str, messages: Vec<Value>) -> futures::future::BoxFuture<'static, ()> {
        let (seen, id, delay) = (self.seen.clone(), id.clone(), *lock(&self.delay));
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            lock(&seen).push((id, messages));
        })
    }
}

/// The session-search ingests, in order: each thread and its messages.
#[derive(Default)]
pub(crate) struct Ingests(pub Mutex<Vec<(ThreadId, Vec<Value>)>>);

impl super::TurnIngest for Ingests {
    fn ingest_turn(&self, id: &ThreadId, _header: &Header, messages: Vec<Value>) {
        lock(&self.0).push((id.clone(), messages));
    }
}

/// The threads the effort judge was prewarmed for, in order.
#[derive(Default)]
pub(crate) struct Prewarms(pub Mutex<Vec<ThreadId>>);

impl super::EffortPrewarm for Prewarms {
    fn prewarm(&self, thread: &ThreadId, _header: &Header) {
        lock(&self.0).push(thread.clone());
    }
}

impl Rig {
    pub fn new() -> Self {
        let store = Arc::new(MemStore::default());
        let idle: Script = Arc::new(|_run| Box::pin(async { RunOutcome::Completed(Default::default()) }));
        let data = tempfile::tempdir().expect("temp data dir");
        Self {
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
            wakes: mixdog_tools::exec::WakeHub::new(),
            prewarms: Arc::default(),
            ingests: Arc::default(),
            closes: Arc::default(),
            sensitive: Arc::default(),
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
            wakes: self.wakes.clone(),
            effort: self.prewarms.clone(),
            search: self.ingests.clone(),
            memory: self.closes.clone(),
            sensitive: Arc::new(super::store::SensitiveMarksOf(self.sensitive.clone())),
            user_cwd: super::UserCwd::new(self._data.path()),
            attachments: Arc::new(super::user_facts::DataBlobs(self._data.path().to_path_buf())),
            feeds: self.feeds.clone(),
            server_requests: self.sink.clone(),
            approval_ids: Arc::new(Counter::default()),
            devices: Arc::new(NamedDevices),
            clock: self.clock.clone(),
            turn_starts: self.turn_starts.clone(),
            turn_review: Arc::new(crate::turn_review::test_review(&self._data.path().join("turn-review"))),
            lanes: SessionLanes {
                cpu: tokens.cpu_interactive,
                io: tokens.interactive_io,
                durability: tokens.durability_io,
            },
            limits: SessionLimits::default(),
        }
    }
}
