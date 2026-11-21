//! The one seam between the ports and the session runtime: a thread's acked header and the
//! section publication. The directory adapter uses `thread/header/read` and
//! `thread/header/patch` (a `meta` record), which the session serves to internal callers only.

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::PromptRestore;
use mixdog_app_protocol::v2::thread::ProviderAccountChange;
use mixdog_app_protocol::v2::thread::SetupUiRequest;
use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_app_protocol::v2::thread::ThreadApprovals;
use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_app_protocol::v2::thread::ThreadRuntime;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::QuotaResume;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;

#[async_trait]
pub trait ThreadState: Send + Sync {
    /// The thread's acked header; a cold thread is opened.
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError>;
    /// The members of [`header`](Self::header) named in `fields`. A header carries the session's prompt and tool catalog
    /// (megabytes once decoded): a reader of one member takes it from where the header is held, not a copy of all of it.
    async fn header_fields(&self, thread: &ThreadId, fields: &'static [&'static str]) -> Result<Header, PortError> {
        Ok(self.header(thread).await?.into_iter().filter(|(key, _)| fields.contains(&key.as_str())).collect())
    }
    /// What the thread's one writer holds now for `keys` of its header (key to value, `null` for absent): the values a
    /// conditional change is judged against, a value it accepted and has not saved yet included, which
    /// [`header`](Self::header) does not show. A read: nothing is written, and no index is waited for. A cold thread is
    /// opened. Every implementer states its own answer ([`held_of`] for one whose header is all it holds).
    async fn held_fields(&self, thread: &ThreadId, keys: &'static [&'static str]) -> Result<Map<String, Value>, PortError>;
    async fn patch_header(&self, thread: &ThreadId, set: Map<String, Value>, unset: Vec<String>) -> Result<(), PortError>;
    /// A header patch the session actor applies only while `expect` still holds of its header
    /// (key to the value the patch was computed from, `null` for absent). `Ok(Some(current))`
    /// is a refusal: the keys' values now, to compute the patch again from.
    async fn patch_header_if(
        &self,
        thread: &ThreadId,
        expect: Map<String, Value>,
        set: Map<String, Value>,
        unset: Vec<String>,
    ) -> Result<Option<Map<String, Value>>, PortError>;
    async fn publish(&self, thread: &ThreadId, section: Section) -> Result<(), PortError>;
    /// [`patch_header`](Self::patch_header) answered by the journal barrier of the patch's own record, for a caller
    /// that counts the change only once it is stored: a session that keeps a change it could not save answers that
    /// change here as not stored. Every implementer states its own answer: none is assumed stored.
    ///
    /// `Stored` is a barrier receipt, not a publication receipt: the write's own journal record is committed. It says
    /// nothing of the index or of any catalog built from the journal, so a reader of those alone may still see the
    /// value before this write for a while; a caller that shows the change keeps its own copy until its reads show it.
    ///
    /// The thread's one writer decides, on what the write carries ([`HeaderWrite`]) and how often it was submitted
    /// ([`Attempt`]): a journal that is another one, or a header that no longer holds what the write expects, takes
    /// nothing of it (`Superseded`); a refusal before a record was accepted is `Refused`; only an append whose outcome
    /// is unknown, or a submitted operation whose record cannot be read for, is `Indeterminate`. No success is
    /// inferred from a fence, from a conflict, from a change that was dropped, or from the value the header holds.
    async fn store_header(&self, thread: &ThreadId, write: HeaderWrite) -> HeaderStored;
    /// The identity of the journal a thread loaded now is written to, read without waiting; `None` when the thread is
    /// not loaded here. A thread deleted and made again under the same id has another.
    fn log_identity(&self, thread: &ThreadId) -> Option<String>;
}

/// [`ThreadState::held_fields`] of a store that holds nothing but the header it answers: `keys` picked from it.
pub fn held_of(header: &Header, keys: &[&str]) -> Map<String, Value> {
    keys.iter().map(|key| ((*key).to_owned(), header.get(*key).cloned().unwrap_or(Value::Null))).collect()
}

/// One header change a caller counts only once it is stored ([`ThreadState::store_header`]). An operation keeps its
/// identity, its incarnation, its precondition and its change whenever it is submitted again.
#[derive(Clone, Debug, PartialEq)]
pub struct HeaderWrite {
    /// The operation's own identity, carried into the journal record of the change: what answers for it later.
    pub operation: String,
    /// The log identity the change was decided for: applied to that journal alone.
    pub incarnation: String,
    /// The header values the change was decided on (key to value, `null` for absent): applied only while they hold.
    pub expect: Map<String, Value>,
    pub set: Map<String, Value>,
    pub unset: Vec<String>,
    pub attempt: Attempt,
}

/// How an operation reaches [`ThreadState::store_header`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Attempt {
    /// Its first submission.
    First,
    /// It was submitted before and is not known stored. Whatever unknown outcome the thread's log holds is settled
    /// first; the operation's committed record, on the journal it was decided for, answers `Stored` and nothing is
    /// appended; it is appended only when it is known not to have committed and its precondition still holds.
    Replay,
    /// Its fate alone, once the log's unknown outcome is settled: `Stored` when its record is committed, `Refused`
    /// when it is known not to be. Nothing is appended.
    Settle,
}

impl HeaderStored {
    /// The answer of a store whose [`ThreadState::patch_header`] is its write: `Ok` is stored, an error is nothing stored.
    pub fn of_patch(patched: Result<(), PortError>) -> Self {
        match patched {
            Ok(()) => Self::Stored,
            Err(error) => Self::Refused(format!("{error:?}")),
        }
    }
}

/// What became of a [`ThreadState::store_header`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeaderStored {
    /// The write's own journal record is committed.
    Stored,
    /// Nothing of it is stored.
    Refused(String),
    /// Nothing of it is stored, and nothing will be: the journal is another one, or the header no longer holds what
    /// the write was decided on.
    Superseded(String),
    /// Whether its record is committed cannot be told.
    Indeterminate(String),
}

/// A header change computed from the header as the thread's one writer holds it. It takes only
/// the header and returns only the change: it is synchronous and pure.
pub type HeaderUpdate = Box<dyn FnOnce(&Header) -> HeaderChange + Send>;

/// The read-modify-write of a thread's header, done where the header has one writer (the session
/// actor): `update` runs there, on a copy of the header as it stands, and its change is the next
/// record, so no other write can land between the read and the write and nothing is retried.
///
/// The contract of `update`: it runs on the actor's own path, so it must be pure, in-memory work
/// over what it captured before the call: no I/O, no locks, no awaits, no blocking, and it must
/// end. Anything it needs from outside the header is looked up before the call and captured. A
/// panic in it is contained: the caller gets a `Failed` error, nothing is written and the actor
/// goes on.
#[async_trait]
pub trait HeaderUpdates: Send + Sync {
    /// Answers once the change is durable; an empty change writes nothing.
    async fn update_header(&self, thread: &ThreadId, update: HeaderUpdate) -> Result<(), PortError>;
}

pub fn port_error(error: CoreError) -> PortError {
    match error {
        CoreError::ThreadNotFound { thread_id } => {
            PortError::NotFound { target: thread_id.as_str().to_owned(), message: format!("session: {} is unavailable", thread_id.as_str()) }
        }
        other => PortError::Failed { capability: "session".into(), message: format!("{other:?}") },
    }
}

/// One typed section of the thread projection, set by its producer (the run, or the domain
/// that owns the value) and published in order on the thread feed (P §5.1). Sections are view
/// state: a producer that needs a value to survive a reload also writes it to the header.
#[derive(Clone, Debug, PartialEq)]
pub enum Section {
    Runtime(ThreadRuntime),
    /// The `toasts` of the runtime section alone: the whole queue as it stands. The session publishes it (a toast is pushed and expires there); the rest of the section stays as it was.
    Toasts(Vec<Value>),
    /// `activeToolSummary` and `activeTools` of the runtime section alone (active-tool-summary.mjs): the running Shell, Web Research and
    /// Agent calls as the `count:startedAt` summary and the per-tool counts; `None` when none run. The rest of the section stays as it was.
    ActiveTools(Option<(String, Value)>),
    /// `setupChanged` of the runtime section alone (notification-router.mjs): the last settings change this runtime announced, `{ action, seq, at }`.
    SetupChanged(Value),
    /// `progressHint` of the runtime section alone (`None` removes it): the rest of the section stays as it was. Producers of a hint (the running tool, the voice install) publish this, never a whole `Runtime`.
    ProgressHint(Option<Value>),
    /// Fields of the runtime section's `spinner` alone, laid over the spinner it holds (`set({ spinner: { ...spinner, ... } })`);
    /// nothing while no spinner is shown. The rest of the section stays as it was.
    Spinner(serde_json::Map<String, Value>),
    /// `spinner.quiet` of the runtime section alone (`None` clears it): the running turn's quiet state (`turn-quiet.mjs`
    /// `set({ spinner: { ...spinner, quiet } })`). The rest of the section stays as it was.
    SpinnerQuiet(Option<Value>),
    /// `commandBusy` and `commandStatus` of the runtime section alone: a command running under the session's lock (a compaction,
    /// manual or the idle auto-clear), `{ active, verb, startedAt, mode }`; `None` once it ended. The rest of the section stays as it was.
    Command(Option<Value>),
    Route(ThreadRoute),
    /// `turnEffort` of the route section alone (`None` clears it): the effort the turn in flight
    /// runs at. The rest of the section stays as it was.
    TurnEffort(Option<String>),
    Context(ThreadContext),
    Todo(Option<Value>),
    Goal(Option<Value>),
    QuotaResume(Option<QuotaResume>),
    Agents(ThreadAgents),
    ShellJobs(Value),
    Workspace(Option<Value>),
    /// `handoffQuestions`, and `toolApprovalResult` when the producer clears it.
    Approvals(ThreadApprovals),
    PromptRestore(Option<PromptRestore>),
    ProviderAccount(ProviderAccountChange),
    Remote(bool),
    /// The setup tool's desktop request waiting for a claim; `None` once it is claimed or its
    /// window ended.
    SetupUiRequest(Option<SetupUiRequest>),
    /// A group room log's view while the room runs; `None` once the room has neither an
    /// exchange state nor handed-off questions.
    RoomView(Option<mixdog_app_protocol::v2::thread::ThreadRoomView>),
}
