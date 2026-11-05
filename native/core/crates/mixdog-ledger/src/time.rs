//! Local calendar days. A usage "day" is the user's own day, so every conversion uses the
//! process's local time zone, as the Node ledger's `Date` does.

use chrono::Datelike;
use chrono::Local;
use chrono::LocalResult;
use chrono::NaiveDate;
use chrono::NaiveDateTime;
use chrono::TimeDelta;
use chrono::TimeZone;

use crate::error::LedgerError;
use crate::error::Result;

/// The largest integer a JavaScript number holds exactly; the open end of a window.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `YYYY-MM-DD` of the local day containing `ts_ms`.
pub fn day_key(ts_ms: i64) -> String {
    let date = Local
        .timestamp_millis_opt(ts_ms)
        .earliest()
        .map(|t| t.date_naive())
        .unwrap_or_default();
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

/// Epoch milliseconds of local midnight starting `date`. A midnight that does not exist
/// (a spring-forward gap) reads as the first local time after the gap, like `Date`.
pub fn local_midnight_ms(date: NaiveDate) -> i64 {
    let mut local: NaiveDateTime = date.and_hms_opt(0, 0, 0).unwrap_or_default();
    loop {
        match Local.from_local_datetime(&local) {
            LocalResult::Single(t) => return t.timestamp_millis(),
            LocalResult::Ambiguous(first, _) => return first.timestamp_millis(),
            LocalResult::None => local += TimeDelta::minutes(30),
        }
    }
}

/// Local midnight that ends `date`.
pub fn next_midnight_ms(date: NaiveDate) -> i64 {
    local_midnight_ms(date.succ_opt().unwrap_or(date))
}
