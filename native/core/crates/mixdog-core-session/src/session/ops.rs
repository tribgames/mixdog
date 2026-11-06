//! Thread-scope op ids inside the actor (P §9.3): one execution per `(thread, opId)`. A
//! duplicate with the same payload digest attaches to the running execution or replays its
//! stored answer; a different digest is `opIdConflict`. A failed barrier forgets the op (not
//! applied), so the same op id may run again. Ops applied by earlier actor instances are found
//! through the durable op index (`core::ops`, WP-FEED) before the request reaches the actor.

use std::collections::HashMap;
use std::collections::VecDeque;

use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::OpId;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;
use tokio::sync::oneshot;

pub(crate) type Waiter = oneshot::Sender<Result<Reply, CoreError>>;

enum State {
    InProgress { digest: String, waiters: Vec<Waiter> },
    Done { digest: String, result: Value },
}

pub(crate) enum Admit {
    /// Execute; the waiter is handed back.
    New(Waiter),
    /// Answered (replayed, attached or refused).
    Handled,
}

/// Retained applied ops per actor (P §9.5 keeps ≥ 10,000 per scope durably).
const RETAIN: usize = 10_000;

#[derive(Default)]
pub(crate) struct OpTable {
    ops: HashMap<OpId, State>,
    order: VecDeque<OpId>,
}

/// `sha256:` of the canonical JSON of `params` without `opId` (P §9.2).
pub(crate) fn digest(params: &Value) -> String {
    let mut params = params.clone();
    if let Value::Object(fields) = &mut params {
        fields.shift_remove("opId");
    }
    let bytes = serde_json::to_vec(&canonical(params)).expect("json serializes");
    let hash = Sha256::digest(&bytes);
    let mut out = String::with_capacity(71);
    out.push_str("sha256:");
    for byte in hash {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Object keys sorted at every level.
fn canonical(value: Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut sorted: Vec<(String, Value)> = fields.into_iter().collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(sorted.into_iter().map(|(k, v)| (k, canonical(v))).collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(canonical).collect()),
        other => other,
    }
}

impl OpTable {
    pub fn admit(&mut self, op: &OpId, digest: &str, waiter: Waiter) -> Admit {
        match self.ops.get_mut(op) {
            None => {
                self.ops.insert(
                    op.clone(),
                    State::InProgress {
                        digest: digest.to_owned(),
                        waiters: Vec::new(),
                    },
                );
                Admit::New(waiter)
            }
            Some(State::InProgress { digest: d, waiters }) if d == digest => {
                waiters.push(waiter);
                Admit::Handled
            }
            Some(State::Done { digest: d, result }) if d == digest => {
                let _ = waiter.send(Ok(Reply::Value(result.clone())));
                Admit::Handled
            }
            Some(_) => {
                let _ = waiter.send(Err(CoreError::OpIdConflict { op_id: op.clone() }));
                Admit::Handled
            }
        }
    }

    pub fn applied(&mut self, op: &OpId, result: &Value) {
        if let Some(State::InProgress { digest, waiters }) = self.ops.remove(op) {
            for waiter in waiters {
                let _ = waiter.send(Ok(Reply::Value(result.clone())));
            }
            self.ops.insert(
                op.clone(),
                State::Done {
                    digest,
                    result: result.clone(),
                },
            );
            self.order.push_back(op.clone());
            while self.order.len() > RETAIN {
                if let Some(old) = self.order.pop_front() {
                    self.ops.remove(&old);
                }
            }
        }
    }

    pub fn failed(&mut self, op: &OpId, error: &CoreError) {
        if let Some(State::InProgress { waiters, .. }) = self.ops.remove(op) {
            for waiter in waiters {
                let _ = waiter.send(Err(error.clone()));
            }
        }
    }
}
