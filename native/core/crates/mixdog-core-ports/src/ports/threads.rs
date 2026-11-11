//! The one seam between the ports and the session runtime: a thread's acked header and the
//! section publication. The directory adapter uses `thread/header/read` and
//! `thread/header/patch` (a `meta` record), which the session serves to internal callers only.

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use mixdog_tools::orch::util::PortError;
use serde_json::Map;
use serde_json::Value;
use mixdog_app_protocol::v2::thread::PromptRestore;
use mixdog_app_protocol::v2::thread::ProviderAccountChange;
use mixdog_app_protocol::v2::thread::SetupUiRequest;
use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_app_protocol::v2::thread::ThreadApprovals;
use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_app_protocol::v2::thread::ThreadRuntime;
use mixdog_app_protocol::v2::thread::ThreadWorkflow;
use mixdog_protocol::QuotaResume;

#[async_trait]
pub trait ThreadState: Send + Sync {
    /// The thread's acked header; a cold thread is opened.
    async fn header(&self, thread: &ThreadId) -> Result<Header, PortError>;
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
        CoreError::ThreadNotFound { thread_id } => PortError::NotFound {
            target: thread_id.as_str().to_owned(),
            message: format!("session: {} is unavailable", thread_id.as_str()),
        },
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
    Route(ThreadRoute),
    Context(ThreadContext),
    Todo(Option<Value>),
    Goal(Option<Value>),
    QuotaResume(Option<QuotaResume>),
    Agents(ThreadAgents),
    ShellJobs(Value),
    Workflow(ThreadWorkflow),
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
