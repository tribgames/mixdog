//! Subscription quota history (`usage-ledger-quota.mjs`): what a provider's own usage meter
//! read over time, next to the token records that moved it.
//!
//! `quota_samples` keeps one row per distinct reading of one limit window (provider · account ·
//! label). A repeat of the reading only extends `seen_until`, so a row is a value plus the span
//! over which it was confirmed, and the time between rows is time nobody measured. Each rise
//! of the meter is split over the same provider account's token records in its interval by
//! list-price value; a rise with no Mixdog record behind it came from outside Mixdog. The split
//! is an estimate: providers do not publish what a request costs the meter.

#![allow(
    clippy::neg_cmp_op_on_partial_ord,
    reason = "NaN must take the guard's branch"
)]

use std::collections::BTreeMap;
use std::collections::HashMap;

use rusqlite::params;
use serde_json::Map;
use serde_json::Value;

use crate::db::Connection;
use crate::db::OptionalExtension;
use crate::db::TransactionBehavior;
use crate::error::Result;
use crate::measure::FAST_KEY;
use crate::measure::NO_USAGE_COST_SOURCE;
use crate::measure::Ordered;
use crate::measure::fast_route_sql;
use crate::measure::is_unmeasuring_provider;
use crate::measure::js_number;
use crate::measure::round_to;
use crate::measure::sort_fast_beside_model;
use crate::period::PeriodRequest;
use crate::period::resolve_usage_stats_period;
use crate::quota_estimate::Estimate;
use crate::quota_estimate::FinerWindow;
use crate::quota_estimate::Interval;
use crate::quota_estimate::Reading;
use crate::quota_estimate::Span;
use crate::quota_estimate::Weight;
use crate::quota_estimate::estimate_outside_quota;
use crate::quota_estimate::estimate_quota_value;
use crate::quota_estimate::outside_spans;
use crate::time::day_key;
use crate::time::local_fields;
use crate::time::local_ms;
use mixdog_js::math::max;
use mixdog_js::math::min;
use mixdog_js::math::round;

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
// Clean, priced meter rises a window needs before its value is shown in dollars when no
// earlier window anchors it.
const MIN_VALUE_SAMPLES: usize = 10;
// Codex reports its reset as a countdown, so one window's reset drifts by the request latency
// between readings. A later reset, or a meter that fell, opens a new window.
const RESET_TOLERANCE_MS: f64 = 2.0 * MINUTE;
const RESET_DROP_POINTS: f64 = 5.0;
// Readings further apart than this leave the path between them unmeasured.
const MEASURED_GAP_MS: f64 = 20.0 * MINUTE;
// Hover slots: the finest of these sizes that cuts the chart into at most 48.
const SLOT_MINUTES: [f64; 11] = [
    30.0, 60.0, 120.0, 180.0, 360.0, 720.0, 1440.0, 2880.0, 10080.0, 20160.0, 43200.0,
];
const MAX_SLOTS: f64 = 48.0;
const MAX_POINTS: usize = 4000;
// The window history is read a page at a time.
const HISTORY_PAGE_SIZE: usize = 10;
const SERIES_LIMIT: usize = 6;
// Each window's value continues from the windows just before it, back until they hold this
// many quota points (at most this many windows).
const PRIOR_POINTS: f64 = 100.0;
const PRIOR_WINDOWS: usize = 24;
// The by-model chart's series key for usage from outside Mixdog.
const OUTSIDE_KEY: &str = "";
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
    upper
        .strip_prefix(prefix)
        .is_some_and(|rest| !rest.chars().next().is_some_and(is_word))
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
        (
            chrono::Datelike::year(&fields),
            chrono::Datelike::month(&fields) - 1,
        )
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
    pub sample: QuotaSample,
}

struct Latest {
    ts: i64,
    seen_until: i64,
    used_pct: f64,
    reset_at: Option<i64>,
}

fn same_window(previous: &Latest, sample: &QuotaSample) -> bool {
    // An idle meter reads zero against a reset that may keep moving: no window ran.
    if previous.used_pct == 0.0 && sample.used_pct == 0.0 {
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
/// countdown never splits one window. Returns the readings taken.
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
            .query_row(params![key.0, key.1, key.2], |r| {
                Ok(Latest {
                    ts: r.get(0)?,
                    seen_until: r.get(1)?,
                    used_pct: r.get(2)?,
                    reset_at: r.get(3)?,
                })
            })
            .optional()?;
        let sample = &reading.sample;
        // A reading older than the span already confirmed arrived late.
        if previous.as_ref().is_some_and(|p| sample.ts <= p.seen_until) {
            continue;
        }
        let same = previous.as_ref().is_some_and(|p| same_window(p, sample));
        match &previous {
            Some(p) if same && (p.used_pct - sample.used_pct).abs() < 0.005 => {
                tx.prepare_cached(
                    "UPDATE quota_samples SET seen_until=?1 WHERE provider=?2 AND account=?3 AND label=?4 AND ts=?5",
                )?
                .execute(params![sample.ts, key.0, key.1, key.2, p.ts])?;
            }
            _ => {
                let reset = if same {
                    previous.as_ref().and_then(|p| p.reset_at)
                } else {
                    sample.reset_at
                };
                tx.prepare_cached(
                    "INSERT OR IGNORE INTO quota_samples VALUES (?1,?2,?3,?4,?5,?6,?7)",
                )?
                .execute(params![
                    key.0,
                    key.1,
                    key.2,
                    sample.ts,
                    sample.ts,
                    sample.used_pct,
                    reset
                ])?;
            }
        }
        written += 1;
    }
    tx.commit()?;
    Ok(written)
}

/// The next recorded (provider, account, label) after a key: windows are visited by index
/// probes, never by a scan of the samples.
pub const NEXT_SERIES_SQL: &str =
    "SELECT provider,account,label FROM quota_samples WHERE (provider,account,label) > (?1,?2,?3)
         ORDER BY provider,account,label LIMIT 1";
/// When a window's meter last moved.
pub const SERIES_CHANGED_SQL: &str =
    "SELECT MAX(ts) FROM quota_samples WHERE provider=?1 AND account=?2 AND label=?3";
/// Every reading of one window, oldest first.
pub const WINDOW_ROWS_SQL: &str = "SELECT ts,seen_until,used_pct,reset_at FROM quota_samples WHERE provider=?1 AND account=?2 AND label=?3 ORDER BY ts";

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
        let row: Option<(String, String, String)> = next
            .query_row(params![cursor.0, cursor.1, cursor.2], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let Some(row) = row else { break };
        let ts: i64 = changed.query_row(params![row.0, row.1, row.2], |r| r.get(0))?;
        let key = format!("{}\u{0}{}", row.0, row.1);
        let entry = found.entry(&key, || {
            (
                Series {
                    provider: row.0.clone(),
                    account: row.1.clone(),
                    windows: Vec::new(),
                },
                0.0,
            )
        });
        entry.0.windows.push(row.2.clone());
        entry.1 = max(entry.1, ts as f64);
        cursor = row;
    }
    let mut series: Vec<(Series, f64)> = found.values().cloned().collect();
    series.sort_by(|a, b| {
        (b.1 - a.1)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
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
fn pick_selection(
    series: &[Series],
    provider: &str,
    account: &str,
    label: &str,
    in_use: &BTreeMap<String, String>,
) -> Option<Selection> {
    let chosen = if provider.is_empty() {
        series.first()?.provider.clone()
    } else {
        provider.to_string()
    };
    let account_id = if account.is_empty() {
        in_use.get(&chosen).cloned().unwrap_or_default()
    } else {
        account.to_string()
    };
    let entry = series
        .iter()
        .find(|row| row.provider == chosen && row.account == account_id)
        .or_else(|| series.iter().find(|row| row.provider == chosen))
        .or_else(|| series.first())?;
    let wanted = label.to_lowercase();
    let picked = entry
        .windows
        .iter()
        .find(|w| w.to_lowercase() == wanted)
        .or_else(|| entry.windows.iter().find(|w| is_weekly(w)))
        .or_else(|| entry.windows.first())?;
    Some(Selection {
        provider: entry.provider.clone(),
        account: entry.account.clone(),
        label: picked.clone(),
    })
}

#[derive(Clone, Copy, Debug)]
struct Row {
    ts: f64,
    until: f64,
    used_pct: f64,
    reset_at: Option<f64>,
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
    start_ms: f64,
    end_ms: f64,
    outside: f64,
    outside_cost_usd: f64,
    outside_unpriced: f64,
    intervals: Vec<Interval>,
    estimate: Option<Estimate>,
    value: Option<Estimate>,
}

/// Readings grouped into limit windows. A run that never left zero is idle — no window was
/// open — and only fills the measured time between the windows around it.
fn quota_instances(rows: &[Row], label: &str, now: f64) -> Vec<Instance> {
    let mut groups: Vec<Vec<Row>> = Vec::new();
    for row in rows {
        let new_group = match groups.last().and_then(|g| g.last()) {
            None => true,
            Some(previous) => {
                row.reset_at != previous.reset_at
                    || row.used_pct < previous.used_pct - RESET_DROP_POINTS
            }
        };
        if new_group {
            groups.push(Vec::new());
        }
        if let Some(group) = groups.last_mut() {
            group.push(*row);
        }
    }
    let mut instances: Vec<Instance> = groups
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
            Instance {
                key: js_number(first.ts).to_string(),
                reset_at: first.reset_at,
                peak: peak.used_pct,
                peak_at: peak.ts,
                exhausted_at: group.iter().find(|r| r.used_pct >= 100.0).map(|r| r.ts),
                last_pct: last.used_pct,
                last_at: last.until,
                idle: peak.used_pct == 0.0,
                rows: group,
                ..Instance::default()
            }
        })
        .collect();
    // After a reset, early or on time, the meter reads zero until the next request: that last
    // run is the window open now, not a gap between windows.
    let any_active = instances.iter().any(|i| !i.idle);
    if let Some(latest) = instances.last_mut()
        && latest.idle
        && any_active
        && latest.reset_at.is_none_or(|r| r > now)
    {
        latest.idle = false;
    }
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
        let opened = quota_window_opened(label, instance.reset_at);
        instance.paced = opened.is_some();
        instance.start_ms = max(min(opened.unwrap_or(first_ts), first_ts), previous_end);
        instance.end_ms = max(
            min(
                instance.reset_at.unwrap_or(instance.last_at),
                next_ts.unwrap_or(f64::INFINITY),
            ),
            instance.last_at,
        );
        instance.current = !has_next && instance.reset_at.is_none_or(|r| r > now);
        previous_end = instance.end_ms;
    }
    let mut before = f64::NEG_INFINITY;
    for instance in &mut instances {
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
    instances
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
        if to - from > MEASURED_GAP_MS {
            UNMEASURED
        } else {
            MEASURED
        }
    };
    for instance in instances {
        if instance.idle {
            if instance.end_ms > instance.start_ms {
                let prior = points.last().map_or(instance.start_ms, |p| p.at);
                add(
                    &mut points,
                    instance.start_ms,
                    0.0,
                    stretch(prior, instance.start_ms),
                );
                add(&mut points, instance.end_ms, 0.0, MEASURED);
            }
            continue;
        }
        // Between windows the meter sits at zero, and every window opens there.
        if instance.start_ms < instance.rows[0].ts {
            let prior = points.last().map_or(instance.start_ms, |p| p.at);
            add(
                &mut points,
                instance.start_ms,
                0.0,
                stretch(prior, instance.start_ms),
            );
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
        add(
            &mut points,
            instance.end_ms,
            instance.last_pct,
            stretch(instance.last_at, instance.end_ms),
        );
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
    let Point {
        at, percent: value, ..
    } = points[low];
    match points.get(low + 1) {
        Some(next) if next.kind != MOVE && next.at != at => {
            value + ((next.percent - value) * (time - at)) / (next.at - at)
        }
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
}

impl Event {
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
    let named: Vec<(i64, String)> = routes
        .query_map([provider], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
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

/// The provider account's token records in [from_ms, to_ms], summed per minute and model,
/// keeping the best-ranked origin per day and model like the usage rollups. Records without an
/// account belong to the legacy owner only, or to every account while no record names one.
fn read_quota_events(
    conn: &Connection,
    selection: &Selection,
    from_ms: f64,
    to_ms: f64,
) -> Result<Vec<Event>> {
    let provider = selection.provider.as_str();
    let owner = legacy_account_owner(conn, provider)?;
    let unlabeled = match &owner {
        Some(o) if *o != selection.account => selection.account.as_str(),
        _ => "",
    };
    // Anthropic's scoped weekly labels are model-family limits, not the whole subscription.
    let scope = if provider == "anthropic-oauth" && selection.label.starts_with("7D ") {
        let tail = mixdog_js::js_trim(&selection.label[3..]).to_lowercase();
        let separators = mixdog_js::JsRegex::new_static(r"[\s_]+", "g");
        format!(
            "claude-{}",
            separators.replace_all_with(&tail, |_| "-".to_string())
        )
    } else {
        String::new()
    };
    let sql = format!(
        "WITH routes AS (
            SELECT id,json_extract(signature,'$[1]') AS model,json_extract(signature,'$[7]') AS rank,
                {} AS fast
            FROM usage_routes
            WHERE json_extract(signature,'$[0]')=?1 AND COALESCE(json_extract(signature,'$[8]'),'') IN (?2,?3)
                AND json_extract(signature,'$[4]')<>'{NO_USAGE_COST_SOURCE}'
        )
        SELECT e.ts,e.day,r.model,r.rank,COUNT(*) AS turns,
            SUM(e.input) AS input,SUM(e.output) AS output,SUM(e.cache_read) AS cacheRead,
            SUM(e.cache_write) AS cacheWrite,SUM(e.cost_usd) AS costUsd,COUNT(e.cost_usd) AS priced,
            SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.output ELSE 0 END) AS speedOutput,
            SUM(CASE WHEN e.duration_ms>0 AND e.output>0 THEN e.duration_ms ELSE 0 END) AS speedMs,
            r.fast
        FROM usage_events e JOIN routes r ON r.id=e.route
        WHERE e.ts>=?4 AND e.ts<=?5
        GROUP BY e.ts,e.day,r.model,r.rank,r.fast
        ORDER BY e.ts",
        fast_route_sql("signature")
    );
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
        fast: bool,
    }
    let mut stmt = conn.prepare_cached(&sql)?;
    let raws: Vec<Raw> = stmt
        .query_map(
            params![provider, selection.account, unlabeled, from_ms, to_ms],
            |r| {
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
                    fast: r.get::<_, i64>(13)? != 0,
                })
            },
        )?
        .collect::<std::result::Result<_, _>>()?;
    let mut best: HashMap<String, Option<f64>> = HashMap::new();
    let mut ranks = conn.prepare_cached(
        "SELECT day,model,MIN(rank) AS rank FROM daily WHERE provider=?1 AND day BETWEEN ?2 AND ?3 GROUP BY day,model",
    )?;
    let rows = ranks.query_map(
        params![provider, day_key(from_ms as i64), day_key(to_ms as i64)],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<f64>>(2)?,
            ))
        },
    )?;
    for row in rows {
        let (day, model, rank) = row?;
        best.insert(format!("{day}\u{0}{model}"), rank);
    }
    let unmeasuring = is_unmeasuring_provider(provider);
    let mut events = Vec::with_capacity(raws.len());
    for row in raws {
        let model = row.model.to_lowercase();
        if !scope.is_empty() && model != scope && !model.starts_with(&format!("{scope}-")) {
            continue;
        }
        let day = row.day.to_string();
        let key = format!(
            "{}-{}-{}\u{0}{}",
            &day[..4],
            &day[4..6],
            &day[6..],
            row.model
        );
        if best.get(&key) != Some(&row.rank) {
            continue;
        }
        // `usage.x || 0`: the measurement normalization, then NaN and absent read as zero.
        let (input, cache_read, cache_write, cost_usd, known, unmeasured) = if unmeasuring {
            (0.0, 0.0, 0.0, 0.0, 0.0, row.turns)
        } else {
            (
                row.input.unwrap_or(0.0),
                row.cache_read.unwrap_or(0.0),
                row.cache_write.unwrap_or(0.0),
                row.cost_usd.unwrap_or(0.0),
                row.priced,
                0.0,
            )
        };
        let output = row.output.unwrap_or(0.0);
        events.push(Event {
            ts: row.ts as f64,
            model: if row.fast {
                format!("{}{FAST_KEY}", row.model)
            } else {
                row.model.clone()
            },
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
        });
    }
    Ok(events)
}

/// `quota_samples` stores readings rounded to two decimal places. Respect the precision
/// actually present: an integer-only series supplies whole-percent readings, not invented
/// tenths.
fn quota_reading_resolution(rows: &[Row]) -> f64 {
    let cents: Vec<f64> = rows.iter().map(|r| round(r.used_pct * 100.0)).collect();
    if cents.iter().any(|v| v % 10.0 != 0.0) {
        0.01
    } else if cents.iter().any(|v| v % 100.0 != 0.0) {
        0.1
    } else {
        1.0
    }
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

fn value_evidence(interval: &Interval) -> bool {
    interval.priced && interval.cost_usd > 0.0 && interval.points > 0.0
}

/// One window's meter rises, each with the records behind it.
fn window_intervals(instance: &Instance, events: &[Event], mixed: &[Span]) -> Vec<Interval> {
    let resolution = quota_reading_resolution(&instance.rows);
    let mut intervals = Vec::new();
    let mut from_ms = instance.start_ms;
    let mut from_pct = 0.0;
    for (row_index, row) in instance.rows.iter().enumerate() {
        let delta = row.used_pct - from_pct;
        if delta > 0.0 {
            let start = first_after(events, from_ms);
            let end = first_after(events, row.ts);
            let (mut cost, mut tokens, mut turns, mut priced) = (0.0, 0.0, 0.0, 0.0);
            for event in &events[start..end] {
                cost += event.cost_usd;
                tokens += event.tokens;
                turns += event.turns;
                priced += event.cost_known_turns;
            }
            let (mut weight, mut total) = (Weight::Turns, turns);
            if cost > 0.0 {
                weight = Weight::CostUsd;
                total = cost;
            } else if tokens > 0.0 {
                weight = Weight::Tokens;
                total = tokens;
            }
            intervals.push(Interval {
                from_ms,
                to_ms: row.ts,
                points: delta,
                cost_usd: cost,
                start,
                end,
                weight,
                total,
                resolution,
                // Only an inferred opening, a saturated meter, or the first rise from zero
                // lowers its measurement quality.
                measured: row_index > 0 && from_pct > 0.0 && row.used_pct < 100.0,
                priced: turns > 0.0 && priced == turns,
                mixed: mixed
                    .iter()
                    .any(|span| span.from_ms < row.ts && span.to_ms > from_ms),
            });
        }
        from_ms = row.ts;
        from_pct = row.used_pct;
    }
    intervals
}

/// An outside-use interval.
#[derive(Clone, Copy, Debug)]
struct Outside {
    from_ms: f64,
    to_ms: f64,
    points: f64,
    cost_usd: Option<f64>,
}

/// Keeps observed quota and recorded dollars intact. Estimates probable outside use from priced
/// history before allocating the remainder over Mixdog's requests; recent observations outweigh
/// older ones. Each window continues from its earlier windows in `listed` (every non-idle
/// window, oldest first), whose records `events` must cover.
fn allocate_quota(
    all: &mut [Instance],
    instances: &[usize],
    events: &[Event],
    mixed: &[Span],
    listed: &[usize],
) -> (Vec<f64>, Vec<Outside>) {
    let mut shares = vec![0.0f64; events.len()];
    let mut outside: Vec<Outside> = Vec::new();
    let mut calibration: HashMap<usize, Vec<Interval>> = HashMap::new();
    for &index in instances {
        let earlier = earlier_windows(all, listed, index);
        let mut prior: Vec<Interval> = Vec::new();
        for window in earlier {
            let held = calibration.entry(window).or_insert_with(|| {
                window_intervals(&all[window], events, mixed)
                    .into_iter()
                    .filter(|i| !i.mixed)
                    .collect()
            });
            prior.extend(held.iter().cloned());
        }
        let intervals = window_intervals(&all[index], events, mixed);
        let own: Vec<Interval> = intervals.iter().filter(|i| !i.mixed).cloned().collect();
        let estimate = estimate_quota_value(&own, &prior);
        // The estimate still splits the meter, but it is shown in dollars only once it rests on
        // more than a few coincidences.
        let own_samples = own
            .iter()
            .filter(|i| i.measured && value_evidence(i))
            .count();
        let value = estimate
            .clone()
            .filter(|_| prior.iter().any(value_evidence) || own_samples >= MIN_VALUE_SAMPLES);
        let instance = &mut all[index];
        instance.outside = 0.0;
        instance.outside_cost_usd = 0.0;
        instance.outside_unpriced = 0.0;
        for interval in &intervals {
            let mut external = interval.points;
            if interval.total > 0.0 {
                external = 0.0;
                if interval.measured && interval.priced {
                    external = match (&estimate, interval.mixed) {
                        (Some(model), true) => min(
                            interval.points,
                            max(
                                0.0,
                                interval.points - interval.cost_usd / model.cost_per_percent,
                            ),
                        ),
                        _ => estimate_outside_quota(interval, estimate.as_ref()),
                    };
                }
                for event_index in interval.start..interval.end {
                    shares[event_index] += ((interval.points - external)
                        * events[event_index].weight(interval.weight))
                        / interval.total;
                }
            }
            if external > 0.0 {
                let cost_usd = value.as_ref().map(|v| external * v.cost_per_percent);
                outside.push(Outside {
                    from_ms: interval.from_ms,
                    to_ms: interval.to_ms,
                    points: external,
                    cost_usd,
                });
                instance.outside += external;
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
    (shares, outside)
}

/// The weekly all-model limit's five-hour companion restarts from zero every few hours and moves
/// in quarter-size steps, so it exposes outside use that a whole-percent weekly reading hides.
fn finer_outside_spans(
    conn: &Connection,
    selection: &Selection,
    events: &[Event],
    weeks: &[&Instance],
    now: f64,
) -> Result<Vec<Span>> {
    if selection.label != "7D" || events.is_empty() || weeks.is_empty() {
        return Ok(Vec::new());
    }
    let mut prefix = vec![0.0f64];
    for event in events {
        prefix.push(prefix[prefix.len() - 1] + event.cost_usd);
    }
    let cost_between =
        |from: f64, to: f64| prefix[first_after(events, to)] - prefix[first_after(events, from)];
    let fives: Vec<Instance> = quota_instances(&read_quota_rows(conn, selection, "5H")?, "5H", now)
        .into_iter()
        .filter(|i| !i.idle)
        .collect();
    let mut spans = Vec::new();
    for week in weeks {
        let readings: Vec<Vec<Reading>> = fives
            .iter()
            .filter(|five| five.start_ms >= week.start_ms && five.start_ms < week.end_ms)
            .map(|five| {
                five.rows
                    .iter()
                    .map(|r| Reading {
                        ts: r.ts,
                        used_pct: r.used_pct,
                    })
                    .collect()
            })
            .collect();
        let starts: Vec<f64> = fives
            .iter()
            .filter(|five| five.start_ms >= week.start_ms && five.start_ms < week.end_ms)
            .map(|five| five.start_ms)
            .collect();
        let windows: Vec<FinerWindow> = starts
            .iter()
            .zip(&readings)
            .map(|(start_ms, readings)| FinerWindow {
                start_ms: *start_ms,
                readings,
            })
            .collect();
        spans.extend(outside_spans(&windows, &cost_between, 5.0 * MINUTE));
    }
    Ok(spans)
}

fn interval_share(interval: &Interval, from_ms: f64, to_ms: f64) -> f64 {
    if interval.to_ms <= interval.from_ms {
        return if interval.to_ms >= from_ms && interval.to_ms <= to_ms {
            1.0
        } else {
            0.0
        };
    }
    max(
        0.0,
        min(interval.to_ms, to_ms) - max(interval.from_ms, from_ms),
    ) / (interval.to_ms - interval.from_ms)
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

fn put_cost_fields(
    out: &mut Map<String, Value>,
    cost_usd: f64,
    outside_cost_usd: Option<f64>,
    unpriced: bool,
) {
    let extra = outside_cost_usd.map(|c| round_to(c, 6));
    let recorded = round_to(cost_usd, 6);
    out.insert("costUsd".into(), js_number(recorded));
    out.insert(
        "outsideCostUsd".into(),
        extra.map_or(Value::Null, js_number),
    );
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
    fn add(&mut self, event: &Event, share: f64) {
        self.consumed += share;
        self.turns += event.turns;
        self.input += event.input;
        self.output += event.output;
        self.cache_read += event.cache_read;
        self.cache_write += event.cache_write;
        self.cost_usd += event.cost_usd;
        self.cost_known_turns += event.cost_known_turns;
        self.unmeasured_turns += event.unmeasured_turns;
        self.speed_output += event.speed_output;
        self.speed_ms += event.speed_ms;
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
    out.insert(
        "costUnpricedTurns".into(),
        js_number(max(0.0, usage.turns - usage.cost_known_turns)),
    );
    out.insert(
        "cacheHitRate".into(),
        if unknown || prompt <= 0.0 {
            Value::Null
        } else {
            js_number(round_to(usage.cache_read / prompt, 4))
        },
    );
    out.insert(
        "outputTokensPerSecond".into(),
        if usage.speed_ms > 0.0 {
            js_number(round_to((usage.speed_output * 1000.0) / usage.speed_ms, 1))
        } else {
            Value::Null
        },
    );
    out
}

/// What a Fast key stands for: `modelId` is the model itself, never the internal key.
fn put_identity(out: &mut Map<String, Value>, key: &str) {
    if let Some(model) = key.strip_suffix(FAST_KEY) {
        out.insert("fast".into(), true.into());
        out.insert("modelId".into(), model.to_string().into());
    }
}

fn model_of_row(row: &Value) -> String {
    row.get("modelId")
        .or_else(|| row.get("model"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
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
    let index = anchor
        .and_then(|a| listed.iter().position(|&i| all[i].key == a))
        .unwrap_or(listed.len() - 1);
    let instance = &all[listed[index]];
    let mut out = Map::new();
    out.insert("view".into(), "window".into());
    out.insert("anchor".into(), instance.key.clone().into());
    out.insert("fromMs".into(), js_number(instance.start_ms));
    out.insert("toMs".into(), js_number(instance.end_ms));
    out.insert("startDay".into(), day_key(instance.start_ms as i64).into());
    out.insert("endDay".into(), day_key(instance.end_ms as i64).into());
    out.insert(
        "previousAnchor".into(),
        index
            .checked_sub(1)
            .map_or(Value::Null, |p| all[listed[p]].key.clone().into()),
    );
    out.insert(
        "nextAnchor".into(),
        listed
            .get(index + 1)
            .map_or(Value::Null, |&n| all[n].key.clone().into()),
    );
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
    let span = if instance.paced {
        Some(reset_at - instance.start_ms)
    } else {
        None
    };
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
    let runs_out = if rate > 0.0 {
        instance.last_at + ((100.0 - instance.last_pct) / rate) * HOUR
    } else {
        f64::INFINITY
    };
    let before_reset = runs_out < reset_at;
    let mut out = Map::new();
    out.insert("ratePerHour".into(), js_number(round_to(rate, 2)));
    out.insert("fromMs".into(), js_number(instance.last_at));
    out.insert("fromPct".into(), js_number(instance.last_pct));
    out.insert(
        "exhaustAt".into(),
        if before_reset {
            js_number(round(runs_out))
        } else {
            Value::Null
        },
    );
    out.insert(
        "atResetPct".into(),
        if before_reset {
            Value::Null
        } else {
            js_number(round_to(
                instance.last_pct + (rate * (reset_at - instance.last_at)) / HOUR,
                1,
            ))
        },
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
}

/// Each model's running share of its window, sampled at slot ends; the slot running now is
/// sampled at now, as far as it has run.
fn model_series(slots: &[Slot], instances: &[&Instance], keys: &[String], now: f64) -> Vec<Value> {
    let mut series: Vec<(String, Vec<Value>)> =
        keys.iter().map(|k| (k.clone(), Vec::new())).collect();
    let mut running: HashMap<String, f64> = HashMap::new();
    let mut owner: Option<Option<usize>> = None;
    for slot in slots {
        if slot.future {
            break;
        }
        let instance = instances
            .iter()
            .position(|entry| slot.from_ms >= entry.start_ms && slot.from_ms < entry.end_ms);
        if owner != Some(instance) {
            owner = Some(instance);
            for (key, points) in &mut series {
                running.insert(key.clone(), 0.0);
                points.push(Value::Array(vec![js_number(slot.from_ms), 0.into()]));
            }
        }
        for (key, points) in &mut series {
            let part = if key == OUTSIDE_KEY {
                slot.outside
            } else {
                slot.models.get(key).map_or(0.0, |u| u.consumed)
            };
            let total = running[key.as_str()] + part;
            running.insert(key.clone(), total);
            points.push(Value::Array(vec![
                js_number(min(slot.to_ms, now)),
                js_number(round_to(total, 2)),
            ]));
        }
    }
    series
        .into_iter()
        .map(|(key, points)| {
            let mut out = Map::new();
            out.insert("key".into(), key.clone().into());
            put_identity(&mut out, &key);
            out.insert("points".into(), Value::Array(points));
            Value::Object(out)
        })
        .collect()
}

/// Outside usage is spread over the time its interval covers; returns its total within the
/// domain.
fn spread_outside_usage(
    outside: &[Outside],
    slots: &mut [Slot],
    domain_from: f64,
    domain_to: f64,
    slot_ms: f64,
) -> f64 {
    let slot_at = |time: f64, len: usize| {
        min(
            (len - 1) as f64,
            max(0.0, ((time - domain_from) / slot_ms).floor()),
        ) as usize
    };
    let mut total = 0.0;
    let add = |slot: &mut Slot, interval: &Outside, share: f64, total: &mut f64| {
        let part = interval.points * share;
        slot.outside += part;
        match interval.cost_usd {
            None => slot.outside_unpriced += part,
            Some(c) => slot.outside_cost_usd += c * share,
        }
        *total += part;
    };
    let len = slots.len();
    for interval in outside {
        let from = max(interval.from_ms, domain_from);
        let to = min(interval.to_ms, domain_to);
        if interval.to_ms <= interval.from_ms {
            if interval.to_ms < domain_from || interval.to_ms > domain_to {
                continue;
            }
            add(
                &mut slots[slot_at(interval.to_ms, len)],
                interval,
                1.0,
                &mut total,
            );
            continue;
        }
        let mut index = slot_at(from, len);
        while index < len && slots[index].from_ms < to {
            let overlap = min(to, slots[index].to_ms) - max(from, slots[index].from_ms);
            if overlap > 0.0 {
                add(
                    &mut slots[index],
                    interval,
                    overlap / (interval.to_ms - interval.from_ms),
                    &mut total,
                );
            }
            index += 1;
        }
    }
    total
}

fn history_row(instance: &Instance, events: &[Event]) -> Value {
    let start = first_after(events, instance.start_ms - 1.0);
    let end = first_after(events, instance.end_ms);
    let (mut tokens, mut turns, mut cost_usd, mut unpriced) = (0.0, 0.0, 0.0, 0.0);
    for event in &events[start..end] {
        tokens += event.tokens;
        turns += event.turns;
        cost_usd += event.cost_usd;
        unpriced += event.turns - event.cost_known_turns;
    }
    let mut out = Map::new();
    out.insert("key".into(), instance.key.clone().into());
    out.insert("startMs".into(), js_number(instance.start_ms));
    out.insert("endMs".into(), js_number(instance.end_ms));
    out.insert(
        "resetAt".into(),
        instance.reset_at.map_or(Value::Null, js_number),
    );
    out.insert("peak".into(), js_number(round_to(instance.peak, 1)));
    out.insert("peakAt".into(), js_number(instance.peak_at));
    out.insert(
        "exhaustedAt".into(),
        instance.exhausted_at.map_or(Value::Null, js_number),
    );
    out.insert("current".into(), instance.current.into());
    out.insert("tokens".into(), js_number(tokens));
    out.insert("turns".into(), js_number(turns));
    put_cost_fields(
        &mut out,
        cost_usd,
        (instance.value.is_some() && instance.outside_unpriced == 0.0)
            .then_some(instance.outside_cost_usd),
        unpriced > 0.0,
    );
    out.insert(
        "costPerPercent".into(),
        instance
            .value
            .as_ref()
            .map_or(Value::Null, |v| js_number(round_to(v.cost_per_percent, 6))),
    );
    out.insert(
        "estimateSamples".into(),
        instance.estimate.as_ref().map_or(0, |e| e.samples).into(),
    );
    out.insert("outside".into(), js_number(round_to(instance.outside, 2)));
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
                out.insert(
                    "windows".into(),
                    Value::Array(s.windows.iter().cloned().map(Value::from).collect()),
                );
                Value::Object(out)
            })
            .collect(),
    )
}

/// The history of one limit window over a period: the meter's path, who moved it (per model and
/// hover slot), where each window in it peaked and, for the open window, where the current pace
/// ends it. `view: window` selects one window (the latest, or `anchor`); any other view reads
/// [from_ms, to_ms]. The list of every window is read a page at a time ([`read_quota_windows`]).
pub(crate) fn read_quota_history(
    conn: &Connection,
    query: &QuotaHistoryQuery,
    now: i64,
) -> Result<Value> {
    let now = now as f64;
    let view = if query.view.is_empty() {
        "window"
    } else {
        query.view.as_str()
    };
    let subscriptions = list_quota_series(conn)?;
    let selection = pick_selection(
        &subscriptions,
        &query.provider,
        &query.account,
        &query.label,
        &query.in_use,
    );
    let mut base = Map::new();
    base.insert("generatedAt".into(), js_number(now));
    base.insert("view".into(), view.to_string().into());
    base.insert("subscriptions".into(), series_value(&subscriptions));
    base.insert(
        "selection".into(),
        selection.as_ref().map_or(Value::Null, Selection::to_value),
    );
    let Some(selection) = selection else {
        base.insert("period".into(), Value::Null);
        return Ok(Value::Object(base));
    };
    let rows = read_quota_rows(conn, &selection, &selection.label)?;
    let mut instances = quota_instances(&rows, &selection.label, now);
    let listed: Vec<usize> = (0..instances.len())
        .filter(|&i| !instances[i].idle)
        .collect();
    let mut range = Map::new();
    range.insert("firstDay".into(), day_key(rows[0].ts as i64).into());
    let period: Option<(Value, f64, f64)> = if view == "window" {
        window_period(&instances, &listed, query.anchor.as_deref()).map(|p| {
            let from = p["fromMs"].as_f64().unwrap_or(0.0);
            let to = p["toMs"].as_f64().unwrap_or(0.0);
            (p, from, to)
        })
    } else {
        let mut p = Map::new();
        p.insert("view".into(), view.to_string().into());
        p.insert(
            "fromMs".into(),
            query.from_ms.map_or(Value::Null, js_number),
        );
        p.insert("toMs".into(), query.to_ms.map_or(Value::Null, js_number));
        Some((
            Value::Object(p),
            query.from_ms.unwrap_or(0.0),
            query.to_ms.unwrap_or(0.0),
        ))
    };
    let Some((period, period_from, period_to)) = period else {
        base.insert("range".into(), Value::Object(range));
        base.insert("period".into(), Value::Null);
        return Ok(Value::Object(base));
    };

    let domain_from = if period_from > 0.0 {
        period_from
    } else {
        rows[0].ts
    };
    let domain_to = max(period_to, domain_from + MINUTE);
    let overlapping = |i: &Instance| i.end_ms > domain_from && i.start_ms < domain_to;
    let shown: Vec<usize> = (0..instances.len())
        .filter(|&i| overlapping(&instances[i]))
        .collect();
    let calibrated = calibrated_windows(&instances, &listed, &shown);
    let from = calibrated
        .iter()
        .fold(domain_from, |m, &i| min(m, instances[i].start_ms));
    let to = shown
        .iter()
        .fold(domain_to, |m, &i| max(m, instances[i].end_ms));
    let events = read_quota_events(conn, &selection, from, to)?;
    let calibrated_refs: Vec<&Instance> = calibrated.iter().map(|&i| &instances[i]).collect();
    let finer = finer_outside_spans(conn, &selection, &events, &calibrated_refs, now)?;
    let (shares, outside) = allocate_quota(&mut instances, &shown, &events, &finer, &listed);
    let shown_refs: Vec<&Instance> = shown.iter().map(|&i| &instances[i]).collect();
    let points = quota_points(&shown_refs);

    let span = domain_to - domain_from;
    let slot_ms = SLOT_MINUTES
        .iter()
        .map(|m| m * MINUTE)
        .find(|size| span / size <= MAX_SLOTS)
        .unwrap_or_else(|| (span / MAX_SLOTS).ceil());
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
        });
        start += slot_ms;
    }
    let last_slot = (slots.len() - 1) as f64;
    let slot_at = |time: f64| {
        min(
            last_slot,
            max(0.0, ((time - domain_from) / slot_ms).floor()),
        ) as usize
    };
    let mut totals = Usage::default();
    let mut models: Ordered<Usage> = Ordered::default();
    for (index, event) in events.iter().enumerate() {
        if event.ts < domain_from || event.ts > domain_to {
            continue;
        }
        let share = shares[index];
        totals.add(event, share);
        models.entry(&event.model, Usage::default).add(event, share);
        let at = slot_at(event.ts);
        let slot = &mut slots[at];
        slot.usage.add(event, share);
        slot.models
            .entry(&event.model, Usage::default)
            .add(event, share);
    }
    let outside_total = spread_outside_usage(&outside, &mut slots, domain_from, domain_to, slot_ms);
    let cost_per_percent = period_quota_rate(&shown_refs, domain_from, domain_to);
    let outside_cost_usd =
        if cost_per_percent.is_none() || slots.iter().any(|s| s.outside_unpriced > 0.0) {
            None
        } else {
            Some(slots.iter().fold(0.0, |sum, s| sum + s.outside_cost_usd))
        };

    let mut exported_models: Vec<Value> = models
        .iter()
        .map(|(key, usage)| export_model(key, usage))
        .collect();
    sort_fast_beside_model(&mut exported_models, model_of_row, &["consumed", "tokens"]);
    let mut series_keys: Vec<String> = exported_models
        .iter()
        .filter(|m| m["consumed"].as_f64().unwrap_or(0.0) > 0.0)
        .take(SERIES_LIMIT)
        .map(|m| m["model"].as_str().unwrap_or("").to_string())
        .collect();
    if outside_total > 0.0 {
        series_keys.push(OUTSIDE_KEY.to_string());
    }
    let last_point = points.last().map_or(domain_from, |p| p.at);
    let peaks: Vec<&Instance> = listed
        .iter()
        .map(|&i| &instances[i])
        .filter(|i| overlapping(i))
        .collect();
    let focus = if view == "window" {
        let anchor = period.get("anchor").and_then(Value::as_str).unwrap_or("");
        listed
            .iter()
            .map(|&i| &instances[i])
            .find(|i| i.key == anchor)
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
            decimate(points.clone(), domain_from, domain_to)
                .iter()
                .map(|p| Value::Array(vec![js_number(p.at), js_number(p.percent), p.kind.into()]))
                .collect(),
        ),
    );
    out.insert(
        "focus".into(),
        focus.map_or(Value::Null, |f| {
            let mut o = Map::new();
            o.insert("startMs".into(), js_number(f.start_ms));
            o.insert("endMs".into(), js_number(f.end_ms));
            o.insert("resetAt".into(), f.reset_at.map_or(Value::Null, js_number));
            o.insert("usedPct".into(), js_number(f.last_pct));
            o.insert("readAt".into(), js_number(f.last_at));
            o.insert("peak".into(), js_number(f.peak));
            o.insert(
                "exhaustedAt".into(),
                f.exhausted_at.map_or(Value::Null, js_number),
            );
            o.insert("current".into(), f.current.into());
            // Whether the window's opening is known, so an even pace can be drawn.
            o.insert("paced".into(), f.paced.into());
            Value::Object(o)
        }),
    );
    out.insert("forecast".into(), forecast);
    let mut summary = Map::new();
    summary.insert(
        "consumed".into(),
        js_number(round_to(totals.consumed + outside_total, 2)),
    );
    summary.insert("outside".into(), js_number(round_to(outside_total, 2)));
    put_cost_fields(
        &mut summary,
        totals.cost_usd,
        outside_cost_usd,
        totals.cost_known_turns < totals.turns,
    );
    summary.insert(
        "costPerPercent".into(),
        cost_per_percent.map_or(Value::Null, js_number),
    );
    summary.insert(
        "estimateSamples".into(),
        shown_refs
            .iter()
            .fold(0usize, |sum, i| {
                sum + i.estimate.as_ref().map_or(0, |e| e.samples)
            })
            .into(),
    );
    summary.insert(
        "maxedOut".into(),
        peaks
            .iter()
            .filter(|i| {
                i.exhausted_at
                    .is_some_and(|e| e >= domain_from && e <= domain_to)
            })
            .count()
            .into(),
    );
    out.insert("summary".into(), Value::Object(summary));
    out.insert("totals".into(), Value::Object(export_usage(&totals)));
    out.insert("outside".into(), js_number(round_to(outside_total, 2)));
    out.insert("models".into(), Value::Array(exported_models));
    out.insert("slotMs".into(), js_number(slot_ms));
    let slot_values: Vec<Value> = slots
        .iter()
        .map(|slot| {
            let mut o = Map::new();
            o.insert("fromMs".into(), js_number(slot.from_ms));
            o.insert("toMs".into(), js_number(slot.to_ms));
            o.insert("future".into(), slot.future.into());
            o.insert(
                "startPct".into(),
                js_number(round_to(value_at(&points, slot.from_ms), 1)),
            );
            o.insert(
                "endPct".into(),
                js_number(round_to(
                    value_at(&points, min(slot.to_ms, last_point as f64)),
                    1,
                )),
            );
            o.insert(
                "consumed".into(),
                js_number(round_to(slot.usage.consumed + slot.outside, 2)),
            );
            o.insert("outside".into(), js_number(round_to(slot.outside, 2)));
            o.insert("tokens".into(), js_number(slot.usage.tokens()));
            o.insert("turns".into(), js_number(slot.usage.turns));
            let slot_rate = period_quota_rate(&shown_refs, slot.from_ms, slot.to_ms);
            put_cost_fields(
                &mut o,
                slot.usage.cost_usd,
                if slot_rate.is_none() || slot.outside_unpriced > 0.0 {
                    None
                } else {
                    Some(slot.outside_cost_usd)
                },
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
            sort_fast_beside_model(&mut slot_models, model_of_row, &["consumed", "tokens"]);
            o.insert("models".into(), Value::Array(slot_models));
            Value::Object(o)
        })
        .collect();
    out.insert("slots".into(), Value::Array(slot_values));
    out.insert(
        "modelSeries".into(),
        Value::Array(model_series(&slots, &shown_refs, &series_keys, now)),
    );
    // A period over several windows marks where each of them peaked.
    out.insert(
        "peaks".into(),
        Value::Array(if view == "window" {
            Vec::new()
        } else {
            peaks
                .iter()
                .map(|i| {
                    let mut o = Map::new();
                    o.insert("key".into(), i.key.clone().into());
                    o.insert("peak".into(), js_number(round_to(i.peak, 1)));
                    o.insert("peakAt".into(), js_number(i.peak_at));
                    Value::Object(o)
                })
                .collect()
        }),
    );
    Ok(Value::Object(out))
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
pub(crate) fn read_quota_windows(
    conn: &Connection,
    query: &QuotaWindowsQuery,
    now: i64,
) -> Result<Value> {
    let now = now as f64;
    let selection = pick_selection(
        &list_quota_series(conn)?,
        &query.provider,
        &query.account,
        &query.label,
        &query.in_use,
    );
    let mut base = Map::new();
    base.insert("generatedAt".into(), js_number(now));
    base.insert(
        "selection".into(),
        selection.as_ref().map_or(Value::Null, Selection::to_value),
    );
    base.insert("page".into(), 0.into());
    base.insert("pageCount".into(), 0.into());
    base.insert("total".into(), 0.into());
    base.insert("windows".into(), Value::Array(Vec::new()));
    let Some(selection) = selection else {
        return Ok(Value::Object(base));
    };
    let mut instances = quota_instances(
        &read_quota_rows(conn, &selection, &selection.label)?,
        &selection.label,
        now,
    );
    let chronological: Vec<usize> = (0..instances.len())
        .filter(|&i| !instances[i].idle)
        .collect();
    let listed: Vec<usize> = chronological.iter().rev().copied().collect();
    let page_count = listed.len().div_ceil(HISTORY_PAGE_SIZE);
    if page_count == 0 {
        return Ok(Value::Object(base));
    }
    // `Math.floor(page) || 0`, clamped.
    let requested = if query.page.is_finite() {
        query.page.floor()
    } else {
        0.0
    };
    let index = min(max(0.0, requested), (page_count - 1) as f64) as usize;
    let shown: Vec<usize> = listed
        .iter()
        .skip(index * HISTORY_PAGE_SIZE)
        .take(HISTORY_PAGE_SIZE)
        .copied()
        .collect();
    let calibrated = calibrated_windows(&instances, &chronological, &shown);
    let from = calibrated
        .iter()
        .fold(f64::INFINITY, |m, &i| min(m, instances[i].start_ms));
    let to = shown
        .iter()
        .fold(f64::NEG_INFINITY, |m, &i| max(m, instances[i].end_ms));
    let events = read_quota_events(conn, &selection, from, to)?;
    let calibrated_refs: Vec<&Instance> = calibrated.iter().map(|&i| &instances[i]).collect();
    let finer = finer_outside_spans(conn, &selection, &events, &calibrated_refs, now)?;
    allocate_quota(&mut instances, &shown, &events, &finer, &chronological);
    base.insert("page".into(), index.into());
    base.insert("pageCount".into(), page_count.into());
    base.insert("total".into(), listed.len().into());
    base.insert(
        "windows".into(),
        Value::Array(
            shown
                .iter()
                .map(|&i| history_row(&instances[i], &events))
                .collect(),
        ),
    );
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
pub(crate) fn get_quota_history(
    conn: &Connection,
    options: &QuotaHistoryOptions,
    in_use: &BTreeMap<String, String>,
    now: i64,
) -> Result<Value> {
    let provider = quota_text(options.provider.as_deref());
    let account = quota_text(options.account.as_deref());
    let label = quota_text(options.window.as_deref());
    if let Some(page) = options.page {
        return read_quota_windows(
            conn,
            &QuotaWindowsQuery {
                provider,
                account,
                label,
                in_use: in_use.clone(),
                page,
            },
            now,
        );
    }
    let view = options
        .view
        .clone()
        .filter(|v| v != "window")
        .unwrap_or_else(|| "window".to_string());
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
