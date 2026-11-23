//! The run observer over progress and the port, the task waits it tracks, and the sensitive failure log.

use super::*;

/// The open `task wait` calls, and the call ids that settled before any batch opened them (a streamed call's `EarlyResult`
/// can precede `ToolCalls`): a settled id is never opened. Every provider send is a generation: a settlement counts for the
/// send its call was issued in, so an eager call of an earlier send that settles late neither suppresses nor closes the
/// wait of a later send that reuses its id.
#[derive(Default)]
pub(super) struct TaskWaits {
    /// The send now running.
    pub(super) generation: u64,
    /// By call id: the task waited on, and the send the wait was opened in.
    pub(super) open: HashMap<String, (Option<String>, u64)>,
    /// The ids settled before opening, in the current send only.
    pub(super) settled: std::collections::HashSet<String>,
}

impl TaskWaits {
    pub(super) fn begin_send(&mut self) {
        self.generation += 1;
        self.settled.clear();
    }

    /// The task of a wait that opens now; `None` for one already open or already settled.
    pub(super) fn open(&mut self, id: &str, task: Option<String>) -> Option<Option<String>> {
        if self.open.contains_key(id) || self.settled.contains(id) {
            return None;
        }
        self.open.insert(id.to_owned(), (task.clone(), self.generation));
        Some(task)
    }

    /// The task of a wait that closes now; a settlement of the current send with no wait open waits for its batch.
    pub(super) fn settle(&mut self, id: &str, generation: u64) -> Option<Option<String>> {
        match self.open.get(id) {
            Some((_, opened)) if *opened == generation => self.open.remove(id).map(|(task, _)| task),
            Some(_) => None,
            None => {
                if generation == self.generation {
                    self.settled.insert(id.to_owned());
                }
                None
            }
        }
    }
}

/// Whether the stream of the current submission announces its chunks (`RunEvent::Chunk`): its text and reasoning deltas then
/// report no progress of their own. Each submission's stream decides it anew, so a provider's way of reporting never outlives
/// the request it came from: a fallback or a model switch to a provider that reports by its deltas has them counted.
#[derive(Default)]
pub(super) struct ChunkReporting(std::sync::atomic::AtomicBool);

impl ChunkReporting {
    pub(super) fn submission_started(&self) {
        self.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    pub(super) fn chunk(&self) {
        self.0.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// A text or reasoning delta of the current stream: progress of `kind` unless the stream reports by its chunks.
    pub(super) fn delta(&self, progress: &ProgressPublisher, kind: StreamKind) {
        if !self.0.load(std::sync::atomic::Ordering::Relaxed) {
            progress.stream_delta(kind);
        }
    }
}

/// A test's notice that the observer handled a settlement of a call (by id), whichever send it belongs to.
#[cfg(any(test, feature = "test-support"))]
pub(super) static SETTLED_HOOKS: std::sync::Mutex<Vec<(String, Arc<tokio::sync::Notify>)>> = std::sync::Mutex::new(Vec::new());

/// `RunObserver` over progress and the port: stage and stream marks feed the progress cell, shown
/// assistant text becomes `item/started` + `item/agentMessage/delta`.
pub(super) struct PortObserver {
    pub(super) observed: Arc<Mutex<Observed>>,
    pub(super) progress: Arc<ProgressPublisher>,
    pub(super) out: mpsc::UnboundedSender<Shown>,
    pub(super) streaming: Arc<Mutex<Segments>>,
    /// The Reasoning item the thinking text streams into, until the model moves on to text,
    /// tool calls or its usage report.
    pub(super) reasoning: Mutex<Option<(ItemId, String)>>,
    /// The tools of the latest request (`result.lastSendTools`).
    pub(super) last_send_tools: Mutex<Arc<[mixdog_core_api::domain::provider::ToolDefinition]>>,
    pub(super) chunked: ChunkReporting,
    /// The turn's live messages, which an early tool notice joins until its result commits.
    pub(super) live: LiveTurnPublisher,
    pub(super) rows: Arc<StoredRows>,
    /// The run's token: once it is cancelled the interruption's record is closed (Node finalizes the interrupted turn in the
    /// abort's own step, so a call that settles after the abort is closed as cancelled).
    pub(super) cancel: tokio_util::sync::CancellationToken,
    /// The session's conversation transcript (`onAssistantText` appends to it, `ask-callbacks.mjs:92`).
    pub(super) transcript: Option<mixdog_core_session::session::transcript_writer::TurnTranscript>,
    /// The turn's provider requests so far (`model_request_<n>`, `tool_batch_<n>`).
    pub(super) requests: std::sync::atomic::AtomicU32,
    /// The tool calls the current request's response streamed, `{ id, name, arguments }`.
    pub(super) streamed_calls: Mutex<Vec<Value>>,
    /// The early notices of calls that settled while the request's batch had not started: `Some` from the request's start to
    /// its `onToolPhaseStarted`. A streamed read can settle before the loop reaches the batch; Node installs the batch's cards
    /// and starts the batch first, then applies the results that came early (`turn-tool-cards.mjs`).
    pub(super) held_early: Mutex<Option<Vec<Value>>>,
    /// The batch's `task wait` calls not settled yet, by call id, with the task each waits on (`activeTaskWaitCallIds`).
    pub(super) task_waits: Mutex<TaskWaits>,
    /// Writes the run's draft (`checkpoint.schedule`) as the record above changes.
    pub(super) sink: Arc<PortSink>,
    /// The thread's model context, whose sensitive marks a tool batch's execution calls set.
    pub(super) context: mixdog_core_session::session::run::ModelContext,
    pub(super) agent_route: Option<(Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>, ThreadId)>,
}

impl PortObserver {
    /// Resolves once every report sent so far has been handed to the port.
    pub(super) fn barrier(&self) -> tokio::sync::oneshot::Receiver<()> {
        let (done, reached) = tokio::sync::oneshot::channel();
        let _ = self.out.send(Shown::Barrier(done));
        reached
    }

    /// `visibleToolCalls` keeping `activeTaskWaitCallIds`, and `beginSessionTaskWait` for each: the batch's `task wait` calls
    /// are what the turn now waits on.
    pub(super) fn open_task_waits(&self, calls: &[mixdog_core_api::domain::provider::ToolCall]) {
        let mut waits = lock(&self.task_waits);
        for call in calls.iter().filter(|call| mixdog_protocol::tool_visibility::is_task_wait(&call.name, Some(&call.arguments))) {
            let task = call.arguments.get("task_id").and_then(Value::as_str).map(str::to_owned);
            if let Some(task) = waits.open(&call.id, task) {
                self.progress.task_wait(true, task.as_deref());
            }
        }
        if !waits.open.is_empty() {
            let _ = self.out.send(Shown::Call(mixdog_core_session::session::run::CallMark::TaskWait(true)));
        }
    }

    /// A call's result: a `task wait` among it is over (`refreshTaskWaitSpinner`, the task wait's release).
    /// `generation` is the send the call was issued in; `None` for a result of the send running.
    pub(super) fn settle_task_wait(&self, call_id: &str, generation: Option<u64>) {
        let mut waits = lock(&self.task_waits);
        let generation = generation.unwrap_or(waits.generation);
        let closed = waits.settle(call_id, generation);
        #[cfg(any(test, feature = "test-support"))]
        SETTLED_HOOKS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|(id, _)| id == call_id)
            .for_each(|(_, signal)| signal.notify_one());
        let Some(task) = closed else { return };
        self.progress.task_wait(false, task.as_deref());
        if waits.open.is_empty() {
            let _ = self.out.send(Shown::Call(mixdog_core_session::session::run::CallMark::TaskWait(false)));
        }
    }

    /// Node's early notice, `recordToolResult`: the interruption keeps it, and the card completes now in the live turn rows, in
    /// completion order, until the call-order result commits. `generation` is the send its call was issued in, `None` for the
    /// send running.
    /// `kept`: the result is the one to keep for its call until the call's row commits; not that of a run the batch
    /// runs again (`early_result_superseded`), which settles the card and is never recovered as the call's result.
    pub(super) fn early_notice(&self, generation: Option<u64>, message: AgentMessage, kept: bool) {
        if let Some(id) = message.tool_call_id() {
            self.settle_task_wait(id, generation);
            self.live.early(id, mixdog_agent::compact::execution_tail::MessageRows::row(&*self.rows, &message));
        }
        // The thread's card closes now (`onToolResult`), from the row its result will be stored as.
        let early = row_of(&message);
        match lock(&self.held_early).as_mut() {
            Some(held) => held.push(early),
            None => {
                let _ = self.out.send(Shown::EarlyResult(early));
            }
        }
        if kept && !self.cancel.is_cancelled() {
            {
                let mut observed = lock(&self.observed);
                observed.started = true;
                observed.undrafted_results.push(row_of(&message));
                observed.results.push(message);
            }
            self.sink.draft(true);
        }
    }

    /// One report of model progress of `kind` (`markSessionStreamDelta`).
    pub(super) fn model_progress(&self, kind: ProgressKind) {
        self.progress.stream_delta(match kind {
            ProgressKind::Semantic => StreamKind::Semantic,
            ProgressKind::Reasoning => StreamKind::Reasoning,
            ProgressKind::Text => StreamKind::Text,
            ProgressKind::Tool => StreamKind::Tool,
        });
        if kind == ProgressKind::Tool {
            self.settle_text();
        }
        let _ = self.out.send(Shown::ToolStream);
    }

    /// A tool call began streaming (`onStreamItemStart` → `settleSegmentBeforeToolCall`): the text segment shown before it is
    /// final now, not when the response's row commits, and text after it is a segment of its own (`closeAssistantSegment`).
    pub(super) fn settle_text(&self) {
        if let Some(id) = lock(&self.streaming).close() {
            let _ = self.out.send(Shown::TextSettled(id));
        }
    }

    pub(super) fn reasoning(&self, text: String) {
        let id = {
            let mut open = lock(&self.reasoning);
            match open.as_mut() {
                Some((id, all)) => {
                    all.push_str(&text);
                    id.clone()
                }
                None => {
                    let id = new_item_id();
                    *open = Some((id.clone(), text.clone()));
                    let item = ThreadItem::Reasoning { id: id.clone(), summary: Vec::new(), content: Vec::new(), meta: ItemMeta::default() };
                    let _ = self.out.send(Shown::Started(item));
                    id
                }
            }
        };
        let _ = self.out.send(Shown::ReasoningDelta(id, text));
    }

    /// The model moved on (text, tool calls, usage) or the run ended: the open Reasoning item is
    /// complete, with all its thinking text.
    pub(super) fn end_reasoning(&self) {
        let done = lock(&self.reasoning).take();
        if let Some((id, text)) = done {
            let _ = self.out.send(Shown::ReasoningDone(id, text));
        }
    }
    pub(super) fn text(&self, text: String) {
        // An empty delta opens no segment: a segment is text shown.
        if text.is_empty() {
            return;
        }
        let (id, opened) = lock(&self.streaming).extend(&text);
        if opened {
            let item =
                ThreadItem::AgentMessage { id: id.clone(), text: MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: ItemMeta::default() };
            let _ = self.out.send(Shown::Started(item));
        }
        let _ = self.out.send(Shown::Delta(id, text));
    }
}

impl RunObserver for PortObserver {
    fn local_wait(&self, phase: Option<&'static str>) {
        self.progress.local_wait(phase);
    }

    fn request_started(&self, provider: &str, request: &mixdog_core_api::domain::provider::ModelRequest, effort: Option<&str>) {
        if let Some((liveness, thread)) = &self.agent_route {
            let route = serde_json::Map::from_iter([
                ("provider".into(), serde_json::json!(provider)),
                ("model".into(), serde_json::json!(request.model)),
                ("effort".into(), serde_json::json!(effort)),
                ("fast".into(), serde_json::json!(request.options.fast)),
                ("modelParameters".into(), serde_json::json!(request.options.model_parameters)),
            ]);
            liveness.publish_request_route(thread.as_str(), route);
        }
    }

    fn event(&self, event: RunEvent) {
        if let (RunEvent::AssistantText { text, .. }, Some(transcript)) = (&event, &self.transcript) {
            transcript.assistant_text(text);
        }
        match event {
            RunEvent::Stage(Stage::Connecting) => {
                lock(&self.observed).tools = false;
                self.progress.stage("connecting");
            }
            RunEvent::Stage(Stage::Streaming) => {
                self.progress.stage("streaming");
                let _ = self.out.send(Shown::Stage("streaming".to_owned(), None));
                let _ = self.out.send(Shown::Call(mixdog_core_session::session::run::CallMark::Streaming));
            }
            RunEvent::Stage(Stage::Requesting) => {
                self.progress.stage("requesting");
                let _ = self.out.send(Shown::Stage("requesting".to_owned(), None));
            }
            RunEvent::ProviderSendStarted => {
                lock(&self.observed).tools = false;
                self.sink.draft(true);
                let index = self.requests.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                lock(&self.streamed_calls).clear();
                lock(&self.task_waits).begin_send();
                let stale = lock(&self.held_early).replace(Vec::new());
                for row in stale.into_iter().flatten() {
                    let _ = self.out.send(Shown::EarlyResult(row));
                }
                let _ = self.out.send(Shown::ModelRequest(index, mixdog_app_protocol::v2::thread::ModelRequestPhase::Started, None));
            }
            // A tool block opens (`onStreamItemStart`): the text before it is a finished segment.
            RunEvent::ItemStart(kind) => {
                if kind == mixdog_core_api::domain::provider::ItemKind::Tool {
                    self.settle_text();
                }
            }
            RunEvent::ToolCallObserved(call) => {
                // A stream that reports no tool progress settles the text at the call's end; text after the call shows after
                // its card.
                self.settle_text();
                lock(&self.streaming).called();
                lock(&self.streamed_calls).push(serde_json::json!({ "id": call.id, "name": call.name, "arguments": call.arguments }));
            }
            RunEvent::ToolPhase(phase) => {
                let index = self.requests.load(std::sync::atomic::Ordering::Relaxed).max(1);
                let completed = matches!(phase, mixdog_agent::env::ToolPhase::Completed { .. });
                let _ = self.out.send(match phase {
                    mixdog_agent::env::ToolPhase::Started => Shown::ToolBatch(index, mixdog_app_protocol::v2::thread::ToolBatchPhase::Started, None),
                    mixdog_agent::env::ToolPhase::Completed { iteration, calls, elapsed_ms } => Shown::ToolBatch(
                        index,
                        mixdog_app_protocol::v2::thread::ToolBatchPhase::Completed,
                        Some((iteration, u32::try_from(calls).unwrap_or(u32::MAX), elapsed_ms)),
                    ),
                });
                if !completed {
                    for row in lock(&self.held_early).take().into_iter().flatten() {
                        let _ = self.out.send(Shown::EarlyResult(row));
                    }
                }
                // `onToolPhaseCompleted`: the spinner goes back to `requesting`.
                if completed {
                    let _ = self.out.send(Shown::Call(mixdog_core_session::session::run::CallMark::ToolPhaseCompleted));
                }
            }
            RunEvent::Stage(Stage::WaitingOnProvider) => self.progress.stream_delta(StreamKind::Keepalive),
            RunEvent::Stage(Stage::ApprovalWait { waiting }) => {
                if waiting {
                    let _ = self.out.send(Shown::Call(mixdog_core_session::session::run::CallMark::ToolApproval));
                }
                self.progress.approval_wait(waiting);
            }
            RunEvent::TextDelta(text) => {
                self.end_reasoning();
                self.chunked.delta(&self.progress, StreamKind::Text);
                if !text.is_empty() {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.text.push_str(&text);
                }
                self.sink.draft(false);
                self.text(text);
            }
            // `relayProgressUpdate`: shown as the reply's text is, in the same segment; the reply's own text does not hold it.
            // An interrupted request keeps it as text it had shown (Node relays it through the callback its interruption
            // snapshot records).
            RunEvent::ProgressDelta(text) => {
                self.end_reasoning();
                self.chunked.delta(&self.progress, StreamKind::Text);
                if !text.is_empty() {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.text.push_str(&text);
                    drop(observed);
                    lock(&self.streaming).update();
                }
                self.sink.draft(false);
                self.text(text);
            }
            RunEvent::ReasoningDelta(text) => {
                self.chunked.delta(&self.progress, StreamKind::Reasoning);
                if !text.is_empty() {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.reasoning.push_str(&text);
                }
                self.sink.draft(false);
                self.reasoning(text);
            }
            RunEvent::Stage(Stage::Notice { message, tone }) => {
                let _ = self.out.send(Shown::Notice(message, tone));
            }
            RunEvent::Usage { iteration, usage, delta } => {
                self.end_reasoning();
                // The request's completion, with the calls its response streamed, before its usage (Node observes each call as
                // it streams, then the usage that completes the request).
                let calls = std::mem::take(&mut *lock(&self.streamed_calls));
                let index = self.requests.load(std::sync::atomic::Ordering::Relaxed).max(1);
                let _ = self.out.send(Shown::ModelRequest(
                    index,
                    mixdog_app_protocol::v2::thread::ModelRequestPhase::Completed,
                    (!calls.is_empty()).then_some(calls),
                ));
                *lock(&self.last_send_tools) = delta.send_tools.clone();
                let report = Shown::Usage(mixdog_core_session::session::UsageReport::from_event(iteration, usage, delta));
                send_prepared(&self.out, &self.sink.port, report);
            }
            RunEvent::Compact(event) => {
                let _ = self.out.send(Shown::Compact(event));
            }
            RunEvent::CompactPass(pass) => {
                send_prepared(&self.out, &self.sink.port, Shown::Pass(pass));
            }
            RunEvent::CompactUsage { iteration, usage, reasoning_tokens, reasoning_tokens_complete, input_excludes_cache } => {
                let _ = self.out.send(Shown::CompactUsage(mixdog_core_session::session::CompactUsageReport {
                    iteration,
                    usage,
                    reasoning_tokens,
                    reasoning_tokens_complete,
                    input_excludes_cache,
                }));
            }
            RunEvent::ToolStream(kind) => self.model_progress(kind),
            RunEvent::Transport => self.progress.stream_delta(StreamKind::Transport),
            RunEvent::Boundary { submission, attempt, boundary } => self.progress.boundary(submission, attempt, boundary),
            RunEvent::SubmissionStarted { id } => {
                self.chunked.submission_started();
                self.progress.submission_started(id);
            }
            RunEvent::Chunk(kind) => {
                self.chunked.chunk();
                match kind {
                    Some(kind) => self.model_progress(kind),
                    // A chunk that reports no kind is transport health (`onStreamDelta('transport')`).
                    None => self.progress.stream_delta(StreamKind::Transport),
                }
            }
            // Node's syncContextDisplayFields (context-state.mjs:116): the window the status shows and the compaction trigger, once known (> 0).
            // A send that compacts nothing also records its check (`compactTelemetry(ctx, 'pre_send_check')`).
            RunEvent::ContextPressure { will_compact, trigger_tokens, boundary_tokens, context_window, messages, tools, reactive, .. } => {
                let positive = |tokens: u64| i64::try_from(tokens).ok().filter(|tokens| *tokens > 0);
                let window = context_window.and_then(positive);
                let context = mixdog_app_protocol::v2::thread::ThreadContext {
                    context_window: window,
                    display_context_window: window,
                    auto_compact_token_limit: positive(trigger_tokens),
                    compact_boundary_tokens: positive(boundary_tokens),
                    ..Default::default()
                };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::Context(context)));
                if !will_compact {
                    let check = Shown::Check(mixdog_core_session::session::run::SendCheck { messages, tools, reactive });
                    send_prepared(&self.out, &self.sink.port, check);
                }
            }
            // The context section is the route's window choice (`runtime.contextPercent`, exact `contextTokens` only for a
            // non-default window), never the usage reading: usage reaches clients as `thread/tokenUsage/updated`.
            // `applyStageChange('account-changed')`: the selection change is thread state, never a transcript item.
            // The pool's `onStageChange('reconnecting', { message })` before it retries on the next account: the
            // client's status (`applyStageChange`: the spinner's mode and verb), never a transcript notice.
            // A provider ladder's `emitProviderRetryStage` before its wait: the client's status, as Node raises it.
            RunEvent::Stage(Stage::Reconnecting { payload: Some(payload), .. }) => {
                // The retry's time reaches the run's status, and the wait until then is the schedule's, not silence.
                if let Some(retry_at) = payload.get("retryAt").and_then(Value::as_i64) {
                    self.progress.retry_scheduled(retry_at);
                }
                let _ = self.out.send(Shown::Stage("reconnecting".to_owned(), Some(payload)));
            }
            RunEvent::Stage(Stage::AccountSwitching { message }) => {
                let _ = self.out.send(Shown::Stage("reconnecting".to_owned(), Some(serde_json::json!({ "message": message }))));
            }
            RunEvent::Stage(Stage::AccountChanged { provider, account_id, at }) => {
                let change = mixdog_app_protocol::v2::thread::ProviderAccountChange { provider, account_id, at };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::ProviderAccount(change)));
            }
            // The pass shows as the spinner's `compacting`; the next send's `requesting` or the turn's end takes it off, a skipped or failed pass included.
            RunEvent::Stage(Stage::ModelThinking) => {
                let _ = self.out.send(Shown::Stage("model_thinking".to_owned(), None));
            }
            RunEvent::Stage(Stage::Compacting) => {
                let _ = self.out.send(Shown::Stage("compacting".to_owned(), None));
            }
            RunEvent::Stage(Stage::ModelFallback { model }) => {
                let route = mixdog_app_protocol::v2::thread::ThreadRoute { session_model: Some(model), ..Default::default() };
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::Route(route)));
            }
            RunEvent::TurnEffort(effort) => {
                let _ = self.out.send(Shown::Section(mixdog_core_ports::ports::threads::Section::TurnEffort(effort)));
            }
            // On the loop's own task, before the assistant turn carrying the calls is committed (its encode reads the marks).
            RunEvent::ExecutionCalls(calls) => {
                let calls: Vec<Value> = calls.iter().map(|call| json!({ "id": call.id, "name": call.name, "arguments": call.arguments })).collect();
                self.context.remember_sensitive(&calls);
            }
            RunEvent::ToolCalls { calls, .. } => {
                {
                    let mut observed = lock(&self.observed);
                    observed.started = true;
                    observed.tools = true;
                    observed.calls.extend(calls.iter().cloned());
                }
                self.sink.draft(true);
                self.end_reasoning();
                let _ = self.out.send(Shown::Call(mixdog_core_session::session::run::CallMark::ToolCall));
                self.progress.stage("tool_running");
                for call in &calls {
                    self.progress.tool_call(Some(&call.name));
                }
                self.open_task_waits(&calls);
            }
            RunEvent::ToolResult { call_id, .. } => self.settle_task_wait(&call_id, None),
            RunEvent::EarlyResult(message) => self.early_notice(None, message, true),
            _ => {}
        }
    }

    fn send_generation(&self) -> u64 {
        lock(&self.task_waits).generation
    }

    fn early_result_of(&self, generation: u64, message: AgentMessage) {
        self.early_notice(Some(generation), message, true);
    }

    fn early_result_superseded(&self, generation: u64, message: AgentMessage) {
        self.early_notice(Some(generation), message, false);
    }

    /// The draft holds the result of a call's last execution: what an earlier run of `call_id` left there is taken back
    /// (from the file too, when it reached it), and `result` takes its place.
    fn early_result_replaced(&self, _generation: u64, call_id: &str, result: Option<AgentMessage>) {
        if self.cancel.is_cancelled() {
            return;
        }
        {
            let mut observed = lock(&self.observed);
            let (held, unwritten) = (observed.results.len(), observed.undrafted_results.len());
            observed.results.retain(|early| early.tool_call_id() != Some(call_id));
            observed.undrafted_results.retain(|early| early.get("toolCallId").and_then(Value::as_str) != Some(call_id));
            // Held and no longer waiting to be written: the file has it.
            if held != observed.results.len() && unwritten == observed.undrafted_results.len() {
                observed.undrafted_withdrawn.push(call_id.to_owned());
            }
            if let Some(message) = result {
                observed.started = true;
                observed.undrafted_results.push(row_of(&message));
                observed.results.push(message);
            }
        }
        self.sink.draft(true);
    }

    fn can_retract(&self) -> bool {
        false
    }

    fn retract_text(&self, _retraction: TextRetraction) -> Retracted {
        Retracted::Refused
    }
}

/// The run's failure log with each failed call's arguments through the thread's sensitive projection and its result text
/// with the thread's values replaced: the log is a file (`history/tool-failures.jsonl`), so a failed sensitive fill's
/// value goes there as its marker, also where the tool's error repeats it. Node summarizes the arguments as they are
/// (`agent-trace-format.mjs:526`, `summarizeToolArgs`) and takes the error line from the result text as it is, and so
/// writes the value to disk: fixed on both sides (`redactSensitiveToolCall(sessionId, { arguments: toolArgs })`,
/// `redactSensitiveText(sessionId, resultText)`, `node-fix-sensitive-side-writes.patch`).
pub(super) struct SensitiveFailures {
    pub(super) inner: Arc<dyn mixdog_agent::env::ToolFailureLog>,
    pub(super) context: mixdog_core_session::session::run::ModelContext,
}

impl mixdog_agent::env::ToolFailureLog for SensitiveFailures {
    fn failed(&self, mut call: mixdog_agent::env::FailedCall) {
        call.tool_args = self.context.redact_arguments(&call.tool_args);
        call.result_text = self.context.redact_text(&call.result_text);
        self.inner.failed(call);
    }

    fn stall_abort(&self, ctx: serde_json::Map<String, Value>) {
        self.inner.stall_abort(ctx);
    }

    /// The `batch` row holds each call's id, tool name and array lengths, no argument: passed on as it is. Without this the
    /// trait's no-op would drop the row.
    fn batch(&self, batch: &mixdog_agent::env::ToolBatch) {
        self.inner.batch(batch);
    }

    /// The `tool` row (and, for an error call, its failure row) holds the call's arguments and result: the arguments go through
    /// the thread's projection and a text result has the thread's values replaced, as `traceAgentTool` does
    /// (`agent-trace-format.mjs`: `redactSensitiveText` only when `resultText` is a string).
    fn tool(&self, mut call: mixdog_agent::env::TracedCall) {
        call.tool_args = self.context.redact_arguments(&call.tool_args);
        call.result_text = self.context.redact_text(&call.result_text);
        if let Value::String(text) = &call.result {
            call.result = Value::String(self.context.redact_text(text));
        }
        self.inner.tool(call);
    }

    /// The `cache_break` row holds the prompt's cache facts, no call's text: passed on as it is.
    fn cache_break(&self, record: serde_json::Map<String, Value>) {
        self.inner.cache_break(record);
    }

    /// The `loop` row holds no call's arguments or text: passed on as it is.
    fn provider_send(&self, send: mixdog_agent::env::ProviderSend) {
        self.inner.provider_send(send);
    }

    /// The `usage_raw` row holds token counts and the provider's usage object, no call's text: passed on as it is.
    fn request_usage(&self, usage: mixdog_agent::env::RequestUsage) {
        self.inner.request_usage(usage);
    }
}
