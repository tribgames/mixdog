//! What a quota point is worth in dollars, from the meter rises the records cover.

/// What a meter rise is weighed by when the records behind it are split.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weight {
    Turns,
    CostUsd,
    Tokens,
}

/// One meter rise of one window with the records behind it. Its points are Mixdog's, outside use (`external`) and
/// unattributed; a rise no record covers has no Mixdog part.
#[derive(Clone, Debug)]
pub struct Interval {
    pub from_ms: f64,
    pub to_ms: f64,
    pub points: f64,
    pub cost_usd: f64,
    pub start: usize,
    pub end: usize,
    pub weight: Weight,
    pub total: f64,
    /// Points of the rise that came from outside Mixdog.
    pub external: f64,
    /// Points the readings cannot assign to Mixdog or to outside use: a move across an unmeasured gap, or within the
    /// meter's own jitter band.
    pub unattributed: f64,
    pub priced: bool,
}

/// A fitted value: dollars per quota point.
#[derive(Clone, Debug)]
pub struct Estimate {
    pub cost_per_percent: f64,
    pub samples: usize,
}

/// A rise whose points are all Mixdog's and whose records are all priced.
pub fn is_value_evidence(row: &Interval) -> bool {
    row.priced
        && row.total > 0.0
        && row.external == 0.0
        && row.unattributed == 0.0
        && row.cost_usd.is_finite()
        && row.cost_usd > 0.0
        && row.points.is_finite()
        && row.points > 0.0
}

/// Dollars per point: the cost of the covered priced rises over the points they moved; `samples`
/// is how many records stand behind them.
pub fn quota_value(evidence: &[&Interval], samples: usize) -> Option<Estimate> {
    let (cost, points) = evidence.iter().fold((0.0, 0.0), |(cost, points), row| (cost + row.cost_usd, points + row.points));
    (points > 0.0).then(|| Estimate { cost_per_percent: cost / points, samples })
}