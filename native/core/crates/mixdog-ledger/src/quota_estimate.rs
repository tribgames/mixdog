//! The value of one quota point in dollars, and the share of a meter rise that came from outside
//! Mixdog (`quota-value-estimate.mjs`).
//!
//! A quota rise is the recorded requests plus nonnegative outside usage. A heavy-tailed
//! measurement component and an exponentially modified Gaussian outside component are fitted
//! to the priced history, recent observations weighing more. The noise scale is an assumption,
//! not a provider accuracy guarantee; callers describe the result as an estimate. Every
//! operation is evaluated as V8 evaluates it (`mixdog_js::math`), so the figures match Node's.

// `!(x > 0)` is true for NaN, which `x <= 0` is not: the estimate's guards are written as
// Node writes them.
#![allow(
    clippy::neg_cmp_op_on_partial_ord,
    reason = "NaN must take the guard's branch"
)]

use mixdog_js::math::exp;
use mixdog_js::math::exp_m1;
use mixdog_js::math::hypot;
use mixdog_js::math::ln;
use mixdog_js::math::ln_1p;
use mixdog_js::math::max;
use mixdog_js::math::min;
use mixdog_js::math::pow;

const NOISE: f64 = 0.06;
const MAX_SAMPLES: usize = 180;
// Influence halves per this many newer quota points. Idle time adds no evidence.
const HALF_LIFE_POINTS: f64 = 32.0;
const FLOOR: f64 = 1e-300;
// Week-to-week drift of one allowance's value, and how far outside use routinely pulls a
// window's own estimate down.
const WINDOW_DRIFT: f64 = 0.08;
const OUTSIDE_PULL: f64 = 0.25;

fn root_two_pi() -> f64 {
    (2.0 * std::f64::consts::PI).sqrt()
}

/// What a meter rise is weighed by when the records behind it are split.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weight {
    Turns,
    CostUsd,
    Tokens,
}

/// One meter rise of one window with the records behind it.
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
    pub resolution: f64,
    pub measured: bool,
    pub priced: bool,
    pub mixed: bool,
}

/// A fitted value: dollars per quota point and the outside-use mixture.
#[derive(Clone, Debug)]
pub struct Estimate {
    pub rate: f64,
    pub cost_per_percent: f64,
    pub mixed: f64,
    pub scale: f64,
    pub resolution: f64,
    pub samples: usize,
}

fn by_end(a: &Interval, b: &Interval) -> std::cmp::Ordering {
    a.to_ms
        .partial_cmp(&b.to_ms)
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn usable(row: &Interval) -> bool {
    row.priced
        && row.cost_usd.is_finite()
        && row.cost_usd > 0.0
        && row.points.is_finite()
        && row.points > 0.0
}

/// One-sided support from chronological prefixes, before the recent-fit cap. Outside use can
/// only enlarge the denominator, so even contaminated prefixes give conservative lower support
/// for own dollars per quota point.
fn own_value_support(history: &[Interval]) -> f64 {
    let z = (2.0 * ln((2.0 * max(1.0, history.len() as f64)) / 0.01)).sqrt();
    let (mut cost, mut points, mut squares, mut rounding) = (0.0, 0.0, 0.0, 0.0);
    let mut block_resolution = 0.0;
    let mut previous: Option<&Interval> = None;
    let mut support = 0.0;
    for row in history {
        if !row.priced
            || !row.measured
            || !(row.cost_usd > 0.0)
            || !row.cost_usd.is_finite()
            || !(row.points > 0.0)
            || !row.points.is_finite()
        {
            previous = None;
            continue;
        }
        let resolution = row.resolution;
        match previous {
            Some(p) if p.to_ms == row.from_ms => {
                if resolution > block_resolution {
                    rounding += resolution - block_resolution;
                    block_resolution = resolution;
                }
            }
            _ => {
                block_resolution = resolution;
                rounding += resolution;
            }
        }
        cost += row.cost_usd;
        points += row.points;
        squares += row.cost_usd * row.cost_usd;
        support = max(
            support,
            (cost - z * NOISE * squares.sqrt()) / (points + rounding),
        );
        previous = Some(row);
    }
    support
}

// Abramowitz–Stegun 7.1.26, evaluated as erfc to retain the normal tail.
fn erfc(value: f64) -> f64 {
    let x = value.abs();
    let t = 1.0 / (1.0 + 0.327_591_1 * x);
    let tail = ((((1.061_405_429 * t - 1.453_152_027) * t + 1.421_413_741) * t - 0.284_496_736)
        * t
        + 0.254_829_592)
        * t
        * exp(-x * x);
    if value < 0.0 { 2.0 - tail } else { tail }
}

#[derive(Clone)]
struct Sample {
    points: f64,
    cost_usd: f64,
    resolution: f64,
    measured: bool,
    weight: f64,
}

fn weighted_quantile(sorted: &[Sample], fraction: f64, total: f64) -> f64 {
    let mut weight = 0.0;
    for sample in sorted {
        weight += sample.weight;
        if weight >= total * fraction {
            return sample.points / sample.cost_usd;
        }
    }
    let last = &sorted[sorted.len() - 1];
    last.points / last.cost_usd
}

struct Densities {
    clean: f64,
    outside: f64,
    sigma: f64,
    delta: f64,
    tau: f64,
}

fn densities(
    points: f64,
    cost_usd: f64,
    resolution: f64,
    measured: bool,
    rate: f64,
    scale: f64,
) -> Densities {
    let quality: f64 = if measured { 1.0 } else { 0.25 };
    // A rise is the DIFFERENCE of two rounded meter readings. Their endpoint errors contribute
    // q²/12 each; whole-percent meters are not 0.1% data.
    let rounding_noise = resolution / 6.0_f64.sqrt();
    let sigma = hypot(&[
        NOISE * rate,
        rounding_noise / cost_usd,
        if measured { 0.0 } else { rate },
    ]) / quality.sqrt();
    let delta = points / cost_usd - rate;
    let tau = scale * rate;
    let z = delta / sigma;
    let normal = exp(-0.5 * (z * z)) / (root_two_pi() * sigma);
    // A small Student-t tail tolerates obsolete or irregular measurements.
    let tail = (0.375 / sigma) * pow(1.0 + (z * z) / 4.0, -2.5);
    let clean = max(FLOOR, 0.95 * normal + 0.05 * tail);
    let outside = max(
        FLOOR,
        (exp(min(
            700.0,
            (sigma * sigma) / (2.0 * (tau * tau)) - delta / tau,
        )) * erfc(((sigma * sigma) / tau - delta) / (std::f64::consts::SQRT_2 * sigma)))
            / (2.0 * tau),
    );
    Densities {
        clean,
        outside,
        sigma,
        delta,
        tau,
    }
}

/// One priced observation with its measurement weight. An inferred opening or saturated meter
/// is weaker evidence, not a reason to discard its dollars.
fn observation(row: &Interval) -> Sample {
    let quality = if row.measured { 1.0 } else { 0.25 };
    let p2 = row.points * row.points;
    let precision = p2 / (p2 + (row.resolution * row.resolution) / 6.0);
    Sample {
        points: row.points,
        cost_usd: row.cost_usd,
        resolution: row.resolution,
        measured: row.measured,
        weight: quality * precision,
    }
}

/// How strongly the current window's own value contradicts the earlier windows', as a weight
/// for a new allowance. Outside use can only LOWER a window's own value, so a lower value must
/// also exceed that pull; a higher one cannot come from outside use at all.
fn allowance_change(own: f64, earlier: f64, points: f64) -> f64 {
    let spread = hypot(&[0.5 / points, NOISE / points.sqrt(), WINDOW_DRIFT]);
    let shift = ln(own / earlier);
    let z = (if shift > 0.0 {
        shift
    } else {
        max(0.0, -shift - OUTSIDE_PULL)
    }) / spread;
    1.0 / (1.0 + exp(-2.0 * (z - 3.0)))
}

/// Observations of ONE account's limit: `intervals` from the current window, `prior` from its
/// earlier windows. The pooled fit continues the earlier windows until the current window's own
/// value clearly contradicts them.
pub fn estimate_quota_value(intervals: &[Interval], prior: &[Interval]) -> Option<Estimate> {
    let mut sorted = intervals.to_vec();
    sorted.sort_by(by_end);
    let lower_bound = own_value_support(&sorted);
    let own = fit_quota_value(intervals, &[], lower_bound);
    let earlier: Vec<Interval> = prior.iter().filter(|row| usable(row)).cloned().collect();
    if earlier.is_empty() {
        return own;
    }
    let pooled = fit_quota_value(intervals, &earlier, lower_bound);
    let Some(own) = own else {
        return pooled;
    };
    let pooled = pooled?;
    let points: f64 = intervals
        .iter()
        .filter(|row| usable(row) && row.measured)
        .fold(0.0, |sum, row| sum + row.points);
    let change_weight = if points > 0.0 {
        let earlier_fit = fit_quota_value(&[], &earlier, 0.0)?;
        allowance_change(own.cost_per_percent, earlier_fit.cost_per_percent, points)
    } else {
        0.0
    };
    let cost_per_percent =
        (1.0 - change_weight) * pooled.cost_per_percent + change_weight * own.cost_per_percent;
    let base = if change_weight > 0.5 { own } else { pooled };
    Some(Estimate {
        rate: 1.0 / cost_per_percent,
        cost_per_percent,
        ..base
    })
}

/// The mixture fit over the current window and any earlier windows. Recent fitting is bounded,
/// but older own-use evidence must not expire merely because web use persists.
fn fit_quota_value(
    intervals: &[Interval],
    prior: &[Interval],
    own_value_lower_bound: f64,
) -> Option<Estimate> {
    let rate_ceiling = if own_value_lower_bound > 0.0 {
        1.0 / own_value_lower_bound
    } else {
        f64::INFINITY
    };
    let mut history: Vec<&Interval> = prior
        .iter()
        .chain(intervals)
        .filter(|row| usable(row))
        .collect();
    history.sort_by(|a, b| by_end(a, b));
    if history.is_empty() {
        return None;
    }
    let history = &history[history.len().saturating_sub(MAX_SAMPLES)..];
    let mut newer_points = 0.0;
    let mut samples: Vec<Sample> = history
        .iter()
        .rev()
        .map(|row| {
            let recency = pow(2.0, -newer_points / HALF_LIFE_POINTS);
            newer_points += row.points;
            let sample = observation(row);
            Sample {
                weight: recency * sample.weight,
                ..sample
            }
        })
        .collect();
    samples.reverse();
    let sum = |f: &dyn Fn(&Sample) -> f64| samples.iter().fold(0.0, |s, row| s + f(row));
    let information = sum(&|r| r.weight);
    let cost = sum(&|r| r.weight * r.cost_usd);
    let points = sum(&|r| r.weight * r.points);
    // Never train a faster own-use rate from an excess total-meter rise that contradicts
    // existing own-value support. Fit its outside component instead.
    let historical_rate = min(points / cost, rate_ceiling);
    let density = |s: &Sample, rate: f64, scale: f64| {
        densities(s.points, s.cost_usd, s.resolution, s.measured, rate, scale)
    };
    let baseline_score = samples.iter().fold(0.0, |s, row| {
        s + row.weight * ln(density(row, historical_rate, 0.7).clean)
    });
    let mut by_rate = samples.clone();
    by_rate.sort_by(|a, b| {
        (a.points / a.cost_usd - b.points / b.cost_usd)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let lower = weighted_quantile(&by_rate, 0.1, information) * 0.65;
    let upper = weighted_quantile(&by_rate, 0.6, information) * 1.15;
    let mut step = (upper - lower) / 40.0;
    let mut candidates: Vec<f64> = std::iter::once(historical_rate)
        .chain((0..41).map(|i| lower + f64::from(i) * step))
        .collect();
    let (mut best_rate, mut best_scale, mut best_mixed) = (historical_rate, 0.7, 0.0);
    let mut best_score = baseline_score;
    for _ in 0..3 {
        for &rate in &candidates {
            if !(rate > 0.0) || rate > rate_ceiling {
                continue;
            }
            for scale in [0.15, 0.7, 3.0] {
                let pairs: Vec<Densities> =
                    samples.iter().map(|s| density(s, rate, scale)).collect();
                for mixed in [0.0, 0.25, 0.5, 0.75, 0.9] {
                    let mut score = 0.0;
                    for (pair, sample) in pairs.iter().zip(&samples) {
                        score +=
                            sample.weight * ln((1.0 - mixed) * pair.clean + mixed * pair.outside);
                    }
                    if score > best_score {
                        best_score = score;
                        best_rate = rate;
                        best_scale = scale;
                        best_mixed = mixed;
                    }
                }
            }
        }
        let radius = step;
        step /= 5.0;
        candidates = (0..11)
            .map(|i| best_rate - radius + f64::from(i) * step)
            .collect();
    }
    // The two additional mixture parameters pay a log-information penalty; the remaining
    // likelihood evidence smoothly controls the correction.
    let evidence = max(0.0, best_score - baseline_score - ln_1p(information));
    let correction_weight = -exp_m1(-evidence);
    let cost_per_percent =
        (1.0 - correction_weight) / historical_rate + correction_weight / best_rate;
    let last = samples.last()?;
    Some(Estimate {
        rate: 1.0 / cost_per_percent,
        cost_per_percent,
        mixed: correction_weight * best_mixed,
        scale: best_scale,
        resolution: last.resolution,
        samples: samples.len(),
    })
}

/// A meter reading inside a finer window.
#[derive(Clone, Copy, Debug)]
pub struct Reading {
    pub ts: f64,
    pub used_pct: f64,
}

/// One finer window: its opening and its readings.
pub struct FinerWindow<'a> {
    pub start_ms: f64,
    pub readings: &'a [Reading],
}

/// A span in which a finer meter rose beyond what Mixdog's own spending explains.
#[derive(Clone, Copy, Debug)]
pub struct Span {
    pub from_ms: f64,
    pub to_ms: f64,
}

/// Spans where a finer meter rose beyond what Mixdog's own spending explains. Each finer window
/// restarts from an exact zero, so a whole-percent reading v proves more than v - 1 points of
/// use since its start. Windows shown to hold outside use never calibrate; the median is
/// retaken over the rest until none drops out. Spending up to `lag_ms` after a reading counts,
/// since requests are recorded on completion.
pub fn outside_spans(
    windows: &[FinerWindow],
    cost_between: &dyn Fn(f64, f64) -> f64,
    lag_ms: f64,
) -> Vec<Span> {
    let last_of = |w: &FinerWindow| w.readings[w.readings.len() - 1];
    let median_rate = |rated: &[usize]| {
        let mut rates: Vec<f64> = rated
            .iter()
            .map(|&i| {
                let last = last_of(&windows[i]);
                cost_between(windows[i].start_ms, last.ts + lag_ms) / (last.used_pct - 0.5)
            })
            .collect();
        rates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        rates.get(rates.len() / 2).copied().unwrap_or(f64::NAN)
    };
    let spans_in = |window: &FinerWindow, rate: f64| {
        let mut spans = Vec::new();
        let (mut from_ms, mut previous, mut excess) = (window.start_ms, 0.0, 0.0);
        for reading in window.readings {
            let expected = cost_between(window.start_ms, reading.ts + lag_ms) / rate;
            let unexplained = reading.used_pct - 1.0 - expected;
            if reading.used_pct > previous
                && (expected == 0.0
                    || (unexplained > 0.3 * expected + 0.25 && unexplained > excess))
            {
                spans.push(Span {
                    from_ms,
                    to_ms: reading.ts,
                });
            }
            excess = max(excess, unexplained);
            from_ms = reading.ts;
            previous = reading.used_pct;
        }
        spans
    };
    let mut calibrating: Vec<usize> = (0..windows.len())
        .filter(|&i| last_of(&windows[i]).used_pct >= 4.0)
        .collect();
    let mut rate = median_rate(&calibrating);
    if !(rate > 0.0) {
        return Vec::new();
    }
    loop {
        let found: Vec<Vec<Span>> = windows.iter().map(|w| spans_in(w, rate)).collect();
        let kept: Vec<usize> = calibrating
            .iter()
            .copied()
            .filter(|&i| found[i].is_empty())
            .collect();
        if kept.is_empty() || kept.len() == calibrating.len() {
            return found.into_iter().flatten().collect();
        }
        calibrating = kept;
        rate = median_rate(&calibrating);
    }
}

/// Expected outside percentage points of a rise, bounded by the actual meter rise.
pub fn estimate_outside_quota(interval: &Interval, model: Option<&Estimate>) -> f64 {
    let Some(model) = model else { return 0.0 };
    if !(interval.points > 0.0) || !(interval.cost_usd > 0.0) || model.mixed == 0.0 {
        return 0.0;
    }
    let d = densities(
        interval.points,
        interval.cost_usd,
        interval.resolution,
        interval.measured,
        model.rate,
        model.scale,
    );
    let probability =
        (model.mixed * d.outside) / ((1.0 - model.mixed) * d.clean + model.mixed * d.outside);
    let a = (d.delta - (d.sigma * d.sigma) / d.tau) / d.sigma;
    let extra = if a < -10.0 {
        // The inverse Mills ratio's tail avoids subtracting two large numbers.
        let z = -a;
        d.sigma * (1.0 / z - 2.0 / pow(z, 3.0) + 10.0 / pow(z, 5.0))
    } else {
        let cdf = 0.5 * erfc(-a / std::f64::consts::SQRT_2);
        d.sigma * (a + exp(-0.5 * a * a) / (root_two_pi() * max(FLOOR, cdf)))
    };
    min(
        interval.points,
        max(0.0, interval.cost_usd * probability * extra),
    )
}
