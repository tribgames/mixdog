//! The session's turn operations: the configure actions of the session object that act on one
//! thread's turn state (`thread/pushNotice`, `thread/clearSessionChangeHistory`,
//! `thread/compact/start`, `turn/retryFailed`, `thread/askSide`, `thread/cancelSide`,
//! `thread/agentControl`, `thread/inheritancePreflight`, `thread/stageAttachmentOriginal`,
//! `thread/resizeImage`). Each answers the action's own value, as the session action lane
//! (`session-action.mjs`) returns it as `value`.

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_rt::CancellationToken;
use serde_json::Value;

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
    /// `session.postCompactHook({ trigger })`, best-effort.
    async fn post_compact(&self, thread: &ThreadId, trigger: &str);
    /// `rearmLateDeferredTools` and `rearmPromptSettingsNotice`: the compaction dropped what the
    /// model was told, so the session tells it again.
    async fn rearm(&self, thread: &ThreadId);
    /// `recoverAgentWorkers()` (`options.recoverAgent`).
    fn recover_workers(&self, thread: &ThreadId);
    /// `invalidateContextStatusCache()`.
    fn invalidate_context_status(&self, thread: &ThreadId);
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
