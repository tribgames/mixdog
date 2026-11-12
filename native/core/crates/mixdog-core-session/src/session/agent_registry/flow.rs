//! The session side of the agent tool's worker turns (WP-AGENT `agent_tool::flow::seams`): the
//! worker's tag and agent, its row writes, the tool calls that started agent tasks, and the
//! completions a worker or its owner is handed (Node `agent-tool/notify.mjs`,
//! `notification-bus.mjs` `notifySessionCompletion`, `agent-task-starts.mjs`).

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_agent::agent_tool::flow::handoff::handoff_content;
use mixdog_agent::agent_tool::flow::seams::AssistantText;
use mixdog_agent::agent_tool::flow::seams::TurnError;
use mixdog_agent::agent_tool::flow::seams::TurnRequest;
use mixdog_agent::agent_tool::flow::seams::TurnResult;
use mixdog_agent::agent_tool::flow::seams::TurnSessions;
use mixdog_app_protocol::v2::thread::TurnInput;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::OpId;
use mixdog_protocol::PromptContent;
use mixdog_protocol::SubmitOptions;
use serde_json::json;
use tokio::sync::oneshot;

use crate::session::control::AgentStart;
use crate::session::seams::AgentTurn;
use crate::session::seams::RunOutcome;
use mixdog_agent::agent_tool::flow::seams::OwnerNotify;
use mixdog_agent::agent_tool::flow::seams::RowUpdate;
use mixdog_agent::agent_tool::flow::seams::SessionNames;
use mixdog_agent::agent_tool::flow::seams::TaskStarts;
use mixdog_agent::agent_tool::flow::seams::TurnListener;
use mixdog_agent::agent_tool::flow::seams::TurnSource;
use mixdog_agent::agent_tool::flow::seams::Unobserve;
use mixdog_agent::agent_tool::flow::seams::WorkerInbox;
use mixdog_agent::agent_tool::flow::seams::WorkerRows;
use mixdog_agent::agent_tool::host::Registry;
use mixdog_agent::agent_tool::scope::clean;
use mixdog_agent::agent_tool::scope::clean_str;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;

use super::AgentRegistry;
use super::Row;
use crate::session::SessionDirectory;

impl SessionNames for AgentRegistry {
    fn tag_for_session(&self, session_id: &str) -> Option<String> {
        Registry::tag_for_session(self, session_id)
    }

    /// `sessionOf(sessionId).agent`: the loaded session's, else its worker row's.
    fn agent(&self, session_id: &str) -> Option<String> {
        let agent = clean(self.session_of(session_id)?.get("agent"));
        (!agent.is_empty()).then_some(agent)
    }
}

/// A row update as `upsertWorkerSessionDeferred`'s patch.
fn patch(update: RowUpdate) -> Row {
    let mut extra = Row::new();
    let mut put = |key: &str, value: Option<String>| {
        if let Some(value) = value {
            extra.insert(key.to_owned(), Value::String(value));
        }
    };
    put("status", update.status);
    put("stage", update.stage);
    put("turnStartedAt", update.turn_started_at);
    put("finishedAt", update.finished_at);
    put("failureReason", update.failure_reason);
    if let Some(task) = update.task_id {
        extra.insert("task_id".into(), task.map_or(Value::Null, Value::String));
    }
    extra
}

impl WorkerRows for AgentRegistry {
    /// `upsertWorkerSessionDeferred(sessionOf(sessionId), tag, patch)`.
    fn upsert(&self, session_id: &str, tag: Option<&str>, update: RowUpdate) {
        let Some(session) = self.session_of(session_id) else { return };
        self.upsert_session_row(&session, tag.unwrap_or_default(), &patch(update));
    }
}

/// `MAX_CALLS` of `agent-task-starts.mjs`.
const MAX_CALLS: usize = 1000;

/// The agent task ids each `agent` tool call started, keyed by the tool call id, until the
/// tool batch takes them for that call's result message (`agentTaskIds`).
#[derive(Default)]
pub struct AgentTaskStarts(Mutex<VecDeque<(String, Vec<String>)>>);

impl AgentTaskStarts {
    /// `takeAgentTaskStarts`: the task ids tool call `tool_call_id` started, forgotten once taken.
    pub fn take(&self, tool_call_id: &str) -> Vec<String> {
        let call = mixdog_js::js_trim(tool_call_id);
        let mut calls = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match calls.iter().position(|(id, _)| id == call) {
            Some(at) => calls.remove(at).map(|(_, ids)| ids).unwrap_or_default(),
            None => Vec::new(),
        }
    }
}

impl TaskStarts for AgentTaskStarts {
    /// `recordAgentTaskStart`: a call seen again keeps its place, as a JS `Map` does.
    fn record(&self, tool_call_id: &str, task_id: &str) {
        let (call, id) = (mixdog_js::js_trim(tool_call_id), mixdog_js::js_trim(task_id));
        if call.is_empty() || id.is_empty() {
            return;
        }
        let mut calls = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match calls.iter_mut().find(|(c, _)| c == call) {
            Some((_, ids)) if !ids.iter().any(|t| t == id) => ids.push(id.to_owned()),
            Some(_) => {}
            None => calls.push_back((call.to_owned(), vec![id.to_owned()])),
        }
        while calls.len() > MAX_CALLS {
            calls.pop_front();
        }
    }
}

/// Subscription ids of turn observers.
static NEXT_OBSERVER: AtomicU64 = AtomicU64::new(1);

impl TurnSource for SessionDirectory {
    /// `observeSessionTurns`: a session this process runs reports its turns (start, then the
    /// run host's final result unchanged); one it does not host reports none.
    fn observe_session_turns(&self, session_id: &str, listener: Arc<dyn TurnListener>) -> Option<Unobserve> {
        let handle = self.handle(&ThreadId::from(clean_str(session_id).as_str()))?;
        let id = NEXT_OBSERVER.fetch_add(1, Ordering::Relaxed);
        handle.cell.turn_listeners.lock().unwrap_or_else(|p| p.into_inner()).push((id, listener));
        let cell = Arc::downgrade(&handle.cell);
        Some(Box::new(move || {
            if let Some(cell) = cell.upgrade() {
                cell.turn_listeners.lock().unwrap_or_else(|p| p.into_inner()).retain(|(at, _)| *at != id);
            }
        }))
    }
}

/// `NON_PERSISTENT_TOOL_STATUSES`.
const NON_PERSISTENT: [&str; 3] = ["running", "pending", "queued"];

/// `modelVisibleToolCompletionMessage(text, meta)` for the completions the core produces: a
/// `<task-notification>` envelope persists as it is; a completion the model must not see (or one
/// still running) yields nothing. The core's producers render envelopes only, so the legacy
/// wrapper forms Node still converts never reach here.
pub(crate) fn model_visible(text: &str, meta: &Value) -> Option<String> {
    let message = mixdog_js::js_trim(text);
    if message.is_empty() || meta.get("model_visible") == Some(&Value::Bool(false)) {
        return None;
    }
    let status = clean(meta.get("status")).to_lowercase();
    if NON_PERSISTENT.contains(&status.as_str()) {
        return None;
    }
    mixdog_protocol::text_class::parse_task_notification(message).map(|_| message.to_owned())
}

/// The model-visible completion queue of a session (`enqueueCompletion`): the session takes it at
/// its next model-call boundary, or an idle one turns for it. One completion is one entry,
/// addressed by its execution.
pub struct SessionCompletions {
    directory: Arc<SessionDirectory>,
}

impl SessionCompletions {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }

    /// Shows the completion to the live session (`card`), then queues its model-visible text, in
    /// that order, on one task. The queue write opens a session not loaded.
    fn deliver(&self, target: String, text: &str, meta: Value, card: bool, queue: Option<String>) {
        let directory = self.directory.clone();
        let content = text.to_owned();
        drop(mixdog_rt::spawn("session-completion", mixdog_rt::TaskClass::Work, async move {
            let thread = ThreadId::from(target.as_str());
            if card {
                directory.show_completion(&thread, content, meta.clone()).await;
            }
            if let Some(visible) = queue {
                let field = |key: &str| clean(meta.get(key));
                let (surface, task, status) = (field("execution_surface"), field("execution_id"), field("status"));
                directory.queue_completion(&thread, &surface, &task, &status, visible).await;
            }
        }));
    }
}

impl WorkerInbox for SessionCompletions {
    /// `enqueueCompletionMessage(sessionId, text, meta)`: the worker's own queue only (no
    /// listener sees it).
    fn enqueue_completion(&self, session_id: &str, text: &str, meta: &Value) -> bool {
        let target = clean_str(session_id);
        let Some(visible) = model_visible(text, meta) else { return false };
        if target.is_empty() {
            return false;
        }
        self.deliver(target, text, meta.clone(), false, Some(visible));
        true
    }
}

impl OwnerNotify for SessionCompletions {
    /// `notifyOwner` → `notifySessionCompletion(owner, text, meta)`: the owner's own id as the
    /// caller, never a routing session. The live owner shows the card (a bodyless preview too);
    /// the model-visible text is queued unless the owner is closed. `true` when the live owner
    /// took it or it was queued.
    fn notify(&self, owner_session_id: &str, text: &str, meta: &Value) -> bool {
        let owner = clean_str(owner_session_id);
        if owner.is_empty() {
            return false;
        }
        let mut owner_meta = meta.as_object().cloned().unwrap_or_default();
        owner_meta.insert("caller_session_id".into(), Value::String(owner.clone()));
        owner_meta.shift_remove("routing_session_id");
        let owner_meta = Value::Object(owner_meta);
        let handle = self.directory.handle(&ThreadId::from(owner.as_str()));
        let live = handle.is_some();
        let closed = handle.is_some_and(|handle| handle.cell.header.load().get("closed") == Some(&Value::Bool(true)));
        let queue = if closed { None } else { model_visible(text, &owner_meta) };
        let queued = queue.is_some();
        if live || queued {
            self.deliver(owner, text, owner_meta, live, queue);
        }
        live || queued
    }
}

/// What a settled worker session still pins in this process besides its thread: the read-dedup
/// caches, side questions and read-only worker snapshots (`unloadSessionRuntime`,
/// `session-close.mjs:344`). Owner: WP-RUN-HOST.
pub trait RuntimeRelease: Send + Sync {
    fn release(&self, thread: &ThreadId, reason: &str);
}

/// The session layer as a worker's turn uses it (`TurnSessions`): reads over the stored model
/// context, the todo list, and the turn started through the internal `turn/start`.
pub struct SessionTurns {
    directory: Arc<SessionDirectory>,
    release: Arc<dyn RuntimeRelease>,
    /// The background shells a stalled turn's stop ended (`takeStoppedShellJobs`); without it a
    /// handoff names none.
    shells: Option<Arc<mixdog_tools::exec::ShellControl>>,
    /// The registry whose cancellations a turn is admitted against (`registry.assertAdmission`,
    /// `agent-turns.mjs:96,108,116`); a turn with none is not checked.
    admission: Option<Arc<AgentRegistry>>,
}

/// `assistantMessageText(content)`: a string, else the `text`/`output_text` parts joined by a
/// line break.
fn assistant_message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| matches!(part.get("type").and_then(Value::as_str), Some("text" | "output_text")))
            .map(|part| part.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// `replayItemText(item)`.
fn replay_item_text(item: &Value) -> String {
    if !item.is_object() {
        return String::new();
    }
    let text = |item: &Value| item.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
    match item.get("type").and_then(Value::as_str) {
        Some("message") => assistant_message_text(item.get("content")),
        Some("text" | "output_text") => text(item),
        None if item.get("thought") != Some(&Value::Bool(true)) => text(item),
        _ => String::new(),
    }
}

/// The result a worker's turn hands its owner, with the worker's sensitive values as the marker (its own context keeps
/// them; the report leaves the session).
fn report_redacted(marks: &dyn crate::session::seams::SensitiveMarks, worker: &ThreadId, result: &TurnResult) -> TurnResult {
    let mut out = result.clone();
    out.content = marks.redact_text(worker, &out.content);
    out.report_content = out.report_content.map(|text| marks.redact_text(worker, &text));
    out
}

/// `providerReplayText(replay)`: the visible text of a replay envelope's items.
fn provider_replay_text(replay: Option<&Value>) -> String {
    let items = replay.and_then(|replay| replay.get("items")).and_then(Value::as_array);
    items
        .into_iter()
        .flatten()
        .map(replay_item_text)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

impl SessionTurns {
    pub fn new(directory: Arc<SessionDirectory>, release: Arc<dyn RuntimeRelease>) -> Self {
        Self { directory, release, shells: None, admission: None }
    }

    /// Admits each turn against the agent registry's cancellations: a turn on a session being
    /// cancelled, or cancelled since the turn began, is refused with
    /// `agent session <id> was cancelled during admission`.
    pub fn with_admission(mut self, registry: Arc<AgentRegistry>) -> Self {
        self.admission = Some(registry);
        self
    }

    /// `registry.assertAdmission(sessionId, epoch)`.
    fn admitted(&self, session_id: &str, epoch: Option<u64>) -> Result<Option<u64>, TurnError> {
        match &self.admission {
            Some(registry) => registry.assert_admission(session_id, epoch).map(Some).map_err(TurnError::new),
            None => Ok(None),
        }
    }

    /// The shell control the progress watchdog's stop reaps through (the one runtime the turns'
    /// shells run in).
    pub fn with_shells(mut self, shells: Arc<mixdog_tools::exec::ShellControl>) -> Self {
        self.shells = Some(shells);
        self
    }

    /// `session.messages` without its first `start`: the model rows since the thread's last compaction, from the `start`th;
    /// the store does not read the frames before it.
    async fn messages_from(&self, session_id: &str, start: usize) -> Vec<Value> {
        let thread = ThreadId::from(clean_str(session_id).as_str());
        match self.directory.model_context(&thread).read_from(start).await {
            Ok(rows) => rows.into_iter().map(|(_, body)| body).collect(),
            Err(error) => {
                tracing::warn!("[agent-turn] the model context of {session_id} is unreadable: {error:?}");
                Vec::new()
            }
        }
    }
}

#[async_trait]
impl TurnSessions for SessionTurns {
    fn take_stopped_shell_jobs(&self, session_id: &str) -> mixdog_agent::agent_tool::flow::seams::StoppedShellJobs {
        let Some(shells) = &self.shells else { return Default::default() };
        let (stopped, stopping) = shells.take_reaped(&ThreadId::from(clean_str(session_id).as_str()));
        mixdog_agent::agent_tool::flow::seams::StoppedShellJobs { stopped, stopping }
    }

    async fn message_count(&self, session_id: &str) -> usize {
        let thread = ThreadId::from(clean_str(session_id).as_str());
        match self.directory.model_context(&thread).len().await {
            Ok(count) => count,
            Err(error) => {
                tracing::warn!("[agent-turn] the model context of {session_id} is unreadable: {error:?}");
                0
            }
        }
    }

    /// The rows a stopped turn's handoff is read from, with the worker's sensitive values as the marker: the handoff leaves
    /// the session.
    async fn assistant_texts(&self, session_id: &str, start: usize) -> Vec<AssistantText> {
        let (marks, worker) = (self.directory.deps().sensitive.clone(), ThreadId::from(clean_str(session_id).as_str()));
        self.messages_from(session_id, start)
            .await
            .into_iter()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
            .map(|message| AssistantText {
                content: marks.redact_text(&worker, &assistant_message_text(message.get("content"))),
                replay: marks.redact_text(&worker, &provider_replay_text(message.get("providerReplay"))),
            })
            .collect()
    }

    fn carry_marks(&self, session_id: &str, owner_session_id: &str) {
        let (worker, owner) = (ThreadId::from(clean_str(session_id).as_str()), ThreadId::from(clean_str(owner_session_id).as_str()));
        self.directory.deps().sensitive.carry(&worker, &owner);
    }

    fn redact_text(&self, session_id: &str, text: &str) -> String {
        self.directory.deps().sensitive.redact_text(&ThreadId::from(clean_str(session_id).as_str()), text)
    }

    /// `notDoneReport(session)` over the todo list of the loaded session's latest acked header
    /// (Node reads the session object in memory); a session that is not loaded has none.
    fn not_done_report(&self, session_id: &str) -> String {
        let thread = ThreadId::from(clean_str(session_id).as_str());
        self.directory
            .handle(&thread)
            .map(|handle| mixdog_core_ports::ports::todo_list::list_of(&handle.live_header().header()).not_done_report())
            .unwrap_or_default()
    }

    /// Starts the turn through the internal `turn/start` (the worker's input row carries
    /// `handoffContent(prompt, attachments)` and the submission), then waits for the run's
    /// outcome: the final result, or the failure's message.
    async fn run_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError> {
        self.turn(request, false).await
    }

    /// `unloadSessionRuntime`: vetoed while the session still owns work (a running turn, or a
    /// closing thread); else the process-local state a settled turn left is released.
    fn unload_runtime(&self, session_id: &str, reason: &str) {
        let thread = ThreadId::from(clean_str(session_id).as_str());
        if let Some(handle) = self.directory.handle(&thread)
            && (handle.cell.run.load().is_some() || handle.cell.closed.load(Ordering::SeqCst))
        {
            return;
        }
        self.directory.deps().side.forget(&thread, true);
        self.release.release(&thread, reason);
    }
}

impl SessionTurns {
    /// [`TurnSessions::run_turn`] for a caller that runs the turn's progress watchdog itself (an
    /// agent dispatch): the run arms none of its own.
    pub async fn run_watched_turn(&self, request: TurnRequest) -> Result<TurnResult, TurnError> {
        self.turn(request, true).await
    }

    async fn turn(&self, request: TurnRequest, caller_watchdog: bool) -> Result<TurnResult, TurnError> {
        let thread = ThreadId::from(clean_str(&request.session_id).as_str());
        let ctx = CallContext::internal("agent-turn");
        // `const cancelEpoch = registry.assertAdmission(sessionId)` (`agent-turns.mjs:96`).
        let epoch = self.admitted(thread.as_str(), None)?;
        let handle = self
            .directory
            .open_handle(&thread, &ctx)
            .await
            .map_err(|error| TurnError::new(format!("agent session {} is unavailable: {error:?}", request.session_id)))?;
        // After `entryForSession` (`:108`), and again before the turn is submitted (`:116`, after
        // the transcript length is read).
        self.admitted(thread.as_str(), epoch)?;
        let submission = request.hooks.submission_id.clone();
        let op = OpId::from(format!("agent-turn:{}", if submission.is_empty() { uuid::Uuid::new_v4().to_string() } else { submission.clone() }));
        let input = TurnInput {
            prompt: PromptContent::Text(request.prompt.clone()),
            options: Some(SubmitOptions { client_submission_id: Some(submission).filter(|id| !id.is_empty()), ..SubmitOptions::default() }),
        };
        self.admitted(thread.as_str(), epoch)?;
        // The report and the failure leave the worker for its owner: the worker's sensitive values as the marker.
        let marks = self.directory.deps().sensitive.clone();
        let mut hooks = request.hooks;
        if let Some(terminal) = hooks.on_terminal_result.take() {
            let (marks, worker) = (marks.clone(), thread.clone());
            hooks.on_terminal_result = Some(Arc::new(move |result: &TurnResult| terminal(&report_redacted(&*marks, &worker, result))));
        }
        let (done, outcome) = oneshot::channel();
        *handle.cell.agent_start.lock().unwrap_or_else(|p| p.into_inner()) = Some(AgentStart {
            content: handoff_content(&request.prompt, &request.attachments),
            turn: AgentTurn {
                kind: request.kind,
                hooks,
                slot: request.slot,
                context: request.context,
                skill_selection: request.skill_selection,
                caller_watchdog,
            },
            done,
        });
        let params = json!({ "threadId": thread, "opId": op, "input": input });
        let started = handle
            .request(CoreRequest { method: Method("turn/start"), params, op: Some(op.clone()), ctx: ctx.clone() })
            .await;
        let unstarted = |message: String| {
            handle.cell.agent_start.lock().unwrap_or_else(|p| p.into_inner()).take();
            TurnError::new(message)
        };
        match started {
            Ok(Reply::Value(value)) if value["kind"] == "started" => {}
            Ok(Reply::Value(value)) => {
                if let Some(queued) = value["queuedId"].as_str() {
                    let params = json!({ "threadId": thread, "opId": format!("{op}:unqueue"), "queuedId": queued, "restore": false });
                    // The refusal below stands whatever this answers, but a turn left queued would run
                    // later with nobody waiting for it.
                    if let Err(error) = handle.request(CoreRequest { method: Method("thread/queue/delete"), params, op: Some(OpId::from(format!("{op}:unqueue"))), ctx }).await {
                        tracing::warn!(session = %request.session_id, "a refused turn was not taken off the queue: {error:?}");
                    }
                }
                return Err(unstarted(format!("agent session {} is busy with another turn", request.session_id)));
            }
            Ok(_) => return Err(unstarted("turn/start answered no value".to_owned())),
            Err(error) => return Err(unstarted(format!("the turn did not start: {error:?}"))),
        }
        match outcome.await {
            Ok(RunOutcome::Completed(result)) => Ok(report_redacted(&*marks, &thread, &result)),
            Ok(RunOutcome::Failed(error)) => Err(TurnError::new(marks.redact_text(&thread, &error.message))),
            Ok(RunOutcome::Interrupted) => Err(TurnError::new("The turn was interrupted")),
            Err(_) => Err(TurnError::new(format!("agent session {} closed during its turn", request.session_id))),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::ThreadItem as ThreadItemKind;
    use serde_json::json;

    use super::*;

    #[test]
    fn task_starts_are_kept_per_call_until_taken() {
        let starts = AgentTaskStarts::default();
        starts.record(" call-1 ", "task-a");
        starts.record("call-1", "task-a");
        starts.record("call-1", "task-b");
        starts.record("", "task-c");
        assert_eq!(starts.take("call-1"), ["task-a", "task-b"]);
        assert!(starts.take("call-1").is_empty(), "forgotten once taken");
        for n in 0..=MAX_CALLS {
            starts.record(&format!("c{n}"), "t");
        }
        assert!(starts.take("c0").is_empty(), "the oldest call goes past the cap");
        assert_eq!(starts.take(&format!("c{MAX_CALLS}")), ["t"]);
    }

    #[test]
    fn a_row_update_is_the_deferred_upserts_patch() {
        let update = RowUpdate {
            status: Some("failed".into()),
            stage: Some("failed".into()),
            task_id: Some(None),
            failure_reason: Some("stalled".into()),
            ..RowUpdate::default()
        };
        assert_eq!(
            Value::Object(patch(update)),
            json!({ "status": "failed", "stage": "failed", "failureReason": "stalled", "task_id": null })
        );
    }

    const ENVELOPE: &str =
        "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent \"rev\" completed</summary>\n</task-notification>";

    #[test]
    fn only_a_model_visible_envelope_is_queued() {
        let envelope = ENVELOPE;
        assert_eq!(model_visible(envelope, &json!({ "status": "completed" })).as_deref(), Some(envelope));
        assert_eq!(model_visible(envelope, &json!({ "model_visible": false })), None);
        assert_eq!(model_visible(envelope, &json!({ "status": "Running" })), None);
        assert_eq!(model_visible("background task\ntask_id: t1", &json!({})), None);
        assert_eq!(model_visible("  ", &json!({})), None);
    }

    #[derive(Default)]
    struct Heard(Mutex<Vec<String>>);
    impl TurnListener for Heard {
        fn turn_started(&self, start: mixdog_agent::agent_tool::flow::seams::TurnStart) {
            self.0.lock().unwrap().push(format!("start {}", start.turn_id.len() > 0));
        }
        fn turn_settled(&self, outcome: mixdog_agent::agent_tool::flow::seams::TurnOutcome) {
            let result = outcome.result.map(|r| format!("{}/{}", r.content, r.iterations)).unwrap_or_default();
            self.0.lock().unwrap().push(format!("settled {} {result}", outcome.done));
        }
    }

    /// `session.messages.length` of a worker with a long conversation: counted from the store's index. The rows are not read: a
    /// turn start and a status read would otherwise read the whole context to return one number.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_workers_message_count_reads_no_row() {
        use mixdog_store::schema::blob::Slot;
        use mixdog_store::schema::bounded::Id;
        use mixdog_store::schema::bounded::Name;
        use mixdog_store::schema::record::Form;
        use mixdog_store::schema::record::ItemRecord;
        use mixdog_store::schema::record::Record;

        const ROWS: usize = 3000;
        let rig = crate::session::testing::Rig::new();
        let store = crate::session::testing::CallCounted::new(rig.store.clone());
        let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
        let handle = crate::session::tests::start_thread(&directory).await;
        let rows = (0..ROWS).map(|n| {
            Record::Item(ItemRecord {
                iid: Id::try_from(format!("m{n}").as_str()).expect("item id"),
                turn: None,
                role: Name::try_from("user").ok(),
                form: Form::Message,
                model: true,
                visible: true,
                archive: None,
                op: None,
                prompt: None,
                refs: Vec::new().try_into().expect("empty list fits"),
                body: Slot::Inline(json!({ "role": "user", "content": "x".repeat(1024) })),
            })
        });
        rig.store.seed(&handle.id, rows.collect());
        let turns = SessionTurns::new(directory.clone(), Arc::new(Released(Mutex::default())));
        let before = store.calls().len();
        let count = turns.message_count(handle.id.as_str()).await;
        let calls = store.calls()[before..].to_vec();
        assert!(!calls.iter().any(|call| call.starts_with("context_io") || call.starts_with("context_cpu")), "no row was read: {calls:?}");
        assert_eq!(count, directory.model_context(&handle.id).read().await.expect("the context").len(), "the length of what a read returns");
        assert!(count >= ROWS);
    }

    /// What a stopped turn's handoff and a worker's result read of a long conversation: the rows after the turn's start, and the
    /// newest assistant message. Each equals what the whole context gives and is asked of the store without the rows before it
    /// (`context_from_io`): the whole read (`context_io`) is never made.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_long_conversation_is_read_from_the_rows_a_caller_returns() {
        use mixdog_store::schema::blob::Slot;
        use mixdog_store::schema::bounded::Id;
        use mixdog_store::schema::bounded::Name;
        use mixdog_store::schema::record::Form;
        use mixdog_store::schema::record::ItemRecord;
        use mixdog_store::schema::record::Record;

        let rig = crate::session::testing::Rig::new();
        let store = crate::session::testing::CallCounted::new(rig.store.clone());
        let directory = Arc::new(SessionDirectory::new(rig.deps_on(store.clone())));
        let handle = crate::session::tests::start_thread(&directory).await;
        let message = |n: usize, role: &str, content: Value| {
            Record::Item(ItemRecord {
                iid: Id::try_from(format!("m{n}").as_str()).expect("item id"),
                turn: None,
                role: Name::try_from(role).ok(),
                form: Form::Message,
                model: true,
                visible: true,
                archive: None,
                op: None,
                prompt: None,
                refs: Vec::new().try_into().expect("empty list fits"),
                body: Slot::Inline(json!({ "role": role, "content": content })),
            })
        };
        // An answer 100 rows from the end, then rows with no content to answer with.
        let rows: Vec<Record> = (0..400)
            .map(|n| match n {
                10 => message(n, "assistant", json!("early")),
                300 => message(n, "assistant", json!("late")),
                n if n > 300 && n % 2 == 0 => message(n, "assistant", json!("  ")),
                n => message(n, "user", json!(format!("q{n}"))),
            })
            .collect();
        rig.store.seed(&handle.id, rows);
        let turns = SessionTurns::new(directory.clone(), Arc::new(Released(Mutex::default())));
        let whole: Vec<Value> = directory.model_context(&handle.id).read().await.expect("the context").into_iter().map(|(_, body)| body).collect();
        let before = store.calls().len();
        let texts = turns.assistant_texts(handle.id.as_str(), 250).await;
        let contents: Vec<String> = texts.into_iter().map(|text| text.content).collect();
        let want: Vec<String> = whole[250..]
            .iter()
            .filter(|m| m["role"] == "assistant")
            .map(|m| m["content"].as_str().expect("text").to_owned())
            .collect();
        assert_eq!(contents, want);
        assert!(contents.iter().any(|c| c == "late"));
        let newest = |m: &Value| m["role"] == "assistant" && !m["content"].as_str().is_some_and(|t| t.trim().is_empty());
        let tail = directory.model_context(&handle.id).read_tail_until(newest).await.expect("the tail");
        let last = |rows: &[Value]| rows.iter().rev().find(|m| newest(m)).cloned();
        assert_eq!(last(&tail), last(&whole), "the newest answer");
        assert!(tail.len() < whole.len(), "only the tail was read: {} of {}", tail.len(), whole.len());
        let calls = store.calls()[before..].to_vec();
        assert!(!calls.iter().any(|call| call.starts_with("context_io")), "the whole context was read: {calls:?}");
        assert!(calls.iter().any(|call| call.starts_with("context_from_io")), "{calls:?}");
        // A conversation with no answer is read to its first row, and the answer of a short one is found.
        let none = directory.model_context(&handle.id).read_tail_until(|_| false).await.expect("whole");
        assert_eq!(none, whole);
    }

    struct Released(Mutex<Vec<String>>);
    impl RuntimeRelease for Released {
        fn release(&self, thread: &ThreadId, reason: &str) {
            self.0.lock().unwrap().push(format!("{thread} {reason}"));
        }
    }

    /// `notDoneReport(session)`: the unfinished items of the session's own list under `Not done:`,
    /// nothing when the list is empty or every item is completed or dropped, or the session is not
    /// loaded.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_not_done_report_names_the_unfinished_items() {
        use mixdog_core_ports::ports::todo_list::list_of;
        let todo = |tasks: Value| match json!({ "todo": { "phases": [{ "name": "Tasks", "tasks": tasks }], "updatedAt": 1 } }) {
            Value::Object(header) => header,
            _ => unreachable!(),
        };

        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = crate::session::tests::start_thread(&directory).await;
        let turns = SessionTurns::new(directory, Arc::new(Released(Mutex::default())));
        assert_eq!(turns.not_done_report("sess_unknown"), "");
        assert_eq!(turns.not_done_report(handle.id.as_str()), "", "a loaded session with no list");
        let mixed = todo(json!([
            { "content": "Measure the build", "status": "completed" },
            { "content": "Write the summary", "status": "in_progress" },
            { "content": "Skipped", "status": "abandoned" },
            { "content": "Verify", "status": "pending" },
        ]));
        assert_eq!(list_of(&mixed).not_done_report(), "Not done:\n- Write the summary\n- Verify");
        assert_eq!(list_of(&todo(json!([{ "content": "Measure the build", "status": "completed" }]))).not_done_report(), "");
    }

    /// A worker's turn: the input row carries `handoffContent` and the submission, the run
    /// is handed the turn's pieces, the final result reaches the terminal hook and the caller,
    /// the reads see only the rows the turn added, and a failure is the turn's own message.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_worker_turn_runs_with_its_handoff_and_returns_the_final_result() {
        use mixdog_agent::agent_tool::flow::seams::{ToolResultMessage, TurnHooks, TurnKind};
        use crate::session::tests::start_thread;

        let rig = crate::session::testing::Rig::new();
        let seen: Arc<Mutex<Vec<(Option<String>, TurnKind, Option<String>, Value)>>> = Arc::default();
        let record = seen.clone();
        rig.set_script(Arc::new(move |run| {
            let record = record.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let agent = run.agent_turn.as_ref();
                record.lock().unwrap().push((
                    agent.and_then(|a| a.skill_selection.clone()),
                    agent.map(|a| a.kind).unwrap_or(TurnKind::Send),
                    agent.and_then(|a| a.context.as_ref().map(|c| c.to_string())),
                    run.input_body.clone(),
                ));
                if run.input_body["content"].to_string().contains("boom") {
                    return crate::session::RunOutcome::Failed(mixdog_protocol::TurnError { message: "provider down".into(), data: json!({}), provider_error: None });
                }
                let reply = crate::session::ItemCommit {
                    iid: mixdog_core_api::ids::ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "assistant", "content": [{ "type": "text", "text": "worked" }] }),
                    prompt: None,
                };
                run.port.commit_item(reply).await.expect("commit");
                let result = TurnResult { content: "worked".into(), iterations: 1, ..Default::default() };
                crate::session::RunOutcome::Completed(Box::new(result))
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        let released = Arc::new(Released(Mutex::default()));
        let turns = SessionTurns::new(directory.clone(), released.clone());
        let request = |prompt: &str, submission: &str| {
            let heard: Arc<Mutex<Vec<String>>> = Arc::default();
            let sink = heard.clone();
            let request = TurnRequest {
                kind: TurnKind::Spawn,
                session_id: handle.id.as_str().to_owned(),
                prompt: prompt.to_owned(),
                attachments: vec![json!({ "type": "image", "attachmentRef": "a".repeat(64), "mimeType": "image/png", "filename": "x.png", "sizeBytes": 5, "data": "dropped" })],
                context: Some(json!({ "k": 1 })),
                cwd: String::new(),
                skill_selection: Some("skills".into()),
                hooks: TurnHooks {
                    submission_id: submission.into(),
                    notify: Arc::new(|_, _| true),
                    on_tool_result: Arc::new(|_: &ToolResultMessage| {}),
                    on_terminal_result: Some(Arc::new(move |result: &TurnResult| sink.lock().unwrap().push(result.content.clone()))),
                },
                slot: None,
            };
            (request, heard)
        };
        assert_eq!(turns.message_count(handle.id.as_str()).await, 0);
        let (first, terminal) = request("do it", "sub-1");
        let result = turns.run_turn(first).await.expect("turn");
        assert_eq!((result.content.as_str(), result.iterations), ("worked", 1));
        assert_eq!(*terminal.lock().unwrap(), ["worked"], "the terminal hook hears the final result");
        let (skill, kind, context, body) = seen.lock().unwrap()[0].clone();
        assert_eq!((skill.as_deref(), kind, context.as_deref()), (Some("skills"), TurnKind::Spawn, Some("{\"k\":1}")));
        assert_eq!(
            body["content"],
            json!([{ "type": "text", "text": "do it" }, { "type": "image", "attachmentRef": "a".repeat(64), "sizeBytes": 5, "mimeType": "image/png", "filename": "x.png" }])
        );
        assert_eq!(body["meta"]["transcript"]["submissionIds"], json!(["sub-1"]));
        assert_eq!(turns.message_count(handle.id.as_str()).await, 2);
        let texts = turns.assistant_texts(handle.id.as_str(), 1).await;
        assert_eq!(texts, [AssistantText { content: "worked".into(), replay: String::new() }]);
        assert!(turns.assistant_texts(handle.id.as_str(), 2).await.is_empty());

        let (second, _) = request("boom", "sub-2");
        let error = turns.run_turn(second).await.expect_err("failed");
        assert_eq!(error.message, "provider down");
        turns.unload_runtime(handle.id.as_str(), "agent-turn-complete");
        assert_eq!(*released.0.lock().unwrap(), [format!("{} agent-turn-complete", handle.id)]);
    }

    /// A worker's report leaves the worker: a value it marked sensitive is the marker in the result its owner gets, in the
    /// terminal hook's copy and in the rows a stopped turn's handoff is read from; carried, the value is the owner's too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_workers_report_reaches_its_owner_with_the_workers_sensitive_values_as_the_marker() {
        use mixdog_agent::agent_tool::flow::seams::{ToolResultMessage, TurnHooks, TurnKind};
        use crate::session::tests::start_thread;
        const CODE: &str = "482913";

        let rig = crate::session::testing::Rig::new();
        rig.set_script(Arc::new(move |run| {
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let fill = json!({ "id": "c1", "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": CODE } } });
                assert!(run.context.remember_sensitive(&[fill]));
                let text = format!("filled {CODE}");
                let reply = crate::session::ItemCommit {
                    iid: mixdog_core_api::ids::ItemId::from("a-1"),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "role": "assistant", "content": text }),
                    prompt: None,
                };
                run.port.commit_item(reply).await.expect("commit");
                crate::session::RunOutcome::Completed(Box::new(TurnResult { content: text.clone(), report_content: Some(text), iterations: 1, ..Default::default() }))
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let (worker, owner) = (start_thread(&directory).await, start_thread(&directory).await);
        let turns = SessionTurns::new(directory.clone(), Arc::new(Released(Mutex::default())));
        let heard: Arc<Mutex<Vec<TurnResult>>> = Arc::default();
        let sink = heard.clone();
        let request = TurnRequest {
            kind: TurnKind::Spawn,
            session_id: worker.id.as_str().to_owned(),
            prompt: "sign in".into(),
            attachments: Vec::new(),
            context: None,
            cwd: String::new(),
            skill_selection: None,
            hooks: TurnHooks {
                submission_id: "sub-1".into(),
                notify: Arc::new(|_, _| true),
                on_tool_result: Arc::new(|_: &ToolResultMessage| {}),
                on_terminal_result: Some(Arc::new(move |result: &TurnResult| sink.lock().unwrap().push(result.clone()))),
            },
            slot: None,
        };
        turns.carry_marks(worker.id.as_str(), owner.id.as_str());
        let result = turns.run_turn(request).await.expect("turn");
        let marked = "filled [redacted]";
        assert_eq!((result.content.as_str(), result.report_content.as_deref()), (marked, Some(marked)));
        let terminal = heard.lock().unwrap().clone();
        assert_eq!(terminal.iter().map(|r| (r.content.as_str(), r.report_content.as_deref())).collect::<Vec<_>>(), [(marked, Some(marked))]);
        assert_eq!(turns.assistant_texts(worker.id.as_str(), 1).await, [AssistantText { content: marked.into(), replay: String::new() }]);
        assert_eq!(rig.sensitive.redact_text(owner.id.as_str(), CODE), "[redacted]", "the owner holds the worker's mark");
    }

    /// A worker's turn asked of a session that is busy is refused, and the entry it queued is taken
    /// off the queue again: left there it would run later with nobody waiting for it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_worker_turn_refused_as_busy_leaves_nothing_queued() {
        use mixdog_agent::agent_tool::flow::seams::{ToolResultMessage, TurnHooks, TurnKind};
        use crate::eventually_on;
        use crate::session::tests::{idle, start_thread, turn};

        let rig = crate::session::testing::Rig::new();
        let hold = Arc::new(tokio::sync::Notify::new());
        let ran = Arc::new(tokio::sync::Notify::new());
        let starts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (gate, said, count) = (hold.clone(), ran.clone(), starts.clone());
        rig.set_script(Arc::new(move |run| {
            let (gate, said, count) = (gate.clone(), said.clone(), count.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                count.fetch_add(1, Ordering::SeqCst);
                said.notify_waiters();
                gate.notified().await;
                crate::session::RunOutcome::Completed(Box::default())
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        turn(&handle, "user work", "op-1").await;
        eventually_on!(&[&ran, &handle.cell.stepped], || (starts.load(Ordering::SeqCst) == 1).then_some(())).await;
        let turns = SessionTurns::new(directory.clone(), Arc::new(Released(Mutex::default())));
        let request = TurnRequest {
            kind: TurnKind::Spawn,
            session_id: handle.id.as_str().to_owned(),
            prompt: "late".into(),
            attachments: Vec::new(),
            context: None,
            cwd: String::new(),
            skill_selection: None,
            hooks: TurnHooks {
                submission_id: "sub-busy".into(),
                notify: Arc::new(|_, _| true),
                on_tool_result: Arc::new(|_: &ToolResultMessage| {}),
                on_terminal_result: None,
            },
            slot: None,
        };
        let refused = turns.run_turn(request).await.expect_err("busy");
        assert!(refused.message.contains("busy with another turn"), "{}", refused.message);
        eventually_on!(&[&handle.cell.stepped], || handle.cell.queued.load().is_empty().then_some(())).await;
        hold.notify_one();
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    }

    /// `observeSessionTurns`: the observer hears each turn start and the run host's final
    /// result unchanged, until it stops observing; a session not hosted here reports nothing.
    #[tokio::test(start_paused = true)]
    async fn an_observer_hears_each_turn_and_its_final_result() {
        use crate::eventually_on;
        use crate::session::tests::idle;
        use crate::session::tests::start_thread;
        use crate::session::tests::turn;

        let rig = crate::session::testing::Rig::new();
        rig.set_script(Arc::new(|_run| {
            Box::pin(async move {
                let result = mixdog_agent::agent_tool::flow::seams::TurnResult {
                    content: "done".into(),
                    iterations: 2,
                    ..Default::default()
                };
                crate::session::RunOutcome::Completed(Box::new(result))
            })
        }));
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        let heard = Arc::new(Heard::default());
        let stop = directory.observe_session_turns(handle.id.as_str(), heard.clone()).expect("hosted here");
        turn(&handle, "go", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || (heard.0.lock().unwrap().len() == 2).then_some(())).await;
        assert_eq!(*heard.0.lock().unwrap(), ["start true", "settled true done/2"]);
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        stop();
        turn(&handle, "again", "op-2").await;
        eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        assert_eq!(heard.0.lock().unwrap().len(), 2, "no longer observed");
        assert!(directory.observe_session_turns("sess_elsewhere", heard).is_none());
    }

    /// A completion handed to a worker reaches its queue; a closed owner takes none.
    #[tokio::test(start_paused = true)]
    async fn a_completion_reaches_the_session_queue() {
        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let header = |value: Value| value.as_object().cloned().unwrap();
        directory.create_with_id(ThreadId::from("sess_worker"), header(json!({})), json!({})).await.expect("worker");
        directory.create_with_id(ThreadId::from("sess_owner"), header(json!({ "closed": true })), json!({})).await.expect("owner");
        let completions = SessionCompletions::new(directory.clone());
        let envelope = ENVELOPE;
        let meta = json!({ "execution_surface": "agent", "execution_id": "t1", "status": "completed" });
        assert!(completions.enqueue_completion("sess_worker", envelope, &meta));
        let worker = ThreadId::from("sess_worker");
        let queued = || {
            rig.store.records(&worker).iter().any(|(_, record)| {
                matches!(record, mixdog_store::schema::record::Record::Queue(q) if q.qid.as_str().starts_with("completion_"))
            })
        };
        crate::eventually_on!(&[&directory.handle(&worker).expect("loaded").cell.stepped], || queued().then_some(())).await;
        let owner = ThreadId::from("sess_owner");
        assert!(completions.notify("sess_owner", envelope, &meta), "the live owner takes it");
        let owner_queued = rig.store.records(&owner).iter().any(|(_, record)| matches!(record, mixdog_store::schema::record::Record::Queue(_)));
        assert!(!owner_queued, "a closed owner keeps nothing for the model");
        assert!(!completions.notify(" ", envelope, &meta));
    }

    /// `suppressDisplay`: the completion the live session showed wakes a turn whose input row is
    /// durable but adds no row; one queued without a listener shows its row when taken in.
    #[tokio::test(start_paused = true)]
    async fn a_shown_completions_turn_row_adds_no_second_row() {
        use crate::eventually_on;
        use crate::session::tests::idle;
        use crate::session::tests::start_thread;
        use mixdog_store::schema::record::Record;
        use mixdog_tools::exec::TaskNotifier;

        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        let rows = |records: &[(u64, Record)]| {
            records.iter().filter(|(_, r)| matches!(r, Record::Item(item) if item.role.as_ref().is_some_and(|r| r.as_str() == "user"))).count()
        };
        directory.finished(&handle.id, "agent", "t1", "completed", ENVELOPE.to_owned()).await;
        eventually_on!(&[&handle.cell.stepped], || (rows(&rig.store.records(&handle.id)) == 1 && idle(&handle)).then_some(())).await;
        let items = handle.cell.view.load_full().items.clone();
        assert_eq!(items.len(), 1, "the card alone: {items:?}");
        assert!(matches!(items[0].as_ref(), ThreadItemKind::ToolCall { .. }));

        // A worker's own completion has no listener: its row shows when its turn takes it in.
        let completions = SessionCompletions::new(directory.clone());
        let other = ENVELOPE.replace("t1", "t2");
        let meta = json!({ "execution_surface": "agent", "execution_id": "t2", "status": "completed" });
        assert!(completions.enqueue_completion(handle.id.as_str(), &other, &meta));
        eventually_on!(&[&handle.cell.stepped], || (rows(&rig.store.records(&handle.id)) == 2 && idle(&handle)).then_some(())).await;
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.view.load_full().items.len() == 2).then_some(())).await;
    }

    /// The live owner's cards (`execution-delivery.mjs`): a failed bodyless preview shows a card,
    /// a successful one does not, and the body that follows shows its own card.
    #[tokio::test(start_paused = true)]
    async fn the_live_owner_shows_the_cards_node_shows() {
        use crate::eventually_on;
        use crate::session::tests::start_thread;
        use mixdog_tools::exec::TaskNotifier;

        let rig = crate::session::testing::Rig::new();
        let directory = Arc::new(SessionDirectory::new(rig.deps()));
        let handle = start_thread(&directory).await;
        let completions = SessionCompletions::new(directory.clone());
        let cards = || {
            handle
                .cell
                .view
                .load_full()
                .items
                .iter()
                .filter(|item| matches!(item.as_ref(), ThreadItemKind::ToolCall { .. }))
                .count()
        };
        let preview = |status: &str| {
            format!("background task\ntask_id: t1\nsurface: agent\nstatus: {status}\nstarted: 2026-01-01T00:00:00.000Z")
        };
        let preview_meta = |status: &str| {
            json!({ "type": "agent_task_result", "model_visible": false, "execution_surface": "agent", "execution_id": "t1", "status": status })
        };
        assert!(completions.notify(handle.id.as_str(), &preview("completed"), &preview_meta("completed")));
        assert!(completions.notify(handle.id.as_str(), &preview("failed"), &preview_meta("failed")));
        eventually_on!(&[&handle.cell.stepped], || (cards() == 1).then_some(())).await;
        let has_body = || {
            handle.cell.view.load_full().items.iter().any(|item| match item.as_ref() {
                ThreadItemKind::ToolCall { meta, .. } => meta.ext.get("agentResponseHasBody") == Some(&Value::Bool(true)),
                _ => false,
            })
        };
        let body = "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>Agent \"rev\" completed</summary>\n<result>\nall done\n</result>\n</task-notification>";
        directory.finished(&handle.id, "agent", "t1", "completed", body.to_owned()).await;
        // The body of the same execution replaces its preview on the tail card.
        eventually_on!(&[&handle.cell.stepped], || has_body().then_some(())).await;
        directory.finished(&handle.id, "agent", "t1", "completed", body.to_owned()).await;
        mixdog_rt::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(cards(), 1, "one card for the execution; its body shows once");
    }
}
