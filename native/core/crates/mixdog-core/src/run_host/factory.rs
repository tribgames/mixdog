//! The real [`RunFactory`]: a session turn (`RunStart`) becomes a `mixdog-agent` run and its
//! outcome (`RunOutcome`).
//!
//! What a turn needs that only the host knows is gathered in [`RunParts::assemble`] (each field of
//! [`Assembled`] names its owner); everything that follows from the `RunStart` itself is built
//! here: the cancel signal, the turn review and its gate, the model context and its stored rows,
//! the commit sink, the steering queue, the observer, progress and live-turn publishing, and the
//! outcome.

// Transparent callback/state names; existing ownership and call signatures are unchanged.
type ToolResultCallback = dyn Fn(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage) + Send + Sync;
type SinkState = (Arc<Mutex<Segments>>, Arc<Mutex<Observed>>);

/// The text segments of the response streaming now, in order (`committedSegments` and the open segment of `turn-stream.mjs`):
/// each a live item of its own, with how many bytes of the response's text it holds. A tool block's start closes the open one
/// (`closeAssistantSegment`), and text after it opens the next under a new id; a closed segment's id is never reused. The
/// response commits as one assistant message (the model's context), whose row names its segments ([`Segments::take`]).
#[derive(Default)]
pub(crate) struct Segments {
    /// Each segment: its id, its bytes of the text, and how many of the response's tool calls streamed before it.
    closed: Vec<(ItemId, usize, usize)>,
    open: Option<(ItemId, usize, usize)>,
    /// The response's tool calls streamed so far.
    calls: usize,
    /// Everything shown of the response, in order.
    shown: String,
    /// A progress update is part of what was shown: the response's own text is then not what its segments cut.
    updates: bool,
}

impl Segments {
    /// What streams next is a progress update: shown where the text is, no part of the response's text.
    fn update(&mut self) {
        self.updates = true;
    }

    /// `text` streams: into the open segment, else a new one. The segment's id, and whether it opened now.
    fn extend(&mut self, text: &str) -> (ItemId, bool) {
        self.shown.push_str(text);
        match &mut self.open {
            Some((id, len, _)) => {
                *len += text.len();
                (id.clone(), false)
            }
            None => {
                let id = new_item_id();
                self.open = Some((id.clone(), text.len(), self.calls));
                (id, true)
            }
        }
    }

    /// A tool call of the response streamed whole: a segment after it shows after its card.
    fn called(&mut self) {
        self.calls += 1;
    }

    /// Closes the open segment: its id, when one was open.
    fn close(&mut self) -> Option<ItemId> {
        let open = self.open.take()?;
        let id = open.0.clone();
        self.closed.push(open);
        Some(id)
    }

    /// The response's segments, taken whole as its message commits: the row's id (its first segment's) and what the row's
    /// `meta` names of the showing, which the transcript reads back to show the same rows. `segments` when the text was not
    /// shown whole before the calls, as more than one or after a call (`[{id, len, after}]`, `len` in bytes of the shown
    /// text, `after` the tool calls before it), and `shownText` when progress updates were shown among it: the text shown,
    /// which the message's own text then is not.
    fn take(&mut self) -> Option<(ItemId, serde_json::Map<String, Value>)> {
        let mut all = std::mem::take(&mut self.closed);
        all.extend(self.open.take());
        self.calls = 0;
        let (shown, updates) = (std::mem::take(&mut self.shown), std::mem::take(&mut self.updates));
        let first = all.first()?.0.clone();
        let mut named = serde_json::Map::new();
        if all.len() > 1 || all[0].2 > 0 {
            named.insert("segments".into(), Value::Array(all.iter().map(|(id, len, after)| json!({ "id": id.as_str(), "len": len, "after": after })).collect()));
        }
        if updates {
            named.insert("shownText".into(), Value::String(shown));
        }
        Some((first, named))
    }
}

/// `row`'s `meta` with what it names of how its reply was shown ([`Segments::take`]).
fn with_shown(row: &mut Value, named: serde_json::Map<String, Value>) {
    if !named.is_empty()
        && let Some(object) = row.as_object_mut()
        && let Some(meta) = object.entry("meta").or_insert_with(|| json!({})).as_object_mut()
    {
        meta.extend(named);
    }
}
type SinkServices = (Arc<dyn Clock>, Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>);

use std::collections::HashMap;
use super::failed_turn_rewind;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_agent::env::{
    Clock, Compactor, Reactions, ResultReuse, RouteFallback, RunEnv, RunEvent, RunObserver, SkillSelector, Stage, TailReminder, TextRetraction, Retracted, Ticket, ToolGate,
    ToolHooks, TranscriptSink, TurnGuards,
};
use mixdog_agent::compact::blob_reads::with_blobs;
use mixdog_agent::env::CommitError;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::tools::{ToolEnv, ToolSet};
use mixdog_agent::{AgentError, Run, RunCarry, RunConfig};
use mixdog_core_api::domain::provider::{Content, ProgressKind, ProviderAdapter, Role};
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::ids::{ItemId, ThreadId, TurnId};
use mixdog_protocol::message_class::row_facts;
use mixdog_protocol::message_class::user_text::UserText;
use mixdog_protocol::{ItemMeta, MaybeBlob, ThreadItem, TurnError};
use mixdog_rt::TaskClass;
use mixdog_tools::policy::SessionSurface;
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use super::live_turn::LiveTurnPublisher;
use super::watchdog::{StallSite, Watchdog, registration_id, stall_abort_ctx};
use mixdog_agent::agent_tool::progress::Snapshot;
use mixdog_agent::agent_tool::watchdog::{is_watchdog_abort, resolve_policy, AgentKind, Overrides};
use super::message_row::{message_of, row_of};
use mixdog_core_run::run_host::progress::ProgressPublisher;
use mixdog_core_run::run_host::progress::StreamKind;
use super::retry::{RandomJitter, TimerWait};
use super::steer::SteerQueue;
use super::quiet_watch::QuietWatch;
use super::tool_progress::{RunToolProgress, ToolHints};
use mixdog_core_session::session::turn_snapshot::ReviewGate;
use mixdog_core_session::session::failure_record::provider_turn_error;
use mixdog_core_session::session::ItemCommit;
use mixdog_core_session::session::RunFactory;
use mixdog_core_session::session::RunOutcome;
use mixdog_core_session::session::RunPort;
use mixdog_core_session::session::RunStart;
use mixdog_core_session::session::run::Queued;
use mixdog_core_session::session::run::RunError;
use mixdog_core_session::session::StoredRows;

/// What the policy gate needs from the run it gates, which exists only after assembly.
pub struct GateContext {
    pub observer: Arc<dyn RunObserver>,
    pub cancel: tokio_util::sync::CancellationToken,
    pub guards: Arc<dyn TurnGuards>,
    pub approvals: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>,
}

/// What the explicit skill selector needs from the run it serves, which exists only after assembly.
pub struct SkillContext {
    pub gate: Arc<dyn ToolGate>,
    pub env: ToolEnv,
    pub cancel: tokio_util::sync::CancellationToken,
}

/// Builds the turn's skill selector from the run's gate, environment and token.
pub type SkillsBuilder = Box<dyn FnOnce(SkillContext) -> Arc<dyn SkillSelector> + Send>;

/// Builds the turn's gate (PolicyGate) from the run's observer, token and guards.
pub type GateBuilder = Box<dyn FnOnce(GateContext) -> Arc<dyn ToolGate> + Send>;

pub struct RunHostFactory {
    parts: Arc<dyn RunParts>,
    /// The map TurnLiveness writes: one entry per run, read by the pool, the thread list and the report host.
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    /// The registry the hosted web search reports its spend to (`registerNativeWebSearchUsageSink`): the one `SenderDeps.sinks` holds.
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
}

impl RunHostFactory {
    pub fn new(
        liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
        search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
        parts: Arc<dyn RunParts>,
    ) -> Self {
        Self { parts, liveness, search_usage }
    }
}

pub(super) use mixdog_core_session::session::run::new_item_id;

fn failed(message: impl Into<String>, data: Value) -> RunOutcome {
    RunOutcome::Failed(TurnError { message: message.into(), data, provider_error: None })
}

/// What a run that ended before its model loop reads as ([`setup_end`]).
#[derive(Debug, PartialEq, Eq)]
enum SetupEnd {
    /// The outcome as the setup reported it.
    AsReported,
    /// The progress watchdog's stop: a stalled failure whose sentence is the error, as after the loop.
    Stalled,
    /// A stop: a stopped turn, closed as `finalizeCancelledTurn` closes one that produced nothing.
    Stopped,
}

/// Node's abort rejects the turn wherever it stands and `askSession` closes it as stopped (`finalizeCancelledTurn`,
/// `ask-turn-failure.mjs`; the stop itself takes the prompt back, `abort.mjs` `reclaimInFlightPrompt`). The run's own
/// waits here end with its fired token (`RunPort::scoped`), so a setup step that was waiting on a save reports a
/// failure of its own ("the session's title could not be saved"): a failure reported before the model was asked
/// (`asked`) by a run whose token has fired is that stop, not a failed turn.
fn setup_end(failed: bool, asked: bool, cancelled: bool, abort_reason: Option<&str>) -> SetupEnd {
    if !failed || asked || !cancelled {
        return SetupEnd::AsReported;
    }
    if abort_reason.is_some_and(is_watchdog_abort) {
        return SetupEnd::Stalled;
    }
    SetupEnd::Stopped
}

/// What `finalizeInterruptedTurn` leaves of a prompt whose turn was stopped before anything was asked of the model, for
/// the stop's reason: whether the prompt's row leaves (a user's stop that hands it back), and the rows that follow it
/// when it stays (the interruption line of a stop that keeps the prompt).
fn stopped_prompt(input: &AgentMessage, reason: mixdog_agent::interrupt::AbortReason) -> (bool, Vec<AgentMessage>) {
    use mixdog_agent::interrupt::{finalize_interrupted_turn, Interrupted, Phase};
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript: vec![input.clone()],
        current_user_text: input.text(),
        response_started: false,
        partial_assistant: String::new(),
        partial_reasoning: String::new(),
        observed_tool_calls: Vec::new(),
        observed_tool_results: Vec::new(),
        phase: Phase::Streaming,
        reason,
    });
    (!finalized.user_turn_preserved, finalized.transcript.into_iter().skip(1).collect())
}

/// What a stop that lands before the model loop needs of the run: the loop closes a stop that lands inside it
/// ([`close_cancelled`]); this closes one that ends the run's setup.
struct BeforeLoop {
    port: RunPort,
    input_item: ItemId,
    input_body: Value,
    cancel: tokio_util::sync::CancellationToken,
    signal: mixdog_agent::cancel::Cancel,
    /// Set once the run reaches its model loop.
    asked: Arc<std::sync::atomic::AtomicBool>,
}

impl BeforeLoop {
    async fn settle(self, outcome: RunOutcome) -> RunOutcome {
        let reported_failure = matches!(outcome, RunOutcome::Failed(_));
        let reason = self.signal.is_aborted().then(|| self.signal.reason());
        match setup_end(reported_failure, self.asked.load(Ordering::SeqCst), self.cancel.is_cancelled(), reason.as_deref()) {
            SetupEnd::AsReported => outcome,
            SetupEnd::Stalled => failed(reason.unwrap_or_default(), Value::Null),
            SetupEnd::Stopped => {
                // The run's token has fired: what closes the stopped turn is saved on a port whose waits outlive it.
                let port = self.port.closing();
                if let Ok(input) = message_of(&self.input_body) {
                    let (rewound, following) = stopped_prompt(&input, self.signal.close_reason());
                    if rewound {
                        // A row the thread shows under another id is taken by the actor when the turn closes (`apply_reclaim`).
                        if let Err(error) = port.prompt_rewound(self.input_item.clone()).await {
                            tracing::warn!("[session] rewound prompt save failed: {error:?}");
                        }
                    }
                    for message in &following {
                        let item = ItemCommit { iid: new_item_id(), role: Some("user".to_owned()), model: true, visible: false, body: row_of(message), prompt: None };
                        if let Err(error) = port.commit_item(item).await {
                            tracing::warn!("[session] interrupted turn row save failed: {error:?}");
                        }
                    }
                }
                RunOutcome::Interrupted
            }
        }
    }
}

// ---- the commit sink ---------------------------------------------------------------------------------

/// Where a row stands among the run's shown reports ([`Shown::Row`]): answered by the forwarder once every report before the
/// row has reached the port, with the sender it waits on until the row is handed over. Dropped unanswered when the forwarder
/// stops (the run cancelled, its task ended or panicked, its channel gone).
type RowPlace = tokio::sync::oneshot::Receiver<tokio::sync::oneshot::Sender<()>>;

/// How a row's hand-over stands after [`row_handover`].
enum Handover {
    /// Every report before the row reached the port: the row goes now, and the forwarder, waiting on this sender, takes the
    /// reports after it once the row is handed over.
    Reached(tokio::sync::oneshot::Sender<()>),
    /// The row has no place (a sink that shows nothing): it goes now.
    Unplaced,
    /// The forwarder stopped before reaching the row's place: nothing it still held will reach the port, so the row goes now.
    Gone,
}

/// The one wait of a row's hand-over (hence of `accepted`, which the tool start waits on): the forwarder reaching the row's
/// place among the shown reports. What it can wait for, and why that is bounded:
/// - the reports ahead of the row being sent to the port: each is a send into the producer lane, which waits only for
///   lane room, as the row's own send does;
/// - the media preparation of a report ahead of it ([`Shown::Prepared`]): every preparation starts when its report is
///   produced and runs beside the others, so the wait is the remaining preparation of the slowest report ahead, never a
///   sum of preparations run one after another; a text delta, a card or any other report waits on nothing;
/// - the hand-over of the row before it, which is this same wait.
///
/// It never outlasts the forwarder: a cancelled run ends the forwarder and its preparations, and a forwarder that ends any
/// other way (its task panicked or was dropped, its channel closed) drops the place unanswered. The row then goes at once
/// ([`Handover::Gone`]), so neither the run's flush nor its saves ever wait on forwarding that will not happen.
async fn row_handover(place: Option<RowPlace>) -> Handover {
    match place {
        None => Handover::Unplaced,
        Some(place) => match place.await {
            Ok(handed) => Handover::Reached(handed),
            Err(_) => Handover::Gone,
        },
    }
}

/// Where the skills a prompt loaded are stamped: the thread's row of that prompt.
struct AppliedSkills {
    parts: Arc<dyn RunParts>,
    thread: ThreadId,
    /// The turn's input row, which the actor committed, and the message id it carries.
    input: (Option<String>, ItemId),
}

/// What `beginTurn` (`tui/session/turn.mjs`) gave the turn, as its assistant rows and its completion take it.
struct TurnStamp {
    /// `attemptId` and the route fields of the input row's `meta.transcript`
    /// (`persistedAssistantTranscriptMetadata`: the attempt and `transcriptRouteMetadataFields`).
    carried: serde_json::Map<String, Value>,
    /// `rawTranscriptMeta.at`, else the ask's start.
    started_at: i64,
    /// The turn's change-record key, which its completion names.
    checkpoint_id: Option<String>,
    /// `pickDoneVerb(stats.turns)`.
    verb: &'static str,
}

impl TurnStamp {
    fn of(input_body: &Value, verb: &'static str, asked_at: i64) -> Option<Self> {
        let transcript = input_body.pointer("/meta/transcript")?.as_object()?;
        let text = |key: &str| transcript.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
        let carried = ["attemptId", "modelId", "model", "provider", "agent"]
            .into_iter()
            .filter_map(|key| text(key).map(|value| (key.to_owned(), json!(value))))
            .collect();
        Some(Self {
            carried,
            started_at: transcript.get("at").and_then(Value::as_i64).filter(|at| *at != 0).unwrap_or(asked_at),
            checkpoint_id: text("checkpointId").map(str::to_owned),
            verb,
        })
    }
}

/// A task that carries a turn's events to its session (the run's shown events, its commits): a replay's settled signal counts
/// it with the turn (mixdog-ai `replay_bytes::in_run`), so the turn is not settled while an event it sent is still on the way.
fn turn_task<F: std::future::Future>(task: F) -> impl std::future::Future<Output = F::Output> {
    #[cfg(feature = "replay-bytes")]
    return mixdog_ai::transport::replay_bytes::in_run(task);
    #[cfg(not(feature = "replay-bytes"))]
    task
}

/// A [`turn_task`]'s wait for the turn's next event: a wait on the turn, parked for a replay's settled signal.
fn turn_input<F: std::future::Future>(wait: F) -> impl std::future::Future<Output = F::Output> {
    #[cfg(feature = "replay-bytes")]
    return mixdog_ai::transport::replay_bytes::parked(wait);
    #[cfg(not(feature = "replay-bytes"))]
    wait
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What the interrupted request had produced that the transcript does not hold yet
/// (`createTurnInterruptionTracker`): the run's observer fills it, the sink empties it when an assistant message commits.
#[derive(Default)]
struct Observed {
    started: bool,
    text: String,
    reasoning: String,
    /// `markToolPhaseStarted`; a new send (`markProviderSendStarted`) puts it back.
    tools: bool,
    calls: Vec<mixdog_core_api::domain::provider::ToolCall>,
    /// Results that settled but were not committed in call order (`__earlyNotify`).
    results: Vec<AgentMessage>,
    /// How much of the above the run's draft holds (`journalDelta`'s cursor): the lengths of `text`, `reasoning` and
    /// `calls`, the phase, and the early results not yet written.
    drafted_text: usize,
    drafted_reasoning: usize,
    drafted_calls: usize,
    drafted_tools: bool,
    undrafted_results: Vec<Value>,
}

impl Observed {
    /// `markAssistantMessageCommitted`: the message holds what was drafted of it.
    fn message_committed(&mut self) {
        self.text.clear();
        self.reasoning.clear();
        self.calls.clear();
        self.drafted_text = 0;
        self.drafted_reasoning = 0;
        self.drafted_calls = 0;
    }

    /// What the draft gained since its last write (a `draft` record's body, `RunDraft`), or `None`.
    fn undrafted(&mut self) -> Option<Value> {
        let mut body = serde_json::Map::new();
        if self.text.len() > self.drafted_text {
            body.insert("text".into(), json!(self.text[self.drafted_text..]));
            self.drafted_text = self.text.len();
        }
        if self.reasoning.len() > self.drafted_reasoning {
            body.insert("reasoning".into(), json!(self.reasoning[self.drafted_reasoning..]));
            self.drafted_reasoning = self.reasoning.len();
        }
        if self.calls.len() > self.drafted_calls {
            let calls = row_of(&AgentMessage::assistant("", self.calls[self.drafted_calls..].to_vec()));
            body.insert("calls".into(), calls.get("toolCalls").cloned().unwrap_or_default());
            self.drafted_calls = self.calls.len();
        }
        if !self.undrafted_results.is_empty() {
            body.insert("results".into(), Value::Array(std::mem::take(&mut self.undrafted_results)));
        }
        if self.tools != self.drafted_tools {
            body.insert("tools".into(), json!(self.tools));
            self.drafted_tools = self.tools;
        }
        (!body.is_empty()).then_some(Value::Object(body))
    }
}

/// The open `task wait` calls, and the call ids that settled before any batch opened them (a streamed call's `EarlyResult`
/// can precede `ToolCalls`): a settled id is never opened. Every provider send is a generation: a settlement counts for the
/// send its call was issued in, so an eager call of an earlier send that settles late neither suppresses nor closes the
/// wait of a later send that reuses its id.
#[derive(Default)]
struct TaskWaits {
    /// The send now running.
    generation: u64,
    /// By call id: the task waited on, and the send the wait was opened in.
    open: HashMap<String, (Option<String>, u64)>,
    /// The ids settled before opening, in the current send only.
    settled: std::collections::HashSet<String>,
}

impl TaskWaits {
    fn begin_send(&mut self) {
        self.generation += 1;
        self.settled.clear();
    }

    /// The task of a wait that opens now; `None` for one already open or already settled.
    fn open(&mut self, id: &str, task: Option<String>) -> Option<Option<String>> {
        if self.open.contains_key(id) || self.settled.contains(id) {
            return None;
        }
        self.open.insert(id.to_owned(), (task.clone(), self.generation));
        Some(task)
    }

    /// The task of a wait that closes now; a settlement of the current send with no wait open waits for its batch.
    fn settle(&mut self, id: &str, generation: u64) -> Option<Option<String>> {
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

/// A test's notice that the observer handled a settlement of a call (by id), whichever send it belongs to.
#[cfg(any(test, feature = "test-support"))]
static SETTLED_HOOKS: std::sync::Mutex<Vec<(String, Arc<tokio::sync::Notify>)>> = std::sync::Mutex::new(Vec::new());

// ---- the turn ----------------------------------------------------------------------------------------

/// A message of the turn's context as the turn keeps it: its stored row, which the message shares, or the message itself
/// when it has none.
enum HistoryRow {
    Stored(Arc<serde_json::Map<String, Value>>),
    Message(AgentMessage),
}

impl HistoryRow {
    /// The message: the row read back as it was read when the turn began (the same row, the same codec).
    fn message(&self) -> AgentMessage {
        match self {
            HistoryRow::Stored(stored) => mixdog_agent::message_row::message_of_stored(stored).expect("a row the turn read once reads again"),
            HistoryRow::Message(message) => message.clone(),
        }
    }
}

/// Responses projects from stamped rows, not from the current request option
/// alone. The current row must supersede an earlier turn even at saved effort.
fn stamp_outgoing_effort(row: &mut Value, config: &RunConfig) {
    if let Some(seed) = config.effort.as_ref().and_then(|wiring| wiring.route.seed.as_ref())
        && let Some(row) = row.as_object_mut()
        && let Some(meta) = row.entry("meta").or_insert_with(|| json!({})).as_object_mut()
    {
        meta.insert("effortConfiguration".into(), seed.to_value());
    }
}

/// `promptContentText(input.prompt).trim()`: a string, or the text parts joined by a newline.
fn prompt_text(body: &Value) -> String {
    match body.get("content") {
        Some(Value::String(text)) => text.trim().to_owned(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n").trim().to_owned(),
        _ => String::new(),
    }
}
/// The run's [`McpCatalog`]: the parts' refresh for this thread. A refresh that fails is logged; like Node's
/// (`catch` around the reconcile in `foldMcpSurface`), it never breaks the turn.
struct ThreadMcp {
    parts: Arc<dyn RunParts>,
    thread: ThreadId,
    surface: tokio::sync::watch::Receiver<Arc<SessionSurface>>,
}

/// The native tool-search records of a transcript, which the request boundary's tool snapshot reads its references from.
pub(crate) fn native_searches(messages: &[AgentMessage]) -> Vec<Value> {
    messages.iter().filter_map(|m| m.message.native_tool_search.clone()).collect()
}

/// `session.messages`: the system blocks the session's requests lead with, then its stored conversation rows.
pub(crate) fn session_messages(header: &mixdog_store::schema::record::Header, rows: &[Value]) -> Result<Vec<AgentMessage>, String> {
    let mut messages = system_messages(header);
    let mut leading = true;
    for row in rows {
        let message = super::message_row::message_of(row)?;
        if leading && is_stale_system_row(&message) {
            continue;
        }
        leading = false;
        messages.push(message);
    }
    Ok(messages)
}

/// A system row an earlier build stored at the head of the context: the header's prompt is the request's system set, so the
/// stored copy is dropped on load and the next rewrite does not change what the request leads with.
fn is_stale_system_row(message: &AgentMessage) -> bool {
    message.role() == Role::System
}

/// The request's system messages: the header's prompt fields, in Node's order and tiers (WP-PROMPT).
pub(crate) fn system_messages(header: &mixdog_store::schema::record::Header) -> Vec<AgentMessage> {
    mixdog_core_prompt::prompt::blocks::request_system_messages(header)
        .into_iter()
        .map(|wire| {
            let mut message = AgentMessage::user_content(Content::Text(String::new()));
            message.message = wire;
            message
        })
        .collect()
}

/// Whether a provider error is one of the runtime's own timeout or stall errors (`armTurnTimeoutOnProviderError`,
/// `turn-reap.mjs`): a code of `PROVIDER_TIMEOUT_CODES`, or Node's `streamStalled` flag. The flag is not a field
/// here; its producers are a stream watchdog's expiry (`timeout_phase`) and a stream cut after it showed text (a
/// truncated stream whose text was emitted).
fn provider_timeout_or_stall(error: &mixdog_core_api::domain::provider::ProviderError) -> bool {
    use mixdog_core_api::domain::provider::TransportFault;
    matches!(error.code.as_deref(), Some("ESTREAMSTALL" | "EPROVIDERTIMEOUT" | "EGEMINITIMEOUT"))
        || error.timeout_phase.is_some()
        || (matches!(error.transport, Some(TransportFault::TruncatedStream)) && error.exposure.text_emitted)
}

#[cfg(test)]
mod tests {
    #[cfg(node_twin)]
    #[path = "../../turn_durability_replay.rs"]
    mod turn_durability_replay;

    #[path = "../../factory_pinned_account_tests.rs"]
    mod pinned_account;

    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicI64};
    use std::time::Duration;

    use mixdog_agent::env::{AllowAll, CompactError, CompactOutput, CompactRequest, NoGuards};
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
    use mixdog_core_api::domain::mock::{MockApprovalGate, MockCodec, MockFileService, MockProcessManager, MockRetryDecider};
    use mixdog_core_api::domain::provider::{DeliveryState, ModelRequest, ModelStream, ProviderError, StopReason, StreamEvent, ToolCall, WireCodec};
    use mixdog_core_api::domain::retry::RetryPolicy;
    use mixdog_core_api::domain::tool::{SurfaceKind, Tool, ToolAnnotations, ToolContext, ToolIo, ToolOutcome, ToolOutput, ToolPart, ToolSpec};
    use mixdog_core_api::ids::{ConnectionId, Method, OpId};
    use mixdog_core_api::{CoreRequest, Reply, ThreadDirectory, ThreadHandle};
    use mixdog_protocol::{JsonValue, ProviderId};
    use mixdog_store::schema::blob::Slot;
    use mixdog_store::schema::record::Record;

    use super::*;
    use mixdog_core_session::session::testing::{Rig, eventually_on_awaiting};
    use mixdog_core_session::session::SessionDirectory;

    /// A system row an earlier build stored at the head of the context is not read back: the header's prompt is the request's
    /// system set, so the next rewrite leaves the request's lead as it was.
    #[test]
    fn a_stored_leading_system_row_is_not_part_of_the_loaded_context() {
        let header = mixdog_store::schema::record::Header::new();
        let rows = [json!({ "role": "system", "content": "old prompt" }), json!({ "role": "user", "content": "hello" }), json!({ "role": "system", "content": "later" })];
        let loaded = session_messages(&header, &rows).expect("messages");
        let roles: Vec<Role> = loaded.iter().skip(system_messages(&header).len()).map(|m| m.role()).collect();
        assert_eq!(roles, [Role::User, Role::System]);
    }

    struct Steps(VecDeque<StreamEvent>);

    #[async_trait]
    impl ModelStream for Steps {
        async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
            self.0.pop_front().map(Ok)
        }
        fn delivery(&self) -> DeliveryState {
            DeliveryState::Accepted
        }
        fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
    }

    struct NoJobs;
    impl mixdog_core_run::run_host::progress::WaitedJobs for NoJobs {
        fn silence(&self, _: &[String], _: i64) -> Option<mixdog_agent::agent_tool::progress::ToolSilence> {
            None
        }
    }

    /// A scripted stream that holds its stop until the observer has recorded the first call's early result, so that result
    /// precedes the batch.
    struct HeldStop(Steps, Arc<tokio::sync::Notify>);

    #[async_trait]
    impl ModelStream for HeldStop {
        async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
            if matches!(self.0.0.front(), Some(StreamEvent::Completed { .. })) {
                self.1.notified().await;
            }
            self.0.next().await
        }
        fn delivery(&self) -> DeliveryState {
            DeliveryState::Accepted
        }
        fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
    }

    /// `Scripted`, whose response number `.2` (from 0) has its stop wait for the notice.
    struct HeldScripted(Scripted, Arc<tokio::sync::Notify>, usize);

    #[async_trait]
    impl ProviderAdapter for HeldScripted {
        fn release_send(&self, group: &str) {
            self.0.release_send(group);
        }
        fn id(&self) -> &ProviderId {
            self.0.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.0.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.0.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.0.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            let held = lock(&self.0.requests).len() == self.2;
            let stream = self.0.attempt(request).await?;
            if !held {
                return Ok(stream);
            }
            // The held attempt's events are held again behind the notice.
            let mut steps = VecDeque::new();
            let mut stream = stream;
            while let Some(event) = stream.next().await {
                steps.push_back(event?);
            }
            Ok(Box::new(HeldStop(Steps(steps), self.1.clone())))
        }
    }

    struct Scripted {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
        codec: MockCodec,
        script: Mutex<VecDeque<Vec<StreamEvent>>>,
        requests: Mutex<Vec<Arc<ModelRequest>>>,
        /// The next attempt is refused (a failed turn); it clears as it fires.
        fail_first: std::sync::atomic::AtomicBool,
    }

    #[async_trait]
    impl ProviderAdapter for Scripted {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &ProviderId {
            &self.id
        }
        fn codec(&self) -> &dyn WireCodec {
            &self.codec
        }
        fn retry_policy(&self) -> &RetryPolicy {
            &self.policy
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            &self.keepalive
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            if self.fail_first.swap(false, std::sync::atomic::Ordering::SeqCst) {
                return Err(ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::InvalidRequest, DeliveryState::NotSent));
            }
            lock(&self.requests).push(request);
            let steps = lock(&self.script).pop_front().expect("provider script exhausted");
            Ok(Box::new(Steps(steps.into())))
        }
    }

    struct Echo(ToolSpec);

    #[async_trait]
    impl Tool for Echo {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
            Ok(ToolOutput { parts: vec![ToolPart::Text(format!("echo:{args}"))], ..ToolOutput::default() })
        }
    }

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    struct NoBlobs;

    #[async_trait]
    impl mixdog_agent::compact::blob_reads::BlobReads for NoBlobs {
        async fn read_with(&self, work: mixdog_agent::compact::blob_reads::StoreWork) -> Result<(), mixdog_agent::compact::blob_reads::StoreUnavailable> {
            work(self);
            Ok(())
        }
    }

    struct Parts {
        provider: Arc<dyn ProviderAdapter>,
        workspace: std::path::PathBuf,
        /// Tools beside `echo`.
        more: Vec<Arc<dyn Tool>>,
        /// A key the settings reconcile adds to the header, and the headers the turns were assembled from.
        settle: Option<Arc<Settle>>,
        /// The route's effort wiring a turn is assembled with (the effort replay).
        effort: Option<Arc<EffortParts>>,
    }

    /// What the host's route wiring puts on a turn whose route takes effort updates (`assemble.rs`): the header's effort
    /// on the requests, the projection inputs, the step's auto-effort anchor and its judge.
    struct EffortParts {
        effort: Option<String>,
        route: mixdog_agent::effort::EffortRoute,
        step_auto: Option<mixdog_agent::step_effort::StepAutoEffort>,
        judge: Option<Arc<dyn mixdog_agent::step_effort::StepEffortJudge>>,
    }

    /// The scripted provider as the effort-taking adapter (`attempt_with` is its `attempt`).
    struct EffortScripted(Arc<dyn ProviderAdapter>);
    #[async_trait]
    impl mixdog_agent::effort::EffortAdapter for EffortScripted {
        async fn attempt_with(&self, request: Arc<ModelRequest>, _: Option<mixdog_agent::effort::EffortProjection>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.0.attempt(request).await
        }
    }

    struct Settle {
        add: (&'static str, Value),
        seen: Mutex<Vec<mixdog_store::schema::record::Header>>,
    }

    /// The judge model's answer as the turn-effort recording scripted it (`judgeTurn` answering `JUDGE.step`).
    #[cfg(node_twin)]
    struct RecordedProbs(Vec<f64>);

    fn request(method: &'static str, params: Value, op: &str) -> CoreRequest {
        CoreRequest {
            method: Method(method),
            params,
            op: Some(OpId::from(op)),
            ctx: CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new()),
        }
    }

    /// The scripted provider, arming `arm` as its first request goes out (the turn's start is on disk by then).
    struct ArmedOnSend {
        inner: Arc<Scripted>,
        arm: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    #[async_trait]
    impl ProviderAdapter for ArmedOnSend {
        fn release_send(&self, group: &str) {
            self.inner.release_send(group);
        }
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            let arm = lock(&self.arm).take();
            if let Some(arm) = arm {
                arm();
            }
            self.inner.attempt(request).await
        }
    }

    /// A tool that starts, tells it did, and finishes only when released.
    struct Blocker(ToolSpec, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);

    #[async_trait]
    impl Tool for Blocker {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            self.1.notify_one();
            self.2.notified().await;
            Ok(ToolOutput { parts: vec![ToolPart::Text("blocked, then released".into())], ..ToolOutput::default() })
        }
    }

    /// An eager wait of send 1 settles after send 2 began: a wait with the same call id in send 2 is not suppressed by it, stays
    /// open through it, and closes only on its own result.
    #[test]
    fn an_earlier_sends_late_settlement_neither_suppresses_nor_closes_a_later_wait() {
        let mut waits = TaskWaits::default();
        waits.begin_send();
        let first = waits.generation;
        waits.begin_send();
        assert_eq!(waits.settle("w", first), None);
        assert_eq!(waits.open("w", Some("t".into())), Some(Some("t".into())), "the later send's wait opens");
        assert_eq!(waits.settle("w", first), None);
        assert!(waits.open.contains_key("w"), "a late settlement of the earlier send leaves the wait open");
        assert_eq!(waits.settle("w", waits.generation), Some(Some("t".into())), "its own result closes it");
        assert!(waits.open.is_empty());
    }

    /// A tool that tells when it runs.
    struct Probe(ToolSpec, Arc<std::sync::atomic::AtomicBool>, Arc<tokio::sync::Notify>);

    #[async_trait]
    impl Tool for Probe {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            self.1.store(true, std::sync::atomic::Ordering::SeqCst);
            self.2.notify_one();
            Ok(ToolOutput { parts: vec![ToolPart::Text("probed".into())], ..ToolOutput::default() })
        }
    }

    /// A failure the run's setup reports after its token fired is the stop that fired it (`setup_end`): Node's abort rejects
    /// the turn wherever it stands, and `askSession` closes it as stopped. A failure with no stop stays the failure, the loop
    /// closes its own stops, and the progress watchdog's stop stays a stalled failure.
    #[test]
    fn a_setup_failure_after_a_stop_is_that_stop() {
        let stop = mixdog_agent::cancel::runtime_abort_reason("sess_1", mixdog_agent::cancel::USER_CANCEL);
        assert_eq!(setup_end(true, false, true, Some(&stop)), SetupEnd::Stopped);
        assert_eq!(setup_end(true, false, true, None), SetupEnd::Stopped);
        assert_eq!(setup_end(true, true, true, Some(&stop)), SetupEnd::AsReported, "the loop closes a stop that lands inside it");
        assert_eq!(setup_end(true, false, false, None), SetupEnd::AsReported, "a failure with no stop is the failure");
        assert_eq!(setup_end(false, false, true, Some(&stop)), SetupEnd::AsReported, "an outcome that is no failure is itself");
        assert_eq!(setup_end(true, false, true, Some("agent task stale (no progress for 600s)")), SetupEnd::Stalled);
    }

    /// What a stop before the model was asked leaves of the prompt, by its reason (`finalizeInterruptedTurn` over a turn
    /// that produced nothing): a user's stop hands it back, a stop that keeps it adds the interruption line, any other
    /// stop leaves it as it is.
    #[test]
    fn a_prompt_stopped_before_the_model_is_asked_is_left_as_the_interruption_leaves_it() {
        use mixdog_agent::interrupt::AbortReason;
        let prompt = AgentMessage::user("give it back");
        let texts = |rows: Vec<AgentMessage>| rows.iter().map(AgentMessage::text).collect::<Vec<_>>();
        let (rewound, following) = stopped_prompt(&prompt, AbortReason::UserCancel);
        assert!(rewound && following.is_empty(), "a user's stop hands the prompt back: {:?}", texts(following));
        let (rewound, following) = stopped_prompt(&prompt, AbortReason::UserCancelKeepPrompt);
        assert!(!rewound);
        assert_eq!(texts(following), ["[Request interrupted]"]);
        let (rewound, following) = stopped_prompt(&prompt, AbortReason::Other);
        assert!(!rewound && following.is_empty(), "a stop that is not the user's keeps the prompt: {:?}", texts(following));
    }

    /// A `UserPromptSubmit` hook that never answers: the turn stands in its setup, before the model is asked.
    struct HeldPrompt {
        reached: tokio::sync::Notify,
    }

    #[async_trait]
    impl mixdog_core_session::session::lifecycle_hooks::LifecycleHooks for HeldPrompt {
        async fn prompt_submit(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header, _: &Value) -> mixdog_core_session::session::lifecycle_hooks::PromptVerdict {
            self.reached.notify_one();
            std::future::pending().await
        }
    }

    /// The hooks a turn fired, in order, and what its `UserPromptSubmit` answers.
    #[derive(Default)]
    struct TurnHooks {
        calls: Mutex<Vec<String>>,
        verdict: Mutex<mixdog_core_session::session::lifecycle_hooks::PromptVerdict>,
    }

    #[async_trait]
    impl mixdog_core_session::session::lifecycle_hooks::LifecycleHooks for TurnHooks {
        async fn prompt_submit(&self, _: &ThreadId, header: &mixdog_store::schema::record::Header, prompt: &Value) -> mixdog_core_session::session::lifecycle_hooks::PromptVerdict {
            lock(&self.calls).push(format!("UserPromptSubmit:{}:{prompt}", header["cwd"].as_str().unwrap_or_default()));
            lock(&self.verdict).clone()
        }
        async fn stop_failure(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header, error_type: &str) {
            lock(&self.calls).push(format!("StopFailure:{error_type}"));
        }
    }

    /// Compacts the first time it is asked, keeping what the session's compactor keeps first (`split_protected_context`: the
    /// system messages), then a summary and the latest message.
    #[derive(Default)]
    struct CompactsOnce {
        asked: AtomicBool,
    }

    #[async_trait]
    impl Compactor for CompactsOnce {
        fn estimate_tokens(&self, _: &[AgentMessage]) -> u64 {
            1_000_000
        }

        async fn reduces(&self, _: &CompactRequest<'_>) -> bool {
            !self.asked.swap(true, Ordering::SeqCst)
        }

        async fn compact(&self, request: CompactRequest<'_>) -> Result<CompactOutput, CompactError> {
            let mut messages: Vec<AgentMessage> = request.messages.iter().take_while(|m| m.role() == Role::System).cloned().collect();
            messages.push(AgentMessage::user("[summary]"));
            messages.extend(request.messages.last().cloned());
            Ok(CompactOutput { messages, usage: None, input_excludes_cache: false, dropped_count: 0, dropped: None, skipped: false, pipeline_ms: 0.0, summary_ms: None, summary_route: None })
        }
    }

    /// [`Parts`] with a compactor and explicit compaction settings.
    struct Compacting {
        inner: Parts,
        compactor: Arc<dyn Compactor>,
        settings: mixdog_agent::boundary::CompactSettings,
    }

    /// The provider that, when its request arrives, makes the store refuse the next write (the assistant row the reply commits).
    #[cfg(node_twin)]
    struct RefusesNextSave {
        inner: Arc<Scripted>,
        refuse: Arc<std::sync::atomic::AtomicBool>,
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl ProviderAdapter for RefusesNextSave {
        fn release_send(&self, group: &str) {
            self.inner.release_send(group);
        }
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.refuse.store(true, std::sync::atomic::Ordering::SeqCst);
            self.inner.attempt(request).await
        }
    }

    #[cfg(node_twin)]
    struct TranscriptNow;
    #[cfg(node_twin)]
    impl mixdog_core_session::session::Clock for TranscriptNow {
        fn now_ms(&self) -> i64 {
            1_772_600_767_890
        }
    }
    /// A provider that refuses every attempt with `error`.
    struct Refusing {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
        codec: MockCodec,
        error: ProviderError,
    }

    #[async_trait]
    impl ProviderAdapter for Refusing {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &ProviderId {
            &self.id
        }
        fn codec(&self) -> &dyn WireCodec {
            &self.codec
        }
        fn retry_policy(&self) -> &RetryPolicy {
            &self.policy
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            &self.keepalive
        }
        async fn attempt(&self, _: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            Err(self.error.clone())
        }
    }

    /// [`Parts`] that records every shell reap it is asked for.
    struct Reaping {
        inner: Parts,
        reaps: Arc<Mutex<Vec<(ThreadId, i64)>>>,
        woke: Arc<tokio::sync::Notify>,
    }

    /// `PROVIDER_TIMEOUT_CODES` and `streamStalled` (`turn-reap.mjs`): the three codes, a stream watchdog's expiry and a
    /// stream cut after it showed text; nothing else.
    #[test]
    fn only_a_timeout_or_stall_error_is_one() {
        use mixdog_core_api::domain::provider::{ErrorKind, StreamTimeoutPhase, TransportFault};
        let plain = || ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        for code in ["ESTREAMSTALL", "EPROVIDERTIMEOUT", "EGEMINITIMEOUT"] {
            let mut error = plain();
            error.code = Some(code.to_owned());
            assert!(super::provider_timeout_or_stall(&error), "{code}");
        }
        let mut watchdog = plain();
        watchdog.timeout_phase = Some(StreamTimeoutPhase::Idle);
        assert!(super::provider_timeout_or_stall(&watchdog));
        let mut cut = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        assert!(!super::provider_timeout_or_stall(&cut), "a cut stream that showed nothing is no stall");
        cut.exposure.text_emitted = true;
        assert!(super::provider_timeout_or_stall(&cut));
        let mut other = plain();
        other.code = Some("ECONNRESET".to_owned());
        other.timed_out = true;
        assert!(!super::provider_timeout_or_stall(&other));
        assert!(!super::provider_timeout_or_stall(&plain()));
    }

    /// A tool that reports its output through `ctx.progress`, then waits to be released.
    struct Reporter {
        spec: ToolSpec,
        reported: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl Tool for Reporter {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            ctx.progress.progress(mixdog_core_api::domain::tool::ToolProgress::Output(b"compiling".to_vec()));
            self.reported.notify_one();
            self.release.notified().await;
            Ok(ToolOutput { parts: vec![ToolPart::Text("built".into())], ..ToolOutput::default() })
        }
    }

    /// A tool that spends like a hosted web search: it reports its delta to the usage registry under the asking thread.
    #[cfg(node_twin)]
    struct Searcher {
        spec: ToolSpec,
        sinks: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
        delta: Value,
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl Tool for Searcher {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            self.sinks.report(Some(ctx.thread_id.as_str()), || self.delta.clone());
            Ok(ToolOutput { parts: vec![ToolPart::Text("searched".into())], ..ToolOutput::default() })
        }
    }

    // ---- the real assembly -------------------------------------------------------------------------

    struct OneProvider(Arc<dyn ProviderAdapter>);

    struct Config;

    struct NoMcp;
    impl super::super::session_tools::SessionMcp for NoMcp {
        fn tools(&self, _: Option<&str>, _: &std::path::Path) -> Vec<Arc<dyn Tool>> {
            Vec::new()
        }
    }

    struct NoSkills;
    #[async_trait]
    impl super::super::session_tools::SkillsListed for NoSkills {
        async fn any_for(&self, _: &std::path::Path) -> Result<bool, String> {
            Ok(false)
        }
    }


    /// The session catalog `call_tool` resolves its target in, bound once the directory exists (the composition's
    /// `LateCatalog`).
    #[derive(Default)]
    struct LateCatalog(std::sync::OnceLock<Arc<dyn mixdog_tools::orch::bridge::CatalogView>>);

    impl LateCatalog {
        fn bound(&self) -> &dyn mixdog_tools::orch::bridge::CatalogView {
            self.0.get().expect("the catalog is bound before a turn runs").as_ref()
        }
    }

    #[async_trait]
    impl mixdog_tools::orch::bridge::CatalogView for LateCatalog {
        fn available(&self, thread: &ThreadId) -> Vec<mixdog_tools::orch::bridge::ToolDoc> {
            self.bound().available(thread)
        }
        fn is_eager(&self, thread: &ThreadId, name: &str) -> bool {
            self.bound().is_eager(thread, name)
        }
        fn block_reason(&self, thread: &ThreadId, name: &str) -> Option<String> {
            self.bound().block_reason(thread, name)
        }
        fn alias_members(&self, key: &str) -> Vec<String> {
            self.bound().alias_members(key)
        }
        fn mcp_server_members(&self, thread: &ThreadId, requested: &str) -> Vec<String> {
            self.bound().mcp_server_members(thread, requested)
        }
        fn instructions_for(&self, thread: &ThreadId, names: &[String]) -> String {
            self.bound().instructions_for(thread, names)
        }
        async fn announce(&self, thread: &ThreadId, names: &[String]) {
            self.bound().announce(thread, names).await;
        }
        fn resolve_call(&self, thread: &ThreadId, name: &str) -> mixdog_tools::orch::bridge::CallResolution {
            self.bound().resolve_call(thread, name)
        }
        async fn refresh(&self, thread: &ThreadId) {
            self.bound().refresh(thread).await;
        }
        async fn load_native(&self, thread: &ThreadId, args: &Value) -> Option<Result<String, String>> {
            self.bound().load_native(thread, args).await
        }
        fn lacks(&self, thread: &ThreadId, names: &[String]) -> bool {
            self.bound().lacks(thread, names)
        }
        async fn await_connect(&self, thread: &ThreadId) {
            self.bound().await_connect(thread).await;
        }
    }

    /// `call_tool`'s own pipeline, never reached: the loop projects a wire call onto its target before dispatch.
    struct Unprojected;

    #[async_trait]
    impl mixdog_tools::orch::bridge::ToolDispatcher for Unprojected {
        async fn dispatch(&self, _: &ToolContext, name: &str, _: Value) -> ToolOutcome {
            panic!("call_tool dispatched {name} without the loop's projection")
        }
    }

    struct PoolResolver(Vec<Arc<dyn Tool>>);
    impl mixdog_tools::policy::ToolResolver for PoolResolver {
        fn resolve(&self, _scope: Option<&str>, name: &str) -> Option<Arc<dyn Tool>> {
            self.0.iter().find(|t| t.spec().name == name).cloned()
        }
    }

    struct NoStamps;
    #[async_trait::async_trait]
    impl mixdog_core_ports::ports::run_stamps::RunStamps for NoStamps {
        async fn stamp_of(&self, _: &ThreadId) -> Option<Value> {
            None
        }
    }

    struct AllowNone;
    impl super::super::mcp_seams::AllowAllActions for AllowNone {
        fn allow_all_actions(&self) -> bool {
            false
        }
    }

    struct NoEvidence;
    #[async_trait]
    impl mixdog_core_agents::agents::AgentEvidence for NoEvidence {
        async fn home_greeted(&self, _: &str) -> bool {
            false
        }
        async fn home_chatted(&self, _: &str) -> bool {
            false
        }
        async fn mixy_owns_routines(&self) -> Result<bool, String> {
            Ok(false)
        }
    }
    struct NoLadder;
    #[async_trait]
    impl super::super::step_judge::LadderSources for NoLadder {
        fn cached_row(&self, _: &str, _: &str) -> Option<serde_json::Map<String, Value>> {
            None
        }
        async fn rejected(&self, _: &str, _: &str) -> Option<mixdog_ai::effort::RejectionEntry> {
            None
        }
        fn custom_config(&self, _: &str) -> Option<(mixdog_ai::providers::custom::Protocol, String)> {
            None
        }
        fn anthropic_levels(&self, _: &str) -> Vec<String> {
            Vec::new()
        }
    }

    struct Pricing;

    struct NoSkillNames;

    /// Every thread is open for a hop; a hop never runs here (the scripted provider never fails), so the session's writes refuse.
    struct OpenHopSessions;
    impl mixdog_core_run::run_host::hop_host::HopSessions for OpenHopSessions {
        fn open(&self, _: &ThreadId) -> Option<Arc<dyn mixdog_core_run::run_host::hop_host::HopSession>> {
            Some(Arc::new(NoHopWrites))
        }
    }
    struct NoHopWrites;

    struct NoWiring;

    struct NoBots;
    #[async_trait::async_trait]
    impl mixdog_core_run::run_host::route_chain::BotRoutes for NoBots {
        async fn bot_route(&self, _: &str) -> Result<Option<Option<Value>>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
        async fn stored_bot_route(&self, _: &str) -> Result<Option<Value>, mixdog_core_run::run_host::route_chain::RouteReadUnavailable> {
            Ok(None)
        }
    }

    struct Offline;
    #[async_trait]
    impl mixdog_ai::transport::http::HttpSend for Offline {
        async fn send(
            &self,
            _: mixdog_core_api::domain::provider::WireRequest,
            _exchange: mixdog_ai::transport::Exchange,
        ) -> Result<mixdog_ai::transport::http::HttpResponse, ProviderError> {
            Err(ProviderError::new(
                mixdog_core_api::domain::provider::ErrorKind::Transient,
                DeliveryState::NotSent,
            ))
        }
    }

    struct NoMarks;
    struct NoCeilings;
    struct AutoOff;
    struct NoAttachmentText;
    fn named(name: &str) -> Arc<dyn Tool> {
        let spec = ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: name.into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        Arc::new(Echo(spec))
    }

    /// Notes every thread the assembly asks where its approvals go.
    #[derive(Default)]
    struct AskedFor(Mutex<Vec<String>>);
    impl crate::run_host::run_approvals::RunApprovals for AskedFor {
        fn gate_for(&self, thread: &ThreadId, own: Arc<dyn mixdog_core_api::domain::approval::ApprovalGate>) -> Arc<dyn mixdog_core_api::domain::approval::ApprovalGate> {
            lock(&self.0).push(thread.as_str().to_owned());
            own
        }
    }

    /// The test settings host: a turn start brings the header to `.1`, the settings as they stand now.
    struct LiveSettings(Arc<SessionDirectory>, Arc<Mutex<serde_json::Map<String, Value>>>);

    impl LiveSettings {
        fn threads(&self) -> mixdog_core_session::session::thread_state::SessionThreads {
            mixdog_core_session::session::thread_state::SessionThreads::new(self.0.clone())
        }
    }

    #[async_trait]
    impl super::super::turn_settings::TurnSettings for LiveSettings {
        async fn reconcile(&self, thread: &ThreadId, _: bool) -> Result<mixdog_store::schema::record::Header, String> {
            use mixdog_core_ports::ports::threads::ThreadState;
            let set = lock(&self.1).clone();
            if !set.is_empty() {
                self.threads().patch_header(thread, set, Vec::new()).await.map_err(|error| format!("{error:?}"))?;
            }
            self.threads().header(thread).await.map_err(|error| format!("{error:?}"))
        }
    }

    /// A transcript of text only: a media part is a failure of the replay.
    struct ManualMeters;
    impl mixdog_agent::compact::estimate::MediaMeter for ManualMeters {
        fn part(&self, part: &mixdog_core_api::domain::provider::ContentPart) -> mixdog_agent::compact::estimate::PartMeter {
            panic!("media part in a text-only replay: {part:?}")
        }
    }
    impl mixdog_agent::compact::pressure::ImageIdentities for ManualMeters {
        fn images(&self, _: &mixdog_agent::message::AgentMessage) -> Vec<mixdog_agent::compact::pressure::ImageDescriptor> {
            Vec::new()
        }
    }
    #[cfg(node_twin)]
    impl mixdog_agent::compact::triggers::ToolMediaMeter for ManualMeters {
        fn bytes(&self, _: &mixdog_core_api::domain::provider::Content, _: bool) -> u64 {
            0
        }
        fn count(&self, _: &mixdog_core_api::domain::provider::Content, _: bool) -> u64 {
            0
        }
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_agent::compact::fresh::AttachmentSeam for ManualMeters {
        async fn reference_media(&self, message: &mixdog_agent::message::AgentMessage) -> mixdog_agent::message::AgentMessage {
            message.clone()
        }
        fn has_referencable_media(&self, _: &mixdog_agent::message::AgentMessage) -> bool {
            false
        }
        fn attachment_tokens(&self, _: &mixdog_agent::message::AgentMessage) -> u64 {
            0
        }
    }
    #[cfg(node_twin)]
    impl mixdog_agent::compact::dropped::Redactor for ManualMeters {
        fn redact(&self, rows: Vec<Value>) -> Vec<Value> {
            rows
        }
    }
    /// The summary route's one answer: the recording's fixed summary, the requests counted.
    #[cfg(node_twin)]
    struct ManualSummary {
        text: String,
        calls: std::sync::atomic::AtomicUsize,
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_agent::compact::summary_run::SummarySender for ManualSummary {
        async fn send(
            &self,
            _: &str,
            _: &str,
            _: &mixdog_agent::compact::summary_run::SummaryCall,
        ) -> Result<mixdog_agent::compact::summary_run::SummaryResponse, mixdog_agent::compact::summary_run::SummaryFailure> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(mixdog_agent::compact::summary_run::SummaryResponse {
                text: self.text.clone(),
                tool_call: false,
                stop: None,
                usage: Some(mixdog_core_api::domain::provider::Usage { input_tokens: 10, output_tokens: 2, cache_write_tokens: 100, ..Default::default() }),
                input_excludes_cache: false,
            })
        }
    }
    /// The conversation's own model is the only summary route (`summaryMode: session`).
    #[cfg(node_twin)]
    struct ManualHost {
        sender: Arc<ManualSummary>,
        route: super::super::summary_routes::SessionRoute,
        calibration: f64,
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl super::super::summary_routes::SummaryHost for ManualHost {
        fn session(&self) -> super::super::summary_routes::SessionRoute {
            self.route.clone()
        }
        fn maintainer_route(&self) -> Option<super::super::summary_routes::MaintainerRoute> {
            None
        }
        async fn provider_ready(&self, _: &str, _: bool) -> Result<bool, mixdog_agent::compact::summary_run::SummaryFailure> {
            Ok(true)
        }
        fn whole_window(&self, _: &str, _: &str) -> u64 {
            self.route.context_window.expect("a window")
        }
        fn calibration(&self, _: &str, _: &str) -> f64 {
            self.calibration
        }
        fn sender(&self, _: &str) -> Arc<dyn mixdog_agent::compact::summary_run::SummarySender> {
            self.sender.clone()
        }
        async fn saved_catalog(&self, _: &str) -> Option<Vec<Value>> {
            None
        }
    }
    #[cfg(node_twin)]
    struct ManualNoFork;
    #[async_trait]
    #[cfg(node_twin)]
    impl super::super::summary_routes::ForkSender for ManualNoFork {
        async fn send(&self, _: &mixdog_agent::compact::summary_run::SummaryRoute) -> Result<mixdog_agent::compact::summary_run::SummaryResponse, mixdog_agent::compact::summary_run::SummaryFailure> {
            panic!("a session without a warm request forks nothing")
        }
    }
    #[cfg(node_twin)]
    struct ManualCompactionWorld(Arc<ManualHost>);
    #[async_trait]
    #[cfg(node_twin)]
    impl super::super::compactors::CompactionWorld for ManualCompactionWorld {
        async fn facts(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header, _: &[Value]) -> super::super::compactors::CompactionFacts {
            super::super::compactors::CompactionFacts {
                media: Arc::new(ManualMeters),
                tool_media: Arc::new(ManualMeters),
                native_pdf: false,
                attachments: Arc::new(ManualMeters),
                redactor: Arc::new(ManualMeters),
                summary: self.0.clone(),
                saved_request: None,
                fork_sender: Arc::new(ManualNoFork),
            }
        }
        fn compaction_config(&self) -> Option<Value> {
            Some(json!({ "summaryMode": "self" }))
        }
        fn retire_fork(&self, _: &ThreadId) {}
    }
    /// The thread's own header and route over a window the recording had; no media.
    struct ManualWorld {
        threads: Arc<dyn mixdog_core_ports::ports::threads::ThreadState>,
        window: u64,
    }
    #[async_trait]
    impl mixdog_core_session::session::thread_context::ContextWorld for ManualWorld {
        async fn snapshot(&self, thread: Option<&ThreadId>) -> Result<Option<mixdog_core_session::session::thread_context::ContextSnapshot>, mixdog_core_api::CoreError> {
            let header = self.threads.header(thread.expect("a thread")).await.expect("the thread's header");
            let text = |key: &str| header.get(key).and_then(Value::as_str).expect("a route").to_owned();
            let (provider, model) = (text("provider"), text("model"));
            Ok(Some(mixdog_core_session::session::thread_context::ContextSnapshot {
                header,
                replay_owner: ProviderId::from(provider.as_str()),
                provider,
                model,
                context_window: json!(self.window),
                cwd: Value::Null,
                mode: Value::Null,
                messages: Vec::new(),
                active: true,
                request_native: Vec::new(),
                request_defined: Vec::new(),
                session_defined: Vec::new(),
                agent_mode: false,
                annotations: std::collections::HashMap::new(),
                media: Arc::new(ManualMeters),
                images: Arc::new(ManualMeters),
                rows: Arc::new(super::super::context_world::StoredBodies),
            }))
        }
        fn lowering(&self, _: &ThreadId, _: &str) -> (Arc<dyn mixdog_agent::compact::estimate::MediaMeter>, Arc<dyn mixdog_agent::compact::pressure::ImageIdentities>) {
            (Arc::new(ManualMeters), Arc::new(ManualMeters))
        }
    }
    /// The test `Config`, whose sessions have the compaction policy `.0`.
    #[cfg(node_twin)]
    struct ManualConfig(mixdog_agent::boundary::CompactSettings);
    struct ManualNoHooks;
    #[async_trait]
    impl super::super::compact_hooks::CompactHooks for ManualNoHooks {
        async fn pre(&self, _: &ThreadId, _: &str) {}
        async fn post(&self, _: &ThreadId, _: &str) {}
    }
    struct ManualGauge;
    impl mixdog_core_session::session::route_session::ContextStatusCache for ManualGauge {
        fn invalidate(&self, _: &ThreadId) {}
    }

    /// The test function the scripted MCP servers run as (`mixdog_testkit::mcp_server`): nothing unless started as one.
    #[test]
    fn scripted_server() {
        mixdog_testkit::mcp_server::serve_if_asked();
    }

    /// What reached the real servers: the one log they all append to, read for the calls it gained since the last read, each
    /// `{"name": "mcp__<server>__<tool>", "arguments": …}` in the order the calls arrived.
    #[cfg(node_twin)]
    struct ReachLogs {
        log: std::path::PathBuf,
        seen: Mutex<usize>,
    }

    #[cfg(node_twin)]
    impl ReachLogs {
        #[cfg(node_twin)]
        fn take(&self) -> Vec<Value> {
            let mut seen = lock(&self.seen);
            let calls = mixdog_testkit::mcp_server::reached(&self.log);
            let gained = calls[*seen..].to_vec();
            *seen = calls.len();
            gained
        }
    }

    /// The hub's own tools of a scope, each server kept for a folder as the hub keeps it (`McpHub::tools_for_cwd`): its own
    /// scope intersected with its owning plugin's.
    #[cfg(node_twin)]
    struct ScopedServers {
        scopes: mixdog_mcp::scopes::ExtensionScopes,
        hub: Arc<mixdog_mcp::McpHub>,
        scope: &'static str,
    }

    #[cfg(node_twin)]
    impl super::super::session_tools::SessionMcp for ScopedServers {
        fn tools(&self, _: Option<&str>, cwd: &std::path::Path) -> Vec<Arc<dyn Tool>> {
            self.hub.tools_for_cwd(self.scope, &self.scopes, cwd)
        }
    }

    /// The provider of one recorded turn: before it answers with step `n`'s call it moves the session's cwd to the step's,
    /// in place as the `cwd` tool does mid-turn; at each request it notes what reached the server since the last one and the
    /// session's MCP snapshot then (at the first, the turn start's).
    #[cfg(node_twin)]
    struct MovingCwd {
        inner: Scripted,
        cwds: Vec<Value>,
        thread: std::sync::OnceLock<(ThreadId, Arc<mixdog_core_session::session::SessionHandle>)>,
        reached: Arc<ReachLogs>,
        observed: Mutex<Vec<(Value, Value)>>,
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl ProviderAdapter for MovingCwd {
        fn release_send(&self, group: &str) {
            self.inner.release_send(group);
        }
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            let n = lock(&self.inner.requests).len();
            let (id, handle) = self.thread.get().expect("the thread is started before its turn");
            let ran = Value::from(self.reached.take());
            let names = handle.header_snapshot().get("deferredMcpToolNames").cloned().unwrap_or(Value::Null);
            lock(&self.observed).push((ran, names));
            if let Some(cwd) = self.cwds.get(n).filter(|_| n > 0) {
                handle
                    .request(CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": id, "set": { "cwd": cwd } }), op: None, ctx: CallContext::internal("test") })
                    .await
                    .expect("cwd");
            }
            self.inner.attempt(request).await
        }
    }

    /// A provider that hands each request it is asked to send to `sent` and answers with a text. Its codec is Grok's, so
    /// the body of a request is what a Grok turn puts on the wire.
    struct Handing {
        id: ProviderId,
        policy: RetryPolicy,
        keepalive: KeepaliveSchedule,
        codec: Arc<dyn WireCodec>,
        sent: tokio::sync::mpsc::UnboundedSender<Arc<ModelRequest>>,
    }

    #[async_trait]
    impl ProviderAdapter for Handing {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &ProviderId {
            &self.id
        }
        fn codec(&self) -> &dyn WireCodec {
            &*self.codec
        }
        fn retry_policy(&self) -> &RetryPolicy {
            &self.policy
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            &self.keepalive
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            self.sent.send(request).expect("the test is listening");
            Ok(Box::new(Steps(
                VecDeque::from([StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]),
            )))
        }
    }

    /// The surface host of the daemon reduced to what a `tools/toolsStatus` call touches: the mode, and the reconcile,
    /// which brings an empty thread to the current settings by writing its header.
    struct Reconciling(Arc<SessionDirectory>);

    fn handing() -> (Arc<Handing>, tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>) {
        let (sent, heard) = tokio::sync::mpsc::unbounded_channel();
        let provider = Arc::new(Handing { id: ProviderId::from("scripted"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, codec: mixdog_ai::providers::grok::codec("1.0.70"), sent });
        (provider, heard)
    }

    /// Once turn preparation has seated a picker edit, the provider receives those fields, not the
    /// previous send's options or the fallback chain's defaults.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_next_provider_request_uses_the_seated_model_effort_and_speed() {
        let (provider, mut sent) = handing();
        let world = turn_world(provider).await;
        let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "fallback", "fast": false })).await;
        let mut requests = Vec::new();
        for (n, op) in ["first", "second"].into_iter().enumerate() {
            if n == 1 {
                handle.request(CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": id, "set": {
                    "model": "selected", "effort": "high", "autoEffort": false, "fast": true, "modelParameters": { "serviceTier": "ultrafast" }
                }}), op: None, ctx: CallContext::internal("test") }).await.unwrap();
            }
            let before = handle.header_snapshot().get("turnCoverage").cloned();
            handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": op } }), op)).await.unwrap();
            requests.push(tokio::time::timeout(Duration::from_secs(30), sent.recv()).await.expect("provider send").unwrap());
            settled_turns(&world, &id, &handle, n + 1, before).await;
        }
        assert_eq!(requests[0].model.as_str(), "fallback");
        assert!(!requests[0].options.fast);
        assert_eq!(requests[1].model.as_str(), "selected");
        assert_eq!(requests[1].options.effort.as_deref(), Some("high"));
        assert!(requests[1].options.fast);
        assert_eq!(requests[1].options.model_parameters, Some(json!({ "serviceTier": "ultrafast" })));
    }

    // An inline module's path is resolved from `src/run_host/factory/tests/`.
    #[cfg(node_twin)]
    #[path = "../../../../../mixdog-ai/src/providers/grok/fixture_manifest.rs"]
    mod tests_manifest;

    #[cfg(node_twin)]
    #[path = "../explicit_skills_node_cases.rs"]
    mod explicit_skills_node_cases;

    #[cfg(node_twin)]
    #[path = "../skill_wire_node_cases.rs"]
    mod skill_wire_node_cases;

    #[cfg(node_twin)]
    #[path = "../completion_node_cases.rs"]
    mod completion_node_cases;

    #[cfg(node_twin)]
    #[path = "../live_cwd_node_cases.rs"]
    mod live_cwd_node_cases;

    #[cfg(node_twin)]
    #[cfg(node_twin)]
    #[cfg(node_twin)]
    #[cfg(node_twin)]
    #[path = "../../offload_prune_turn_tests.rs"]
    mod offload_prune_turn_tests;

    // ---- `$skill` chips: the skills a prompt loaded, stamped on its row (`fixtures/applied-skills`) ----

    #[cfg(node_twin)]
    struct SkillDefaults;
    #[cfg(node_twin)]
    impl mixdog_mcp::skill_catalog::SkillSettingsSource for SkillDefaults {
        fn current(&self) -> mixdog_mcp::skill_catalog::SkillSettings {
            mixdog_mcp::skill_catalog::SkillSettings::default()
        }
    }

    /// The recorded skills name no deferred tools: a load arms nothing.
    #[cfg(node_twin)]
    struct NothingToArm;
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_mcp::skill_port::DeferredToolArm for NothingToArm {
        async fn arm(&self, _: &ThreadId, _: &mixdog_mcp::skill_deps::SkillToolDependencies) -> Result<mixdog_tools::orch::skill::ArmNotice, mixdog_tools::orch::util::PortError> {
            Ok(mixdog_tools::orch::skill::ArmNotice::default())
        }
    }

    /// No skill's body is in a recorded thread before its turn loads it.
    #[cfg(node_twin)]
    struct NoBodies;
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_mcp::skill_port::TranscriptTexts for NoBodies {
        async fn user_texts(&self, _: &ThreadId) -> Result<Vec<String>, mixdog_tools::orch::util::PortError> {
            Ok(Vec::new())
        }
    }

    /// The thread's model conversation as stored (`thread/messages/read`, Node's `session.messages`): its user rows.
    #[cfg(node_twin)]
    async fn stored_user_rows(handle: &dyn ThreadHandle, id: &ThreadId) -> Vec<Value> {
        let read = CoreRequest { method: Method("thread/messages/read"), params: json!({ "threadId": id }), op: None, ctx: CallContext::internal("test") };
        let Reply::Value(read) = handle.request(read).await.expect("thread/messages/read") else { panic!("thread/messages/read answers a value") };
        read["messages"].as_array().expect("messages").iter().filter(|message| message["role"] == "user").cloned().collect()
    }

    #[cfg(node_twin)]
    struct NoPromptBlobs;

    /// The user rows the transcript restores from stored rows (`restoreTranscriptItems`), each row by itself.
    #[cfg(node_twin)]
    fn restored_user_rows(rows: &[Value]) -> Vec<Value> {
        use mixdog_core_session::session::transcript::Restored;
        let mut restored = Vec::new();
        for (n, row) in rows.iter().enumerate() {
            let mut record: mixdog_store::schema::record::ItemRecord =
                serde_json::from_value(json!({ "iid": format!("m{n}"), "form": "message", "model": true, "visible": true, "refs": [], "body": { "inline": {} } })).expect("a record");
            // The record's facts as the session writes them at commit (`user_facts`); these prompts are plain text.
            let mut body = row.clone();
            let facts = mixdog_core_session::session::user_facts::user_facts(&mut body, &NoPromptBlobs);
            record.visible = facts.visible;
            record.prompt = facts.prompt.map(Slot::Inline);
            record.body = Slot::Inline(body.clone());
            for item in mixdog_core_session::session::transcript::restore(&record, &body) {
                if let Restored::Row { row, .. } = item
                    && row.get("kind") == Some(&json!("user"))
                {
                    restored.push(Value::Object(row));
                }
            }
        }
        restored
    }

    /// The identities declared by name in `fixtures/applied-skills/MANIFEST.json` `exclusions`: each is drawn by the core
    /// (the client's turn carried Node's, `record-applied-skills.mjs` `turnMeta`; Node's restored `id` counts
    /// `hist_<session>_<n>`). Both sides must carry the same ones, the core's must be non-empty strings, and each is then
    /// replaced by one token on both sides; everything else is compared as it is.
    #[cfg(node_twin)]
    fn mask_declared_ids(row: &Value, side: &str, what: &str) -> Value {
        let mut row = row.clone();
        for path in ["/meta/transcript/messageId", "/meta/transcript/attemptId", "/meta/transcript/checkpointId", "/messageId", "/attemptId", "/checkpointId", "/id"] {
            if let Some(slot) = row.pointer_mut(path) {
                assert!(slot.as_str().is_some_and(|id| !id.is_empty()), "{what}: {side} {path} is an id, got {slot}");
                *slot = json!("<id>");
            }
        }
        if let Some(Value::Array(ids)) = row.pointer_mut("/meta/submissionIds") {
            assert!(ids.iter().all(|id| id.as_str().is_some_and(|id| !id.is_empty())), "{what}: {side} submission ids");
            let count = ids.len();
            *ids = vec![json!("<id>"); count];
        }
        row
    }

    /// Each of `got` against each of `want`, whole, but for the identities `mask_declared_ids` names.
    #[cfg(node_twin)]
    fn assert_rows(got: &[Value], want: &[Value], what: &str) {
        let want: Vec<Value> = want.iter().map(|row| mask_declared_ids(row, "recorded", what)).collect();
        let got: Vec<Value> = got.iter().map(|row| mask_declared_ids(row, "core", what)).collect();
        assert_eq!(got, want, "{what}");
    }

    /// A tool that holds its call until the test lets it go, so a prompt can be queued into the running turn.
    #[cfg(node_twin)]
    struct Hold {
        spec: ToolSpec,
        started: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    #[cfg(node_twin)]
    impl Tool for Hold {
        fn spec(&self) -> &ToolSpec {
            &self.spec
        }
        async fn call(&self, _ctx: &ToolContext, _args: JsonValue) -> ToolOutcome {
            self.started.notify_one();
            self.release.notified().await;
            Ok(ToolOutput { parts: vec![ToolPart::Text("held".into())], ..ToolOutput::default() })
        }
    }

    fn named_spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: name.into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations::default(),
            parallel_safe: true,
            exclusive_with: Vec::new(),
        }
    }

    #[cfg(node_twin)]
    fn says(text: &str) -> Vec<StreamEvent> {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    }

    /// The user lines of a thread's view, each by its text with the chips it shows.
    #[cfg(node_twin)]
    async fn user_lines(handle: &dyn ThreadHandle, id: &ThreadId) -> Vec<(String, Value)> {
        let read = CoreRequest { method: Method("thread/read"), params: json!({ "threadId": id }), op: None, ctx: CallContext::internal("test") };
        let Reply::Value(read) = handle.request(read).await.expect("thread/read") else { panic!("thread/read answers a value") };
        read["items"]
            .as_array()
            .expect("items")
            .iter()
            .filter(|item| item["type"] == "userMessage")
            .map(|item| (item["displayText"].as_str().unwrap_or_default().to_owned(), item.get("appliedSkills").cloned().unwrap_or(Value::Null)))
            .collect()
    }

    #[cfg(node_twin)]
    #[cfg(node_twin)]
    #[cfg(node_twin)]
    #[cfg(node_twin)]
    #[path = "../../restart_prefix_tests.rs"]
    mod restart_prefix;

    #[cfg(node_twin)]
    #[path = "../../session_message_sanitize_replay.rs"]
    mod session_message_sanitize_replay;

    #[cfg(node_twin)]
    #[path = "../../session_read_cache_replay.rs"]
    mod session_read_cache_replay;
    impl mixdog_core_run::run_host::hop_host::HopWiring for NoWiring {
        fn wiring(&self, _: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<mixdog_agent::effort::EffortWiring>, Option<mixdog_agent::text_only::TextOnlyInput>) {
            (None, None)
        }
    }
    async fn snapshot_call(service: &mixdog_tools::orch::status::ToolsService, thread: &ThreadId, message: &str) -> Value {
        use mixdog_core_api::DomainService;
        let call = CoreRequest { method: Method("tools/toolsStatus"), params: json!({ "threadId": thread, "snapshot": true, "snapshotUserMessage": message }), op: None, ctx: CallContext::internal("test") };
        let Ok(Reply::Value(status)) = service.call(call).await else { panic!("tools/toolsStatus answers a value") };
        status
    }
    /// A throttled draft takes the streamed text while the message's row commits on another thread: the draft is queued
    /// before the row (a draft after it would recover the message a second time). The row's commit runs at the first moment
    /// it can: at once if nothing holds the draft between taking and queuing it, else once the draft lets go.
    #[test]
    fn a_draft_taken_while_its_message_commits_is_queued_before_the_row() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let observed = Observed { started: true, text: "reading".into(), ..Observed::default() };
        let jobs = Arc::new(Jobs { observed: Arc::new(Mutex::new(observed)), seq: AtomicU64::new(0), tx, shown: None, taken: Mutex::default() });
        let later: Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Arc::default();
        let (committer, pending) = (jobs.clone(), later.clone());
        *lock(&jobs.taken) = Some(Box::new(move || {
            let free = jobs_free(&committer);
            let commit = move || {
                let item = ItemCommit { iid: ItemId::from("row"), role: Some("assistant".into()), model: true, visible: true, body: json!({ "content": "reading" }), prompt: None };
                committer.row(true, None, item);
            };
            if free {
                commit();
            } else {
                *lock(&pending) = Some(std::thread::spawn(commit));
            }
        }));
        jobs.draft();
        if let Some(thread) = lock(&later).take() {
            thread.join().expect("the commit");
        }
        let mut order = Vec::new();
        while let Ok(job) = rx.try_recv() {
            order.push(match job {
                Job::Draft(_, body) => format!("draft {}", body["text"].as_str().unwrap_or_default()),
                Job::Commit(_, item, _) => format!("row {}", item.iid.as_str()),
                Job::Compact(..) => "compact".to_owned(),
                Job::Rewound(..) => "rewound".to_owned(),
            });
        }
        assert_eq!(order, ["draft reading", "row row"]);
    }
    fn jobs_free(jobs: &Jobs) -> bool {
        jobs.observed.try_lock().is_ok()
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl mixdog_services::effort_judge::judge::StepProbs for RecordedProbs {
        async fn probs(&self, _: mixdog_agent::step_effort::StepInput) -> Result<Vec<f64>, mixdog_services::effort_judge::error::JudgeError> {
            Ok(self.0.clone())
        }
    }
    #[async_trait]
    impl mixdog_ai::registry::providers::ProviderBuilder for OneProvider {
        async fn build(&self, _name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(self.0.clone())
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(true)
        }
    }
    #[async_trait]
    impl mixdog_mcp::skill_select::SkillNames for NoSkillNames {
        async fn names(&self, _: &std::path::Path) -> Result<std::collections::HashSet<String>, String> {
            Ok(Default::default())
        }
    }
    impl super::super::settings::HeartbeatMarks for NoMarks {
        fn is_heartbeat(&self, _: &str) -> bool {
            false
        }
    }
    impl super::super::settings::OutputCeilingSource for NoCeilings {
        fn ceilings(&self, _: &str, _: &str, _: &mixdog_store::schema::record::Header) -> super::super::settings::OutputCeilings {
            Default::default()
        }
    }
    impl super::super::settings::AutoEffortSource for AutoOff {
        fn mode_on(&self) -> bool {
            false
        }
        fn base_setting(&self) -> Option<Value> {
            None
        }
        fn steps_enabled(&self) -> bool {
            true
        }
    }
    #[async_trait]
    impl mixdog_agent::attachments::AttachmentText for NoAttachmentText {
        async fn text_of(&self, _: &mixdog_core_api::domain::provider::ContentPart) -> Result<Option<String>, Box<ProviderError>> {
            Ok(None)
        }
    }
    impl mixdog_ai::registry::accounting::UsagePricing for Pricing {
        fn price_usage(&self, args: &mixdog_ai::catalog::UsageArgs) -> mixdog_ai::catalog::PricedUsage {
            mixdog_ai::catalog::PricedUsage { input: args.input_tokens, cost_usd: None, rates: serde_json::Map::new() }
        }
    }
    #[async_trait]
    impl RunParts for Parts {
        async fn reconcile_turn(&self, _: &ThreadId, mut header: mixdog_store::schema::record::Header, _: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
            if let Some(settle) = &self.settle {
                header.insert(settle.add.0.to_owned(), settle.add.1.clone());
            }
            Ok(header)
        }

        async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            if let Some(settle) = &self.settle {
                lock(&settle.seen).push(input.header.clone());
            }
            let spec = ToolSpec {
                name: "echo".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "echo".into(),
                input_schema: json!({ "type": "object" }),
                annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            };
            let tokens = mixdog_rt::testing::tokens();
            let mut config = RunConfig::new(input.thread.clone(), input.turn.clone(), "m");
            if let Some(effort) = &self.effort {
                config.options.effort = effort.effort.clone();
                config.effort = Some(mixdog_agent::effort::EffortWiring { route: effort.route.clone(), adapter: Arc::new(EffortScripted(self.provider.clone())) });
                config.step_auto_effort = effort.step_auto.clone();
            }
            Ok(Assembled {
                provider: self.provider.clone(),
                tools: ToolSet::new(std::iter::once(Arc::new(Echo(spec)) as Arc<dyn Tool>).chain(self.more.iter().cloned()).collect()),
                tool_env: ToolEnv {
                    thread_id: input.thread.clone(),
                    turn_id: input.turn.clone(),
                    cwd: mixdog_core_api::domain::common::AbsPath::new(self.workspace.clone()).unwrap(),
                    surface: SurfaceKind::Lead,
                    io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                    approvals: Arc::new(MockApprovalGate::default()),
                    files: Arc::new(MockFileService::default()),
                    processes: Arc::new(MockProcessManager::default()),
                    progress: input.progress.clone(),
                    deadline_of: None,
                    notify: input.notify.clone(),
                    review: None,
                },
                gate: Box::new(|_| Arc::new(AllowAll)),
                worktree: self.workspace.to_string_lossy().into_owned(),
                config,
                clock: Arc::new(Fixed),
                decider: Arc::new(MockRetryDecider),
                guards: Arc::new(NoGuards),
                compactor: None,
                route: None,
                skills: None,
                hooks: None,
                reuse: None,
                reactions: None,
                reaction_scope: None,
                rows: Arc::default(),
                tail: None,
                side: None,
                step_judge: self.effort.as_ref().and_then(|e| e.judge.clone()),
                artifacts: None,
                images: None,
                failures: None,
                blobs: Arc::new(NoBlobs),
                carry: RunCarry::default(),
            })
        }
    }
    #[async_trait]
    impl RunParts for Compacting {
        async fn reconcile_turn(&self, thread: &ThreadId, header: mixdog_store::schema::record::Header, conversation: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
            self.inner.reconcile_turn(thread, header, conversation).await
        }

        async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            let mut assembled = self.inner.assemble(input).await?;
            assembled.compactor = Some(self.compactor.clone());
            assembled.config.compact = Some(self.settings.clone());
            Ok(assembled)
        }
    }
    #[async_trait]
    impl RunParts for Reaping {
        async fn reconcile_turn(&self, thread: &ThreadId, header: mixdog_store::schema::record::Header, conversation: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
            self.inner.reconcile_turn(thread, header, conversation).await
        }

        async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            self.inner.assemble(input).await
        }

        fn reap_turn_shells(&self, thread: &ThreadId, since_ms: i64) {
            lock(&self.reaps).push((thread.clone(), since_ms));
            self.woke.notify_one();
        }
    }
    #[async_trait]
    impl super::super::host_seams::ConfigSeams for Config {
        fn hidden_agent(&self, _: Option<&str>) -> bool {
            false
        }
        fn synced_compaction(&self, _: &mixdog_store::schema::record::Header, _: bool) -> Option<Value> {
            None
        }
        fn route_config(&self, _: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
            Default::default()
        }
        fn settings_changes(&self, _: &mixdog_core_api::ids::ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
            None
        }
        fn run_settings(&self, _: &ThreadId, _: &mixdog_store::schema::record::Header) -> super::super::assemble::RunSettings {
            super::super::assemble::RunSettings {
                hidden_agent: false,
                agent_mode: false,
                limits: None,
                compact: None,
                escalated_max_output_tokens: None,
                read_body_required: false,
                vision: None,
                effort: None,
                step_auto_effort: None,
                text_only: None,
                attachments: None,
                file_text: None,
                model_max_output_tokens: None,
                auto_clear: None,
            }
        }
        fn stored_instruction_files(&self) -> Option<Value> {
            None
        }
        fn response_language(&self) -> Option<(String, String)> {
            None
        }
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl super::super::host_seams::ConfigSeams for ManualConfig {
        fn hidden_agent(&self, agent: Option<&str>) -> bool {
            super::super::host_seams::ConfigSeams::hidden_agent(&Config, agent)
        }
        fn synced_compaction(&self, header: &mixdog_store::schema::record::Header, install: bool) -> Option<Value> {
            super::super::host_seams::ConfigSeams::synced_compaction(&Config, header, install)
        }
        fn route_config(&self, header: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
            super::super::host_seams::ConfigSeams::route_config(&Config, header)
        }
        fn settings_changes(&self, _: &ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
            None
        }
        fn run_settings(&self, thread: &ThreadId, header: &mixdog_store::schema::record::Header) -> super::super::assemble::RunSettings {
            let mut settings = super::super::host_seams::ConfigSeams::run_settings(&Config, thread, header);
            settings.compact = Some(self.0.clone());
            settings
        }
        fn stored_instruction_files(&self) -> Option<Value> {
            None
        }
        fn response_language(&self) -> Option<(String, String)> {
            None
        }
    }
    /// The skill catalog over `<data>/skills` and the `Skill` tool that loads from it (`CatalogSkillPort`), as the core
    /// composes them: the selection lists from the catalog and loads through the tool.
    #[cfg(node_twin)]
    fn real_skills(data: &std::path::Path) -> (Arc<mixdog_mcp::skill_catalog::SkillCatalog>, mixdog_mcp::skills_watch::SkillsWatch, super::super::assemble::SkillParts) {
        let tokens = mixdog_rt::testing::tokens();
        let root = mixdog_mcp::skills::SkillRoot { dir: data.join("skills"), source: mixdog_mcp::skills::SkillSource::Global, plugin: None };
        let watch = mixdog_mcp::skills_watch::SkillsWatch::new();
        let catalog = mixdog_mcp::skill_catalog::SkillCatalog::new(
            data.to_path_buf(),
            tokens.maintenance_io,
            Arc::new(move |_| vec![root.clone()]),
            Arc::new(SkillDefaults),
            &watch,
        );
        let port = mixdog_mcp::skill_port::CatalogSkillPort::new(catalog.clone(), Arc::new(NothingToArm), Arc::new(NoBodies));
        let tool: Arc<dyn Tool> = Arc::new(mixdog_tools::orch::skill::SkillTool::new(Arc::new(port)));
        (catalog.clone(), watch, super::super::assemble::SkillParts { names: catalog.clone(), tool, deliveries: Some(catalog) })
    }
    /// [`Parts`] whose turns select skills and stamp what loaded on the thread of the late-bound directory.
    #[cfg(node_twin)]
    struct Skilled {
        inner: Parts,
        skills: super::super::assemble::SkillParts,
        directory: Arc<std::sync::OnceLock<std::sync::Weak<SessionDirectory>>>,
    }
    #[async_trait]
    #[cfg(node_twin)]
    impl RunParts for Skilled {
        async fn reconcile_turn(&self, thread: &ThreadId, header: mixdog_store::schema::record::Header, conversation: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
            self.inner.reconcile_turn(thread, header, conversation).await
        }

        async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            let mut assembled = self.inner.assemble(input).await?;
            let parts = self.skills.clone();
            assembled.skills = Some(Box::new(move |run: SkillContext| {
                Arc::new(super::super::mcp_seams::ExplicitSkillSelector::new(parts.names, parts.tool, run.gate, run.env, run.cancel)) as Arc<dyn SkillSelector>
            }));
            Ok(assembled)
        }

        async fn record_applied_skills(&self, thread: &ThreadId, item: &ItemId, names: &[String]) -> Result<(), TurnError> {
            let Some(directory) = self.directory.get().and_then(std::sync::Weak::upgrade) else {
                return Err(TurnError { message: "the session directory is closed".into(), data: json!({}), provider_error: None });
            };
            mixdog_core_session::session::thread_switches::record_applied_skills(&directory, thread, item, names)
                .await
                .map_err(|error| TurnError { message: error.to_string(), data: json!({}), provider_error: None })
        }
    }
    /// The process died again after a recovery's rows landed and before its end record: the next recovery keeps the restart
    /// line where it stands and adds no second one.
    #[test]
    fn a_recovery_whose_rows_landed_adds_no_second_restart_line() {
        use mixdog_agent::interrupt::PROCESS_RESTART_INTERRUPT_MESSAGE;
        let row = |role: &str, text: &str| json!({ "role": role, "content": text });
        let context = vec![
            (ItemId::from("in"), row("user", "do the task")),
            (ItemId::from("partial"), row("assistant", "partial streamed answer")),
            (ItemId::from("restart"), row("user", PROCESS_RESTART_INTERRUPT_MESSAGE)),
        ];
        let draft = mixdog_core_session::session::turn_draft::RunDraft { started: true, input: Some("in".into()), ..Default::default() };
        let left = crashed_rows(mixdog_core_session::session::CrashedRun { context, input: Some(ItemId::from("in")), draft });
        assert!(!left.sealed);
        assert!(left.rows.is_empty(), "no row is added: {:?}", left.rows.iter().map(|row| row.body.clone()).collect::<Vec<_>>());
        let kept: Vec<String> = left.context.expect("the context restarts on the turn").into_iter().map(|(iid, _)| iid.as_str().to_owned()).collect();
        assert_eq!(kept, ["in", "partial", "restart"]);
    }
    /// A run that died with nothing drafted (only its draft's opening body) is finalized from its rows alone, as Node's reconnect
    /// recovery finalizes it (`recover_after_restart`, which the session crate's scripted runs answer a crash with): the same
    /// rows are added, in the same order.
    #[test]
    fn a_draftless_crash_is_finalized_as_the_reconnect_recovery_finalizes_it() {
        let context = vec![
            (ItemId::from("in"), json!({ "role": "user", "content": "read a" })),
            (ItemId::from("call"), json!({ "role": "assistant", "content": "Reading.", "toolCalls": [{ "id": "call_1", "name": "read", "arguments": { "path": "a.txt" } }] })),
        ];
        let bodies: Vec<Value> = context.iter().map(|(_, body)| body.clone()).collect();
        let reconnect: Vec<(String, Value)> = mixdog_agent::interrupt::recover_after_restart(&bodies)
            .expect("recovered")
            .into_iter()
            .filter_map(|row| match row {
                mixdog_agent::interrupt::RecoveredRow::New { role, body } => Some((role.to_owned(), body)),
                mixdog_agent::interrupt::RecoveredRow::Kept { .. } => None,
            })
            .collect();
        assert!(!reconnect.is_empty());
        let draft = mixdog_core_session::session::turn_draft::RunDraft { input: Some("in".into()), ..Default::default() };
        let left = crashed_rows(mixdog_core_session::session::CrashedRun { context, input: Some(ItemId::from("in")), draft });
        assert!(!left.sealed);
        let added: Vec<(String, Value)> = left.rows.into_iter().map(|row| (row.role.unwrap_or_default(), row.body)).collect();
        let shape = |rows: &[(String, Value)]| rows.iter().map(|(role, body)| (role.clone(), body["content"].clone(), body["toolCallId"].clone())).collect::<Vec<_>>();
        assert_eq!(shape(&added), shape(&reconnect));
    }
    impl mixdog_protocol::message_class::user_text::Blobs for NoBlobs {
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
            Ok(None)
        }
    }
    #[derive(Default)]
    struct Ledger(Mutex<Vec<mixdog_ai::registry::accounting::UsageRow>>, tokio::sync::Notify);
    #[async_trait]
    impl mixdog_ai::registry::accounting::UsageSink for Ledger {
        async fn record_queued(&self, row: mixdog_ai::registry::accounting::UsageRow) -> Result<(), String> {
            lock(&self.0).push(row);
            self.1.notify_waiters();
            Ok(())
        }
    }
    #[async_trait]
    impl mixdog_core_run::run_host::hop_host::HopSession for NoHopWrites {
        fn header(&self) -> Option<Arc<mixdog_store::schema::record::Header>> {
            None
        }
        async fn write_hop(&self, _: mixdog_core_ports::ports::domain_sessions::Obj, _: &mixdog_core_run::run_host::route_fallback::HopWrite) -> Result<Option<mixdog_store::schema::record::Header>, mixdog_tools::orch::util::PortError> {
            unreachable!("no hop in this test")
        }
        async fn write_wire_pin(&self, _: Value) -> Result<(), mixdog_tools::orch::util::PortError> {
            unreachable!("no hop in this test")
        }
        async fn rebuild_tool_surface(&self, _: &str) -> Result<(), mixdog_tools::orch::util::PortError> {
            unreachable!("no hop in this test")
        }
    }
    #[cfg(node_twin)]
    impl mixdog_protocol::message_class::user_text::Blobs for NoPromptBlobs {
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
            Err(mixdog_protocol::message_class::user_text::ReadError::Missing)
        }
    }


    /// `fixtures/turn-effort/*.json` (`record-turn-effort.mjs`, client mode): Node's TUI session store over its real
    /// session runtime ran a turn (a tool call, then a reply) on an Anthropic route with effort fixed (`high`), none, and
    /// Auto at `medium` with the step judged after the tool call; each change its route state published
    /// (`local-session-runtime.mjs` `publishChanged`) was recorded whole, in order, with the state before the turn and how
    /// it ended. The same turn here: the session actor starts it, the factory builds the run with the route's effort wiring
    /// and the judge over the recorded judge answers, and every `thread/route/updated` frame the actor sent the thread's feed
    /// is read in order, whole sequence; each request's effort is the recorded one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn the_actor_publishes_the_turn_effort_sequence_node_published() {
        use mixdog_agent::effort::{EffortMode, EffortRoute, EffortSnapshot};
        for name in ["fixed", "none", "auto-step"] {
            let recorded: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/../../fixtures/turn-effort/{name}.json", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap();
            let effort = recorded["route"]["effort"].as_str().map(str::to_owned);
            let model = recorded["route"]["model"].as_str().unwrap().to_owned();
            let prompt = recorded["prompt"].as_str().unwrap().to_owned();
            let route = EffortRoute {
                provider: "anthropic".into(),
                model: model.clone(),
                mode: Some(EffortMode::Anthropic),
                allowed: ["low", "medium", "high"].map(String::from).to_vec(),
                seed: effort.clone().map(|e| EffortSnapshot { provider: "anthropic".into(), model: model.clone(), mode: EffortMode::Anthropic, initial_effort: e.clone(), effort: e }),
                wire: Arc::new(|e| Some(e.to_owned())),
            };
            let probs = |kind: &str| recorded["judge"][kind].as_array().unwrap().iter().map(|p| p.as_f64().unwrap()).collect::<Vec<f64>>();
            let (step_auto, judge) = if recorded["autoEffort"] == "on" {
                let options = mixdog_ai::effort::effort_options_for("anthropic", &json!({ "id": model, "reasoningLevels": ["low", "medium", "high"], "customReasoning": true }), None);
                let base = mixdog_services::effort_judge::ladder::resolve_auto_effort(effort.as_deref().unwrap(), &options, &probs("turn")).expect("the route's effort is on its ladder").effort.to_owned();
                let ladder = Arc::new(mixdog_services::effort_judge::AutoLadder { base: base.clone(), options });
                let judge: Arc<dyn mixdog_agent::step_effort::StepEffortJudge> = Arc::new(mixdog_services::effort_judge::EffortJudge::over(Arc::new(RecordedProbs(probs("step"))), ladder));
                (Some(mixdog_agent::step_effort::StepAutoEffort { request: prompt.clone(), base }), Some(judge))
            } else {
                (None, None)
            };
            let provider = Arc::new(Scripted {
                id: ProviderId::from("anthropic"),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(VecDeque::from([
                    vec![
                        StreamEvent::TextDelta("reading".into()),
                        StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "path": "a.txt" }), native_type: None }),
                        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                    ],
                    vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
                ])),
                requests: Mutex::new(Vec::new()),
                fail_first: std::sync::atomic::AtomicBool::new(false),
            });
            let workspace = tempfile::tempdir().unwrap();
            let rig = Rig::new();
            let mut deps = rig.deps_parts(rig.store.clone());
            let parts = Parts {
                provider: provider.clone(),
                workspace: workspace.path().to_path_buf(),
                more: Vec::new(),
                settle: None,
                effort: Some(Arc::new(EffortParts { effort: effort.clone(), route, step_auto, judge })),
            };
            deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(parts)));
            let directory = SessionDirectory::new(Arc::new(deps));
            // The session as Node's run had it: the route's provider and model, and the window the catalog gave the model
            // (the recording's first publication: 500000, 500000, 100).
            let published = &recorded["client"]["published"][0];
            let mut header = mixdog_store::schema::record::Header::new();
            for (key, value) in [("provider", json!("anthropic")), ("model", json!(model)), ("kind", json!("task")), ("cwd", json!("/ws"))] {
                header.insert(key.into(), value);
            }
            for key in ["contextWindow", "rawContextWindow", "effectiveContextWindowPercent"] {
                header.insert(key.into(), published[key].clone());
            }
            assert_eq!(published["sessionProvider"], "anthropic", "{name}: the recording's route");
            let id = ThreadId::from(format!("effort-{name}"));
            directory.create_with_id(id.clone(), header, json!({})).await.expect("the session");
            directory.open(&id, &CallContext::internal("test")).await.expect("the session opens");
            let handle = directory.handle(&id).expect("loaded");
            let frames = |method: &str| -> Vec<Value> { rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == method).map(|(_, _, params)| params).collect() };
            // `initial` and `atStart`: the route state before the turn, and what was published before it.
            let before = frames("thread/route/updated");
            assert_eq!(before.len(), recorded["client"]["atStart"].as_array().unwrap().len(), "{name}: nothing is published before the turn");
            assert_eq!(before.last().map_or(Value::Null, |p| p["value"]["turnEffort"].clone()), recorded["client"]["initial"], "{name}: the effort before the turn");
            handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": prompt } }), "op-1")).await.expect("turn/start");
            eventually_on_awaiting(|| format!("{name}: the turn's end"), &[handle.stepped()], || (!frames("turn/completed").is_empty()).then_some(())).await;
            // `status`: the turn the client's `submitAndWait` saw end `done` is the one that completed.
            assert_eq!(recorded["client"]["status"], "done", "{name}: the recorded turn ended done");
            assert_eq!(frames("turn/completed").len(), 1, "{name}: the turn completed once");
            // Every publication of the client's route state (`publishChanged`: the keys that changed, the first one the whole
            // route), in order. The core publishes the whole route with each frame: Node's changes accumulate into the state the
            // client held after each publication, and `turnEffort` is compared in each. The other keys of Node's first publication
            // (`sessionId`, `sessionProvider`, `sessionModel`, the context windows and limits, `agentScope`) are the MANIFEST's
            // declared exclusion: this rig's thread stores no route and the windows are `thread/context/updated`'s.
            // A publication that does not carry `turnEffort` is the client's first snapshot of a route that never changed (the
            // `none` scenario): the core publishes no frame for a route that did not change. Declared in the MANIFEST.
            // The core's publications, as Node's keys: the route frames carry `turnEffort`, the context frames the windows
            // and limits. Node publishes only what changed, so the first publication holds the whole route and each later
            // one the keys that changed; the core's first route frame and first context frame make the first, each later
            // route frame one more, and a later context frame must repeat the first's windows (nothing changed).
            let routes = frames("thread/route/updated");
            let contexts = frames("thread/context/updated");
            const CONTEXT_KEYS: [&str; 6] = ["contextWindow", "rawContextWindow", "effectiveContextWindowPercent", "displayContextWindow", "compactBoundaryTokens", "autoCompactTokenLimit"];
            let window_of = |frame: &Value| -> serde_json::Map<String, Value> { CONTEXT_KEYS.iter().map(|k| ((*k).to_owned(), frame["value"][*k].clone())).collect() };
            let first_context = window_of(contexts.first().expect("a context frame"));
            for later in &contexts[1..] {
                assert_eq!(window_of(later), first_context, "{name}: a later context frame changes no window");
            }
            let mut core: Vec<serde_json::Map<String, Value>> = routes.iter().map(|f| serde_json::Map::from_iter([("turnEffort".to_owned(), f["value"]["turnEffort"].clone())])).collect();
            if core.is_empty() {
                core.push(serde_json::Map::new());
            }
            core[0].extend(first_context);
            // The session's route as the thread's state holds it (`thread/read`): its provider and model.
            let Reply::Value(read) = handle.request(CoreRequest { method: Method("thread/read"), params: json!({ "threadId": id }), op: None, ctx: CallContext::internal("test") }).await.expect("thread/read") else { panic!("thread/read answers a value") };
            for key in ["sessionProvider", "sessionModel"] {
                core[0].insert(key.to_owned(), read["state"]["route"][key].clone());
            }
            let node = recorded["client"]["published"].as_array().unwrap();
            assert_eq!(core.len(), node.len(), "{name}: one publication for each of Node's");
            // Each publication compared whole, key by key, over the route, provider, model and catalog window the recording
            // ran with. The only keys that differ are the identity keys, asserted exactly: the core's frames carry no `sessionId`
            // and no `agentScope` (the frame's `threadId` names the thread). A publication without `turnEffort` (scenario
            // `none`: a route that never changed) is compared as it is: the core has no route frame, and no such key.
            // `displayContextWindow` differs in it too: Node's first publication is made before its first status pass and holds 0,
            // while the core shows the seated route's window from the start (`SessionState::context`); asserted exactly below.
            const NAMED_ABSENCES: [&str; 3] = ["agentScope", "displayContextWindow", "sessionId"];
            for (n, (node, core)) in node.iter().zip(&core).enumerate() {
                let node = node.as_object().unwrap();
                let mut differing: Vec<&str> = node.keys().chain(core.keys()).filter(|k| node.get(*k) != core.get(*k)).map(String::as_str).collect();
                differing.sort_unstable();
                differing.dedup();
                let named: &[&str] = if n == 0 { &NAMED_ABSENCES } else { &[] };
                assert_eq!(differing, named, "{name}: publication {n}: the keys that differ from Node's");
                if n == 0 {
                    assert_eq!((node["displayContextWindow"].as_i64(), core["displayContextWindow"].as_i64()), (Some(0), node["contextWindow"].as_i64()), "{name}: the window the core shows from the start");
                }
            }
            let sent: Vec<Value> = lock(&provider.requests).iter().map(|r| json!(r.options.effort)).collect();
            let node: Vec<Value> = recorded["sends"].as_array().unwrap().iter().map(|s| s["requestEffort"].clone()).collect();
            assert_eq!(sent, node, "{name}: each request's effort");
        }
    }
    /// `fixtures/turn-durability` `save-failure-tool-rounds`: while the saves fail Node carries the turn on through its tool
    /// rounds to the answer (it gates only the next turn's open on durability, `turn-durability.mjs`). A row the store refuses
    /// here neither stops the tool the row carried nor the requests after it: the recorded number of requests is sent, every
    /// tool runs, the answer is stored, and no storage error is raised inside the turn.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_refused_row_save_does_not_stop_the_running_turn_as_node_carries_it_on() {
        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/turn-durability/golden.json")).expect("golden");
        let case = golden["cases"].as_array().unwrap().iter().find(|case| case["name"] == "save-failure-tool-rounds").expect("the recorded case");
        let recorded_sends = case["steps"][0]["sends"].as_u64().expect("sends") as usize;
        let round = |text: &str, id: &str| {
            vec![
                StreamEvent::TextDelta(text.into()),
                StreamEvent::ToolCallDone(ToolCall { id: id.into(), name: "echo".into(), arguments: json!({ "a": id }), native_type: None }),
                StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
            ]
        };
        let scripted = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([round("reading", "c1"), round("reading again", "c2"), says("answer")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let provider = Arc::new(RefusesNextSave { inner: scripted.clone(), refuse: rig.store.fail_next.clone() });
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        let stored = || format!("{:?}", rig.store.records(&id));
        eventually_on_awaiting(|| "the answer in the store".to_owned(), &[handle.stepped()], || (stored().contains("answer") && !handle.turn_busy()).then_some(())).await;
        assert_eq!(lock(&scripted.requests).len(), recorded_sends, "the requests Node sent while its saves failed");
        assert!(["c1", "c2"].iter().all(|id| stored().contains(&format!("echo:{{\\\"a\\\":\\\"{id}\\\"}}")) || stored().contains(&format!("echo:{{\"a\":\"{id}\"}}"))), "both tool rounds ran: {}", stored());
        assert!(!stored().contains("is not saved to disk"), "no storage error inside the turn: {}", stored());
    }
    /// `fixtures/session-transcript/turn-lead.json`: Node's exec turn over its real session runtime, a Lead session with
    /// memory on and a value it marked sensitive, wrote `<home>/projects/<slug>/<id>.jsonl` as the prompt, the text the
    /// model surfaced before its tool call and the final answer, each with the value redacted. The same turn here goes
    /// the whole production way (the session actor starts it, the factory builds the run, the loop asks the provider and
    /// runs the tool) and leaves the same file; the cwd, the project slug, the session id and the wall clock are names.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_turn_writes_the_conversation_transcript_node_wrote() {
        let recorded: Value = serde_json::from_str(include_str!("../../../../fixtures/session-transcript/turn-lead.json")).expect("the recording");
        let script = recorded["script"].as_array().expect("script");
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::TextDelta(script[0]["text"].as_str().unwrap().to_owned()),
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: script[0]["calls"][0][1].clone(), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta(script[1]["text"].as_str().unwrap().to_owned()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let files = mixdog_core_session::session::transcript_writer::TranscriptFiles::new(home.path(), mixdog_rt::testing::tokens().durability_io, Arc::new(TranscriptNow), rig.sensitive.clone());
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.transcripts = Some(files.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let project = workspace.path().to_string_lossy().into_owned();
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": project }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        // The value the session marked sensitive, as the recording's browser fill marked it.
        rig.sensitive.remember(id.as_str(), &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "ref": "e1", "text": recorded["secret"], "sensitive": true } } })]);
        let handle = directory.handle(&id).expect("loaded");
        handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": recorded["prompt"] } }), "op-1"))
            .await
            .expect("turn/start");
        let rows = || rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Item(_))).count();
        eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (rows() >= 4 && !handle.turn_busy()).then_some(())).await;
        let header = handle.header_snapshot();
        files.turn(id.as_str(), &header, &[]).expect("the session's transcript").flushed().await;

        let cwd = header["cwd"].as_str().expect("cwd").to_owned();
        let slug = mixdog_core_session::session::purge::project_slug(&cwd);
        let path = home.path().join("projects").join(&slug).join(format!("{id}.jsonl"));
        let written = std::fs::read_to_string(&path).expect("the transcript");
        let named = written
            .replace(&serde_json::to_string(&cwd).unwrap()[1..serde_json::to_string(&cwd).unwrap().len() - 1], "<cwd>")
            .replace(id.as_str(), recorded["sessionId"].as_str().unwrap())
            .replace("\"timestamp\":\"2026-03-04T05:06:07.890Z\"", "\"timestamp\":\"<now>\"");
        let node = recorded["atClose"]["files"].as_object().expect("files");
        let key = format!("<slug>/{}.jsonl", recorded["sessionId"].as_str().unwrap());
        assert_eq!(node.keys().collect::<Vec<_>>(), [&key], "Node wrote one transcript, named as here");
        assert_eq!(named, node[&key].as_str().unwrap());
    }
    /// `fixtures/session-transcript/turn-exec.json`: Node's own exec runtime (memory switched off for the session,
    /// `MIXDOG_FEATURE_MEMORY=0`) writes its transcript only inside its pristine home, which is gone when the exec ends,
    /// with the memory ingest disabled there: nothing of the conversation is left for memory. A session whose memory is
    /// off writes no transcript here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_session_with_memory_off_leaves_no_transcript_for_memory() {
        let recorded: Value = serde_json::from_str(include_str!("../../../../fixtures/session-transcript/turn-exec.json")).expect("the recording");
        assert_eq!(recorded["memoryFeature"], false);
        assert_eq!(recorded["atClose"]["memoryIngestDisabled"], "1");
        assert_eq!(recorded["afterExec"], json!({ "userProjects": [], "pristineHomeLeft": false }));
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let files = mixdog_core_session::session::transcript_writer::TranscriptFiles::new(home.path(), mixdog_rt::testing::tokens().durability_io, Arc::new(TranscriptNow), rig.sensitive.clone());
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.transcripts = Some(files.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let project = workspace.path().to_string_lossy().into_owned();
        let params = json!({ "opId": "op-start", "kind": "task", "projectPath": project, "session": { "toolProfile": "headless", "approvalMode": "implicit", "memory": false } });
        let reply = directory.request(request("thread/start", params, "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": recorded["prompt"] } }), "op-1")).await.expect("turn/start");
        let rows = || rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Item(_))).count();
        eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (rows() >= 2 && !handle.turn_busy()).then_some(())).await;
        assert!(files.turn(id.as_str(), &handle.header_snapshot(), &[]).is_none(), "no writer for a memory-off session");
        assert!(!home.path().join("projects").exists(), "nothing was written for memory");
    }
    /// A provider's notice (the Gemini redirect) goes the whole way a client reads it: the stream event, the loop's
    /// stage notice, the run host's shown event, the session's live row and the frame the thread's feed publishes (the
    /// feed desktop and phone both follow). The message and tone are the Node recording's, and the row is the one the
    /// real TUI/desktop notice surface made of it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_providers_notice_reaches_the_threads_clients_as_the_row_node_showed() {
        let text = mixdog_testkit::fixture!("../../fixtures/wire-anthropic-gemini/gemini.json");
        let recorded: Value = serde_json::from_str(&text).expect("the Gemini recording");
        let send = &recorded["scenarios"].as_array().unwrap().iter().find(|s| s["id"] == "pro25.boundary-at").expect("the redirect scenario")["sends"][0];
        let (notice, row) = (&send["notices"][0], &send["noticeRows"][0]);
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([vec![
                StreamEvent::Notice { message: notice["message"].as_str().unwrap().to_owned(), warn: notice["tone"] == "warn" },
                StreamEvent::TextDelta("hello".into()),
                StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
            ]])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        // Woken by each step of the thread's actor; the frame is searched for before waiting.
        let shown = mixdog_rt::time::timeout(std::time::Duration::from_secs(30), async { loop {
            let stepped = handle.stepped().notified();
            tokio::pin!(stepped);
            stepped.as_mut().enable();
            let found = rig.feeds.frames(id.as_str()).into_iter().find_map(|(_, _, params)| {
                let text = row["text"].as_str().unwrap();
                // The row's text and tone sit in the item's `meta`; its `kind` is on the item that holds them.
                let mut stack = vec![(params, Value::Null)];
                while let Some((value, kind)) = stack.pop() {
                    match value {
                        Value::Object(mut map) if map.get("text").and_then(Value::as_str) == Some(text) => {
                            map.entry("kind").or_insert(kind);
                            return Some(Value::Object(map));
                        }
                        Value::Object(map) => {
                            let kind = map.get("kind").cloned().unwrap_or(kind);
                            stack.extend(map.into_iter().map(|(_, v)| (v, kind.clone())));
                        }
                        Value::Array(all) => stack.extend(all.into_iter().map(|v| (v, kind.clone()))),
                        _ => {}
                    }
                }
                None
            });
            if let Some(found) = found {
                break found;
            }
            stepped.await;
        } })
        .await
        .expect("the thread's feed never published the provider's notice within 30 s");
        assert_eq!((shown["kind"].clone(), shown["text"].clone(), shown["tone"].clone()), (row["kind"].clone(), row["text"].clone(), row["tone"].clone()), "{shown}");
    }
    /// A conversation whose settings moved since its prompt: the notice staged on its header reaches the model with the
    /// next turn that is accepted, once (`ask-turn-prepare.mjs:204`, `ask-turn-settle.mjs:155-156`; the notice, the
    /// carrying message and the settled header are `fixtures/prompt-notice-turn`, the first case). A turn the provider
    /// refuses acknowledges nothing, so the notice stays pending and the turn after it carries it; the turn after that
    /// carries nothing new.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_staged_settings_notice_reaches_the_model_once_and_a_failed_turn_leaves_it_pending() {
        let twin: Value = serde_json::from_str(include_str!("../../../../fixtures/prompt-notice-turn/twin.json")).unwrap();
        let case = &twin["cases"][0];
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([done("two"), done("three")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(true),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        // The settings moved: what `stage_prompt_settings_notice` leaves on the header at a turn start.
        let threads = mixdog_core_session::session::thread_state::SessionThreads::new(Arc::new(directory));
        use mixdog_core_ports::ports::threads::ThreadState;
        // The same turn also carries a workflow switch, a prepared worktree's report and a deferred-tool delta, staged as
        // Node leaves them (`fixtures/turn-reminders`).
        let reminders: Value = serde_json::from_str(&mixdog_testkit::todo_wording(mixdog_testkit::fixture!("../../fixtures/turn-reminders/twin.json"))).unwrap();
        let session_of = |name: &str| reminders["cases"].as_array().unwrap().iter().find(|case| case["name"] == name).unwrap()["session"].clone();
        let (switched, setup, delta) = (session_of("workflow-carried-by-prompt"), session_of("setup-notice"), session_of("deferred-delta-removals-only"));
        let staged: serde_json::Map<String, Value> = [
            ("promptSettings".to_owned(), case["startRecord"].clone()),
            ("promptSettingsNotice".to_owned(), case["pending"].clone()),
            ("promptSettingsNoticeRevision".to_owned(), case["pending"]["revision"].clone()),
            ("workflowSwitch".to_owned(), switched["workflowSwitch"].clone()),
            ("pendingSetupNotice".to_owned(), setup["pendingSetupNotice"].clone()),
            ("pendingDeferredToolDelta".to_owned(), delta["pendingDeferredToolDelta"].clone()),
            ("deferredToolDeltaRevision".to_owned(), delta["deferredToolDeltaRevision"].clone()),
            ("deferredMcpToolNames".to_owned(), delta["deferredMcpToolNames"].clone()),
        ]
        .into_iter()
        .collect();
        threads.patch_header(&id, staged, Vec::new()).await.expect("staged");

        let ended = || {
            rig.store
                .records(&id)
                .into_iter()
                .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
                .count()
        };
        let turn = |prompt: &str, op: &str, want: usize| {
            let (handle, op, thread, prompt) = (handle.clone(), op.to_owned(), id.clone(), prompt.to_owned());
            let ended = &ended;
            async move {
                // The settle writes the acknowledgement of what the turn carried, then the run's end record, then the
                // turn's coverage stamp (`actor.rs` settle; Node: `commitAskTurn` acknowledges, `ask-turn-settle.mjs:148-164`,
                // before the turn is published). The header a client reads follows only once each is acked, and the store
                // already holds the end record before that, so the end record alone does not say the header is settled:
                // the coverage stamp, the last of them, does.
                let covered = || handle.header_snapshot().get("turnCoverage").cloned();
                let before = covered();
                handle.request(request("turn/start", json!({ "threadId": thread, "opId": op, "input": { "prompt": prompt } }), &op)).await.expect("turn/start");
                eventually_on_awaiting(|| format!("the end record of run {want} and the changed turnCoverage stamp (turn {op})"), &[handle.stepped()], || (ended() >= want && covered() != before).then_some(())).await;
            }
        };
        let header = || async { threads.header(&id).await.expect("header") };

        turn("one", "op-1", 1).await;
        assert!(lock(&provider.requests).is_empty(), "the first attempt was refused");
        let after_failure = header().await;
        assert_eq!(after_failure["promptSettingsNotice"], case["failed"]["notice"], "a failed turn acknowledges nothing");
        for key in ["workflowSwitch", "pendingSetupNotice", "pendingDeferredToolDelta"] {
            assert!(after_failure.get(key).is_some(), "a failed turn leaves {key} pending");
        }

        turn("two", "op-2", 2).await;
        let settled = header().await;
        let after = &case["after"];
        assert!(settled.get("promptSettingsNotice").is_none(), "the accepted turn acknowledged the notice");
        for key in ["workflowSwitch", "pendingSetupNotice", "pendingDeferredToolDelta"] {
            assert!(settled.get(key).is_none(), "the accepted turn acknowledged {key}");
        }
        assert_eq!(settled["promptSettingsTold"], after["told"]);
        assert_eq!(settled["promptSettingsNoticeRevision"], after["revision"]);

        turn("three", "op-3", 3).await;
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2);
        // The turn's own message is the last one of its request.
        let last = |request: &ModelRequest| format!("{:?}", request.messages.last().expect("a message").content);
        assert!(last(&requests[0]).contains("Core memory was updated"), "the accepted turn's request carries the notice");
        assert!(last(&requests[0]).contains("two"));
        for marker in ["# Workflow Changed", "# Worktree Prepared", "<deferred_tools_delta>"] {
            assert!(last(&requests[0]).contains(marker), "the accepted turn's request carries {marker}");
            assert!(!last(&requests[1]).contains(marker), "the next turn does not carry {marker} again");
        }
        assert!(!last(&requests[1]).contains("Core memory was updated"), "the next turn carries nothing new");
        assert!(header().await.get("promptSettingsNotice").is_none());
    }
    /// A production failed turn: the provider refuses on exhausted quota and names the reset. The run ends with the
    /// facts Node's `turnFailureRecord` reads off that error (`fixtures/turn-failure`, the first case), the row's
    /// completion stores them, the turn end is shown, and the quota settlement that reads it queues the auto-resume at
    /// Node's reset. Nothing here waits on a clock: the store tells when the entry is queued.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_quota_failed_run_stores_nodes_failure_record_and_queues_the_resume_at_its_reset() {
        let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/turn-failure/golden.json")).unwrap();
        let case = &gold["cases"][0];
        assert_eq!(case["name"], "quota with a provider-named reset");
        let reset = gold["resetAt"].as_u64().expect("the recorded reset");
        let mut refusal = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::QuotaExhausted, DeliveryState::Accepted);
        refusal.status = Some(429);
        refusal.code = case["fields"]["code"].as_str().map(str::to_owned);
        refusal.message = case["message"].as_str().unwrap().to_owned();
        refusal.reset_at = Some(std::time::UNIX_EPOCH + Duration::from_millis(reset));
        let provider = Arc::new(Refusing { id: ProviderId::from("anthropic-oauth"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, codec: MockCodec, error: refusal });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let woke = Arc::new(tokio::sync::Notify::new());
        let _subscription = {
            let woke = woke.clone();
            rig.quota.subscribe(move |_| woke.notify_one())
        };
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        // A session has the route it runs on (Node requires a provider and a model), which the quota stop names and
        // the resume entry requires.
        let route = case["route"].clone();
        let patch = json!({ "threadId": id, "set": { "provider": route["provider"], "model": route["model"] }, "unset": [] });
        handle.request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") }).await.expect("route");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        let entry = eventually_on_awaiting(|| "the quota entry for the failed run's thread".to_owned(), &[&*woke], || rig.quota.entry(id.as_str())).await;
        assert_eq!(entry.to_value()["resetAt"].as_f64(), Some(reset as f64), "the resume waits for the reset the provider named");

        let completion = rig
            .store
            .records(&id)
            .into_iter()
            .find_map(|(_, record)| match record {
                Record::Amend(amend) => match amend.body {
                    Slot::Inline(body) => body.pointer("/meta/transcript/completion").cloned(),
                    _ => None,
                },
                _ => None,
            })
            .expect("the failed turn's row records its end");
        assert_eq!(completion["status"], "failed");
        assert_eq!(completion["errorKind"], case["errorKind"]);
        assert_eq!(completion["detail"], case["detail"]);
        assert_eq!(completion["errorDetails"], case["errorDetails"]);
        assert_eq!(completion["quota"]["resetAt"], case["quota"]["resetAt"]);
    }
    /// `registerNativeWebSearchUsageSink` (`turn-run.mjs`): a search a turn's tool runs reaches the thread's clients as
    /// `thread/tokenUsage/updated` with the search's own delta (recorded from Node, `mixdog-cli/tests/record_search_usage.mjs`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_search_a_turns_tool_runs_is_heard_by_the_thread() {
        let golden: Value = serde_json::from_str(include_str!("../../../mixdog-cli/tests/goldens/exec_search_usage.json")).unwrap();
        let delta = golden["search"][0].clone();
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "search".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let sinks = mixdog_tools::web::NativeSearchUsageSinks::new();
        let searcher = Searcher {
            spec: ToolSpec {
                name: "search".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "search".into(),
                input_schema: json!({ "type": "object" }),
                annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
            sinks: sinks.clone(),
            delta: delta.clone(),
        };
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), sinks, Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(searcher)], settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        let heard = || -> Vec<Value> {
            rig.feeds.frames(id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/tokenUsage/updated").map(|(_, _, params)| params["usage"].clone()).collect()
        };
        // Woken by each step of the thread's actor.
        eventually_on_awaiting(|| "the thread/tokenUsage/updated frame carrying the usage delta".to_owned(), &[handle.stepped()], || heard().contains(&delta).then_some(())).await;
        assert_eq!(heard().iter().filter(|usage| **usage == delta).count(), 1);
    }
    /// `fixtures/cache-break` `compactions` `manual` through the core's real manual compaction (`HostManualCompaction::compact`):
    /// the recording's three prompts run as real turns of a real thread, then the thread is compacted by the run host's own entry
    /// over its stored rows, the compactor the session gets from `SessionCompactors`, and the directory's commit. What the core parks in the
    /// thread's header for the next send is the intent Node recorded (`pendingCacheBreakIntent`), and the pass asked for the
    /// summaries Node's did.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_manual_compaction_parks_the_intent_node_recorded() {
        use mixdog_core_ports::ports::threads::ThreadState;
        use mixdog_core_session::session::turn_ops::ManualCompaction;

        let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/cache-break/golden.json")).unwrap();
        let scenario = golden["compactions"].as_array().unwrap().iter().find(|s| s["name"] == "manual").expect("the manual scenario");
        let turns: Vec<&Value> = scenario["steps"].as_array().unwrap().iter().filter(|s| s["name"].as_str().unwrap().starts_with("turn")).collect();
        let script = turns
            .iter()
            .map(|turn| vec![StreamEvent::TextDelta(turn["answer"].as_str().unwrap().into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }])
            .collect::<VecDeque<_>>();
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(script),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let World { workspace, rig, directory, .. } = turn_world(provider.clone()).await;
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.path() }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let session = scenario["header"].as_object().unwrap();
        handle
            .request(CoreRequest {
                method: Method("thread/header/patch"),
                params: json!({ "threadId": id, "set": { "provider": "scripted", "model": "m", "compaction": session["compaction"], "providerCacheOpts": session["providerCacheOpts"], "contextWindow": session["contextWindow"], "rawContextWindow": session["rawContextWindow"], "effectiveContextWindowPercent": session["effectiveContextWindowPercent"] } }),
                op: None,
                ctx: CallContext::internal("test"),
            })
            .await
            .expect("route");
        let stored_roles = || -> usize {
            rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"].is_string()))).count()
        };
        for (n, turn) in turns.iter().enumerate() {
            let op = format!("op-{n}");
            let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": turn["prompt"] } }), &op)).await.expect("turn/start");
            let Reply::Value(started) = started else { panic!("turn/start answers a value") };
            assert_eq!(started["kind"], "started");
            eventually_on_awaiting(|| format!("turn {n}'s two rows stored and the thread idle"), &[&rig.store.committed, handle.stepped()], || (stored_roles() >= 2 * (n + 1) && !handle.turn_busy()).then_some(())).await;
        }

        let window = scenario["contextWindow"].as_u64().unwrap();
        let calibration = scenario["tokenCalibration"].as_f64().unwrap();
        let settings = mixdog_agent::boundary::CompactSettings { auto: true, context_window: Some(window), token_calibration: calibration, ..Default::default() };
        let threads: Arc<dyn ThreadState> = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
        let host = Arc::new(ManualHost {
            sender: Arc::new(ManualSummary { text: scenario["summaryText"].as_str().unwrap().into(), calls: Default::default() }),
            route: super::super::summary_routes::SessionRoute { provider: scenario["provider"].as_str().unwrap().into(), model: scenario["model"].as_str().unwrap().into(), context_window: Some(window), summary_model: None },
            calibration,
        });
        let tokens = mixdog_rt::testing::tokens();
        let late = Arc::new(super::super::compose_parts::LateDirectory::default());
        late.bind(&directory);
        let manual = super::super::manual_compaction::HostManualCompaction::new(super::super::manual_compaction::ManualParts {
            world: Arc::new(ManualWorld { threads: threads.clone(), window }),
            threads: threads.clone(),
            config: Arc::new(ManualConfig(settings)),
            compactors: Arc::new(super::super::compactors::SessionCompactors::new(Arc::new(ManualCompactionWorld(host.clone())), Arc::new(Fixed))),
            directory: late,
            hooks: Arc::new(ManualNoHooks),
            gauge: Arc::new(ManualGauge),
            clock: Arc::new(Fixed),
            recover: Arc::new(|_| {}),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            data_dir: workspace.path().join("data"),
            blobs: Arc::new(NoBlobs),
            reuses: Arc::default(),
        });
        let answer = manual.compact(&id, "manual", false, &mixdog_agent::cancel::Cancel::default()).await.expect("the compaction").expect("a compaction answer");
        assert_eq!(answer["changed"], true, "{answer}");
        assert_eq!(host.sender.calls.load(std::sync::atomic::Ordering::SeqCst) as u64, scenario["compaction"]["summaryRequests"].as_u64().unwrap(), "the summary requests of the pass");
        let header = threads.header(&id).await.expect("the header");
        assert_eq!(header.get("pendingCacheBreakIntent").cloned().unwrap_or(Value::Null), scenario["compaction"]["pending"], "the intent the core parks for the next send");
    }
    /// Node's tool calls once the session's cwd moved out of a plugin's project scope and back (`fixtures/mcp-cwd-scope`):
    /// one turn per recorded session, started in project A, each step a model's call dispatched through the real turn path
    /// after the cwd moved. The snapshot the turn start took, each call's result as the model got it back, the calls that
    /// reached the server and the snapshot after each call are the recorded ones, on a native session, a bridge one, one
    /// with no deferred provider mode, a sub-agent's (`owner: agent`, judged on the agent surface) and a bridge session's
    /// `call_tool` wire calls (projected onto their targets). The native case is replayed once more with its turn started
    /// by a paired phone (a `turn/start` from a relay connection, the only way a phone reaches a tool).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_models_mcp_call_after_the_cwd_left_its_plugins_scope_gets_nodes_result() {
        use mixdog_core_api::domain::provider::{Content, ContentPart};
        let mut checked = 0;
        let text = mixdog_testkit::fixture!("../../fixtures/mcp-cwd-scope/golden.json");
        let runs = [(0, mixdog_protocol::Origin::Local), (1, mixdog_protocol::Origin::Local), (2, mixdog_protocol::Origin::Local), (3, mixdog_protocol::Origin::Local), (4, mixdog_protocol::Origin::Local), (0, mixdog_protocol::Origin::Relay)];
        for (case_index, origin) in runs {
            let sandbox = tempfile::tempdir().unwrap();
            for project in ["project-a", "project-b"] {
                std::fs::create_dir_all(sandbox.path().join(project)).unwrap();
            }
            let escaped = serde_json::to_string(&sandbox.path().to_string_lossy()).unwrap();
            let rec = mixdog_js::fixture_tools::parse_golden(&text.replace("<SANDBOX>", &escaped[1..escaped.len() - 1])).expect("mcp cwd scope golden");
            let case = &rec["cases"][case_index];
            let label = &format!("{} ({origin:?})", case["name"].as_str().unwrap());
            let steps = case["steps"].as_array().unwrap();
            // The recorded registry as real servers: one process per server, listing the recorded tools and answering
            // `ran <server> <tool>`, each call appended to the server's reach log. The hub connects them in one scope and
            // hands the session its tools; what reached a server is read from its log.
            let tokens = mixdog_rt::testing::tokens();
            let hub = mixdog_mcp::McpHub::new(
                mixdog_mcp::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk },
                sandbox.path().join("artifacts"),
                mixdog_mcp::result::OutputPolicy::default(),
            );
            let mut configs = Vec::new();
            // One log for every server: the order of the calls across servers is the order they reached them in.
            let reach = sandbox.path().join("reach.log");
            for entry in rec["registry"].as_array().unwrap() {
                let server = entry["server"].as_str().unwrap();
                let tools: Vec<&str> = entry["tools"].as_array().unwrap().iter().map(|doc| doc["name"].as_str().unwrap()).collect();
                let launch = mixdog_testkit::mcp_server::launch("run_host::factory::tests::scripted_server", server, &tools, &reach);
                let mut raw = json!({ "command": launch.command, "args": launch.args, "env": launch.env });
                if let Some(plugin) = entry["pluginId"].as_str() {
                    raw["_mixdogPlugin"] = json!({ "id": plugin, "key": server.strip_prefix(&format!("plugin-{plugin}-")).unwrap_or(server) });
                }
                configs.push(mixdog_mcp::McpServerConfig::from_entry(server, &raw, &std::env::vars().collect()).unwrap());
            }
            hub.apply_in("scope-test", configs);
            for entry in rec["registry"].as_array().unwrap() {
                let name = entry["server"].as_str().unwrap();
                let mut state = hub.server_in("scope-test", name).unwrap().subscribe();
                let ready = mixdog_rt::time::timeout(Duration::from_secs(60), state.wait_for(|s| matches!(&**s, mixdog_mcp::server::ServerState::Ready(_)))).await;
                assert!(ready.is_ok(), "{label}: timed out after 60 s waiting for the server {name} to be ready");
            }
            let reached = Arc::new(ReachLogs { log: reach, seen: Mutex::new(0) });
            let connected: Vec<Arc<dyn Tool>> = hub.tools_in("scope-test");
            let mcp = Arc::new(ScopedServers { scopes: mixdog_mcp::scopes::ExtensionScopes::from_config(&rec["extensionScopes"]), hub: hub.clone(), scope: "scope-test" });
            let done = |stop| StreamEvent::Completed { stop: Some(stop), pricing_model: None, request_ms: None };
            let mut script: VecDeque<Vec<StreamEvent>> = steps
                .iter()
                .enumerate()
                .map(|(n, step)| {
                    // A recorded wire call (`call_tool`) is what the model sent; otherwise the target itself.
                    let (name, arguments) = match step.get("wire") {
                        Some(wire) => (wire["name"].as_str().unwrap().to_owned(), wire["arguments"].clone()),
                        None => (step["call"].as_str().unwrap().to_owned(), step["arguments"].clone()),
                    };
                    let call = ToolCall { id: format!("c{n}"), name, arguments, native_type: None };
                    vec![StreamEvent::ToolCallDone(call), done(StopReason::ToolUse)]
                })
                .collect();
            script.push_back(vec![StreamEvent::TextDelta("ok".into()), done(StopReason::EndTurn)]);
            // The recorded session's own provider serves the turn, so its exposure (native, bridge) stays the recorded one.
            let provider = Arc::new(MovingCwd {
                inner: Scripted {
                    id: ProviderId::from(case["before"]["provider"].as_str().unwrap()),
                    policy: RetryPolicy::codex_default(),
                    keepalive: KeepaliveSchedule::SPEC,
                    codec: MockCodec,
                    script: Mutex::new(script),
                    requests: Mutex::new(Vec::new()),
                    fail_first: std::sync::atomic::AtomicBool::new(false),
                },
                cwds: steps.iter().map(|step| step["cwd"].clone()).collect(),
                thread: std::sync::OnceLock::new(),
                reached: reached.clone(),
                observed: Mutex::new(Vec::new()),
            });
            let world = turn_world_with(provider.clone(), mcp, connected, true).await;
            let mut header = super::super::surface_host::tests::header_of(&case["before"]);
            for key in ["id", "updatedAt"] {
                header.shift_remove(key);
            }
            header.insert("cwd".into(), case["turnStart"]["cwd"].clone());
            let (id, handle) = started_thread(&world, Value::Object(header)).await;
            assert!(provider.thread.set((id.clone(), handle.clone())).is_ok());
            let mut start = request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1");
            start.ctx = CallContext::connection(ConnectionId(1), origin, mixdog_rt::CancellationToken::new());
            let started = handle.request(start).await.expect("turn/start");
            let Reply::Value(started) = started else { panic!("turn/start answers a value") };
            assert_eq!(started["kind"], "started", "{label}");
            eventually_on_awaiting(
                || format!("{label}: the turn's {} requests and an idle actor", steps.len() + 1),
                &[&world.rig.store.committed, handle.stepped()],
                || (lock(&provider.inner.requests).len() > steps.len() && !handle.turn_busy()).then_some(()),
            )
            .await;
            let requests = lock(&provider.inner.requests).clone();
            assert_eq!(requests.len(), steps.len() + 1, "{label}: one request per call and the closing one");
            let first = &requests[0];
            assert!(first.messages.iter().all(|message| message.role != Role::Tool), "{label}: the first request carries no call result");
            let results: Vec<String> = requests
                .last()
                .unwrap()
                .messages
                .iter()
                .filter(|message| message.role == Role::Tool)
                .map(|message| match &message.content {
                    Content::Text(text) => text.clone(),
                    Content::Parts(parts) => parts.iter().filter_map(|part| match part { ContentPart::Text(text, _) => Some(text.as_str()), _ => None }).collect(),
                })
                .collect();
            let observed = lock(&provider.observed).clone();
            assert_eq!(results.len(), steps.len(), "{label}: every call's result");
            assert_eq!(observed[0], (json!([]), case["turnStart"]["mcpNames"].clone()), "{label}: the turn start's snapshot");
            assert_eq!(observed.len(), steps.len() + 1, "{label}: every call observed");
            for (n, step) in steps.iter().enumerate() {
                assert_eq!(results[n], step["result"].as_str().unwrap(), "{label} step {n}: what the model got back");
                assert_eq!(observed[n + 1].0, step["ran"], "{label} step {n}: the calls that reached the server");
                assert_eq!(observed[n + 1].1, step["mcpNames"], "{label} step {n}: the session's MCP snapshot");
                checked += 1;
            }
            let recorded: Vec<Value> = steps.iter().flat_map(|step| step["ran"].as_array().unwrap().clone()).collect();
            assert_eq!(mixdog_testkit::mcp_server::reached(&provider.reached.log), recorded, "{label}: every call that reached a server, in the order Node's servers received them");
            hub.close_all().await;
        }
        assert_eq!(checked, 24);
    }
    /// Node's `nextMainRequest` over the cases `snapshot_effects/record.mjs` recorded (no user conversation, a transcript,
    /// each again after a new ignored directory and after the skill catalog was invalidated): it is null without a user
    /// conversation, otherwise the stored transcript as it is (its iteration 1), and it writes, lists and probes nothing.
    /// The core's snapshot request for a thread without a conversation and for one whose transcript is the recorded one
    /// (a turn `hi` answered `ok`): null where Node's is, the same conversation messages where Node has them, and the
    /// thread's stored state untouched by the call. The core's snapshot path holds no prompt composition, probe or skill
    /// catalog to touch (`HostRunParts::snapshot_request` builds from the header and the rows).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn the_snapshot_answers_where_nodes_next_main_request_answers() {
        let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
        let set = repo_root.join("native/core/fixtures/request-snapshot-effects");
        tests_manifest::verify_dir(&repo_root, &set, "native/core/crates/mixdog-core/src/run_host/snapshot_effects/record.mjs");
        let node: Value = serde_json::from_slice(&std::fs::read(set.join("node-recorded.json")).unwrap()).unwrap();
        let (provider, mut heard) = handing();
        let world = turn_world(provider.clone()).await;
        let (empty, empty_handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let (talked, talked_handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let covered_before = talked_handle.header_snapshot().get("turnCoverage").cloned();
        let started = talked_handle.request(request("turn/start", json!({ "threadId": talked, "opId": "op-1", "input": { "prompt": "hi" } }), "op-1")).await.expect("turn/start");
        assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
        mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv()).await.unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the turn's request")).expect("the provider is alive");
        settled_turns(&world, &talked, &talked_handle, 1, covered_before).await;
        let (directory, parts) = world.next.bound().expect("bound");
        let directory = directory.upgrade().expect("directory");
        for case in node["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert_eq!((case["fsCalls"].clone(), case["gitRequested"].clone()), (json!([]), json!([])), "{name}: Node's call did something");
            let (id, handle) = if case["request"].is_null() { (&empty, &empty_handle) } else { (&talked, &talked_handle) };
            let before = stored_state(&world, id, handle);
            let status = snapshot_call(&tools_status(&world), id, "").await;
            assert_eq!(stored_state(&world, id, handle), before, "{name}: the snapshot call wrote to the stored thread");
            let prior = directory.model_context(id).read().await.expect("rows");
            let built = parts.snapshot_request(id, &handle.live_header().header(), &handle.surface().borrow().clone(), (prior, 0), None).await;
            match (&case["request"], built) {
                (Value::Null, None) => assert_eq!(status["requestSnapshot"], Value::Null, "{name}"),
                (request, Some((_, built))) if !request.is_null() => {
                    let conversation = |messages: Vec<(String, String)>| messages.into_iter().filter(|(role, _)| role != "system").collect::<Vec<_>>();
                    let nodes = request["messages"].as_array().unwrap().iter().map(|m| (m["role"].as_str().unwrap().to_owned(), m["content"].as_str().unwrap().to_owned())).collect();
                    let text = |content: &mixdog_core_api::domain::provider::Content| match content {
                        mixdog_core_api::domain::provider::Content::Text(text) => text.clone(),
                        mixdog_core_api::domain::provider::Content::Parts(parts) => parts
                            .iter()
                            .filter_map(|part| match part {
                                mixdog_core_api::domain::provider::ContentPart::Text(text, _) => Some(text.as_str()),
                                _ => None,
                            })
                            .collect(),
                    };
                    let cores = built.messages.iter().map(|m| (format!("{:?}", m.role).to_lowercase(), text(&m.content))).collect();
                    assert_eq!(conversation(cores), conversation(nodes), "{name}: the conversation of the request");
                    assert_eq!(request["iteration"], json!(built.options.iteration), "{name}: the iteration");
                    assert!(status["requestSnapshot"].is_object(), "{name}");
                }
                (request, built) => panic!("{name}: Node {request}, the core {:?}", built.map(|(_, r)| r.messages.len())),
            }
        }
    }
    /// Each recorded case (`fixtures/applied-skills`, `record-applied-skills.mjs`: Node's real `askSession` over SKILL.md files)
    /// as a real turn over the same files: the session actor starts it, the loop selects the prompt's skills from the skill
    /// catalog and loads them through the real `Skill` tool, a prompt queued into the running turn is prepared at its drain, a
    /// fork is the directory's `thread/fork`. Compared whole with Node's: every user row the thread stores (live and after the
    /// thread is opened again over the same store), every user row the transcript restores from them, and the chips each
    /// user line shows. The compaction case is Node's compacted rows carried through the conversion a compaction writes
    /// them back with (`message_of` -> `row_of`) and restored.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[cfg(node_twin)]
    async fn a_prompts_loaded_skills_are_its_rows_chips_as_node_stores_and_restores_them() {
        let golden_text: &str = mixdog_testkit::fixture!("../../fixtures/applied-skills/golden.json");
        let count = serde_json::from_str::<Value>(golden_text).expect("golden")["cases"].as_array().expect("cases").len();
        let mut compared = 0;
        for index in 0..count {
            let sandbox = tempfile::tempdir().unwrap();
            let data = sandbox.path().join("mixdog_data_dir");
            let escaped = serde_json::to_string(&sandbox.path().to_string_lossy().replace('\\', "/")).unwrap();
            let golden: Value = serde_json::from_str(&golden_text.replace("<SANDBOX>", &escaped[1..escaped.len() - 1])).expect("golden");
            let case = &golden["cases"][index];
            let label = case["name"].as_str().expect("name");
            let want_rows = case["userRows"].as_array().expect("userRows");
            let want_restored = case["restoredUserRows"].as_array().expect("restoredUserRows");
            let chips_of = |rows: &[Value]| rows.iter().map(|row| row.get("appliedSkills").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>();
            if case.get("compaction").is_some() {
                let carried: Vec<Value> = want_rows.iter().map(|row| super::super::message_row::row_of(&super::super::message_row::message_of(row).expect("a stored row"))).collect();
                assert_rows(&carried, want_rows, &format!("{label}: the compacted rows written back"));
                assert_rows(&restored_user_rows(&carried), want_restored, &format!("{label}: the restored rows"));
                compared += 1;
                continue;
            }
            for name in golden["skills"].as_array().expect("skills") {
                let name = name.as_str().expect("name");
                std::fs::create_dir_all(data.join("skills").join(name)).unwrap();
                std::fs::write(data.join("skills").join(name).join("SKILL.md"), format!("---\nname: {name}\ndescription: Exercise persisted skill selection.\n---\n# {name}\nFollow it.\n")).unwrap();
            }
            let (catalog, watch, skill_parts) = real_skills(&data);
            // A skill removed after the listing was read: the skills watcher reports the removal (as Node's root watcher did
            // before its turn), so the next listing no longer names it and its mention stays prose.
            if let Some(removed) = case["removed"].as_array() {
                use mixdog_mcp::skill_select::SkillNames as _;
                catalog.names(sandbox.path()).await.expect("the listing");
                for name in removed {
                    std::fs::remove_file(data.join("skills").join(name.as_str().expect("name")).join("SKILL.md")).unwrap();
                }
                mixdog_workspace::watcher::ChangeSink::changed(&*watch.sink(), "mcp.skills:root", Vec::new(), mixdog_workspace::watcher::ChangeKind::Removed);
            }
            let queued = case["queued"].as_str();
            let (started, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
            let script = if queued.is_some() {
                vec![
                    vec![
                        StreamEvent::ToolCallDone(ToolCall { id: "h1".into(), name: "hold".into(), arguments: json!({}), native_type: None }),
                        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                    ],
                    // The host's queue hands the queued prompt over after the tool batch: the one reply answers it.
                    says("Done."),
                ]
            } else {
                vec![says("Done.")]
            };
            let provider = Arc::new(Scripted {
                id: ProviderId::from("scripted"),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(script.into()),
                requests: Mutex::new(Vec::new()),
                fail_first: std::sync::atomic::AtomicBool::new(false),
            });
            let workspace = tempfile::tempdir().unwrap();
            let hold: Arc<dyn Tool> = Arc::new(Hold { spec: named_spec("hold"), started: started.clone(), release: release.clone() });
            let late = Arc::new(std::sync::OnceLock::new());
            let factory = |more: Vec<Arc<dyn Tool>>| {
                let parts = Skilled { inner: Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more, settle: None, effort: None }, skills: skill_parts.clone(), directory: late.clone() };
                Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(parts)))
            };
            let rig = Rig::new();
            // The product's projection of the stored rows, which shows a row's chips.
            let projection = || Arc::new(mixdog_core_session::session::transcript::RecordTranscript::new());
            let mut deps = rig.deps_parts(rig.store.clone());
            deps.runs = factory(vec![hold]);
            deps.transcript = projection();
            let directory = Arc::new(SessionDirectory::new(Arc::new(deps)));
            late.set(Arc::downgrade(&directory)).expect("bound once");
            let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
            let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
            let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
            let handle = directory.handle(&id).expect("loaded");
            handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": case["prompt"] } }), "op-1")).await.expect("turn/start");
            if let Some(queued) = queued {
                mixdog_core_session::session::testing::awaiting(|| format!("{label}: the held tool to start"), started.notified()).await;
                // The core takes a prompt for a thread whose turn runs through the host's queue (`turn/start`; a send to a busy worker,
                // `enqueue_turn`): Node's manager queue holds only notifications for the core's producers, which `queue_completion`
                // carries. The drain hands over durable entries only: the tool is let go once the queued entry is in the store.
                // (From no client connection: Node's queued entry carries no device, which a connection's prompt is stamped with.)
                let typed = CoreRequest { method: Method("turn/start"), params: json!({ "threadId": id, "opId": "op-2", "input": { "prompt": queued } }), op: Some(OpId::from("op-2")), ctx: CallContext::internal("queued-prompt") };
                handle.request(typed).await.expect("the queued prompt");
                let durable = || rig.store.records(&id).iter().any(|(_, record)| matches!(record, Record::Queue(_)));
                eventually_on_awaiting(|| format!("{label}: the queued entry in the store"), &[&rig.store.committed, handle.stepped()], || durable().then_some(())).await;
                release.notify_one();
            }
            let chips = |lines: Vec<(String, Value)>| lines.into_iter().map(|(_, chips)| chips).collect::<Vec<_>>();
            // The skills are prepared (and stamped) before the request the reply answers.
            let replied = || {
                rig.store
                    .records(&id)
                    .into_iter()
                    .filter(|(_, record)| match record {
                        Record::Item(item) => matches!(item.body, Slot::Inline(ref body) if body["role"] == "assistant" && body["content"] == "Done."),
                        _ => false,
                    })
                    .count()
                    == 1
            };
            eventually_on_awaiting(|| format!("{label}: the turn's reply in the store"), &[handle.stepped()], || replied().then_some(())).await;
            // A turn without its terminal record is one the process died in, which opening a thread again recovers (a restart line
            // is stored): the turn has ended in the store before the thread is opened again.
            let ended = || {
                let runs = rig.store.records(&id).into_iter().filter_map(|(_, record)| if let Record::Run(run) = record { Some(run.phase) } else { None });
                let (mut started, mut ended) = (0, 0);
                for phase in runs {
                    match phase {
                        mixdog_store::schema::record::RunPhase::Started => started += 1,
                        mixdog_store::schema::record::RunPhase::Attempt => {}
                        _ => ended += 1,
                    }
                }
                started == ended
            };
            eventually_on_awaiting(|| format!("{label}: the turn's end in the store"), &[&rig.store.committed, handle.stepped()], || ended().then_some(())).await;
            // A fork: the directory's `thread/fork` carries the conversation into a new thread, which is what is compared.
            let (id, handle) = if case["name"] == "a fork" {
                let Reply::Value(forked) = directory.request(request("thread/fork", json!({ "threadId": id, "opId": "op-fork" }), "op-fork")).await.expect("thread/fork") else {
                    panic!("thread/fork answers a value")
                };
                let heir = ThreadId::from(forked["thread"]["id"].as_str().expect("the heir"));
                let handle = directory.handle(&heir).expect("the heir is loaded");
                (heir, handle)
            } else {
                (id, handle)
            };
            let rows = stored_user_rows(&*handle, &id).await;
            assert_rows(&rows, want_rows, &format!("{label}: the stored user rows"));
            assert_rows(&restored_user_rows(&rows), want_restored, &format!("{label}: the restored user rows"));
            assert_eq!(chips(user_lines(&*handle, &id).await), chips_of(want_restored.as_slice()), "{label}: the live lines");
            let applied: Vec<Value> = rows.iter().filter_map(|row| row.pointer("/meta/transcript/appliedSkills")).flat_map(|names| names.as_array().cloned().unwrap_or_default()).collect();
            assert_eq!(Value::Array(applied), case["applied"], "{label}: the skills the turn applied");
            // The thread opened again over the same store reads the stamps back from the stored rows.
            let mut reopened = rig.deps_parts(rig.store.clone());
            reopened.runs = factory(Vec::new());
            reopened.transcript = projection();
            let again = SessionDirectory::new(Arc::new(reopened));
            let handle = again.open_handle(&id, &CallContext::internal("test")).await.expect("reopened");
            assert_rows(&stored_user_rows(&*handle, &id).await, want_rows, &format!("{label}: the stored user rows, reopened"));
            assert_eq!(chips(user_lines(&*handle, &id).await), chips_of(want_restored.as_slice()), "{label}: the restored lines");
            compared += 1;
        }
        assert_eq!(compared, count);
    }

    /// Text, a tool block, more text in one response (`turn-stream.mjs` `closeAssistantSegment`): the text before the block is
    /// final when the block starts and the text after it streams under a new item; the committed reply takes both rows' places,
    /// one row each, in the order shown (text, card, text), and a reopened thread shows the same rows. Repeated tool progress and
    /// an empty delta open no segment of their own.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_text_around_a_tool_block_is_two_segments_live_and_on_reload() {
        use mixdog_core_api::domain::provider::{ItemKind, ProgressKind};
        let scripted = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ItemStart { kind: ItemKind::Text, phase: None },
                    StreamEvent::TextDelta("before".into()),
                    StreamEvent::ItemStart { kind: ItemKind::Tool, phase: None },
                    StreamEvent::Progress(ProgressKind::Tool),
                    StreamEvent::Progress(ProgressKind::Tool),
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "a": 1 }), native_type: None }),
                    StreamEvent::TextDelta(String::new()),
                    StreamEvent::ItemStart { kind: ItemKind::Text, phase: None },
                    StreamEvent::TextDelta("after".into()),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let rig = Rig::new();
        let workspace = tempfile::tempdir().unwrap();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.transcript = Arc::new(mixdog_core_session::session::testing::RecordTranscript::new());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: scripted.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the turn's end".to_owned(), &[handle.stepped()], || {
            rig.feeds.frames(id.as_str()).iter().any(|(_, method, params)| method == "item/agentMessage/delta" && params["delta"] == "all done").then_some(())
        })
        .await;
        eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;

        let frames = rig.feeds.frames(id.as_str());
        let delta_item = |text: &str| {
            frames.iter().find(|(_, method, params)| method == "item/agentMessage/delta" && params["delta"] == text).map(|(_, _, params)| params["itemId"].as_str().unwrap_or_default().to_owned()).expect("the delta")
        };
        let (before, after) = (delta_item("before"), delta_item("after"));
        assert_ne!(before, after, "the text after the tool block is an item of its own");
        let position = |found: &dyn Fn(&str, &Value) -> bool| frames.iter().position(|(_, method, params)| found(method, params)).expect("the frame");
        let before_final = position(&|method, params| method == "item/completed" && params["item"]["id"] == before.as_str() && params["item"]["text"] == "before");
        let after_starts = position(&|method, params| method == "item/agentMessage/delta" && params["delta"] == "after");
        assert!(before_final < after_starts, "the text before the block is final before the text after it streams");
        let started: Vec<&Value> = frames.iter().filter(|(_, method, params)| method == "item/started" && params["item"]["type"] == "agentMessage").map(|(_, _, params)| &params["item"]["id"]).collect();
        assert_eq!(started.len(), 3, "one item per segment and the answer, none for an empty delta: {started:?}");

        let rows = |items: &[Arc<ThreadItem>]| -> Vec<(String, String)> {
            items
                .iter()
                .filter_map(|item| match item.as_ref() {
                    ThreadItem::AgentMessage { id, text: MaybeBlob::Inline(text), .. } => Some((id.as_str().to_owned(), text.clone())),
                    ThreadItem::ToolCall { run, .. } => Some(("card".to_owned(), run.call_id.clone().unwrap_or_default())),
                    _ => None,
                })
                .collect()
        };
        let live = rows(&handle.view_items());
        let expected = vec![(before.clone(), "before".to_owned()), ("card".to_owned(), "c1".to_owned()), (after.clone(), "after".to_owned())];
        assert_eq!(live[..3], expected[..], "the committed reply's rows, where they were shown: {live:?}");
        directory.shutdown().await;

        let mut deps = rig.deps_parts(rig.store.clone());
        deps.transcript = Arc::new(mixdog_core_session::session::testing::RecordTranscript::new());
        let reopened = SessionDirectory::new(Arc::new(deps));
        let handle = reopened.open_handle(&id, &CallContext::internal("test")).await.expect("reopen");
        eventually_on_awaiting(|| "the reopen".to_owned(), &[handle.stepped()], || handle.recovered().then_some(())).await;
        let restored = rows(&handle.view_items());
        assert_eq!(restored[..3], expected[..], "the reopened rows are the rows shown, no text lost or repeated: {restored:?}");
        reopened.shutdown().await;
    }
    /// A Stop that hands the prompt back while the turn is still setting up (`abort.mjs` `reclaimInFlightPrompt`, with the
    /// runtime's abort ending the turn as stopped): the step that was waiting on a save when the token fired (the first
    /// turn's title, "the session's title could not be saved") does not fail the turn. It ends interrupted, its prompt's
    /// row is rewound, and no model was asked.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_before_the_model_is_asked_ends_the_turn_stopped_and_takes_the_prompt_back() {
        use mixdog_store::schema::record::RunPhase;
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::new()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let hooks = Arc::new(HeldPrompt { reached: tokio::sync::Notify::new() });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.lifecycle = hooks.clone();
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let records = || rig.store.records(&id);
        let ended = || {
            records()
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Run(run) if matches!(run.phase, RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted) => Some(format!("{:?}", run.phase)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };

        handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "give it back", "options": { "clientSubmissionId": "sub-1" } } }), "op-1"))
            .await
            .expect("turn/start");
        mixdog_core_session::session::testing::awaiting(|| "the turn to reach its UserPromptSubmit hook".to_owned(), hooks.reached.notified()).await;
        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
        let stopped = handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(true), submission_id: Some("sub-1".to_owned()), ctx }).await.expect("stop");
        assert_eq!(stopped["restoreText"], json!("give it back"), "the stop hands the prompt back: {stopped}");
        eventually_on_awaiting(|| "the stopped turn's end record".to_owned(), &[handle.stepped()], || (!ended().is_empty()).then_some(())).await;
        assert_eq!(ended(), ["Interrupted"], "a stop during the setup is a stopped turn, not a failed one");
        assert!(records().iter().any(|(_, record)| matches!(record, Record::Rewind(_))), "the handed-back prompt's row is rewound");
        assert!(lock(&provider.requests).is_empty(), "no model was asked");
        let stored = format!("{:?}", records());
        assert!(!stored.contains("could not be saved"), "no setup step's failure is recorded: {stored}");
    }
    /// A tool's progress reaches the thread's clients: the run's sink writes the cell's progress,
    /// the hint is published as the runtime section while the tool runs, and it is withdrawn when
    /// the turn moves on.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_running_tools_output_is_published_to_the_threads_clients_and_withdrawn_after() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "report".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let (reported, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let reporter = Reporter {
            spec: ToolSpec {
                name: "report".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "report".into(),
                input_schema: json!({ "type": "object" }),
                annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            },
            reported: reported.clone(),
            release: release.clone(),
        };
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: vec![Arc::new(reporter)], settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1"))
            .await
            .expect("turn/start");

        let hints = || -> Vec<Value> {
            rig.feeds
                .frames(id.as_str())
                .into_iter()
                .filter(|(_, method, _)| method == "thread/runtime/updated")
                .map(|(_, _, params)| params["value"]["progressHint"].clone())
                .collect()
        };
        mixdog_core_session::session::testing::awaiting(|| "the report tool to be called".to_owned(), reported.notified()).await;
        eventually_on_awaiting(|| "the tool-output hint with outputTail \"compiling\" published to the thread's clients".to_owned(), &[&rig.feeds.published], || hints().contains(&json!({ "outputTail": "compiling" })).then_some(())).await;
        release.notify_one();
        eventually_on_awaiting(|| "the tool-output hint withdrawn (a null hint published last) after the tool ends".to_owned(), &[&rig.feeds.published], || (hints().last() == Some(&Value::Null)).then_some(())).await;
    }

    /// One real turn: the session actor starts it, the factory builds the run, the loop asks the
    /// scripted provider, the tool runs behind the review gate, and the rows settle in the store.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_runs_from_the_factory_through_the_loop_and_a_tool_to_settle() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::TextDelta("looking".into()),
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "a": 1 }), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let started = handle
            .request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1"))
            .await
            .expect("turn/start");
        let Reply::Value(started) = started else { panic!("turn/start answers a value") };
        assert_eq!(started["kind"], "started");

        let roles = || -> Vec<(String, Value)> {
            rig.store
                .records(&id)
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Item(item) => match item.body {
                        Slot::Inline(body) => Some((body["role"].as_str().unwrap_or_default().to_owned(), body)),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        };
        // Woken by each step of the thread's actor, which acknowledges each row after the store holds it.
        eventually_on_awaiting(|| "the four-role transcript (user, assistant, tool, assistant) in the store".to_owned(), &[handle.stepped()], || (roles().len() >= 4).then_some(())).await;
        let rows = roles();
        assert_eq!(rows.iter().map(|(role, _)| role.as_str()).collect::<Vec<_>>(), ["user", "assistant", "tool", "assistant"]);
        assert_eq!(rows[1].1["content"], "looking");
        assert_eq!(rows[1].1["toolCalls"][0]["name"], "echo");
        assert_eq!(rows[2].1["toolCallId"], "c1");
        assert_eq!(rows[2].1["content"], "echo:{\"a\":1}");
        assert_eq!(rows[3].1["content"], "all done");
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2);
        let second: Vec<_> = requests[1].messages.iter().map(|m| m.role).collect();
        assert_eq!(second, [Role::User, Role::Assistant, Role::Tool]);
        let _ = AtomicI64::new(0);
    }
    /// The show rule end to end, through the run's own sink (`PortSink`) and the actor: from its first request on the disk
    /// takes no write, and still the response's text, its call's card, the tool's start and the tool's result reach the
    /// thread's feed, in the order the loop produced them (Node's `onTextDelta`, `onToolCall`, `onToolPhaseStarted`,
    /// `onToolResult`), with none of their rows stored. The next request, which the answer after the tool comes from, waits
    /// for the tool's row (`crash-tool-wire`); once the disk takes the writes the turn ends with every row, in order.
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn a_held_disk_holds_back_nothing_the_turn_shows() {
        let scripted = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::TextDelta("looking".into()),
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({ "a": 1 }), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let rig = Rig::new();
        // From the first request on, the log takes no write until `go`. The run's draft (the crash checkpoint, written apart
        // from the log) is not held: its write runs on the actor's own thread under the test backend's inline lanes, so a
        // held draft would stop the session itself, which no slow disk does.
        let (arrived, (go, held)) = (Arc::new(tokio::sync::Notify::new()), std::sync::mpsc::channel::<()>());
        let (gate, at_gate) = (rig.store.commit_gate.clone(), arrived.clone());
        let arm: Box<dyn FnOnce() + Send> = Box::new(move || {
            *lock(&gate) = Some((at_gate, held));
        });
        let provider = Arc::new(ArmedOnSend { inner: scripted.clone(), arm: Mutex::new(Some(arm)) });
        let workspace = tempfile::tempdir().unwrap();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        let roles = || -> Vec<String> {
            rig.store
                .records(&id)
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Item(item) => match item.body {
                        Slot::Inline(body) => Some(body["role"].as_str().unwrap_or_default().to_owned()),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        };
        // What the feed showed of the turn, each once, in the order it first showed it.
        let shown = || -> Vec<&'static str> {
            let mut out = Vec::new();
            for (_, method, params) in rig.feeds.frames(id.as_str()) {
                let call = params["item"]["run"]["callId"] == "c1";
                let name = match method.as_str() {
                    "item/agentMessage/delta" if params["delta"] == "looking" => "text",
                    "item/completed" if call && params["item"]["run"]["completedAt"].is_null() => "card",
                    "item/completed" if call => "result",
                    "thread/toolBatch/updated" if params["phase"] == "started" => "tool started",
                    "item/agentMessage/delta" if params["delta"] == "all done" => "answer",
                    _ => continue,
                };
                if !out.contains(&name) {
                    out.push(name);
                }
            }
            out
        };
        eventually_on_awaiting(|| format!("the tool's result shown with the disk held: {:?}", shown()), &[handle.stepped()], || shown().contains(&"result").then_some(())).await;
        assert_eq!(shown(), ["text", "card", "tool started", "result"], "shown as produced, the answer after the tool not yet");
        assert_eq!(roles(), ["user"], "none of the turn's rows is stored");
        assert_eq!(lock(&scripted.requests).len(), 1, "the next request waits for the tool's row");

        go.send(()).expect("the disk waits");
        eventually_on_awaiting(|| "the turn's rows in the store".to_owned(), &[handle.stepped()], || (roles().len() >= 4).then_some(())).await;
        assert_eq!(roles(), ["user", "assistant", "tool", "assistant"]);
        eventually_on_awaiting(|| "the answer shown".to_owned(), &[handle.stepped()], || shown().contains(&"answer").then_some(())).await;
        assert_eq!(shown(), ["text", "card", "tool started", "result", "answer"]);
        drop(arrived);
    }
    /// A turn whose response streams `looking` and calls `probe`, then answers `all done`; every report's media preparation is
    /// held (`TestCompaction::prepare_held`) from its first request on.
    struct HeldTurn {
        rig: Rig,
        _directory: SessionDirectory,
        _workspace: tempfile::TempDir,
        id: ThreadId,
        handle: Arc<mixdog_core_session::session::SessionHandle>,
        ran: Arc<std::sync::atomic::AtomicBool>,
        ran_now: Arc<tokio::sync::Notify>,
        /// How many preparations had started when the hold began.
        held_from: Arc<std::sync::atomic::AtomicUsize>,
    }
    /// A Stop while a report's preparation is held and the response's row waits for its place: the preparation and the
    /// forwarder end with the run's cancel, the row goes at once and is saved, the run's flush completes and the run ends.
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn a_stop_while_a_row_waits_for_its_place_saves_the_row_and_ends_the_run() {
        let turn = HeldTurn::start().await;
        turn.a_preparation_is_held().await;
        let ctx = CallContext::connection(ConnectionId(1), mixdog_protocol::Origin::Local, mixdog_rt::CancellationToken::new());
        turn.handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: Some(false), submission_id: None, ctx }).await.expect("stop");
        // The hold is never let go: nothing of the stopped run waits for it.
        eventually_on_awaiting(|| format!("the stopped run ended: {:?}", turn.stored()), &[turn.handle.stepped()], || (!turn.handle.turn_busy()).then_some(())).await;
        assert!(
            turn.stored().iter().any(|body| body["role"] == "assistant" && body["toolCalls"][0]["name"] == "probe"),
            "the row that waited for its place is saved: {:?}",
            turn.stored()
        );
        assert!(!turn.ran.load(std::sync::atomic::Ordering::SeqCst), "the stopped tool never started");
    }
    /// A turn's hooks (`turn-run.mjs` `runTurn`): `UserPromptSubmit` with the prompt as submitted, before the model is asked;
    /// the context it adds leads the prompt the model reads (`# Additional context` / `# Task`). A handler's block
    /// refuses the turn with Node's message before any request, that turn fires `StopFailure`, and the next turn's request does not carry the refused prompt.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_fires_its_prompt_and_stop_hooks_and_a_blocked_prompt_asks_no_model() {
        use mixdog_core_session::session::lifecycle_hooks::PromptVerdict;
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([done("ok"), done("later")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let hooks = Arc::new(TurnHooks::default());
        *lock(&hooks.verdict) = PromptVerdict { blocked: false, reason: None, context: vec!["remember X".to_owned(), " and Y\n".to_owned()] };
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.lifecycle = hooks.clone();
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let ended = || {
            rig.store
                .records(&id)
                .into_iter()
                .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
                .count()
        };
        let calls = || lock(&hooks.calls).clone();

        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the first turn's end record".to_owned(), &[handle.stepped()], || (ended() >= 1).then_some(())).await;
        assert_eq!(calls(), ["UserPromptSubmit:/ws:\"go\""]);
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 1);
        let asked = format!("{:?}", requests[0].messages.iter().find(|m| m.role == Role::User).expect("the prompt").content);
        // The debug form writes each line break as `\n`. The joined context is trimmed as one text, as Node trims it.
        assert!(asked.contains(r"# Additional context\nremember X\n\n and Y\n\n# Task\ngo"), "the context leads the prompt: {asked}");

        *lock(&hooks.verdict) = PromptVerdict { blocked: true, reason: Some("not now".to_owned()), context: vec!["never read".to_owned()] };
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
        eventually_on_awaiting(|| "the refused turn's end record and its StopFailure".to_owned(), &[handle.stepped()], || (ended() >= 2 && calls().len() >= 3).then_some(())).await;
        assert_eq!(calls()[1..], ["UserPromptSubmit:/ws:\"again\"", "StopFailure:unknown"]);
        assert_eq!(lock(&provider.requests).len(), 1, "a blocked prompt asks no model");
        let stored = format!("{:?}", rig.store.records(&id));
        assert!(stored.contains("prompt blocked by hook: not now"), "the turn failed with Node's message");

        *lock(&hooks.verdict) = PromptVerdict::default();
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-3", "input": { "prompt": "third" } }), "op-3")).await.expect("turn/start");
        eventually_on_awaiting(|| "the third turn's end record".to_owned(), &[handle.stepped()], || (ended() >= 3).then_some(())).await;
        let requests = lock(&provider.requests).clone();
        let roles: Vec<_> = requests[1].messages.iter().map(|m| m.role).collect();
        assert_eq!(roles, [Role::User, Role::Assistant, Role::User], "the refused prompt is not in the model history");
        // The refusal leaves the rows the provider last saw: no new lineage, so the kept prefix guard still holds
        // (Node's `session.messages` and guard are untouched by it). The first turn's context restart (its hook context joined
        // the prompt) names the lineage the refused turn opens on; none is named after the refused turn started.
        let mut started = 0;
        let mut epochs_after_refusal = 0;
        for (_, record) in rig.store.records(&id) {
            match record {
                Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Started) => started += 1,
                Record::Meta(meta) if started >= 2 && matches!(&meta.change, Slot::Inline(change) if change.set.contains_key("transcriptEpoch")) => epochs_after_refusal += 1,
                _ => {}
            }
        }
        assert_eq!(epochs_after_refusal, 0, "a refused prompt names no new transcript lineage");
    }
    /// The rewrite keeps one copy of the system prompt but retires the old provider continuation.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_automatic_compaction_sends_a_full_request_without_the_retired_continuation() {
        use mixdog_ai::providers::compat::{CompatConfig, CompatProfile};
        use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
        use mixdog_core_api::domain::keepalive::TransportKind;
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([done("ok"), done("later")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        let parts = Compacting {
            inner: Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None },
            compactor: Arc::new(CompactsOnce::default()),
            settings: mixdog_agent::boundary::CompactSettings { auto: true, context_window: Some(1_000), token_calibration: 1.0, ..Default::default() },
        };
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(parts)));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let continuation = json!({ "compatResponses": { "previousResponseId": "resp_retired", "store": true, "seenMessageCount": 1 } });
        let patch = json!({ "threadId": id, "set": { "promptBase": "rules", "providerState": continuation }, "unset": [] });
        handle.request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") }).await.expect("the system prompt and saved continuation");
        let ended = || {
            rig.store
                .records(&id)
                .into_iter()
                .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
                .count()
        };
        for (turns, (op, prompt)) in [("op-1", "go"), ("op-2", "again")].into_iter().enumerate() {
            handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("turn/start");
            eventually_on_awaiting(|| format!("the end record of turn {op}"), &[handle.stepped()], || (ended() > turns).then_some(())).await;
        }
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2, "each turn asked the model once");
        let codec = CompatResponsesCodec::new(CompatProfile::command_code_oauth(), CompatConfig::default(), TransportKind::Http1);
        let encode = |request: &ModelRequest| -> Value { serde_json::from_slice(&codec.encode(request).unwrap().body).unwrap() };
        let mut control = requests[0].as_ref().clone();
        control.options.provider_state = Some(serde_json::from_value(continuation).unwrap());
        assert_eq!(encode(&control)["previous_response_id"], "resp_retired", "the stale anchor would otherwise be accepted");
        let first = encode(&requests[0]);
        assert!(first["input"].to_string().contains("[summary]"), "the complete compacted transcript goes on the wire");
        assert!(first.get("previous_response_id").is_none(), "the live loop must not reuse the retired anchor");
        assert!(encode(&requests[1]).get("previous_response_id").is_none(), "a later turn must not reload the retired anchor");
        let system = |at: usize| requests[at].messages.iter().filter(|m| m.role == Role::System).count();
        assert!(format!("{:?}", requests[0].messages).contains("[summary]"), "the first turn's request is the compacted transcript");
        assert!(system(0) > 0, "the header's prompt leads the request");
        assert_eq!(system(1), system(0), "the next turn's request carries the system prompt once");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_large_scanned_pdf_goes_by_reference_before_send_even_with_auto_compaction_off() {
        use mixdog_agent::boundary::CompactSettings;
        use mixdog_agent::offload::{Artifact, ArtifactStore};
        use mixdog_core_api::domain::provider::ContentPart;
        use mixdog_store::blobs::{BlobStore, digest_of, hex};
        use super::super::assemble::CompactorInput;
        use super::super::attachment_store::StoreFiles;
        use super::super::compaction_world::{ProcessCompactionWorld, tests::services};
        use super::super::compactors::SessionCompactors;
        use super::super::host_seams::CompactorSource;
        use super::super::media::{AttachmentFacts, StoredFacts};

        struct ScannedPdf(String);
        #[async_trait]
        impl AttachmentFacts for ScannedPdf {
            async fn facts(&self, reference: &str) -> Option<StoredFacts> {
                (reference == self.0).then_some(StoredFacts { page_count: Some(90), text_pages: Some(0), text_chars: Some(0), ..Default::default() })
            }
        }
        struct NoArchive;
        #[async_trait]
        impl ArtifactStore for NoArchive {
            async fn persist(&self, _: &str) -> Option<Artifact> {
                None
            }
            async fn preview(&self, _: &str) -> Option<Artifact> {
                None
            }
        }

        let workspace = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let blobs = BlobStore::new(workspace.path());
        // Stub the inspector's result; the blob store and named on-disk copy are real.
        let bytes = b"%PDF-1.7\nscan fixture";
        let digest = digest_of(bytes);
        let reference = hex(&digest);
        super::super::fixture_fs::write(blobs.path(&digest).as_path(), bytes.to_vec());
        let mut services = services(workspace.path(), json!({}), Arc::default()).await;
        services.attachment_facts = Arc::new(ScannedPdf(reference.to_owned()));
        services.files = Arc::new(StoreFiles::new(blobs, workspace.path(), &tokens));
        let compactors = SessionCompactors::new(Arc::new(ProcessCompactionWorld::new(services)), Arc::new(Fixed));

        for auto in [false, true] {
            let provider = scripted(&["ok"]);
            let rig = Rig::new();
            let mut deps = rig.deps_parts(rig.store.clone());
            let settings = CompactSettings { auto, context_window: Some(100_000), token_calibration: 1.0, ..Default::default() };
            let id = ThreadId::from("sess_scan");
            let header = json!({ "provider": "scripted", "model": "m" }).as_object().unwrap().clone();
            let input = CompactorInput { settings: settings.clone(), rows: Arc::default(), archive: Arc::new(NoArchive), blobs: Arc::new(NoBlobs) };
            let compactor = compactors.compactor(&id, &header, &[], input).await.expect("a compactor even when auto is off");
            let parts = Compacting {
                inner: Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None },
                compactor,
                settings,
            };
            deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(parts)));
            let directory = SessionDirectory::new(Arc::new(deps));
            directory.create_with_id(id.clone(), header, json!({})).await.expect("the session");
            let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
            let prompt = json!([
                { "type": "text", "text": "Review this scan." },
                { "type": "file", "attachmentRef": reference, "filename": "scan.pdf", "mimeType": "application/pdf" }
            ]);
            let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": prompt } }), "op-1")).await.expect("turn/start");
            assert!(matches!(started, Reply::Value(_)), "the turn starts");
            eventually_on_awaiting(|| format!("the turn's end record (auto={auto})"), &[handle.stepped()], || (ended_runs(&rig, &id) == 1).then_some(())).await;

            let requests = lock(&provider.requests);
            assert_eq!(requests.len(), 1, "one provider request (auto={auto})");
            let user = requests[0].messages.iter().rfind(|message| message.role == Role::User).expect("the user prompt");
            let Content::Parts(parts) = &user.content else { panic!("expected prompt and PDF reference (auto={auto})") };
            let copy = workspace.path().join("prompt-attachments").join("files").join(reference).join("scan.pdf");
            assert!(parts.iter().any(|part| matches!(part, ContentPart::Text(text, _) if text.contains("Review this scan."))));
            assert!(parts.iter().any(|part| matches!(part, ContentPart::Text(text, _) if text.contains("no text layer (scanned pages)") && text.contains(copy.to_str().unwrap()))), "the first send points to the scan (auto={auto})");
            assert!(parts.iter().all(|part| matches!(part, ContentPart::Text(..))), "no PDF sent inline (auto={auto})");
            assert_eq!(std::fs::read(copy).unwrap(), bytes);
        }
    }

    /// A directory over `rig`'s store whose turns run on `provider` and whose thread header carries the system prompt `rules`.
    fn restartable(rig: &Rig, provider: &Arc<dyn ProviderAdapter>, workspace: &std::path::Path) -> SessionDirectory {
        restartable_with(rig, provider, workspace, Vec::new())
    }
    fn restartable_with(rig: &Rig, provider: &Arc<dyn ProviderAdapter>, workspace: &std::path::Path, more: Vec<Arc<dyn Tool>>) -> SessionDirectory {
        let mut deps = rig.deps_parts(rig.store.clone());
        let parts = Parts { provider: provider.clone(), workspace: workspace.to_path_buf(), more, settle: None, effort: None };
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(parts)));
        SessionDirectory::new(Arc::new(deps))
    }
    /// [`Parts`] whose first assembly, when asked to, fails: the turn ends after the settings reconcile and before its rows are written.
    struct FailsAssembly {
        inner: Parts,
        fail: std::sync::atomic::AtomicBool,
    }
    #[async_trait]
    impl RunParts for FailsAssembly {
        async fn reconcile_turn(&self, thread: &ThreadId, header: mixdog_store::schema::record::Header, conversation: bool) -> Result<mixdog_store::schema::record::Header, TurnError> {
            self.inner.reconcile_turn(thread, header, conversation).await
        }

        async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError> {
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err(TurnError { message: "assembly failed".into(), data: json!({}), provider_error: None });
            }
            self.inner.assemble(input).await
        }
    }
    fn restartable_failing(rig: &Rig, provider: &Arc<dyn ProviderAdapter>, workspace: &std::path::Path, fail: bool) -> SessionDirectory {
        let mut deps = rig.deps_parts(rig.store.clone());
        let parts = FailsAssembly { inner: Parts { provider: provider.clone(), workspace: workspace.to_path_buf(), more: Vec::new(), settle: None, effort: None }, fail: std::sync::atomic::AtomicBool::new(fail) };
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(parts)));
        SessionDirectory::new(Arc::new(deps))
    }
    /// A prompt fold that moved the prefix owes the stored thinking a rebind (`thinkingRebindPending`, written with the prefix). A
    /// turn that fails to assemble after the reconcile leaves the debt in the header, and the turn that follows a reopen pays it: the
    /// request it sends carries no thinking the old prefix signed, and the debt is cleared.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_failed_assembly_leaves_the_thinking_rebind_owed_to_the_next_turn_after_a_reopen() {
        const SIGNATURE: &str = "sig-owed";
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let mut first_round = vec![StreamEvent::ThinkingBlocks(json!([{ "type": "thinking", "thinking": "hm", "signature": SIGNATURE }]))];
        first_round.extend(done("one"));
        let (first, third) = (scripted_rounds(vec![first_round]), scripted_rounds(vec![done("three")]));
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let provider: Arc<dyn ProviderAdapter> = first.clone();
        let directory = restartable_failing(&rig, &provider, workspace.path(), false);
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the end record of the first turn".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 0).then_some(())).await;
        // The fold's write: the prefix moved and the rebind is owed, in one header change.
        let owed = json!({ "threadId": id, "set": { "thinkingRebindPending": true }, "unset": [] });
        handle.request(CoreRequest { method: Method("thread/header/patch"), params: owed, op: None, ctx: CallContext::internal("test") }).await.expect("the owed rebind");
        drop(handle);
        drop(directory);

        // The next turn fails after its reconcile, before its rows are written.
        let failing = restartable_failing(&rig, &provider, workspace.path(), true);
        let handle = failing.open_handle(&id, &CallContext::internal("test")).await.expect("reopen");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
        eventually_on_awaiting(|| "the failed turn's end".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 1 && !handle.turn_busy()).then_some(())).await;
        assert_eq!(handle.live_header().header().get("thinkingRebindPending"), Some(&Value::Bool(true)), "the debt outlives the failed turn");
        drop(handle);
        drop(failing);

        // A process that opens the files honours it: the request carries no signed thinking, and the debt is paid.
        let next: Arc<dyn ProviderAdapter> = third.clone();
        let resumed = restartable_failing(&rig, &next, workspace.path(), false);
        let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("reopen again");
        assert_eq!(handle.live_header().header().get("thinkingRebindPending"), Some(&Value::Bool(true)), "the debt is on disk");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-3", "input": { "prompt": "third" } }), "op-3")).await.expect("turn/start");
        eventually_on_awaiting(|| "the third turn's end".to_owned(), &[handle.stepped()], || (!lock(&third.requests).is_empty() && !handle.turn_busy()).then_some(())).await;
        let sent = format!("{:?}", lock(&third.requests)[0].messages);
        assert!(sent.contains("one") && sent.contains("third"), "the history and the new prompt are sent: {sent}");
        assert!(!sent.contains(SIGNATURE), "the thinking the old prefix signed is not replayed: {sent}");
        assert!(handle.live_header().header().get("thinkingRebindPending").is_none(), "the debt is cleared once paid");
    }
    fn scripted(answers: &[&str]) -> Arc<Scripted> {
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(answers.iter().map(|answer| done(answer)).collect()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        })
    }
    fn ended_runs(rig: &Rig, id: &ThreadId) -> usize {
        rig.store.records(id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed))).count()
    }
    /// A session resumed by a new process over the same files sends the same request prefix the first process did, then the new
    /// turn: nothing before the prompt is rebuilt differently, the answer the first process stored is in it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_session_resumed_after_a_restart_sends_the_prefix_it_sent_before() {
        let (first, second) = (scripted(&["ok"]), scripted(&["later"]));
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let provider: Arc<dyn ProviderAdapter> = first.clone();
        let directory = restartable(&rig, &provider, workspace.path());
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let patch = json!({ "threadId": id, "set": { "promptBase": "rules" }, "unset": [] });
        handle.request(CoreRequest { method: Method("thread/header/patch"), params: patch, op: None, ctx: CallContext::internal("test") }).await.expect("the system prompt");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the end record of the first turn".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 0).then_some(())).await;
        drop(handle);
        drop(directory);
        // A new process: a new directory over what the first one wrote.
        let provider: Arc<dyn ProviderAdapter> = second.clone();
        let resumed = restartable(&rig, &provider, workspace.path());
        let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
        eventually_on_awaiting(|| "the end record of the second turn".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 1).then_some(())).await;
        let (before, after) = (lock(&first.requests).clone(), lock(&second.requests).clone());
        let wire = |request: &ModelRequest| request.messages.iter().map(|m| format!("{:?}", m)).collect::<Vec<_>>();
        let (sent_before, sent_after) = (wire(&before[0]), wire(&after[0]));
        assert_eq!(sent_after[..sent_before.len()], sent_before[..], "the prefix is the same");
        assert_eq!(sent_after.len(), sent_before.len() + 2, "then the first answer and the new prompt");
        assert!(sent_after[sent_before.len()].contains("ok") && sent_after[sent_before.len() + 1].contains("again"), "{sent_after:?}");
    }
    /// What is on disk at each point a crash can fall in a turn: with the request on the wire the prompt and the turn's start are
    /// durable and no end is; after the answer the end is.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_prompt_is_durable_before_the_request_leaves_and_the_turns_end_only_after_the_answer() {
        let release = Arc::new(tokio::sync::Notify::new());
        let provider = Arc::new(HeldScripted(Arc::try_unwrap(scripted(&["ok"])).ok().expect("one owner"), release.clone(), 0));
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let adapter: Arc<dyn ProviderAdapter> = provider.clone();
        let directory = restartable(&rig, &adapter, workspace.path());
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the request on the wire".to_owned(), &[handle.stepped()], || (!lock(&provider.0.requests).is_empty()).then_some(())).await;
        let records = rig.store.records(&id);
        let items = records.iter().filter(|(_, record)| matches!(record, Record::Item(_))).count();
        let started = records.iter().filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Started))).count();
        assert_eq!((items >= 1, started, ended_runs(&rig, &id)), (true, 1, 0), "with the request on the wire: the prompt and the start are on disk, no end");
        release.notify_one();
        eventually_on_awaiting(|| "the end record".to_owned(), &[handle.stepped()], || (ended_runs(&rig, &id) > 0).then_some(())).await;
        let after = rig.store.records(&id).iter().filter(|(_, record)| matches!(record, Record::Item(_))).count();
        assert!(after > items, "the answer was stored with the end of the turn");
    }
    /// A provider that, on its first request, runs `on_first` (the test makes the store start failing there) and then answers as `inner`.
    struct OnFirstSend {
        inner: Arc<Scripted>,
        on_first: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    }

    #[async_trait]
    impl ProviderAdapter for OnFirstSend {
        fn release_send(&self, group: &str) {
            self.inner.release_send(group);
        }
        fn id(&self) -> &ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
            if let Some(first) = lock(&self.on_first).take() {
                first();
            }
            self.inner.attempt(request).await
        }
    }
    fn tool_call(id: &str, name: &str) -> StreamEvent {
        StreamEvent::ToolCallDone(ToolCall { id: id.into(), name: name.into(), arguments: json!({ "a": id }), native_type: None })
    }
    fn tool_use() -> StreamEvent {
        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None }
    }
    fn scripted_rounds(rounds: Vec<Vec<StreamEvent>>) -> Arc<Scripted> {
        Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(rounds.into()),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        })
    }
    fn item_rows(rig: &Rig, id: &ThreadId) -> usize {
        rig.store.records(id).iter().filter(|(_, record)| matches!(record, Record::Item(_))).count()
    }
    /// While the store refuses every write from the first request on, the turn goes on through its tool round to the answer: every
    /// request is sent, the tool runs and its result reaches the next request, and nothing after the failure is on disk.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_store_that_starts_failing_mid_turn_does_not_stop_the_turn_and_nothing_after_it_reaches_disk() {
        let inner = scripted_rounds(vec![vec![tool_call("c1", "echo"), tool_use()], answer_events("done")]);
        let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
        let id_cell: Arc<Mutex<Option<ThreadId>>> = Arc::default();
        let on_disk_at_failure = Arc::new(Mutex::new(None));
        let provider = Arc::new(OnFirstSend {
            inner: inner.clone(),
            on_first: Mutex::new(Some({
                let (failing, store, id_cell, seen) = (rig.store.failing.clone(), rig.store.clone(), id_cell.clone(), on_disk_at_failure.clone());
                Box::new(move || {
                    let id = lock(&id_cell).clone().expect("the thread is known");
                    *lock(&seen) = Some(store.records(&id).iter().filter(|(_, record)| matches!(record, Record::Item(_))).count());
                    *lock(&failing) = Some("disk full".into());
                })
            })),
        });
        let adapter: Arc<dyn ProviderAdapter> = provider;
        let directory = restartable(&rig, &adapter, workspace.path());
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        *lock(&id_cell) = Some(id.clone());
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the turn carried on to the end".to_owned(), &[handle.stepped()], || (lock(&inner.requests).len() == 2 && !handle.turn_busy()).then_some(())).await;
        let second = format!("{:?}", lock(&inner.requests)[1].messages);
        assert!(second.contains("echo:"), "the tool ran and its result went on to the next request: {second}");
        assert_eq!(Some(item_rows(&rig, &id)), *lock(&on_disk_at_failure), "no row written after the store began refusing reached disk");
    }
    fn answer_events(text: &str) -> Vec<StreamEvent> {
        vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]
    }
    /// A process that dies while a tool runs leaves the prompt and the turn's start on disk and no end; the process that opens the
    /// files takes the next prompt and sends it after the first one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_crash_inside_a_tool_run_leaves_the_prompt_and_no_end_and_the_next_process_sends_it_after_that_prompt() {
        let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let spec = ToolSpec {
            name: "blocker".into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: "blocker".into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let (first, second) = (scripted_rounds(vec![vec![tool_call("c1", "blocker"), tool_use()]]), scripted_rounds(vec![answer_events("later")]));
        let (rig, workspace) = (Rig::new(), tempfile::tempdir().unwrap());
        let provider: Arc<dyn ProviderAdapter> = first.clone();
        let directory = restartable_with(&rig, &provider, workspace.path(), vec![Arc::new(Blocker(spec, blocked.clone(), release.clone()))]);
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        tokio::time::timeout(std::time::Duration::from_secs(30), blocked.notified()).await.expect("the tool started within 30 s");
        // The process dies here: the tool never ends, and only the files are what the next process has.
        let started = rig.store.records(&id).iter().filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Started))).count();
        assert_eq!((item_rows(&rig, &id) >= 1, started, ended_runs(&rig, &id)), (true, 1, 0), "the prompt and the start are on disk, no end");
        let next: Arc<dyn ProviderAdapter> = second.clone();
        let resumed = restartable(&rig, &next, workspace.path());
        let handle = resumed.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "again" } }), "op-2")).await.expect("turn/start");
        eventually_on_awaiting(|| "the resumed turn's end".to_owned(), &[handle.stepped()], || (!lock(&second.requests).is_empty() && !handle.turn_busy()).then_some(())).await;
        let sent = format!("{:?}", lock(&second.requests)[0].messages);
        let (go, again) = (sent.find("go").expect("the first prompt is in the request"), sent.find("again").expect("the new prompt is in the request"));
        assert!(go < again, "the first prompt precedes the new one: {sent}");
        release.notify_one();
    }
    /// The prefix guard is the actor incarnation's: a thread rewound after its guard was kept, then unloaded at its idle deadline,
    /// reopens on no guard, so the next send reaches the provider (it was refused as `Session state changed unexpectedly.` when the
    /// guard outlived the actor and the rewrite's lineage was only the old actor's to name).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_send_after_the_idle_unload_of_a_rewound_thread_reaches_the_provider() {
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([done("one"), done("two"), done("three")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let phases = |wanted: mixdog_store::schema::record::RunPhase| {
            rig.store.records(&id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == wanted)).count()
        };
        for (turns, (op, prompt)) in [("op-1", "go"), ("op-2", "again")].into_iter().enumerate() {
            handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": prompt } }), op)).await.expect("turn/start");
            eventually_on_awaiting(|| format!("the end record of turn {op}"), &[handle.stepped()], || (phases(mixdog_store::schema::record::RunPhase::Completed) > turns).then_some(())).await;
        }
        // The second turn's prompt leaves the transcript; the first actor's guard still describes the longer history.
        let again = rig
            .store
            .records(&id)
            .into_iter()
            .find_map(|(_, record)| match record {
                Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"] == "user" && body["content"].as_str().is_some_and(|text| text.contains("again"))) => Some(item.iid.as_str().to_owned()),
                _ => None,
            })
            .expect("the second prompt's row");
        handle.request(request("thread/rewind", json!({ "threadId": id, "opId": "op-rewind", "itemId": again }), "op-rewind")).await.expect("thread/rewind");
        // The idle deadline's decision: nothing watches or runs the thread, so it leaves the directory.
        // A release never waits for work under way: the turn's settle may still be finishing as its end record lands, and the
        // thread then stays until its idle clock decides again. The decision is asked again after each step the actor takes.
        loop {
            let mut stepped = Box::pin(handle.stepped().notified());
            stepped.as_mut().enable();
            directory.release(&id).await;
            if directory.handle(&id).is_none() {
                break;
            }
            tokio::time::timeout(std::time::Duration::from_secs(30), stepped).await.expect("the thread became idle within 30 s");
        }
        let reopened = directory.open_handle(&id, &CallContext::internal("test")).await.expect("reopen");
        assert!(!Arc::ptr_eq(&reopened, &handle), "a replacement actor");
        reopened.request(request("turn/start", json!({ "threadId": id, "opId": "op-3", "input": { "prompt": "third" } }), "op-3")).await.expect("turn/start");
        eventually_on_awaiting(|| "the send after the unload ends".to_owned(), &[reopened.stepped()], || {
            (phases(mixdog_store::schema::record::RunPhase::Completed) + phases(mixdog_store::schema::record::RunPhase::Failed) >= 3).then_some(())
        })
        .await;
        assert_eq!(phases(mixdog_store::schema::record::RunPhase::Failed), 0, "no refusal: {:?}", rig.store.records(&id));
        assert_eq!(lock(&provider.requests).len(), 3, "the third send reached the provider");
    }
    /// A turn is assembled from the header the settings reconcile returns, not the one it started
    /// with: a gate that moved since the last turn reaches the request (`await reconcileTurnSettings()`).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_is_assembled_from_the_reconciled_header() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([vec![StreamEvent::TextDelta("ok".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }]])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let settle = Arc::new(Settle { add: ("featureDeniedTools", json!(["web_search"])), seen: Mutex::default() });
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: Some(settle.clone()), effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the assistant's answer in the store".to_owned(), &[handle.stepped()], || {
            let answered = rig.store.records(&id).into_iter().any(|(_, record)| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["role"] == "assistant")));
            answered.then_some(())
        })
        .await;
        let seen = lock(&settle.seen).clone();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0]["featureDeniedTools"], json!(["web_search"]));
    }
    /// A failed turn's retry removes the stale copy of its prompt from the model context for good
    /// (`prepareAskTurn`): the retry's own request and the next turn's both carry the prompt once,
    /// while the transcript keeps every row it showed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_retried_prompt_is_in_the_next_turns_model_context_once() {
        let done = |text: &str| vec![StreamEvent::TextDelta(text.into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }];
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([done("fixed"), done("welcome")])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(true),
        });
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let mut deps = rig.deps_parts(rig.store.clone());
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: provider.clone(), workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        let ended = || {
            rig.store
                .records(&id)
                .into_iter()
                .filter(|(_, record)| matches!(record, Record::Run(run) if matches!(run.phase, mixdog_store::schema::record::RunPhase::Completed | mixdog_store::schema::record::RunPhase::Failed)))
                .count()
        };
        let turn = |input: Value, op: &str, want: usize| {
            let (handle, op, thread) = (handle.clone(), op.to_owned(), id.clone());
            let ended = &ended;
            async move {
                let started = handle.request(request("turn/start", json!({ "threadId": thread, "opId": op, "input": input }), &op)).await.expect("turn/start");
                let Reply::Value(started) = started else { panic!("turn/start answers a value") };
                // The previous turn's run is over once its record is written, but its settlement
                // (the Goal runtime's `turn_settled`) is not: a prompt arriving in between is
                // queued behind it and starts when it is done, with the options it was sent with.
                // Node queues the same way (`drain.mjs` runs the queue only after `runTurn` returns),
                // so both answers are right; the first turn, on an idle thread, can only start.
                let kind = started["kind"].as_str().expect("turn/start names its answer");
                assert!(kind == "queued" && want > 1 || kind == "started", "turn {op}: {started}");
                // Woken by each step of the thread's actor, which is where a run's end is acknowledged after its record is stored.
                eventually_on_awaiting(|| format!("the end record of run {want} in the store (turn {op})"), &[handle.stepped()], || (ended() >= want).then_some(())).await;
            }
        };
        turn(json!({ "prompt": "fix it" }), "op-1", 1).await;
        assert!(lock(&provider.requests).is_empty(), "the first attempt was refused");
        turn(json!({ "prompt": "fix it", "options": { "retryFailedTurn": true } }), "op-2", 2).await;
        turn(json!({ "prompt": "thanks" }), "op-3", 3).await;

        let prompts_of = |request: &ModelRequest| request.messages.iter().filter(|m| m.role == Role::User && format!("{:?}", m.content).contains("fix it")).count();
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2, "the retry and the next turn each asked once");
        assert_eq!(prompts_of(&requests[0]), 1, "the retry's request carries the prompt once");
        assert_eq!(prompts_of(&requests[1]), 1, "the next turn's request carries it once, not the failed copy and the retry's");
        assert_eq!(requests[1].messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::User]);
        let transcript_prompts = rig
            .store
            .records(&id)
            .into_iter()
            .filter(|(_, record)| matches!(record, Record::Item(item) if item.visible && matches!(&item.body, Slot::Inline(body) if body["content"] == "fix it")))
            .count();
        assert_eq!(transcript_prompts, 2, "the transcript keeps the failed prompt beside the retry's");
    }
    /// The owner's case with the real run: a response calls two tools, which start as their blocks stream (eager dispatch, so the
    /// first's gate answer precedes the step's usage); the first finishes and the second stays blocked. Before the second is
    /// released the feed carries the usage, both cards, the first's closed card, and a message the person sent meanwhile.
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn a_step_with_a_blocked_eager_call_is_published_as_it_happens() {
        let scripted = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::TextDelta("looking".into()),
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "probe".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::ToolCallDone(ToolCall { id: "c2".into(), name: "blocker".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let spec = |name: &str| ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: name.into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
        let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let rig = Rig::new();
        let workspace = tempfile::tempdir().unwrap();
        let mut deps = rig.deps_parts(rig.store.clone());
        let more: Vec<Arc<dyn Tool>> = vec![Arc::new(Probe(spec("probe"), ran.clone(), ran_now.clone())), Arc::new(Blocker(spec("blocker"), blocked.clone(), release.clone()))];
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: scripted, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        tokio::time::timeout(std::time::Duration::from_secs(30), blocked.notified()).await.expect("the second call started within 30 s");
        // The two calls run side by side: the first is waited for, not assumed to be ahead of the second.
        tokio::time::timeout(std::time::Duration::from_secs(30), ran_now.notified()).await.expect("the first call ran within 30 s");
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst), "the first call ran");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "typed while blocked" } }), "op-2")).await.expect("the second prompt is taken");
        let frames = || rig.feeds.frames(id.as_str());
        fn card_told(frames: &[(u64, String, Value)], call: &str, closed: bool) -> bool {
            frames.iter().any(|(_, method, params)| method == "item/completed" && params["item"]["run"]["callId"] == call && params["item"]["run"]["completedAt"].is_null() != closed)
        }
        let told = || {
            let frames = frames();
            let method = |wanted: &str| frames.iter().any(|(_, method, _)| method == wanted);
            method("thread/tokenUsage/updated") && card_told(&frames, "c1", false) && card_told(&frames, "c2", false) && card_told(&frames, "c1", true) && method("thread/queue/changed")
        };
        eventually_on_awaiting(|| format!("the step shown with its second call blocked: {:?}", frames().iter().map(|(_, method, _)| method.clone()).collect::<Vec<_>>()), &[handle.stepped()], || told().then_some(())).await;
        assert!(
            !frames().iter().any(|(_, method, params)| method == "item/completed" && params["item"]["run"]["callId"] == "c2" && !params["item"]["run"]["completedAt"].is_null()),
            "the blocked call's card is not closed"
        );
        release.notify_one();
        eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
    }
    /// An eager call of send 1 that its response's final calls left out is held through the start of send 2, which issues a
    /// `task wait` with the same call id. The held call settles through `batch.rs`'s eager path, `early_result_of` and the
    /// observer, either before the wait opens (`opens_first == false`) or after; the wait stays open until its own result,
    /// which clears the spinner and the agent's wait.
    async fn a_held_calls_late_settlement_leaves_a_later_sends_wait_alone(opens_first: bool) {
        let id = if opens_first { "held-after-open" } else { "held-before-open" };
        let settled = Arc::new(tokio::sync::Notify::new());
        SETTLED_HOOKS.lock().unwrap().push((id.into(), settled.clone()));
        let (go, held_started, held_release, wait_started, wait_release) = (
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(tokio::sync::Notify::new()),
        );
        let call = |id: &str, name: &str, arguments: Value| ToolCall { id: id.into(), name: name.into(), arguments, native_type: None };
        let stop = |stop| StreamEvent::Completed { stop: Some(stop), pricing_model: None, request_ms: None };
        let scripted = Arc::new(HeldScripted(
            Scripted {
                id: ProviderId::from("scripted"),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(VecDeque::from([
                    // Send 1: the stream runs `holder`, and the final calls name `quick` alone.
                    vec![
                        StreamEvent::ToolCallDone(call(id, "holder", json!({}))),
                        StreamEvent::ReturnedCalls(vec![call("quick-1", "quick", json!({}))]),
                        stop(StopReason::ToolUse),
                    ],
                    // Send 2: a wait with the first call's id, its stop held until the test lets it go.
                    vec![StreamEvent::ToolCallDone(call(id, "task", json!({ "action": "wait" }))), stop(StopReason::ToolUse)],
                    vec![StreamEvent::TextDelta("all done".into()), stop(StopReason::EndTurn)],
                ])),
                requests: Mutex::new(Vec::new()),
                fail_first: std::sync::atomic::AtomicBool::new(false),
            },
            go.clone(),
            1,
        ));
        let spec = |name: &str| ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: name.into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
        let rig = Rig::new();
        let workspace = tempfile::tempdir().unwrap();
        let mut deps = rig.deps_parts(rig.store.clone());
        let more: Vec<Arc<dyn Tool>> = vec![
            Arc::new(Blocker(spec("holder"), held_started.clone(), held_release.clone())),
            Arc::new(Probe(spec("quick"), ran, ran_now)),
            Arc::new(Blocker(spec("task"), wait_started.clone(), wait_release.clone())),
        ];
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: scripted, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let thread = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&thread).expect("loaded");
        let within = |what: &'static str, signal: Arc<tokio::sync::Notify>| async move {
            tokio::time::timeout(std::time::Duration::from_secs(30), signal.notified()).await.unwrap_or_else(|_| panic!("{what} within 30 s"));
        };
        let frames = || rig.feeds.frames(thread.as_str());
        let mode = || frames().iter().rev().find_map(|(_, method, params)| (method == "thread/runtime/updated").then(|| params["value"]["spinner"]["mode"].as_str().map(str::to_owned)).flatten());
        let waiting = || directory.worker_live(&thread, 0, &NoJobs).task_waiting;
        let shown_open = || mode().as_deref() == Some("task-wait") && waiting();
        handle.request(request("turn/start", json!({ "threadId": thread, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        within("send 1's call started", held_started).await;
        // Send 2 has begun and issued its wait: the held call spans the start of the send.
        within("send 2's wait started", wait_started).await;
        if opens_first {
            go.notify_one();
            eventually_on_awaiting(|| format!("the wait shown as open: {:?}", mode()), &[handle.stepped()], || shown_open().then_some(())).await;
            held_release.notify_one();
            within("the held call's settlement handled", settled.clone()).await;
        } else {
            held_release.notify_one();
            within("the held call's settlement handled", settled.clone()).await;
            go.notify_one();
            eventually_on_awaiting(|| format!("the wait shown as open: {:?}", mode()), &[handle.stepped()], || shown_open().then_some(())).await;
        }
        assert!(shown_open(), "the held call's late settlement left the wait open");
        wait_release.notify_one();
        eventually_on_awaiting(|| format!("the wait's own result clears the working state: {:?}", mode()), &[handle.stepped()], || (mode().as_deref() != Some("task-wait") && !waiting()).then_some(())).await;
        eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn a_late_settlement_of_an_earlier_send_before_the_wait_opens_does_not_hide_it() {
        a_held_calls_late_settlement_leaves_a_later_sends_wait_alone(false).await;
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn a_late_settlement_of_an_earlier_send_after_the_wait_opened_does_not_close_it() {
        a_held_calls_late_settlement_leaves_a_later_sends_wait_alone(true).await;
    }
    /// A `task wait` that finishes while its response still streams (its early result precedes the batch) sits beside a blocked
    /// sibling: the wait is over, so the spinner never shows `task-wait` and no agent counts it open while the sibling runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn an_early_completed_task_wait_beside_a_blocked_call_is_not_shown_as_open() {
        let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
        let settled = Arc::new(tokio::sync::Notify::new());
        SETTLED_HOOKS.lock().unwrap().push(("early-wait".into(), settled.clone()));
        let scripted = Arc::new(HeldScripted(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall { id: "early-wait".into(), name: "task".into(), arguments: json!({ "action": "wait" }), native_type: None }),
                    StreamEvent::ToolCallDone(ToolCall { id: "c2".into(), name: "blocker".into(), arguments: json!({}), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        }, settled, 0));
        let spec = |name: &str| ToolSpec {
            name: name.into(),
            title: None,
            trigger: None,
            public: true,
            aliases: Vec::new(),
            description: name.into(),
            input_schema: json!({ "type": "object" }),
            annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
            parallel_safe: true,
            exclusive_with: Vec::new(),
        };
        let (blocked, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let rig = Rig::new();
        let workspace = tempfile::tempdir().unwrap();
        let mut deps = rig.deps_parts(rig.store.clone());
        let more: Vec<Arc<dyn Tool>> = vec![Arc::new(Probe(spec("task"), ran.clone(), ran_now.clone())), Arc::new(Blocker(spec("blocker"), blocked.clone(), release.clone()))];
        deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider: scripted, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None })));
        let directory = SessionDirectory::new(Arc::new(deps));
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");

        tokio::time::timeout(std::time::Duration::from_secs(30), blocked.notified()).await.expect("the second call started within 30 s");
        tokio::time::timeout(std::time::Duration::from_secs(30), ran_now.notified()).await.expect("the wait ran within 30 s");
        assert!(ran.load(std::sync::atomic::Ordering::SeqCst), "the wait ran");
        let frames = || rig.feeds.frames(id.as_str());
        let shown = || frames().iter().any(|(_, method, params)| method == "item/completed" && params["item"]["run"]["callId"] == "c2" && params["item"]["run"]["completedAt"].is_null());
        eventually_on_awaiting(|| "the blocked call's card shown".to_owned(), &[handle.stepped()], || shown().then_some(())).await;
        let waiting = frames().iter().any(|(_, method, params)| method == "thread/runtime/updated" && params["value"]["spinner"]["mode"] == "task-wait");
        assert!(!waiting, "a wait that already ended is not shown as waiting");
        // The agent row's `awaitingTask: "wait"` reads this flag (`job_status_row`, the pool list's `taskWaits`).
        assert!(!directory.worker_live(&id, 0, &NoJobs).task_waiting, "the agent row does not await a wait that already ended");
        release.notify_one();
        eventually_on_awaiting(|| "the turn settled".to_owned(), &[handle.stepped()], || (!handle.turn_busy()).then_some(())).await;
    }
    impl HeldTurn {
        async fn start() -> Self {
            let scripted = Arc::new(Scripted {
                id: ProviderId::from("scripted"),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(VecDeque::from([
                    vec![
                        StreamEvent::TextDelta("looking".into()),
                        StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "probe".into(), arguments: json!({}), native_type: None }),
                        StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                    ],
                    vec![StreamEvent::TextDelta("all done".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
                ])),
                requests: Mutex::new(Vec::new()),
                fail_first: std::sync::atomic::AtomicBool::new(false),
            });
            let rig = Rig::new();
            let held_from = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let (compaction, from) = (rig.compaction.clone(), held_from.clone());
            let arm: Box<dyn FnOnce() + Send> = Box::new(move || {
                from.store(*compaction.prepare_started.borrow(), std::sync::atomic::Ordering::SeqCst);
                compaction.prepare_held.send_replace(true);
            });
            let provider = Arc::new(ArmedOnSend { inner: scripted, arm: Mutex::new(Some(arm)) });
            let (ran, ran_now) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(tokio::sync::Notify::new()));
            let spec = ToolSpec {
                name: "probe".into(),
                title: None,
                trigger: None,
                public: true,
                aliases: Vec::new(),
                description: "probe".into(),
                input_schema: json!({ "type": "object" }),
                annotations: ToolAnnotations { read_only_hint: Some(true), idempotent_hint: Some(true), ..ToolAnnotations::default() },
                parallel_safe: true,
                exclusive_with: Vec::new(),
            };
            let workspace = tempfile::tempdir().unwrap();
            let mut deps = rig.deps_parts(rig.store.clone());
            let more: Vec<Arc<dyn Tool>> = vec![Arc::new(Probe(spec, ran.clone(), ran_now.clone()))];
            deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more, settle: None, effort: None })));
            let directory = SessionDirectory::new(Arc::new(deps));
            let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
            let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
            let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
            let handle = directory.handle(&id).expect("loaded");
            handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
            Self { rig, _directory: directory, _workspace: workspace, id, handle, ran, ran_now, held_from }
        }

        /// A report's preparation started after the hold began, and waits.
        async fn a_preparation_is_held(&self) {
            let mut started = self.rig.compaction.prepare_started.subscribe();
            let wait = started.wait_for(|started| *self.rig.compaction.prepare_held.borrow() && *started > self.held_from.load(std::sync::atomic::Ordering::SeqCst));
            tokio::time::timeout(std::time::Duration::from_secs(30), wait).await.expect("a preparation held within 30 s").expect("the counter");
        }

        /// What the feed showed of the turn, each once, in the order it first showed it.
        fn shown(&self) -> Vec<&'static str> {
            let mut out = Vec::new();
            for (_, method, params) in self.rig.feeds.frames(self.id.as_str()) {
                let call = params["item"]["run"]["callId"] == "c1";
                let name = match method.as_str() {
                    "item/agentMessage/delta" if params["delta"] == "looking" => "text",
                    "item/completed" if call && params["item"]["run"]["completedAt"].is_null() => "card",
                    "item/completed" if call => "result",
                    "thread/toolBatch/updated" if params["phase"] == "started" => "tool started",
                    "item/agentMessage/delta" if params["delta"] == "all done" => "answer",
                    _ => continue,
                };
                if !out.contains(&name) {
                    out.push(name);
                }
            }
            out
        }

        /// The stored item rows' bodies.
        fn stored(&self) -> Vec<Value> {
            self.rig
                .store
                .records(&self.id)
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Item(item) => match item.body {
                        Slot::Inline(body) => Some(body),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        }
    }
    /// The contract of a row's hand-over ([`row_handover`]): a report's media preparation is held ahead of the response's
    /// tool-call row, so the row waits for that report's own preparation and the tool, which waits for the row's hand-over, has
    /// not started; once the preparation ends the tool starts and the thread shows the turn in the order the loop produced it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 3)]
    async fn a_held_forwarding_holds_back_no_tool_and_reorders_nothing_shown() {
        let turn = HeldTurn::start().await;
        turn.a_preparation_is_held().await;
        assert!(!turn.ran.load(std::sync::atomic::Ordering::SeqCst), "the tool waits for the report ahead of its row");
        assert!(turn.shown().iter().all(|name| *name == "text"), "nothing produced after the held report is shown: {:?}", turn.shown());

        turn.rig.compaction.prepare_held.send_replace(false);
        tokio::time::timeout(std::time::Duration::from_secs(30), turn.ran_now.notified()).await.expect("the tool started within 30 s");
        eventually_on_awaiting(|| format!("the answer shown: {:?}", turn.shown()), &[turn.handle.stepped()], || turn.shown().contains(&"answer").then_some(())).await;
        assert_eq!(turn.shown(), ["text", "card", "tool started", "result", "answer"], "shown in the order produced");
        // The turn's normal end waits for every preparation it started: none is left running once it settled.
        eventually_on_awaiting(|| "the turn settled".to_owned(), &[turn.handle.stepped()], || (!turn.handle.turn_busy()).then_some(())).await;
        let compaction = &turn.rig.compaction;
        assert_eq!(*compaction.prepare_ended.borrow(), *compaction.prepare_started.borrow(), "no preparation outlives the turn");
    }
    /// A forwarder that dies (its task dropped mid-report, as a panic unwinds it) while a report's preparation is held, nothing
    /// released and nothing cancelled: the preparation it owned ends, the row it held goes at once, a report produced after it
    /// died starts no preparation, and a row placed after it died goes at once (its channel gone).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dead_forwarder_holds_back_no_row_and_leaves_no_preparation() {
        let (port_tx, mut port_rx) = mpsc::unbounded_channel::<RunPort>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        let done_rx = Arc::new(Mutex::new(Some(done_rx)));
        let rig = Rig::new();
        rig.set_script(Arc::new(move |run| {
            let (port_tx, done_rx) = (port_tx.clone(), lock(&done_rx).take());
            Box::pin(async move {
                let _ = port_tx.send(run.port.clone());
                if let Some(done) = done_rx {
                    let _ = done.await;
                }
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        let port = port_rx.recv().await.expect("the run's port");

        let compaction = rig.compaction.clone();
        let started_before = *compaction.prepare_started.borrow();
        compaction.prepare_held.send_replace(true);
        let (shown_tx, shown_rx) = mpsc::unbounded_channel();
        let (jobs_tx, mut jobs_rx) = mpsc::unbounded_channel();
        let jobs = Jobs { observed: Arc::default(), seq: AtomicU64::new(0), tx: jobs_tx, shown: Some(shown_tx.clone()), taken: Mutex::default() };
        // A token nothing fires: only the forwarder's death can end what it owns.
        let forwarder = spawn_forwarder(port.clone(), shown_rx, tokio_util::sync::CancellationToken::new());
        let check = || Shown::Check(mixdog_core_session::session::run::SendCheck { messages: Arc::from(Vec::new()), tools: Vec::new(), reactive: false });
        send_prepared(&shown_tx, &port, check());
        let item = |iid: &str| ItemCommit { iid: ItemId::from(iid), role: Some("assistant".into()), model: true, visible: true, body: json!({ "content": "x" }), prompt: None };
        jobs.row(true, None, item("held"));
        let Some(Job::Commit(_, _, Some(held))) = jobs_rx.recv().await else { panic!("the row with its place") };
        let within = std::time::Duration::from_secs(30);
        let mut started = compaction.prepare_started.subscribe();
        tokio::time::timeout(within, started.wait_for(|started| *started > started_before)).await.expect("the preparation held within 30 s").expect("the counter");

        forwarder.abort();
        assert!(matches!(tokio::time::timeout(within, row_handover(Some(held))).await.expect("the held row goes within 30 s"), Handover::Gone));
        let _ = forwarder.await;
        let mut ended = compaction.prepare_ended.subscribe();
        let all_ended = ended.wait_for(|ended| *ended == *compaction.prepare_started.borrow());
        tokio::time::timeout(within, all_ended).await.expect("the owned preparation ended within 30 s, still held").expect("the counter");
        assert!(*compaction.prepare_held.borrow(), "nothing released the hold");

        let started_after = *compaction.prepare_started.borrow();
        send_prepared(&shown_tx, &port, check());
        tokio::task::yield_now().await;
        assert_eq!(*compaction.prepare_started.borrow(), started_after, "no preparation starts once the forwarding is gone");
        jobs.row(true, None, item("after"));
        let Some(Job::Commit(_, _, Some(after))) = jobs_rx.recv().await else { panic!("the row with its place") };
        assert!(matches!(tokio::time::timeout(within, row_handover(Some(after))).await.expect("the later row goes within 30 s"), Handover::Gone));
        compaction.prepare_held.send_replace(false);
        let _ = done_tx.send(());
    }
    /// Several media-bearing reports ahead of a row prepare at once: every preparation has started while each is still held
    /// (a forwarder that prepared them in turn would have started one), and the row's place is answered only once they are done.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_reports_ahead_of_a_row_prepare_at_once() {
        let (port_tx, mut port_rx) = mpsc::unbounded_channel::<RunPort>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        let done_rx = Arc::new(Mutex::new(Some(done_rx)));
        let rig = Rig::new();
        rig.set_script(Arc::new(move |run| {
            let (port_tx, done_rx) = (port_tx.clone(), lock(&done_rx).take());
            Box::pin(async move {
                let _ = port_tx.send(run.port.clone());
                if let Some(done) = done_rx {
                    let _ = done.await;
                }
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        let port = port_rx.recv().await.expect("the run's port");

        let before = *rig.compaction.prepare_started.borrow();
        rig.compaction.prepare_held.send_replace(true);
        let (shown_tx, shown_rx) = mpsc::unbounded_channel();
        let cancel = tokio_util::sync::CancellationToken::new();
        let forwarder = spawn_forwarder(port.clone(), shown_rx, cancel.clone());
        let check = || Shown::Check(mixdog_core_session::session::run::SendCheck { messages: Arc::from(Vec::new()), tools: Vec::new(), reactive: false });
        for _ in 0..3 {
            send_prepared(&shown_tx, &port, check());
        }
        let (reached, mut place) = tokio::sync::oneshot::channel();
        let _ = shown_tx.send(Shown::Row(reached));
        let mut started = rig.compaction.prepare_started.subscribe();
        tokio::time::timeout(std::time::Duration::from_secs(30), started.wait_for(|started| *started >= before + 3)).await.expect("three preparations under way within 30 s").expect("the counter");
        assert!(matches!(place.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)), "the row waits while the reports ahead prepare");

        rig.compaction.prepare_held.send_replace(false);
        let handed = tokio::time::timeout(std::time::Duration::from_secs(30), place).await.expect("the place answered within 30 s").expect("the forwarder reached the row");
        let _ = handed.send(());
        cancel.cancel();
        let _ = forwarder.await;
        let _ = done_tx.send(());
    }
    /// A turn a provider timeout ended (no retry recovered it, nothing else stopped it) reaps the shells it started
    /// since its ask (`armTurnTimeoutOnProviderError`); a turn any other provider error ended keeps them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_ended_by_a_provider_timeout_reaps_its_shells() {
        let failed_end = |rig: &Rig, id: &ThreadId| {
            rig.store.records(id).into_iter().any(|(_, record)| match record {
                Record::Amend(amend) => match amend.body {
                    Slot::Inline(body) => body.pointer("/meta/transcript/completion/status") == Some(&json!("failed")),
                    _ => false,
                },
                _ => false,
            })
        };
        for (code, reaped) in [(Some("EPROVIDERTIMEOUT"), true), (None, false)] {
            let mut refusal = ProviderError::new(mixdog_core_api::domain::provider::ErrorKind::InvalidRequest, DeliveryState::NotSent);
            refusal.code = code.map(str::to_owned);
            refusal.message = "provider timed out after 1000ms".to_owned();
            let provider = Arc::new(Refusing { id: ProviderId::from("mock"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC, codec: MockCodec, error: refusal });
            let workspace = tempfile::tempdir().unwrap();
            let rig = Rig::new();
            let (reaps, woke) = (Arc::new(Mutex::new(Vec::new())), Arc::new(tokio::sync::Notify::new()));
            let parts = Reaping { inner: Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None }, reaps: reaps.clone(), woke: woke.clone() };
            let mut deps = rig.deps_parts(rig.store.clone());
            deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(parts)));
            let directory = SessionDirectory::new(Arc::new(deps));
            let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
            let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
            let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
            let handle = directory.handle(&id).expect("loaded");
            handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
            tokio::time::timeout(Duration::from_secs(60), async {
                while !failed_end(&rig, &id) {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the failed turn records its end");
            let reaps = lock(&reaps).clone();
            if reaped {
                let [(thread, since)] = reaps.as_slice() else { panic!("one reap of the timed-out turn: {reaps:?}") };
                assert_eq!(thread, &id);
                assert!(*since > 0, "the reap starts at the turn's ask");
            } else {
                assert!(reaps.is_empty(), "a turn another error ended keeps its shells: {reaps:?}");
            }
        }
    }
    /// The account pool's two notices reach the thread once each, as status and as thread state (Node
    /// `applyStageChange`), never as transcript rows: on a direct run and on one whose provider answers through the
    /// model proxy's wire.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_pools_switching_and_changed_notices_reach_the_thread_once_each() {
        use mixdog_core_api::domain::provider::AccountStage;
        use mixdog_core_domains::domains::ai_admin::model_proxy as proxy;
        let switching = "Quota exhausted — switching to the next account";
        let events = vec![
            StreamEvent::AccountStage(AccountStage::Switching { message: switching.into() }),
            StreamEvent::TextDelta("ok".into()),
            StreamEvent::AccountStage(AccountStage::Changed { provider: "custom-x".into(), account_id: "k2".into(), at: 7 }),
            StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None },
        ];
        let crossed: Vec<StreamEvent> = events
            .iter()
            .map(|event| {
                let wire = serde_json::to_value(proxy::event_out(event)).unwrap();
                match proxy::event_in(serde_json::from_value(wire).unwrap()).unwrap() {
                    proxy::Incoming::Event(event) => event,
                    other => panic!("{other:?}"),
                }
            })
            .collect();
        for (how, script) in [("direct", events.clone()), ("model proxy", crossed)] {
            let provider = Arc::new(Scripted {
                id: ProviderId::from("custom-x"),
                policy: RetryPolicy::codex_default(),
                keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec,
                script: Mutex::new(VecDeque::from([script])),
                requests: Mutex::new(Vec::new()),
                fail_first: std::sync::atomic::AtomicBool::new(false),
            });
            let workspace = tempfile::tempdir().unwrap();
            let rig = Rig::new();
            let mut deps = rig.deps_parts(rig.store.clone());
            deps.runs = Arc::new(RunHostFactory::new(mixdog_services::task_reports::runtime_state::RuntimeLiveness::new(), mixdog_tools::web::NativeSearchUsageSinks::new(), Arc::new(Parts { provider, workspace: workspace.path().to_path_buf(), more: Vec::new(), settle: None, effort: None })));
            let directory = SessionDirectory::new(Arc::new(deps));
            let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": "/ws" }), "op-start")).await.expect("thread/start");
            let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
            let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
            let handle = directory.handle(&id).expect("loaded");
            handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
            let frames = |method: &str| -> Vec<Value> { rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == method).map(|(_, _, params)| params).collect() };
            eventually_on_awaiting(|| format!("{how}: the turn's end"), &[handle.stepped()], || (!frames("turn/completed").is_empty()).then_some(())).await;
            let stages: Vec<Value> = frames("thread/stage/updated").into_iter().filter(|p| p["stage"] == "reconnecting").collect();
            assert_eq!(stages, [json!({ "threadId": id, "stage": "reconnecting", "detail": { "message": switching } })], "{how}: the switching status, once");
            let changed: Vec<Value> = frames("thread/providerAccount/changed").into_iter().filter(|p| p.to_string().contains("\"custom-x\"")).collect();
            assert_eq!(changed.len(), 1, "{how}: the account change, once: {changed:?}");
            // The PC's account id never leaves the PC (Node's `scalarDetail`); a direct run names it.
            assert_eq!(changed[0].to_string().contains("\"k2\""), how == "direct", "{how}: {changed:?}");
            let rows = serde_json::to_string(&rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m.starts_with("item/")).collect::<Vec<_>>()).unwrap();
            assert!(!rows.contains(switching), "{how}: the switching message is not a transcript row");
        }
    }
    /// A clock the test moves.
    struct Moving(AtomicI64);
    impl Clock for Moving {
        fn now_ms(&self) -> i64 {
            self.0.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// [`Config`] whose sessions know a context window and compact automatically only when `auto`; the target is small
    /// enough that an earlier turn's tool output is discardable.
    struct Windowed {
        auto: bool,
    }
    #[async_trait]
    impl super::super::host_seams::ConfigSeams for Windowed {
        fn hidden_agent(&self, agent: Option<&str>) -> bool {
            super::super::host_seams::ConfigSeams::hidden_agent(&Config, agent)
        }
        fn synced_compaction(&self, header: &mixdog_store::schema::record::Header, install: bool) -> Option<Value> {
            super::super::host_seams::ConfigSeams::synced_compaction(&Config, header, install)
        }
        fn route_config(&self, header: &mixdog_store::schema::record::Header) -> mixdog_app_protocol::v2::thread::ThreadRoute {
            super::super::host_seams::ConfigSeams::route_config(&Config, header)
        }
        fn settings_changes(&self, _: &ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
            None
        }
        fn run_settings(&self, thread: &ThreadId, header: &mixdog_store::schema::record::Header) -> super::super::assemble::RunSettings {
            let mut settings = super::super::host_seams::ConfigSeams::run_settings(&Config, thread, header);
            settings.compact = Some(mixdog_agent::boundary::CompactSettings {
                auto: self.auto,
                context_window: Some(100_000),
                target_tokens: Some(2_500),
                token_calibration: 1.0,
                ..Default::default()
            });
            settings
        }
        fn stored_instruction_files(&self) -> Option<Value> {
            None
        }
        fn response_language(&self) -> Option<(String, String)> {
            None
        }
    }

    /// A local Anthropic endpoint behind the real adapter: it keeps every model request's JSON body and answers by what the
    /// last message carries, reporting tiered usage only the message marker can explain (a five-minute write after the
    /// cached read of the previous request's extent; a shrunken transcript reads nothing).
    #[derive(Default)]
    struct CacheEndpoint {
        bodies: Mutex<Vec<Value>>,
        extent: Mutex<(usize, u64)>,
    }
    impl CacheEndpoint {
        /// A model request of the session's turns: it carries the session's tools (a summary request carries none).
        fn main(body: &Value) -> bool {
            body["tools"].as_array().is_some_and(|tools| !tools.is_empty()) && body["max_tokens"] != 1
        }
        fn sse(&self, body: &Value) -> String {
            let messages = body["messages"].as_array().cloned().unwrap_or_default();
            let text = body.to_string();
            if !Self::main(body) {
                let usage = json!({ "input_tokens": 10, "output_tokens": 1 });
                return [
                    ("message_start", json!({ "type": "message_start", "message": { "id": "msg_s", "type": "message", "role": "assistant", "model": "claude-test", "content": [], "stop_reason": null, "usage": usage } })),
                    ("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } })),
                    ("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "HANDOFF-SUMMARY: the log was read." } })),
                    ("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
                    ("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 2 } })),
                    ("message_stop", json!({ "type": "message_stop" })),
                ]
                .iter()
                .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
                .collect();
            }
            let (count, extent) = *lock(&self.extent);
            let read = if messages.len() >= count { extent } else { 0 };
            let created = 100 * (lock(&self.bodies).iter().filter(|b| Self::main(b)).count() as u64 + 1);
            *lock(&self.extent) = (messages.len(), read + created);
            let has = |id: &str| text.contains(&format!("\"tool_use_id\":\"{id}\""));
            let call = |id: &str, name: &str| Some((id.to_owned(), name.to_owned()));
            let last_text = messages.last().map(|m| m.to_string()).unwrap_or_default();
            let tool = if has("toolu_c3") {
                None
            } else if has("toolu_c2") {
                call("toolu_c3", "glob")
            } else if last_text.contains("now wait") {
                call("toolu_c2", "list")
            } else if has("toolu_c1") {
                None
            } else {
                call("toolu_c1", "grep")
            };
            let usage = json!({ "input_tokens": 10, "output_tokens": 1, "cache_read_input_tokens": read, "cache_creation_input_tokens": created, "cache_creation": { "ephemeral_5m_input_tokens": created, "ephemeral_1h_input_tokens": 0 } });
            let start = json!({ "type": "message_start", "message": { "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test", "content": [], "stop_reason": null, "usage": usage } });
            let (block, delta, stop) = match tool {
                Some((id, name)) => (
                    json!({ "type": "tool_use", "id": id, "name": name, "input": {} }),
                    json!({ "type": "input_json_delta", "partial_json": "{}" }),
                    "tool_use",
                ),
                None => (json!({ "type": "text", "text": "" }), json!({ "type": "text_delta", "text": "done" }), "end_turn"),
            };
            [
                ("message_start", start),
                ("content_block_start", json!({ "type": "content_block_start", "index": 0, "content_block": block })),
                ("content_block_delta", json!({ "type": "content_block_delta", "index": 0, "delta": delta })),
                ("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })),
                ("message_delta", json!({ "type": "message_delta", "delta": { "stop_reason": stop }, "usage": { "output_tokens": 2 } })),
                ("message_stop", json!({ "type": "message_stop" })),
            ]
            .iter()
            .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
            .collect()
        }
    }
    struct OneBody(Option<bytes::Bytes>);
    #[async_trait]
    impl mixdog_ai::transport::BodyStream for OneBody {
        async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            self.0.take().map(Ok)
        }
    }
    #[async_trait]
    impl mixdog_ai::transport::http::HttpSend for CacheEndpoint {
        async fn send(&self, request: mixdog_core_api::domain::provider::WireRequest, _: mixdog_ai::transport::Exchange) -> Result<mixdog_ai::transport::http::HttpResponse, ProviderError> {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            let reply = self.sse(&body);
            lock(&self.bodies).push(body);
            Ok(mixdog_ai::transport::http::HttpResponse { status: 200, headers: vec![("content-type".into(), "text/event-stream".into())], body: Box::new(OneBody(Some(reply.into()))) })
        }
    }
    struct TestKey;
    #[async_trait]
    impl mixdog_ai::providers::anthropic::ApiKeySource for TestKey {
        async fn key(&self) -> Result<String, ProviderError> {
            Ok("not-a-credential".into())
        }
        async fn reload(&self) -> Result<String, ProviderError> {
            Ok("not-a-credential".into())
        }
    }

    /// A tool whose result is fixed text.
    struct Says(ToolSpec, String);
    #[async_trait]
    impl Tool for Says {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
            Ok(ToolOutput { parts: vec![ToolPart::Text(self.1.clone())], ..ToolOutput::default() })
        }
    }
    /// A tool that answers only when the test lets it, after telling the test it is waiting.
    struct Held(ToolSpec, Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);
    #[async_trait]
    impl Tool for Held {
        fn spec(&self) -> &ToolSpec {
            &self.0
        }
        async fn call(&self, _: &ToolContext, _: JsonValue) -> ToolOutcome {
            self.1.notify_one();
            self.2.notified().await;
            Ok(ToolOutput { parts: vec![ToolPart::Text("RECENT-RESULT".into())], ..ToolOutput::default() })
        }
    }

    const OLD_PAYLOAD: &str = "OLD-PAYLOAD-7f3a ";

    /// Two turns of a session through the real turn path, real Anthropic adapter and the run host's compactor, with the
    /// clock moved by `wait_ms` while the second turn's tool runs. Returns the endpoint's model request bodies and the thread.
    async fn tool_wait_turns(wait_ms: i64) -> (Vec<Value>, Value) {
        let endpoint = Arc::new(CacheEndpoint::default());
        let mut config = mixdog_ai::providers::anthropic::AnthropicConfig::new(Arc::new(|_: &str| {
            Some(mixdog_ai::providers::anthropic::ModelCaps { max_output_tokens: Some(4096), ..Default::default() })
        }));
        // Not the official URL: the body goes out plain.
        config.base_url = "http://anthropic.test".into();
        let adapter = mixdog_ai::providers::anthropic::AnthropicAdapter::api_key(config, endpoint.clone(), Arc::new(TestKey), mixdog_rt::testing::tokens().cpu_bulk);
        let clock = Arc::new(Moving(AtomicI64::new(1_700_000_000_000)));
        let (waiting, release) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
        let spec = |name: &str| named_spec(name);
        let pool: Vec<Arc<dyn Tool>> = vec![
            // Builtin names, so the session's tool set offers them.
            Arc::new(Says(spec("grep"), OLD_PAYLOAD.repeat(1_000))),
            Arc::new(Held(spec("list"), waiting.clone(), release.clone())),
            Arc::new(Says(spec("glob"), "MORE".into())),
            named("Skill"),
        ];
        let world = turn_world_at(Arc::new(adapter), Arc::new(NoMcp), Vec::new(), false, None, Some(pool), Arc::new(MockFileService::default()), true, clock.clone(), Arc::new(Windowed { auto: false }), true, None).await;
        let tools = json!([{ "name": "grep" }, { "name": "list" }, { "name": "glob" }]);
        let (id, handle) = started_thread(&world, json!({ "provider": "anthropic", "model": "claude-test", "tools": tools })).await;
        let completed = || world.rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == "turn/completed").count();
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "read the log" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the first turn's end".to_owned(), &[handle.stepped()], || (completed() >= 1).then_some(())).await;
        clock.0.fetch_add(10_000, std::sync::atomic::Ordering::SeqCst);
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "now wait" } }), "op-2")).await.expect("turn/start");
        if mixdog_rt::time::timeout(Duration::from_secs(30), waiting.notified()).await.is_err() {
            let frames: Vec<(String, Value)> = world.rig.feeds.frames(id.as_str()).into_iter().map(|(_, m, p)| (m, p)).collect();
            panic!("the held tool never ran; sent {:#?}; frames {frames:#?}", lock(&endpoint.bodies).iter().map(|b| b["messages"].to_string()).collect::<Vec<_>>());
        }
        clock.0.fetch_add(wait_ms, std::sync::atomic::Ordering::SeqCst);
        release.notify_one();
        eventually_on_awaiting(|| "the second turn's end".to_owned(), &[handle.stepped()], || (completed() >= 2).then_some(())).await;
        let all = lock(&endpoint.bodies).clone();
        let summaries = all.iter().filter(|b| !CacheEndpoint::main(b) && b["max_tokens"] != 1).count();
        let mut bodies: Vec<Value> = all.into_iter().filter(CacheEndpoint::main).collect();
        // The summary requests' count rides last.
        bodies.push(json!(summaries));
        (bodies, Value::Object((*handle.header_snapshot()).clone()))
    }

    /// The owner's rule through the production wiring: the second turn's request after a tool wait longer than the
    /// transcript tail's five-minute lifetime is compacted before it goes out (the old tool output gone, the recent call and
    /// result kept, a smaller body); the next immediate tool round reuses that write without compacting again; and the
    /// same history inside the lifetime goes out whole.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cache_expiry_a_tool_wait_past_the_tail_lifetime_compacts_the_next_request_before_it_is_sent() {
        let (mut bodies, header) = tool_wait_turns(6 * 60_000).await;
        let summaries = bodies.pop().expect("the summary count");
        let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
        // read the log → grep; its answer; now wait → list; after the wait; the immediate round after it.
        assert_eq!(bodies.len(), 5, "{text:#?}");
        // The old output is tool history, not conversation: the compaction moves it out by reference without a model summary,
        // and the round after it asks for none either.
        assert_eq!(summaries, json!(0), "no summary request");
        let (a, b, c) = (&text[2], &text[3], &text[4]);
        assert!(a.contains(OLD_PAYLOAD), "request A carries the old tool output");
        assert!(!b.contains(OLD_PAYLOAD), "request B was compacted before dispatch: {b}");
        assert!(b.contains("omitted or shortened to fit the tool-history budget"), "B carries the compaction's handoff reference: {b}");
        assert!(b.contains("now wait") && b.contains("toolu_c2") && b.contains("RECENT-RESULT"), "the recent call and its result are kept: {b}");
        assert!(serde_json::to_vec(&bodies[3]).unwrap().len() < serde_json::to_vec(&bodies[2]).unwrap().len(), "B is smaller than A");
        assert!(!c.contains(OLD_PAYLOAD) && c.contains("RECENT-RESULT") && c.contains("toolu_c3"), "the next round extends B without a second compaction: {c}");
        assert!(header.get("cacheTailBook").is_some_and(|book| !book.is_null()), "the book is persisted on the session: {header}");
    }

    /// The paired control: the same history and tool wait inside the tail's lifetime keeps the old tool output.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cache_expiry_a_tool_wait_inside_the_tail_lifetime_sends_the_transcript_whole() {
        let (mut bodies, _) = tool_wait_turns(60_000).await;
        assert_eq!(bodies.pop(), Some(json!(0)), "no summary");
        let text: Vec<String> = bodies.iter().map(|b| b["messages"].to_string()).collect();
        assert_eq!(bodies.len(), 5, "{text:#?}");
        assert!(text[3].contains(OLD_PAYLOAD) && text[4].contains(OLD_PAYLOAD), "nothing was compacted: {text:#?}");
    }

    fn cache_adapter(endpoint: &Arc<CacheEndpoint>) -> Arc<dyn ProviderAdapter> {
        let mut config = mixdog_ai::providers::anthropic::AnthropicConfig::new(Arc::new(|_: &str| {
            Some(mixdog_ai::providers::anthropic::ModelCaps { max_output_tokens: Some(4096), ..Default::default() })
        }));
        config.base_url = "http://anthropic.test".into();
        Arc::new(mixdog_ai::providers::anthropic::AnthropicAdapter::api_key(config, endpoint.clone(), Arc::new(TestKey), mixdog_rt::testing::tokens().cpu_bulk))
    }

    /// The tools of [`tool_wait_turns`], the held one answering at once.
    fn answering_pool() -> Vec<Arc<dyn Tool>> {
        let release = Arc::new(tokio::sync::Notify::new());
        release.notify_one();
        vec![
            Arc::new(Says(named_spec("grep"), OLD_PAYLOAD.repeat(1_000))),
            Arc::new(Held(named_spec("list"), Arc::new(tokio::sync::Notify::new()), release)),
            Arc::new(Says(named_spec("glob"), "MORE".into())),
            named("Skill"),
        ]
    }

    /// What the fresh host does after a restart `gap_ms` past the first turn.
    enum AfterRestart {
        Turn,
        SideQuestion,
    }

    /// The first turn on one host, the process ending (its books gone), then a fresh host over the same store and clock,
    /// `gap_ms` later, doing `after`. Returns the model request bodies the fresh host sent and its answer to a side question.
    async fn first_turn_then_restart(gap_ms: i64, after: AfterRestart) -> (Vec<Value>, Option<Value>) {
        let clock = Arc::new(Moving(AtomicI64::new(1_700_000_000_000)));
        let first = Arc::new(CacheEndpoint::default());
        let world = turn_world_at(cache_adapter(&first), Arc::new(NoMcp), Vec::new(), false, None, Some(answering_pool()), Arc::new(MockFileService::default()), true, clock.clone(), Arc::new(Windowed { auto: false }), true, None).await;
        let tools = json!([{ "name": "grep" }, { "name": "list" }, { "name": "glob" }]);
        // The session records its model's window ([`Windowed`]'s), as a session created over a listed model does: the manual
        // pass reads it there.
        let (id, handle) = started_thread(&world, json!({ "provider": "anthropic", "model": "claude-test", "tools": tools, "contextWindow": 100_000 })).await;
        let completed = |world: &World| world.rig.feeds.frames(id.as_str()).into_iter().filter(|(_, m, _)| m == "turn/completed").count();
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "read the log" } }), "op-1")).await.expect("turn/start");
        eventually_on_awaiting(|| "the first turn's end".to_owned(), &[handle.stepped()], || (completed(&world) >= 1).then_some(())).await;
        assert!(handle.header_snapshot().get("cacheTailBook").is_some(), "the checkpoint holds the book");
        // The process ends here: the next host has the stored session and books of its own, none of them open.
        clock.0.fetch_add(gap_ms, std::sync::atomic::Ordering::SeqCst);
        let second = Arc::new(CacheEndpoint::default());
        let store: Arc<dyn mixdog_core_session::session::ThreadStore> = world.rig.store.clone();
        let resumed = turn_world_at(cache_adapter(&second), Arc::new(NoMcp), Vec::new(), false, Some(store), Some(answering_pool()), Arc::new(MockFileService::default()), true, clock.clone(), Arc::new(Windowed { auto: false }), true, None).await;
        let handle = resumed.directory.open_handle(&id, &CallContext::internal("test")).await.expect("the thread reopens from its files");
        let answer = match after {
            AfterRestart::Turn => {
                handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-2", "input": { "prompt": "now wait" } }), "op-2")).await.expect("turn/start");
                eventually_on_awaiting(|| "the resumed turn's end".to_owned(), &[handle.stepped()], || (completed(&resumed) >= 1).then_some(())).await;
                None
            }
            AfterRestart::SideQuestion => {
                let asked = handle.request(request("thread/askSide", json!({ "opId": "op-side", "question": "what did the log say?" }), "op-side")).await;
                Some(match asked {
                    Ok(Reply::Value(value)) => value,
                    Ok(_) => panic!("thread/askSide answers a value"),
                    Err(error) => json!({ "error": error.to_string() }),
                })
            }
        };
        let bodies = lock(&second.bodies).iter().filter(|b| CacheEndpoint::main(b)).cloned().collect();
        (bodies, answer)
    }

    /// A fresh host after a persisted checkpoint judges the next request by the stored book: inside the tail's lifetime the
    /// transcript goes out whole; past it (the restart drops the expired proof) it is compacted before the first send.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cache_expiry_a_fresh_host_judges_the_first_send_by_the_persisted_book() {
        let (bodies, _) = first_turn_then_restart(10_000, AfterRestart::Turn).await;
        let first = bodies.first().expect("the resumed turn's first request")["messages"].to_string();
        assert!(first.contains(OLD_PAYLOAD) && first.contains("now wait"), "the persisted proof is live: sent whole");
        let (bodies, _) = first_turn_then_restart(6 * 60_000, AfterRestart::Turn).await;
        let first = bodies.first().expect("the resumed turn's first request")["messages"].to_string();
        assert!(!first.contains(OLD_PAYLOAD) && first.contains("now wait"), "compacted before the first send after the restart: {first}");
    }

    /// A side question on a fresh host (no turn ran in this process) is judged through the gate its rebuilt request loads
    /// from the header: the idle session's cold transcript is compacted first by the host's own manual pass
    /// (`thread/compact/start`, the production compaction over the turns' compactor), and the question is then asked on the
    /// request rebuilt from the compacted history — the old tool output gone, the stale body never sent.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cache_expiry_a_cold_side_question_compacts_the_idle_session_and_is_asked_on_the_rebuilt_request() {
        let (bodies, answer) = first_turn_then_restart(6 * 60_000, AfterRestart::SideQuestion).await;
        let answer = answer.expect("an answer");
        assert_eq!(answer["text"], "done", "the question was asked and answered: {answer}");
        assert_eq!(bodies.len(), 1, "one side request, and no stale one before it: {bodies:#?}");
        let sent = bodies[0]["messages"].to_string();
        assert!(sent.contains("what did the log say?"), "the side question rides the request: {sent}");
        assert!(!sent.contains(OLD_PAYLOAD), "the request was rebuilt from the compacted history: {sent}");
    }

    async fn turn_world(provider: Arc<dyn ProviderAdapter>) -> World {
        turn_world_full(provider, Arc::new(NoMcp), Vec::new(), false, None, None, Arc::new(MockFileService::default()), false).await
    }
    /// [`turn_world`] whose sessions take their MCP tools from `mcp`, and whose registry resolves `connected` by name
    /// whatever the folder, as `McpAwareResolver` resolves a ready server's tool (`McpHub::tool_in`); `lead`: the turn
    /// settings are a Lead surface host's (`LeadSurfaceHost`, the MCP fold and the refresh every call starts with) over the world's threads.
    #[cfg(node_twin)]
    async fn turn_world_with(provider: Arc<dyn ProviderAdapter>, mcp: Arc<dyn super::super::session_tools::SessionMcp>, connected: Vec<Arc<dyn Tool>>, lead: bool) -> World {
        turn_world_full(provider, mcp, connected, lead, None, None, Arc::new(MockFileService::default()), false).await
    }
    /// [`turn_world`] over `threads` (the rig's memory store when `None`) with `pool` as the tool pool (`list` and `Skill`
    /// when `None`).
    #[cfg(node_twin)]
    async fn turn_world_over(provider: Arc<dyn ProviderAdapter>, threads: Option<Arc<dyn mixdog_core_session::session::ThreadStore>>, pool: Option<Vec<Arc<dyn Tool>>>) -> World {
        turn_world_full(provider, Arc::new(NoMcp), Vec::new(), false, threads, pool, Arc::new(MockFileService::default()), false).await
    }
    /// [`turn_world`] over the tools `pool` and the file service `files` its tools read and write through; with
    /// `header_surfaces` the tool surface of a thread is the one its header names (`HeaderToolSurfaces`), not the rig's empty one.
    #[cfg(node_twin)]
    async fn turn_world_files(provider: Arc<dyn ProviderAdapter>, pool: Vec<Arc<dyn Tool>>, files: Arc<dyn mixdog_core_api::domain::fs::FileService>, header_surfaces: bool) -> World {
        turn_world_full(provider, Arc::new(NoMcp), Vec::new(), false, None, Some(pool), files, header_surfaces).await
    }
    #[allow(clippy::too_many_arguments)]
    async fn turn_world_full(
        provider: Arc<dyn ProviderAdapter>,
        mcp: Arc<dyn super::super::session_tools::SessionMcp>,
        connected: Vec<Arc<dyn Tool>>,
        lead: bool,
        threads: Option<Arc<dyn mixdog_core_session::session::ThreadStore>>,
        pool: Option<Vec<Arc<dyn Tool>>>,
        files: Arc<dyn mixdog_core_api::domain::fs::FileService>,
        header_surfaces: bool,
    ) -> World {
        turn_world_at(provider, mcp, connected, lead, threads, pool, files, header_surfaces, Arc::new(Fixed), Arc::new(Config), false, None).await
    }
    /// [`turn_world_full`] whose services read `clock` and whose run settings are `config`'s; with
    /// `summaries_on_turn_registry` a compaction's summary goes to the turn's own provider and reads its saved requests.
    #[allow(clippy::too_many_arguments)]
    async fn turn_world_at(
        provider: Arc<dyn ProviderAdapter>,
        mcp: Arc<dyn super::super::session_tools::SessionMcp>,
        connected: Vec<Arc<dyn Tool>>,
        lead: bool,
        threads: Option<Arc<dyn mixdog_core_session::session::ThreadStore>>,
        pool: Option<Vec<Arc<dyn Tool>>>,
        files: Arc<dyn mixdog_core_api::domain::fs::FileService>,
        header_surfaces: bool,
        clock: Arc<dyn Clock>,
        config: Arc<dyn super::super::host_seams::ConfigSeams>,
        summaries_on_turn_registry: bool,
        first_auto_effort: Option<Arc<super::super::auto_effort::TurnAutoEffort>>,
    ) -> World {
        let workspace = tempfile::tempdir().unwrap();
        let rig = Rig::new();
        let tokens = mixdog_rt::testing::tokens();
        let ledger = Arc::new(Ledger::default());
        let sink: Arc<dyn mixdog_ai::registry::accounting::UsageSink> = ledger.clone();
        let accounting = mixdog_ai::registry::accounted::AccountingDeps::new(Arc::new(Pricing), Arc::new(move || Some(sink.clone())));
        let mut pool: Vec<Arc<dyn Tool>> = pool.unwrap_or_else(|| vec![named("list"), named("Skill")]);
        // A Lead world's bridge sessions reach their deferred tools through the product's `call_tool`.
        let late_catalog = Arc::new(LateCatalog::default());
        if lead {
            pool.push(Arc::new(mixdog_tools::orch::bridge::CallTool::new(late_catalog.clone(), Arc::new(Unprojected))));
        }
        let processes: Arc<dyn mixdog_core_api::domain::process::ProcessManager> = Arc::new(MockProcessManager::default());
        let connectors: Arc<dyn mixdog_tools::policy::ConnectorPermissions> = mixdog_mcp::permissions::ConnectorPolicy::new(
            workspace.path().to_path_buf(),
            mixdog_mcp::permissions::PolicyIo { maintenance: tokens.maintenance_io, interactive: tokens.interactive_io, durability: tokens.durability_io },
        );
        let data = workspace.path().join("data");
        let judge = mixdog_services::effort_judge::judge::EffortJudgeModel::with_options(
            mixdog_services::effort_judge::model::ModelConfig::in_data_dir(&data, mixdog_services::effort_judge::model::OrtRuntime::Library(workspace.path().join("no-ort.dll"))),
            mixdog_services::effort_judge::JudgeLanes::of(&tokens),
            mixdog_services::effort_judge::judge::JudgeOptions::default(),
        )
        .unwrap();
        let store = Arc::new(super::super::side_question_store::SideQuestionStore::new());
        let registry = Arc::new(mixdog_ai::registry::providers::ProviderRegistry::new(Arc::new(OneProvider(provider.clone()))).with_accounting(accounting));
        let compaction = if summaries_on_turn_registry {
            super::super::compaction_world::tests::services_over(workspace.path(), json!({}), Arc::default(), store.clone(), registry.clone(), serde_json::Map::new()).await
        } else {
            super::super::compaction_world::tests::services(workspace.path(), json!({}), Arc::default()).await
        };
        let hook_bus = mixdog_mcp::hook_bus::HookBus::new(data.clone(), tokens.maintenance_io, processes.clone(), None, None, None);
        let next = super::super::next_request_source::NextRequestSource::new();
        let (kept, side_store, side_next) = (store.clone(), store.clone(), next.clone());
        let liveness = mixdog_services::task_reports::runtime_state::RuntimeLiveness::new();
        let asked = Arc::new(AskedFor::default());
        let exclusions: Arc<mixdog_core_session::session::SessionToolExclusions> = Arc::default();
        let surfaces_from = exclusions.clone();
        #[cfg(node_twin)]
        let surfaces_from_catalog = exclusions.clone();
        let (compaction_docs, compaction_reader, compaction_facts, compaction_config) = (compaction.docs.clone(), compaction.reader.clone(), compaction.attachment_facts.clone(), compaction.config.clone());
        let compactors = Arc::new(super::super::compactors::SessionCompactors::new(Arc::new(super::super::compaction_world::ProcessCompactionWorld::new(compaction)), clock.clone()));
        // A world wired as the composition wires compaction (summaries on the turn's registry) also compacts a session on
        // `thread/compact/start` with the host's own manual pass, over the same compactor the turns use.
        let late = Arc::new(super::super::compose_parts::LateDirectory::default());
        let manual: Option<Arc<dyn mixdog_core_session::session::turn_ops::ManualCompaction>> = summaries_on_turn_registry.then(|| {
            let threads: Arc<dyn mixdog_core_ports::ports::threads::ThreadState> = Arc::new(super::super::compose_parts::LateThreads(late.clone()));
            Arc::new(super::super::manual_compaction::HostManualCompaction::new(super::super::manual_compaction::ManualParts {
                world: Arc::new(ManualWorld { threads: threads.clone(), window: 100_000 }),
                threads,
                config: config.clone(),
                compactors: compactors.clone(),
                directory: late.clone(),
                hooks: Arc::new(ManualNoHooks),
                gauge: Arc::new(ManualGauge),
                clock: clock.clone(),
                recover: Arc::new(|_| {}),
                io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
                data_dir: data.clone(),
                blobs: Arc::new(NoBlobs),
                reuses: Arc::default(),
            })) as Arc<dyn mixdog_core_session::session::turn_ops::ManualCompaction>
        });
        let parts = super::super::turn_path::TurnPathParts {
            tokens: tokens.clone(),
            clock: clock.clone(),
            paths: mixdog_store::paths::Paths { plugin_root: workspace.path().join("plugin"), data_dir: data },
            registry,
            effort_judge: judge,
            side: super::super::side_requests::SideRequests {
                store: kept,
                caching: Arc::new(|_, _| false),
                docs: compaction_docs,
                reader: compaction_reader,
                facts: compaction_facts,
                clock: clock.clone(),
            },
            next: next.clone(),
            files,
            processes,
            policy: Arc::new(mixdog_tools::policy::ToolPolicy::new(Arc::new(mixdog_tools::policy::MemoryGrantStore::default()), connectors.clone())),
            connectors,
            resolver: Arc::new(PoolResolver(pool.iter().chain(&connected).cloned().collect())),
            unattended: crate::run_host::unattended::UnattendedRunRegistry::new(Arc::new(NoStamps)),
            approvals: asked.clone(),
            exclusions,
            agents: Arc::new(mixdog_core_agents::agents::AgentDefinitions::new(workspace.path().join("shipped"), workspace.path().join("agents"), tokens.interactive_io, mixdog_core_config::config::AgentRoutes::new(compaction_config, workspace.path()), Arc::new(NoEvidence), Arc::new(|| json!({})), workspace.path())),
            allow_all: Arc::new(AllowNone),
            hub: (mixdog_mcp::McpHub::new(mixdog_mcp::McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io, cpu: tokens.cpu_bulk }, workspace.path().to_path_buf(), Default::default())),
            blobs: Arc::new(NoBlobs),
            tool_pool: pool,
            mcp: mcp.clone(),
            skills_listed: Arc::new(NoSkills),
            skill_names: Arc::new(NoSkillNames),
            skill_deliveries: None,
            ext_pool: Arc::new(mixdog_core_api::domain::mock::MockExtPool::new(4)),
            hook_bus,
            hook_common: Arc::new(|_| mixdog_mcp::hook_bus::HookCommon::default()),
            goals: Arc::new(rig.goals.clone()),
            todos: rig.todos.clone(),
            work: rig.work.clone(),
            config,
            settings: super::super::settings::SettingsSources { wiring: Arc::new(NoWiring), attachments: Arc::new(NoAttachmentText), media: None, heartbeats: Arc::new(NoMarks), ceilings: Arc::new(NoCeilings), auto_effort: Arc::new(AutoOff), first_auto_effort, vision: None },
            ladder: Arc::new(NoLadder),
            shells: None,
            liveness,
            search_usage: mixdog_tools::web::NativeSearchUsageSinks::new(),
            reuses: Arc::default(),
            deps: Box::new({
                // A world over a real store hosts a stored session: its surface is the production one, the header's tools.
                let production_surface = threads.is_some();
                let store = threads.unwrap_or_else(|| -> Arc<dyn mixdog_core_session::session::ThreadStore> { rig.store.clone() });
                let rig_deps = rig.deps_parts(store);
                move |runs| {
                    let mut deps = rig_deps;
                    deps.runs = runs;
                    if let Some(manual) = manual {
                        deps.compaction = manual;
                    }
                    if production_surface {
                        deps.surfaces = Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(Arc::new(mixdog_core_session::session::NoRouteExclusions)));
                    }
                    deps.side = Arc::new(super::super::side_question_store::SideQuestionService::new(side_store, side_next));
                    // A Lead world's sessions are judged by the surface the composition derives from the header (`compose_flip`).
                    if lead {
                        deps.surfaces = Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(surfaces_from));
                    } else if header_surfaces {
                        deps.surfaces = Arc::new(mixdog_core_session::session::HeaderToolSurfaces::new(Arc::new(mixdog_core_session::session::NoRouteExclusions)));
                    }
                    deps
                }
            }),
            compactors,
            hops: Box::new({
                let registry_dir = workspace.path().join("catalog");
                move |_directory, registry| {
                    let io = mixdog_ai::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
                    let metadata = mixdog_ai::catalog::ModelsDevSource::new(Arc::new(Offline), registry_dir, io);
                    let catalog = futures::executor::block_on(mixdog_ai::catalog::CatalogService::cold_start(mixdog_ai::catalog::CatalogSnapshot::default(), Vec::new(), metadata));
                    mixdog_core_run::run_host::hop_host::HopFactory::new(
                        mixdog_core_run::run_host::hop_host::HopDeps {
                            registry: registry.clone(),
                            catalog: Arc::new(catalog),
                            config: Arc::new(serde_json::Map::new),
                            bots: Arc::new(NoBots),
                            errors: Arc::new(|e| e.message.clone()),
                            wiring: Arc::new(NoWiring),
                        },
                        Arc::new(OpenHopSessions),
                    )
                }
            }),
        };
        let path = super::super::turn_path::TurnPath::new(parts).expect("turn path");
        // No provider is registered ahead: as after a restart, the turn's first request readies the thread's provider.
        assert!(path.registry.get("scripted").await.is_none());
        let directory = path.directory.clone();
        late.bind(&directory);
        // The settings host the composition binds: here one whose live settings are one key, `responseLanguage`, that a
        // turn start writes into the header when it moved (`settings`, empty: nothing moved).
        let settings = Arc::new(Mutex::new(serde_json::Map::new()));
        #[cfg(not(node_twin))]
        assert!(!lead, "a Lead surface host needs the recorded tool pool, which only the local comparison build has");
        #[cfg(not(node_twin))]
        assert!(path.turn_settings.bind(Arc::new(LiveSettings(directory.clone(), settings.clone()))).is_ok());
        #[cfg(node_twin)]
        {
        if lead {
            let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(directory.clone()));
            let host = super::super::surface_host::tests::lead_host_over(threads.clone(), threads.clone(), mcp);
            assert!(path.turn_settings.bind(Arc::new(host)).is_ok());
            // As `compose_flip` binds it: the directory's running headers, the Lead's exclusions, the bridge definitions.
            let catalog = super::super::session_catalog::SessionCatalog::new(directory.clone(), threads.clone(), threads, surfaces_from_catalog, Arc::new(super::super::surface_host::tests::Bridge(super::super::surface_host::tests::node_bridge())), clock.clone())
                .with_refresh(path.turn_settings.clone());
            assert!(late_catalog.0.set(Arc::new(catalog)).is_ok());
        } else {
            assert!(path.turn_settings.bind(Arc::new(LiveSettings(directory.clone(), settings.clone()))).is_ok());
        }
        }
        World {
            workspace,
            rig,
            ledger,
            asked,
            store,
            next,
            #[cfg(node_twin)]
            path,
            directory,
            #[cfg(node_twin)]
            settings,
        }
    }
    #[test]
    fn a_fresh_turn_at_saved_effort_supersedes_the_previous_turns_stamp() {
        use mixdog_agent::effort::{EffortMode, EffortRoute, EffortSnapshot, EffortWiring, ProjectingAdapter};

        let saved = EffortSnapshot {
            provider: "openai".into(), model: "gpt-6".into(), mode: EffortMode::Responses,
            initial_effort: "high".into(), effort: "medium".into(),
        };
        let previous = EffortSnapshot { effort: "high".into(), ..saved.clone() };
        let mut config = RunConfig::new(ThreadId::from("thread"), TurnId::from("turn"), "gpt-6");
        config.options.effort = Some("medium".into());
        config.effort = Some(EffortWiring {
            route: EffortRoute {
                provider: saved.provider.clone(), model: saved.model.clone(), mode: Some(saved.mode),
                allowed: vec!["medium".into(), "high".into()], seed: Some(saved),
                wire: Arc::new(|effort| Some(effort.to_owned())),
            },
            adapter: Arc::new(ProjectingAdapter::new(Arc::new(Scripted {
                id: ProviderId::from("openai"), policy: RetryPolicy::codex_default(), keepalive: KeepaliveSchedule::SPEC,
                codec: MockCodec, script: Mutex::default(), requests: Mutex::default(), fail_first: Default::default(),
            }))),
        });
        let mut row = json!({"role": "user", "content": "new question"});
        stamp_outgoing_effort(&mut row, &config);
        let mut earlier = AgentMessage::user("earlier question");
        earlier.effort = Some(previous);
        let messages = [earlier, AgentMessage::assistant("answer", Vec::new()), message_of(&row).unwrap()];
        let projection = config.effort.unwrap().route.project(&messages).unwrap();
        assert_eq!(projection.initial_effort, "high");
        assert_eq!(projection.updates.get(&2).map(String::as_str), Some("medium"));
    }

    #[tokio::test]
    async fn the_first_outbound_request_uses_judged_effort_without_changing_the_saved_route() {
        use super::super::auto_effort::{ConfigAutoEffort, EffortConfiguration, EffortDiagnostics, JudgeAnswer, TurnAutoEffort, TurnJudge, TurnJudgeInput};
        struct JudgeRoute;
        #[async_trait]
        impl EffortConfiguration for JudgeRoute {
            async fn configured(&self, _: &mixdog_store::schema::record::Header) -> bool { true }
        }
        #[async_trait]
        impl super::super::step_judge::LadderSources for JudgeRoute {
            fn cached_row(&self, _: &str, _: &str) -> Option<serde_json::Map<String, Value>> {
                json!({"reasoningLevels": ["low", "medium", "high"]}).as_object().cloned()
            }
            async fn rejected(&self, _: &str, _: &str) -> Option<mixdog_ai::effort::RejectionEntry> { None }
            fn custom_config(&self, _: &str) -> Option<(mixdog_ai::providers::custom::Protocol, String)> { None }
            fn anthropic_levels(&self, _: &str) -> Vec<String> { Vec::new() }
        }
        #[async_trait]
        impl TurnJudge for JudgeRoute {
            async fn judge(&self, input: TurnJudgeInput) -> JudgeAnswer {
                assert_eq!(input.request, "hard problem");
                JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 0 }
            }
        }
        impl EffortDiagnostics for JudgeRoute {
            fn record(&self, _: serde_json::Map<String, Value>) {}
            fn warn(&self, _: &str) {}
        }
        let root = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let (cfg, _) = mixdog_core_config::config::Config::open(
            root.path().join("config.json"),
            Arc::new(mixdog_core_api::mock::MockStatePublisher::default()),
            mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
        ).await.unwrap();
        let auto = Arc::new(TurnAutoEffort::new(
            Arc::new(ConfigAutoEffort::new(cfg, Arc::new(|name| (name == "MIXDOG_AUTO_EFFORT").then(|| "on".to_owned())))),
            Arc::new(JudgeRoute), Arc::new(JudgeRoute), Arc::new(JudgeRoute), Arc::new(JudgeRoute), Arc::new(String::new),
        ));
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![StreamEvent::TextDelta("answer".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let World { workspace, directory, ledger, .. } = turn_world_at(
            provider.clone(), Arc::new(NoMcp), Vec::new(), false, None, None,
            Arc::new(MockFileService::default()), false, Arc::new(Fixed), Arc::new(Config), false, Some(auto),
        ).await;
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.path() }), "op-start")).await.unwrap();
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().unwrap());
        let handle = directory.handle(&id).unwrap();
        handle.request(CoreRequest {
            method: Method("thread/header/patch"),
            params: json!({ "threadId": id, "set": { "provider": "scripted", "model": "m", "effort": "low" } }),
            op: None,
            ctx: CallContext::internal("test"),
        }).await.unwrap();
        handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "hard problem" } }), "op-1")).await.unwrap();
        eventually_on_awaiting(|| "the turn's usage record".to_owned(), &[&ledger.1], || (!lock(&ledger.0).is_empty()).then_some(())).await;
        assert_eq!(lock(&provider.requests)[0].options.effort.as_deref(), Some("high"));
        assert_eq!(handle.live_header().header()["effort"], "low");
    }

    /// The done-when turn: `TurnPath::new` over test implementations of the missing owner traits, a
    /// scripted provider behind the accounted registry, a tool call, the stored rows and the ledger row.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_turn_runs_through_the_turn_path() {
        let provider = Arc::new(Scripted {
            id: ProviderId::from("scripted"),
            policy: RetryPolicy::codex_default(),
            keepalive: KeepaliveSchedule::SPEC,
            codec: MockCodec,
            script: Mutex::new(VecDeque::from([
                vec![
                    StreamEvent::ToolCallDone(ToolCall { id: "c1".into(), name: "list".into(), arguments: json!({ "path": "." }), native_type: None }),
                    StreamEvent::Completed { stop: Some(StopReason::ToolUse), pricing_model: None, request_ms: None },
                ],
                vec![StreamEvent::TextDelta("listed".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
                // The side question's answer, then the answer after the saved request was forgotten.
                vec![StreamEvent::TextDelta(" it listed the path ".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
                vec![StreamEvent::TextDelta("rebuilt".into()), StreamEvent::Completed { stop: Some(StopReason::EndTurn), pricing_model: None, request_ms: None }],
            ])),
            requests: Mutex::new(Vec::new()),
            fail_first: std::sync::atomic::AtomicBool::new(false),
        });
        let World { workspace, rig, ledger, asked, store, directory, .. } = turn_world(provider.clone()).await;
        let reply = directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": workspace.path() }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = directory.handle(&id).expect("loaded");
        handle
            .request(CoreRequest {
                method: Method("thread/header/patch"),
                params: json!({ "threadId": id, "set": { "provider": "scripted", "model": "m" } }),
                op: None,
                ctx: CallContext::internal("test"),
            })
            .await
            .expect("route");
        let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        let Reply::Value(started) = started else { panic!("turn/start answers a value") };
        assert_eq!(started["kind"], "started");
        let roles = || -> Vec<String> {
            rig.store
                .records(&id)
                .into_iter()
                .filter_map(|(_, record)| match record {
                    Record::Item(item) => match item.body {
                        Slot::Inline(body) => body["role"].as_str().map(str::to_owned),
                        _ => None,
                    },
                    _ => None,
                })
                .collect()
        };
        eventually_on_awaiting(|| "the four-role transcript in the store and two usage rows in the ledger".to_owned(), &[&rig.store.committed, &ledger.1], || (roles().len() >= 4 && lock(&ledger.0).len() >= 2).then_some(())).await;
        assert_eq!(roles(), ["user", "assistant", "tool", "assistant"]);
        // The turn's two approval entry points (the policy gate and the tool environment a nested call is judged with) both went through the composition's choice.
        assert_eq!(*lock(&asked.0), [id.as_str(), id.as_str()]);
        let requests = lock(&provider.requests).clone();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[1].messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool]);
        let rows = lock(&ledger.0).clone();
        assert!(rows.iter().all(|r| r.provider == "scripted" && r.model == "m" && r.session_id == id.as_str()), "{rows:?}");

        // `thread/askSide` end to end: the real service forks the request the loop saved, on a scope of
        // its own, and the answer comes back trimmed without entering the transcript.
        let asked = handle.request(request("thread/askSide", json!({ "opId": "op-side", "question": " what did it list? " }), "op-side")).await.expect("thread/askSide");
        let Reply::Value(asked) = asked else { panic!("thread/askSide answers a value") };
        assert_eq!(asked["text"], "it listed the path");
        let requests = lock(&provider.requests).clone();
        let fork = requests.last().expect("the fork's request");
        assert_eq!(requests.len(), 3);
        assert_eq!(fork.messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool, Role::Assistant, Role::User], "the saved request, its reply, the question");
        assert!(fork.options.transport_scope.as_deref().is_some_and(|scope| scope.starts_with(&format!("{}#side:", id.as_str()))), "{:?}", fork.options.transport_scope);
        assert_eq!(roles(), ["user", "assistant", "tool", "assistant"], "the question never enters the transcript");
        assert_eq!(lock(&ledger.0).len(), 3, "the fork's usage row is the provider's own accounting row");

        // With no saved request (a restart, a forgotten one) the question forks the request the next turn
        // would send, rebuilt from the stored rows by the turn's own assembly.
        store.forget(&id);
        let rebuilt = handle.request(request("thread/askSide", json!({ "opId": "op-side-2", "question": "again?" }), "op-side-2")).await.expect("thread/askSide");
        let Reply::Value(rebuilt) = rebuilt else { panic!("thread/askSide answers a value") };
        assert_eq!(rebuilt["text"], "rebuilt");
        let requests = lock(&provider.requests).clone();
        let fork = requests.last().expect("the rebuilt fork");
        assert_eq!(fork.messages.iter().map(|m| m.role).collect::<Vec<_>>(), [Role::User, Role::Assistant, Role::Tool, Role::Assistant, Role::User]);
        assert_eq!((fork.model.as_str(), fork.options.session_id.as_deref()), ("m", Some(id.as_str())));
    }
    #[async_trait]
    impl mixdog_core_ports::ports::tools_status::SurfaceHost for Reconciling {
        fn mode(&self, _: Option<&mixdog_store::schema::record::Header>) -> String {
            "lead".into()
        }
        async fn preview(&self) -> Result<mixdog_tools::orch::status::StatusSurface, mixdog_core_api::CoreError> {
            Ok(mixdog_tools::orch::status::StatusSurface::default())
        }
        async fn reconcile_empty(&self, thread: &ThreadId) -> Result<(), mixdog_core_api::CoreError> {
            use mixdog_core_ports::ports::threads::ThreadState;
            let set = json!({ "settingsReconciledAt": 1 }).as_object().unwrap().clone();
            mixdog_core_session::session::thread_state::SessionThreads::new(self.0.clone())
                .patch_header(thread, set, Vec::new())
                .await
                .map_err(|_| mixdog_core_api::CoreError::ThreadNotFound { thread_id: thread.clone() })
        }
    }
    /// The production `tools/toolsStatus` service over the world's threads and its request source.
    fn tools_status(world: &World) -> mixdog_tools::orch::status::ToolsService {
        let threads = Arc::new(mixdog_core_session::session::thread_state::SessionThreads::new(world.directory.clone()));
        let surface = mixdog_core_ports::ports::tools_status::SessionToolStatus::new(threads, Arc::new(Reconciling(world.directory.clone()))).with_snapshots(world.next.clone());
        mixdog_tools::orch::status::ToolsService::new(Arc::new(surface))
    }
    /// The snapshot taken now, and the request the thread's next turn (`op`, prompt `go`) then hands the provider,
    /// encoded the same way.
    async fn snapshot_then_turn(
        world: &World,
        provider: &Arc<Handing>,
        heard: &mut tokio::sync::mpsc::UnboundedReceiver<Arc<ModelRequest>>,
        id: &ThreadId,
        handle: &Arc<mixdog_core_session::session::SessionHandle>,
        op: &str,
    ) -> (Value, Value) {
        let status = snapshot_call(&tools_status(world), id, "go").await;
        let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": op, "input": { "prompt": "go" } }), op)).await.expect("turn/start");
        let Reply::Value(started) = started else { panic!("turn/start answers a value") };
        assert_eq!(started["kind"], "started", "{op}");
        let sent = mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the request turn {op} hands the provider"))
            .expect("the provider is alive");
        let handed = super::super::request_snapshot::snapshot(&handle.live_header().header(), &**provider, &sent).expect("the sent request encodes");
        (status["requestSnapshot"].clone(), handed)
    }
    /// A thread with history: the snapshot is `nextMainRequest`'s, the stored header and transcript as they are with the
    /// asked user message after them, so for a thread whose settings did not move since (and a model whose rules give no
    /// tail reminder) it is the request the next turn sends. Taking it stores nothing.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_snapshot_of_a_thread_with_history_is_its_next_request() {
        let (provider, mut heard) = handing();
        let world = turn_world(provider.clone()).await;
        let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let covered_before = handle.header_snapshot().get("turnCoverage").cloned();
        let started = handle.request(request("turn/start", json!({ "threadId": id, "opId": "op-1", "input": { "prompt": "go" } }), "op-1")).await.expect("turn/start");
        assert!(matches!(started, Reply::Value(_)), "turn/start answers a value");
        mixdog_rt::time::timeout(Duration::from_secs(30), heard.recv()).await.unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the first turn's request")).expect("the provider is alive");
        settled_turns(&world, &id, &handle, 1, covered_before).await;
        let before = stored_state(&world, &id, &handle);
        let first = snapshot_call(&tools_status(&world), &id, "go").await;
        assert_eq!(stored_state(&world, &id, &handle), before, "the snapshot call wrote to the stored thread");
        let (snapshot, handed) = snapshot_then_turn(&world, &provider, &mut heard, &id, &handle, "op-2").await;
        assert!(snapshot.is_object(), "a thread with a conversation has a request");
        assert_eq!(first["requestSnapshot"], snapshot, "two snapshots of the same thread differ");
        assert_eq!(snapshot, handed, "the snapshot is not the request the next turn handed the provider");
    }
    /// `nextMainRequest` is null for a session with no user conversation (`side-question.mjs:67`), so is the snapshot:
    /// nothing is composed for it, and the thread's whole stored state (records, live header, accounting, files) is the
    /// same after the call as before it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_thread_with_no_conversation_has_no_snapshot_and_the_call_stores_nothing() {
        let (provider, _heard) = handing();
        let world = turn_world(provider).await;
        let (id, handle) = started_thread(&world, json!({ "provider": "scripted", "model": "m" })).await;
        let before = stored_state(&world, &id, &handle);
        let status = snapshot_call(&tools_status(&world), &id, "go").await;
        assert_eq!(status["requestSnapshot"], Value::Null, "Node's nextMainRequest is null without a user conversation");
        assert_eq!(stored_state(&world, &id, &handle), before, "the snapshot call wrote to the stored thread");
    }
    /// The composition of a turn: TurnPath::new over test implementations of the missing owner traits and the scripted
    /// provider behind the accounted registry.
    struct World {
        workspace: tempfile::TempDir,
        rig: Rig,
        ledger: Arc<Ledger>,
        asked: Arc<AskedFor>,
        store: Arc<super::super::side_question_store::SideQuestionStore>,
        next: Arc<super::super::next_request_source::NextRequestSource>,
        #[cfg(node_twin)]
        path: super::super::turn_path::TurnPath,
        directory: Arc<SessionDirectory>,
        /// The live settings a turn start brings the thread to ([`LiveSettings`]).
        #[cfg(node_twin)]
        settings: Arc<Mutex<serde_json::Map<String, Value>>>,
    }
    async fn started_thread(world: &World, header: Value) -> (ThreadId, Arc<mixdog_core_session::session::SessionHandle>) {
        let reply = world.directory.request(request("thread/start", json!({ "opId": "op-start", "kind": "task", "projectPath": world.workspace.path() }), "op-start")).await.expect("thread/start");
        let Reply::Subscribe(subscribe) = reply else { panic!("thread/start subscribes") };
        let id = ThreadId::from(subscribe.result["thread"]["id"].as_str().expect("thread id"));
        let handle = world.directory.handle(&id).expect("loaded");
        handle
            .request(CoreRequest { method: Method("thread/header/patch"), params: json!({ "threadId": id, "set": header }), op: None, ctx: CallContext::internal("test") })
            .await
            .expect("route");
        (id, handle)
    }
    /// Waits until `count` runs of the thread have completed in the store and the last turn's settlement is over: the
    /// coverage stamp is written before the Goal settlement comes back (`JobDone::GoalSettled`), and a turn started
    /// while the actor is still busy settling is queued. `covered_before` is the stamp before the turn started.
    async fn settled_turns(world: &World, id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>, count: usize, covered_before: Option<Value>) {
        let done = || world.rig.store.records(id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase == mixdog_store::schema::record::RunPhase::Completed)).count();
        let covered = || handle.header_snapshot().get("turnCoverage").cloned();
        eventually_on_awaiting(
            || format!("{count} completed runs of {}, the changed turnCoverage stamp and an idle actor", id.as_str()),
            &[&world.rig.store.committed, handle.stepped()],
            || (done() >= count && covered() != covered_before && !handle.turn_busy()).then_some(()),
        )
        .await;
    }
    /// The whole of what is stored for a thread and its session directory, as Debug text: every record of the store (header,
    /// transcript items, ends), the live header, the accounting rows, and every file under the workspace with its bytes.
    fn stored_state(world: &World, id: &ThreadId, handle: &Arc<mixdog_core_session::session::SessionHandle>) -> String {
        fn files(dir: &std::path::Path, out: &mut Vec<String>) {
            let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
            entries.sort();
            for path in entries {
                if path.is_dir() {
                    files(&path, out);
                } else {
                    out.push(format!("{}={:?}", path.display(), std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut on_disk = Vec::new();
        files(world.workspace.path(), &mut on_disk);
        format!("{:#?}\n{:#?}\n{:#?}\n{:#?}", world.rig.store.records(id), handle.live_header().header(), lock(&world.ledger.0), on_disk)
    }
}

/// Everything of a turn the host supplies. Owners are named where the real source is not in this
/// crate yet.
pub struct Assembled {
    /// The route's provider adapter, chosen by the registry (WP-AI-SVC) for the header's route
    /// (broker, wire route, credentials).
    pub provider: Arc<dyn ProviderAdapter>,
    /// The surface's tools (WP-TOOLS-ORCH / WP-MCP) and the call environment they share.
    pub tools: ToolSet,
    pub tool_env: ToolEnv,
    /// The policy gate (`PolicyGate`, WP-AGENT/WP-SANDBOX); the factory puts the review in front.
    pub gate: GateBuilder,
    /// The turn's final workspace, where the review baseline is taken.
    pub worktree: String,
    /// `RunConfig` from the route and settings: model, request options, limits, compaction,
    /// effort wiring, text-only handling, slot (the admission lease, `Held::run_yielded`),
    /// attachments. `thread_id`, `turn_id`, `signal` and `first_request_after` are set by the
    /// factory.
    pub config: RunConfig,
    pub clock: Arc<dyn Clock>,
    pub decider: Arc<dyn RetryDecider>,
    pub guards: Arc<dyn TurnGuards>,
    pub compactor: Option<Arc<dyn Compactor>>,
    pub route: Option<Arc<dyn RouteFallback>>,
    pub skills: Option<SkillsBuilder>,
    pub hooks: Option<Arc<dyn ToolHooks>>,
    pub reuse: Option<Arc<dyn ResultReuse>>,
    pub reactions: Option<Arc<dyn Reactions>>,
    /// Clears the session's react targets when the turn ends, however it ends.
    pub reaction_scope: Option<super::reactions::ReactionScope>,
    /// The run's stored bodies, empty: the factory registers the turn's context and commits in
    /// it; `reactions` reads its message facts from the same value.
    pub rows: Arc<StoredRows>,
    pub tail: Option<Arc<dyn TailReminder>>,
    pub side: Option<Arc<dyn mixdog_agent::env::SendTap>>,
    pub step_judge: Option<Arc<dyn mixdog_agent::step_effort::StepEffortJudge>>,
    pub artifacts: Option<Arc<dyn mixdog_agent::offload::ArtifactStore>>,
    pub images: Option<Arc<dyn mixdog_agent::offload::ImageCompactor>>,
    /// Where the turn's failed tool calls are recorded (`history/tool-failures.jsonl`).
    pub failures: Option<Arc<dyn mixdog_agent::env::ToolFailureLog>>,
    /// The attachment blob reader, for the display facts of a user row (a pasted text's body).
    pub blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    /// The guard state that outlives one ask (the session record).
    pub carry: RunCarry,
}
enum Job {
    /// A row, with its place among the run's shown reports.
    Commit(u64, ItemCommit, Option<RowPlace>),
    Compact(u64, mixdog_core_session::session::run::Compaction),
    /// A rewrite that is not a compaction: the model context restarts at these rows, with no divider.
    Rewound(u64, Vec<(ItemId, Value)>),
    Draft(u64, Value),
}
/// `TURN_CHECKPOINT_THROTTLE_MS` (`ask-turn-state.mjs:14`): streamed text is drafted at most this often; every other
/// change of the draft is written at once (`checkpoint.schedule(true)`).
const DRAFT_THROTTLE: std::time::Duration = std::time::Duration::from_millis(150);
/// When the draft was last written, and whether a throttled write is armed.
#[derive(Default)]
struct DraftClock {
    last: Option<tokio::time::Instant>,
    armed: bool,
}
/// `TranscriptSink` over the run's port: commits go to the actor in order on one task, which waits for no save (the actor
/// shows each as it takes it); their saves are told in the same order on another, which `durable` waits for. `Ticket(0)`
/// is the turn's input row, which the actor committed.
struct PortSink {
    jobs: Jobs,
    /// The last job the actor has taken.
    accepted: watch::Receiver<u64>,
    /// The last job whose save has ended, every one before it too.
    done: watch::Receiver<u64>,
    port: RunPort,
    rows: Arc<StoredRows>,
    live: LiveTurnPublisher,
    turn: Mutex<Vec<AgentMessage>>,
    /// The segments the shown assistant text belongs to, until its message commits.
    streaming: Arc<Mutex<Segments>>,
    iids: Mutex<HashMap<String, ItemId>>,
    clock: Arc<dyn Clock>,
    blobs: Arc<dyn mixdog_agent::compact::blob_reads::BlobReads>,
    /// A worker's turn hook (`onToolResult`): called with each tool result the turn gains.
    on_tool_result: Option<Arc<ToolResultCallback>>,
    /// What the turn's input row says of the turn, which its assistant rows repeat; `None` for an input row
    /// without transcript metadata.
    stamp: Option<TurnStamp>,
    /// The loop's counters, set by the host just before the turn's terminal reply commits
    /// (`appendAssistantTurnMessage` writes them on that message).
    terminal: Mutex<Option<(u32, u64)>>,
    applied: AppliedSkills,
    drafted: Mutex<DraftClock>,
}
/// The run's jobs in order, and the draft they take from: what a draft takes from `observed`, and an assistant commit
/// empties of it, is numbered and queued while `observed` is held, so no draft of a message lands after the message's row.
struct Jobs {
    /// `markAssistantMessageCommitted` empties it.
    observed: Arc<Mutex<Observed>>,
    seq: AtomicU64,
    tx: mpsc::UnboundedSender<Job>,
    /// The run's shown reports, which each row takes its place among (`None`: a sink that shows nothing).
    shown: Option<mpsc::UnboundedSender<Shown>>,
    /// Called once a draft's body is taken, before it is queued.
    #[cfg(any(test, feature = "test-support"))]
    taken: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}
impl Jobs {
    /// Queues what the draft gained since its last write.
    fn draft(&self) {
        let mut observed = lock(&self.observed);
        if let Some(body) = observed.undrafted() {
            #[cfg(any(test, feature = "test-support"))]
            if let Some(taken) = lock(&self.taken).take() {
                taken();
            }
            self.queue(&mut observed, |n| Job::Draft(n, body));
        }
    }

    /// Queues a row of the run (an assistant message's ends its draft), after the seal of the turn's reply if any.
    fn row(&self, assistant: bool, sealed: Option<Value>, item: ItemCommit) -> u64 {
        let mut observed = lock(&self.observed);
        if assistant {
            observed.message_committed();
        }
        if let Some(sealed) = sealed {
            self.queue(&mut observed, |n| Job::Draft(n, sealed));
        }
        // The rows and the shown reports reach the port on two tasks: the row takes its place among the reports here, after
        // every report the run produced before it ([`row_handover`]). A forwarder already gone drops the place at once.
        let place = self.shown.as_ref().map(|shown| {
            let (reached, place) = tokio::sync::oneshot::channel();
            let _ = shown.send(Shown::Row(reached));
            place
        });
        self.queue(&mut observed, |n| Job::Commit(n, item, place))
    }

    /// Numbers and queues one job; `_held` is the observed record, held by the caller.
    fn queue(&self, _held: &mut Observed, job: impl FnOnce(u64) -> Job) -> u64 {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.tx.send(job(n));
        n
    }
}
impl PortSink {
    fn spawn(
        port: RunPort,
        rows: Arc<StoredRows>,
        live: LiveTurnPublisher,
        state: SinkState,
        services: SinkServices,
        on_tool_result: Option<Arc<ToolResultCallback>>,
        initial: (Option<TurnStamp>, AppliedSkills),
        shown: mpsc::UnboundedSender<Shown>,
    ) -> Arc<Self> {
        let (streaming, observed) = state;
        let (clock, blobs) = services;
        let (stamp, applied) = initial;
        let (jobs, mut queue) = mpsc::unbounded_channel::<Job>();
        let (accepted_tx, accepted) = watch::channel(0u64);
        let (done_tx, done) = watch::channel(0u64);
        let (saves, mut saving) = mpsc::unbounded_channel::<(u64, Result<Queued, RunError>, &'static str)>();
        let worker = port.clone();
        // A row held for its place past the run's cancel is handed over on a port whose send outlives the token: it would have
        // gone before the cancel had the forwarder not held it, and the cancelled run's flush waits for its save.
        let unheld = port.closing();
        // The actor takes each job in order and shows it at once; it orders the writes itself (`outbox.rs`), so nothing here
        // waits for one before handing on the next.
        drop(mixdog_rt::spawn("run-commit", TaskClass::Work, turn_task(async move {
            while let Some(job) = turn_input(queue.recv()).await {
                let (n, queued, failed) = match job {
                    Job::Commit(n, item, place) => {
                        let queued = match row_handover(place).await {
                            Handover::Reached(handed) => {
                                let queued = worker.queue_item(item).await;
                                let _ = handed.send(());
                                queued
                            }
                            Handover::Unplaced => worker.queue_item(item).await,
                            Handover::Gone => unheld.queue_item(item).await,
                        };
                        (n, queued, "[session] message save failed")
                    }
                    Job::Compact(n, compaction) => (n, worker.queue_compacted(compaction).await, "[session] compaction save failed"),
                    Job::Rewound(n, replacement) => (n, worker.queue_context_rewound(replacement).await, "[session] context save failed"),
                    // Node reports a failed checkpoint write and goes on (`[turn-checkpoint] write failed`).
                    Job::Draft(n, body) => (n, worker.queue_draft(body).await, "[turn-checkpoint] write failed"),
                };
                accepted_tx.send_replace(n);
                let _ = saves.send((n, queued, failed));
            }
        })));
        let teller = port.clone();
        drop(mixdog_rt::spawn("run-commit-saves", TaskClass::Work, turn_task(async move {
            while let Some((n, queued, failed)) = turn_input(saving.recv()).await {
                // Node logs a failed session save and goes on (`ask-turn-state.mjs:107`, `session-lifecycle.mjs:522`).
                let saved = match queued {
                    Ok(queued) => teller.saved(queued).await,
                    Err(error) => Err(error),
                };
                if let Err(error) = saved {
                    tracing::warn!("{failed}: {error:?}");
                }
                done_tx.send_replace(n);
            }
        })));
        let jobs = Jobs {
            observed,
            seq: AtomicU64::new(0),
            tx: jobs,
            shown: Some(shown),
            #[cfg(any(test, feature = "test-support"))]
            taken: Mutex::default(),
        };
        Arc::new(Self { jobs, accepted, done, port, rows, live, turn: Mutex::new(Vec::new()), streaming, iids: Mutex::new(HashMap::new()), clock, blobs, on_tool_result, stamp, terminal: Mutex::new(None), applied, drafted: Mutex::new(DraftClock::default()) })
    }

    /// The run's draft changed (`checkpoint.schedule`): written now when `now` (a boundary) or when the last write is
    /// older than [`DRAFT_THROTTLE`], else once that much time has passed.
    fn draft(self: &Arc<Self>, now: bool) {
        let wait = {
            let mut clock = lock(&self.drafted);
            let at = tokio::time::Instant::now();
            match clock.last {
                Some(last) if !now && at < last + DRAFT_THROTTLE => {
                    if std::mem::replace(&mut clock.armed, true) {
                        return;
                    }
                    last + DRAFT_THROTTLE - at
                }
                _ => {
                    clock.last = Some(at);
                    drop(clock);
                    self.write_draft();
                    return;
                }
            }
        };
        let sink = self.clone();
        drop(tokio::spawn(async move {
            mixdog_rt::time::sleep(wait).await;
            {
                let mut clock = lock(&sink.drafted);
                clock.armed = false;
                clock.last = Some(tokio::time::Instant::now());
            }
            sink.write_draft();
        }));
    }

    /// Queues what the draft gained since its last write, in order with the run's rows.
    fn write_draft(&self) {
        self.jobs.draft();
    }

    /// What Node's loop and turn commit write on an assistant row besides its content: its id, time and
    /// route (`attachAssistantTranscriptMetadata`, `persistedAssistantTranscriptMetadata`), the tool-call
    /// message's `createdAt`, and on the terminal reply the loop's counters and the turn's completion
    /// (`appendAssistantTurnMessage`, `attachAssistantTranscriptCompletion`).
    fn stamp_assistant(&self, row: &mut Value, message: &AgentMessage, terminal: Option<(u32, u64)>) {
        let Some(stamp) = &self.stamp else { return };
        let Some(object) = row.as_object_mut() else { return };
        let now = self.clock.now_ms();
        if !message.tool_calls().is_empty() {
            object.insert("createdAt".into(), json!(now));
        }
        if let Some((iterations, tool_calls_total)) = terminal {
            object.insert("iterations".into(), json!(iterations));
            object.insert("toolCallsTotal".into(), json!(tool_calls_total));
        }
        let meta = object.entry("meta").or_insert_with(|| json!({}));
        if !meta.is_object() {
            *meta = json!({});
        }
        let transcript = meta.as_object_mut().expect("meta is an object").entry("transcript").or_insert_with(|| json!({}));
        if !transcript.is_object() {
            *transcript = json!({});
        }
        let transcript = transcript.as_object_mut().expect("transcript is an object");
        transcript.entry("messageId").or_insert_with(|| json!(self.message_id()));
        transcript.entry("at").or_insert_with(|| json!(now));
        for (key, value) in &stamp.carried {
            transcript.entry(key.clone()).or_insert_with(|| value.clone());
        }
        if terminal.is_some() && !mixdog_js::js_trim(&message.text()).is_empty() {
            let mut completion = json!({ "status": "done", "verb": stamp.verb, "elapsedMs": (now - stamp.started_at).max(0) });
            if let Some(checkpoint) = &stamp.checkpoint_id {
                completion["checkpointId"] = json!(checkpoint);
            }
            transcript.entry("completion").or_insert(completion);
        }
        // Node's key order: the tool-call message opens with `role, createdAt` (`buildToolCallAssistantMessage`), the
        // terminal reply puts its `meta` right after `content` (`appendAssistantTurnMessage`).
        let lead: &[&str] = if !message.tool_calls().is_empty() {
            &["role", "createdAt"]
        } else if terminal.is_some() {
            &["role", "content", "meta"]
        } else {
            &[]
        };
        if !lead.is_empty() {
            let mut ordered = serde_json::Map::new();
            for key in lead {
                if let Some(value) = object.shift_remove(*key) {
                    ordered.insert((*key).into(), value);
                }
            }
            ordered.append(object);
            *object = ordered;
        }
    }

    /// The input row and the context before it: known ids, and the turn's first live message.
    fn seed(&self, input: &AgentMessage) {
        let mut turn = lock(&self.turn);
        turn.push(input.clone());
        self.live.publish(&turn, &*self.rows);
    }

    fn iid_of(&self, message: &AgentMessage) -> ItemId {
        match &message.message_id {
            Some(id) => lock(&self.iids).entry(id.clone()).or_insert_with(new_item_id).clone(),
            None => new_item_id(),
        }
    }

    /// Every queued commit is durable (or failed).
    async fn flush(&self) {
        let last = self.jobs.seq.load(Ordering::SeqCst);
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= last).await;
    }
}
/// The compacted record's identities from the loop's report.
fn dropped_of(dropped: &mixdog_agent::env::Dropped) -> mixdog_core_session::session::run::Dropped {
    mixdog_core_session::session::run::Dropped { message_ids: dropped.message_ids.clone(), call_ids: dropped.call_ids.clone() }
}
// ---- the observer ------------------------------------------------------------------------------------

enum Shown {
    Section(mixdog_core_ports::ports::threads::Section),
    Started(ThreadItem),
    Delta(ItemId, String),
    ReasoningDelta(ItemId, String),
    ReasoningDone(ItemId, String),
    TextSettled(ItemId),
    Notice(String, mixdog_agent::env::Tone),
    Usage(mixdog_core_session::session::UsageReport),
    Compact(mixdog_agent::env::CompactEvent),
    Check(mixdog_core_session::session::run::SendCheck),
    Pass(Box<mixdog_agent::env::CompactPass>),
    ToolStream,
    CompactUsage(mixdog_core_session::session::CompactUsageReport),
    /// Answered once every report before it has reached the port.
    Barrier(tokio::sync::oneshot::Sender<()>),
    /// A row's place among the reports ([`Jobs::row`], [`row_handover`]): once every report before it has reached the port the
    /// forwarder answers it, then waits for the row's hand-over before it takes the reports after it.
    Row(tokio::sync::oneshot::Sender<tokio::sync::oneshot::Sender<()>>),
    /// A report whose media is prepared before it is sent ([`send_prepared`]): the preparation, started when the report was
    /// produced, answers the report.
    Prepared(Preparation),
    /// A hosted web search's spend, as `reportNativeWebSearchUsage` shapes it.
    SearchUsage(Value),
    /// A stage the client shows as its status, with its detail.
    Stage(String, Option<Value>),
    /// A step of the model call the spinner follows.
    Call(mixdog_core_session::session::run::CallMark),
    /// A call's result row, before its batch commits it: its card closes.
    EarlyResult(Value),
    ModelRequest(u32, mixdog_app_protocol::v2::thread::ModelRequestPhase, Option<Vec<Value>>),
    ToolBatch(u32, mixdog_app_protocol::v2::thread::ToolBatchPhase, Option<(u32, u32, u64)>),
}
/// A report's media preparation, owned by the run's forwarding for its whole life: the forwarder awaits it in the report's
/// place, and dropping it (the forwarder ended any way: the run's cancel, its task aborted or panicked, its channel closed,
/// with this queued or being awaited) ends the preparation. It is never detached.
struct Preparation(tokio::task::JoinHandle<Shown>);
impl Drop for Preparation {
    fn drop(&mut self) {
        self.0.abort();
    }
}
impl Future for Preparation {
    /// The prepared report; `None` when the preparation panicked.
    type Output = Option<Shown>;

    fn poll(self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Self::Output> {
        Pin::new(&mut self.get_mut().0).poll(cx).map(Result::ok)
    }
}
/// Hands the forwarder a report with media, its preparation (`RunPort::prepare_report`) started now, as the report is produced,
/// beside every other report's: the forwarder sends the report in its place once its own preparation is done
/// ([`Shown::Prepared`]). Once the forwarding is gone nothing is started (and a forwarder that goes between the check and the
/// send drops, so ends, the preparation it never took).
fn send_prepared(out: &mpsc::UnboundedSender<Shown>, port: &RunPort, shown: Shown) {
    if out.is_closed() {
        return;
    }
    let port = port.clone();
    let preparation = Preparation(mixdog_rt::spawn(
        "run-report-prepare",
        TaskClass::Work,
        turn_task(async move {
            match &shown {
                Shown::Usage(report) => port.prepare_report(&report.outgoing).await,
                Shown::Check(check) => port.prepare_report(&check.messages).await,
                Shown::Pass(pass) => {
                    port.prepare_report(&pass.request).await;
                    if let mixdog_agent::env::PassStage::Done { after, .. } = &pass.stage {
                        port.prepare_report(after).await;
                    }
                }
                _ => {}
            }
            shown
        }),
    ));
    let _ = out.send(Shown::Prepared(preparation));
}
/// The run's shown reports to the port, one at a time, in the order the run produced them. Per report it awaits only the
/// report's send and, for a report with media, the rest of that report's own preparation, already under way
/// ([`send_prepared`]). The run's cancel ends it, and what it still holds is dropped: a row's place ([`row_handover`]) and every
/// preparation ([`Preparation`]) with it.
fn spawn_forwarder(port: RunPort, mut shown_rx: mpsc::UnboundedReceiver<Shown>, cancel: tokio_util::sync::CancellationToken) -> tokio::task::JoinHandle<()> {
    mixdog_rt::spawn(
        "run-shown",
        TaskClass::Work,
        turn_task(async move {
            let forward = async {
                while let Some(mut shown) = turn_input(shown_rx.recv()).await {
                    if let Shown::Prepared(preparation) = shown {
                        match preparation.await {
                            Some(ready) => shown = ready,
                            // The preparation panicked: the report is not sent.
                            None => continue,
                        }
                    }
                    let _ = forward_report(&port, shown).await;
                }
            };
            let _ = cancel.run_until_cancelled(forward).await;
        }),
    )
}
/// Sends one report to the port; a report with media arrives here prepared.
async fn forward_report(port: &RunPort, shown: Shown) -> Result<(), RunError> {
    match shown {
        Shown::Section(section) => port.section(section).await,
        Shown::Started(item) => port.item_started(item).await,
        Shown::Delta(id, text) => port.delta(id, text).await,
        Shown::ReasoningDelta(id, text) => port.reasoning_delta(id, text).await,
        Shown::ReasoningDone(id, text) => port.reasoning_completed(id, text).await,
        Shown::TextSettled(id) => port.text_settled(id).await,
        Shown::Notice(text, tone) => port.notice(text, tone).await,
        Shown::Usage(report) => port.usage_prepared(report).await,
        Shown::Compact(event) => port.compact_event(event).await,
        Shown::Check(check) => port.send_check_prepared(check).await,
        Shown::SearchUsage(delta) => port.search_usage(delta).await,
        Shown::Stage(stage, detail) => port.stage(stage, detail).await,
        Shown::ModelRequest(index, phase, calls) => port.model_request(index, phase, calls).await,
        Shown::ToolBatch(index, phase, completed) => port.tool_batch(index, phase, completed).await,
        Shown::Call(mark) => port.call_mark(mark).await,
        Shown::EarlyResult(row) => port.early_result(row).await,
        Shown::Pass(pass) => port.compact_pass_prepared(pass).await,
        Shown::ToolStream => port.tool_stream().await,
        Shown::CompactUsage(report) => port.compact_usage(report).await,
        Shown::Barrier(done) => {
            let _ = done.send(());
            Ok(())
        }
        // Every report before the row is on the port: the row goes, and the reports after it wait for its hand-over.
        Shown::Row(reached) => {
            let (handed, on_port) = tokio::sync::oneshot::channel();
            if reached.send(handed).is_ok() {
                let _ = on_port.await;
            }
            Ok(())
        }
        // Unwrapped by the forwarder before it gets here.
        Shown::Prepared(_) => Ok(()),
    }
}
/// `RunObserver` over progress and the port: stage and stream marks feed the progress cell, shown
/// assistant text becomes `item/started` + `item/agentMessage/delta`.
struct PortObserver {
    observed: Arc<Mutex<Observed>>,
    progress: Arc<ProgressPublisher>,
    out: mpsc::UnboundedSender<Shown>,
    streaming: Arc<Mutex<Segments>>,
    /// The Reasoning item the thinking text streams into, until the model moves on to text,
    /// tool calls or its usage report.
    reasoning: Mutex<Option<(ItemId, String)>>,
    /// The tools of the latest request (`result.lastSendTools`).
    last_send_tools: Mutex<Vec<mixdog_core_api::domain::provider::ToolDefinition>>,
    /// The stream announces its chunks (`RunEvent::Chunk`): its deltas report no kind of their own.
    chunked: std::sync::atomic::AtomicBool,
    /// The turn's live messages, which an early tool notice joins until its result commits.
    live: LiveTurnPublisher,
    rows: Arc<StoredRows>,
    /// The run's token: once it is cancelled the interruption's record is closed (Node finalizes the interrupted turn in the
    /// abort's own step, so a call that settles after the abort is closed as cancelled).
    cancel: tokio_util::sync::CancellationToken,
    /// The session's conversation transcript (`onAssistantText` appends to it, `ask-callbacks.mjs:92`).
    transcript: Option<mixdog_core_session::session::transcript_writer::TurnTranscript>,
    /// The turn's provider requests so far (`model_request_<n>`, `tool_batch_<n>`).
    requests: std::sync::atomic::AtomicU32,
    /// The tool calls the current request's response streamed, `{ id, name, arguments }`.
    streamed_calls: Mutex<Vec<Value>>,
    /// The early notices of calls that settled while the request's batch had not started: `Some` from the request's start to
    /// its `onToolPhaseStarted`. A streamed read can settle before the loop reaches the batch; Node installs the batch's cards
    /// and starts the batch first, then applies the results that came early (`turn-tool-cards.mjs`).
    held_early: Mutex<Option<Vec<Value>>>,
    /// The batch's `task wait` calls not settled yet, by call id, with the task each waits on (`activeTaskWaitCallIds`).
    task_waits: Mutex<TaskWaits>,
    /// Writes the run's draft (`checkpoint.schedule`) as the record above changes.
    sink: Arc<PortSink>,
    /// The thread's model context, whose sensitive marks a tool batch's execution calls set.
    context: mixdog_core_session::session::run::ModelContext,
    agent_route: Option<(Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>, ThreadId)>,
}
impl PortObserver {
    /// Resolves once every report sent so far has been handed to the port.
    fn barrier(&self) -> tokio::sync::oneshot::Receiver<()> {
        let (done, reached) = tokio::sync::oneshot::channel();
        let _ = self.out.send(Shown::Barrier(done));
        reached
    }

    /// `visibleToolCalls` keeping `activeTaskWaitCallIds`, and `beginSessionTaskWait` for each: the batch's `task wait` calls
    /// are what the turn now waits on.
    fn open_task_waits(&self, calls: &[mixdog_core_api::domain::provider::ToolCall]) {
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
    fn settle_task_wait(&self, call_id: &str, generation: Option<u64>) {
        let mut waits = lock(&self.task_waits);
        let generation = generation.unwrap_or(waits.generation);
        let closed = waits.settle(call_id, generation);
        #[cfg(any(test, feature = "test-support"))]
        SETTLED_HOOKS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().filter(|(id, _)| id == call_id).for_each(|(_, signal)| signal.notify_one());
        let Some(task) = closed else { return };
        self.progress.task_wait(false, task.as_deref());
        if waits.open.is_empty() {
            let _ = self.out.send(Shown::Call(mixdog_core_session::session::run::CallMark::TaskWait(false)));
        }
    }

    /// Node's early notice, `recordToolResult`: the interruption keeps it, and the card completes now in the live turn rows, in
    /// completion order, until the call-order result commits. `generation` is the send its call was issued in, `None` for the
    /// send running.
    fn early_notice(&self, generation: Option<u64>, message: AgentMessage) {
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
        if !self.cancel.is_cancelled() {
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
    fn model_progress(&self, kind: ProgressKind) {
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
    fn settle_text(&self) {
        if let Some(id) = lock(&self.streaming).close() {
            let _ = self.out.send(Shown::TextSettled(id));
        }
    }

    fn reasoning(&self, text: String) {
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
    fn end_reasoning(&self) {
        let done = lock(&self.reasoning).take();
        if let Some((id, text)) = done {
            let _ = self.out.send(Shown::ReasoningDone(id, text));
        }
    }
    fn text(&self, text: String) {
        // An empty delta opens no segment: a segment is text shown.
        if text.is_empty() {
            return;
        }
        let (id, opened) = lock(&self.streaming).extend(&text);
        if opened {
            let item = ThreadItem::AgentMessage { id: id.clone(), text: MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: ItemMeta::default() };
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
                if !self.chunked.load(std::sync::atomic::Ordering::Relaxed) {
                    self.progress.stream_delta(StreamKind::Text);
                }
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
                if !self.chunked.load(std::sync::atomic::Ordering::Relaxed) {
                    self.progress.stream_delta(StreamKind::Text);
                }
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
                if !self.chunked.load(std::sync::atomic::Ordering::Relaxed) {
                    self.progress.stream_delta(StreamKind::Reasoning);
                }
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
                let _ = self.out.send(Shown::ModelRequest(index, mixdog_app_protocol::v2::thread::ModelRequestPhase::Completed, (!calls.is_empty()).then_some(calls)));
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
                let _ = self.out.send(Shown::CompactUsage(mixdog_core_session::session::CompactUsageReport { iteration, usage, reasoning_tokens, reasoning_tokens_complete, input_excludes_cache }));
            }
            RunEvent::ToolStream(kind) => self.model_progress(kind),
            RunEvent::Transport => self.progress.stream_delta(StreamKind::Transport),
            RunEvent::Boundary { submission, attempt, boundary } => self.progress.boundary(submission, attempt, boundary),
            RunEvent::SubmissionStarted { id } => self.progress.submission_started(id),
            RunEvent::Chunk(kind) => {
                self.chunked.store(true, std::sync::atomic::Ordering::Relaxed);
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
                let context = mixdog_app_protocol::v2::thread::ThreadContext { context_window: window, display_context_window: window, auto_compact_token_limit: positive(trigger_tokens), compact_boundary_tokens: positive(boundary_tokens), ..Default::default() };
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
            RunEvent::EarlyResult(message) => self.early_notice(None, message),
            _ => {}
        }
    }

    fn send_generation(&self) -> u64 {
        lock(&self.task_waits).generation
    }

    fn early_result_of(&self, generation: u64, message: AgentMessage) {
        self.early_notice(Some(generation), message);
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
struct SensitiveFailures {
    inner: Arc<dyn mixdog_agent::env::ToolFailureLog>,
    context: mixdog_core_session::session::run::ModelContext,
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
/// `finalizeCancelledTurn` (`ask-turn-failure.mjs`): the transcript of a stopped turn as `finalizeInterruptedTurn`
/// leaves it for the stop's reason: the partial reply, every unanswered call closed as cancelled, the interruption
/// line, and `sentRequestTail` on the message the request ended with; a user cancel that produced nothing hands the
/// prompt back (it leaves the context), a kept prompt or a non-user stop keeps it. The new rows are committed and the
/// model context restarts on the finalized transcript, which also drops the provider's continuation.
async fn close_cancelled(
    port: &RunPort,
    sink: &PortSink,
    rows: &StoredRows,
    history: &[(ItemId, HistoryRow)],
    input: (&ItemId, &str),
    observed: &Mutex<Observed>,
    reason: mixdog_agent::interrupt::AbortReason,
) {
    use mixdog_agent::compact::execution_tail::MessageRows as _;
    use mixdog_agent::interrupt::{finalize_interrupted_turn, Interrupted, Phase};
    let (input_item, input_text) = input;
    let seen = std::mem::take(&mut *lock(observed));
    let mut known: Vec<(ItemId, AgentMessage)> = history.iter().map(|(iid, row)| (iid.clone(), row.message())).collect();
    for (index, message) in lock(&sink.turn).iter().enumerate() {
        known.push((if index == 0 { input_item.clone() } else { sink.iid_of(message) }, message.clone()));
    }
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript: known.iter().map(|(_, message)| message.clone()).collect(),
        current_user_text: input_text.to_owned(),
        response_started: seen.started,
        partial_assistant: seen.text,
        partial_reasoning: seen.reasoning,
        observed_tool_calls: seen.calls,
        observed_tool_results: seen.results,
        phase: if seen.tools { Phase::Tools } else { Phase::Streaming },
        reason,
    });
    // A user cancel that produced nothing hands the prompt back: the rewind record at its row.
    if !finalized.user_turn_preserved {
        if let Err(error) = port.prompt_rewound(input_item.clone()).await {
            tracing::warn!("[session] rewound prompt save failed: {error:?}");
        }
        return;
    }
    let mut replacement: Vec<(ItemId, Value)> = Vec::new();
    for (index, message) in finalized.transcript.iter().enumerate() {
        let mut body;
        let iid;
        if let Some((known_iid, _)) = known.get(index).filter(|(_, was)| was == message) {
            iid = known_iid.clone();
            body = rows.row(message);
        } else {
            // The shown reply is the item of the partial text it ends as, with the segments it was shown as.
            let shown = if message.role() == Role::Assistant { lock(&sink.streaming).take() } else { None };
            body = row_of(message);
            iid = match shown {
                Some((iid, named)) => {
                    with_shown(&mut body, named);
                    iid
                }
                None => new_item_id(),
            };
            rows.record(message, body.clone());
            let role = match message.role() {
                Role::Assistant => "assistant",
                Role::Tool => "tool",
                _ => "user",
            };
            let item = ItemCommit { iid: iid.clone(), role: Some(role.to_owned()), model: true, visible: message.role() != Role::User, body: body.clone(), prompt: None };
            if let Err(error) = port.commit_item(item).await {
                tracing::warn!("[session] interrupted turn row save failed: {error:?}");
            }
        }
        if finalized.sent_request_tail == Some(index) && let Some(object) = body.as_object_mut() {
            let meta = object.entry("meta").or_insert_with(|| json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert("sentRequestTail".into(), Value::Bool(true));
            }
        }
        replacement.push((iid, body));
    }
    if let Err(error) = port.context_rewound(replacement).await {
        tracing::warn!("[session] interrupted turn context save failed: {error:?}");
    }
}
#[async_trait]
impl mixdog_agent::env::McpCatalog for ThreadMcp {
    async fn refresh(&self) {
        if let Err(error) = self.parts.refresh_mcp(&self.thread).await {
            tracing::warn!("[mcp] catalog refresh failed: {error:?}");
        }
    }

    async fn tools(&self) -> Result<Option<ToolSet>, String> {
        let surface = self.surface.borrow().clone();
        self.parts.request_tools(&self.thread, &surface).await.map_err(|error| error.message)
    }

    async fn snapshot(&self, tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>, messages: &[AgentMessage]) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, String> {
        self.parts.request_snapshot(&self.thread, tools, native_searches(messages)).await.map_err(|error| error.message)
    }

    async fn migrate(&self, messages: &[AgentMessage]) -> Result<Option<Vec<AgentMessage>>, String> {
        let rows = messages.iter().map(super::message_row::row_of).collect();
        self.parts.migrate_exposure(&self.thread, rows).await.map_err(|error| error.message)
    }
}


/// What a turn's host assembly reads from the turn.
pub struct AssembleInput<'a> {
    pub thread: &'a ThreadId,
    pub turn: &'a TurnId,
    /// The session header as acked at turn start.
    pub header: &'a mixdog_store::schema::record::Header,
    pub surface: Arc<SessionSurface>,
    pub port: &'a RunPort,
    /// The session's live tool surface (the gate reads it per call).
    pub surface_rx: tokio::sync::watch::Receiver<Arc<SessionSurface>>,
    /// The agent lane's admission lease of an agent-owned turn (`TurnRequest.slot`), held for the
    /// whole turn; `RunConfig.slot`.
    pub slot: Option<Arc<dyn mixdog_agent::env::Yielder>>,
    /// The trusted text a routine's skill is selected from (`AgentTurn.skill_selection`).
    pub skill_selection: Option<String>,
    /// The session's stored rows before the turn's input.
    pub prior: &'a [Value],
    /// The generation of the history `prior` is, read with it.
    pub generation: u64,
    /// The turn's prompt text, trimmed.
    pub request: &'a str,
    /// A runtime-injected turn (a completion notice, queued work), not a user's prompt.
    pub injected: bool,
    pub cancel: &'a tokio_util::sync::CancellationToken,
    /// No person is attached to the turn ([`RunStart::unattended`]): a Stop hook's block does not continue it.
    pub unattended: bool,
    /// The worker turn's own completion hook (`AgentTurn.hooks.notify`): `assemble` puts it on the
    /// `ToolEnv`, so it reaches every tool call. `None` for a turn no job owns.
    pub notify: Option<mixdog_core_api::domain::tool::ToolNotify>,
    /// Where the run's tools report progress: `ToolEnv.progress` (the run's own sink, built by the
    /// factory over the session cell's progress value).
    pub progress: Arc<dyn mixdog_core_api::domain::tool::ProgressSink>,
}
#[async_trait]
pub trait RunParts: Send + Sync + 'static {
    /// The turn's host parts; a refusal fails the turn with its error.
    async fn assemble(&self, input: AssembleInput<'_>) -> Result<Assembled, TurnError>;

    /// `reconcileTurnSettings`: the header the turn is built from, once the thread's settings follow the
    /// live ones (`conversation`: the thread already holds one, so it keeps its prefix; `header` is what
    /// the turn started with).
    async fn reconcile_turn(&self, thread: &ThreadId, header: mixdog_store::schema::record::Header, conversation: bool) -> Result<mixdog_store::schema::record::Header, TurnError>;

    /// `refreshDeferredMcpToolCatalog(session)`: the thread's MCP catalog follows the live registry. Run by the
    /// loop at each request boundary and around each tool call; a host with no MCP catalog has nothing to refresh.
    async fn refresh_mcp(&self, _thread: &ThreadId) -> Result<(), TurnError> {
        Ok(())
    }

    /// `currentAgents()`: the agents the thread's Lead may delegate to now, for the turn's agent list reminder;
    /// `None` for a thread that gets none (an agent's own, a bot's).
    async fn current_agents(&self, _thread: &ThreadId, _header: &mixdog_store::schema::record::Header) -> Result<Option<Vec<super::turn_reminders::AgentEntry>>, TurnError> {
        Ok(None)
    }

    /// `orchestrationInstructions(mode)`: the text a carried orchestration mode notice ends with.
    async fn orchestration_instructions(&self, _mode: &str) -> Result<String, TurnError> {
        Err(TurnError { message: "this host has no orchestration instructions".to_owned(), data: json!({}), provider_error: None })
    }

    /// The thread's tools as its session holds them now (`session.tools`, after a refresh): the request boundary
    /// adopts their changed MCP definitions. A host with no MCP catalog keeps the run's set.
    async fn request_tools(&self, _thread: &ThreadId, _surface: &SessionSurface) -> Result<Option<ToolSet>, TurnError> {
        Ok(None)
    }

    /// `snapshotProviderRequestTools` over `tools` and the native tool searches (`nativeToolSearch`) of the
    /// transcript the request is built from; a host with no deferred catalog keeps `tools`.
    async fn request_snapshot(&self, _thread: &ThreadId, tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>, _native: Vec<Value>) -> Result<Vec<mixdog_core_api::domain::provider::ToolDefinition>, TurnError> {
        Ok(tools)
    }

    /// `migrateToolExposureAtBoundary` over the transcript `rows` the request is built from: the system messages of
    /// the migrated thread, `None` when nothing migrated. A host with no deferred surface migrates nothing.
    async fn migrate_exposure(&self, _thread: &ThreadId, _rows: Vec<Value>) -> Result<Option<Vec<AgentMessage>>, TurnError> {
        Ok(None)
    }

    /// `getHiddenAgent(agent).stallCap.idleSeconds`: an internal agent's own idle budget, which
    /// the progress watchdog honours.
    fn stall_cap_idle_seconds(&self, _agent: Option<&str>) -> Option<i64> {
        None
    }

    /// `readAgentFirstResponseTimeoutMs(agent)`: the agent definition's own first-response
    /// deadline for the progress watchdog.
    async fn first_response_timeout_ms(&self, _agent: &str) -> Option<i64> {
        None
    }

    /// `armTurnShellReap` / `reapTurnShellJobs`: the progress watchdog stopped the turn, so the
    /// background shells it started at or after `since_ms` are stopped with it.
    fn reap_turn_shells(&self, _thread: &ThreadId, _since_ms: i64) {}

    /// `resetTurnShellReap`: a new turn owns the thread; nothing earlier is reported for it.
    fn reset_turn_shells(&self, _thread: &ThreadId) {}

    /// `recordAppliedSkills`: the skills a turn's prompt loaded, stamped on the thread's durable row `item`. A host
    /// with no session store has nothing to stamp.
    async fn record_applied_skills(&self, _thread: &ThreadId, _item: &ItemId, _names: &[String]) -> Result<(), TurnError> {
        Ok(())
    }
}
impl RunFactory for RunHostFactory {
    fn start(&self, run: RunStart) -> Pin<Box<dyn Future<Output = RunOutcome> + Send>> {
        let (parts, liveness, search_usage) = (self.parts.clone(), self.liveness.clone(), self.search_usage.clone());
        let before_loop = BeforeLoop { port: run.port.clone(), input_item: run.input_item.clone(), input_body: run.input_body.clone(), cancel: run.cancel.clone(), signal: run.signal.clone(), asked: Arc::default() };
        Box::pin(async move {
            let outcome = drive(parts, liveness, search_usage, run, before_loop.asked.clone()).await;
            before_loop.settle(outcome).await
        })
    }

    fn crashed(&self, run: mixdog_core_session::session::CrashedRun) -> mixdog_core_session::session::CrashedRows {
        crashed_rows(run)
    }
}
/// The session's history read back from its store for a run whose transcript a rewrite it did not make retired: once every
/// row the run queued has landed, the stored rows as the turn's start reads them (each registered with the run's sink, so a
/// later rewrite names its item), with the generation of the history they are.
struct ReloadedHistory {
    sink: Arc<PortSink>,
    context: mixdog_core_session::session::run::ModelContext,
    /// The run's gate: its session's book is open, and its generation is the history's.
    gate: mixdog_core_api::domain::cache_tail::TailGateHandle,
}

#[async_trait]
impl mixdog_agent::env::StoredHistory for ReloadedHistory {
    async fn reload(&self) -> Result<(Vec<AgentMessage>, u64), String> {
        TranscriptSink::drafted(&*self.sink).await;
        let generation = self.gate.0.generation();
        let stored = self.context.read().await.map_err(|error| format!("model context unreadable: {error:?}"))?;
        let mut messages = Vec::new();
        for (iid, body) in stored {
            let message = mixdog_agent::message_row::message_of_owned(body).map_err(|(error, _)| format!("the model context holds a row this build cannot read: {error}"))?;
            if messages.is_empty() && is_stale_system_row(&message) {
                continue;
            }
            if let Some(id) = &message.message_id {
                lock(&self.sink.iids).insert(id.clone(), iid);
            }
            self.sink.rows.record_stored(&message);
            messages.push(message);
        }
        Ok((messages, generation))
    }
}

#[async_trait]
impl TranscriptSink for PortSink {
    async fn commit(&self, message: &AgentMessage) -> Result<Ticket, CommitError> {
        // A save writes the throttled draft first (the transcript snapshot hook's `flushNow`): a crash at the row's write
        // leaves what streamed of it.
        self.write_draft();
        let mut row = row_of(message);
        let mut terminal = None;
        if message.role() == Role::Assistant {
            terminal = lock(&self.terminal).take();
            self.stamp_assistant(&mut row, message, terminal);
        }
        // Node hides a row by what it is: a user row the transcript shows nothing for (a hook or
        // skill note, internal text) is not visible; a card or cancel line is written into its meta.
        // and the row that counts for prompt history carries its display text.
        let (row, visible, prompt) = if message.role() == Role::User {
            // The facts read the attachment store (paste line counts, offloaded prompt bodies): the
            // read runs on the store's lane and this task awaits its answer.
            let lane_row = row.clone();
            let read = with_blobs(&*self.blobs, move |blobs| {
                let mut classified = lane_row;
                let facts = row_facts(&mut classified, &mut UserText::new(blobs));
                (classified, facts)
            })
            .await;
            // A store that cannot run the read is an error of the commit: nothing is queued.
            let (row, facts) = read.map_err(|_| CommitError::StoreUnavailable)?;
            let (visible, prompt) = facts.map_or((true, None), |facts| (facts.visible, facts.prompt));
            (row, visible, prompt)
        } else {
            (row, true, None)
        };
        // The segments the reply was shown as: its row names them, so the transcript shows the same rows, live and on reload.
        let shown = if message.role() == Role::Assistant { lock(&self.streaming).take() } else { None };
        let (shown, mut named) = match shown {
            Some((iid, named)) => (Some(iid), named),
            None => (None, serde_json::Map::new()),
        };
        // A reply that ends the turn is its own text (Node's final row is `content`): the updates shown ahead of a tool call
        // stay with that call's row, the ones ahead of the answer go as the answer lands.
        if message.message.tool_calls.is_empty() {
            named.remove("shownText");
        }
        let mut row = row;
        with_shown(&mut row, named);
        self.rows.record(message, row.clone());
        if message.role() == Role::Tool {
            // The authoritative result is in the transcript now: an early notice of it is no longer pending
            // (`recordToolResult` deletes it).
            if let Some(id) = message.tool_call_id() {
                lock(&self.jobs.observed).results.retain(|early| early.tool_call_id() != Some(id));
            }
            if let Some(hook) = &self.on_tool_result {
                hook(&mixdog_agent::agent_tool::flow::seams::ToolResultMessage { ui_diff: message.ui_diff.clone() });
            }
        }
        {
            let mut turn = lock(&self.turn);
            turn.push(message.clone());
            self.live.publish(&turn, &*self.rows);
        }
        // The shown item is the message's item: a later rewrite of the context names it by this id.
        if let (Some(id), Some(iid)) = (&message.message_id, &shown) {
            lock(&self.iids).insert(id.clone(), iid.clone());
        }
        let role = match message.role() {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
            Role::Developer => "developer",
        };
        // The turn's final reply seals its draft first (`sealed` checkpoint), durable before the row is sent: a turn whose
        // reply row then fails to land is still recovered finished.
        let sealed = terminal.is_some().then(|| json!({ "sealed": row.clone() }));
        let item = ItemCommit { iid: shown.unwrap_or_else(|| self.iid_of(message)), role: Some(role.to_owned()), model: true, visible, body: row, prompt };
        Ok(Ticket(self.jobs.row(message.role() == Role::Assistant, sealed, item)))
    }

    fn replace(&self, messages: &[AgentMessage], rewrite: &mixdog_agent::env::Rewrite) {
        // The run's leading system messages are the header's prompt (`system_messages`, put before the stored rows by `drive`),
        // not context rows: the next turn's request carries one system set, as `adoptCompactedTranscript` leaves one.
        let replacement: Vec<(ItemId, Value)> =
            messages.iter().skip_while(|m| m.role() == Role::System).map(|m| (self.iid_of(m), row_of(m))).collect();
        // Only a compaction pass writes a compaction record (and its divider, which an agent-mode session never shows).
        // Node splices any other rewrite into `state.messages` in place (`route-fallback.mjs:161` for a route's replay
        // strip): the context restarts silently.
        if !rewrite.compaction {
            self.jobs.queue(&mut lock(&self.jobs.observed), |n| Job::Rewound(n, replacement));
            return;
        }
        let compaction = mixdog_core_session::session::run::Compaction { replacement, at: self.clock.now_ms(), dropped_count: rewrite.dropped_count, dropped: rewrite.dropped.as_ref().map(dropped_of) };
        self.jobs.queue(&mut lock(&self.jobs.observed), |n| Job::Compact(n, compaction));
    }

    fn message_id(&self) -> String {
        format!("msg_{}", uuid::Uuid::new_v4().simple())
    }

    async fn skills_applied(&self, message: &AgentMessage, names: &[String]) {
        let applied = &self.applied;
        let item = if message.message_id == applied.input.0 { applied.input.1.clone() } else { self.iid_of(message) };
        // Node schedules the save and goes on; a stamp that cannot be stored never fails the turn.
        if let Err(error) = applied.parts.record_applied_skills(&applied.thread, &item, names).await {
            tracing::warn!("[session] applied skills save failed: {}", error.message);
        }
    }

    /// Waits for the save to end, with no bound of its own (a cancelled run stops waiting, `Run::until_durable`). A refused
    /// row does not fail the running turn: Node gates only the next turn's open on durability (`turn-durability.mjs`).
    async fn durable(&self, ticket: Ticket) {
        if ticket.0 == 0 {
            let _ = self.port.input_durable().await;
            return;
        }
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= ticket.0).await;
    }

    /// The actor has taken the job of `ticket`: what the run reports from here reaches it after. The input row it holds already.
    async fn accepted(&self, ticket: Ticket) {
        let mut accepted = self.accepted.clone();
        let _ = accepted.wait_for(|a| *a >= ticket.0).await;
    }

    /// The jobs queued so far, the draft the observer queued for the send's mark among them, have run: each ends once its
    /// write is durable or has failed (`RunPort::draft`, `commit_item`).
    async fn drafted(&self) {
        let queued = self.jobs.seq.load(Ordering::SeqCst);
        let mut done = self.done.clone();
        let _ = done.wait_for(|d| *d >= queued).await;
    }
}
async fn drive(
    parts: Arc<dyn RunParts>,
    liveness: Arc<mixdog_services::task_reports::runtime_state::RuntimeLiveness>,
    search_usage: Arc<mixdog_tools::web::NativeSearchUsageSinks>,
    run: RunStart,
    asked: Arc<std::sync::atomic::AtomicBool>,
) -> RunOutcome {
    let RunStart { prefix_guard, cache_tail, thread, turn, input_body, header, port, context, surface, progress, turn_messages, cancel, signal, review, agent_turn, unattended, verb, skill_selection: routine_selection, input: submitted, input_item, goal_reminder, notice: carried_notice, transcripts, lifecycle } = run;
    // whileTurnDispatched and the runtime entry (`runtime-state.mjs`): the run is live from here to the end of the drive.
    let _live = super::turn_liveness::TurnLiveness::begin(&liveness, &thread, &header, progress.subscribe(), cancel.clone());
    // The turn's own context (`options.context`: an agent spawn's or send's `context` argument).
    let own_context = agent_turn.as_ref().and_then(|turn| turn.context.as_ref()).and_then(Value::as_str).map(str::to_owned);
    let (slot, skill_selection, on_tool_result, notify) = match agent_turn {
        Some(turn) => {
            let hook = turn.hooks.notify;
            let notify = mixdog_core_api::domain::tool::ToolNotify(Arc::new(move |text, meta| hook(text, meta)));
            (turn.slot, turn.skill_selection, Some(turn.hooks.on_tool_result), Some(notify))
        }
        None => (None, routine_selection, None, None),
    };
    parts.reset_turn_shells(&thread);
    let hints = ToolHints::start(progress.subscribe(), port.clone());
    let quiet_changes = progress.subscribe();
    let watched = progress.subscribe();
    let tool_progress = RunToolProgress::new(progress.clone());
    // The generation of the history the rows are, read as one load with them: a rewrite commits its rows and moves the
    // generation in one step of the session, and none can start while this turn runs.
    let generation = cache_tail.generation(thread.as_str(), header.get("cacheTailBook"));
    let mut stored = match context.read().await {
        Ok(stored) => stored,
        Err(error) => return failed(format!("model context unreadable: {error:?}"), Value::Null),
    };
    let request = prompt_text(&input_body);
    // A failed-turn retry starts without the stale copy of its prompt (`prepareAskTurn`). The
    // context is restarted durably (the chained provider state re-baselines with it), at the rows
    // that remain and this run's input, so the next turn reads the prompt once.
    let stale = match failed_turn_rewind::rewound(&mut stored, submitted.options.as_ref(), &request) {
        Ok(stale) => stale,
        Err(text) => return failed(text, Value::Null),
    };
    if !stale.is_empty() {
        let mut restart = stored.clone();
        restart.push((input_item.clone(), input_body.clone()));
        if port.context_rewound(restart).await.is_err() {
            return failed("the failed prompt could not be removed from the model context", Value::Null);
        }
    }
    // The rows' bodies are read where they are, not copied: the context since the last compaction can be tens of MB, and a
    // copy held for the whole run was one of the turn's several (Codex keeps one shared history). The ids are rejoined only
    // for the rare rewrites below.
    let (mut stored_ids, mut prior): (Vec<ItemId>, Vec<Value>) = stored.into_iter().unzip();
    let rejoined = |ids: &[ItemId], bodies: &[Value]| -> Vec<(ItemId, Value)> { ids.iter().cloned().zip(bodies.iter().cloned()).collect() };
    let injected = input_body.pointer("/meta/source").is_some_and(Value::is_string);
    // Node's `await reconcileTurnSettings()` of the turn preparation: a gate that moved since the last turn
    // reaches this one through the header, before the request is assembled.
    let header = match parts.reconcile_turn(&thread, header, mixdog_core_session::session::thread_settings::has_conversation_messages(&prior)).await {
        Ok(header) => header,
        Err(error) => return RunOutcome::Failed(error),
    };
    // A prefix that moved under the stored conversation (a rebuilt prompt) leaves the thinking it stored bound to the old
    // one (`markToolSurfaceMigrated` with the transcript). The fold records that owed in the header, in the write that moves
    // the prefix; the rows are rebound and written with this turn's input below, and only then is the debt cleared, so a turn
    // that fails first (or a restart) leaves it to the next turn.
    let rebind_owed = header.get("thinkingRebindPending") == Some(&Value::Bool(true));
    let mut rebound = false;
    if rebind_owed {
        let (rows, changed, closing) = super::thinking_binding::rebind_to_changed_prefix_at(&prior);
        if changed {
            if let Some(at) = closing {
                stored_ids.insert(at, ItemId::from(uuid::Uuid::now_v7().to_string()));
            }
            prior = rows;
            rebound = true;
        }
    }
    // `refreshSessionBp3Environment` (`ask-turn-execute.mjs`): the first turn of a session whose prompt has not
    // taken its `# Session` block yet adds it, and the session records that it did.
    let mut header = header;
    if header.get("sessionStartMetaInjected") != Some(&Value::Bool(true)) && !mixdog_core_session::session::route_session::has_user_conversation(&prior) {
        let patch = super::prompt_session::refresh_environment(&header, &mixdog_core_prompt::prompt::blocks::SystemBlocks::from_header(&header));
        for key in &patch.change.unset {
            header.shift_remove(key);
        }
        for (key, value) in &patch.change.set {
            header.insert(key.clone(), value.clone());
        }
        if port.save_header(patch.change).await.is_err() {
            return failed("the session's prompt could not be saved", Value::Null);
        }
    }
    // `ensureSessionTranscriptWriter(); transcript.appendUser(prompt)` (`turn-prepare.mjs:162-163`): the prompt as submitted,
    // before the turn's reminders ride it.
    let turn_transcript = transcripts.as_ref().and_then(|files| files.turn(thread.as_str(), &header, &prior));
    if let Some(transcript) = &turn_transcript {
        transcript.user(input_body.get("content").unwrap_or(&Value::Null));
    }
    // `dispatchPromptSubmit` (`turn-prepare.mjs:185-208`), after the prompt row and before the model is asked: a handler's
    // block refuses the turn (`prompt blocked by hook: <reason>`), a hook failure decides nothing, and the context the
    // handlers add joins the turn's own as the context this turn carries. The wait ends with the turn (`turn.awaitTurn`):
    // a turn stopped meanwhile ends as stopped: in the loop, or by `BeforeLoop` when a later setup wait ends with the fired token.
    let submitted_prompt = input_body.get("content").cloned().unwrap_or(Value::Null);
    let verdict = tokio::select! {
        verdict = lifecycle.prompt_submit(&thread, &header, &submitted_prompt) => verdict,
        () = cancel.cancelled() => Default::default(),
    };
    if verdict.blocked {
        // The refusal throws before `askSession` (`turn-run.mjs` `runTurn`): `session.messages` never takes the prompt and
        // keeps a retry's stale copy, so the model context restarts at the rows it held before this turn.
        let mut stored = rejoined(&stored_ids, &prior);
        stored.extend(stale);
        if let Err(error) = port.context_restored(stored).await {
            tracing::warn!("[session] the refused prompt could not be removed from the model context: {error:?}");
        }
        return failed(format!("prompt blocked by hook: {}", verdict.reason.as_deref().unwrap_or_default()), Value::Null);
    }
    let turn_context = super::lifecycle_hooks::turn_context(own_context.as_deref(), &verdict.context);
    let surface_now = surface.borrow().clone();
    let assembled = match parts.assemble(AssembleInput { thread: &thread, turn: &turn, header: &header, surface: surface_now, port: &port, surface_rx: surface.clone(), slot, skill_selection, prior: &prior, generation, request: &request, injected, cancel: &cancel, unattended, notify, progress: tool_progress }).await {
        Ok(assembled) => assembled,
        Err(error) => return RunOutcome::Failed(error),
    };
    let Assembled {
        provider, tools, tool_env, gate, worktree, mut config, clock, decider, guards, compactor, route, skills, hooks, reuse, reactions, reaction_scope: _reaction_scope, rows, tail, side, step_judge, artifacts, images, failures, blobs, carry,
    } = assembled;
    // The actor incarnation's guard: the request its last completed turn settled on, on this lineage (a route switch or a
    // rewrite names a new one); a replacement actor holds none.
    let mut carry = carry;
    carry.prefix_guard = prefix_guard.for_header(&header);
    let failures = failures.map(|inner| Arc::new(SensitiveFailures { inner, context: context.clone() }) as Arc<dyn mixdog_agent::env::ToolFailureLog>);
    // `backfillFallbackSessionTitle` (`precommitUserTurn`, `ask-turn-execute.mjs`): a titleless session is named
    // from the earliest human turn of its history, else this turn's prompt (an injected turn never names it),
    // before the first save.
    let prompt = (!injected).then(|| json!({ "role": "user", "content": input_body.get("content").cloned().unwrap_or(Value::Null) }));
    if let Some(change) = mixdog_core_session::session::session_title::fallback_title_change(&header, &prior, prompt.as_ref(), clock.now_ms())
        && port.save_header(change).await.is_err()
    {
        return failed("the session's title could not be saved", Value::Null);
    }
    // The turn's tools publish each edit's card diff to the same review (`registerEditToolUiDiff`).
    let mut tool_env = tool_env;
    tool_env.review = Some(review.api());
    // The turn's workspace is final: take the baseline in the background; no tool runs before it.
    review.start(&worktree);

    // `buildUserTurn` (`ask-turn-prepare.mjs:147-246`): the reminders staged on the conversation (a workflow or an
    // orchestration mode switch, moved settings, a changed agent list or working folder, a prepared worktree, a
    // deferred-tool delta, the Goal) and the ones this prompt earns (the current time, a delegated agent's todo start)
    // ride this turn once, as the user message's reminder suffix. The message is kept as it was sent (the context the
    // next turns replay, and a retry resubmits), and the actor acknowledges the revisions when the turn is accepted
    // (`ask-turn-settle.mjs:148-164`); a failed turn leaves them pending.
    let mut input_body = input_body;
    let current_agents = match parts.current_agents(&thread, &header).await {
        Ok(agents) => agents,
        Err(error) => return RunOutcome::Failed(error),
    };
    // A retried failed turn resends its own message as it is (`retainedUserTurn`, `ask-turn-execute.mjs:38-69`): it
    // keeps the reminders it was built with, learns the agents changed since, and acknowledges its settings notice only.
    let retried = super::turn_reminders::is_retained(&input_body);
    let (mut carried, revisions) = if retried {
        match super::turn_reminders::resubmit(&input_body, &header, &prior, current_agents.as_deref()) {
            Ok(resent) => resent,
            Err(text) => return failed(text, input_body),
        }
    } else {
        let mode_instructions = match super::turn_reminders::carried_mode(&header) {
            Some(mode) => match parts.orchestration_instructions(&mode).await {
                Ok(text) => Some(text),
                Err(error) => return RunOutcome::Failed(error),
            },
            None => None,
        };
        // `promptContentText(prompt)`: a stored text attachment is read from the store; one that cannot be read fails the turn.
        let prompt_content = input_body.get("content").cloned().unwrap_or(Value::Null);
        let prompt_text = match with_blobs(&*blobs, move |store| super::turn_reminders::prompt_content_text(&prompt_content, store)).await {
            Ok(Ok(text)) => text,
            Ok(Err(text)) => return failed(text, input_body),
            Err(error) => return failed(error.to_string(), input_body),
        };
        let facts = super::turn_reminders::Facts {
            header: &header,
            prior: &prior,
            prompt_text: &prompt_text,
            genuine: !injected,
            current_agents: current_agents.as_deref(),
            mode_instructions: mode_instructions.as_deref(),
            goal: goal_reminder.as_ref().map(|reminder| reminder.content.as_str()),
            hidden_agent: config.hidden_agent,
            now_ms: clock.now_ms() as f64,
        };
        let reminders = match super::turn_reminders::build(&facts) {
            Ok(reminders) => reminders,
            Err(text) => return failed(text, input_body),
        };
        // `prefixUserTurnContent(prompt, contextBlock)` (`buildUserTurn`): the turn's context leads the prompt, the reminders
        // trail it. A retried turn resends its message as it was built (`retainedUserTurn` reads no context).
        let Some(carried) = super::lifecycle_hooks::with_turn_context(&input_body, &turn_context).and_then(|message| reminders.carry(&message)) else {
            return failed("the turn's input row cannot carry the turn's reminders".to_owned(), input_body);
        };
        (carried, reminders.revisions)
    };
    stamp_outgoing_effort(&mut carried, &config);
    // Told means sent: the one point where the start reminder is on the outgoing message, built now or retained from the
    // failed attempt. A retained message stored without it (an older build) leaves the ten-call reminder to fire.
    if mixdog_core_run::run_host::guards::carries_todo_start(&carried) {
        guards.note_creation_told();
    }
    if carried != input_body || rebound {
        let mut sent = rejoined(&stored_ids, &prior);
        sent.push((input_item.clone(), carried.clone()));
        if port.context_rewound(sent).await.is_err() {
            return failed("the turn's reminders could not be saved with the turn's input", Value::Null);
        }
        input_body = carried;
    }
    if rebind_owed {
        let spent = mixdog_store::schema::record::HeaderChange { set: serde_json::Map::new(), unset: vec!["thinkingRebindPending".into()] };
        if port.save_header(spent).await.is_err() {
            return failed("the session's thinking rebind could not be recorded", Value::Null);
        }
    }
    carried_notice.carry(revisions);
    let input = match message_of(&input_body) {
        Ok(input) => input,
        Err(error) => return failed(format!("the turn's input row is not a model message: {error}"), input_body),
    };
    let live = LiveTurnPublisher::new(turn_messages);
    let streaming = Arc::new(Mutex::new(Segments::default()));
    let stamp = TurnStamp::of(&input_body, verb, clock.now_ms());
    let observed = Arc::new(Mutex::new(Observed::default()));
    let applied = AppliedSkills { parts: parts.clone(), thread: thread.clone(), input: (input.message_id.clone(), input_item.clone()) };
    let (shown_tx, shown_rx) = mpsc::unbounded_channel::<Shown>();
    let sink = PortSink::spawn(port.clone(), rows.clone(), live.clone(), (streaming.clone(), observed.clone()), (clock.clone(), blobs), on_tool_result, (stamp, applied), shown_tx.clone());
    // The system messages are the header's prompt fields, in Node's order and tiers (WP-PROMPT).
    let mut messages = system_messages(&header);
    // The context before the input row with the item each message is, for the rewrite a cancelled turn ends with: each
    // message as its stored row (shared with the message), read back into the message only if the turn is cancelled, so
    // the turn holds no second copy of the conversation.
    let mut history: Vec<(ItemId, HistoryRow)> = Vec::new();
    let mut leading = true;
    for (iid, body) in stored_ids.into_iter().zip(prior) {
        // A stored row the codec cannot read fails the turn: dropping it would change the context. The row becomes the
        // message's own `stored` and the turn's registered body at once (one copy, shared).
        let message = match mixdog_agent::message_row::message_of_owned(body) {
            Ok(message) => message,
            Err((error, body)) => return failed(format!("the model context holds a row this build cannot read: {error}"), body),
        };
        if leading && is_stale_system_row(&message) {
            continue;
        }
        leading = false;
        if let Some(id) = &message.message_id {
            lock(&sink.iids).insert(id.clone(), iid.clone());
        }
        let row = match &message.stored {
            Some(stored) => HistoryRow::Stored(stored.clone()),
            None => HistoryRow::Message(message.clone()),
        };
        history.push((iid, row));
        rows.record_stored(&message);
        messages.push(message);
    }
    let input_text = input.text();
    rows.record(&input, input_body);
    sink.seed(&input);
    messages.push(input);

    let progress = Arc::new(ProgressPublisher::new(progress, clock.clone()));
    progress.ask_start();
    let asked_at = clock.now_ms();
    // The progress watchdog judges the model work from the ask on, and only a run no person is
    // attached to (Node arms it per worker turn once the ask has started).
    let watchdog = if unattended {
        let agent = header.get("agent").and_then(Value::as_str).filter(|name| !name.is_empty());
        let model = header.get("model").and_then(Value::as_str).unwrap_or_default();
        let budget = provider.first_response_budget(model, header.get("modelParameters").filter(|parameters| parameters.is_object()));
        // `agentWatchdogOverrides`: the agent definition's first-response deadline and the routed
        // model's first-response budget.
        let overrides = Overrides {
            first_transport_timeout_ms: match agent {
                Some(name) => parts.first_response_timeout_ms(name).await,
                None => None,
            },
            provider_first_byte_timeout_ms: budget.map(|b| b.transport_ms),
            provider_first_output_timeout_ms: budget.map(|b| b.semantic_ms),
            ..Overrides::default()
        };
        let kind = AgentKind { name: agent, hidden: config.hidden_agent, stall_cap_idle_seconds: parts.stall_cap_idle_seconds(agent) };
        let policy = resolve_policy(kind, overrides, &|name: &str| std::env::var(name).ok());
        let (reaper, reaped_thread) = (parts.clone(), thread.clone());
        // The worker-turn registry's stop (`abortOnTimeout`, `agent-watchdog-registry.mjs:30-33`): the reap is armed, then the stop is
        // recorded with what the sweep judged, then the abort.
        let (stall_log, stall_agent, site) = (failures.clone(), agent.map(str::to_owned), StallSite::Registry { registration_id: registration_id() });
        let anchor_ts = clock.now_ms();
        Watchdog::arm(true, policy, signal.clone(), clock.clone(), move |now| watched.borrow().snapshot(now), move |snapshot: &Snapshot, message: &str, now: i64| {
            reaper.reap_turn_shells(&reaped_thread, asked_at);
            if let Some(log) = stall_log {
                log.stall_abort(stall_abort_ctx(reaped_thread.as_str(), stall_agent.as_deref(), &site, &policy, anchor_ts, snapshot, message, now));
            }
        })
    } else {
        None
    };
    // The quiet-time cue of a turn a person watches (`startQuietWatch` in the lead turn, `turn.mjs:781`), against the lead's warn point.
    let quiet_watch = (!unattended).then(|| {
        let warn_ms = mixdog_agent::agent_tool::watchdog::stall_warn_ms(AgentKind { name: Some("lead"), ..AgentKind::default() }, &|name: &str| std::env::var(name).ok());
        QuietWatch::start(quiet_changes, port.clone(), clock.clone(), Arc::new(TimerWait), warn_ms as f64)
    });
    drop(spawn_forwarder(port.clone(), shown_rx, cancel.clone()));
    // `registerNativeWebSearchUsageSink(session.id, options.onNativeWebSearchUsage)` (`turn-run.mjs`): from the first send to the
    // ask's end the newest entry of this thread's session hears every search the turn runs, in the order the other reports reach the port.
    let search_tx = shown_tx.clone();
    let hears_search = search_usage.register(thread.as_str(), Arc::new(move |delta| {
        let _ = search_tx.send(Shown::SearchUsage(delta));
    }));
    let agent_route = (header.get("owner").and_then(Value::as_str) == Some("agent")).then(|| (liveness.clone(), thread.clone()));
    let observer = Arc::new(PortObserver { observed: observed.clone(), progress: progress.clone(), out: shown_tx, streaming, reasoning: Mutex::new(None), last_send_tools: Mutex::new(Vec::new()), chunked: std::sync::atomic::AtomicBool::new(false), live: live.clone(), rows: rows.clone(), cancel: cancel.clone(), requests: std::sync::atomic::AtomicU32::new(0), streamed_calls: Mutex::new(Vec::new()), held_early: Mutex::new(None), task_waits: Mutex::default(), context: context.clone(), sink: sink.clone(), transcript: turn_transcript.clone(), agent_route });
    let closing = observer.clone();

    config.thread_id = thread.clone();
    config.turn_id = turn.clone();
    config.signal = Some(signal.clone());
    config.first_request_after = Some(Ticket(0));
    config.select_input_skills = !injected && !retried;
    // Only the gate's refusal (a stale request) reloads the history: a run without one has nothing to reload for.
    config.history = config.options.tail_gate.clone().map(|gate| Arc::new(ReloadedHistory { sink: sink.clone(), context: context.clone(), gate }) as Arc<dyn mixdog_agent::env::StoredHistory>);
    let gate: Arc<dyn ToolGate> = Arc::new(ReviewGate::new(review, gate(GateContext { observer: observer.clone(), cancel: cancel.clone(), guards: guards.clone(), approvals: Arc::new(port.clone()) })));
    let skills = skills.map(|build| build(SkillContext { gate: gate.clone(), env: tool_env.clone(), cancel: cancel.clone() }));
    let guard_state = guards.clone();
    let env = RunEnv {
        clock,
        jitter: Arc::new(RandomJitter),
        waiter: Arc::new(TimerWait),
        decider,
        steer: Arc::new(SteerQueue::new(port.clone())),
        observer,
        sink: sink.clone(),
        gate,
        guards,
        compactor: compactor.map(|inner| Arc::new(super::goal_reminder_compactor::GoalReminderCompactor::new(inner, port.clone())) as Arc<dyn Compactor>),
        route,
        skills,
        hooks,
        reuse,
        reactions,
        tail,
        mcp: Some(Arc::new(ThreadMcp { parts: parts.clone(), thread: thread.clone(), surface: surface.clone() })),
        side,
        step_judge,
        artifacts,
        images,
        failures,
    };
    // The loop closes a stop from here on (`close_cancelled`); one that ended the setup above is `BeforeLoop`'s.
    asked.store(true, Ordering::SeqCst);
    // Node's `_api_call_with_interrupt` spans `agentLoop`: an abort inside reads "during call".
    progress.model_loop(true);
    let provider_id = provider.id().as_str().to_owned();
    let result = Run::new(env, cancel.clone(), provider, tools, tool_env, config, messages, carry).run().await;
    progress.model_loop(false);
    // `releaseWebSearchUsage?.()` after `askSession`.
    drop(hears_search);
    // The model work is over: the watchdog, which judges only that, stops here.
    drop(watchdog);
    closing.end_reasoning();
    // No hint is published once the run's outcome is on its way: the run owns the runtime section.
    hints.finish().await;
    if let Some(quiet_watch) = quiet_watch {
        quiet_watch.finish().await;
    }
    // The guard state that outlives one ask lives on the session record (`session.todoCheck`, `session._repeat*`).
    // A cancelled run's token has fired, but Node saves after the abort (`finalizeCancelledTurn`).
    let end_port = if cancel.is_cancelled() { port.closing() } else { port.clone() };
    {
        let carry = match &result {
            Ok(output) => &output.carry,
            Err(failure) => &failure.carry,
        };
        let mut set = carry.to_saved();
        if let Some(check) = guard_state.saved() {
            set.insert("todoCheck".into(), check);
        }
        let _ = end_port.save_header(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() }).await;
        let kept = match &result {
            Ok(output) if !cancel.is_cancelled() => output.carry.prefix_guard.clone(),
            _ => None,
        };
        prefix_guard.keep(kept);
    }
    match result {
        Ok(output) => {
            // The loop ends on the terminal answer without committing it (Node's turn commit does):
            // history keeps only the terminal segment.
            let mut terminal = output.response.clone();
            if let Some(segment) = &output.response.history_content {
                terminal.content.clone_from(segment);
            }
            let mut transcript = output.transcript.clone();
            if let Some(mut message) = mixdog_agent::response::intermediate_message(&terminal) {
                message.message_id = Some(sink.message_id());
                message.turn_reminder.clone_from(&output.last_reminder);
                *lock(&sink.terminal) = Some((output.iterations, output.tool_calls_total));
                if let Err(error) = sink.commit(&message).await {
                    sink.flush().await;
                    // The turn ends once what it produced is forwarded, its media preparations done ([`Preparation`]).
                    let _ = closing.barrier().await;
                    sink.live.clear();
                    progress.error();
                    return failed(error.to_string(), Value::Null);
                }
                transcript.push(message);
            }
            sink.flush().await;
            // `settleAskTurn`: the ask's usage and transcript reach the header once every call's report
            // has (the port's lane keeps their order). Every media preparation of the turn is done by then ([`Preparation`]).
            let _ = closing.barrier().await;
            let settled = mixdog_core_session::session::run::Settled {
                transcript,
                usage: output.usage.clone(),
                last_turn_usage: output.last_turn_usage.clone(),
                tool_calls_total: output.tool_calls_total,
                send_tools: lock(&closing.last_send_tools).clone(),
                response_model: output.response.model.clone(),
                asked_at_ms: asked_at,
                input_excludes_cache: output.input_excludes_cache,
            };
            let _ = port.settled(settled).await;
            // `transcript.appendFinalAssistant(result)` (`turn-settle.mjs:44`): `historyContent ?? content`.
            if let Some(turn_transcript) = &turn_transcript {
                turn_transcript.final_text(output.response.history_content.as_deref().unwrap_or(&output.response.content));
            }
            // The `Stop` hook is no longer asked here: the agent loop asks it when the model ends its turn, so a block can
            // continue the turn (owner-approved difference from Node's `completeTurn`).
            sink.live.clear();
            progress.done(output.response.content.trim().is_empty());
            if let Some(state) = output.provider_state.clone() {
                let _ = port.save_provider_state(Some(state)).await;
            }
            RunOutcome::Completed(Box::new(mixdog_agent::agent_tool::flow::seams::TurnResult {
                content: output.response.content.clone(),
                report_content: output.response.report_content.clone(),
                termination: output.termination,
                iterations: output.iterations,
                tool_calls_total: output.tool_calls_total,
                stop_reason: output.response.stop.as_ref().map(super::message_row::stop_name),
            }))
        }
        Err(failure) => {
            sink.flush().await;
            // The turn ends once what it produced is forwarded, its media preparations done ([`Preparation`]); a cancelled run's
            // forwarder is gone already, and this answers at once.
            let _ = closing.barrier().await;
            sink.live.clear();
            // The watchdog's abort is a stalled failure, not a user's interrupt: its sentence is
            // the error, and the partial output the sink just flushed goes to the owner.
            if signal.is_aborted() && is_watchdog_abort(&signal.reason()) {
                // The turn has unwound: sweep what it registered while stopping (`reapTurnShellJobs`).
                parts.reap_turn_shells(&thread, asked_at);
                progress.error();
                return failed(signal.reason(), Value::Null);
            }
            if matches!(failure.error, AgentError::Aborted) || cancel.is_cancelled() {
                progress.cancelling();
                close_cancelled(&end_port, &sink, &rows, &history, (&input_item, &input_text), &observed, signal.close_reason()).await;
                return RunOutcome::Interrupted;
            }
            // The turn's terminal error: a provider timeout or stall that ended it (a retry the turn recovered from never
            // reaches here) stops its shell work, while nothing else stopped the turn first
            // (`armTurnTimeoutOnProviderError` then `reapTurnShellJobs`, `ask-session.mjs`).
            if !signal.is_aborted() && matches!(&failure.error, AgentError::Provider(error) if provider_timeout_or_stall(error)) {
                parts.reap_turn_shells(&thread, asked_at);
            }
            progress.error();
            let data = if failure.carried_report.is_empty() { Value::Null } else { json!({ "carriedReport": failure.carried_report }) };
            // A provider's refusal keeps what `turnFailureRecord` reads off it: kind, status, code, retry advice and
            // reset (`provider_turn_error`); any other failure is its message.
            if let AgentError::Provider(error) = &failure.error {
                return RunOutcome::Failed(provider_turn_error(error, &provider_id, data));
            }
            // The guard's refusal reads as `Session state changed unexpectedly.` (`err-text.mjs:274`, by its code).
            if matches!(failure.error, AgentError::PrefixMutation(_)) {
                return failed("Session state changed unexpectedly.".to_owned(), data);
            }
            failed(failure.error.to_string(), data)
        }
    }
}
/// `recoverTurnCheckpoint` of a run the process died in. A sealed turn (its answer committed, stamped with the turn's
/// completion) stays as it is. Otherwise its draft is finalized as `finalizeTurnInterruptionSnapshot(.., 'process-crash')`
/// finalizes the checkpoint: the partial reply, every unanswered call closed as cancelled and the restart line are
/// committed, and the model context restarts on the finalized transcript, with `sentRequestTail` on the message the
/// request ended with (as [`close_cancelled`] leaves a stopped turn).
fn crashed_rows(run: mixdog_core_session::session::CrashedRun) -> mixdog_core_session::session::CrashedRows {
    use mixdog_agent::interrupt::{finalize_interrupted_turn, AbortReason, Interrupted, Phase};
    use mixdog_core_session::session::CrashedRows;
    use mixdog_protocol::message_class::RowFacts;
    use mixdog_protocol::message_class::user_text::{Blobs, ReadError};
    struct NoAttachments;
    impl Blobs for NoAttachments {
        fn text_within(&self, _: &str, _: u64) -> Result<Option<String>, ReadError> {
            Ok(None)
        }
    }
    let mut known: Vec<(ItemId, AgentMessage)> = Vec::with_capacity(run.context.len());
    for (iid, body) in &run.context {
        match message_of(body) {
            Ok(message) => known.push((iid.clone(), message)),
            Err(error) => {
                tracing::error!("[turn-checkpoint] the crashed turn is not finalized: its context holds a row this build cannot read: {error}");
                return CrashedRows::default();
            }
        }
    }
    let input = run.input.as_ref().and_then(|input| known.iter().position(|(iid, _)| iid == input));
    // The turn's own rows follow its input row: any of them is output (`responseStarted`).
    let answered = input.is_some_and(|at| at + 1 < known.len());
    let sealed = answered
        && run.context.last().is_some_and(|(_, body)| body.get("role").and_then(Value::as_str) == Some("assistant") && body.pointer("/meta/transcript/completion").is_some());
    if sealed {
        return CrashedRows { sealed: true, ..CrashedRows::default() };
    }
    // The turn was sealed (its final reply drafted) but the reply's row never landed: the reply is committed as that row
    // and the turn ends finished, as Node brings a sealed checkpoint back (`turn-checkpoint-recovery.mjs`).
    if let Some(row) = run.draft.sealed.clone() {
        return CrashedRows { sealed: true, rows: vec![ItemCommit { iid: new_item_id(), role: Some("assistant".to_owned()), model: true, visible: true, body: row, prompt: None }], ..CrashedRows::default() };
    }
    // A recovery whose rows landed but whose end record did not (the process died again in between) left the restart line
    // closing the turn: finalized again, the turn is rebuilt with that line at the same place, which is kept, not added again.
    let restart = |message: &AgentMessage| message.role() == Role::User && message.text() == mixdog_agent::interrupt::PROCESS_RESTART_INTERRUPT_MESSAGE;
    let mut transcript: Vec<AgentMessage> = known.iter().map(|(_, message)| message.clone()).collect();
    if answered && transcript.last().is_some_and(restart) {
        transcript.pop();
    }
    let draft = run.draft;
    let calls = message_of(&json!({ "role": "assistant", "content": "", "toolCalls": draft.calls })).map(|message| message.tool_calls().to_vec()).unwrap_or_default();
    let results = draft.results.iter().filter_map(|row| message_of(row).ok()).collect();
    let finalized = finalize_interrupted_turn(Interrupted {
        transcript,
        current_user_text: input.map(|at| known[at].1.text()).unwrap_or_default(),
        response_started: draft.started || answered,
        partial_assistant: draft.text,
        partial_reasoning: draft.reasoning,
        observed_tool_calls: calls,
        observed_tool_results: results,
        phase: if draft.tools { Phase::Tools } else { Phase::Streaming },
        reason: AbortReason::ProcessCrash,
    });
    if !finalized.response_preserved {
        return CrashedRows::default();
    }
    let mut rows = Vec::new();
    let mut replacement: Vec<(ItemId, Value)> = Vec::new();
    for (index, message) in finalized.transcript.iter().enumerate() {
        let (iid, mut body) = match known.get(index).filter(|(_, was)| was == message || (restart(was) && restart(message))) {
            Some((iid, _)) => (iid.clone(), run.context[index].1.clone()),
            None => {
                let (iid, mut body) = (new_item_id(), row_of(message));
                let role = match message.role() {
                    Role::Assistant => "assistant",
                    Role::Tool => "tool",
                    _ => "user",
                };
                // The restart line is classified as a live commit's is (a cancel line shows as the turn's end); it names
                // no attachment, so no attachment is read.
                let facts = row_facts(&mut body, &mut UserText::new(&NoAttachments)).unwrap_or(RowFacts { visible: true, prompt: None });
                rows.push(ItemCommit { iid: iid.clone(), role: Some(role.to_owned()), model: true, visible: facts.visible, body: body.clone(), prompt: facts.prompt });
                (iid, body)
            }
        };
        if finalized.sent_request_tail == Some(index) && let Some(object) = body.as_object_mut() {
            let meta = object.entry("meta").or_insert_with(|| json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert("sentRequestTail".into(), Value::Bool(true));
            }
        }
        replacement.push((iid, body));
    }
    CrashedRows { sealed: false, rows, context: Some(replacement), context_tokens: None }
}
