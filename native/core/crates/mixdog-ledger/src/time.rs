//! Local calendar days. A usage "day" is the user's own day, so every conversion uses the
//! local time zone `mixdog_js::time` defines (the one copy of `Date`'s rules, DST gaps and
//! overlaps included, with its test override).

use chrono::Datelike;
use chrono::NaiveDate;
use chrono::NaiveDateTime;
use chrono::TimeDelta;
use chrono::Timelike;

use crate::error::LedgerError;
use crate::error::Result;

/// The largest integer a JavaScript number holds exactly; the open end of a window.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `YYYY-MM-DD` of the local day containing `ts_ms`.
pub fn day_key(ts_ms: i64) -> String {
    let date = local_fields(ts_ms).date();
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// The compact integer a stored event keeps for its day (`20260101`).
pub fn day_number(day: &str) -> Result<i64> {
    let digits: String = day.chars().filter(|c| *c != '-').collect();
    digits
        .parse()
        .map_err(|_| LedgerError::Invalid("a calendar day"))
}

pub fn parse_day(day: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| LedgerError::Invalid("a calendar day"))
}

/// Epoch milliseconds of the local wall-clock time `local`, as `Date` resolves it: a repeated
/// time (clocks set back) is its first occurrence, and a time that does not exist (clocks set
/// forward) is read with the offset in force before the change, so it lands after the gap.
pub fn local_ms(local: NaiveDateTime) -> i64 {
    mixdog_js::time::local_to_utc_ms(
        i64::from(local.year()),
        i64::from(local.month()),
        i64::from(local.day()),
        i64::from(local.hour()),
        i64::from(local.minute()),
        i64::from(local.second()),
        i64::from(local.nanosecond() / 1_000_000),
    ) as i64
}

/// The local wall-clock fields of `ts_ms`.
pub fn local_fields(ts_ms: i64) -> NaiveDateTime {
    mixdog_js::time::local_fields(ts_ms as f64)
        .and_then(|f| {
            NaiveDate::from_ymd_opt(f.year, f.month, f.day)?.and_hms_milli_opt(
                f.hour,
                f.minute,
                f.second,
                f.millisecond,
            )
        })
        .unwrap_or_default()
}

/// `new Date(ts); date.setDate(date.getDate() + days)`: the same local time of day, `days`
/// calendar dates away.
pub fn add_local_days(ts_ms: i64, days: i64) -> i64 {
    local_ms(local_fields(ts_ms) + TimeDelta::days(days))
}

/// `new Date(ts); date.setHours(h, m, s, ms)` on the local day containing `ts_ms`.
pub fn set_local_time(ts_ms: i64, hours: u32, minutes: u32, seconds: u32, millis: u32) -> i64 {
    let day = local_fields(ts_ms).date();
    let time = day
        .and_hms_milli_opt(hours, minutes, seconds, millis)
        .unwrap_or_default();
    local_ms(time)
}

/// Epoch milliseconds of local midnight starting `date`.
pub fn local_midnight_ms(date: NaiveDate) -> i64 {
    local_ms(date.and_hms_opt(0, 0, 0).unwrap_or_default())
}

/// Local midnight that ends `date`.
pub fn next_midnight_ms(date: NaiveDate) -> i64 {
    local_midnight_ms(date.succ_opt().unwrap_or(date))
}
