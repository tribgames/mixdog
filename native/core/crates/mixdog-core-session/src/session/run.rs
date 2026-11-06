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

use super::SessionLanes;
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
        let token = CancellationToken::new();
        let dropped = || CoreError::Internal {
            incident_id: "session-context-job-dropped".into(),
        };
        let mut read = None;
        loop {
            let (store, thread) = (self.store.clone(), self.thread.clone());
            let page = self
                .lanes
                .io
                .submit(&token, move |lane| store.context_io(lane, &thread, read))?
                .await
                .map_err(|_| dropped())??;
            let store = self.store.clone();
            let step = self
                .lanes
                .cpu
                .submit(&token, move |lane| store.context_cpu(lane, page))?
                .await
                .map_err(|_| dropped())??;
            match step {
                ContextStep::More(next) => read = Some(next),
                ContextStep::Done(mut rows) => {
                    rows.retain(|(iid, _)| *iid != self.input);
                    return Ok(rows);
                }
            }
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
    Approval {
        turn: TurnId,
        ask: ApprovalAsk,
        reply: oneshot::Sender<ApprovalResolution>,
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
    Compacted {
        turn: TurnId,
        compaction: Compaction,
        ack: oneshot::Sender<Result<(), RunError>>,
    },
}

/// What the run shows besides its rows and deltas.
pub(crate) enum RunShown {
    /// A muted transcript notice (`pushNotice(text, 'info', {transcript: true})`).
    Notice(String),
    /// One model call's usage (`onUsageDelta`).
    Usage(UsageReport),
    /// The finished `Reasoning` item (`item/completed`).
    Reasoning(ThreadItem),
    /// The compact marker (`applyCompactEvent`).
    Compact(mixdog_agent::env::CompactEvent),
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
    /// The header's `providerState` as acked at turn start.
    pub(crate) provider: Option<ProviderState>,
}

impl RunPort {
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
        self.send(ProducerMsg::ProviderState {
            turn: self.turn.clone(),
            state,
            ack,
        })
        .await?;
        rx.await.map_err(|_| RunError::Closed)?
    }

    pub fn thread(&self) -> &ThreadId {
        &self.thread
    }

    pub fn turn(&self) -> &TurnId {
        &self.turn
    }

    async fn send(&self, msg: ProducerMsg) -> Result<(), RunError> {
        self.tx.send(msg).await.map_err(|_| RunError::Closed)
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

    /// A runtime notice of the turn (`onStageChange('notice')`): a muted (`info`) transcript
    /// line, live only.
    pub async fn notice(&self, text: String) -> Result<(), RunError> {
        self.shown(RunShown::Notice(text)).await
    }

    /// One model call's usage (`onUsageDelta`): `thread/tokenUsage/updated` with Node's delta
    /// (`usageDeltaEvent`).
    pub async fn usage(&self, report: UsageReport) -> Result<(), RunError> {
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
        self.send(ProducerMsg::TakeSteers {
            turn: self.turn.clone(),
            request,
            reply,
        })
        .await?;
        rx.await.map_err(|_| RunError::Closed)
    }

    /// Appends the `compacted` record and resolves once it is durable (or failed).
    pub async fn compacted(&self, compaction: Compaction) -> Result<(), RunError> {
        let (ack, rx) = oneshot::channel();
        self.send(ProducerMsg::Compacted {
            turn: self.turn.clone(),
            compaction,
            ack,
        })
        .await?;
        rx.await.map_err(|_| RunError::Closed)?
    }
}

#[async_trait]
impl ApprovalGate for RunPort {
    /// Persisted, published, and resolved by the first valid decision, expiry, or the run's
    /// own abort. A thread that closes first resolves it `interrupted`.
    async fn request(&self, ask: ApprovalAsk) -> ApprovalResolution {
        let interrupted = || ApprovalResolution::Interrupted { at: 0 };
        let (reply, rx) = oneshot::channel();
        let msg = ProducerMsg::Approval {
            turn: self.turn.clone(),
            ask,
            reply,
        };
        if self.send(msg).await.is_err() {
            return interrupted();
        }
        rx.await.unwrap_or_else(|_| interrupted())
    }
}
