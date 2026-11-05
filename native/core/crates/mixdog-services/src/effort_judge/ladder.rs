//! Auto effort: turns the judge's difficulty distribution into an effort by
//! moving along the model's effort ladder from a base effort. Every turn
//! starts again from the base, so a run of hard turns never ratchets the
//! effort upward.
//!
//! The judge rates four levels (easy, normal, hard, very hard), each one
//! ladder step from the base: -1, 0, +1, +2. The chosen level minimises the
//! expected cost under the distribution; opposite calls are asymmetric
//! ("easy" for a hard step degrades the answer, "hard" for an easy one only
//! costs tokens).

use mixdog_js::{js_trim};
use mixdog_agent::step_effort::StepResult;

pub const LEVELS: usize = 4;
const STEP_OF_LEVEL: [i32; LEVELS] = [-1, 0, 1, 2];
const UNDER_OPPOSITE_COST: f64 = 3.0;
const OVER_OPPOSITE_COST: f64 = 1.0;
/// Ties keep the default first, then the cheaper side.
const TIE_ORDER: [usize; LEVELS] = [1, 0, 2, 3];
const EFFORT_ORDER: [&str; 8] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const FLOOR_INDEX: usize = 2;

/// The efforts auto may choose for a model, ascending: from `low` up to the
/// tier below the top (`max`/`ultra` are reserved for an explicit choice).
pub fn ladder_of(options: &[String]) -> Vec<&'static str> {
    let supported: Vec<String> = options.iter().map(|o| js_trim(o).to_lowercase()).collect();
    EFFORT_ORDER
        .iter()
        .enumerate()
        .filter(|(index, level)| {
            supported.iter().any(|s| s == **level) && *index >= FLOOR_INDEX && !matches!(**level, "max" | "ultra")
        })
        .map(|(_, level)| *level)
        .collect()
}

fn expected_cost(values: &[f64; LEVELS], level: usize) -> f64 {
    values
        .iter()
        .enumerate()
        .map(|(actual, p)| {
            let mut cost = level.abs_diff(actual) as f64;
            if level == 0 && actual >= 2 {
                cost += UNDER_OPPOSITE_COST;
            }
            if actual == 0 && level >= 2 {
                cost += OVER_OPPOSITE_COST;
            }
            p * cost
        })
        .sum()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Judged {
    pub step: i32,
    pub level: Option<usize>,
    pub confidence: f64,
}

/// Ladder step for a judge distribution over the four levels (index 0 = easy).
pub fn judged_step(probs: &[f64]) -> Judged {
    let Ok(values) = <[f64; LEVELS]>::try_from(probs) else {
        return Judged { step: 0, level: None, confidence: 0.0 };
    };
    if values.iter().any(|v| !v.is_finite()) {
        return Judged { step: 0, level: None, confidence: 0.0 };
    }
    let confidence = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut level = TIE_ORDER[0];
    for candidate in TIE_ORDER {
        if expected_cost(&values, candidate) < expected_cost(&values, level) - 1e-12 {
            level = candidate;
        }
    }
    Judged { step: STEP_OF_LEVEL[level], level: Some(level), confidence }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub base: &'static str,
    pub effort: &'static str,
    pub step: i32,
    pub level: Option<usize>,
    pub confidence: f64,
}

/// The effort for a distribution, or None when `base` lies outside the ladder.
pub fn resolve_auto_effort(base: &str, options: &[String], probs: &[f64]) -> Option<Resolved> {
    let ladder = ladder_of(options);
    let at = ladder.iter().position(|level| *level == base.to_lowercase())?;
    let judged = judged_step(probs);
    let index = (at as i32 + judged.step).clamp(0, ladder.len() as i32 - 1) as usize;
    Some(Resolved { base: ladder[at], effort: ladder[index], step: judged.step, level: judged.level, confidence: judged.confidence })
}

/// What a resolved distribution means for a run. The default records the
/// effort on the tool result; a route with its own reasoning levels supplies
/// another implementation that also fills `StepResult::level`.
pub trait StepLadder: Send + Sync {
    fn resolve(&self, probs: &[f64]) -> Option<StepResult>;
}

/// Moves along the model's ladder from the turn's base effort.
pub struct AutoLadder {
    pub base: String,
    pub options: Vec<String>,
}

impl StepLadder for AutoLadder {
    fn resolve(&self, probs: &[f64]) -> Option<StepResult> {
        let resolved = resolve_auto_effort(&self.base, &self.options, probs)?;
        Some(StepResult { level: None, effort: Some(resolved.effort.to_owned()) })
    }
}

/// A custom (`custom-*`) route: the ladder is the model row's own effort
/// levels, and the chosen effort is snapped onto them. The snapped level is
/// both the per-request effort and the effort recorded on the tool result; a
/// distribution the row cannot place (no supported level) leaves the step as
/// it is.
pub struct CustomLadder {
    pub base: String,
    pub row: mixdog_ai::providers::custom::reasoning::ReasoningRow,
    pub protocol: mixdog_ai::providers::custom::Protocol,
    pub base_url: String,
}

impl StepLadder for CustomLadder {
    fn resolve(&self, probs: &[f64]) -> Option<StepResult> {
        let options = self.row.effort_levels().unwrap_or_default();
        let resolved = resolve_auto_effort(&self.base, &options, probs)?;
        let level = mixdog_ai::providers::custom::reasoning::resolve(
            &self.protocol,
            &self.row,
            Some(resolved.effort),
            &self.base_url,
        )
        .level?;
        Some(StepResult { level: Some(level.to_owned()), effort: Some(level.to_owned()) })
    }
}
