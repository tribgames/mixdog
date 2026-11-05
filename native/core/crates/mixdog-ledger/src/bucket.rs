//! The per-bucket measurement algebra (`usage-ledger-rollup.mjs` `empty`/`add`): one
//! accumulator for a day, a route, or either's conversation share.

use std::collections::BTreeMap;

use serde_json::Map;
use serde_json::Value;

use crate::measure::is_unmeasuring_provider;
use crate::measure::js_number;

/// One stored amount: a daily row, a sum of events, or a session-day sum.
pub struct Amount<'a> {
    pub provider: &'a str,
    pub turns: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub cost_usd: Option<f64>,
    pub cost_source: &'a str,
    pub duration_ms: f64,
    /// Recorded without provider usage, whatever its provider.
    pub unmeasured: bool,
}

#[derive(Clone, Debug)]
pub struct Bucket {
    pub turns: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub cost_usd: f64,
    pub cost_billed: f64,
    pub cost_estimated: f64,
    pub cost_known_turns: f64,
    pub duration_ms: f64,
    pub duration_turns: f64,
    pub unmeasured_turns: f64,
    pub sessions: BTreeMap<String, f64>,
    pub sessions_complete: bool,
}

impl Bucket {
    pub fn new() -> Self {
        Bucket {
            turns: 0.0,
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            cost_usd: 0.0,
            cost_billed: 0.0,
            cost_estimated: 0.0,
            cost_known_turns: 0.0,
            duration_ms: 0.0,
            duration_turns: 0.0,
            unmeasured_turns: 0.0,
            sessions: BTreeMap::new(),
            sessions_complete: true,
        }
    }

    /// Adds `amount` (`sign` -1 takes it back out: a model's Fast calls leave its normal route).
    pub fn add(&mut self, amount: &Amount<'_>, sign: f64) {
        let cost = amount.cost_usd.unwrap_or(0.0);
        let (mut input, mut cache_read, mut cache_write) =
            (amount.input, amount.cache_read, amount.cache_write);
        let (mut cost_usd, mut known, mut billed, mut estimated) = (
            cost,
            if amount.cost_source != "unpriced" {
                amount.turns
            } else {
                0.0
            },
            if amount.cost_source == "provider" {
                cost
            } else {
                0.0
            },
            if amount.cost_source == "provider" {
                0.0
            } else {
                cost
            },
        );
        let mut unmeasured = 0.0;
        if is_unmeasuring_provider(amount.provider) {
            (input, cache_read, cache_write) = (0.0, 0.0, 0.0);
            (cost_usd, known, billed, estimated) = (0.0, 0.0, 0.0, 0.0);
            unmeasured = amount.turns;
        }
        if amount.unmeasured && unmeasured == 0.0 {
            unmeasured = amount.turns;
        }
        self.turns += sign * amount.turns;
        self.input += sign * input;
        self.output += sign * amount.output;
        self.cache_read += sign * cache_read;
        self.cache_write += sign * cache_write;
        self.cost_usd += sign * cost_usd;
        self.cost_known_turns += sign * known;
        self.cost_billed += sign * billed;
        self.cost_estimated += sign * estimated;
        self.unmeasured_turns += sign * unmeasured;
        self.duration_ms += sign * amount.duration_ms;
        if amount.duration_ms > 0.0 {
            self.duration_turns += sign * amount.turns;
        }
    }

    /// The measurement fields as a JSON object (no session map).
    pub fn measurements(&self) -> Map<String, Value> {
        let mut out = Map::new();
        for (name, value) in [
            ("turns", self.turns),
            ("input", self.input),
            ("output", self.output),
            ("cacheRead", self.cache_read),
            ("cacheWrite", self.cache_write),
            ("costUsd", self.cost_usd),
            ("costBilled", self.cost_billed),
            ("costEstimated", self.cost_estimated),
            ("costKnownTurns", self.cost_known_turns),
            ("durationMs", self.duration_ms),
            ("durationTurns", self.duration_turns),
            ("unmeasuredTurns", self.unmeasured_turns),
        ] {
            out.insert(name.to_string(), js_number(value));
        }
        out
    }

    /// The bucket as a rollup JSON object.
    pub fn to_object(&self) -> Map<String, Value> {
        let mut out = self.measurements();
        out.insert(
            "sessions".to_string(),
            Value::Object(
                self.sessions
                    .iter()
                    .map(|(id, tokens)| (id.clone(), js_number(*tokens)))
                    .collect(),
            ),
        );
        out.insert(
            "sessionsComplete".to_string(),
            Value::Bool(self.sessions_complete),
        );
        out
    }
}

impl Default for Bucket {
    fn default() -> Self {
        Self::new()
    }
}
