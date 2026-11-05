//! The run's port into its actor (RL §5.2). Every method is cancel-safe: sends go into the
//! bounded producer lane (a full lane is backpressure while the actor's outbox waits on
//! storage), replies come back on oneshots. The run selects each await against its token.

use async_trait::async_trait;
pub use mixdog_agent::env::Priority;
use bytes::Bytes;
use mixdog_app_protocol::v2::thread::ItemDeltaParams;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
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
use super::state::Section;

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

/// A steer entry handed to the run at a model-call boundary (R10).
#[derive(Clone, Debug, PartialEq)]
pub struct SteerInput {
    pub queued_id: QueuedId,
    /// The queue entry (`{message, …}`).
    pub entry: Value,
}

/// `queuePriorityValue(entry.priority) <= queuePriorityValue(max)`: `now` (0) and `next` (1)
/// pass every drain, `later` (2) only a `later` drain; a missing or unknown priority is `next`.
pub(crate) fn within_priority(entry: &Value, max: Priority) -> bool {
    let rank = match entry.pointer("/options/priority").and_then(Value::as_str) {
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
        Some(p) => serde_json::json!({ "message": "m", "options": { "priority": p } }),
        None => serde_json::json!({ "message": "m" }),
    };
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
        params: Bytes,
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
        max_priority: Priority,
        reply: oneshot::Sender<Vec<SteerInput>>,
    },
}

#[derive(Clone)]
pub struct RunPort {
    pub(crate) thread: ThreadId,
    pub(crate) turn: TurnId,
    pub(crate) tx: mpsc::Sender<ProducerMsg>,
    pub(crate) input: watch::Receiver<InputState>,
}

impl RunPort {
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
        let params = encode(&ItemDeltaParams {
            thread_id: self.thread.clone(),
            turn_id: self.turn.clone(),
            item_id: item.clone(),
            delta: text.clone(),
            index: None,
        });
        self.send(ProducerMsg::Delta { item, text, params }).await
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

    /// Steer entries whose enqueue is durable and whose queue priority is at most
    /// `max_priority`, dequeued for injection now, in queue order (today's
    /// `drainPendingSteering({maxPriority})`: `next` leaves `later` entries queued).
    pub async fn take_steers(&self, max_priority: Priority) -> Result<Vec<SteerInput>, RunError> {
        let (reply, rx) = oneshot::channel();
        self.send(ProducerMsg::TakeSteers {
            turn: self.turn.clone(),
            max_priority,
            reply,
        })
        .await?;
        rx.await.map_err(|_| RunError::Closed)
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
