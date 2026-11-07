//! The run's port into its actor (RL §5.2). Every method is cancel-safe: sends go into the
//! bounded producer lane (a full lane is backpressure while the actor's outbox waits on
//! storage), replies come back on oneshots. The run selects each await against its token.

use async_trait::async_trait;
pub use mixdog_agent::env::DrainRequest;
pub use mixdog_agent::env::DrainStage;
pub use mixdog_agent::env::Priority;
pub use mixdog_agent::env::SteerMode;
use bytes::Bytes;
use mixdog_app_protocol::v2::thread::ItemDeltaParams;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::provider::ProviderState;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::QueuedId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::ThreadItem;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::watch;

use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::Scope;

use super::SessionLanes;
use super::control::Ctl;
use super::frames::encode;
use super::seams::ContextStep;
use super::seams::ThreadStore;
use mixdog_core_ports::ports::threads::Section;

/// A run's read of its thread's model context (`mixdog_store::context`).
#[derive(Clone)]
pub struct ModelContext {
    pub(crate) store: Arc<dyn ThreadStore>,
    pub(crate) lanes: SessionLanes,
    pub(crate) thread: ThreadId,
    /// The run's input row, which the read leaves out.
    pub(crate) input: ItemId,
}

impl ModelContext {
    /// The lineage's model rows since its last compaction, oldest first, before the run's input
    /// row (today's `session.messages` at ask start). Read once the input row is durable.
    pub async fn read(&self) -> Result<Vec<(ItemId, Value)>, CoreError> {
        let mut rows = read_context(&self.store, &self.lanes, &self.thread).await?;
        rows.retain(|(iid, _)| *iid != self.input);
        Ok(rows)
    }
}

/// The model context of `thread`: its lineage's model rows since the last compaction, oldest
/// first, as of the rows acked so far.
pub(crate) async fn read_context(
    store: &Arc<dyn ThreadStore>,
    lanes: &SessionLanes,
    thread: &ThreadId,
) -> Result<Vec<(ItemId, Value)>, CoreError> {
    let token = CancellationToken::new();
    let dropped = || CoreError::Internal {
        incident_id: "session-context-job-dropped".into(),
    };
    let mut read = None;
    loop {
        let (store_io, thread) = (store.clone(), thread.clone());
        let page = lanes
            .io
            .submit(&token, move |lane| store_io.context_io(lane, &thread, read))?
            .await
            .map_err(|_| dropped())??;
        let store_cpu = store.clone();
        let step = lanes
            .cpu
            .submit(&token, move |lane| store_cpu.context_cpu(lane, page))?
            .await
            .map_err(|_| dropped())??;
        match step {
            ContextStep::More(next) => read = Some(next),
            ContextStep::Done(rows) => return Ok(rows),
        }
    }
}

/// The run's input rows: pending until their records are acked (the first model call waits,
/// RL §5.4), then durable, or failed with the barrier error.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum InputState {
    Pending,
    Durable,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunError {
    /// The actor is gone (thread closing).
    Closed,
    /// The record failed its barrier and was not applied.
    NotApplied,
    /// The run's token fired while the call waited on the lane or its reply; the message may or
    /// may not have been taken.
    Cancelled,
}

/// One steering input handed to the run at a model-call boundary (R10), as today's drain
/// returns it (`ask-turn-steering-drain.mjs`): a steered entry alone, the queued prompts merged
/// into one, or one background job's completion.
#[derive(Clone, Debug, PartialEq)]
pub struct SteerInput {
    /// The queue entries this input took, in queue order (`ids`).
    pub queued_ids: Vec<QueuedId>,
    /// The model content: a string or an array of prompt parts (`content`).
    pub content: Value,
    /// Display text (`text`); a steered entry carries its own, if any.
    pub text: Option<String>,
    /// `TaskNotification` for a completion: the drain's `SteerEntry.mode`, stored under its own
    /// source, never as the user speaking.
    pub mode: SteerMode,
    /// A completion's execution provenance (`SteerEntry.execution`).
    pub execution: Option<Value>,
    /// A steered entry's `submittedAt` and `messageId`; a merged group carries neither.
    pub submitted_at: Option<i64>,
    pub message_id: Option<String>,
}

/// `queuePriorityValue(entry.priority) <= queuePriorityValue(max)`: `now` (0) and `next` (1)
/// pass every drain, `later` (2) only a `later` drain; a missing or unknown priority is `next`.
/// The priority is the entry's own top-level field, as Node's queue entries carry it.
pub(crate) fn within_priority(entry: &Value, max: Priority) -> bool {
    let rank = match entry.get("priority").and_then(Value::as_str) {
        Some("now") => 0,
        Some("later") => 2,
        _ => 1,
    };
    let ceiling = match max {
        Priority::Next => 1,
        Priority::Later => 2,
    };
    rank <= ceiling
}

#[cfg(test)]
#[test]
fn a_next_drain_leaves_later_entries_queued() {
    let entry = |priority: Option<&str>| match priority {
        Some(p) => serde_json::json!({ "message": "m", "priority": p }),
        None => serde_json::json!({ "message": "m" }),
    };
    // The Goal's continuation entry is queued with its priority at the top level.
    let goal = super::goal_lane::continuation_entry("p", None, 1);
    assert!(!within_priority(&goal, Priority::Next));
    assert!(within_priority(&goal, Priority::Later));
    for (priority, next, later) in [
        (Some("now"), true, true),
        (Some("next"), true, true),
        (None, true, true),
        (Some("later"), false, true),
    ] {
        assert_eq!(within_priority(&entry(priority), Priority::Next), next, "{priority:?}");
        assert_eq!(within_priority(&entry(priority), Priority::Later), later, "{priority:?}");
    }
}

/// A history row the run commits.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemCommit {
    pub iid: ItemId,
    pub role: Option<String>,
    /// Part of the model context.
    pub model: bool,
    pub visible: bool,
    /// The model message (FORMAT.md §5.2 `item.body`).
    pub body: Value,
    /// The row's prompt-history text (the record's `prompt`), when the run knows it; `None`
    /// leaves it to the row's own facts (`user_row`).
    pub prompt: Option<String>,
}

pub(crate) enum ProducerMsg {
    Section(Section),
    ItemStarted {
        turn: TurnId,
        item: ThreadItem,
    },
    Delta {
        item: ItemId,
        text: String,
        /// `item/agentMessage/delta` or `item/reasoning/textDelta`.
        method: &'static str,
        params: Bytes,
    },
    /// A view-only line or notification of the run (not persisted).
    Shown {
        turn: TurnId,
        shown: RunShown,
    },
    Commit {
        turn: TurnId,
        item: ItemCommit,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
    TakeSteers {
        turn: TurnId,
        request: DrainRequest,
        reply: oneshot::Sender<Vec<SteerInput>>,
    },
    ProviderState {
        turn: TurnId,
        state: Option<ProviderState>,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
    /// Header keys the run's session state is saved under (`todoCheck`, the `_repeat*` guards, the pinned
    /// `wireRoute`, the re-rooted prompt): the keys that differ are written in one `meta` record.
    Header {
        turn: TurnId,
        change: mixdog_store::schema::record::HeaderChange,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
    Compacted {
        turn: TurnId,
        compaction: Compaction,
        /// The header fields the compaction sets with it (a manual compaction's `compaction`
        /// record, its reset reading, its re-armed reminders), written in the one meta record
        /// that counts the compaction. `None`: the pass' own telemetry counts it.
        header: Option<mixdog_store::schema::record::HeaderChange>,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
    ContextRewound {
        turn: TurnId,
        replacement: Vec<(ItemId, Value)>,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
}

/// What the run shows besides its rows and deltas.
pub(crate) enum RunShown {
    /// A transcript notice (`pushNotice(text, tone, {transcript: true})`).
    Notice { text: String, tone: mixdog_agent::env::Tone },
    /// One model call's usage (`onUsageDelta`).
    Usage(UsageReport),
    /// The finished `Reasoning` item (`item/completed`).
    Reasoning(ThreadItem),
    /// The compact marker (`applyCompactEvent`).
    Compact(mixdog_agent::env::CompactEvent),
    /// The pre-send check of a request (`compactTelemetry(ctx, 'pre_send_check')`).
    Check(SendCheck),
    /// A stage of a pre-send compaction pass (`compactTelemetry` of `compactBeforeSend`).
    Pass(Box<mixdog_agent::env::CompactPass>),
    /// A tool call's arguments streamed or completed in the provider stream (markSessionStreamDelta('tool')).
    ToolStream,
    /// The summary model's usage of a compaction pass (ccumulateCompactUsage).
    CompactUsage(CompactUsageReport),
    /// The ask's end (`applyAskTerminalUsageTotals`, `recordProviderContextBaseline`).
    Settled(Settled),
    /// A hosted web search's spend (`onNativeWebSearchUsage`): the delta `reportNativeWebSearchUsage` hands the turn.
    SearchUsage(Value),
}

/// What a compaction pass's summary model used (ccumulateCompactUsage).
#[derive(Clone, Debug, PartialEq)]
pub struct CompactUsageReport {
    pub iteration: u32,
    pub usage: mixdog_core_api::domain::provider::Usage,
    pub reasoning_tokens: Option<u64>,
    pub reasoning_tokens_complete: bool,
}

/// The request the loop is about to send, as its pre-send check judged it.
#[derive(Clone, Debug, PartialEq)]
pub struct SendCheck {
    pub messages: Vec<mixdog_agent::message::AgentMessage>,
    pub tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
    /// A context-overflow retry is pending (`reactivePending`).
    pub reactive: bool,
}

/// What the ask's settlement reads of a finished run (`result` of `settleAskTurn`).
#[derive(Clone, Debug, PartialEq)]
pub struct Settled {
    /// `session.messages` after the terminal assistant message was appended.
    pub transcript: Vec<mixdog_agent::message::AgentMessage>,
    /// `result.usage`: the ask's aggregate.
    pub usage: mixdog_core_api::domain::provider::Usage,
    /// `result.lastTurnUsage`.
    pub last_turn_usage: mixdog_core_api::domain::provider::Usage,
    /// `result.toolCallsTotal`.
    pub tool_calls_total: u64,
    /// `result.lastSendTools`: the tools of the last request.
    pub send_tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
}

/// Everything Node's `usageDeltaEvent` carries about one model call (`onUsageDelta`).
#[derive(Clone, Debug, PartialEq)]
pub struct UsageReport {
    pub iteration: u32,
    pub usage: mixdog_core_api::domain::provider::Usage,
    /// `response.model || model`.
    pub model: String,
    /// The model the request named.
    pub requested_model: String,
    /// `deltaToolCalls`.
    pub delta_tool_calls: u64,
    /// `requestMs`.
    pub request_ms: u64,
    /// `deltaPrompt`.
    pub delta_prompt: u64,
    /// `sendTools`.
    pub send_tools: Vec<mixdog_core_api::domain::provider::ToolDefinition>,
    /// `reasoningUsage(usage)`: `None` when the provider reported none.
    pub reasoning_tokens: Option<u64>,
    pub reasoning_tokens_complete: bool,
    /// `outgoing`: the transcript the request carried.
    pub outgoing: Vec<mixdog_agent::message::AgentMessage>,
    /// `sendStartedAt`.
    pub sent_at_ms: i64,
}

impl UsageReport {
    /// The report of a loop `RunEvent::Usage`.
    pub fn from_event(iteration: u32, usage: mixdog_core_api::domain::provider::Usage, delta: mixdog_agent::env::UsageDelta) -> Self {
        Self {
            iteration,
            usage,
            model: delta.model,
            requested_model: delta.requested_model,
            delta_tool_calls: delta.delta_tool_calls,
            request_ms: delta.request_ms,
            delta_prompt: delta.delta_prompt,
            send_tools: delta.send_tools,
            reasoning_tokens: delta.reasoning_tokens,
            reasoning_tokens_complete: delta.reasoning_tokens_complete,
            outgoing: delta.outgoing,
            sent_at_ms: delta.sent_at_ms,
        }
    }
}

/// A compaction of the run's model context: the store's `compacted` record.
#[derive(Clone, Debug, PartialEq)]
pub struct Compaction {
    /// The new model context, in order: each row's item id and stored body.
    pub replacement: Vec<(ItemId, Value)>,
    /// Wall-clock milliseconds of the compaction (the divider's `at`).
    pub at: i64,
    /// Node `droppedMessages`: how many rows the pass took out (always written).
    pub dropped_count: u64,
    /// The identities the compaction took out of the model context, when the loop reports them.
    pub dropped: Option<Dropped>,
}

/// The `compacted` record's `dropped: {messageIds, callIds}`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dropped {
    pub message_ids: Vec<String>,
    pub call_ids: Vec<String>,
}

#[derive(Clone)]
pub struct RunPort {
    pub(crate) thread: ThreadId,
    pub(crate) turn: TurnId,
    pub(crate) tx: mpsc::Sender<ProducerMsg>,
    pub(crate) input: watch::Receiver<InputState>,
    /// The run's token: it ends every wait of the port except the commits, whose rows an abort
    /// still writes.
    pub(crate) cancel: CancellationToken,
    /// The actor's control lane, for what must not queue behind the producers (approvals).
    pub(crate) ctl: mpsc::Sender<Ctl>,
    /// The header's `providerState` as acked at turn start.
    pub(crate) provider: Option<ProviderState>,
    /// The host that prices the thread's pressure, and the provider it prices on.
    pub(crate) meters: Arc<dyn super::turn_ops::ManualCompaction>,
    /// The provider the thread is on right now: a hop to another route moves it mid-run, and the meters
    /// are prepared for the provider the reports will be priced on.
    pub(crate) meters_provider: Arc<dyn Fn() -> String + Send + Sync>,
}

impl RunPort {
    /// Reads the facts of the stored attachments `messages` carry before a report that prices them
    /// reaches the actor, which meters synchronously (`MediaMeter::prepare`).
    async fn prepare_meters(&self, messages: &[mixdog_agent::message::AgentMessage]) {
        self.meters.prepare_books(&self.thread, &(self.meters_provider)(), messages).await;
    }

    /// The session's saved provider state, read once at turn start as today's loop options
    /// read `session.providerState` (`ask-turn-loop-options.mjs:71`).
    pub async fn provider_state(&self) -> Option<ProviderState> {
        self.provider.clone()
    }

    /// Today's `persistProviderState`: `Some` replaces the saved state as a whole (the adapter
    /// already merged its slot into it), `None` deletes it. The agent calls it only where Node
    /// writes, when the provider reported an update or a state is present. Resolves once the
    /// header change is durable; an unchanged state appends nothing.
    pub async fn save_provider_state(&self, state: Option<ProviderState>) -> Result<(), RunError> {
        let (ack, rx) = oneshot::channel();
        self.call(ProducerMsg::ProviderState { turn: self.turn.clone(), state, ack }, rx).await?
    }

    /// Sets header keys of the session record the run holds state under; resolves once durable, and
    /// writes nothing for keys that already agree.
    pub async fn save_header(&self, change: mixdog_store::schema::record::HeaderChange) -> Result<(), RunError> {
        let (ack, rx) = oneshot::channel();
        self.call(ProducerMsg::Header { turn: self.turn.clone(), change, ack }, rx).await?
    }

    /// The port for what closes a cancelled run (`finalizeCancelledTurn` saves after the abort): the same
    /// producer lane, but its waits no longer end with the run's fired token.
    #[must_use]
    pub fn closing(&self) -> Self {
        Self { cancel: CancellationToken::new(), ..self.clone() }
    }

    pub fn thread(&self) -> &ThreadId {
        &self.thread
    }

    pub fn turn(&self) -> &TurnId {
        &self.turn
    }

    /// The one wait of the port (RL §5.2): `work` ends when it finishes or when the run's token
    /// fires, so a producer lane the actor stopped reading (the durability outbox is full) or an
    /// ack that never comes cannot hold an aborted run.
    async fn scoped<T>(&self, work: impl std::future::Future<Output = Result<T, RunError>>) -> Result<T, RunError> {
        Scope::new().cancel(&self.cancel).run(work).await.done().unwrap_or(Err(RunError::Cancelled))
    }

    async fn send(&self, msg: ProducerMsg) -> Result<(), RunError> {
        self.scoped(async { self.tx.send(msg).await.map_err(|_| RunError::Closed) }).await
    }

    /// `msg` into the producer lane, then its reply.
    async fn call<T>(&self, msg: ProducerMsg, reply: oneshot::Receiver<T>) -> Result<T, RunError> {
        self.scoped(async {
            self.tx.send(msg).await.map_err(|_| RunError::Closed)?;
            reply.await.map_err(|_| RunError::Closed)
        })
        .await
    }

    /// Resolves once the run's input rows are durable (the first model call waits on it).
    pub async fn input_durable(&self) -> Result<(), RunError> {
        let mut input = self.input.clone();
        let state = input
            .wait_for(|state| *state != InputState::Pending)
            .await
            .map_err(|_| RunError::Closed)?;
        match *state {
            InputState::Durable => Ok(()),
            _ => Err(RunError::NotApplied),
        }
    }

    pub async fn section(&self, section: Section) -> Result<(), RunError> {
        self.send(ProducerMsg::Section(section)).await
    }

    /// `item/started` (not persisted).
    pub async fn item_started(&self, item: ThreadItem) -> Result<(), RunError> {
        self.send(ProducerMsg::ItemStarted {
            turn: self.turn.clone(),
            item,
        })
        .await
    }

    /// `item/agentMessage/delta` (not persisted; ≤ 16 KiB, encoded here, RL §5.6).
    pub async fn delta(&self, item: ItemId, text: String) -> Result<(), RunError> {
        self.item_delta(item, text, "item/agentMessage/delta").await
    }

    /// `item/reasoning/textDelta` on the `Reasoning` item the run started (`item_started`):
    /// the thinking text Node's live turn shows (`appendReasoningDelta`). Not persisted.
    pub async fn reasoning_delta(&self, item: ItemId, text: String) -> Result<(), RunError> {
        self.item_delta(item, text, "item/reasoning/textDelta").await
    }

    async fn item_delta(&self, item: ItemId, text: String, method: &'static str) -> Result<(), RunError> {
        let params = encode(&ItemDeltaParams {
            thread_id: self.thread.clone(),
            turn_id: self.turn.clone(),
            item_id: item.clone(),
            delta: text.clone(),
            index: None,
        });
        self.send(ProducerMsg::Delta { item, text, method, params }).await
    }

    /// A runtime notice of the turn (`onStageChange('notice', { tone, message })`): a transcript
    /// line of the stage's tone (`warn`, else `info`), live only.
    pub async fn notice(&self, text: String, tone: mixdog_agent::env::Tone) -> Result<(), RunError> {
        self.shown(RunShown::Notice { text, tone }).await
    }

    /// One model call's usage (`onUsageDelta`): `thread/tokenUsage/updated` with Node's delta
    /// (`usageDeltaEvent`).
    pub async fn usage(&self, report: UsageReport) -> Result<(), RunError> {
        self.prepare_meters(&report.outgoing).await;
        self.shown(RunShown::Usage(report)).await
    }

    /// The `Reasoning` item the run started (`item_started`) is complete: `item/completed` with
    /// the thinking text as its `content`, which Node's CLI reads. Live only.
    pub async fn reasoning_completed(&self, item: ItemId, text: String) -> Result<(), RunError> {
        let item = ThreadItem::Reasoning { id: item, summary: Vec::new(), content: vec![text], meta: Default::default() };
        self.shown(RunShown::Reasoning(item)).await
    }

    /// A compaction pass's marker (`onCompactEvent` → `applyCompactEvent`): the
    /// `Compact complete` / `failed` / `checked` row, live only; a compaction that changed the
    /// context puts it before the turn's input row, where the restored divider stands.
    pub async fn compact_event(&self, event: mixdog_agent::env::CompactEvent) -> Result<(), RunError> {
        self.shown(RunShown::Compact(event)).await
    }

    /// The pre-send check of the request the loop is about to send.
    pub async fn send_check(&self, check: SendCheck) -> Result<(), RunError> {
        self.prepare_meters(&check.messages).await;
        self.shown(RunShown::Check(check)).await
    }

    /// The summary model's usage of a compaction pass: a usage report of the turn.
    pub async fn compact_usage(&self, report: CompactUsageReport) -> Result<(), RunError> {
        self.shown(RunShown::CompactUsage(report)).await
    }

    /// A tool call's arguments streamed or completed: semantic model progress.
    pub async fn tool_stream(&self) -> Result<(), RunError> {
        self.shown(RunShown::ToolStream).await
    }

    /// A stage of the compaction pass before a send.
    pub async fn compact_pass(&self, pass: Box<mixdog_agent::env::CompactPass>) -> Result<(), RunError> {
        self.prepare_meters(&pass.request).await;
        if let mixdog_agent::env::PassStage::Done { after, .. } = &pass.stage {
            self.prepare_meters(after).await;
        }
        self.shown(RunShown::Pass(pass)).await
    }

    /// The ask's end: its usage and transcript, before the run's outcome is reported.
    pub async fn settled(&self, settled: Settled) -> Result<(), RunError> {
        self.prepare_meters(&settled.transcript).await;
        self.shown(RunShown::Settled(settled)).await
    }

    /// A hosted web search's spend (`onNativeWebSearchUsage`): `thread/tokenUsage/updated` with the search's own
    /// delta (`source: native_web_search`). The search is not a main-stream request, so the header's usage books
    /// (`persistIterationMetrics`, fed by `onUsageDelta` only) and the live output count never hear it.
    pub async fn search_usage(&self, delta: Value) -> Result<(), RunError> {
        self.shown(RunShown::SearchUsage(delta)).await
    }

    async fn shown(&self, shown: RunShown) -> Result<(), RunError> {
        self.send(ProducerMsg::Shown { turn: self.turn.clone(), shown }).await
    }

    /// Appends a history row of this run and resolves once it is durable (or failed).
    pub async fn commit_item(&self, item: ItemCommit) -> Result<(), RunError> {
        let (ack, rx) = oneshot::channel();
        self.send(ProducerMsg::Commit {
            turn: self.turn.clone(),
            item,
            ack,
        })
        .await?;
        rx.await.map_err(|_| RunError::Closed)?
    }

    /// Input dequeued for injection at this boundary (`createAskSteeringDrain`). First the
    /// steered entries whose enqueue is durable and whose queue priority is at most
    /// `max_priority`, in queue order, one input each (`drainPendingSteering({maxPriority})`:
    /// `next` leaves `later` entries queued). Then the rest of the queue within that priority,
    /// at the `Terminal` stage, or at any stage when it holds task notifications only
    /// (`pendingQueueHoldsOnlyNotifications`): its prompts merged into one input, then each
    /// completion on its own, oldest first (`_groupPendingMessageEntries`). While a route saved
    /// during the turn is held, that rest stays queued for the next turn. A completion no
    /// boundary took starts its own turn when this one ends.
    pub async fn take_steers(&self, request: DrainRequest) -> Result<Vec<SteerInput>, RunError> {
        let (reply, rx) = oneshot::channel();
        self.call(ProducerMsg::TakeSteers { turn: self.turn.clone(), request, reply }, rx).await
    }

    /// A failed-turn retry's rewind (`prepareAskTurn` shrinking `session.messages`): the model
    /// context restarts at `replacement`, which holds the context less the stale copy of the
    /// failed prompt, then the run's input row. It is the store's `compacted` record that drops
    /// rows from the context, written with nothing taken out of the transcript and no divider, so
    /// the next turn reads the prompt once. Resolves once it is durable (or failed).
    pub async fn context_rewound(&self, replacement: Vec<(ItemId, Value)>) -> Result<(), RunError> {
        let (ack, rx) = oneshot::channel();
        self.call(ProducerMsg::ContextRewound { turn: self.turn.clone(), replacement, ack }, rx).await?
    }

    /// Appends the `compacted` record and resolves once it is durable (or failed).
    pub async fn compacted(&self, compaction: Compaction) -> Result<(), RunError> {
        let (ack, rx) = oneshot::channel();
        self.call(ProducerMsg::Compacted { turn: self.turn.clone(), compaction, header: None, ack }, rx).await?
    }
}

#[async_trait]
impl ApprovalGate for RunPort {
    /// Persisted, published, and resolved by the first valid decision, expiry, or the run's
    /// own abort. A thread that closes first resolves it `interrupted`.
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        let interrupted = || ApprovalResolution::Interrupted { at: 0 };
        let (reply, mut rx) = oneshot::channel();
        let msg = Ctl::Approval { turn: self.turn.clone(), ask, reply };
        // The control lane, not the producer lane (RL §6.2): back-pressure on the producers
        // cannot hold an approval.
        let asked = self
            .scoped(async {
                self.ctl.send(msg).await.map_err(|_| RunError::Closed)?;
                (&mut rx).await.map_err(|_| RunError::Closed)
            })
            .await;
        match asked {
            Ok(resolution) => resolution,
            // The scope prefers the cancel arm, so a resolution the actor sent before it fired the
            // token (a close resolves the approval `Interrupted`, then aborts the run: Node's
            // `closeSession` order) is still waiting in the channel. It is taken here, whenever
            // this task happens to be polled, so the outcome does not depend on scheduling.
            Err(RunError::Cancelled) => rx.try_recv().unwrap_or(ApprovalResolution::Cancelled { at: 0 }),
            Err(_) => interrupted(),
        }
    }
}

/// A cancelled run releases every wait of the port while the actor reads nothing (the state of
/// a full durability outbox, G3(c)); the actor's end of the lane is held here and never drained.
#[cfg(test)]
mod cancel_tests {
    use mixdog_core_api::domain::approval::ApprovalKind;

    use super::*;

    fn port(lane: usize) -> (RunPort, mpsc::Receiver<ProducerMsg>, mpsc::Receiver<Ctl>, CancellationToken) {
        let (tx, rx) = mpsc::channel(lane);
        let (ctl, ctl_rx) = mpsc::channel(4);
        let cancel = CancellationToken::new();
        let port = RunPort {
            thread: ThreadId::from("t"),
            turn: TurnId::from("r"),
            tx,
            input: watch::channel(InputState::Pending).1,
            cancel: cancel.clone(),
            ctl,
            provider: None,
            meters: Arc::new(crate::session::testing::TestCompaction::default()),
            meters_provider: Arc::new(String::new),
        };
        (port, rx, ctl_rx, cancel)
    }

    fn ask() -> ApprovalAsk {
        ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: None,
            tool: Some("bash".to_owned()),
            action_kind: None,
            reason: None,
            payload: Value::Null,
            remember: Vec::new(),
            expires_after: None,
        }
    }

    fn compaction() -> Compaction {
        Compaction { replacement: Vec::new(), at: 0, dropped_count: 0, dropped: None }
    }

    /// A hop to another provider mid-run moves the thread's provider: the next report is prepared for the new
    /// one, so its pressure is recorded (`books()` finds the meters of the provider the header names).
    #[tokio::test]
    async fn a_report_after_a_provider_switch_prepares_the_meters_of_the_new_provider() {
        let (mut port, _actor, _ctl, _cancel) = port(8);
        let meters = Arc::new(crate::session::testing::TestCompaction::default());
        let provider = Arc::new(std::sync::Mutex::new("first".to_owned()));
        let live = provider.clone();
        port.meters = meters.clone();
        port.meters_provider = Arc::new(move || live.lock().unwrap().clone());
        let check = || SendCheck { messages: Vec::new(), tools: Vec::new(), reactive: false };
        port.send_check(check()).await.unwrap();
        *provider.lock().unwrap() = "second".to_owned();
        port.send_check(check()).await.unwrap();
        assert_eq!(*meters.prepared.lock().unwrap(), vec![("first".to_owned(), 0), ("second".to_owned(), 0)]);
    }

    #[tokio::test]
    async fn a_send_blocked_on_a_full_lane_ends_at_cancel() {
        let (port, _actor, _ctl, cancel) = port(1);
        port.notice("fills the lane".into(), mixdog_agent::env::Tone::Info).await.expect("room for one");
        let blocked = tokio::spawn({
            let port = port.clone();
            async move { port.save_provider_state(None).await }
        });
        cancel.cancel();
        assert_eq!(blocked.await.unwrap(), Err(RunError::Cancelled));
    }

    #[tokio::test]
    async fn an_ack_the_actor_never_sends_ends_at_cancel() {
        let (port, _actor, _ctl, cancel) = port(4);
        let compacting = tokio::spawn({
            let port = port.clone();
            async move { port.compacted(compaction()).await }
        });
        cancel.cancel();
        assert_eq!(compacting.await.unwrap(), Err(RunError::Cancelled));
    }

    #[tokio::test]
    async fn an_approval_rides_the_control_lane_past_a_full_producer_lane_and_ends_at_cancel() {
        let (port, _actor, mut ctl, cancel) = port(1);
        port.notice("fills the lane".into(), mixdog_agent::env::Tone::Info).await.expect("room for one");
        let asking = tokio::spawn({
            let port = port.clone();
            async move { port.request(ask()).await }
        });
        // The actor reads only its control lane (the producers are held back by the outbox): the
        // approval is there although the producer lane is full.
        assert!(matches!(ctl.recv().await, Some(Ctl::Approval { .. })));
        cancel.cancel();
        assert!(matches!(asking.await.unwrap(), ApprovalResolution::Cancelled { .. }));
    }

    /// A close resolves the pending approval `Interrupted` and then fires the run's token. The
    /// request task is not polled between the two (a current-thread runtime, so this holds on
    /// every schedule): it must still answer with the resolution that was sent first.
    #[tokio::test]
    async fn an_approval_resolved_before_the_cancel_keeps_its_resolution() {
        let (port, _actor, mut ctl, cancel) = port(4);
        let asking = tokio::spawn({
            let port = port.clone();
            async move { port.request(ask()).await }
        });
        let Some(Ctl::Approval { reply, .. }) = ctl.recv().await else { panic!("the approval is on the control lane") };
        reply.send(ApprovalResolution::Interrupted { at: 7 }).expect("the request still waits");
        cancel.cancel();
        assert!(matches!(asking.await.unwrap(), ApprovalResolution::Interrupted { at: 7 }));
    }
}
