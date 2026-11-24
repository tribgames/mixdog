//! `quota_samples` keeps one row per distinct reading of one limit window (provider · account ·
//! label). A repeat of the reading only extends `seen_until`, so a row is a value plus the span
//! over which it was confirmed, and the time between rows is time nobody measured. Each rise
//! of the meter is split over the same provider account's token records in its interval by
//! list-price value; a rise with no Mixdog record behind it came from outside Mixdog. The split
//! is an estimate: providers do not publish what a request costs the meter.

#![allow(clippy::neg_cmp_op_on_partial_ord, reason = "NaN must take the guard's branch")]

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;

use rusqlite::params;
use serde_json::Map;
use serde_json::Value;

use crate::db::Connection;
use crate::db::OptionalExtension;
use crate::db::TransactionBehavior;
use crate::error::Result;
use crate::measure::NO_USAGE_COST_SOURCE;
use crate::measure::Ordered;
use crate::measure::SpeedTier;
use crate::measure::is_unmeasuring_provider;
use crate::measure::js_number;
use crate::measure::round_to;
use crate::measure::sort_model_tiers;
use crate::measure::speed_tier_sql;
use crate::period::PeriodRequest;
use crate::period::resolve_usage_stats_period;
use crate::quota_estimate::Estimate;
use crate::quota_estimate::Interval;
use crate::quota_estimate::Weight;
use crate::quota_estimate::is_value_evidence;
use crate::quota_estimate::quota_value;
use crate::time::day_key;
use crate::time::local_fields;
use crate::time::local_ms;
use mixdog_js::math::max;
use mixdog_js::math::min;
use mixdog_js::math::round;

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
// Distinct records a window's value, with the windows before it, must rest on before it is shown
// in dollars.
const MIN_VALUE_SAMPLES: usize = 10;
// Codex reports its reset as a countdown, so one window's reset drifts by the request latency
// between readings. A later reset, or a meter that fell, opens a new window.
const RESET_TOLERANCE_MS: f64 = 2.0 * MINUTE;
const RESET_DROP_POINTS: f64 = 5.0;
// Readings further apart than this leave the path between them unmeasured.
const MEASURED_GAP_MS: f64 = 20.0 * MINUTE;
// Hover slots: the finest of these sizes that cuts the chart into at most 48.
const SLOT_MINUTES: [f64; 11] = [30.0, 60.0, 120.0, 180.0, 360.0, 720.0, 1440.0, 2880.0, 10080.0, 20160.0, 43200.0];
const MAX_SLOTS: f64 = 48.0;
const MAX_POINTS: usize = 4000;
// The window history is read a page at a time.
const HISTORY_PAGE_SIZE: usize = 10;
const SERIES_LIMIT: usize = 6;
// Each window's value continues from the windows just before it, back until they hold this
// many quota points (at most this many windows).
const PRIOR_POINTS: f64 = 100.0;
const PRIOR_WINDOWS: usize = 24;
const MOVE: u8 = 0;
const MEASURED: u8 = 1;
const UNMEASURED: u8 = 2;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `^<prefix>\b` over the upper-cased text (case-blind prefix).
fn starts_word(text: &str, prefix: &str) -> bool {
    let upper = text.to_uppercase();
    upper.strip_prefix(prefix).is_some_and(|rest| !rest.chars().next().is_some_and(is_word))
}

/// Nominal length of a limit window from its label; none when unknown.
pub fn quota_window_span_ms(label: &str) -> Option<f64> {
    if starts_word(label, "5H") {
        Some(5.0 * HOUR)
    } else if starts_word(label, "24H") {
        Some(24.0 * HOUR)
    } else if starts_word(label, "7D") || starts_word(label, "W") {
        Some(7.0 * 24.0 * HOUR)
    } else {
        None
    }
}

/// When a window opened, from its reset: one fixed span back, or one calendar month for a
/// monthly window; none when the label does not say.
fn quota_window_opened(label: &str, reset_at: Option<f64>) -> Option<f64> {
    let reset_at = reset_at?;
    if let Some(span) = quota_window_span_ms(label) {
        return Some(reset_at - span);
    }
    if !starts_word(label, "M") {
        return None;
    }
    // `setMonth(getMonth() - 1)` keeps the day number: a short month overflows into the next.
    let fields = local_fields(reset_at as i64);
    let (year, month) = if chrono::Datelike::month(&fields) == 1 {
        (chrono::Datelike::year(&fields) - 1, 12)
    } else {
        (chrono::Datelike::year(&fields), chrono::Datelike::month(&fields) - 1)
    };
    let first = chrono::NaiveDate::from_ymd_opt(year, month, 1)?;
    let date = first + chrono::TimeDelta::days(i64::from(chrono::Datelike::day(&fields)) - 1);
    Some(local_ms(date.and_time(fields.time())) as f64)
}

fn window_order(a: &str, b: &str) -> std::cmp::Ordering {
    let span = |label: &str| quota_window_span_ms(label).unwrap_or(MAX_SAFE);
    (span(a) - span(b))
        .partial_cmp(&0.0)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then_with(|| mixdog_js::utf16_len(a).cmp(&mixdog_js::utf16_len(b)))
        .then_with(|| mixdog_js::locale_compare(a, b))
}

/// One reading of a limit window.
#[derive(Clone, Copy, Debug)]
pub struct QuotaSample {
    pub ts: i64,
    pub used_pct: f64,
    pub reset_at: Option<i64>,
}

/// A reading to record for one limit window.
#[derive(Clone, Debug)]
pub struct QuotaReading {
    pub provider: String,
    pub account: String,
    pub label: String,
    /// The provider declares the window rolling: its use ages out continuously instead of resetting.
    pub rolling: bool,
    pub sample: QuotaSample,
}

struct Latest {
    ts: i64,
    seen_until: i64,
    used_pct: f64,
    reset_at: Option<i64>,
}

fn same_window(previous: &Latest, reading: &QuotaReading) -> bool {
    let sample = &reading.sample;
    // A rolling window is one window: its use ages out and its reset slides with it.
    // An idle meter reads zero against a reset that may keep moving: no window ran.
    if reading.rolling || (previous.used_pct == 0.0 && sample.used_pct == 0.0) {
        return true;
    }
    if sample.used_pct < previous.used_pct - RESET_DROP_POINTS {
        return false;
    }
    match (previous.reset_at, sample.reset_at) {
        (Some(a), Some(b)) => ((a - b).abs() as f64) <= RESET_TOLERANCE_MS,
        (a, b) => a.is_none() && b.is_none(),
    }
}

/// Stores readings in one transaction. A repeat of the latest reading of its window extends
/// that row; a new reading of the same window keeps the window's first reset, so a drifting
/// countdown never splits one window, except a rolling window's, whose reset slides as its use
/// ages out. Returns the readings taken.
pub fn record_quota_samples(conn: &mut Connection, samples: &[QuotaReading]) -> Result<usize> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut written = 0;
    for reading in samples {
        let key = (&reading.provider, &reading.account, &reading.label);
        let previous: Option<Latest> = tx
            .prepare_cached(
                "SELECT ts,seen_until,used_pct,reset_at FROM quota_samples
                 WHERE provider=?1 AND account=?2 AND label=?3 ORDER BY ts DESC LIMIT 1",
            )?
            .query_row(params![key.0, key.1, key.2], |r| Ok(Latest { ts: r.get(0)?, seen_until: r.get(1)?, used_pct: r.get(2)?, reset_at: r.get(3)? }))
            .optional()?;
        let sample = &reading.sample;
        // A reading older than the span already confirmed arrived late.
        if previous.as_ref().is_some_and(|p| sample.ts <= p.seen_until) {
            continue;
        }
        let same = previous.as_ref().is_some_and(|p| same_window(p, reading));
        match &previous {
            Some(p) if same && (p.used_pct - sample.used_pct).abs() < 0.005 => {
                tx.prepare_cached("UPDATE quota_samples SET seen_until=?1 WHERE provider=?2 AND account=?3 AND label=?4 AND ts=?5")?
                    .execute(params![sample.ts, key.0, key.1, key.2, p.ts])?;
            }
            _ => {
                let reset = if same && !reading.rolling { previous.as_ref().and_then(|p| p.reset_at) } else { sample.reset_at };
                tx.prepare_cached(
                    "INSERT OR IGNORE INTO quota_samples(provider,account,label,ts,seen_until,used_pct,reset_at,rolling)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                )?
                .execute(params![key.0, key.1, key.2, sample.ts, sample.ts, sample.used_pct, reset, reading.rolling])?;
            }
        }
        written += 1;
    }
    tx.commit()?;
    Ok(written)
}

/// The next recorded (provider, account, label) after a key: windows are visited by index
/// probes, never by a scan of the samples.
pub const NEXT_SERIES_SQL: &str = "SELECT provider,account,label FROM quota_samples WHERE (provider,account,label) > (?1,?2,?3)
         ORDER BY provider,account,label LIMIT 1";
/// When a window's meter last moved.
pub const SERIES_CHANGED_SQL: &str = "SELECT MAX(ts) FROM quota_samples WHERE provider=?1 AND account=?2 AND label=?3";
/// Every reading of one window, oldest first.
pub const WINDOW_ROWS_SQL: &str = "SELECT ts,seen_until,used_pct,reset_at,rolling FROM quota_samples WHERE provider=?1 AND account=?2 AND label=?3 ORDER BY ts";

#[derive(Clone, Debug)]
struct Series {
    provider: String,
    account: String,
    windows: Vec<String>,
}

/// Every recorded subscription account with its limit windows. The one whose meter moved last
/// comes first — the subscription in use. Distinct windows are visited by index probes, never
/// by a scan of the samples.
fn list_quota_series(conn: &Connection) -> Result<Vec<Series>> {
    let mut found: Ordered<(Series, f64)> = Ordered::default();
    let mut next = conn.prepare_cached(NEXT_SERIES_SQL)?;
    let mut changed = conn.prepare_cached(SERIES_CHANGED_SQL)?;
    // The empty key sorts before every stored one (a provider is never empty).
    let mut cursor: (String, String, String) = (String::new(), String::new(), String::new());
    loop {
        let row: Option<(String, String, String)> =
            next.query_row(params![cursor.0, cursor.1, cursor.2], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        let Some(row) = row else { break };
        let ts: i64 = changed.query_row(params![row.0, row.1, row.2], |r| r.get(0))?;
        let key = format!("{}\u{0}{}", row.0, row.1);
        let entry = found.entry(&key, || (Series { provider: row.0.clone(), account: row.1.clone(), windows: Vec::new() }, 0.0));
        entry.0.windows.push(row.2.clone());
        entry.1 = max(entry.1, ts as f64);
        cursor = row;
    }
    let mut series: Vec<(Series, f64)> = found.values().cloned().collect();
    series.sort_by(|a, b| (b.1 - a.1).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(series
        .into_iter()
        .map(|(mut s, _)| {
            s.windows.sort_by(|a, b| window_order(a, b));
            s
        })
        .collect())
}

/// The account and window a question names (or the defaults).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub provider: String,
    pub account: String,
    pub label: String,
}

impl Selection {
    fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("provider".into(), self.provider.clone().into());
        out.insert("account".into(), self.account.clone().into());
        out.insert("label".into(), self.label.clone().into());
        Value::Object(out)
    }
}

fn is_weekly(label: &str) -> bool {
    label.eq_ignore_ascii_case("7D") || label.eq_ignore_ascii_case("W")
}

/// No account asked for: the one its account pool has in use (`in_use`, per provider), else the
/// one whose meter moved last. A subscription opens on its weekly window unless a window was
/// asked for; one without a weekly window opens on its shortest.
fn pick_selection(series: &[Series], provider: &str, account: &str, label: &str, in_use: &BTreeMap<String, String>) -> Option<Selection> {
    let chosen = if provider.is_empty() { series.first()?.provider.clone() } else { provider.to_string() };
    let account_id = if account.is_empty() { in_use.get(&chosen).cloned().unwrap_or_default() } else { account.to_string() };
    let entry = series
        .iter()
        .find(|row| row.provider == chosen && row.account == account_id)
        .or_else(|| series.iter().find(|row| row.provider == chosen))
        .or_else(|| series.first())?;
    let wanted = label.to_lowercase();
    let picked =
        entry.windows.iter().find(|w| w.to_lowercase() == wanted).or_else(|| entry.windows.iter().find(|w| is_weekly(w))).or_else(|| entry.windows.first())?;
    Some(Selection { provider: entry.provider.clone(), account: entry.account.clone(), label: picked.clone() })
}

#[derive(Clone, Copy, Debug)]
struct Row {
    ts: f64,
    until: f64,
    used_pct: f64,
    reset_at: Option<f64>,
    rolling: bool,
}

fn read_quota_rows(conn: &Connection, selection: &Selection, label: &str) -> Result<Vec<Row>> {
    let mut stmt = conn.prepare_cached(WINDOW_ROWS_SQL)?;
    let rows = stmt
        .query_map(params![selection.provider, selection.account, label], |r| {
            Ok(Row {
                ts: r.get::<_, i64>(0)? as f64,
                until: r.get::<_, i64>(1)? as f64,
                used_pct: r.get(2)?,
                reset_at: r.get::<_, Option<i64>>(3)?.map(|v| v as f64),
                rolling: r.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// A limit window: its readings, span and the estimate its meter rises were split with.
#[derive(Clone, Debug, Default)]
struct Instance {
    key: String,
    rows: Vec<Row>,
    reset_at: Option<f64>,
    peak: f64,
    peak_at: f64,
    exhausted_at: Option<f64>,
    last_pct: f64,
    last_at: f64,
    idle: bool,
    current: bool,
    paced: bool,
    /// Its readings declare it rolling: use ages out continuously, so a fall is real use leaving it.
    rolling: bool,
    /// How far the meter moves on its own ([`series_jitter`]); none on a rolling window.
    jitter: f64,
    start_ms: f64,
    end_ms: f64,
    outside: f64,
    outside_cost_usd: f64,
    outside_unpriced: f64,
    unattributed: f64,
    intervals: Vec<Interval>,
    estimate: Option<Estimate>,
    value: Option<Estimate>,
}

/// Readings grouped into limit windows. A run that never left zero is idle — no window was
/// open — and only fills the measured time between the windows around it.
fn quota_instances(rows: &[Row], label: &str, now: f64) -> Vec<Instance> {
    let mut instances = group_instances(rows);
    mark_open_window(&mut instances, now);
    place_windows(&mut instances, label, now);
    let jitter = series_jitter(&instances);
    for instance in &mut instances {
        instance.jitter = if instance.rolling { 0.0 } else { jitter };
    }
    instances
}

/// The series' jitter band: the deepest fall below the highest reading so far inside any window that does not roll.
/// Use there only accumulates, so such a fall is the meter's own movement, and a move no larger than it cannot be told
/// from that movement.
fn series_jitter(instances: &[Instance]) -> f64 {
    let mut band = 0.0;
    for instance in instances.iter().filter(|i| !i.rolling) {
        let mut highest = 0.0;
        for row in &instance.rows {
            highest = max(highest, row.used_pct);
            band = max(band, highest - row.used_pct);
        }
    }
    band
}

/// Readings grouped by window: a moved reset or a fall opens the next one, except on a window that declares itself
/// rolling, where use ages out and the reset slides with it.
fn group_instances(rows: &[Row]) -> Vec<Instance> {
    let mut groups: Vec<Vec<Row>> = Vec::new();
    for row in rows {
        let new_group = match groups.last().and_then(|g| g.last()) {
            None => true,
            Some(previous) => !(row.rolling && previous.rolling) && (row.reset_at != previous.reset_at || row.used_pct < previous.used_pct - RESET_DROP_POINTS),
        };
        if new_group {
            groups.push(Vec::new());
        }
        if let Some(group) = groups.last_mut() {
            group.push(*row);
        }
    }
    groups
        .into_iter()
        .map(|group| {
            let first = group[0];
            let last = group[group.len() - 1];
            let mut peak = first;
            for row in &group {
                if row.used_pct > peak.used_pct {
                    peak = *row;
                }
            }
            let rolling = group.iter().any(|r| r.rolling);
            Instance {
                key: js_number(first.ts).to_string(),
                // A rolling window's reset slides: it opened by its first and next frees up at its latest.
                reset_at: if rolling { last.reset_at } else { first.reset_at },
                peak: peak.used_pct,
                peak_at: peak.ts,
                exhausted_at: group.iter().find(|r| r.used_pct >= 100.0).map(|r| r.ts),
                last_pct: last.used_pct,
                last_at: last.until,
                idle: peak.used_pct == 0.0,
                rolling,
                rows: group,
                ..Instance::default()
            }
        })
        .collect()
}

/// After a reset, early or on time, the meter reads zero until the next request: that last run is the window open
/// now, not a gap between windows.
fn mark_open_window(instances: &mut [Instance], now: f64) {
    let any_active = instances.iter().any(|i| !i.idle);
    if let Some(latest) = instances.last_mut()
        && latest.idle
        && any_active
        && latest.reset_at.is_none_or(|r| r > now)
    {
        latest.idle = false;
    }
}

/// Each window's span: its clock started at its opening, and an idle run fills the time between the windows around it.
fn place_windows(instances: &mut [Instance], label: &str, now: f64) {
    let mut previous_end = f64::NEG_INFINITY;
    for index in 0..instances.len() {
        if instances[index].idle {
            continue;
        }
        let next_ts = instances.get(index + 1).map(|n| n.rows[0].ts);
        let has_next = next_ts.is_some();
        let instance = &mut instances[index];
        let first_ts = instance.rows[0].ts;
        // A window's clock started at its opening: never after its first reading, never inside
        // the window before it.
        let opened = quota_window_opened(label, instance.rows[0].reset_at);
        instance.paced = opened.is_some();
        instance.start_ms = max(min(opened.unwrap_or(first_ts), first_ts), previous_end);
        instance.end_ms = max(min(instance.reset_at.unwrap_or(instance.last_at), next_ts.unwrap_or(f64::INFINITY)), instance.last_at);
        instance.current = !has_next && instance.reset_at.is_none_or(|r| r > now);
        previous_end = instance.end_ms;
    }
    let mut before = f64::NEG_INFINITY;
    for instance in instances.iter_mut() {
        if instance.idle {
            instance.start_ms = max(instance.rows[0].ts, before);
        } else {
            before = instance.end_ms;
        }
    }
    let mut after = f64::INFINITY;
    for instance in instances.iter_mut().rev() {
        if instance.idle {
            instance.end_ms = max(instance.start_ms, min(instance.last_at, after));
        } else {
            after = instance.start_ms;
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Point {
    at: f64,
    percent: f64,
    kind: u8,
}

/// The meter's path through a run of windows.
fn quota_points(instances: &[&Instance]) -> Vec<Point> {
    let mut points: Vec<Point> = Vec::new();
    fn add(points: &mut Vec<Point>, time: f64, value: f64, kind: u8) {
        let at = round(time);
        let percent = round_to(value, 2);
        if let Some(last) = points.last()
            && last.at == at
            && last.percent == percent
        {
            return;
        }
        let kind = if points.is_empty() { MOVE } else { kind };
        points.push(Point { at, percent, kind });
    }
    let stretch = |from: f64, to: f64| {
        if to - from > MEASURED_GAP_MS { UNMEASURED } else { MEASURED }
    };
    for instance in instances {
        if instance.idle {
            if instance.end_ms > instance.start_ms {
                let prior = points.last().map_or(instance.start_ms, |p| p.at);
                add(&mut points, instance.start_ms, 0.0, stretch(prior, instance.start_ms));
                add(&mut points, instance.end_ms, 0.0, MEASURED);
            }
            continue;
        }
        // Between windows the meter sits at zero, and every window opens there.
        if instance.start_ms < instance.rows[0].ts {
            let prior = points.last().map_or(instance.start_ms, |p| p.at);
            add(&mut points, instance.start_ms, 0.0, stretch(prior, instance.start_ms));
        }
        for row in &instance.rows {
            let prior = points.last().map_or(row.ts, |p| p.at);
            add(&mut points, row.ts, row.used_pct, stretch(prior, row.ts));
            if row.until > row.ts {
                add(&mut points, row.until, row.used_pct, MEASURED);
            }
        }
        if instance.current {
            continue;
        }
        add(&mut points, instance.end_ms, instance.last_pct, stretch(instance.last_at, instance.end_ms));
        add(&mut points, instance.end_ms, 0.0, MEASURED);
    }
    points
}

/// The meter at `time` on a path: linear between vertices, flat after the last.
fn value_at(points: &[Point], time: f64) -> f64 {
    if points.is_empty() || time < points[0].at {
        return 0.0;
    }
    let (mut low, mut high) = (0usize, points.len() - 1);
    while low < high {
        let mid = (low + high + 1) >> 1;
        if points[mid].at <= time {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    let Point { at, percent: value, .. } = points[low];
    match points.get(low + 1) {
        Some(next) if next.kind != MOVE && next.at != at => value + ((next.percent - value) * (time - at)) / (next.at - at),
        _ => value,
    }
}

/// Thin a long path to the first, last, highest and lowest vertex per step.
fn decimate(points: Vec<Point>, from_ms: f64, to_ms: f64) -> Vec<Point> {
    if points.len() <= MAX_POINTS {
        return points;
    }
    let step = (to_ms - from_ms) / (MAX_POINTS as f64 / 4.0);
    let mut kept = Vec::new();
    let mut bucket: Option<f64> = None;
    let mut group: Vec<Point> = Vec::new();
    fn flush(group: &mut Vec<Point>, kept: &mut Vec<Point>) {
        if group.is_empty() {
            return;
        }
        let (mut high, mut low) = (0usize, 0usize);
        for (i, p) in group.iter().enumerate() {
            if p.percent > group[high].percent {
                high = i;
            }
            if p.percent < group[low].percent {
                low = i;
            }
        }
        let last = group.len() - 1;
        for (i, p) in group.iter().enumerate() {
            if i == 0 || i == high || i == low || i == last {
                kept.push(*p);
            }
        }
        group.clear();
    }
    for point in points {
        let index = ((point.at - from_ms) / step).floor();
        if bucket != Some(index) || point.kind == MOVE {
            flush(&mut group, &mut kept);
            bucket = Some(index);
        }
        group.push(point);
    }
    flush(&mut group, &mut kept);
    kept
}

/// One record row, summed per minute and model.
#[derive(Clone, Debug)]
struct Event {
    ts: f64,
    model: String,
    turns: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_usd: f64,
    cost_known_turns: f64,
    unmeasured_turns: f64,
    speed_output: f64,
    speed_ms: f64,
    tokens: f64,
    span_ms: f64,
}

impl Event {
    /// The stretch of the record's run, which ended at `ts`, inside (from_ms, to_ms].
    fn run_in(&self, from_ms: f64, to_ms: f64) -> (f64, f64) {
        if self.span_ms <= 0.0 {
            return (self.ts, self.ts);
        }
        (max(self.ts - self.span_ms, from_ms), min(self.ts, to_ms))
    }

    fn fraction_in(&self, from_ms: f64, to_ms: f64) -> f64 {
        if self.span_ms <= 0.0 {
            return if self.ts > from_ms && self.ts <= to_ms { 1.0 } else { 0.0 };
        }
        max(0.0, min(self.ts, to_ms) - max(self.ts - self.span_ms, from_ms)) / self.span_ms
    }

    /// The stretches of the record's run that `covered`, stretches of that run, leave out, each with the part of the
    /// record it is.
    fn uncovered(&self, covered: &mut [(f64, f64)]) -> Vec<(f64, f64, f64)> {
        if self.span_ms <= 0.0 {
            return if covered.is_empty() { vec![(self.ts, self.ts, 1.0)] } else { Vec::new() };
        }
        covered.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut gaps = Vec::new();
        let mut at = self.ts - self.span_ms;
        for &(from_ms, to_ms) in covered.iter() {
            if from_ms > at {
                gaps.push((at, from_ms, (from_ms - at) / self.span_ms));
            }
            at = max(at, to_ms);
        }
        if self.ts > at {
            gaps.push((at, self.ts, (self.ts - at) / self.span_ms));
        }
        gaps
    }

    fn weight(&self, weight: Weight) -> f64 {
        match weight {
            Weight::Turns => self.turns,
            Weight::CostUsd => self.cost_usd,
            Weight::Tokens => self.tokens,
        }
    }
}

/// Index of the first record later than `time`; records are sorted by ts.
fn first_after(events: &[Event], time: f64) -> usize {
    let (mut low, mut high) = (0usize, events.len());
    while low < high {
        let mid = (low + high) >> 1;
        if events[mid].ts <= time {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    low
}

/// Records written before accounts were recorded carry none. They were made through the
/// account the provider was used through when recording began: the one on its earliest record
/// that names an account.
fn legacy_account_owner(conn: &Connection, provider: &str) -> Result<Option<String>> {
    let mut routes = conn.prepare_cached(
        "SELECT id,json_extract(signature,'$[8]') FROM usage_routes
         WHERE json_extract(signature,'$[0]')=?1 AND COALESCE(json_extract(signature,'$[8]'),'')<>''",
    )?;
    let named: Vec<(i64, String)> = routes.query_map([provider], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<_, _>>()?;
    let mut earliest = conn.prepare_cached("SELECT MIN(ts) FROM usage_events WHERE route=?1")?;
    let mut best: Option<(i64, String)> = None;
    for (route, account) in named {
        let ts: Option<i64> = earliest.query_row([route], |r| r.get(0))?;
        if let Some(ts) = ts
            && best.as_ref().is_none_or(|(held, _)| ts < *held)
        {
            best = Some((ts, account));
        }
    }
    Ok(best.map(|(_, account)| account))
}

/// Anthropic's scoped weekly labels are model-family limits, not the whole subscription: the model prefix such a
/// label selects, else "".
fn model_family_scope(selection: &Selection) -> String {
    if selection.provider == "anthropic-oauth" && selection.label.starts_with("7D ") {
        let tail = mixdog_js::js_trim(&selection.label[3..]).to_lowercase();
        let separators = mixdog_js::JsRegex::new_static(r"[\s_]+", "g");
        format!("claude-{}", separators.replace_all_with(&tail, |_| "-".to_string()))
    } else {
        String::new()
    }
}

/// `YYYY-MM-DD` of a record's `day` (`YYYYMMDD`).
fn day_text(day: i64) -> String {
    let day = day.to_string();
    format!("{}-{}-{}", &day[..4], &day[4..6], &day[6..])
}

/// The best (lowest) origin rank of each day in [first_day, last_day] and model of the provider, keyed `day\0model`.
fn best_origin_ranks(conn: &Connection, provider: &str, first_day: &str, last_day: &str) -> Result<HashMap<String, Option<f64>>> {
    let mut best: HashMap<String, Option<f64>> = HashMap::new();
    let mut ranks = conn.prepare_cached("SELECT day,model,MIN(rank) AS rank FROM daily WHERE provider=?1 AND day BETWEEN ?2 AND ?3 GROUP BY day,model")?;
    let rows =
        ranks.query_map(params![provider, first_day, last_day], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<f64>>(2)?)))?;
    for row in rows {
        let (day, model, rank) = row?;
        best.insert(format!("{day}\u{0}{model}"), rank);
    }
    Ok(best)
}

/// The records of provider `?1`'s account (`?2`, or unlabeled when `?3` is empty) whose runs reach into [`?4`, `?5`],
/// summed per end, run and model. A record still running at `?5` ends no later than the longest run of its routes past
/// it, which bounds the read on the time index.
fn quota_events_sql() -> String {
    format!(
        "WITH routes AS (
            SELECT id,json_extract(signature,'$[1]') AS model,json_extract(signature,'$[7]') AS rank,
                {} AS speed_tier
            FROM usage_routes
            WHERE json_extract(signature,'$[0]')=?1 AND COALESCE(json_extract(signature,'$[8]'),'') IN (?2,?3)
                AND json_extract(signature,'$[4]')<>'{NO_USAGE_COST_SOURCE}'
        ),
        reach AS (
            SELECT ?5+COALESCE(MAX((SELECT MAX(d.duration_ms) FROM usage_events d WHERE d.route=routes.id)),0) AS ms FROM routes
        )
        SELECT e.ts,e.day,r.model,r.rank,COUNT(*) AS turns,
            SUM(e.input) AS input,SUM(e.output) AS output,SUM(e.cache_read) AS cacheRead,
            SUM(e.cache_write) AS cacheWrite,SUM(e.cost_usd) AS costUsd,COUNT(e.cost_usd) AS priced,
            SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END) AS speedOutput,
            SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END) AS speedMs,
            r.speed_tier,COALESCE(e.duration_ms,0) AS spanMs
        FROM usage_events e JOIN routes r ON r.id=e.route
        WHERE e.ts>=?4 AND e.ts<=(SELECT ms FROM reach) AND e.ts-COALESCE(e.duration_ms,0)<=?5
        GROUP BY e.ts,e.day,r.model,r.rank,r.speed_tier,COALESCE(e.duration_ms,0)
        ORDER BY e.ts",
        speed_tier_sql("signature")
    )
}

/// The provider account's token records whose runs reach into [from_ms, to_ms], summed per end, run and model,
/// keeping the best-ranked origin per day and model like the usage rollups. Records without an
/// account belong to the legacy owner only, or to every account while no record names one.
fn read_quota_events(conn: &Connection, selection: &Selection, from_ms: f64, to_ms: f64) -> Result<Vec<Event>> {
    let provider = selection.provider.as_str();
    let owner = legacy_account_owner(conn, provider)?;
    let unlabeled = match &owner {
        Some(o) if *o != selection.account => selection.account.as_str(),
        _ => "",
    };
    let scope = model_family_scope(selection);
    let sql = quota_events_sql();
    struct Raw {
        ts: i64,
        day: i64,
        model: String,
        rank: Option<f64>,
        turns: f64,
        input: Option<f64>,
        output: Option<f64>,
        cache_read: Option<f64>,
        cache_write: Option<f64>,
        cost_usd: Option<f64>,
        priced: f64,
        speed_output: Option<f64>,
        speed_ms: Option<f64>,
        tier: SpeedTier,
        span_ms: f64,
    }
    let mut stmt = conn.prepare_cached(&sql)?;
    let raws: Vec<Raw> = stmt
        .query_map(params![provider, selection.account, unlabeled, from_ms, to_ms], |r| {
            Ok(Raw {
                ts: r.get(0)?,
                day: r.get(1)?,
                model: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                rank: r.get(3)?,
                turns: r.get::<_, i64>(4)? as f64,
                input: r.get(5)?,
                output: r.get(6)?,
                cache_read: r.get(7)?,
                cache_write: r.get(8)?,
                cost_usd: r.get(9)?,
                priced: r.get::<_, i64>(10)? as f64,
                speed_output: r.get(11)?,
                speed_ms: r.get(12)?,
                tier: r.get(13)?,
                span_ms: r.get::<_, f64>(14)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    // A record's day is the one it ended on: for a record still running at `to_ms`, a day past it.
    let (Some(first_day), Some(last_day)) = (raws.iter().map(|r| r.day).min(), raws.iter().map(|r| r.day).max()) else {
        return Ok(Vec::new());
    };
    let best = best_origin_ranks(conn, provider, &day_text(first_day), &day_text(last_day))?;
    let unmeasuring = is_unmeasuring_provider(provider);
    let mut events = Vec::with_capacity(raws.len());
    for row in raws {
        let model = row.model.to_lowercase();
        if !scope.is_empty() && model != scope && !model.starts_with(&format!("{scope}-")) {
            continue;
        }
        let key = format!("{}\u{0}{}", day_text(row.day), row.model);
        if best.get(&key) != Some(&row.rank) {
            continue;
        }
        // `usage.x || 0`: the measurement normalization, then NaN and absent read as zero.
        let (input, cache_read, cache_write, cost_usd, known, unmeasured) = if unmeasuring {
            (0.0, 0.0, 0.0, 0.0, 0.0, row.turns)
        } else {
            (row.input.unwrap_or(0.0), row.cache_read.unwrap_or(0.0), row.cache_write.unwrap_or(0.0), row.cost_usd.unwrap_or(0.0), row.priced, 0.0)
        };
        let output = row.output.unwrap_or(0.0);
        events.push(Event {
            ts: row.ts as f64,
            model: row.tier.key(&row.model),
            turns: row.turns,
            input,
            output,
            cache_read,
            cache_write,
            cost_usd,
            cost_known_turns: known,
            unmeasured_turns: unmeasured,
            speed_output: row.speed_output.unwrap_or(0.0),
            speed_ms: row.speed_ms.unwrap_or(0.0),
            tokens: input + output + cache_read + cache_write,
            span_ms: row.span_ms,
        });
    }
    Ok(events)
}

/// The windows just before `instance`, oldest first: the calibration its value continues from.
/// `listed` is every non-idle window (indices), oldest first.
fn earlier_windows(all: &[Instance], listed: &[usize], instance: usize) -> Vec<usize> {
    let mut earlier: Vec<usize> = Vec::new();
    let mut points = 0.0;
    for &index in listed.iter().rev() {
        if points >= PRIOR_POINTS || earlier.len() >= PRIOR_WINDOWS {
            break;
        }
        if all[index].start_ms >= all[instance].start_ms {
            continue;
        }
        earlier.insert(0, index);
        points += all[index].peak;
    }
    earlier
}

/// Every window `shown` reads records for: itself and its calibration.
fn calibrated_windows(all: &[Instance], listed: &[usize], shown: &[usize]) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    let mut push = |index: usize| {
        if !out.contains(&index) {
            out.push(index);
        }
    };
    for &instance in shown {
        for index in earlier_windows(all, listed, instance) {
            push(index);
        }
    }
    for &instance in shown {
        push(instance);
    }
    out
}

/// A rise of `points` over (from_ms, to_ms], with the records that ran in it.
fn covered_interval(from_ms: f64, to_ms: f64, points: f64, events: &[Event], longest_run: f64) -> Interval {
    let start = first_after(events, from_ms);
    let end = first_after(events, to_ms + longest_run);
    let (mut cost, mut tokens, mut turns, mut priced) = (0.0, 0.0, 0.0, 0.0);
    for event in &events[start..end] {
        let f = event.fraction_in(from_ms, to_ms);
        cost += f * event.cost_usd;
        tokens += f * event.tokens;
        turns += f * event.turns;
        priced += f * event.cost_known_turns;
    }
    let (mut weight, mut total) = (Weight::Turns, turns);
    if cost > 0.0 {
        weight = Weight::CostUsd;
        total = cost;
    } else if tokens > 0.0 {
        weight = Weight::Tokens;
        total = tokens;
    }
    Interval { from_ms, to_ms, points, cost_usd: cost, start, end, weight, total, external: 0.0, unattributed: 0.0, priced: turns > 0.0 && priced == turns }
}

/// A rise no record ran in: `external` points of outside use, the rest unattributed.
fn uncovered_interval(from_ms: f64, to_ms: f64, points: f64, external: f64) -> Interval {
    let unattributed = points - external;
    Interval { from_ms, to_ms, points, cost_usd: 0.0, start: 0, end: 0, weight: Weight::Turns, total: 0.0, external, unattributed, priced: false }
}

/// One window's readings told apart into Mixdog's rises, each with the records behind it, outside use and what the
/// readings cannot assign.
///
/// - A reading a record ran up to, since the last rise, rises above that rise by Mixdog's use; one at or below it
///   books nothing, so the records running through a dip count in the next rise. A rolling meter steps from every
///   reading instead.
/// - The meter settles a request a reading late: a rise right after a Mixdog rise read only once, with a record that
///   ended since the reading before, is that rise's own lagged debit and joins it, so its records count once. Across
///   an unmeasured gap it cannot be told from other use and is unattributed.
/// - A stretch of readings no record ran in is judged by its net move: within the series' jitter band it is the
///   meter's own movement and books nothing, keeping the last rise as the base; past it, the excess is outside use and
///   the band unattributed, booked where its readings rose ([`stretch_rises`]).
fn window_intervals(instance: &Instance, events: &[Event], finer: &[Interval]) -> Vec<Interval> {
    let longest_run = events.iter().fold(0.0, |m, e| max(m, e.span_ms));
    let ran_in = |from_ms: f64, to_ms: f64| {
        events[first_after(events, from_ms)..first_after(events, to_ms + longest_run)].iter().any(|e| e.fraction_in(from_ms, to_ms) > 0.0)
    };
    let rows = &instance.rows;
    let mut intervals: Vec<Interval> = Vec::new();
    let (mut base_ms, mut base_pct) = (instance.start_ms, 0.0);
    // The reading that last rose by Mixdog's use, and when the reading before it was last confirmed.
    let mut last_rise: Option<(usize, f64)> = None;
    let mut index = 0;
    while index < rows.len() {
        let row = rows[index];
        let delta = row.used_pct - base_pct;
        if ran_in(base_ms, row.ts) {
            if delta > 0.0 {
                intervals.push(covered_interval(base_ms, row.ts, delta, events, longest_run));
                last_rise = Some((index, if index > 0 { rows[index - 1].until } else { instance.start_ms }));
                (base_ms, base_pct) = (row.ts, row.used_pct);
            } else if instance.rolling {
                (base_ms, base_pct) = (row.ts, row.used_pct);
                last_rise = None;
            }
            index += 1;
            continue;
        }
        let lagged = last_rise.is_some_and(|(rise, confirmed)| {
            let read = rows[rise];
            rise + 1 == index && read.until == read.ts && first_after(events, confirmed) < first_after(events, read.ts)
        });
        if delta > 0.0 && lagged {
            if row.ts - rows[index - 1].ts <= MEASURED_GAP_MS {
                let rise = intervals.last_mut().expect("the rise the lagged debit settles");
                rise.points += delta;
                rise.to_ms = row.ts;
            } else {
                intervals.push(uncovered_interval(base_ms, row.ts, delta, 0.0));
            }
            last_rise = None;
            (base_ms, base_pct) = (row.ts, row.used_pct);
            index += 1;
            continue;
        }
        let mut end = index + 1;
        if !instance.rolling {
            while end < rows.len() && !ran_in(rows[end - 1].ts, rows[end].ts) {
                end += 1;
            }
        }
        let last = rows[end - 1];
        let net = last.used_pct - base_pct;
        if instance.rolling {
            if net > 0.0 {
                intervals.push(uncovered_interval(base_ms, last.ts, net, net));
            }
            (base_ms, base_pct) = (last.ts, last.used_pct);
        } else if net <= instance.jitter {
            base_ms = last.ts;
        } else {
            let rises = stretch_rises(&rows[index..end], base_ms, base_pct);
            let risen = rises.iter().fold(0.0, |sum, rise| sum + rise.2);
            for (from_ms, to_ms, rise) in rises {
                let share = rise / risen;
                intervals.push(uncovered_interval(from_ms, to_ms, net * share, (net - instance.jitter) * share));
            }
            (base_ms, base_pct) = (last.ts, last.used_pct);
        }
        last_rise = None;
        index = end;
    }
    for interval in intervals.iter_mut().filter(|i| i.total > 0.0) {
        (interval.external, interval.unattributed) = finer_split(interval, finer);
    }
    intervals
}

/// Each reading of a stretch that rose above the highest one before it, from (`from_ms`, `from_pct`): the time since
/// that highest reading and the points it rose by. What the stretch books is shared out by these rises, so it lands
/// where the meter moved, and a meter that only climbs books each step as it read.
fn stretch_rises(rows: &[Row], from_ms: f64, from_pct: f64) -> Vec<(f64, f64, f64)> {
    let (mut high_ms, mut high) = (from_ms, from_pct);
    let mut rises = Vec::new();
    for row in rows {
        if row.used_pct > high {
            rises.push((high_ms, row.ts, row.used_pct - high));
            (high_ms, high) = (row.ts, row.used_pct);
        }
    }
    rises
}

/// The points of a covered rise that a finer meter puts outside Mixdog and leaves unattributed over the same time, in
/// proportion to the finer points that overlap it.
fn finer_split(interval: &Interval, finer: &[Interval]) -> (f64, f64) {
    let (mut total, mut outside, mut unattributed) = (0.0, 0.0, 0.0);
    for rise in finer {
        let part = rise.points * interval_share(rise, interval.from_ms, interval.to_ms);
        if !(part > 0.0) {
            continue;
        }
        total += part;
        outside += part * rise.external / rise.points;
        unattributed += part * rise.unattributed / rise.points;
    }
    if total > 0.0 { (interval.points * outside / total, interval.points * unattributed / total) } else { (0.0, 0.0) }
}

/// The points of an interval that are not Mixdog's: outside use, with its value, and unattributed points, which have
/// none.
#[derive(Clone, Copy, Debug)]
struct Outside {
    from_ms: f64,
    to_ms: f64,
    points: f64,
    unattributed: f64,
    cost_usd: Option<f64>,
}

/// What one meter rise credits one record: the part of the record that ran in the rise, the stretch
/// it ran over, and the points of the rise that are its share.
#[derive(Clone, Copy, Debug)]
struct Piece {
    event: usize,
    from_ms: f64,
    to_ms: f64,
    fraction: f64,
    share: f64,
}

/// How many records stand behind these rises.
fn covering_records(intervals: &[&Interval], events: &[Event]) -> usize {
    let mut seen: HashSet<usize> = HashSet::new();
    for interval in intervals {
        for index in interval.start..interval.end {
            if events[index].fraction_in(interval.from_ms, interval.to_ms) > 0.0 {
                seen.insert(index);
            }
        }
    }
    seen.len()
}

/// Each shown window's rises split among the records that ran in them, and the points that are not Mixdog's. A record
/// that spans rises appears once per rise, with the part of it in that rise, and once per stretch of its run no rise
/// covers. The dollar value is the covered priced cost over the points it moved, continuing from the earlier windows;
/// unattributed points have none.
fn allocate_quota(all: &mut [Instance], instances: &[usize], events: &[Event], finer: &[Interval], listed: &[usize]) -> (Vec<Piece>, Vec<Outside>) {
    let mut pieces: Vec<Piece> = Vec::new();
    let mut covered: Vec<Vec<(f64, f64)>> = vec![Vec::new(); events.len()];
    let mut outside: Vec<Outside> = Vec::new();
    let mut calibration: HashMap<usize, Vec<Interval>> = HashMap::new();
    for &index in instances {
        let earlier = earlier_windows(all, listed, index);
        let mut prior: Vec<Interval> = Vec::new();
        for window in earlier {
            let held = calibration.entry(window).or_insert_with(|| window_intervals(&all[window], events, finer));
            prior.extend(held.iter().cloned());
        }
        let intervals = window_intervals(&all[index], events, finer);
        let evidence: Vec<&Interval> = prior.iter().chain(&intervals).filter(|i| is_value_evidence(i)).collect();
        let estimate = quota_value(&evidence, covering_records(&evidence, events));
        let value = estimate.clone().filter(|e| e.samples >= MIN_VALUE_SAMPLES);
        let instance = &mut all[index];
        instance.outside = 0.0;
        instance.outside_cost_usd = 0.0;
        instance.outside_unpriced = 0.0;
        instance.unattributed = 0.0;
        for interval in &intervals {
            let (external, unattributed) = (interval.external, interval.unattributed);
            if interval.total > 0.0 {
                for event_index in interval.start..interval.end {
                    let event = &events[event_index];
                    let fraction = event.fraction_in(interval.from_ms, interval.to_ms);
                    if fraction <= 0.0 {
                        continue;
                    }
                    let (from_ms, to_ms) = event.run_in(interval.from_ms, interval.to_ms);
                    covered[event_index].push((from_ms, to_ms));
                    let share = ((interval.points - external - unattributed) * fraction * event.weight(interval.weight)) / interval.total;
                    pieces.push(Piece { event: event_index, from_ms, to_ms, fraction, share });
                }
            }
            if external > 0.0 || unattributed > 0.0 {
                let cost_usd = value.as_ref().map(|v| external * v.cost_per_percent);
                outside.push(Outside { from_ms: interval.from_ms, to_ms: interval.to_ms, points: external, unattributed, cost_usd });
                instance.outside += external;
                instance.unattributed += unattributed;
                match cost_usd {
                    None => instance.outside_unpriced += external,
                    Some(c) => instance.outside_cost_usd += c,
                }
            }
        }
        instance.intervals = intervals;
        instance.estimate = estimate;
        instance.value = value;
    }
    // The stretches of a record that ran where no shown rise did are still its usage, with no share.
    for (index, ranges) in covered.iter_mut().enumerate() {
        for (from_ms, to_ms, fraction) in events[index].uncovered(ranges) {
            pieces.push(Piece { event: index, from_ms, to_ms, fraction, share: 0.0 });
        }
    }
    (pieces, outside)
}

/// The meters finer than a coarse series, in the order they are tried: a weekly series' five-hour
/// companion; a monthly series' five-hour, else weekly. A model-scope suffix is kept.
fn finer_labels(label: &str) -> Vec<String> {
    let (head, suffix) = label.split_once(' ').map_or((label, String::new()), |(head, rest)| (head, format!(" {rest}")));
    match head {
        "7D" => vec![format!("5H{suffix}")],
        "M" => vec![format!("5H{suffix}"), format!("7D{suffix}")],
        _ => Vec::new(),
    }
}

/// The windows of the finer meter of a coarse series that were open in (from_ms, to_ms].
fn finer_windows(conn: &Connection, selection: &Selection, from_ms: f64, to_ms: f64, now: f64) -> Result<Vec<Instance>> {
    for label in finer_labels(&selection.label) {
        let rows = read_quota_rows(conn, selection, &label)?;
        if rows.is_empty() {
            continue;
        }
        return Ok(quota_instances(&rows, &label, now).into_iter().filter(|i| !i.idle && i.end_ms > from_ms && i.start_ms < to_ms).collect());
    }
    Ok(Vec::new())
}

/// The records of the series' windows in (from_ms, to_ms], and the rises of its finer meter there, each with the
/// records behind it; a finer rise no record covers is use that did not come through Mixdog. The records are read over
/// the finer windows whole, so a finer rise that began before the range or ended after it is judged by every record
/// that ran in it.
fn read_records_and_finer_rises(conn: &Connection, selection: &Selection, from_ms: f64, to_ms: f64, now: f64) -> Result<(Vec<Event>, Vec<Interval>)> {
    let windows = finer_windows(conn, selection, from_ms, to_ms, now)?;
    let from = windows.iter().fold(from_ms, |m, w| min(m, w.start_ms));
    let to = windows.iter().fold(to_ms, |m, w| max(m, w.end_ms));
    let events = read_quota_events(conn, selection, from, to)?;
    let finer = windows.iter().flat_map(|w| window_intervals(w, &events, &[])).collect();
    Ok((events, finer))
}

fn interval_share(interval: &Interval, from_ms: f64, to_ms: f64) -> f64 {
    if interval.to_ms <= interval.from_ms {
        return if interval.to_ms >= from_ms && interval.to_ms <= to_ms { 1.0 } else { 0.0 };
    }
    max(0.0, min(interval.to_ms, to_ms) - max(interval.from_ms, from_ms)) / (interval.to_ms - interval.from_ms)
}

/// A period spanning different capacities averages by observed quota, not dollars. A missing
/// calibration must not silently stand in as zero.
fn period_quota_rate(instances: &[&Instance], from_ms: f64, to_ms: f64) -> Option<f64> {
    let (mut value, mut points) = (0.0, 0.0);
    for instance in instances {
        for interval in &instance.intervals {
            let part = interval.points * interval_share(interval, from_ms, to_ms);
            if !(part > 0.0) {
                continue;
            }
            let Some(v) = &instance.value else {
                return None;
            };
            value += part * v.cost_per_percent;
            points += part;
        }
    }
    (points > 0.0).then(|| round_to(value / points, 6))
}

fn rounded_cost(value: f64) -> Value {
    js_number(round_to(value, 6))
}

fn put_cost_fields(out: &mut Map<String, Value>, cost_usd: f64, outside_cost_usd: Option<f64>, unpriced: bool) {
    let extra = outside_cost_usd.map(|c| round_to(c, 6));
    let recorded = round_to(cost_usd, 6);
    out.insert("costUsd".into(), js_number(recorded));
    out.insert("outsideCostUsd".into(), extra.map_or(Value::Null, js_number));
    out.insert(
        "estimatedTotalCostUsd".into(),
        match extra {
            Some(e) if !unpriced => js_number(round_to(recorded + e, 6)),
            _ => Value::Null,
        },
    );
}

#[derive(Clone, Default)]
struct Usage {
    consumed: f64,
    turns: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    cost_usd: f64,
    cost_known_turns: f64,
    unmeasured_turns: f64,
    speed_output: f64,
    speed_ms: f64,
}

impl Usage {
    /// part of the record's usage and share points of the meter.
    fn add(&mut self, event: &Event, share: f64, part: f64) {
        self.consumed += share;
        self.turns += event.turns * part;
        self.input += event.input * part;
        self.output += event.output * part;
        self.cache_read += event.cache_read * part;
        self.cache_write += event.cache_write * part;
        self.cost_usd += event.cost_usd * part;
        self.cost_known_turns += event.cost_known_turns * part;
        self.unmeasured_turns += event.unmeasured_turns * part;
        self.speed_output += event.speed_output * part;
        self.speed_ms += event.speed_ms * part;
    }

    fn tokens(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// Route-shaped totals, so the token table's cells render them unchanged.
fn export_usage(usage: &Usage) -> Map<String, Value> {
    let prompt = usage.input + usage.cache_read + usage.cache_write;
    let unknown = usage.unmeasured_turns > 0.0 && usage.unmeasured_turns == usage.turns;
    let nullable = |v: f64| if unknown { Value::Null } else { js_number(v) };
    let mut out = Map::new();
    out.insert("consumed".into(), js_number(round_to(usage.consumed, 2)));
    out.insert("turns".into(), js_number(usage.turns));
    out.insert("input".into(), nullable(usage.input));
    out.insert("output".into(), js_number(usage.output));
    out.insert("cacheRead".into(), nullable(usage.cache_read));
    out.insert("cacheWrite".into(), nullable(usage.cache_write));
    out.insert("tokens".into(), js_number(usage.tokens()));
    out.insert("unmeasuredTurns".into(), js_number(usage.unmeasured_turns));
    out.insert("costUsd".into(), rounded_cost(usage.cost_usd));
    out.insert("costUnpricedTurns".into(), js_number(max(0.0, usage.turns - usage.cost_known_turns)));
    out.insert("cacheHitRate".into(), if unknown || prompt <= 0.0 { Value::Null } else { js_number(round_to(usage.cache_read / prompt, 4)) });
    out.insert(
        "outputTokensPerSecond".into(),
        if usage.speed_ms > 0.0 { js_number(round_to((usage.speed_output * 1000.0) / usage.speed_ms, 1)) } else { Value::Null },
    );
    out
}

/// `modelId` is the model itself when the grouping key includes a tier suffix.
fn put_identity(out: &mut Map<String, Value>, key: &str) {
    let (model, tier) = SpeedTier::split_key(key);
    tier.put_fields(out);
    if tier != SpeedTier::Standard {
        out.insert("modelId".into(), model.to_string().into());
    }
}

fn model_of_row(row: &Value) -> String {
    row.get("modelId").or_else(|| row.get("model")).and_then(Value::as_str).unwrap_or("").to_string()
}

fn export_model(key: &str, usage: &Usage) -> Value {
    let mut out = Map::new();
    out.insert("model".into(), key.to_string().into());
    put_identity(&mut out, key);
    out.extend(export_usage(usage));
    Value::Object(out)
}

fn window_period(all: &[Instance], listed: &[usize], anchor: Option<&str>) -> Option<Value> {
    if listed.is_empty() {
        return None;
    }
    let index = anchor.and_then(|a| listed.iter().position(|&i| all[i].key == a)).unwrap_or(listed.len() - 1);
    let instance = &all[listed[index]];
    let mut out = Map::new();
    out.insert("view".into(), "window".into());
    out.insert("anchor".into(), instance.key.clone().into());
    out.insert("fromMs".into(), js_number(instance.start_ms));
    out.insert("toMs".into(), js_number(instance.end_ms));
    out.insert("startDay".into(), day_key(instance.start_ms as i64).into());
    out.insert("endDay".into(), day_key(instance.end_ms as i64).into());
    out.insert("previousAnchor".into(), index.checked_sub(1).map_or(Value::Null, |p| all[listed[p]].key.clone().into()));
    out.insert("nextAnchor".into(), listed.get(index + 1).map_or(Value::Null, |&n| all[n].key.clone().into()));
    out.insert("isCurrent".into(), instance.current.into());
    Some(Value::Object(out))
}

/// How fast the open window is being used, and where that pace ends it. The pace is read over
/// the last fifth of the window (half an hour to a day).
fn forecast_for(instance: Option<&Instance>, points: &[Point]) -> Value {
    let Some(instance) = instance else {
        return Value::Null;
    };
    let Some(reset_at) = instance.reset_at else {
        return Value::Null;
    };
    if !instance.current || instance.last_pct >= 100.0 {
        return Value::Null;
    }
    let span = if instance.paced { Some(reset_at - instance.start_ms) } else { None };
    let lookback = min(
        24.0 * HOUR,
        max(
            30.0 * MINUTE,
            match span {
                Some(s) if s != 0.0 => s / 5.0,
                _ => HOUR,
            },
        ),
    );
    let from = max(instance.start_ms, instance.last_at - lookback);
    let hours = (instance.last_at - from) / HOUR;
    if hours < 5.0 / 60.0 {
        return Value::Null;
    }
    let rate = max(0.0, (instance.last_pct - value_at(points, from)) / hours);
    let runs_out = if rate > 0.0 { instance.last_at + ((100.0 - instance.last_pct) / rate) * HOUR } else { f64::INFINITY };
    let before_reset = runs_out < reset_at;
    let mut out = Map::new();
    out.insert("ratePerHour".into(), js_number(round_to(rate, 2)));
    out.insert("fromMs".into(), js_number(instance.last_at));
    out.insert("fromPct".into(), js_number(instance.last_pct));
    out.insert("exhaustAt".into(), if before_reset { js_number(round(runs_out)) } else { Value::Null });
    out.insert(
        "atResetPct".into(),
        if before_reset { Value::Null } else { js_number(round_to(instance.last_pct + (rate * (reset_at - instance.last_at)) / HOUR, 1)) },
    );
    Value::Object(out)
}

struct Slot {
    from_ms: f64,
    to_ms: f64,
    future: bool,
    usage: Usage,
    models: Ordered<Usage>,
    outside: f64,
    outside_cost_usd: f64,
    outside_unpriced: f64,
    unattributed: f64,
}

/// A layer of the by-model chart: a model's share, outside use, or the points the readings cannot assign.
enum Layer {
    Model(String),
    Outside,
    Unattributed,
}

impl Layer {
    fn part(&self, slot: &Slot) -> f64 {
        match self {
            Layer::Model(key) => slot.models.get(key).map_or(0.0, |u| u.consumed),
            Layer::Outside => slot.outside,
            Layer::Unattributed => slot.unattributed,
        }
    }
}

/// Each layer's running share of its window, sampled at slot ends; the slot running now is
/// sampled at now, as far as it has run. A layer that is not a model has an empty key and names its `part`.
fn model_series(slots: &[Slot], instances: &[&Instance], layers: &[Layer], now: f64) -> Vec<Value> {
    let mut series: Vec<Vec<Value>> = vec![Vec::new(); layers.len()];
    let mut running = vec![0.0; layers.len()];
    let mut owner: Option<Option<usize>> = None;
    for slot in slots {
        if slot.future {
            break;
        }
        let instance = instances.iter().position(|entry| slot.from_ms >= entry.start_ms && slot.from_ms < entry.end_ms);
        if owner != Some(instance) {
            owner = Some(instance);
            for (points, total) in series.iter_mut().zip(&mut running) {
                *total = 0.0;
                points.push(Value::Array(vec![js_number(slot.from_ms), 0.into()]));
            }
        }
        for ((layer, points), total) in layers.iter().zip(&mut series).zip(&mut running) {
            *total += layer.part(slot);
            points.push(Value::Array(vec![js_number(min(slot.to_ms, now)), js_number(round_to(*total, 2))]));
        }
    }
    layers
        .iter()
        .zip(series)
        .map(|(layer, points)| {
            let mut out = Map::new();
            match layer {
                Layer::Model(key) => {
                    out.insert("key".into(), key.clone().into());
                    put_identity(&mut out, key);
                }
                Layer::Outside => {
                    out.insert("key".into(), "".into());
                    out.insert("part".into(), "outside".into());
                }
                Layer::Unattributed => {
                    out.insert("key".into(), "".into());
                    out.insert("part".into(), "unattributed".into());
                }
            }
            out.insert("points".into(), Value::Array(points));
            Value::Object(out)
        })
        .collect()
}

/// Outside and unattributed usage is spread over the time its interval covers; returns their totals within the domain.
fn spread_outside_usage(outside: &[Outside], slots: &mut [Slot], domain_from: f64, domain_to: f64, slot_ms: f64) -> (f64, f64) {
    let slot_at = |time: f64, len: usize| min((len - 1) as f64, max(0.0, ((time - domain_from) / slot_ms).floor())) as usize;
    let mut total = (0.0, 0.0);
    let add = |slot: &mut Slot, interval: &Outside, share: f64, total: &mut (f64, f64)| {
        let part = interval.points * share;
        slot.outside += part;
        slot.unattributed += interval.unattributed * share;
        match interval.cost_usd {
            None => slot.outside_unpriced += part,
            Some(c) => slot.outside_cost_usd += c * share,
        }
        total.0 += part;
        total.1 += interval.unattributed * share;
    };
    let len = slots.len();
    for interval in outside {
        let from = max(interval.from_ms, domain_from);
        let to = min(interval.to_ms, domain_to);
        if interval.to_ms <= interval.from_ms {
            if interval.to_ms < domain_from || interval.to_ms > domain_to {
                continue;
            }
            add(&mut slots[slot_at(interval.to_ms, len)], interval, 1.0, &mut total);
            continue;
        }
        let mut index = slot_at(from, len);
        while index < len && slots[index].from_ms < to {
            let overlap = min(to, slots[index].to_ms) - max(from, slots[index].from_ms);
            if overlap > 0.0 {
                add(&mut slots[index], interval, overlap / (interval.to_ms - interval.from_ms), &mut total);
            }
            index += 1;
        }
    }
    total
}

fn history_row(instance: &Instance, events: &[Event]) -> Value {
    let longest_run = events.iter().fold(0.0, |m, e| max(m, e.span_ms));
    let start = first_after(events, instance.start_ms);
    let end = first_after(events, instance.end_ms + longest_run);
    let (mut tokens, mut turns, mut cost_usd, mut unpriced) = (0.0, 0.0, 0.0, 0.0);
    for event in &events[start..end] {
        let part = event.fraction_in(instance.start_ms, instance.end_ms);
        tokens += part * event.tokens;
        turns += part * event.turns;
        cost_usd += part * event.cost_usd;
        unpriced += part * (event.turns - event.cost_known_turns);
    }
    let mut out = Map::new();
    out.insert("key".into(), instance.key.clone().into());
    out.insert("startMs".into(), js_number(instance.start_ms));
    out.insert("endMs".into(), js_number(instance.end_ms));
    out.insert("resetAt".into(), instance.reset_at.map_or(Value::Null, js_number));
    out.insert("peak".into(), js_number(instance.peak));
    out.insert("peakAt".into(), js_number(instance.peak_at));
    out.insert("exhaustedAt".into(), instance.exhausted_at.map_or(Value::Null, js_number));
    out.insert("current".into(), instance.current.into());
    out.insert("tokens".into(), js_number(tokens));
    out.insert("turns".into(), js_number(turns));
    put_cost_fields(&mut out, cost_usd, (instance.value.is_some() && instance.outside_unpriced == 0.0).then_some(instance.outside_cost_usd), unpriced > 0.0);
    out.insert("costPerPercent".into(), instance.value.as_ref().map_or(Value::Null, |v| js_number(round_to(v.cost_per_percent, 6))));
    out.insert("estimateSamples".into(), instance.estimate.as_ref().map_or(0, |e| e.samples).into());
    out.insert("outside".into(), js_number(round_to(instance.outside, 2)));
    out.insert("unattributed".into(), js_number(round_to(instance.unattributed, 2)));
    Value::Object(out)
}

/// What a quota history question names.
#[derive(Clone, Debug, Default)]
pub struct QuotaHistoryQuery {
    pub provider: String,
    pub account: String,
    pub label: String,
    /// provider -> the account its pool has in use.
    pub in_use: BTreeMap<String, String>,
    /// `window` (the default) or a statistics view.
    pub view: String,
    pub anchor: Option<String>,
    pub from_ms: Option<f64>,
    pub to_ms: Option<f64>,
}

fn series_value(series: &[Series]) -> Value {
    Value::Array(
        series
            .iter()
            .map(|s| {
                let mut out = Map::new();
                out.insert("provider".into(), s.provider.clone().into());
                out.insert("account".into(), s.account.clone().into());
                out.insert("windows".into(), Value::Array(s.windows.iter().cloned().map(Value::from).collect()));
                Value::Object(out)
            })
            .collect(),
    )
}

fn focus_value(f: &Instance) -> Value {
    let mut o = Map::new();
    o.insert("startMs".into(), js_number(f.start_ms));
    o.insert("endMs".into(), js_number(f.end_ms));
    o.insert("resetAt".into(), f.reset_at.map_or(Value::Null, js_number));
    o.insert("usedPct".into(), js_number(f.last_pct));
    o.insert("readAt".into(), js_number(f.last_at));
    o.insert("peak".into(), js_number(f.peak));
    o.insert("exhaustedAt".into(), f.exhausted_at.map_or(Value::Null, js_number));
    o.insert("current".into(), f.current.into());
    // Whether the window's opening is known, so an even pace can be drawn.
    o.insert("paced".into(), f.paced.into());
    Value::Object(o)
}

fn slot_value(slot: &Slot, points: &[Point], last_point: f64, shown: &[&Instance]) -> Value {
    let mut o = Map::new();
    o.insert("fromMs".into(), js_number(slot.from_ms));
    o.insert("toMs".into(), js_number(slot.to_ms));
    o.insert("future".into(), slot.future.into());
    o.insert("startPct".into(), js_number(value_at(points, slot.from_ms)));
    o.insert("endPct".into(), js_number(value_at(points, min(slot.to_ms, last_point))));
    o.insert("consumed".into(), js_number(round_to(slot.usage.consumed + slot.outside + slot.unattributed, 2)));
    o.insert("outside".into(), js_number(round_to(slot.outside, 2)));
    o.insert("unattributed".into(), js_number(round_to(slot.unattributed, 2)));
    o.insert("tokens".into(), js_number(slot.usage.tokens()));
    o.insert("turns".into(), js_number(slot.usage.turns));
    let slot_rate = period_quota_rate(shown, slot.from_ms, slot.to_ms);
    put_cost_fields(
        &mut o,
        slot.usage.cost_usd,
        if slot_rate.is_none() || slot.outside_unpriced > 0.0 { None } else { Some(slot.outside_cost_usd) },
        slot.usage.cost_known_turns < slot.usage.turns,
    );
    let mut slot_models: Vec<Value> = slot
        .models
        .iter()
        .map(|(model, usage)| {
            let mut m = Map::new();
            m.insert("model".into(), model.clone().into());
            put_identity(&mut m, model);
            m.insert("consumed".into(), js_number(round_to(usage.consumed, 2)));
            m.insert("tokens".into(), js_number(usage.tokens()));
            m.insert("costUsd".into(), rounded_cost(usage.cost_usd));
            Value::Object(m)
        })
        .collect();
    sort_model_tiers(&mut slot_models, model_of_row, &["consumed", "tokens"]);
    o.insert("models".into(), Value::Array(slot_models));
    Value::Object(o)
}

/// The history of one limit window over a period: the meter's path, who moved it (per model and
/// hover slot), where each window in it peaked and, for the open window, where the current pace
/// ends it. `view: window` selects one window (the latest, or `anchor`); any other view reads
/// [from_ms, to_ms]. The list of every window is read a page at a time ([`read_quota_windows`]).
pub(crate) fn read_quota_history(conn: &Connection, query: &QuotaHistoryQuery, now: i64) -> Result<Value> {
    let now = now as f64;
    let view = if query.view.is_empty() { "window" } else { query.view.as_str() };
    let subscriptions = list_quota_series(conn)?;
    let selection = pick_selection(&subscriptions, &query.provider, &query.account, &query.label, &query.in_use);
    let mut base = Map::new();
    base.insert("generatedAt".into(), js_number(now));
    base.insert("view".into(), view.to_string().into());
    base.insert("subscriptions".into(), series_value(&subscriptions));
    base.insert("selection".into(), selection.as_ref().map_or(Value::Null, Selection::to_value));
    let Some(selection) = selection else {
        base.insert("period".into(), Value::Null);
        return Ok(Value::Object(base));
    };
    let rows = read_quota_rows(conn, &selection, &selection.label)?;
    let mut instances = quota_instances(&rows, &selection.label, now);
    let listed: Vec<usize> = (0..instances.len()).filter(|&i| !instances[i].idle).collect();
    let mut range = Map::new();
    range.insert("firstDay".into(), day_key(rows[0].ts as i64).into());
    let Some((period, period_from, period_to)) = history_period(query, view, &instances, &listed, now) else {
        base.insert("range".into(), Value::Object(range));
        base.insert("period".into(), Value::Null);
        return Ok(Value::Object(base));
    };

    let domain_from = if period_from > 0.0 { period_from } else { rows[0].ts };
    let domain_to = max(period_to, domain_from + MINUTE);
    let overlapping = |i: &Instance| i.end_ms > domain_from && i.start_ms < domain_to;
    let shown: Vec<usize> = (0..instances.len()).filter(|&i| overlapping(&instances[i])).collect();
    let calibrated = calibrated_windows(&instances, &listed, &shown);
    let from = calibrated.iter().fold(domain_from, |m, &i| min(m, instances[i].start_ms));
    let to = shown.iter().fold(domain_to, |m, &i| max(m, instances[i].end_ms));
    let (events, finer) = read_records_and_finer_rises(conn, &selection, from, to, now)?;
    let (pieces, outside) = allocate_quota(&mut instances, &shown, &events, &finer, &listed);
    let shown_refs: Vec<&Instance> = shown.iter().map(|&i| &instances[i]).collect();
    let points = quota_points(&shown_refs);

    let (mut slots, slot_ms) = quota_slots(domain_from, domain_to, now);
    let (totals, models) = fold_events_into_slots(&events, &pieces, &mut slots, domain_from, domain_to, slot_ms);
    let (outside_total, unattributed_total) = spread_outside_usage(&outside, &mut slots, domain_from, domain_to, slot_ms);
    let cost_per_percent = period_quota_rate(&shown_refs, domain_from, domain_to);
    let outside_cost_usd = if cost_per_percent.is_none() || slots.iter().any(|s| s.outside_unpriced > 0.0) {
        None
    } else {
        Some(slots.iter().fold(0.0, |sum, s| sum + s.outside_cost_usd))
    };

    let mut exported_models: Vec<Value> = models.iter().map(|(key, usage)| export_model(key, usage)).collect();
    sort_model_tiers(&mut exported_models, model_of_row, &["consumed", "tokens"]);
    let mut layers: Vec<Layer> = exported_models
        .iter()
        .filter(|m| m["consumed"].as_f64().unwrap_or(0.0) > 0.0)
        .take(SERIES_LIMIT)
        .map(|m| Layer::Model(m["model"].as_str().unwrap_or("").to_string()))
        .collect();
    if outside_total > 0.0 {
        layers.push(Layer::Outside);
    }
    if unattributed_total > 0.0 {
        layers.push(Layer::Unattributed);
    }
    let last_point = points.last().map_or(domain_from, |p| p.at);
    let peaks: Vec<&Instance> = listed.iter().map(|&i| &instances[i]).filter(|i| overlapping(i)).collect();
    let focus = if view == "window" {
        let anchor = period.get("anchor").and_then(Value::as_str).unwrap_or("");
        listed.iter().map(|&i| &instances[i]).find(|i| i.key == anchor)
    } else {
        None
    };

    let mut out = base;
    out.insert("range".into(), Value::Object(range));
    out.insert("period".into(), period);
    let mut domain = Map::new();
    domain.insert("fromMs".into(), js_number(domain_from));
    domain.insert("toMs".into(), js_number(domain_to));
    out.insert("domain".into(), Value::Object(domain));
    let forecast = forecast_for(focus, &points);
    out.insert(
        "points".into(),
        Value::Array(
            decimate(points.clone(), domain_from, domain_to).iter().map(|p| Value::Array(vec![js_number(p.at), js_number(p.percent), p.kind.into()])).collect(),
        ),
    );
    out.insert("focus".into(), focus.map_or(Value::Null, focus_value));
    out.insert("forecast".into(), forecast);
    let mut summary = Map::new();
    summary.insert("consumed".into(), js_number(round_to(totals.consumed + outside_total + unattributed_total, 2)));
    summary.insert("outside".into(), js_number(round_to(outside_total, 2)));
    summary.insert("unattributed".into(), js_number(round_to(unattributed_total, 2)));
    put_cost_fields(&mut summary, totals.cost_usd, outside_cost_usd, totals.cost_known_turns < totals.turns);
    summary.insert("costPerPercent".into(), cost_per_percent.map_or(Value::Null, js_number));
    summary.insert("estimateSamples".into(), shown_refs.iter().fold(0usize, |sum, i| sum + i.estimate.as_ref().map_or(0, |e| e.samples)).into());
    summary.insert("maxedOut".into(), peaks.iter().filter(|i| i.exhausted_at.is_some_and(|e| e >= domain_from && e <= domain_to)).count().into());
    out.insert("summary".into(), Value::Object(summary));
    out.insert("totals".into(), Value::Object(export_usage(&totals)));
    out.insert("outside".into(), js_number(round_to(outside_total, 2)));
    out.insert("unattributed".into(), js_number(round_to(unattributed_total, 2)));
    out.insert("models".into(), Value::Array(exported_models));
    out.insert("slotMs".into(), js_number(slot_ms));
    let slot_values: Vec<Value> = slots.iter().map(|slot| slot_value(slot, &points, last_point as f64, &shown_refs)).collect();
    out.insert("slots".into(), Value::Array(slot_values));
    out.insert("modelSeries".into(), Value::Array(model_series(&slots, &shown_refs, &layers, now)));
    out.insert("peaks".into(), Value::Array(if view == "window" { Vec::new() } else { peak_values(&peaks) }));
    Ok(Value::Object(out))
}

/// The period a history question covers and its bounds (from, to]: the window `view: window` selects, or the
/// statistics period [from_ms, to_ms].
fn history_period(query: &QuotaHistoryQuery, view: &str, instances: &[Instance], listed: &[usize], now: f64) -> Option<(Value, f64, f64)> {
    if view == "window" {
        window_period(instances, listed, query.anchor.as_deref()).map(|p| {
            let from = p["fromMs"].as_f64().unwrap_or(0.0);
            let to = p["toMs"].as_f64().unwrap_or(0.0);
            (p, from, to)
        })
    } else {
        let mut p = Map::new();
        p.insert("view".into(), view.to_string().into());
        p.insert("fromMs".into(), query.from_ms.map_or(Value::Null, js_number));
        p.insert("toMs".into(), query.to_ms.map_or(Value::Null, js_number));
        // A statistics period never reaches past now: its `toMs` is now, or the last millisecond of a range that ended
        // earlier, which as a range (from, to] ends one past it.
        Some((Value::Object(p), query.from_ms.unwrap_or(0.0), query.to_ms.map_or(0.0, |to| min(to + 1.0, now))))
    }
}

/// Equal slots over the domain, and their width.
fn quota_slots(domain_from: f64, domain_to: f64, now: f64) -> (Vec<Slot>, f64) {
    let span = domain_to - domain_from;
    let slot_ms = SLOT_MINUTES.iter().map(|m| m * MINUTE).find(|size| span / size <= MAX_SLOTS).unwrap_or_else(|| (span / MAX_SLOTS).ceil());
    let mut slots: Vec<Slot> = Vec::new();
    let mut start = domain_from;
    while start < domain_to {
        slots.push(Slot {
            from_ms: start,
            to_ms: min(start + slot_ms, domain_to),
            future: start >= now,
            usage: Usage::default(),
            models: Ordered::default(),
            outside: 0.0,
            outside_cost_usd: 0.0,
            outside_unpriced: 0.0,
            unattributed: 0.0,
        });
        start += slot_ms;
    }
    (slots, slot_ms)
}

/// Each piece of a record, added to the slots its run covers and to the totals of the domain and of
/// its model: a record spanning several rises or slots gives each the part that ran there.
fn fold_events_into_slots(events: &[Event], pieces: &[Piece], slots: &mut [Slot], domain_from: f64, domain_to: f64, slot_ms: f64) -> (Usage, Ordered<Usage>) {
    let last_slot = (slots.len() - 1) as f64;
    let slot_at = |time: f64| min(last_slot, max(0.0, ((time - domain_from) / slot_ms).floor())) as usize;
    // A record that ran no time belongs to the range (from, to] its end falls in, as every run does.
    let slot_ending = |time: f64| min(last_slot, max(0.0, ((time - domain_from) / slot_ms).ceil() - 1.0)) as usize;
    let mut totals = Usage::default();
    let mut models: Ordered<Usage> = Ordered::default();
    let mut deposit = |slot: &mut Slot, event: &Event, share: f64, part: f64| {
        totals.add(event, share, part);
        models.entry(&event.model, Usage::default).add(event, share, part);
        slot.usage.add(event, share, part);
        slot.models.entry(&event.model, Usage::default).add(event, share, part);
    };
    for piece in pieces {
        let event = &events[piece.event];
        if piece.to_ms <= piece.from_ms {
            if piece.to_ms > domain_from && piece.to_ms <= domain_to {
                deposit(&mut slots[slot_ending(piece.to_ms)], event, piece.share, piece.fraction);
            }
            continue;
        }
        let (from, to) = (max(piece.from_ms, domain_from), min(piece.to_ms, domain_to));
        let mut index = slot_at(from);
        while index < slots.len() && slots[index].from_ms < to {
            let overlap = min(to, slots[index].to_ms) - max(from, slots[index].from_ms);
            if overlap > 0.0 {
                let part = overlap / (piece.to_ms - piece.from_ms);
                deposit(&mut slots[index], event, piece.share * part, piece.fraction * part);
            }
            index += 1;
        }
    }
    (totals, models)
}

/// A period over several windows marks where each of them peaked.
fn peak_values(peaks: &[&Instance]) -> Vec<Value> {
    peaks
        .iter()
        .map(|i| {
            let mut o = Map::new();
            o.insert("key".into(), i.key.clone().into());
            o.insert("peak".into(), js_number(i.peak));
            o.insert("peakAt".into(), js_number(i.peak_at));
            Value::Object(o)
        })
        .collect()
}

/// What a window-list question names.
#[derive(Clone, Debug, Default)]
pub struct QuotaWindowsQuery {
    pub provider: String,
    pub account: String,
    pub label: String,
    pub in_use: BTreeMap<String, String>,
    pub page: f64,
}

/// One page of a limit window's history, newest first: every window that opened, with its peak,
/// the shape it rose in and what the requests behind it cost. `page` is clamped to the pages
/// there are.
pub(crate) fn read_quota_windows(conn: &Connection, query: &QuotaWindowsQuery, now: i64) -> Result<Value> {
    let now = now as f64;
    let selection = pick_selection(&list_quota_series(conn)?, &query.provider, &query.account, &query.label, &query.in_use);
    let mut base = Map::new();
    base.insert("generatedAt".into(), js_number(now));
    base.insert("selection".into(), selection.as_ref().map_or(Value::Null, Selection::to_value));
    base.insert("page".into(), 0.into());
    base.insert("pageCount".into(), 0.into());
    base.insert("total".into(), 0.into());
    base.insert("windows".into(), Value::Array(Vec::new()));
    let Some(selection) = selection else {
        return Ok(Value::Object(base));
    };
    let mut instances = quota_instances(&read_quota_rows(conn, &selection, &selection.label)?, &selection.label, now);
    let chronological: Vec<usize> = (0..instances.len()).filter(|&i| !instances[i].idle).collect();
    let listed: Vec<usize> = chronological.iter().rev().copied().collect();
    let page_count = listed.len().div_ceil(HISTORY_PAGE_SIZE);
    if page_count == 0 {
        return Ok(Value::Object(base));
    }
    // `Math.floor(page) || 0`, clamped.
    let requested = if query.page.is_finite() { query.page.floor() } else { 0.0 };
    let index = min(max(0.0, requested), (page_count - 1) as f64) as usize;
    let shown: Vec<usize> = listed.iter().skip(index * HISTORY_PAGE_SIZE).take(HISTORY_PAGE_SIZE).copied().collect();
    let calibrated = calibrated_windows(&instances, &chronological, &shown);
    let from = calibrated.iter().fold(f64::INFINITY, |m, &i| min(m, instances[i].start_ms));
    let to = shown.iter().fold(f64::NEG_INFINITY, |m, &i| max(m, instances[i].end_ms));
    let (events, finer) = read_records_and_finer_rises(conn, &selection, from, to, now)?;
    allocate_quota(&mut instances, &shown, &events, &finer, &chronological);
    base.insert("page".into(), index.into());
    base.insert("pageCount".into(), page_count.into());
    base.insert("total".into(), listed.len().into());
    base.insert("windows".into(), Value::Array(shown.iter().map(|&i| history_row(&instances[i], &events)).collect()));
    Ok(Value::Object(base))
}

/// Options of the service-level quota history call (`getQuotaHistory`), as the client sends
/// them.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaHistoryOptions {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
    /// The limit window's label.
    #[serde(default)]
    pub window: Option<String>,
    #[serde(default)]
    pub page: Option<f64>,
    #[serde(default)]
    pub view: Option<String>,
    #[serde(default)]
    pub anchor: Option<String>,
    #[serde(default)]
    pub start_day: Option<String>,
    #[serde(default)]
    pub end_day: Option<String>,
    #[serde(default)]
    pub start_time: Option<String>,
    #[serde(default)]
    pub end_time: Option<String>,
}

/// Request text is cut to 200 UTF-16 units, like the service's `quotaText`.
pub fn quota_text(value: Option<&str>) -> String {
    mixdog_js::slice_utf16(value.unwrap_or(""), 200)
}

/// `getQuotaHistory` over the ledger, before the account service adds its labels: a window
/// list page when `page` is given, else the history of the named window or period.
pub(crate) fn get_quota_history(conn: &Connection, options: &QuotaHistoryOptions, in_use: &BTreeMap<String, String>, now: i64) -> Result<Value> {
    let provider = quota_text(options.provider.as_deref());
    let account = quota_text(options.account.as_deref());
    let label = quota_text(options.window.as_deref());
    if let Some(page) = options.page {
        return read_quota_windows(conn, &QuotaWindowsQuery { provider, account, label, in_use: in_use.clone(), page }, now);
    }
    let view = options.view.clone().filter(|v| v != "window").unwrap_or_else(|| "window".to_string());
    let period = if view == "window" {
        None
    } else {
        Some(resolve_usage_stats_period(
            &PeriodRequest {
                view: Some(view.clone()),
                anchor: options.anchor.clone(),
                start_day: options.start_day.clone(),
                end_day: options.end_day.clone(),
                start_time: options.start_time.clone(),
                end_time: options.end_time.clone(),
            },
            now,
        )?)
    };
    let anchor = quota_text(options.anchor.as_deref());
    let mut history = read_quota_history(
        conn,
        &QuotaHistoryQuery {
            provider,
            account,
            label,
            in_use: in_use.clone(),
            view,
            anchor: (!anchor.is_empty() && period.is_none()).then_some(anchor),
            from_ms: period.as_ref().and_then(|p| p["fromMs"].as_f64()),
            to_ms: period.as_ref().and_then(|p| p["toMs"].as_f64()),
        },
        now,
    )?;
    // The caller's period replaces the thin one the history carries, in the same place.
    if let (Some(period), Some(slot)) = (period, history.get_mut("period")) {
        *slot = period;
    }
    Ok(history)
}

#[cfg(test)]
mod tests {
    use super::*;

    mod recorded;

    const MIN_MS: f64 = 60_000.0;
    const HOUR_MS: f64 = 60.0 * MIN_MS;
    const START: f64 = 1_000.0 * MIN_MS;

    /// A ledger holding a record per (end, duration) on `prov`'s account `acc`, with each record's day ranked.
    fn ledger(records: &[(f64, f64)]) -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::create(&mut conn).unwrap();
        conn.execute("INSERT INTO usage_routes(id,signature) VALUES (1,'[\"prov\",\"m\",\"oauth\",\"cli\",\"subscription\",null,\"live\",0,\"acc\"]')", [])
            .unwrap();
        conn.execute("INSERT INTO usage_sessions(id,value) VALUES (1,'s')", []).unwrap();
        for (index, &(ts, duration)) in records.iter().enumerate() {
            let day = day_key(ts as i64);
            conn.execute("INSERT OR IGNORE INTO daily VALUES (?1,0,'prov','m','live','subscription',0,2,2,2,2,2,2,0,0)", [&day]).unwrap();
            conn.execute(
                "INSERT INTO usage_events VALUES (?1,?2,?3,1,1,1,1,1,0,0.5,?4)",
                rusqlite::params![vec![1u8, index as u8], ts as i64, day.replace('-', "").parse::<i64>().unwrap(), duration],
            )
            .unwrap();
        }
        conn
    }

    fn selection(label: &str) -> Selection {
        Selection { provider: "prov".into(), account: "acc".into(), label: label.into() }
    }

    fn reading(label: &str, rolling: bool, ts: f64, used_pct: f64, reset_at: f64) -> QuotaReading {
        QuotaReading {
            provider: "prov".into(),
            account: "acc".into(),
            label: label.into(),
            rolling,
            sample: QuotaSample { ts: ts as i64, used_pct, reset_at: Some(reset_at as i64) },
        }
    }

    /// What a window's own view folds into its domain: (pieces' totals, the slots).
    fn view(all: &mut [Instance], index: usize, events: &[Event], listed: &[usize]) -> (Usage, Vec<Slot>) {
        let (pieces, _) = allocate_quota(all, &[index], events, &[], listed);
        let (from, to) = (all[index].start_ms, all[index].end_ms);
        let (mut slots, slot_ms) = quota_slots(from, to, START + 120.0 * MIN_MS);
        let (totals, _) = fold_events_into_slots(events, &pieces, &mut slots, from, to, slot_ms);
        (totals, slots)
    }

    fn record(ts: f64, span_ms: f64, cost_usd: f64) -> Event {
        Event {
            ts,
            model: "m".into(),
            turns: 1.0,
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            cost_usd,
            cost_known_turns: 1.0,
            unmeasured_turns: 0.0,
            speed_output: 0.0,
            speed_ms: 0.0,
            tokens: 0.0,
            span_ms,
        }
    }

    fn row(minutes: f64, used_pct: f64) -> Row {
        Row { ts: START + minutes * MIN_MS, until: START + minutes * MIN_MS, used_pct, reset_at: None, rolling: false }
    }

    fn window(rows: Vec<Row>) -> Instance {
        Instance { start_ms: START, end_ms: START + 60.0 * MIN_MS, rows, ..Default::default() }
    }

    #[test]
    fn a_meter_that_dips_and_returns_rises_only_above_its_highest_reading() {
        let instance = window(vec![row(5.0, 20.0), row(10.0, 19.0), row(15.0, 20.0), row(20.0, 21.0)]);
        // A reading no record ran up to is judged with the stretch it is in; these all have one.
        let events = vec![record(START + 20.0 * MIN_MS, 20.0 * MIN_MS, 1.0)];

        let intervals = window_intervals(&instance, &events, &[]);

        let points: Vec<f64> = intervals.iter().map(|i| i.points).collect();
        assert_eq!(points, vec![20.0, 1.0]);
    }

    #[test]
    fn records_running_between_the_highest_reading_and_a_dip_count_in_the_next_rise() {
        let instance = window(vec![row(5.0, 10.0), row(10.0, 9.0), row(15.0, 11.0)]);
        let events = vec![record(START + 10.0 * MIN_MS, 2.0 * MIN_MS, 1.0)];

        let intervals = window_intervals(&instance, &events, &[]);

        assert_eq!(intervals.len(), 2);
        assert_eq!(intervals[1].from_ms, START + 5.0 * MIN_MS);
        assert!(intervals[1].total > 0.0 && intervals[1].external == 0.0, "{:?}", intervals[1]);
    }

    #[test]
    fn a_rolling_meter_counts_its_rise_from_the_previous_reading() {
        let mut instance = window(vec![row(5.0, 20.0), row(10.0, 19.0), row(15.0, 20.0)]);
        instance.rolling = true;

        let points: Vec<f64> = window_intervals(&instance, &[], &[]).iter().map(|i| i.points).collect();

        assert_eq!(points, vec![20.0, 1.0]);
    }

    #[test]
    fn a_long_record_spanning_several_rises_leaves_none_of_them_outside() {
        let instance = window(vec![row(10.0, 1.0), row(20.0, 2.0), row(30.0, 3.0)]);
        let events = vec![record(START + 30.0 * MIN_MS, 30.0 * MIN_MS, 3.0)];

        let intervals = window_intervals(&instance, &events, &[]);

        assert_eq!(intervals.len(), 3);
        for interval in &intervals {
            assert!(interval.total > 0.0, "a rise inside the record's run has no record: {interval:?}");
            assert!((interval.cost_usd - 1.0).abs() < 1e-9, "{interval:?}");
        }
        let mut all = vec![instance];
        let (pieces, outside) = allocate_quota(&mut all, &[0], &events, &[], &[0]);
        assert!(outside.is_empty() && all[0].outside == 0.0);
        let share: f64 = pieces.iter().map(|p| p.share).sum();
        assert!((share - 3.0).abs() < 1e-9, "{pieces:?}");
    }

    #[test]
    fn a_covered_rise_is_not_outside_whatever_its_dollars_per_point() {
        let instance = window(vec![row(10.0, 1.0), row(20.0, 30.0)]);
        let events = vec![record(START + 10.0 * MIN_MS, MIN_MS, 5.0), record(START + 20.0 * MIN_MS, MIN_MS, 0.01)];
        let mut all = vec![instance];

        let (_, outside) = allocate_quota(&mut all, &[0], &events, &[], &[0]);

        assert!(outside.is_empty() && all[0].outside == 0.0, "{outside:?}");
    }

    #[test]
    fn a_weekly_rise_takes_the_outside_share_its_five_hour_companion_shows() {
        let weekly = window(vec![row(60.0, 3.0)]);
        let events = vec![record(START + 30.0 * MIN_MS, 30.0 * MIN_MS, 3.0)];
        // The first five-hour reading is confirmed by a later poll, so the next rise is not its lagged debit.
        let five = window(vec![Row { until: START + 35.0 * MIN_MS, ..row(30.0, 2.0) }, row(60.0, 4.0)]);
        let finer = window_intervals(&five, &events, &[]);
        assert!(finer[0].total > 0.0 && finer[1].total == 0.0);
        let mut all = vec![weekly];

        let (_, outside) = allocate_quota(&mut all, &[0], &events, &finer, &[0]);

        assert!((all[0].outside - 1.5).abs() < 1e-9, "{outside:?}");
        assert!(all[0].intervals[0].external > 0.0 && !is_value_evidence(&all[0].intervals[0]));
    }

    #[test]
    fn a_record_crossing_slots_gives_each_slot_its_share_of_the_rises() {
        let instance = window(vec![row(30.0, 1.0), row(60.0, 2.0)]);
        let events = vec![record(START + 60.0 * MIN_MS, 60.0 * MIN_MS, 2.0)];
        let mut all = vec![instance];
        let (pieces, _) = allocate_quota(&mut all, &[0], &events, &[], &[0]);
        let (mut slots, slot_ms) = quota_slots(START, START + 60.0 * MIN_MS, START + 120.0 * MIN_MS);
        assert!(slots.len() > 1);

        let (totals, _) = fold_events_into_slots(&events, &pieces, &mut slots, START, START + 60.0 * MIN_MS, slot_ms);

        let first_half: f64 = slots.iter().filter(|s| s.to_ms <= START + 30.0 * MIN_MS).map(|s| s.usage.consumed).sum();
        let second_half: f64 = slots.iter().filter(|s| s.from_ms >= START + 30.0 * MIN_MS).map(|s| s.usage.consumed).sum();
        assert!((first_half - 1.0).abs() < 1e-9 && (second_half - 1.0).abs() < 1e-9, "{first_half} {second_half}");
        assert!((totals.consumed - 2.0).abs() < 1e-9 && (totals.turns - 1.0).abs() < 1e-9, "{} {}", totals.consumed, totals.turns);
    }

    #[test]
    fn a_record_across_two_windows_is_split_between_their_rows() {
        let first = Instance { end_ms: START + 30.0 * MIN_MS, ..window(vec![row(30.0, 1.0)]) };
        let second = Instance { start_ms: START + 30.0 * MIN_MS, ..window(vec![row(60.0, 1.0)]) };
        let events = vec![record(START + 60.0 * MIN_MS, 60.0 * MIN_MS, 2.0)];

        let (a, b) = (history_row(&first, &events), history_row(&second, &events));

        assert!((a["turns"].as_f64().unwrap() - 0.5).abs() < 1e-6, "{a}");
        assert!((b["turns"].as_f64().unwrap() - 0.5).abs() < 1e-6, "{b}");
        assert!((a["costUsd"].as_f64().unwrap() - 1.0).abs() < 1e-6, "{a}");
    }

    #[test]
    fn records_of_one_millisecond_keep_their_own_durations() {
        let ts = 1_795_500_000_000.0;
        let conn = ledger(&[(ts, 0.0), (ts, 600_000.0)]);

        let events = read_quota_events(&conn, &selection("5H"), ts - 1.0, ts + 1.0).unwrap();

        let mut spans: Vec<f64> = events.iter().map(|e| e.span_ms).collect();
        spans.sort_by(f64::total_cmp);
        assert_eq!(spans, vec![0.0, 600_000.0]);
    }

    #[test]
    fn the_part_of_a_record_no_rise_covers_stays_where_it_ran() {
        let mut all = vec![window(vec![row(30.0, 1.0)])];
        let events = vec![record(START + 60.0 * MIN_MS, 60.0 * MIN_MS, 2.0)];

        let (totals, slots) = view(&mut all, 0, &events, &[0]);

        let turns: Vec<f64> = slots.iter().map(|s| s.usage.turns).collect();
        assert_eq!(turns, vec![0.5, 0.5], "the uncovered half ran in the second slot");
        assert_eq!((slots[0].usage.consumed, slots[1].usage.consumed, totals.turns), (1.0, 0.0, 1.0));
    }

    #[test]
    fn a_record_across_two_windows_counts_once_across_their_views() {
        let first = Instance { end_ms: START + 30.0 * MIN_MS, ..window(vec![row(30.0, 1.0)]) };
        let second = Instance { start_ms: START + 30.0 * MIN_MS, ..window(vec![row(60.0, 1.0)]) };
        let events = vec![record(START + 60.0 * MIN_MS, 60.0 * MIN_MS, 2.0)];
        let mut all = vec![first, second];

        let turns: Vec<f64> = (0..2).map(|index| view(&mut all, index, &events, &[0, 1]).0.turns).collect();

        assert_eq!(turns, vec![0.5, 0.5]);
    }

    #[test]
    fn a_record_running_past_midnight_is_read_with_the_day_it_ended_on() {
        let midnight = local_ms(chrono::NaiveDate::from_ymd_opt(2026, 11, 24).unwrap().and_hms_opt(0, 0, 0).unwrap()) as f64;
        let conn = ledger(&[(midnight + 5.0 * MIN_MS, 10.0 * MIN_MS)]);

        let events = read_quota_events(&conn, &selection("5H"), midnight - HOUR_MS, midnight - MIN_MS).unwrap();

        assert_eq!(events.len(), 1, "the record ran before midnight");
        assert!((events[0].fraction_in(midnight - HOUR_MS, midnight - MIN_MS) - 0.4).abs() < 1e-9);
    }

    #[test]
    fn a_record_at_the_boundary_of_two_windows_counts_once_across_them() {
        let boundary = START + 30.0 * MIN_MS;
        let first = Instance { end_ms: boundary, ..window(vec![row(30.0, 1.0)]) };
        let second = Instance { start_ms: boundary, ..window(vec![row(60.0, 1.0)]) };
        let at_end = vec![record(boundary, 0.0, 1.0)];
        for events in [at_end.clone(), vec![record(boundary + 1.0, 2.0, 1.0)]] {
            let (a, b) = (history_row(&first, &events), history_row(&second, &events));
            assert_eq!(a["turns"].as_f64().unwrap() + b["turns"].as_f64().unwrap(), 1.0, "{a} {b}");
        }
        assert_eq!(history_row(&first, &at_end)["turns"].as_f64(), Some(1.0), "a record belongs to the range its end is in");
        let mut all = vec![first, second];

        let turns: Vec<f64> = (0..2).map(|index| view(&mut all, index, &at_end, &[0, 1]).0.turns).collect();

        assert_eq!(turns, vec![1.0, 0.0]);
    }

    #[test]
    fn a_finer_rise_is_judged_by_its_records_outside_the_coarse_range() {
        let t0 = 1_795_500_000_000.0;
        // The five-hour window opened two hours before the weekly one; its first rise's record ran before the week.
        let mut conn = ledger(&[(t0 - HOUR_MS, 30.0 * MIN_MS), (t0 + 45.0 * MIN_MS, 10.0 * MIN_MS)]);
        let (five, week) = (t0 + 3.0 * HOUR_MS, t0 + 7.0 * 24.0 * HOUR_MS);
        record_quota_samples(
            &mut conn,
            &[
                reading("5H", false, t0 + 30.0 * MIN_MS, 4.0, five),
                reading("5H", false, t0 + HOUR_MS, 6.0, five),
                reading("7D", false, t0 + HOUR_MS, 1.0, week),
            ],
        )
        .unwrap();
        let query = QuotaWindowsQuery { provider: "prov".into(), account: "acc".into(), label: "7D".into(), in_use: BTreeMap::new(), page: 0.0 };

        let page = read_quota_windows(&conn, &query, (t0 + 2.0 * HOUR_MS) as i64).unwrap();

        assert_eq!(page["windows"][0]["outside"].as_f64(), Some(0.0), "{page}");
    }

    #[test]
    fn a_window_is_rolling_only_when_its_readings_declare_it() {
        let mut conn = ledger(&[]);
        let reset = START + 5.0 * HOUR_MS;
        record_quota_samples(&mut conn, &[reading("W", false, START, 10.0, reset), reading("5H", true, START, 10.0, reset)]).unwrap();
        let rolling = |label: &str| quota_instances(&read_quota_rows(&conn, &selection(label), label).unwrap(), label, START)[0].rolling;

        assert!(!rolling("W"), "Grok Build's weekly window resets");
        assert!(rolling("5H"), "Muse Code's sized window declares itself rolling");
    }

    #[test]
    fn a_value_is_shown_once_it_rests_on_enough_distinct_records_with_the_windows_before() {
        // Ten one-point rises split between two windows, each rise with a record of its own.
        let rises = |from: i32, to: i32, base: i32| (from..=to).map(|i| row(f64::from(i) * 5.0, f64::from(i - base))).collect::<Vec<_>>();
        let earlier = Instance { end_ms: START + 25.0 * MIN_MS, ..window(rises(1, 5, 0)) };
        let later = Instance { start_ms: START + 25.0 * MIN_MS, ..window(rises(6, 10, 5)) };
        let records: Vec<Event> = (1..=10).map(|i| record(START + f64::from(i) * 5.0 * MIN_MS, MIN_MS, 1.0)).collect();
        for (count, shown) in [(9, false), (10, true)] {
            let mut all = vec![earlier.clone(), later.clone()];

            allocate_quota(&mut all, &[1], &records[..count], &[], &[0, 1]);

            assert_eq!(all[1].value.is_some(), shown, "{count} records");
            assert_eq!(all[1].estimate.as_ref().map(|e| e.samples), Some(count));
        }
    }

    #[test]
    fn a_period_ending_now_keeps_its_slots_and_one_that_ended_runs_through_its_last_millisecond() {
        let now = 1_795_500_000_000.0;
        let mut conn = ledger(&[]);
        record_quota_samples(&mut conn, &[reading("5H", false, now - HOUR_MS, 10.0, now + HOUR_MS)]).unwrap();
        let query = |view: &str, from_ms: f64, to_ms: f64| QuotaHistoryQuery {
            provider: "prov".into(),
            account: "acc".into(),
            label: "5H".into(),
            view: view.into(),
            from_ms: Some(from_ms),
            to_ms: Some(to_ms),
            ..QuotaHistoryQuery::default()
        };

        let hour = read_quota_history(&conn, &query("hour", now - 24.0 * HOUR_MS, now), now as i64).unwrap();
        let closed = read_quota_history(&conn, &query("custom", now - 48.0 * HOUR_MS, now - 24.0 * HOUR_MS - 1.0), now as i64).unwrap();

        let slots = hour["slots"].as_array().unwrap();
        assert_eq!((hour["slotMs"].as_f64(), slots.len(), hour["domain"]["toMs"].as_f64()), (Some(30.0 * MIN_MS), 48, Some(now)));
        assert!(slots.iter().all(|s| s["future"] == false), "{slots:?}");
        assert_eq!(closed["domain"]["toMs"].as_f64(), Some(now - 24.0 * HOUR_MS));
    }

    #[test]
    fn the_record_read_is_bounded_on_the_time_index_by_the_longest_run_of_its_routes() {
        use rusqlite::types::Null;
        let conn = ledger(&[]);
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {}", quota_events_sql())).unwrap();

        let plan: Vec<String> =
            stmt.query_map(rusqlite::params![Null, Null, Null, Null, Null], |r| r.get(3)).unwrap().collect::<std::result::Result<_, _>>().unwrap();

        assert!(plan.iter().any(|row| row.starts_with("SEARCH e ") && row.contains("ts>? AND ts<?")), "{plan:?}");
        assert!(plan.iter().any(|row| row.contains("usage_events_route_duration (route=?)")), "{plan:?}");
    }
}
