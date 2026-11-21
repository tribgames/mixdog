//! The op store of a non-thread scope (P §9.2, §9.5): the scope's `ops` rows and its
//! `op_watermarks` row in `state/core.sqlite`, through the store's one handle on that file.
//! A domain owner writes an applied op with [`op_row`] in the transaction of its domain change
//! (SPEC R30); the gate writes fences, rejections and external states through
//! [`OpStore::put`].

use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::error::stored::rejection_from_json;
use mixdog_core_api::error::stored::rejection_to_json;
use mixdog_core_api::ids::OpId;
use mixdog_store::sqlite::DbError;
use mixdog_store::state::CoreState;
use mixdog_store::state::OpRow;
use mixdog_store::state::OpRowState;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde_json::Value;

use super::digest::PayloadDigest;
use super::store::OpRecord;
use super::store::OpRetention;
use super::store::OpState;
use super::store::OpStore;
use super::uuid7::op_time_ms;

/// The `ops`/`op_watermarks` rows of one scope.
#[derive(Clone, Debug)]
pub struct StateOpStore {
    state: CoreState,
    scope: Arc<str>,
}

impl StateOpStore {
    /// The store of the domain scope `scope` (`config`, `account`, …).
    pub fn new(state: CoreState, scope: Arc<str>) -> Self {
        Self { state, scope }
    }

    /// The `ops.scope` key, for an owner's own `StateTx::put_op`.
    pub fn scope(&self) -> &str {
        &self.scope
    }
}

/// The `ops` row of `record` for `id`, completed at `now_ms` (an `externalPending` record is
/// not complete). `created_at` is the op id's UUIDv7 time.
pub fn op_row(id: &OpId, record: &OpRecord, now_ms: i64) -> Result<OpRow, CoreError> {
    let created_at = i64::try_from(op_time_ms(id, "opId")?).expect("a UUIDv7 time has 48 bits");
    let (method, digest, audience, state) = match record {
        OpRecord::Fenced => {
            return Ok(OpRow {
                method: String::new(),
                payload_digest: String::new(),
                state: OpRowState::Fenced,
                outcome: None,
                created_at,
                completed_at: Some(now_ms),
            });
        }
        OpRecord::Settled { method, digest, audience, state } => (method, digest, audience.as_ref(), state),
    };
    let mut row = OpRow {
        method: method.to_string(),
        payload_digest: digest.as_str().to_owned(),
        state: OpRowState::InProgress,
        outcome: None,
        created_at,
        completed_at: None,
    };
    set_op_row_outcome(&mut row, audience, state, now_ms);
    Ok(row)
}

/// Encode an audience-bound outcome in a row the owner commits in its own transaction.
pub fn set_op_row_outcome(row: &mut OpRow, audience: Option<&PayloadDigest>, state: &OpState, now_ms: i64) {
    let audience = audience.map(|a| Arc::from(a.as_str()));
    let (row_state, outcome) = match state {
        OpState::Applied { seq, result } => (OpRowState::Applied, encode(&Applied { audience, seq: *seq, result: result.clone() })),
        OpState::Rejected { error } => (OpRowState::Rejected, encode(&Rejected { audience, error: rejection_to_json(error) })),
        OpState::ExternalPending { effect, target } => {
            (OpRowState::ExternalPending, encode(&External { audience, effect: effect.clone(), target: target.clone() }))
        }
        OpState::ExternalUnknown { effect, target } => {
            (OpRowState::ExternalUnknown, encode(&External { audience, effect: effect.clone(), target: target.clone() }))
        }
    };
    row.state = row_state;
    row.outcome = Some(outcome);
    row.completed_at = (row_state != OpRowState::ExternalPending).then_some(now_ms);
}

/// The record a stored row holds.
pub fn op_record(row: OpRow) -> Result<OpRecord, CoreError> {
    let (audience, state) = match row.state {
        OpRowState::Fenced => return Ok(OpRecord::Fenced),
        // Boot recovery turns every `inProgress` row into `externalUnknown`, and the core
        // never writes one.
        OpRowState::InProgress => return Err(unreadable()),
        OpRowState::Applied => {
            let Applied { audience, seq, result } = decode(row.outcome)?;
            (audience, OpState::Applied { seq, result })
        }
        OpRowState::Rejected => {
            let Rejected { audience, error } = decode(row.outcome)?;
            (audience, OpState::Rejected { error: rejection_from_json(error)? })
        }
        OpRowState::ExternalPending => {
            let External { audience, effect, target } = decode(row.outcome)?;
            (audience, OpState::ExternalPending { effect, target })
        }
        OpRowState::ExternalUnknown => {
            let External { audience, effect, target } = decode(row.outcome)?;
            (audience, OpState::ExternalUnknown { effect, target })
        }
    };
    Ok(OpRecord::Settled {
        method: row.method.into(),
        digest: PayloadDigest::from_stored(row.payload_digest.into()),
        audience: audience.map(PayloadDigest::from_stored),
        state,
    })
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Applied {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audience: Option<Arc<str>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
    /// Present (a JSON `null` included) exactly when the result was stored.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
    result: Option<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Rejected {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audience: Option<Arc<str>>,
    error: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct External {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audience: Option<Arc<str>>,
    effect: Arc<str>,
    target: Arc<str>,
}

fn present<'de, D: Deserializer<'de>>(input: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(input).map(Some)
}

fn encode<T: Serialize>(outcome: &T) -> String {
    serde_json::to_string(outcome).expect("an op outcome always serializes")
}

fn decode<T: for<'de> Deserialize<'de>>(outcome: Option<String>) -> Result<T, CoreError> {
    let text = outcome.ok_or_else(unreadable)?;
    serde_json::from_str(&text).map_err(|_| unreadable())
}

fn unreadable() -> CoreError {
    CoreError::Internal { incident_id: "op-row-unreadable".into() }
}

fn lane_unrun(why: &str) -> CoreError {
    CoreError::Internal { incident_id: format!("{}-{why}", mixdog_rt::LaneKind::InteractiveIo.name()).into() }
}

fn store_error(error: DbError) -> CoreError {
    match error {
        // `CoreState` reads run on the interactive io lane.
        DbError::LaneFull => CoreError::QueueFull { queue: mixdog_rt::LaneKind::InteractiveIo.name().into() },
        DbError::LaneCancelled => CoreError::Cancelled { by: "caller".into() },
        DbError::LaneShutDown => lane_unrun("lane-shut-down"),
        DbError::LaneWedged => lane_unrun("lane-wedged"),
        DbError::LaneJobLost => lane_unrun("job-dropped"),
        _ => CoreError::StorageIndeterminate { scope: "state".into() },
    }
}

fn now_ms() -> i64 {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

#[async_trait]
impl OpStore for StateOpStore {
    async fn get(&self, id: &OpId) -> Result<Option<OpRecord>, CoreError> {
        let row = self.state.op(&self.scope, id.as_str()).await.map_err(store_error)?;
        row.map(op_record).transpose()
    }

    async fn put(&self, id: &OpId, record: OpRecord) -> Result<(), CoreError> {
        let row = op_row(id, &record, now_ms())?;
        let (scope, id) = (self.scope.clone(), id.clone());
        self.state.write(move |tx| tx.put_op(&scope, id.as_str(), &row)).await.map_err(store_error)
    }

    async fn watermark(&self) -> Result<Option<u64>, CoreError> {
        self.state.watermark(&self.scope).await.map_err(store_error)
    }
}

#[async_trait]
impl OpRetention for StateOpStore {
    async fn nth_newest_ms(&self, n: usize) -> Result<Option<u64>, CoreError> {
        self.state.nth_newest_ms(&self.scope, n).await.map_err(store_error)
    }

    async fn set_watermark(&self, ms: u64) -> Result<(), CoreError> {
        self.state.set_watermark(&self.scope, ms).await.map_err(store_error)
    }

    async fn delete_before(&self, ms: u64, limit: usize) -> Result<usize, CoreError> {
        self.state.delete_ops_before(&self.scope, ms, limit).await.map_err(store_error)
    }
}
