//! The session's turn operations: the configure actions of the session object that act on one
//! thread's turn state (`thread/pushNotice`, `thread/clearSessionChangeHistory`,
//! `thread/compact/start`, `turn/retryFailed`, `thread/askSide`, `thread/cancelSide`,
//! `thread/agentControl`, `thread/inheritancePreflight`, `thread/stageAttachmentOriginal`,
//! `thread/resizeImage`). Each answers the action's own value, as the session action lane
//! (`session-action.mjs`) returns it as `value`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use serde_json::Value;

/// The header a compaction commit writes with it (`compactionRecord` and what follows): computed on
/// the actor from the thread's header as it stands and the rows a finished turn appended since the
/// snapshot (`appendedSinceSnapshot`), written in the record that counts the compaction, so it
/// states the new `compaction.compactCount` itself.
pub type CompactionHeader = Box<dyn FnOnce(&mixdog_store::schema::record::Header, &[(mixdog_core_api::ids::ItemId, Value)]) -> mixdog_store::schema::record::HeaderChange + Send>;

/// What committing a manual compaction's result came to (`commitSessionCompaction`).
#[derive(Debug, PartialEq, Eq)]
pub enum CompactionCommit {
    /// The compacted context is durable (rows a finished turn appended meanwhile follow it).
    Applied,
    /// A turn runs or began since the plan, or the context no longer starts with what was
    /// compacted (rewound, cleared, replaced): nothing was applied and the conversation is as it was
    /// (`compact: the conversation changed while compacting; compaction not applied, run it again`).
    Moved,
}

/// One incarnation of a loaded session, as a session call addressed it when it began (`entryForSession`'s entry): it keeps
/// meaning that runtime however the thread is reloaded after. Holds the actor's inbox weakly, so a call in flight never keeps
/// a session that unloads alive.
pub struct SessionIncarnation {
    cell: Arc<super::control::ControlCell>,
    inbox: tokio::sync::mpsc::WeakSender<super::actor::Inbox>,
}

impl SessionIncarnation {
    /// Whether this runtime ended (closed, deleted, unloaded or stopped): Node's `entry.disposed`.
    pub fn disposed(&self) -> bool {
        self.cell.closed.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// `pushNotice(text, tone)` of this runtime (no `transcript` option): a toast of the session, published to its clients when
    /// this returns (after any earlier record the session still holds unacknowledged). Posting to a runtime that ended is
    /// accepted and shown to no one, as Node's posting to a disposed runtime's state is. The error is the cause that dropped
    /// the toast from a live runtime: its record was not stored, or the actor stopped without ending the runtime.
    pub async fn push_toast(&self, text: &str, tone: &str) -> Result<(), String> {
        let Some(inbox) = self.inbox.upgrade() else { return self.ended("the session stopped before the notice was posted") };
        let (tx, rx) = tokio::sync::oneshot::channel();
        if inbox.send(super::actor::Inbox::PushToast { text: text.to_owned(), tone: tone.to_owned(), tx }).await.is_err() {
            return self.ended("the session stopped before the notice was posted");
        }
        match rx.await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => self.ended("the session stopped before the notice was published"),
        }
    }

    /// A post that found its actor gone: no error when the runtime is disposed (the actor releases its slot, closing the cell,
    /// before anything else it holds is dropped: `SessionActor::slot`).
    fn ended(&self, cause: &str) -> Result<(), String> {
        if self.disposed() { Ok(()) } else { Err(cause.to_owned()) }
    }
}

#[async_trait]
impl mixdog_mcp::mcp_service::Incarnation for SessionIncarnation {
    async fn toast(&self, text: &str, tone: &str) -> Result<(), String> {
        self.push_toast(text, tone).await
    }

    fn disposed(&self) -> bool {
        SessionIncarnation::disposed(self)
    }
}

impl mixdog_mcp::mcp_service::SessionToasts for super::SessionDirectory {
    /// Node's `isClosed()` of the session service: the directory's shutdown began ([`super::SessionDirectory::shutdown_for`]).
    fn closed(&self) -> bool {
        self.is_closed()
    }

    fn incarnation(&self, thread: &str) -> Option<Arc<dyn mixdog_mcp::mcp_service::Incarnation>> {
        self.hosting(&ThreadId::from(thread)).map(|incarnation| Arc::new(incarnation) as Arc<dyn mixdog_mcp::mcp_service::Incarnation>)
    }
}

impl super::SessionDirectory {
    /// The incarnation of `thread` a session call addressed now; `None` for a thread no loaded session hosts (a cold session
    /// is not disposed: Node reopens it).
    pub fn hosting(&self, thread: &ThreadId) -> Option<SessionIncarnation> {
        let handle = self.handle(thread)?;
        (!handle.cell.closed.load(std::sync::atomic::Ordering::SeqCst)).then(|| SessionIncarnation { cell: handle.cell.clone(), inbox: handle.inbox.downgrade() })
    }

    /// Commits `compaction`, planned on the model context whose item ids are `snapshot`, to
    /// `thread`. Opens the thread as `loadSession` does. `header` is what the commit sets in the
    /// thread's header with the compaction; `None` writes none (the pre-send pass's telemetry counts it).
    pub async fn commit_compaction(
        &self,
        thread: &ThreadId,
        snapshot: Vec<mixdog_core_api::ids::ItemId>,
        compaction: super::run::Compaction,
        header: Option<CompactionHeader>,
    ) -> Result<CompactionCommit, CoreError> {
        let ctx = mixdog_core_api::call::CallContext::internal("compaction");
        let handle = self.open_handle(thread, &ctx).await?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        handle
            .inbox
            .send(super::actor::Inbox::CommitCompaction { snapshot, compaction, header, tx })
            .await
            .map_err(|_| CoreError::Internal { incident_id: "compaction-closed".into() })?;
        rx.await.map_err(|_| CoreError::Internal { incident_id: "compaction-dropped".into() })?
    }
}

/// The methods the thread's actor serves itself: they read or change what only the actor owns
/// (its busy state, its live rows, its queue).
pub(super) fn is_actor_method(method: &str) -> bool {
    matches!(method, "thread/pushNotice" | "thread/clearSessionChangeHistory" | "thread/askSide" | "thread/cancelSide" | "thread/compact/start" | "turn/retryFailed")
}

/// `SIDE_QUESTION_NO_REQUEST`.
pub const SIDE_QUESTION_NO_REQUEST: &str = "Send a message first, then try /btw.";
/// `SIDE_QUESTION_TOOL_ATTEMPT`.
pub const SIDE_QUESTION_TOOL_ATTEMPT: &str =
    "The model tried to use a tool instead of answering. A side question cannot run tools; try asking it differently.";
const SIDE_QUESTION_EMPTY_ANSWER: &str = "The model returned no answer.";
/// The abort reason of a canceled side question (`cancelSideQuestion`).
pub const SIDE_QUESTION_CANCELED: &str = "Side question canceled.";
/// The answer a fork gives each tool call of the saved reply (`SIDE_QUESTION_TOOL_STUB`): the
/// calls run in the main session; the fork only needs each answered so the request stays valid.
pub const SIDE_QUESTION_TOOL_STUB: &str =
    "This tool call belongs to the main task and is handled there; its result is not part of this side question.";

/// What a side-question send ended with, other than an answer.
#[derive(Debug, PartialEq)]
pub enum SideFailure {
    /// The run's token was cancelled (`cancelSideQuestion`, or a newer question replaced it).
    Aborted,
    /// The provider's error text.
    Failed(String),
}

/// The reply of the forked request (`response` of `provider.send`).
pub struct SideReply {
    pub content: String,
    pub tool_call: bool,
}

/// The side question in flight of a session (`beginSideQuestion`): dropping it ends the run
/// (`run.end()`), and the token is cancelled by `cancel` or a newer `begin`.
pub struct SideRun {
    pub cancel: CancellationToken,
    pub end: Box<dyn Send + Sync>,
}

/// The side-question store as the session reads it: the latest provider request the loop sent
/// (`side-question-store.mjs`) and the fork that sends a question on it. The composition backs it
/// with the run host's one `SideQuestionStore`, shared with the loop's send path.
#[async_trait]
pub trait SideQuestions: Send + Sync {
    /// `sideQuestionRequest(sessionId) || nextMainRequest(sessionId)` is not null.
    async fn has_request(&self, thread: &ThreadId) -> bool;
    /// `beginSideQuestion`: aborts the session's question still in flight.
    fn begin(&self, thread: &ThreadId) -> SideRun;
    /// `cancelSideQuestion`: whether a question was in flight.
    fn cancel(&self, thread: &ThreadId) -> bool;
    /// `forgetSideQuestion(sessionId, { cancel })`: the transcript the saved request carried is gone
    /// (clear, rewind), so a later question waits for the next request; `cancel` (a close or runtime
    /// unload) also aborts the question in flight.
    fn forget(&self, thread: &ThreadId, cancel: bool);
    /// Sends the fork of the session's request (`buildForkedRequest`) with `prompt` as its last
    /// user message and `tool_stub` answering each tool call of the saved reply, on its own
    /// transport scope, one provider call, no tools executed; logs the usage as `side-question`.
    async fn send(&self, thread: &ThreadId, prompt: &str, tool_stub: &str, cancel: &CancellationToken) -> Result<SideReply, SideFailure>;
}

/// The manual compaction of a session, as `session-ops.mjs` `compact` drives it: the host owns
/// the compaction engine (`compactSessionMessages`) and the session's hooks, the session's actor
/// owns the turn guard and the Goal reminder the compaction re-marks.
#[async_trait]
pub trait ManualCompaction: Send + Sync {
    /// `mgr.compactSessionMessages(id, { requireReduction, onStageChange })`: the PreCompact hook
    /// (`trigger`) runs once the manager's savings gate passes, best-effort. `None` is Node's
    /// `null` (no session, or nothing to report); a `skipped` result is returned as is.
    async fn compact(&self, thread: &ThreadId, trigger: &str, require_reduction: bool) -> Result<Option<Value>, CoreError>;
    /// `compactConversationForHeir` (`inheritance.mjs`): the conversation of `source` compacted to fit `budget_tokens`, on a
    /// copy - nothing of the source is touched. `summarize` (an explicitly chosen compacted carry) summarizes whatever the
    /// size. The rows of the result, system blocks included; `None` when the compaction yields no conversation.
    async fn compact_for_heir(&self, source: &ThreadId, budget_tokens: u64, summarize: bool) -> Result<Option<Vec<Value>>, CoreError>;
    /// `session.postCompactHook({ trigger })`, best-effort.
    async fn post_compact(&self, thread: &ThreadId, trigger: &str);
    /// `pruneOffloadSession`'s listing, after a committed compaction: the session's tool-result sidecars old
    /// enough to be pruned; none when there are none.
    async fn offload_candidates(&self, thread: &ThreadId) -> Vec<std::path::PathBuf>;
    /// The rest of `pruneOffloadSession`, run on the idle session's actor: of `candidates`, the sidecars that
    /// `transcripts` (what the session holds, as `JSON.stringify` writes it) no longer reach are deleted, best-effort.
    async fn prune_offloads(&self, thread: &ThreadId, candidates: Vec<std::path::PathBuf>, transcripts: String);
    /// `rearmLateDeferredTools` and `rearmPromptSettingsNotice`: the compaction dropped what the
    /// model was told, so the session tells it again.
    async fn rearm(&self, thread: &ThreadId);
    /// `recoverAgentWorkers()` (`options.recoverAgent`).
    fn recover_workers(&self, thread: &ThreadId);
    /// `invalidateContextStatusCache()`.
    fn invalidate_context_status(&self, thread: &ThreadId);
    /// The meters the thread's context pressure is recorded with (`recordProviderContextBaseline`,
    /// `rememberCompactTelemetry`) for the thread whose header is `header`; `None` when the host has no
    /// meters for it, which records no pressure.
    fn books(&self, thread: &ThreadId, header: &mixdog_store::schema::record::Header) -> Option<Books>;
    /// Reads from the attachment store what pricing `messages` on `provider` needs, into the meters
    /// [`Self::books`] hands out for the thread (`MediaMeter::prepare`): the pressure is metered
    /// synchronously, so its host prepares first.
    async fn prepare_books(&self, thread: &ThreadId, provider: &str, messages: &[mixdog_agent::message::AgentMessage]);
    /// `syncSessionCompaction(session, config)`: the `compaction` record of the thread following the
    /// saved configuration, when it differs from the header's. `install`: the session is being installed
    /// (the one sync that leaves an injected configuration's sessions alone).
    fn synced_compaction(&self, header: &mixdog_store::schema::record::Header, install: bool) -> Option<Value>;
    /// The configured values the route section carries besides the session's own: `autoClear` (`getAutoClear`), `systemShell`
    /// (`normalizeSystemShellConfig(config.shell)`) and `webSearchRoute` (`webSearchRouteOrDefault(config.webSearchRoute)`), for
    /// the thread whose header is `header`.
    fn route_config(&self, header: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute;
    /// The saved configuration's change counter (`announceSettingsChange`, providers.mjs): it moves when a settings change is applied, and
    /// a thread then announces `setupChanged`. `None`: no configuration.
    fn settings_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>>;
}

/// What a thread's transcript is priced and signed with on its provider (the compaction's own
/// meters), and the request facts the header alone does not hold.
pub struct Books {
    /// The priced media and the image identities of the thread (`MediaLowering`).
    pub media: std::sync::Arc<dyn mixdog_agent::compact::estimate::MediaMeter>,
    pub images: std::sync::Arc<dyn mixdog_agent::compact::pressure::ImageIdentities>,
    /// The provider-native tools its requests carry first (`getNativeTools`).
    pub native: Vec<Value>,
    /// `isAgentModeSession(session)`.
    pub agent_mode: bool,
}

/// `compact(options)` of the session ops: the PreCompact trigger and whether a reduction is required.
pub fn compact_trigger(options: Option<&Value>) -> (&'static str, bool) {
    let require_reduction = options.and_then(|options| options.get("requireReduction")) == Some(&Value::Bool(true));
    (if require_reduction { "auto_clear" } else { "manual" }, require_reduction)
}

/// The answer of a compaction refused because a turn runs.
pub fn compact_in_turn() -> Value {
    serde_json::json!({ "changed": false, "reason": "compact skipped: turn in progress" })
}

/// `sideQuestionPrompt`.
fn side_question_prompt(question: &str) -> String {
    [
        "<side-question>",
        "The user is asking you a quick side question. The main agent keeps working on the task on its own;",
        "this exchange does not reach it and does not change that work.",
        "Answer directly, in this one response, from what this conversation already contains.",
        "No tools are available here: do not call any, and do not offer or promise to do anything.",
        "If the conversation does not tell you the answer, say that you do not know.",
        "",
        question,
        "</side-question>",
    ]
    .join("\n")
}

/// `askSideQuestion`: the answer text. Rejects with Node's messages.
pub async fn ask_side_question(side: &dyn SideQuestions, thread: &ThreadId, question: &str) -> Result<String, CoreError> {
    let text = mixdog_js::js_trim(question);
    if text.is_empty() {
        return Err(failure("Side question is empty."));
    }
    if !side.has_request(thread).await {
        return Err(failure(SIDE_QUESTION_NO_REQUEST));
    }
    let run = side.begin(thread);
    let sent = side.send(thread, &side_question_prompt(text), SIDE_QUESTION_TOOL_STUB, &run.cancel).await;
    // A cancel that raced the reply wins over it (`if (run.signal.aborted) throw ...`).
    if run.cancel.is_cancelled() || matches!(sent, Err(SideFailure::Aborted)) {
        return Err(failure(SIDE_QUESTION_CANCELED));
    }
    let reply = match sent {
        Ok(reply) => reply,
        Err(SideFailure::Failed(message)) => return Err(failure(&message)),
        Err(SideFailure::Aborted) => unreachable!("handled above"),
    };
    drop(run);
    if reply.tool_call {
        return Ok(SIDE_QUESTION_TOOL_ATTEMPT.to_owned());
    }
    let answer = mixdog_js::js_trim(&reply.content);
    Ok(if answer.is_empty() { SIDE_QUESTION_EMPTY_ANSWER } else { answer }.to_owned())
}

/// A refusal as the wire carries it: Node's plain `Error`, its message the whole answer.
pub fn failure(message: &str) -> CoreError {
    CoreError::DomainError { domain: "session".into(), code: None, message: Some(message.into()), detail: None }
}
