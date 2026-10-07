/**
 * Subscription quota history: what a provider's own usage meter read over
 * time, next to the token records that moved it.
 *
 * quota_samples keeps one row per distinct reading of one limit window
 * (provider · account · label). A later measurement that repeats the reading
 * only extends `seen_until`, so a row is a value plus the span over which it
 * was confirmed, and the time between rows is time nobody measured.
 *
 * Each rise of the meter is split over the same provider account's token
 * records in its interval by list-price value. A rise with no Mixdog record
 * behind it came from outside Mixdog (the web app, another client). The split
 * is an estimate: providers do not publish what a request costs the meter.
 */
import { normalizeUsageMeasurement } from './usage-measurement.mjs';
import { usageRollupDayKey } from './usage-rollup.mjs';
import { estimateOutsideQuota, estimateQuotaValue, outsideSpans } from './quota-value-estimate.mjs';

export const QUOTA_SCHEMA = `
    CREATE TABLE IF NOT EXISTS quota_samples (
        provider TEXT NOT NULL, account TEXT NOT NULL, label TEXT NOT NULL,
        ts INTEGER NOT NULL, seen_until INTEGER NOT NULL,
        used_pct REAL NOT NULL, reset_at INTEGER,
        PRIMARY KEY(provider,account,label,ts)
    ) WITHOUT ROWID;
`;

const MINUTE = 60_000;
// Clean, priced meter rises a window needs before its value is shown in
// dollars when no earlier window anchors it.
const MIN_VALUE_SAMPLES = 10;
const valueEvidence = (interval) => interval.priced && interval.costUsd > 0 && interval.points > 0;
const HOUR = 60 * MINUTE;
// Codex reports its reset as a countdown, so one window's reset drifts by the
// request latency between readings. A later reset, or a meter that fell,
// opens a new window.
const RESET_TOLERANCE_MS = 2 * MINUTE;
const RESET_DROP_POINTS = 5;
// Readings further apart than this leave the path between them unmeasured.
const MEASURED_GAP_MS = 20 * MINUTE;
// Hover slots: the finest of these sizes that cuts the chart into at most 48.
const SLOT_SIZES = [30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 20160, 43200].map((minutes) => minutes * MINUTE);
const MAX_SLOTS = 48;
const MAX_POINTS = 4000;
// The window history is read a page at a time, and a page reads only the
// records of its own windows and of the earlier windows their values continue.
const HISTORY_PAGE_SIZE = 10;
const SERIES_LIMIT = 6;
// Each window's value continues from the windows just before it, back until
// they hold this many quota points (at most this many windows).
const PRIOR_POINTS = 100;
const PRIOR_WINDOWS = 24;
// The by-model chart's series key for usage from outside Mixdog. Every
// recorded model has a name, so the empty key cannot collide.
const OUTSIDE_KEY = '';
// Path vertex kinds: pen up, a confirmed stretch, and a stretch between
// readings too far apart to know its path.
const MOVE = 0;
const MEASURED = 1;
const UNMEASURED = 2;

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Nominal length of a limit window from its label; null when unknown. */
export function quotaWindowSpanMs(label) {
  const text = String(label || '').toUpperCase();
  if (/^5H\b/.test(text)) return 5 * HOUR;
  if (/^24H\b/.test(text)) return 24 * HOUR;
  if (/^(?:7D|W)\b/.test(text)) return 7 * 24 * HOUR;
  return null;
}

/** When a window opened, from its reset: one fixed span back, or one calendar
 *  month for a monthly window; null when the label does not say. */
function quotaWindowOpened(label, resetAt) {
  if (resetAt == null) return null;
  const span = quotaWindowSpanMs(label);
  if (span) return resetAt - span;
  if (!/^M\b/i.test(String(label || ''))) return null;
  const opened = new Date(resetAt);
  opened.setMonth(opened.getMonth() - 1);
  return opened.getTime();
}

function windowOrder(a, b) {
  const span = (label) => quotaWindowSpanMs(label) ?? Number.MAX_SAFE_INTEGER;
  return span(a) - span(b) || a.length - b.length || a.localeCompare(b);
}

function sameWindow(previous, sample) {
  // An idle meter reads zero against a reset that may keep moving: no window
  // ran, so there is nothing to split.
  if (previous.used_pct === 0 && sample.usedPct === 0) return true;
  if (sample.usedPct < previous.used_pct - RESET_DROP_POINTS) return false;
  if (previous.reset_at == null || sample.resetAt == null) return previous.reset_at == null && sample.resetAt == null;
  return Math.abs(previous.reset_at - sample.resetAt) <= RESET_TOLERANCE_MS;
}

/**
 * Store readings in one transaction. A repeat of the latest reading of its
 * window extends that row; a new reading of the same window keeps the
 * window's first reset, so a drifting countdown never splits one window.
 */
export function recordQuotaSamples(db, samples) {
  const latest = db.prepare(`SELECT ts,seen_until,used_pct,reset_at FROM quota_samples
      WHERE provider=? AND account=? AND label=? ORDER BY ts DESC LIMIT 1`);
  const extend = db.prepare(
    'UPDATE quota_samples SET seen_until=? WHERE provider=? AND account=? AND label=? AND ts=?'
  );
  const insert = db.prepare('INSERT OR IGNORE INTO quota_samples VALUES (?,?,?,?,?,?,?)');
  let written = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const sample of samples) {
      const key = [sample.provider, sample.account, sample.label];
      const previous = latest.get(...key);
      // A reading older than the span already confirmed arrived late.
      if (previous && sample.ts <= previous.seen_until) continue;
      const same = Boolean(previous) && sameWindow(previous, sample);
      if (same && Math.abs(previous.used_pct - sample.usedPct) < 0.005) extend.run(sample.ts, ...key, previous.ts);
      else insert.run(...key, sample.ts, sample.ts, sample.usedPct, same ? previous.reset_at : sample.resetAt);
      written += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return written;
}

/**
 * Every recorded subscription account with its limit windows. The one whose
 * meter moved last comes first — the subscription in use — because every
 * connected one is measured alike, idle or not.
 */
function listQuotaSeries(db) {
  const series = new Map();
  const rows = db
    .prepare('SELECT provider,account,label,MAX(ts) AS changed FROM quota_samples GROUP BY provider,account,label')
    .all();
  for (const row of rows) {
    const key = `${row.provider}\u0000${row.account}`;
    const entry = series.get(key) || { provider: row.provider, account: row.account, windows: [], changed: 0 };
    entry.windows.push(row.label);
    entry.changed = Math.max(entry.changed, row.changed);
    series.set(key, entry);
  }
  return [...series.values()]
    .sort((a, b) => b.changed - a.changed)
    .map(({ provider, account, windows }) => ({ provider, account, windows: windows.sort(windowOrder) }));
}

// A subscription opens on its weekly window, the limit a plan is used up
// against, unless a window was asked for; one without a weekly window opens
// on its shortest.
const WEEKLY_WINDOW = /^(?:7D|W)$/i;

// No account asked for: the one its account pool has in use (`inUse`, per
// provider), else the one whose meter moved last.
function pickSelection(series, { provider, account, label, inUse = {} }) {
  const chosen = provider || series[0]?.provider;
  const accountId = account || inUse[chosen] || '';
  const entry =
    series.find((row) => row.provider === chosen && row.account === accountId) ||
    series.find((row) => row.provider === chosen) ||
    series[0];
  if (!entry) return null;
  const wanted = String(label || '').toLowerCase();
  return {
    provider: entry.provider,
    account: entry.account,
    label:
      entry.windows.find((window) => window.toLowerCase() === wanted) ||
      entry.windows.find((window) => WEEKLY_WINDOW.test(window)) ||
      entry.windows[0],
  };
}

/**
 * Readings grouped into limit windows, each with its span and its reading.
 * A run that never left zero is idle — no window was open — and only fills
 * the measured time between the windows around it.
 */
function quotaInstances(rows, label, now) {
  const groups = [];
  for (const row of rows) {
    const previous = groups.at(-1)?.at(-1);
    if (!previous || row.resetAt !== previous.resetAt || row.usedPct < previous.usedPct - RESET_DROP_POINTS) {
      groups.push([]);
    }
    groups.at(-1).push(row);
  }
  const instances = groups.map((group) => {
    const first = group[0];
    const last = group.at(-1);
    let peak = first;
    for (const row of group) if (row.usedPct > peak.usedPct) peak = row;
    return {
      key: String(first.ts),
      rows: group,
      resetAt: first.resetAt,
      peak: peak.usedPct,
      peakAt: peak.ts,
      exhaustedAt: group.find((row) => row.usedPct >= 100)?.ts ?? null,
      lastPct: last.usedPct,
      lastAt: last.until,
      idle: peak.usedPct === 0,
      current: false,
      paced: false,
    };
  });
  // After a reset, early or on time, the meter reads zero until the next
  // request: that last run is the window open now, not a gap between windows.
  const latest = instances.at(-1);
  if (
    latest?.idle &&
    instances.some((instance) => !instance.idle) &&
    (latest.resetAt == null || latest.resetAt > now)
  ) {
    latest.idle = false;
  }
  const active = instances.filter((instance) => !instance.idle);
  let previousEnd = -Infinity;
  active.forEach((instance) => {
    const first = instance.rows[0];
    // Any later reading, even an idle one after an early reset, closes it.
    const next = instances[instances.indexOf(instance) + 1];
    // A window's clock started at its opening: never after its first reading,
    // never inside the window before it.
    const opened = quotaWindowOpened(label, instance.resetAt);
    instance.paced = opened !== null;
    instance.startMs = Math.max(Math.min(opened ?? first.ts, first.ts), previousEnd);
    instance.endMs = Math.max(
      Math.min(instance.resetAt ?? instance.lastAt, next ? next.rows[0].ts : Infinity),
      instance.lastAt
    );
    instance.current = !next && (instance.resetAt == null || instance.resetAt > now);
    previousEnd = instance.endMs;
  });
  let before = -Infinity;
  for (const instance of instances) {
    if (instance.idle) instance.startMs = Math.max(instance.rows[0].ts, before);
    else before = instance.endMs;
  }
  let after = Infinity;
  for (let index = instances.length - 1; index >= 0; index -= 1) {
    const instance = instances[index];
    if (instance.idle) instance.endMs = Math.max(instance.startMs, Math.min(instance.lastAt, after));
    else after = instance.startMs;
  }
  return instances;
}

/** The meter's path through a run of windows, as [time, percent, kind]. */
function quotaPoints(instances) {
  const points = [];
  const add = (time, value, kind) => {
    const last = points.at(-1);
    const at = Math.round(time);
    const percent = round(value);
    if (last && last[0] === at && last[1] === percent) return;
    points.push([at, percent, last ? kind : MOVE]);
  };
  const stretch = (from, to) => (to - from > MEASURED_GAP_MS ? UNMEASURED : MEASURED);
  for (const instance of instances) {
    if (instance.idle) {
      if (instance.endMs > instance.startMs) {
        add(instance.startMs, 0, stretch(points.at(-1)?.[0] ?? instance.startMs, instance.startMs));
        add(instance.endMs, 0, MEASURED);
      }
      continue;
    }
    // Between windows the meter sits at zero, and every window opens there.
    if (instance.startMs < instance.rows[0].ts) {
      add(instance.startMs, 0, stretch(points.at(-1)?.[0] ?? instance.startMs, instance.startMs));
    }
    for (const row of instance.rows) {
      add(row.ts, row.usedPct, stretch(points.at(-1)?.[0] ?? row.ts, row.ts));
      if (row.until > row.ts) add(row.until, row.usedPct, MEASURED);
    }
    if (instance.current) continue;
    add(instance.endMs, instance.lastPct, stretch(instance.lastAt, instance.endMs));
    add(instance.endMs, 0, MEASURED);
  }
  return points;
}

/** The meter at `time` on a path: linear between vertices, flat after the last. */
function valueAt(points, time) {
  if (!points.length || time < points[0][0]) return 0;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (points[mid][0] <= time) low = mid;
    else high = mid - 1;
  }
  const [at, value] = points[low];
  const next = points[low + 1];
  if (!next || next[2] === MOVE || next[0] === at) return value;
  return value + ((next[1] - value) * (time - at)) / (next[0] - at);
}

/** Thin a long path to the first, last, highest and lowest vertex per step. */
function decimate(points, fromMs, toMs) {
  if (points.length <= MAX_POINTS) return points;
  const step = (toMs - fromMs) / (MAX_POINTS / 4);
  const kept = [];
  let bucket = null;
  let group = [];
  const flush = () => {
    if (!group.length) return;
    let high = group[0];
    let low = group[0];
    for (const point of group) {
      if (point[1] > high[1]) high = point;
      if (point[1] < low[1]) low = point;
    }
    const extremes = new Set([group[0], high, low, group.at(-1)]);
    for (const point of group) if (extremes.has(point)) kept.push(point);
    group = [];
  };
  for (const point of points) {
    const index = Math.floor((point[0] - fromMs) / step);
    if (index !== bucket || point[2] === MOVE) {
      flush();
      bucket = index;
    }
    group.push(point);
  }
  flush();
  return kept;
}

/** Index of the first record later than `time`; records are sorted by ts. */
function firstAfter(events, time) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (events[mid].ts <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Records written before accounts were recorded carry none. They were made
// through the account the provider was used through when recording began: the
// one on its earliest record that names an account. Once set it never
// changes, so it is read once per connection.
const legacyAccountOwners = new WeakMap();

function legacyAccountOwner(db, provider) {
  let owners = legacyAccountOwners.get(db);
  if (!owners) {
    owners = new Map();
    legacyAccountOwners.set(db, owners);
  }
  if (owners.has(provider)) return owners.get(provider);
  const row = db
    .prepare(`
      SELECT json_extract(r.signature,'$[8]') AS account
      FROM usage_events e JOIN usage_routes r ON r.id=e.route
      WHERE json_extract(r.signature,'$[0]')=? AND COALESCE(json_extract(r.signature,'$[8]'),'')<>''
      ORDER BY e.ts LIMIT 1`)
    .get(provider);
  if (!row) return null;
  owners.set(provider, row.account);
  return row.account;
}

/**
 * The provider account's token records in [fromMs, toMs], summed per minute
 * and model, keeping the best-ranked origin per day and model like the usage
 * rollups. The provider and account are read off the route table once — far
 * smaller than the records — so no record is decoded. Records without an
 * account belong to the legacy owner only, or to every account while no
 * record names one.
 */
function readQuotaEvents(db, { provider, account, label = '', fromMs, toMs }) {
  const owner = legacyAccountOwner(db, provider);
  const unlabeled = owner === null || owner === account ? '' : account;
  // Anthropic's scoped weekly labels are model-family limits, not the whole
  // subscription. An unrecognized scope must never borrow every model's cost.
  const scope =
    provider === 'anthropic-oauth' && label.startsWith('7D ')
      ? `claude-${label
          .slice(3)
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, '-')}`
      : '';
  const rows = db
    .prepare(`
      WITH routes AS (
          SELECT id,json_extract(signature,'$[1]') AS model,json_extract(signature,'$[7]') AS rank
          FROM usage_routes
          WHERE json_extract(signature,'$[0]')=? AND COALESCE(json_extract(signature,'$[8]'),'') IN (?,?)
      )
      SELECT e.ts,e.day,r.model,r.rank,COUNT(*) AS turns,
          SUM(e.input) AS input,SUM(e.output) AS output,SUM(e.cache_read) AS cacheRead,
          SUM(e.cache_write) AS cacheWrite,SUM(e.cost_usd) AS costUsd,COUNT(e.cost_usd) AS priced,
          SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END) AS speedOutput,
          SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END) AS speedMs
      FROM usage_events e JOIN routes r ON r.id=e.route
      WHERE e.ts>=? AND e.ts<=?
      GROUP BY e.ts,e.day,r.model,r.rank
      ORDER BY e.ts`)
    .all(provider, account, unlabeled, fromMs, toMs);
  const best = new Map();
  const ranks = db.prepare(`SELECT day,model,MIN(rank) AS rank FROM daily
      WHERE provider=? AND day BETWEEN ? AND ? GROUP BY day,model`);
  for (const row of ranks.all(provider, usageRollupDayKey(fromMs), usageRollupDayKey(toMs))) {
    best.set(`${row.day}\u0000${row.model}`, row.rank);
  }
  return rows.flatMap((row) => {
    const model = String(row.model).toLowerCase();
    if (scope && model !== scope && !model.startsWith(`${scope}-`)) return [];
    const day = String(row.day);
    if (best.get(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}\u0000${row.model}`) !== row.rank) return [];
    const usage = normalizeUsageMeasurement(provider, {
      turns: row.turns,
      input: row.input,
      output: row.output,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      costUsd: row.costUsd ?? 0,
      costKnownTurns: row.priced,
    });
    const event = {
      ts: row.ts,
      model: row.model,
      turns: row.turns,
      input: usage.input || 0,
      output: usage.output || 0,
      cacheRead: usage.cacheRead || 0,
      cacheWrite: usage.cacheWrite || 0,
      costUsd: usage.costUsd || 0,
      costKnownTurns: usage.costKnownTurns || 0,
      unmeasuredTurns: usage.unmeasuredTurns || 0,
      // Output over the wall time of the timed requests that produced it.
      speedOutput: row.speedOutput,
      speedMs: row.speedMs,
    };
    event.tokens = event.input + event.output + event.cacheRead + event.cacheWrite;
    return [event];
  });
}

/** quota_samples stores readings rounded to two decimal places. Respect the
 *  precision actually present: an integer-only series supplies whole-percent
 *  readings, not invented tenths. Preserve finer reported readings when present. */
function quotaReadingResolution(rows) {
  const cents = rows.map((row) => Math.round(row.usedPct * 100));
  if (cents.some((value) => value % 10 !== 0)) return 0.01;
  return cents.some((value) => value % 100 !== 0) ? 0.1 : 1;
}

/** The windows just before `instance`, oldest first: the calibration its
 *  value continues from. Defined per window, so every view of one window
 *  computes the same value. `listed` is every non-idle window, oldest first. */
function earlierWindows(listed, instance) {
  const earlier = [];
  let points = 0;
  for (let index = listed.length - 1; index >= 0; index -= 1) {
    if (points >= PRIOR_POINTS || earlier.length >= PRIOR_WINDOWS) break;
    const candidate = listed[index];
    if (candidate.startMs >= instance.startMs) continue;
    earlier.unshift(candidate);
    points += candidate.peak;
  }
  return earlier;
}

/** Every window `shown` reads records for: itself and its calibration. */
function calibratedWindows(listed, shown) {
  return [...new Set([...shown.flatMap((instance) => earlierWindows(listed, instance)), ...shown])];
}

/** One window's meter rises, each with the records behind it. */
function windowIntervals(instance, events, mixed) {
  const resolution = quotaReadingResolution(instance.rows);
  const intervals = [];
  let fromMs = instance.startMs;
  let fromPct = 0;
  for (const [rowIndex, row] of instance.rows.entries()) {
    const delta = row.usedPct - fromPct;
    if (delta > 0) {
      const start = firstAfter(events, fromMs);
      const end = firstAfter(events, row.ts);
      let cost = 0;
      let tokens = 0;
      let turns = 0;
      let priced = 0;
      for (let index = start; index < end; index += 1) {
        cost += events[index].costUsd;
        tokens += events[index].tokens;
        turns += events[index].turns;
        priced += events[index].costKnownTurns;
      }
      let weight = 'turns';
      let total = turns;
      if (cost > 0) {
        weight = 'costUsd';
        total = cost;
      } else if (tokens > 0) {
        weight = 'tokens';
        total = tokens;
      }
      intervals.push({
        fromMs,
        toMs: row.ts,
        points: delta,
        costUsd: cost,
        start,
        end,
        weight,
        total,
        resolution,
        // Long reading gaps still carry cost and quota evidence. Only an
        // inferred opening, a saturated meter, or the first rise from zero
        // lowers its measurement quality: the first request of a window can
        // show a whole step of a rounded-up meter, so that rise only bounds
        // its use within one step.
        measured: rowIndex > 0 && fromPct > 0 && row.usedPct < 100,
        priced: turns > 0 && priced === turns,
        mixed: mixed.some((span) => span.fromMs < row.ts && span.toMs > fromMs),
      });
    }
    fromMs = row.ts;
    fromPct = row.usedPct;
  }
  return intervals;
}

/**
 * Keep observed quota and recorded dollars intact. Continuously estimate
 * probable outside use from priced history before allocating the remainder
 * over Mixdog's requests; recent observations outweigh older ones. Each
 * window continues from its earlier windows in `listed` (every non-idle
 * window, oldest first), whose records `events` must cover. Intervals
 * overlapping `mixed` spans never calibrate the rate: their outside share is
 * the rise that Mixdog's own dollars at that rate do not cover.
 */
function allocateQuota(instances, events, mixed = [], listed = []) {
  const shares = new Float64Array(events.length);
  const outside = [];
  const calibration = new Map();
  const calibrationOf = (instance) => {
    if (!calibration.has(instance)) {
      calibration.set(
        instance,
        windowIntervals(instance, events, mixed).filter((interval) => !interval.mixed)
      );
    }
    return calibration.get(instance);
  };
  for (const instance of instances) {
    instance.outside = 0;
    instance.outsideCostUsd = 0;
    instance.outsideUnpriced = 0;
    instance.intervals = windowIntervals(instance, events, mixed);
    const own = instance.intervals.filter((interval) => !interval.mixed);
    const prior = earlierWindows(listed, instance).flatMap(calibrationOf);
    instance.estimate = estimateQuotaValue(own, prior);
    // The estimate still splits the meter, but it is shown in dollars only
    // once it rests on more than a few coincidences: a light Mixdog spend
    // landing on heavy use elsewhere reads as a tiny rate. An earlier
    // window's evidence anchors it; without one, the window's own clean,
    // priced rises must first number MIN_VALUE_SAMPLES.
    const ownSamples = own.filter((interval) => interval.measured && valueEvidence(interval)).length;
    instance.value =
      instance.estimate && (prior.some(valueEvidence) || ownSamples >= MIN_VALUE_SAMPLES) ? instance.estimate : null;
    for (const interval of instance.intervals) {
      const { start, end, total, weight, points } = interval;
      let external = points;
      if (total > 0) {
        external = 0;
        if (interval.measured && interval.priced) {
          external =
            interval.mixed && instance.estimate
              ? Math.min(points, Math.max(0, points - interval.costUsd / instance.estimate.costPerPercent))
              : estimateOutsideQuota(interval, instance.estimate);
        }
      }
      if (total > 0) {
        for (let index = start; index < end; index += 1) {
          shares[index] += ((points - external) * events[index][weight]) / total;
        }
      }
      if (external > 0) {
        const costUsd = instance.value ? external * instance.value.costPerPercent : null;
        outside.push({ fromMs: interval.fromMs, toMs: interval.toMs, points: external, costUsd });
        instance.outside += external;
        if (costUsd === null) instance.outsideUnpriced += external;
        else instance.outsideCostUsd += costUsd;
      }
    }
  }
  return { shares, outside };
}

/**
 * The weekly all-model limit's five-hour companion restarts from zero every
 * few hours and moves in quarter-size steps, so it exposes outside use that a
 * whole-percent weekly reading hides. Each week is judged by its own
 * five-hour windows, so a plan change between weeks cannot make every later
 * five-hour window look mixed. Scoped weekly limits share no five-hour meter.
 */
function finerOutsideSpans(db, selection, events, weeks, now) {
  if (selection.label !== '7D' || !events.length || !weeks.length) return [];
  const prefix = [0];
  for (const event of events) prefix.push(prefix.at(-1) + event.costUsd);
  const costBetween = (from, to) => prefix[firstAfter(events, to)] - prefix[firstAfter(events, from)];
  const fives = quotaInstances(readQuotaRows(db, { ...selection, label: '5H' }), '5H', now).filter(
    (instance) => !instance.idle
  );
  return weeks.flatMap((week) =>
    outsideSpans(
      fives
        .filter((five) => five.startMs >= week.startMs && five.startMs < week.endMs)
        .map((five) => ({ startMs: five.startMs, readings: five.rows })),
      costBetween
    )
  );
}

function intervalShare(interval, fromMs, toMs) {
  if (interval.toMs <= interval.fromMs) return interval.toMs >= fromMs && interval.toMs <= toMs ? 1 : 0;
  return (
    Math.max(0, Math.min(interval.toMs, toMs) - Math.max(interval.fromMs, fromMs)) / (interval.toMs - interval.fromMs)
  );
}

/** A period spanning different capacities averages by observed quota, not
 *  dollars. A missing calibration must not silently stand in as zero. */
function periodQuotaRate(instances, fromMs, toMs) {
  let value = 0;
  let points = 0;
  for (const instance of instances) {
    for (const interval of instance.intervals) {
      const part = interval.points * intervalShare(interval, fromMs, toMs);
      if (!(part > 0)) continue;
      if (!instance.value) return null;
      value += part * instance.value.costPerPercent;
      points += part;
    }
  }
  return points > 0 ? round(value / points, 6) : null;
}

function quotaCostFields(costUsd, outsideCostUsd, unpriced = false) {
  const extra = outsideCostUsd === null ? null : round(outsideCostUsd, 6);
  const recorded = round(costUsd, 6);
  return {
    costUsd: recorded,
    outsideCostUsd: extra,
    estimatedTotalCostUsd: extra === null || unpriced ? null : round(recorded + extra, 6),
  };
}

const USAGE_FIELDS = [
  'turns',
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'costUsd',
  'costKnownTurns',
  'unmeasuredTurns',
  'speedOutput',
  'speedMs',
];

function emptyUsage() {
  return { consumed: 0, ...Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0])) };
}

function addUsage(target, event, share) {
  target.consumed += share;
  for (const field of USAGE_FIELDS) target[field] += event[field];
}

const tokensOf = (usage) => usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
const byConsumption = (a, b) => b.consumed - a.consumed || b.tokens - a.tokens;

/** Route-shaped totals, so the token table's cells render them unchanged. */
function exportUsage(usage) {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const unknown = usage.unmeasuredTurns > 0 && usage.unmeasuredTurns === usage.turns;
  return {
    consumed: round(usage.consumed),
    turns: usage.turns,
    input: unknown ? null : usage.input,
    output: usage.output,
    cacheRead: unknown ? null : usage.cacheRead,
    cacheWrite: unknown ? null : usage.cacheWrite,
    tokens: tokensOf(usage),
    unmeasuredTurns: usage.unmeasuredTurns,
    costUsd: round(usage.costUsd, 6),
    costUnpricedTurns: Math.max(0, usage.turns - usage.costKnownTurns),
    cacheHitRate: unknown || prompt <= 0 ? null : round(usage.cacheRead / prompt, 4),
    outputTokensPerSecond: usage.speedMs > 0 ? round((usage.speedOutput * 1000) / usage.speedMs, 1) : null,
  };
}

function windowPeriod(listed, anchor) {
  if (!listed.length) return null;
  let index = listed.findIndex((instance) => instance.key === anchor);
  if (index < 0) index = listed.length - 1;
  const instance = listed[index];
  return {
    view: 'window',
    anchor: instance.key,
    fromMs: instance.startMs,
    toMs: instance.endMs,
    startDay: usageRollupDayKey(instance.startMs),
    endDay: usageRollupDayKey(instance.endMs),
    previousAnchor: listed[index - 1]?.key ?? null,
    nextAnchor: listed[index + 1]?.key ?? null,
    isCurrent: instance.current,
  };
}

/** How fast the open window is being used, and where that pace ends it. The
 *  pace is read over the last fifth of the window (half an hour to a day). */
function forecastFor(instance, points) {
  if (!instance?.current || instance.resetAt == null || instance.lastPct >= 100) return null;
  const span = instance.paced ? instance.resetAt - instance.startMs : null;
  const lookback = Math.min(24 * HOUR, Math.max(30 * MINUTE, span ? span / 5 : HOUR));
  const from = Math.max(instance.startMs, instance.lastAt - lookback);
  const hours = (instance.lastAt - from) / HOUR;
  if (hours < 5 / 60) return null;
  const rate = Math.max(0, (instance.lastPct - valueAt(points, from)) / hours);
  const runsOut = rate > 0 ? instance.lastAt + ((100 - instance.lastPct) / rate) * HOUR : Infinity;
  const beforeReset = runsOut < instance.resetAt;
  return {
    ratePerHour: round(rate),
    fromMs: instance.lastAt,
    fromPct: instance.lastPct,
    exhaustAt: beforeReset ? Math.round(runsOut) : null,
    atResetPct: beforeReset ? null : round(instance.lastPct + (rate * (instance.resetAt - instance.lastAt)) / HOUR, 1),
  };
}

/** Each model's running share of its window, sampled at slot ends; the slot
 *  running now is sampled at now, as far as it has run. */
function modelSeries(slots, instances, keys, now) {
  const series = keys.map((key) => ({ key, points: [] }));
  const running = new Map();
  let owner;
  for (const slot of slots) {
    if (slot.future) break;
    const instance = instances.find((entry) => slot.fromMs >= entry.startMs && slot.fromMs < entry.endMs) || null;
    if (instance !== owner) {
      owner = instance;
      for (const entry of series) {
        running.set(entry.key, 0);
        entry.points.push([slot.fromMs, 0]);
      }
    }
    for (const entry of series) {
      const part = entry.key === OUTSIDE_KEY ? slot.outside : slot.models.get(entry.key)?.consumed || 0;
      running.set(entry.key, running.get(entry.key) + part);
      entry.points.push([Math.min(slot.toMs, now), round(running.get(entry.key))]);
    }
  }
  return series;
}

/** Outside usage is spread over the time its interval covers; returns its total within the domain. */
function spreadOutsideUsage(outside, slots, slotAt, domainFrom, domainTo) {
  let total = 0;
  const add = (slot, interval, share) => {
    const part = interval.points * share;
    slot.outside += part;
    if (interval.costUsd === null) slot.outsideUnpriced += part;
    else slot.outsideCostUsd += interval.costUsd * share;
    total += part;
  };
  for (const interval of outside) {
    const from = Math.max(interval.fromMs, domainFrom);
    const to = Math.min(interval.toMs, domainTo);
    if (interval.toMs <= interval.fromMs) {
      if (interval.toMs < domainFrom || interval.toMs > domainTo) continue;
      add(slots[slotAt(interval.toMs)], interval, 1);
      continue;
    }
    for (let index = slotAt(from); index < slots.length && slots[index].fromMs < to; index += 1) {
      const slot = slots[index];
      const overlap = Math.min(to, slot.toMs) - Math.max(from, slot.fromMs);
      if (overlap <= 0) continue;
      add(slot, interval, overlap / (interval.toMs - interval.fromMs));
    }
  }
  return total;
}

function historyRow(instance, events) {
  const start = firstAfter(events, instance.startMs - 1);
  const end = firstAfter(events, instance.endMs);
  let tokens = 0;
  let turns = 0;
  let costUsd = 0;
  let unpriced = 0;
  for (let index = start; index < end; index += 1) {
    tokens += events[index].tokens;
    turns += events[index].turns;
    costUsd += events[index].costUsd;
    unpriced += events[index].turns - events[index].costKnownTurns;
  }
  return {
    key: instance.key,
    startMs: instance.startMs,
    endMs: instance.endMs,
    resetAt: instance.resetAt,
    peak: round(instance.peak, 1),
    peakAt: instance.peakAt,
    exhaustedAt: instance.exhaustedAt,
    current: instance.current,
    tokens,
    turns,
    ...quotaCostFields(
      costUsd,
      instance.value && !instance.outsideUnpriced ? instance.outsideCostUsd : null,
      unpriced > 0
    ),
    costPerPercent: instance.value ? round(instance.value.costPerPercent, 6) : null,
    estimateSamples: instance.estimate?.samples ?? 0,
    outside: round(instance.outside),
  };
}

function readQuotaRows(db, { provider, account, label }) {
  return db
    .prepare(`SELECT ts,seen_until AS until,used_pct AS usedPct,reset_at AS resetAt FROM quota_samples
        WHERE provider=? AND account=? AND label=? ORDER BY ts`)
    .all(provider, account, label);
}

/**
 * The history of one limit window over a period: the meter's path, who moved
 * it (per model and hover slot), where each window in it peaked and, for the
 * open window, where the current pace ends it. `view: 'window'` selects one
 * window (the latest, or `anchor`); any other view reads [fromMs, toMs]. The
 * list of every window is read a page at a time (readQuotaWindows).
 */
export function readQuotaHistory(
  db,
  {
    provider = '',
    account = '',
    label = '',
    inUse = {},
    view = 'window',
    anchor = null,
    fromMs = null,
    toMs = null,
    now = Date.now(),
  } = {}
) {
  const subscriptions = listQuotaSeries(db);
  const selection = pickSelection(subscriptions, { provider, account, label, inUse });
  const base = { generatedAt: now, view, subscriptions, selection };
  if (!selection) return { ...base, period: null };
  const rows = readQuotaRows(db, selection);
  const instances = quotaInstances(rows, selection.label, now);
  const listed = instances.filter((instance) => !instance.idle);
  const range = { firstDay: usageRollupDayKey(rows[0].ts) };
  const period = view === 'window' ? windowPeriod(listed, anchor) : { view, fromMs, toMs };
  if (!period) return { ...base, range, period: null };

  const domainFrom = period.fromMs > 0 ? period.fromMs : rows[0].ts;
  const domainTo = Math.max(period.toMs, domainFrom + MINUTE);
  const overlapping = (instance) => instance.endMs > domainFrom && instance.startMs < domainTo;
  const shown = instances.filter(overlapping);
  const calibrated = calibratedWindows(listed, shown);
  const events = readQuotaEvents(db, {
    provider: selection.provider,
    account: selection.account,
    label: selection.label,
    fromMs: Math.min(domainFrom, ...calibrated.map((instance) => instance.startMs)),
    toMs: Math.max(domainTo, ...shown.map((instance) => instance.endMs)),
  });
  const { shares, outside } = allocateQuota(
    shown,
    events,
    finerOutsideSpans(db, selection, events, calibrated, now),
    listed
  );
  const points = quotaPoints(shown);

  const slotMs =
    SLOT_SIZES.find((size) => (domainTo - domainFrom) / size <= MAX_SLOTS) ??
    Math.ceil((domainTo - domainFrom) / MAX_SLOTS);
  const slots = [];
  for (let start = domainFrom; start < domainTo; start += slotMs) {
    slots.push({
      fromMs: start,
      toMs: Math.min(start + slotMs, domainTo),
      future: start >= now,
      usage: emptyUsage(),
      models: new Map(),
      outside: 0,
      outsideCostUsd: 0,
      outsideUnpriced: 0,
    });
  }
  const slotAt = (time) => Math.min(slots.length - 1, Math.max(0, Math.floor((time - domainFrom) / slotMs)));
  const totals = emptyUsage();
  const models = new Map();
  events.forEach((event, index) => {
    if (event.ts < domainFrom || event.ts > domainTo) return;
    const share = shares[index];
    addUsage(totals, event, share);
    const model = models.get(event.model) || emptyUsage();
    models.set(event.model, model);
    addUsage(model, event, share);
    const slot = slots[slotAt(event.ts)];
    addUsage(slot.usage, event, share);
    const slotModel = slot.models.get(event.model) || emptyUsage();
    slot.models.set(event.model, slotModel);
    addUsage(slotModel, event, share);
  });
  const outsideTotal = spreadOutsideUsage(outside, slots, slotAt, domainFrom, domainTo);
  const costPerPercent = periodQuotaRate(shown, domainFrom, domainTo);
  const outsideCostUsd =
    costPerPercent === null || slots.some((slot) => slot.outsideUnpriced > 0)
      ? null
      : slots.reduce((sum, slot) => sum + slot.outsideCostUsd, 0);

  const exportedModels = [...models].map(([model, usage]) => ({ model, ...exportUsage(usage) })).sort(byConsumption);
  const seriesKeys = exportedModels
    .filter((model) => model.consumed > 0)
    .slice(0, SERIES_LIMIT)
    .map((model) => model.model);
  if (outsideTotal > 0) seriesKeys.push(OUTSIDE_KEY);
  const lastPoint = points.at(-1)?.[0] ?? domainFrom;
  const peaks = listed.filter(overlapping);
  const focus = view === 'window' ? listed.find((instance) => instance.key === period.anchor) : null;
  return {
    ...base,
    range,
    period,
    domain: { fromMs: domainFrom, toMs: domainTo },
    points: decimate(points, domainFrom, domainTo),
    focus: focus
      ? {
          startMs: focus.startMs,
          endMs: focus.endMs,
          resetAt: focus.resetAt,
          usedPct: focus.lastPct,
          readAt: focus.lastAt,
          peak: focus.peak,
          exhaustedAt: focus.exhaustedAt,
          current: focus.current,
          // Whether the window's opening is known, so an even pace can be drawn.
          paced: focus.paced,
        }
      : null,
    forecast: forecastFor(focus, points),
    summary: {
      consumed: round(totals.consumed + outsideTotal),
      outside: round(outsideTotal),
      ...quotaCostFields(totals.costUsd, outsideCostUsd, totals.costKnownTurns < totals.turns),
      costPerPercent,
      estimateSamples: shown.reduce((sum, instance) => sum + (instance.estimate?.samples ?? 0), 0),
      maxedOut: peaks.filter(
        (instance) =>
          instance.exhaustedAt !== null && instance.exhaustedAt >= domainFrom && instance.exhaustedAt <= domainTo
      ).length,
    },
    totals: exportUsage(totals),
    outside: round(outsideTotal),
    models: exportedModels,
    slotMs,
    slots: slots.map((slot) => ({
      fromMs: slot.fromMs,
      toMs: slot.toMs,
      future: slot.future,
      startPct: round(valueAt(points, slot.fromMs), 1),
      endPct: round(valueAt(points, Math.min(slot.toMs, lastPoint)), 1),
      consumed: round(slot.usage.consumed + slot.outside),
      outside: round(slot.outside),
      tokens: tokensOf(slot.usage),
      turns: slot.usage.turns,
      ...quotaCostFields(
        slot.usage.costUsd,
        periodQuotaRate(shown, slot.fromMs, slot.toMs) === null || slot.outsideUnpriced > 0
          ? null
          : slot.outsideCostUsd,
        slot.usage.costKnownTurns < slot.usage.turns
      ),
      models: [...slot.models]
        .map(([model, usage]) => ({
          model,
          consumed: round(usage.consumed),
          tokens: tokensOf(usage),
          costUsd: round(usage.costUsd, 6),
        }))
        .sort(byConsumption),
    })),
    modelSeries: modelSeries(slots, shown, seriesKeys, now),
    // A period over several windows marks where each of them peaked.
    peaks:
      view === 'window'
        ? []
        : peaks.map((instance) => ({ key: instance.key, peak: round(instance.peak, 1), peakAt: instance.peakAt })),
  };
}

/**
 * One page of a limit window's history, newest first: every window that
 * opened, with its peak, the shape it rose in and what the requests behind it
 * cost. `page` is clamped to the pages there are.
 */
export function readQuotaWindows(
  db,
  { provider = '', account = '', label = '', inUse = {}, page = 0, now = Date.now() } = {}
) {
  const selection = pickSelection(listQuotaSeries(db), { provider, account, label, inUse });
  const base = { generatedAt: now, selection, page: 0, pageCount: 0, total: 0, windows: [] };
  if (!selection) return base;
  const chronological = quotaInstances(readQuotaRows(db, selection), selection.label, now).filter(
    (instance) => !instance.idle
  );
  const listed = chronological.toReversed();
  const pageCount = Math.ceil(listed.length / HISTORY_PAGE_SIZE);
  if (!pageCount) return base;
  const index = Math.min(Math.max(0, Math.floor(page) || 0), pageCount - 1);
  const shown = listed.slice(index * HISTORY_PAGE_SIZE, (index + 1) * HISTORY_PAGE_SIZE);
  const calibrated = calibratedWindows(chronological, shown);
  const events = readQuotaEvents(db, {
    provider: selection.provider,
    account: selection.account,
    label: selection.label,
    fromMs: Math.min(...calibrated.map((instance) => instance.startMs)),
    toMs: Math.max(...shown.map((instance) => instance.endMs)),
  });
  allocateQuota(shown, events, finerOutsideSpans(db, selection, events, calibrated, now), chronological);
  return {
    ...base,
    page: index,
    pageCount,
    total: listed.length,
    windows: shown.map((instance) => historyRow(instance, events)),
  };
}
