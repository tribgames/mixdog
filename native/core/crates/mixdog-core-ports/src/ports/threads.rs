//! The one seam between the ports and the session runtime: a thread's acked header and the
//! section publication. The directory adapter uses `thread/header/read` and
//! `thread/header/patch` (a `meta` record), which the session serves to internal callers only.

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
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
    /// `progressHint` of the runtime section alone (`None` removes it): the rest of the section stays as it was. Producers of a hint (the running tool, the voice install) publish this, never a whole `Runtime`.
    ProgressHint(Option<Value>),
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
