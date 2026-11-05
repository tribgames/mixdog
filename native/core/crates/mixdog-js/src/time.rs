//! JavaScript `Date` local-time semantics, in one place: the process time zone (the `TZ`
//! environment variable, else the OS zone, resolved once, with a thread-local override for
//! tests), UTC <-> local conversion with V8's rules for DST gaps and overlaps, and
//! `Date.parse` (V8's ES5 and legacy reader, in `date_parser.rs`).
//!
//! Times are JS time values: milliseconds since the epoch as `f64`, `NaN` for an invalid date.

use std::cell::Cell;
use std::sync::OnceLock;

use chrono::{DateTime, Datelike, Offset, TimeZone, Timelike};
pub use chrono_tz::Tz;

/// The largest magnitude of a valid JS time value.
const MAX_TIME_MS: f64 = 8.64e15;
const DAY_MS: i64 = 86_400_000;
/// Year ~2413: the top of the window an out-of-calendar wall time is folded into.
const FAR_MS: i64 = 14_000_000_000_000;
/// The Gregorian 400-year cycle (146097 days).
const CYCLE_MS: i64 = 146_097 * DAY_MS;

static PROCESS_OVERRIDE: OnceLock<Tz> = OnceLock::new();

thread_local! {
    static OVERRIDE: Cell<Option<Tz>> = const { Cell::new(None) };
}

fn process_zone() -> Tz {
    static ZONE: OnceLock<Tz> = OnceLock::new();
    *ZONE.get_or_init(|| {
        let name = std::env::var("TZ").ok().filter(|v| !v.is_empty()).map(|v| v.trim_start_matches(':').to_owned());
        name.or_else(|| iana_time_zone::get_timezone().ok()).and_then(|n| n.parse::<Tz>().ok()).unwrap_or(Tz::UTC)
    })
}

/// Pins the local zone for the whole process, for a test binary: call it once before any
/// lane or worker thread starts. `Err` carries the zone already pinned.
pub fn set_process_zone(zone: Tz) -> Result<(), Tz> {
    PROCESS_OVERRIDE.set(zone).map_err(|_| *PROCESS_OVERRIDE.get().expect("set"))
}

/// The zone local time means: this thread's `with_local_zone`, else the zone pinned by
/// `set_process_zone`, else the process zone (`TZ`, else the OS zone).
pub fn local_zone() -> Tz {
    OVERRIDE.with(Cell::get).or_else(|| PROCESS_OVERRIDE.get().copied()).unwrap_or_else(process_zone)
}

/// Runs `run` with `zone` as this thread's local zone (for tests; other threads are unaffected).
pub fn with_local_zone<R>(zone: Tz, run: impl FnOnce() -> R) -> R {
    let previous = OVERRIDE.with(|cell| cell.replace(Some(zone)));
    let result = run();
    OVERRIDE.with(|cell| cell.set(previous));
    result
}

fn instant(zone: Tz, ms: i64) -> Option<DateTime<Tz>> {
    Some(zone.from_utc_datetime(&DateTime::from_timestamp_millis(ms)?.naive_utc()))
}

/// The local zone's offset from UTC at the instant `utc_ms`, in milliseconds, east positive
/// (`-getTimezoneOffset() * 60000`). `NaN` in, 0 out.
pub fn local_offset_ms(utc_ms: f64) -> i64 {
    local_offset_ms_in(local_zone(), utc_ms)
}

/// `local_offset_ms` in an explicit zone.
pub fn local_offset_ms_in(zone: Tz, utc_ms: f64) -> i64 {
    if !utc_ms.is_finite() {
        return 0;
    }
    instant(zone, utc_ms.floor() as i64).map_or(0, |t| i64::from(t.offset().fix().local_minus_utc()) * 1000)
}

/// Local calendar fields of an instant, as `Date#getFullYear` and friends read them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalFields {
    pub year: i32,
    /// 1-based (`getMonth() + 1`).
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub millisecond: u32,
    /// 0 = Sunday (`getDay()`).
    pub weekday: u32,
}

/// The local fields of `utc_ms`, `None` for `NaN` or out of range.
pub fn local_fields(utc_ms: f64) -> Option<LocalFields> {
    local_fields_in(local_zone(), utc_ms)
}

/// `local_fields` in an explicit zone.
pub fn local_fields_in(zone: Tz, utc_ms: f64) -> Option<LocalFields> {
    if !utc_ms.is_finite() || utc_ms.abs() > MAX_TIME_MS {
        return None;
    }
    let t = instant(zone, utc_ms.floor() as i64)?;
    Some(LocalFields {
        year: t.year(),
        month: t.month(),
        day: t.day(),
        hour: t.hour(),
        minute: t.minute(),
        second: t.second(),
        millisecond: t.timestamp_subsec_millis(),
        weekday: t.weekday().num_days_from_sunday(),
    })
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The time value of the fields read as UTC (`Date.UTC`); day, hour, ... may overflow their
/// range and carry. `month` is 1-based and must be 1..=12.
pub fn utc_to_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> f64 {
    let days = days_from_civil(year, month, 1) + day - 1;
    ((days * DAY_MS) + ((hour * 60 + minute) * 60 + second) * 1000 + ms) as f64
}

/// The time value of the fields read as local time (`new Date(y, m, d, h, mi, s, ms)`): an
/// hour skipped by a DST change takes the offset from before the change (shifting forward),
/// a repeated hour takes its first occurrence. `NaN` when out of range.
pub fn local_to_utc_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> f64 {
    local_to_utc_ms_in(local_zone(), year, month, day, hour, minute, second, ms)
}

/// `local_to_utc_ms` in an explicit zone.
#[allow(clippy::too_many_arguments)]
pub fn local_to_utc_ms_in(zone: Tz, year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64, ms: i64) -> f64 {
    let wall = utc_to_ms(year, month, day, hour, minute, second, ms) as i64;
    let Some(naive) = DateTime::from_timestamp_millis(wall).map(|t| t.naive_utc()) else {
        // Beyond the calendar chrono represents (the last ~270k years): the rules repeat every
        // 400 years, so the offset is read at the same point of the cycle inside the range.
        let cycles = (wall.abs() - FAR_MS).div_euclid(CYCLE_MS) + 1;
        let shifted = wall - wall.signum() * cycles * CYCLE_MS;
        return time_clip((wall - local_offset_ms_in(zone, shifted as f64)) as f64);
    };
    let utc = match zone.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => t.timestamp_millis(),
        chrono::LocalResult::Ambiguous(first, _) => first.timestamp_millis(),
        chrono::LocalResult::None => {
            let before = local_offset_ms_in(zone, (wall - DAY_MS) as f64);
            wall - before
        }
    };
    time_clip(utc as f64)
}

fn time_clip(t: f64) -> f64 {
    if t.is_finite() && t.abs() <= MAX_TIME_MS { t } else { f64::NAN }
}

/// `Date.parse(text)`: V8's reader, the ES5 date-time string (`±YYYYYY`/`YYYY[-MM[-DD]]`
/// with an optional `THH:mm[:ss[.sss]]` and `Z` or `±hh:mm`) and then the legacy fallback
/// ("May 6, 2024", "5/6/2024 3:04 PM", "Mon, 06 May 2024 10:00:00 GMT+0900", a bare "0").
/// A date-only ISO string is UTC; any other text without a zone is local time. `NaN` when V8
/// rejects it.
pub fn date_parse(text: &str) -> f64 {
    date_parse_in(local_zone(), text)
}

/// `date_parse` in an explicit zone.
pub fn date_parse_in(zone: Tz, text: &str) -> f64 {
    let Some(p) = date_parser::parse(text) else { return f64::NAN };
    // V8's MakeDay refuses years beyond +-1,000,000.
    if !(-1_000_000..=1_000_000).contains(&p.year) {
        return f64::NAN;
    }
    let (year, month, day) = (i64::from(p.year), i64::from(p.month), i64::from(p.day));
    let (hour, minute, second, milli) = (i64::from(p.hour), i64::from(p.minute), i64::from(p.second), i64::from(p.millisecond));
    match p.utc_offset_secs {
        Some(offset) => time_clip(utc_to_ms(year, month, day, hour, minute, second, milli) - f64::from(offset) * 1000.0),
        None => local_to_utc_ms_in(zone, year, month, day, hour, minute, second, milli),
    }
}

#[path = "date_parser.rs"]
mod date_parser;

#[cfg(test)]
#[path = "time_tests.rs"]
mod tests;
