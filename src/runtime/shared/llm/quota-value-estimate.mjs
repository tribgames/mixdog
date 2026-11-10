/**
 * A quota rise is the recorded requests plus nonnegative outside usage.
 * Fit a heavy-tailed measurement component and an exponentially modified
 * Gaussian outside component, rather than dividing cost by the whole rise.
 * A sustained excess meter rise within the usual reach of outside use is NOT
 * evidence of a smaller allowance: it is observationally identical to
 * sustained web use. Historical cost/meter evidence constrains the own-use
 * rate before outside usage is inferred; only a whole new window shifted
 * beyond that reach is read as a new allowance.
 *
 * Recent observations carry more information than old ones. The historical
 * ratio is available from the first priced observation; evidence for mixed
 * use continuously increases the correction, without a sample-count gate.
 * Earlier windows of the same limit continue into a new window, so a value
 * exists from its first reading and settles on the new window's own evidence.
 *
 * The noise scale is an assumption, NOT a provider accuracy guarantee.
 * Continuous proportional outside use is unidentifiable from these inputs;
 * callers must describe the result as a Mixdog-pattern estimate.
 */
const NOISE = 0.06;
const DEFAULT_RESOLUTION = 1;
const MAX_SAMPLES = 180;
// Influence halves per this many newer quota points. Idle time adds no
// evidence, so it never ages an observation by itself.
const HALF_LIFE_POINTS = 32;
const ROOT_TWO_PI = Math.sqrt(2 * Math.PI);
const FLOOR = 1e-300;

/**
 * One-sided support from chronological prefixes, before the recent-fit cap.
 * Outside use can only enlarge the denominator, so even contaminated prefixes
 * provide conservative lower support for own dollars per quota point.
 * Endpoint rounding cancels within a contiguous block, not across missing
 * observations. The union-bound margin accounts for inspecting all prefixes.
 * This uses the assumed NOISE model; it is not a provider confidence guarantee.
 */
function ownValueSupport(history) {
  const z = Math.sqrt(2 * Math.log((2 * Math.max(1, history.length)) / 0.01));
  let cost = 0;
  let points = 0;
  let squares = 0;
  let rounding = 0;
  let blockResolution = 0;
  let previous = null;
  let support = 0;
  for (const row of history) {
    if (
      !row.priced ||
      row.measured === false ||
      !(row.costUsd > 0) ||
      !Number.isFinite(row.costUsd) ||
      !(row.points > 0) ||
      !Number.isFinite(row.points)
    ) {
      previous = null;
      continue;
    }
    const resolution = row.resolution ?? DEFAULT_RESOLUTION;
    if (!previous || (row.fromMs != null && previous.toMs !== row.fromMs)) {
      blockResolution = resolution;
      rounding += resolution;
    } else if (resolution > blockResolution) {
      rounding += resolution - blockResolution;
      blockResolution = resolution;
    }
    cost += row.costUsd;
    points += row.points;
    squares += row.costUsd ** 2;
    support = Math.max(support, (cost - z * NOISE * Math.sqrt(squares)) / (points + rounding));
    previous = row;
  }
  return support;
}

// Abramowitz–Stegun 7.1.26, evaluated as erfc to retain the normal tail.
function erfc(value) {
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const tail =
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return value < 0 ? 2 - tail : tail;
}

function weightedQuantile(sorted, fraction, total) {
  let weight = 0;
  for (const sample of sorted) {
    weight += sample.weight;
    if (weight >= total * fraction) return sample.points / sample.costUsd;
  }
  return sorted.at(-1).points / sorted.at(-1).costUsd;
}

function densities(sample, rate, scale) {
  const quality = sample.measured === false ? 0.25 : 1;
  // A rise is the DIFFERENCE of two rounded meter readings. Their endpoint
  // errors contribute q²/12 each; internal rounding errors cancel when
  // adjacent intervals are combined. Whole-percent meters are not 0.1% data.
  const roundingNoise = (sample.resolution ?? DEFAULT_RESOLUTION) / Math.sqrt(6);
  const sigma =
    Math.hypot(NOISE * rate, roundingNoise / sample.costUsd, sample.measured === false ? rate : 0) / Math.sqrt(quality);
  const delta = sample.points / sample.costUsd - rate;
  const tau = scale * rate;
  // A small Student-t tail tolerates obsolete or irregular measurements
  // without giving up the Gaussian core's sensitivity to small mixed use.
  const normal = Math.exp(-0.5 * (delta / sigma) ** 2) / (ROOT_TWO_PI * sigma);
  const tail = (0.375 / sigma) * (1 + (delta / sigma) ** 2 / 4) ** -2.5;
  const clean = Math.max(FLOOR, 0.95 * normal + 0.05 * tail);
  const outside = Math.max(
    FLOOR,
    (Math.exp(Math.min(700, sigma ** 2 / (2 * tau ** 2) - delta / tau)) *
      erfc((sigma ** 2 / tau - delta) / (Math.SQRT2 * sigma))) /
      (2 * tau)
  );
  return { clean, outside, sigma, delta, tau };
}

const byEnd = (a, b) => (a.toMs ?? 0) - (b.toMs ?? 0);
const usable = (row) =>
  row.priced && Number.isFinite(row.costUsd) && row.costUsd > 0 && Number.isFinite(row.points) && row.points > 0;

/** One priced observation with its measurement weight. An inferred opening or
 *  saturated meter is weaker evidence, not a reason to discard its dollars. */
function observation(row) {
  const quality = row.measured === false ? 0.25 : 1;
  const resolution = row.resolution ?? DEFAULT_RESOLUTION;
  const precision = row.points ** 2 / (row.points ** 2 + resolution ** 2 / 6);
  return { ...row, resolution, weight: quality * precision };
}

// Week-to-week drift of one allowance's value (model mix, list prices), and
// how far outside use routinely pulls a window's own estimate down.
const WINDOW_DRIFT = 0.08;
const OUTSIDE_PULL = 0.25;

/**
 * How strongly the current window's own value contradicts the earlier
 * windows', as a weight for a new allowance. Its spread is the endpoint
 * rounding of `points` plus per-reading noise and drift. Outside use can only
 * LOWER a window's own value, so a lower value must also exceed that pull; a
 * higher one cannot come from outside use at all.
 */
function allowanceChange(own, earlier, points) {
  const spread = Math.hypot(0.5 / points, NOISE / Math.sqrt(points), WINDOW_DRIFT);
  const shift = Math.log(own / earlier);
  const z = (shift > 0 ? shift : Math.max(0, -shift - OUTSIDE_PULL)) / spread;
  return 1 / (1 + Math.exp(-2 * (z - 3)));
}

/**
 * Observations of ONE account's limit: `intervals` from the current window,
 * `prior` from its earlier windows. No sample-count gate is required to
 * display an estimate: the earlier windows supply one from the first reading.
 * The pooled fit continues the earlier windows until the current window's
 * own value clearly contradicts them. A new allowance that raises the value,
 * or lowers it further than outside use routinely does, takes over within a
 * few points; a smaller downward shift is followed as the earlier evidence
 * decays instead.
 */
export function estimateQuotaValue(intervals, prior = []) {
  const ownValueLowerBound = ownValueSupport(intervals.toSorted(byEnd));
  const own = fitQuotaValue(intervals, [], ownValueLowerBound);
  const earlier = prior.filter(usable);
  if (!earlier.length) return own;
  const pooled = fitQuotaValue(intervals, earlier, ownValueLowerBound);
  if (!own) return pooled;
  const points = intervals
    .filter((row) => usable(row) && row.measured !== false)
    .reduce((sum, row) => sum + row.points, 0);
  const changeWeight =
    points > 0 ? allowanceChange(own.costPerPercent, fitQuotaValue([], earlier, 0).costPerPercent, points) : 0;
  const costPerPercent = (1 - changeWeight) * pooled.costPerPercent + changeWeight * own.costPerPercent;
  return { ...(changeWeight > 0.5 ? own : pooled), rate: 1 / costPerPercent, costPerPercent, changeWeight };
}

/** The mixture fit over the current window and any earlier windows. Recent
 *  fitting is bounded, but older own-use evidence must not expire merely
 *  because web use persists. The allowance may change between windows, so
 *  only the current window's own evidence bounds the rate: a provably higher
 *  value takes effect at once. */
function fitQuotaValue(intervals, prior, ownValueLowerBound) {
  const rateCeiling = ownValueLowerBound > 0 ? 1 / ownValueLowerBound : Infinity;
  const history = [...prior, ...intervals].filter(usable).toSorted(byEnd).slice(-MAX_SAMPLES);
  if (!history.length) return null;
  let newerPoints = 0;
  const samples = history
    .toReversed()
    .map((row) => {
      const recency = 2 ** (-newerPoints / HALF_LIFE_POINTS);
      newerPoints += row.points;
      const sample = observation(row);
      return { ...sample, weight: recency * sample.weight };
    })
    .reverse();
  const information = samples.reduce((sum, row) => sum + row.weight, 0);
  const cost = samples.reduce((sum, row) => sum + row.weight * row.costUsd, 0);
  const points = samples.reduce((sum, row) => sum + row.weight * row.points, 0);
  // Never train a faster own-use rate from an excess total-meter rise that
  // contradicts existing own-value support. Fit its outside component instead.
  const historicalRate = Math.min(points / cost, rateCeiling);
  const baselineScore = samples.reduce(
    (sum, row) => sum + row.weight * Math.log(densities(row, historicalRate, 0.7).clean),
    0
  );
  const sorted = samples.toSorted((a, b) => a.points / a.costUsd - b.points / b.costUsd);
  const lower = weightedQuantile(sorted, 0.1, information) * 0.65;
  const upper = weightedQuantile(sorted, 0.6, information) * 1.15;
  let step = (upper - lower) / 40;
  let candidates = [historicalRate, ...Array.from({ length: 41 }, (_, index) => lower + index * step)];
  let best = { rate: historicalRate, scale: 0.7, mixed: 0 };
  let bestScore = baselineScore;
  for (let refinement = 0; refinement < 3; refinement += 1) {
    for (const rate of candidates) {
      if (!(rate > 0) || rate > rateCeiling) continue;
      for (const scale of [0.15, 0.7, 3]) {
        const pairs = samples.map((sample) => densities(sample, rate, scale));
        for (const mixed of [0, 0.25, 0.5, 0.75, 0.9]) {
          let score = 0;
          for (let index = 0; index < pairs.length; index += 1) {
            const pair = pairs[index];
            score += samples[index].weight * Math.log((1 - mixed) * pair.clean + mixed * pair.outside);
          }
          if (score > bestScore) {
            bestScore = score;
            best = { rate, scale, mixed };
          }
        }
      }
    }
    const radius = step;
    step /= 5;
    candidates = Array.from({ length: 11 }, (_, index) => best.rate - radius + index * step);
  }
  // The two additional mixture parameters pay a log-information penalty.
  // The remaining likelihood evidence smoothly controls the correction:
  // no arbitrary number of records changes the estimator's mode.
  const evidence = Math.max(0, bestScore - baselineScore - Math.log1p(information));
  const correctionWeight = -Math.expm1(-evidence);
  const costPerPercent = (1 - correctionWeight) / historicalRate + correctionWeight / best.rate;
  const mixed = correctionWeight * best.mixed;
  return {
    rate: 1 / costPerPercent,
    costPerPercent,
    mixed,
    scale: best.scale,
    correctionWeight,
    ownValueLowerBound,
    information,
    resolution: samples.at(-1).resolution,
    samples: samples.length,
  };
}

/**
 * Spans where a finer meter rose beyond what Mixdog's own spending explains.
 * Each finer window restarts from an exact zero, so a whole-percent reading v
 * proves more than v - 1 points of use since its start, whatever the rounding.
 * Its dollars per point come from the median window (true use ≈ v - 0.5).
 * Outside use only makes a window cheaper, so when it fills many windows the
 * median sinks with them; windows shown to hold outside use therefore never
 * calibrate, and the median is retaken over the rest until none drops out.
 * Spending up to `lagMs` after a reading counts, since requests are recorded
 * on completion. Thirty percent of the expected use plus a quarter point is
 * ordinary weight noise; a rise with no spending at all is outside use
 * outright. After outside use, only further growth of the unexplained excess
 * marks another span.
 */
export function outsideSpans(windows, costBetween, { lagMs = 5 * 60_000 } = {}) {
  const medianRate = (rated) => {
    const rates = rated
      .map((window) => {
        const last = window.readings.at(-1);
        return costBetween(window.startMs, last.ts + lagMs) / (last.usedPct - 0.5);
      })
      .sort((a, b) => a - b);
    return rates[Math.floor(rates.length / 2)];
  };
  const spansIn = (window, rate) => {
    const spans = [];
    let fromMs = window.startMs;
    let previous = 0;
    let excess = 0;
    for (const reading of window.readings) {
      const expected = costBetween(window.startMs, reading.ts + lagMs) / rate;
      const unexplained = reading.usedPct - 1 - expected;
      if (
        reading.usedPct > previous &&
        (expected === 0 || (unexplained > 0.3 * expected + 0.25 && unexplained > excess))
      ) {
        spans.push({ fromMs, toMs: reading.ts });
      }
      excess = Math.max(excess, unexplained);
      fromMs = reading.ts;
      previous = reading.usedPct;
    }
    return spans;
  };
  let calibrating = windows.filter((window) => window.readings.at(-1).usedPct >= 4);
  let rate = medianRate(calibrating);
  if (!(rate > 0)) return [];
  for (;;) {
    const found = new Map(windows.map((window) => [window, spansIn(window, rate)]));
    // A window kept here has no unexplained rise, so it carries spending and
    // the retaken median stays positive.
    const kept = calibrating.filter((window) => !found.get(window).length);
    if (!kept.length || kept.length === calibrating.length) return [...found.values()].flat();
    calibrating = kept;
    rate = medianRate(calibrating);
  }
}

/** Expected outside percentage points, bounded by the actual meter rise. */
export function estimateOutsideQuota(sample, model) {
  if (!model || !(sample.points > 0) || !(sample.costUsd > 0) || model.mixed === 0) return 0;
  const { clean, outside, sigma, delta, tau } = densities(
    { ...sample, resolution: sample.resolution ?? model.resolution },
    model.rate,
    model.scale
  );
  const probability = (model.mixed * outside) / ((1 - model.mixed) * clean + model.mixed * outside);
  const a = (delta - sigma ** 2 / tau) / sigma;
  let extra;
  if (a < -10) {
    // The inverse Mills ratio's tail avoids subtracting two large numbers.
    const z = -a;
    extra = sigma * (1 / z - 2 / z ** 3 + 10 / z ** 5);
  } else {
    const cdf = 0.5 * erfc(-a / Math.SQRT2);
    extra = sigma * (a + Math.exp(-0.5 * a * a) / (ROOT_TWO_PI * Math.max(FLOOR, cdf)));
  }
  return Math.min(sample.points, Math.max(0, sample.costUsd * probability * extra));
}
