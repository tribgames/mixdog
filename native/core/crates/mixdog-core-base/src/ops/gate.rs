//! One scope's op gate: exactly one execution per `(scope, opId)` (P §9.3), `op/status` with
//! fencing (P §9.4) and retention (P §9.5).
//!
//! Every step that reads or writes an op's durable record, and every execution, holds that
//! op's slot in the scope's slot map. A slot is either `Busy` (one lookup or fence in
//! progress; others wait for it, then decide again) or `Executing` (a duplicate with the same
//! payload waits for the shared outcome; a different payload conflicts at once). So a fence
//! and a late arrival of the same id are ordered, and a duplicate never executes twice.
//! The map is per scope and its lock is held only for map operations, never across an await:
//! one scope's slow store never delays another scope.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::call::CallContext;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ops::OpScope;
use mixdog_core_api::ops::OpStatus;
use serde_json::Value;
use tokio::sync::watch;

use super::digest::PayloadDigest;
use super::store::OpRecord;
use super::store::OpRetention;
use super::store::OpState;
use super::store::OpStore;
use super::uuid7::op_time_ms;
use super::uuid7::watermark_text;

/// Records are kept at least this long (P §9.5: 7 days)…
const KEEP_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// …and at least this many newest per scope.
const KEEP_NEWEST: usize = 10_000;
/// Rows deleted per maintenance step (SPEC R31).
const PRUNE_BATCH: usize = 500;

/// A mutation as the gate sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpRequest {
    pub id: OpId,
    pub method: Arc<str>,
    pub digest: PayloadDigest,
}

impl OpRequest {
    /// `params` are the request's params; their `opId` is left out of the digest.
    pub fn new(id: OpId, method: impl Into<Arc<str>>, params: &Value) -> Self {
        Self {
            id,
            method: method.into(),
            digest: PayloadDigest::of_params(params),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppliedOp {
    pub seq: Option<u64>,
    /// `None` when the stored result was too large; the owner reproduces it.
    pub result: Option<Value>,
}

/// The outcome every request carrying the op receives.
#[derive(Clone, Debug, PartialEq)]
pub enum OpOutcome {
    Applied(AppliedOp),
    Rejected(CoreError),
    ExternalUnknown { effect: Arc<str>, target: Arc<str> },
}

impl OpOutcome {
    /// The response: the applied result, the stored rejection, or `externalOutcomeUnknown`.
    pub fn into_result(self, op_id: &OpId) -> Result<AppliedOp, CoreError> {
        match self {
            OpOutcome::Applied(applied) => Ok(applied),
            OpOutcome::Rejected(error) => Err(error),
            OpOutcome::ExternalUnknown { effect, target } => {
                Err(CoreError::ExternalOutcomeUnknown {
                    op_id: op_id.clone(),
                    effect,
                    target,
                })
            }
        }
    }

    fn from_state(state: OpState) -> Self {
        match state {
            OpState::Applied { seq, result } => OpOutcome::Applied(AppliedOp { seq, result }),
            OpState::Rejected { error } => OpOutcome::Rejected(error),
            OpState::ExternalPending { effect, target }
            | OpState::ExternalUnknown { effect, target } => {
                OpOutcome::ExternalUnknown { effect, target }
            }
        }
    }

    fn into_state(self) -> OpState {
        match self {
            OpOutcome::Applied(AppliedOp { seq, result }) => OpState::Applied { seq, result },
            OpOutcome::Rejected(error) => OpState::Rejected { error },
            OpOutcome::ExternalUnknown { effect, target } => {
                OpState::ExternalUnknown { effect, target }
            }
        }
    }

    fn into_status(self) -> OpStatus {
        match self {
            OpOutcome::Applied(AppliedOp { seq, result }) => OpStatus::Applied { seq, result },
            OpOutcome::Rejected(error) => OpStatus::Rejected { error },
            OpOutcome::ExternalUnknown { effect, target } => {
                OpStatus::ExternalUnknown { effect, target }
            }
        }
    }
}

/// What a mutation request does after [`OpGate::begin`].
pub enum Begin {
    /// First arrival: execute, then settle the ticket.
    Execute(OpTicket),
    /// A duplicate of a running or finished execution: answer with its outcome.
    Done(OpOutcome),
}

/// The op gate of one scope; cheap to clone.
#[derive(Clone)]
pub struct OpGate {
    inner: Arc<Inner>,
}

struct Inner {
    scope: OpScope,
    store: Arc<dyn OpStore>,
    retention: Option<Arc<dyn OpRetention>>,
    /// UUIDv7 milliseconds below which records may be gone; 0 = never pruned.
    watermark: AtomicU64,
    slots: Mutex<HashMap<OpId, Slot>>,
    next_claim: AtomicU64,
}

struct Slot {
    claim: u64,
    kind: SlotKind,
    /// Changes when the slot turns `Executing` and when its execution completes; closes when
    /// the slot is released.
    signal: watch::Receiver<Option<OpOutcome>>,
}

enum SlotKind {
    Busy,
    Executing { digest: PayloadDigest },
}

impl OpGate {
    /// The gate of a thread scope: its records live as long as the session log.
    pub fn thread(scope: OpScope, store: Arc<dyn OpStore>) -> Self {
        Self::new(scope, store, None, 0)
    }

    /// The gate of a non-thread scope, with its persisted watermark.
    pub async fn domain<S>(scope: OpScope, store: Arc<S>) -> Result<Self, CoreError>
    where
        S: OpStore + OpRetention + 'static,
    {
        let watermark = store.watermark().await?.unwrap_or(0);
        Ok(Self::new(scope, store.clone(), Some(store), watermark))
    }

    fn new(
        scope: OpScope,
        store: Arc<dyn OpStore>,
        retention: Option<Arc<dyn OpRetention>>,
        watermark: u64,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                scope,
                store,
                retention,
                watermark: AtomicU64::new(watermark),
                slots: Mutex::new(HashMap::new()),
                next_claim: AtomicU64::new(0),
            }),
        }
    }

    pub fn scope(&self) -> &OpScope {
        &self.inner.scope
    }

    /// Admits a mutation (P §9.3): `Execute` for the first arrival; `Done` with the shared or
    /// stored outcome for a duplicate with the same payload; `opIdConflict` for another
    /// payload; `opFenced` for a fenced id; `opIdExpired` below the watermark. Cancelling
    /// `ctx` stops only this caller's wait.
    pub async fn begin(&self, req: &OpRequest, ctx: &CallContext) -> Result<Begin, CoreError> {
        let at = op_time_ms(&req.id, "opId")?;
        self.inner.unexpired(&req.id, at)?;
        let claim = loop {
            let (signal, executing) = {
                let mut slots = self.inner.lock();
                match slots.get(&req.id) {
                    None => break self.inner.claim(&mut slots, &req.id),
                    Some(Slot {
                        kind: SlotKind::Executing { digest },
                        signal,
                        ..
                    }) => {
                        if *digest != req.digest {
                            return Err(CoreError::OpIdConflict {
                                op_id: req.id.clone(),
                            });
                        }
                        (signal.clone(), true)
                    }
                    Some(slot) => (slot.signal.clone(), false),
                }
            };
            if executing {
                if let Some(outcome) = settled(signal, ctx).await? {
                    return Ok(Begin::Done(outcome));
                }
            } else {
                changed(signal, ctx).await?;
            }
        };
        match self.inner.store.get(&req.id).await? {
            Some(OpRecord::Fenced) => Err(CoreError::OpFenced {
                op_id: req.id.clone(),
            }),
            Some(OpRecord::Settled { digest, state, .. }) => {
                if digest == req.digest {
                    Ok(Begin::Done(OpOutcome::from_state(state)))
                } else {
                    Err(CoreError::OpIdConflict {
                        op_id: req.id.clone(),
                    })
                }
            }
            None => {
                // A prune that raced the lookup moved the watermark before deleting.
                self.inner.unexpired(&req.id, at)?;
                Ok(Begin::Execute(claim.execute(req.clone())))
            }
        }
    }

    /// `op/status` (P §9.4): one status per id, in order. With `fence`, an id not found and
    /// not below the watermark is recorded fenced before its `notApplied` answer.
    pub async fn status(
        &self,
        ids: &[OpId],
        fence: bool,
        ctx: &CallContext,
    ) -> Result<Vec<OpStatus>, CoreError> {
        let mut statuses = Vec::with_capacity(ids.len());
        for id in ids {
            statuses.push(self.status_one(id, fence, ctx).await?);
        }
        Ok(statuses)
    }

    async fn status_one(
        &self,
        id: &OpId,
        fence: bool,
        ctx: &CallContext,
    ) -> Result<OpStatus, CoreError> {
        let at = op_time_ms(id, "opIds")?;
        if self.inner.unexpired(id, at).is_err() {
            return Ok(OpStatus::Expired);
        }
        let _claim = loop {
            let busy = {
                let mut slots = self.inner.lock();
                match slots.get(id) {
                    None => break self.inner.claim(&mut slots, id),
                    Some(Slot {
                        kind: SlotKind::Executing { .. },
                        ..
                    }) => return Ok(OpStatus::InProgress),
                    Some(slot) => slot.signal.clone(),
                }
            };
            changed(busy, ctx).await?;
        };
        let status = match self.inner.store.get(id).await? {
            Some(OpRecord::Fenced) => OpStatus::NotApplied,
            Some(OpRecord::Settled { state, .. }) => OpOutcome::from_state(state).into_status(),
            None if self.inner.unexpired(id, at).is_err() => OpStatus::Expired,
            None => {
                if fence {
                    self.inner.store.put(id, OpRecord::Fenced).await?;
                }
                OpStatus::NotApplied
            }
        };
        Ok(status)
    }

    /// One bounded retention step (P §9.5) on the owner's maintenance path. Advances the
    /// persisted watermark to the newest time that keeps 7 days and the newest 10,000 ops,
    /// then deletes up to one batch below it; `more` asks for another step. A thread scope
    /// has nothing to prune.
    pub async fn prune_step(&self, now_ms: u64) -> Result<PruneStep, CoreError> {
        let Some(retention) = &self.inner.retention else {
            return Ok(PruneStep::default());
        };
        if let Some(nth_newest) = retention.nth_newest_ms(KEEP_NEWEST).await? {
            let cutoff = now_ms.saturating_sub(KEEP_MS).min(nth_newest);
            if cutoff > self.inner.watermark.load(Ordering::SeqCst) {
                // Persisted and published before any delete, so a lookup that misses a
                // deleted record always sees the new watermark afterwards.
                retention.set_watermark(cutoff).await?;
                self.inner.watermark.store(cutoff, Ordering::SeqCst);
            }
        }
        let watermark = self.inner.watermark.load(Ordering::SeqCst);
        if watermark == 0 {
            return Ok(PruneStep::default());
        }
        let deleted = retention.delete_before(watermark, PRUNE_BATCH).await?;
        Ok(PruneStep {
            deleted,
            more: deleted == PRUNE_BATCH,
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PruneStep {
    pub deleted: usize,
    pub more: bool,
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, HashMap<OpId, Slot>> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn unexpired(&self, id: &OpId, at: u64) -> Result<(), CoreError> {
        let watermark = self.watermark.load(Ordering::SeqCst);
        if at < watermark {
            return Err(CoreError::OpIdExpired {
                op_id: id.clone(),
                watermark: watermark_text(watermark),
            });
        }
        Ok(())
    }

    fn claim(self: &Arc<Self>, slots: &mut HashMap<OpId, Slot>, id: &OpId) -> Claim {
        let claim = self.next_claim.fetch_add(1, Ordering::Relaxed);
        let (signal_tx, signal) = watch::channel(None);
        slots.insert(
            id.clone(),
            Slot {
                claim,
                kind: SlotKind::Busy,
                signal,
            },
        );
        Claim {
            inner: self.clone(),
            id: id.clone(),
            claim,
            signal: signal_tx,
        }
    }
}

/// Waits on an executing slot: `Some` with the outcome of its execution, `None` when it was
/// abandoned, after which the caller decides again.
async fn settled(
    mut signal: watch::Receiver<Option<OpOutcome>>,
    ctx: &CallContext,
) -> Result<Option<OpOutcome>, CoreError> {
    let wait = async move {
        signal
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|outcome| outcome.clone())
    };
    ctx.cancel
        .run_until_cancelled(wait)
        .await
        .ok_or(CoreError::ConnectionClosed)
}

/// Waits on a busy slot until it turns executing or is released; the caller decides again.
async fn changed(
    mut signal: watch::Receiver<Option<OpOutcome>>,
    ctx: &CallContext,
) -> Result<(), CoreError> {
    let wait = async move {
        let _ = signal.changed().await;
    };
    ctx.cancel
        .run_until_cancelled(wait)
        .await
        .ok_or(CoreError::ConnectionClosed)
}

/// Holds an op's slot; dropping it releases the slot and wakes its waiters.
struct Claim {
    inner: Arc<Inner>,
    id: OpId,
    claim: u64,
    signal: watch::Sender<Option<OpOutcome>>,
}

impl Claim {
    fn execute(self, request: OpRequest) -> OpTicket {
        if let Some(slot) = self.inner.lock().get_mut(&self.id)
            && slot.claim == self.claim
        {
            slot.kind = SlotKind::Executing {
                digest: request.digest.clone(),
            };
        }
        self.signal.send_replace(None);
        OpTicket {
            claim: self,
            request,
        }
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        let mut slots = self.inner.lock();
        if slots
            .get(&self.id)
            .is_some_and(|slot| slot.claim == self.claim)
        {
            slots.remove(&self.id);
        }
    }
}

/// The one execution of an op. Settle it with [`Self::complete`] or [`Self::finish`];
/// dropping it unsettled (the execution failed with nothing applied) lets a duplicate
/// execute.
pub struct OpTicket {
    claim: Claim,
    request: OpRequest,
}

impl OpTicket {
    pub fn request(&self) -> &OpRequest {
        &self.request
    }

    /// Records `externalPending{effect, target}` durably; call before the external action
    /// starts (P §9.6).
    pub async fn external_pending(
        &self,
        effect: Arc<str>,
        target: Arc<str>,
    ) -> Result<(), CoreError> {
        self.record(OpState::ExternalPending { effect, target })
            .await
    }

    /// Records `outcome` durably, then completes. For outcomes not carried by the owner's own
    /// mutation write: rejections and the end of an external action.
    pub async fn finish(self, outcome: OpOutcome) -> Result<(), CoreError> {
        self.record(outcome.clone().into_state()).await?;
        self.complete(outcome);
        Ok(())
    }

    /// Hands `outcome` to every waiting duplicate and releases the op. The owner's mutation
    /// write already carries the record, readable through the scope's store.
    pub fn complete(self, outcome: OpOutcome) {
        self.claim.signal.send_replace(Some(outcome));
    }

    async fn record(&self, state: OpState) -> Result<(), CoreError> {
        let record = OpRecord::Settled {
            method: self.request.method.clone(),
            digest: self.request.digest.clone(),
            state,
        };
        self.claim.inner.store.put(&self.request.id, record).await
    }
}
