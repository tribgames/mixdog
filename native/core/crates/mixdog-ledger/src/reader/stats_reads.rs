//! Reuse ledger inputs, not the clock-dependent statistics document. The slot for a
//! completed read is still per question: a moving window does not accumulate rollups.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{LedgerError, Result};
use crate::reply::{ReplyRx, ReplyTx, reply};
use crate::rollup::RollupQuery;
use crate::stats::StatsData;

const REUSE: Duration = Duration::from_secs(10);
const KEPT: usize = 16;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct ReadKey {
    pub(super) stamp: String,
    pub(super) query: RollupQuery,
    // cached_rollup distinguishes today from completed days.
    pub(super) today: String,
}

type Outcome = Result<Arc<StatsData>, Arc<LedgerError>>;

struct Kept {
    key: ReadKey,
    completed: Instant,
    data: Arc<StatsData>,
}

#[derive(Default)]
struct State {
    recent: HashMap<String, Kept>,
    pending: HashMap<ReadKey, Vec<ReplyTx<Outcome>>>,
}

#[derive(Default)]
pub(super) struct StatsReads(Mutex<State>);

pub(super) enum Claim<'a> {
    Ready(Arc<StatsData>),
    Join(ReplyRx<Outcome>),
    Read(Flight<'a>),
}

impl StatsReads {
    pub(super) fn claim(&self, question: String, key: ReadKey) -> Claim<'_> {
        let mut state = self.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(kept) = state.recent.get(&question)
            && kept.key == key
            && kept.completed.elapsed() < REUSE
        {
            return Claim::Ready(kept.data.clone());
        }
        if let Some(waiters) = state.pending.get_mut(&key) {
            let (tx, rx) = reply();
            waiters.push(tx);
            return Claim::Join(rx);
        }
        state.pending.insert(key.clone(), Vec::new());
        Claim::Read(Flight { reads: self, question, key, result: None })
    }
}

pub(super) struct Flight<'a> {
    reads: &'a StatsReads,
    question: String,
    key: ReadKey,
    result: Option<Outcome>,
}

impl Flight<'_> {
    pub(super) fn finish(mut self, result: Result<StatsData>) -> Result<Arc<StatsData>> {
        let result = result.map(Arc::new).map_err(Arc::new);
        self.result = Some(result.clone());
        result.map_err(LedgerError::SharedStats)
    }
}

impl Drop for Flight<'_> {
    fn drop(&mut self) {
        let result = self.result.take().unwrap_or_else(|| Err(Arc::new(LedgerError::Stopped)));
        let waiters = {
            let mut state = self.reads.0.lock().unwrap_or_else(|p| p.into_inner());
            let waiters = state.pending.remove(&self.key).expect("owned statistics read");
            if let Ok(data) = &result {
                if state.recent.len() >= KEPT && !state.recent.contains_key(&self.question) {
                    state.recent.clear();
                }
                state.recent.insert(std::mem::take(&mut self.question), Kept { key: self.key.clone(), completed: Instant::now(), data: data.clone() });
            }
            waiters
        };
        for waiter in waiters {
            waiter.send(result.clone());
        }
    }
}

#[cfg(test)]
pub(super) mod tests;
