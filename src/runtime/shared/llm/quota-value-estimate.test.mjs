import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateOutsideQuota, estimateQuotaValue, outsideSpans } from './quota-value-estimate.mjs';

test('finer-meter outside spans come only from rises that Mixdog spending cannot explain', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const spend = [];
  const costBetween = (from, to) => spend.reduce((sum, [ts, usd]) => (ts > from && ts <= to ? sum + usd : sum), 0);
  const window = (startMs, steps) => ({
    startMs,
    readings: steps.map(([minutes, usedPct]) => ({ ts: startMs + minutes * MINUTE, usedPct })),
  });
  // Two clean windows: $10 moves four points, so $40 reads 16%.
  const steps = [
    [10, 4],
    [20, 8],
    [30, 12],
    [40, 16],
  ];
  for (const start of [0, 5 * HOUR]) for (const minutes of [5, 15, 25, 35]) spend.push([start + minutes * MINUTE, 10]);
  const clean = [window(0, steps), window(5 * HOUR, steps)];
  assert.deepEqual(outsideSpans(clean, costBetween), []);
  // $2 cannot move six points, and the later rise has no spending behind it.
  spend.push([10 * HOUR + 5 * MINUTE, 2]);
  const mixed = window(10 * HOUR, [
    [10, 6],
    [120, 7],
  ]);
  assert.deepEqual(outsideSpans([...clean, mixed], costBetween), [
    { fromMs: 10 * HOUR, toMs: 10 * HOUR + 10 * MINUTE },
    { fromMs: 10 * HOUR + 10 * MINUTE, toMs: 10 * HOUR + 120 * MINUTE },
  ]);
  assert.deepEqual(outsideSpans([window(0, [[10, 3]])], costBetween), [], 'no rate without a window past 4%');
});

test('finer-meter outside use in most windows does not lower the own rate it is judged by', () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const spend = [];
  const costBetween = (from, to) => spend.reduce((sum, [ts, usd]) => (ts > from && ts <= to ? sum + usd : sum), 0);
  const window = (startMs, steps) => ({
    startMs,
    readings: steps.map(([minutes, usedPct]) => ({ ts: startMs + minutes * MINUTE, usedPct })),
  });
  // Two clean windows: $40 reads 16%.
  const clean = [0, 5 * HOUR].map((start) => {
    for (const minutes of [5, 15, 25, 35]) spend.push([start + minutes * MINUTE, 10]);
    return window(start, [
      [10, 4],
      [20, 8],
      [30, 12],
      [40, 16],
    ]);
  });
  // Three windows where $10 of Mixdog use sits beside 20, 10 and 6 points
  // from elsewhere: their median alone would explain the smallest of them.
  const mixed = [24, 14, 10].map((peak, index) => {
    const start = (10 + 5 * index) * HOUR;
    spend.push([start + 5 * MINUTE, 10]);
    return window(start, [
      [10, 4],
      [20, peak],
    ]);
  });
  assert.deepEqual(
    outsideSpans([...clean, ...mixed], costBetween),
    mixed.map(({ startMs }) => ({ fromMs: startMs + 10 * MINUTE, toMs: startMs + 20 * MINUTE }))
  );
});

function observations(capacity, mixedEvery, extra) {
  return Array.from({ length: 120 }, (_, index) => {
    const costUsd = 0.5 + (index % 11) / 5;
    const outside = mixedEvery && index % mixedEvery === 0 ? extra : 0;
    // Independent truth: $capacity buys 100 points, with bounded noise.
    // The observed value must actually be rounded to its declared 0.1-point grid.
    const noise = 1 + (((index * 8) % 21) - 10) / 100;
    return {
      costUsd,
      points: Math.round(((100 * costUsd) / capacity) * (1 + outside) * noise * 10) / 10,
      priced: true,
      measured: true,
      toMs: index * 60_000,
      resolution: 0.1,
    };
  });
}

test('walk-forward forecasts use only earlier whole-percent observations for Claude and GPT scales', () => {
  for (const dollarsPerPoint of [14, 32]) {
    // Rounded cumulative meter: endpoint errors cancel over a whole window.
    const rows = Array.from({ length: 100 }, (_, index) => ({
      costUsd: dollarsPerPoint * (index % 2 === 0 ? 0.6 : 1.4),
      points: 1,
      priced: true,
      measured: true,
      resolution: 1,
      fromMs: index * 60_000,
      toMs: (index + 1) * 60_000,
    }));
    let absoluteError = 0;
    let futureCost = 0;
    for (let cut = 10; cut < 100; cut += 10) {
      const past = rows.slice(0, cut);
      const model = estimateQuotaValue(past);
      const actualNext = rows.slice(cut, cut + 10).reduce((sum, row) => sum + row.costUsd, 0);
      absoluteError += Math.abs(model.costPerPercent * 10 - actualNext);
      futureCost += actualNext;
      assert.ok(Math.abs(model.costPerPercent / dollarsPerPoint - 1) < 0.04);
    }
    assert.ok(absoluteError / futureCost < 0.04, 'held-out block cost, not training fit');
  }
});

test('every priced observation supplies a value, including sparse and sub-resolution history', () => {
  assert.equal(estimateQuotaValue([]), null);
  assert.equal(estimateQuotaValue([{ costUsd: NaN, points: 1, priced: true }]), null);
  for (const count of [1, 2, 3, 5, 10, 19, 20, 21]) {
    const estimate = estimateQuotaValue(
      Array.from({ length: count }, (_, index) => ({
        costUsd: 2,
        points: 1,
        priced: true,
        measured: true,
        toMs: index * 60_000,
      }))
    );
    assert.equal(estimate.costPerPercent, 2);
    assert.equal(estimate.correctionWeight, 0, 'consistent usage needs no invented outside money');
  }
  const small = estimateQuotaValue([{ costUsd: 0.001, points: 0.001, priced: true }]);
  assert.equal(small.costPerPercent, 1);
  const early = estimateQuotaValue([
    ...Array.from({ length: 4 }, (_, index) => ({
      costUsd: 1,
      points: 1,
      priced: true,
      measured: true,
      toMs: index * 60_000,
    })),
    { costUsd: 1, points: 5, priced: true, measured: true, toMs: 4 * 60_000 },
  ]);
  assert.ok(early.correctionWeight > 0, 'strong mixed-use evidence refines fewer than twenty observations');
  assert.ok(early.costPerPercent > 0.9 && early.costPerPercent < 1.1);
});

test('mixed use does not become the denominator of the full-limit value', () => {
  for (const capacity of [50, 100, 150]) {
    const model = estimateQuotaValue(observations(capacity, 4, 4));
    assert.ok(model);
    assert.ok(Math.abs((model.costPerPercent * 100) / capacity - 1) < 0.04);
    const heldOut = { costUsd: capacity / 100, points: 5 };
    const outside = estimateOutsideQuota(heldOut, model);
    assert.ok(Math.abs(outside - 4) < 0.25, 'four of five points came from outside');
    assert.ok(
      Math.abs(heldOut.costUsd + outside * model.costPerPercent - (5 * capacity) / 100) < (capacity / 100) * 0.3
    );
    assert.ok(outside >= 0 && outside <= heldOut.points, 'attribution conserves observed quota');
  }
});

test('existing priced history supplies a projection and evidence strengthens its correction', () => {
  const history = [
    { costUsd: 20, points: 2, priced: true, measured: false },
    { costUsd: 30, points: 3, priced: true, measured: false },
    { costUsd: 0, points: 8, priced: false, measured: false },
  ];
  const initial = estimateQuotaValue(history);
  assert.equal(initial.correctionWeight, 0);
  assert.ok(Math.abs(initial.costPerPercent - 10) < 1e-12);
  assert.ok(Math.abs(initial.costPerPercent * 100 - 1000) < 1e-9, '$50 moved five points, not thirteen');
  assert.equal(
    estimateOutsideQuota({ costUsd: 1, points: 2 }, initial),
    0,
    'the initial ratio does not pretend to have separated mixed usage'
  );
  const refined = estimateQuotaValue(
    observations(100, 4, 4).map((row) => ({
      ...row,
      priced: true,
      measured: true,
    }))
  );
  assert.ok(refined.correctionWeight > 0.9);
  assert.ok(Math.abs(refined.costPerPercent - 1) < 0.04);
  assert.equal(estimateQuotaValue(history.filter((row) => !row.priced)), null);
});

test('small mixed use is estimated without adding money for a clean meter', () => {
  const clean = estimateQuotaValue(observations(100, 0, 0));
  assert.ok(Math.abs(clean.costPerPercent - 1) < 0.02);
  assert.equal(estimateOutsideQuota({ costUsd: 1, points: 1.05 }, clean), 0);
  const mixed = estimateQuotaValue(observations(100, 2, 0.15));
  assert.ok(Math.abs(mixed.costPerPercent - 1) < 0.06);
  assert.ok(estimateOutsideQuota({ costUsd: 1, points: 1.2 }, mixed) > 0);
});

test('persistent web usage cannot erase own-use evidence, even after the recent-fit cap or a long idle', () => {
  const old = observations(100, 0, 0);
  const isolated = { costUsd: 1, points: 2, priced: true, measured: true, toMs: 120 * 60_000, resolution: 0.1 };
  const spike = estimateQuotaValue([...old, isolated]);
  assert.ok(spike.costPerPercent > 0.9, 'one outlier does not redefine the allowance');
  const recent = observations(50, 0, 0).map((row) => ({ ...row, toMs: row.toMs + 120 * 60_000 }));
  // These same observations can mean unchanged capacity plus equally large
  // web use. Their persistence alone cannot authorize a capacity downgrade.
  for (const count of [10, 60, 120, 240]) {
    const mixed = Array.from({ length: count }, (_, index) => ({
      ...recent[index % recent.length],
      toMs: (120 + index) * 60_000,
    }));
    const model = estimateQuotaValue([...old, ...mixed]);
    assert.ok(model.costPerPercent > 0.9 && model.costPerPercent < 1.1);
    if (count >= 60) {
      assert.ok(estimateOutsideQuota({ costUsd: 1, points: 2, resolution: 0.1 }, model) > 0.7);
    }
  }
  const aged = estimateQuotaValue([...old, { ...isolated, toMs: 8 * 24 * 60 * 60_000 }]);
  assert.ok(aged.costPerPercent > 0.9, 'elapsed time cannot turn external usage into own quota');
  const increased = observations(200, 0, 0).map((row) => ({ ...row, toMs: row.toMs + 120 * 60_000 }));
  assert.ok(
    estimateQuotaValue([...old, ...increased]).costPerPercent > 1.8,
    'new own-use evidence can still update the estimate; it is not a frozen historical number'
  );
});

test('bounded recent work and ambiguous outside use do not imply an accuracy guarantee', () => {
  const old = observations(100, 0, 0);
  const recent = [...observations(50, 4, 1), ...observations(50, 4, 1)].map((row, index) => ({
    ...row,
    toMs: (index + 120) * 60_000,
  }));
  const model = estimateQuotaValue([...old, ...recent]);
  assert.equal(model.samples, 180);
  assert.ok(model.costPerPercent > 0.9, 'the fit cap must not discard older own-use support');
  const same = Array.from({ length: 60 }, () => ({ costUsd: 1, points: 2, priced: true }));
  // These observations are identical for a $50 capacity with no outside
  // use and a $100 capacity with matching outside use. No estimator can
  // choose between them from quota and recorded cost alone.
  const ambiguous = estimateQuotaValue(same);
  assert.ok(Math.abs(ambiguous.costPerPercent - 0.5) < 0.02);
});

test('one-point endpoint rounding does not masquerade as external use', () => {
  // True cumulative use is 0.6, 2, 2.6, 4, ... points. Rounded readings
  // rise by one point each time although the own cost alternates 0.6/1.4.
  const history = Array.from({ length: 80 }, (_, index) => ({
    costUsd: index % 2 === 0 ? 0.6 : 1.4,
    points: 1,
    priced: true,
    measured: true,
    resolution: 1,
    fromMs: index * 60_000,
    toMs: (index + 1) * 60_000,
  }));
  for (const width of [1, 2, 4, 5]) {
    const grouped = [];
    for (let index = 0; index < history.length; index += width) {
      const part = history.slice(index, index + width);
      grouped.push({
        ...part.at(-1),
        fromMs: part[0].fromMs,
        costUsd: part.reduce((sum, row) => sum + row.costUsd, 0),
        points: part.reduce((sum, row) => sum + row.points, 0),
      });
    }
    const model = estimateQuotaValue(grouped);
    assert.ok(Math.abs(model.costPerPercent - 1) < 0.03, `group ${width}: the known true value is $1 per point`);
    assert.equal(estimateOutsideQuota(history[0], model), 0, 'ordinary rounding is not external money');
  }
});

test('Claude- and GPT-sized allowances are recovered from cumulative whole-percent meters', () => {
  for (const dollarsPerPoint of [14, 32]) {
    let actualPoints = 0;
    let shownPoints = 0;
    let costUsd = 0;
    let fromMs = 0;
    const history = [];
    for (let index = 0; actualPoints < 70; index += 1) {
      const cost = 0.15 * (1 + ((index * 7) % 13));
      actualPoints += cost / dollarsPerPoint;
      costUsd += cost;
      const next = Math.round(actualPoints);
      if (next === shownPoints) continue;
      const toMs = (index + 1) * 60_000;
      history.push({
        costUsd,
        points: next - shownPoints,
        resolution: 1,
        priced: true,
        measured: history.length > 0,
        fromMs,
        toMs,
      });
      shownPoints = next;
      costUsd = 0;
      fromMs = toMs;
    }
    const model = estimateQuotaValue(history);
    assert.ok(Math.abs(model.costPerPercent / dollarsPerPoint - 1) < 0.03);
    assert.equal(model.mixed, 0, 'a clean, coarsely rounded meter must not invent outside usage');
  }
});

// One window of a meter shown in whole points, rounded up like Claude's, with
// `outside(step)` points of use from elsewhere beside each request.
function wholePercentWindow(dollarsPerPoint, { points, startMs = 0, outside = () => 0 }) {
  const intervals = [];
  let used = 0;
  let shown = 0;
  let costUsd = 0;
  let fromMs = startMs;
  for (let step = 0; shown < points; step += 1) {
    const spend = (0.15 * (1 + ((step * 7) % 13)) * dollarsPerPoint) / 14;
    costUsd += spend;
    used += spend / dollarsPerPoint + outside(step);
    const next = Math.ceil(used - 1e-9);
    if (next === shown) continue;
    const toMs = startMs + (step + 1) * 60_000;
    intervals.push({ costUsd, points: next - shown, resolution: 1, priced: true, measured: shown > 0, fromMs, toMs });
    shown = next;
    costUsd = 0;
    fromMs = toMs;
  }
  return intervals;
}

const NEXT_WEEK = 7 * 24 * 3_600_000;

test("earlier windows supply the value from a new window's first reading", () => {
  const earlier = wholePercentWindow(30, { points: 80 });
  assert.ok(Math.abs(estimateQuotaValue([], earlier).costPerPercent / 30 - 1) < 0.03, 'before the new window rises');
  const opening = estimateQuotaValue(wholePercentWindow(30, { points: 1, startMs: NEXT_WEEK }), earlier);
  assert.ok(Math.abs(opening.costPerPercent / 30 - 1) < 0.03, 'its first rounded-up step changes nothing');
  for (const points of [2, 3, 5, 10]) {
    const value = estimateQuotaValue(wholePercentWindow(30, { points, startMs: NEXT_WEEK }), earlier);
    assert.ok(Math.abs(value.costPerPercent / 30 - 1) < 0.03, `${points} points into the window`);
  }
});

test('outside use in a new window is not mistaken for a smaller allowance', () => {
  const earlier = wholePercentWindow(30, { points: 80 });
  // Half a point of web use beside every sixtieth request: over a tenth of the meter.
  const mixed = wholePercentWindow(30, {
    points: 20,
    startMs: NEXT_WEEK,
    outside: (step) => (step > 0 && step % 60 === 0 ? 0.5 : 0),
  });
  const alone = estimateQuotaValue(mixed);
  const continued = estimateQuotaValue(mixed, earlier);
  assert.ok(continued.changeWeight < 0.5);
  assert.ok(
    Math.abs(continued.costPerPercent / 30 - 1) < Math.abs(alone.costPerPercent / 30 - 1),
    'the earlier windows keep the own-use value closer than the window alone'
  );
  assert.ok(Math.abs(continued.costPerPercent / 30 - 1) < 0.05);
});

test('a changed allowance replaces the earlier windows within a few points, in either direction', () => {
  const earlier = wholePercentWindow(30, { points: 80 });
  for (const dollarsPerPoint of [60, 15]) {
    const changed = estimateQuotaValue(
      wholePercentWindow(dollarsPerPoint, { points: 10, startMs: NEXT_WEEK }),
      earlier
    );
    assert.ok(changed.changeWeight > 0.9, `$${dollarsPerPoint} per point is a new allowance`);
    assert.ok(Math.abs(changed.costPerPercent / dollarsPerPoint - 1) < 0.06, `$${dollarsPerPoint} per point`);
  }
  // A ten percent drift continues the earlier value instead of jumping on it.
  const drift = estimateQuotaValue(wholePercentWindow(33, { points: 5, startMs: NEXT_WEEK }), earlier);
  assert.ok(drift.changeWeight < 0.1);
  assert.ok(drift.costPerPercent > 30 && drift.costPerPercent < 33);
});
