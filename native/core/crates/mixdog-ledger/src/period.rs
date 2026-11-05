//! The statistics period a view names (`usage-stats-period.mjs`): trailing ranges, calendar
//! windows with their neighbours for paging, and custom date and clock ranges. Dates and
//! clock times are the user's local time, as the Node service's `Date` reads them.

use chrono::Datelike;
use serde_json::Map;
use serde_json::Value;

use crate::error::LedgerError;
use crate::error::Result;
use crate::time::add_local_days;
use crate::time::day_key;
use crate::time::local_fields;
use crate::time::local_midnight_ms;
use crate::time::set_local_time;

const HOUR_MS: i64 = 3_600_000;

fn type_error(message: &'static str) -> LedgerError {
    LedgerError::Period {
        range: false,
        message,
    }
}

fn range_error(message: &'static str) -> LedgerError {
    LedgerError::Period {
        range: true,
        message,
    }
}

/// What a caller may name; every field is optional and `view` defaults to the 24-hour view.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PeriodRequest {
    pub view: Option<String>,
    pub anchor: Option<String>,
    pub start_day: Option<String>,
    pub end_day: Option<String>,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
}

fn midnight(ts_ms: i64) -> i64 {
    local_midnight_ms(local_fields(ts_ms).date())
}

fn is_day_text(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(at, b)| {
            if at == 4 || at == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// Local midnight of the calendar date `anchor` names (`YYYY-MM-DD`, 1970 or later).
fn anchor_date(anchor: Option<&str>, now: i64) -> Result<i64> {
    let Some(anchor) = anchor else {
        return Ok(midnight(now));
    };
    if !is_day_text(anchor) {
        return Err(type_error("Usage period anchor must be a calendar date"));
    }
    let invalid =
        || type_error("Usage period anchor must be a valid calendar date from 1970 onward");
    // `new Date(`${anchor}T00:00:00`)`: an ISO date-time without an offset is local time.
    let parsed = mixdog_js::time::date_parse(&format!("{anchor}T00:00:00"));
    if !parsed.is_finite() {
        return Err(invalid());
    }
    let ms = parsed as i64;
    if local_fields(ms).date().year() < 1970 || day_key(ms) != anchor {
        return Err(invalid());
    }
    Ok(ms)
}

struct ClockTime {
    hours: u32,
    minutes: u32,
    seconds: Option<u32>,
    text: String,
}

/// `HH:MM` or `HH:MM:SS` on a 24-hour clock; blank means the whole day.
fn clock_time(value: Option<&str>, message: &'static str) -> Result<Option<ClockTime>> {
    let Some(text) = value.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let bytes = text.as_bytes();
    let digit = |at: usize| {
        bytes
            .get(at)
            .filter(|b| b.is_ascii_digit())
            .map(|b| u32::from(b - b'0'))
    };
    let pair = |at: usize| Some(digit(at)? * 10 + digit(at + 1)?);
    let parsed = match bytes.len() {
        5 if bytes[2] == b':' => pair(0).zip(pair(3)).map(|(h, m)| (h, m, None)),
        8 if bytes[2] == b':' && bytes[5] == b':' => match (pair(0), pair(3), pair(6)) {
            (Some(h), Some(m), Some(s)) => Some((h, m, Some(s))),
            _ => None,
        },
        _ => None,
    };
    match parsed {
        Some((hours, minutes, seconds))
            if hours <= 23 && minutes <= 59 && seconds.unwrap_or(0) <= 59 =>
        {
            Ok(Some(ClockTime {
                hours,
                minutes,
                seconds,
                text: text.to_string(),
            }))
        }
        _ => Err(type_error(message)),
    }
}

/// A bound names an instant at the precision it was written: a start opens its named unit, an
/// end spans that unit whole, so 09:00–18:00 keeps all of 18:00.
fn clock_ms(day: i64, time: Option<&ClockTime>, start: bool) -> i64 {
    match (start, time) {
        (true, time) => set_local_time(
            day,
            time.map_or(0, |t| t.hours),
            time.map_or(0, |t| t.minutes),
            time.and_then(|t| t.seconds).unwrap_or(0),
            0,
        ),
        (false, None) => set_local_time(day, 23, 59, 59, 999),
        (false, Some(t)) => set_local_time(day, t.hours, t.minutes, t.seconds.unwrap_or(59), 999),
    }
}

fn object(fields: Vec<(&str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect::<Map<_, _>>(),
    )
}

fn text(value: String) -> Value {
    Value::String(value)
}

fn optional(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

/// One owner for trailing ranges and navigation. `hour` is 24 elapsed hours; `7d`, `day`,
/// `week` and `month` are 7, 30, 90 and 365 local calendar dates including today, ending on
/// `anchor`; `year` and `all` cover retained history. Display and accounting bounds both stop
/// at the end of the selected range.
pub fn resolve_usage_stats_period(request: &PeriodRequest, now: i64) -> Result<Value> {
    let view = request.view.as_deref().unwrap_or("hour");
    if ![
        "hour", "7d", "day", "week", "month", "year", "all", "custom",
    ]
    .contains(&view)
    {
        return Err(type_error("Unknown usage statistics view"));
    }
    if now <= 0 {
        return Err(type_error("Usage period requires a valid current time"));
    }
    let today = day_key(now);
    match view {
        "year" | "all" => Ok(object(vec![
            ("view", text(view.to_string())),
            ("anchor", Value::Null),
            ("fromMs", 0.into()),
            ("toMs", now.into()),
            ("startDay", Value::Null),
            ("endDay", text(today)),
            ("days", Value::Null),
            ("previousAnchor", Value::Null),
            ("nextAnchor", Value::Null),
            ("isCurrent", true.into()),
        ])),
        "hour" => {
            let from = now - 24 * HOUR_MS;
            Ok(object(vec![
                ("view", text(view.to_string())),
                ("anchor", Value::Null),
                ("fromMs", from.into()),
                ("toMs", now.into()),
                ("endMs", now.into()),
                ("startDay", text(day_key(from))),
                ("endDay", text(today)),
                ("days", 1.into()),
                ("previousAnchor", Value::Null),
                ("nextAnchor", Value::Null),
                ("isCurrent", true.into()),
            ]))
        }
        "custom" => custom_period(request, now, today),
        _ => calendar_period(view, request.anchor.as_deref(), now),
    }
}

/// The whole days from the start day to the end day, narrowed by clock times when given, never
/// reaching into the future.
fn custom_period(request: &PeriodRequest, now: i64, today: String) -> Result<Value> {
    let (Some(start_day), Some(end_day)) =
        (request.start_day.as_deref(), request.end_day.as_deref())
    else {
        return Err(type_error("Usage range requires a start and end date"));
    };
    let start = anchor_date(Some(start_day), now)?;
    let end = anchor_date(Some(end_day), now)?;
    let from = clock_time(
        request.start_time.as_deref(),
        "Usage range start time must be a HH:MM clock time",
    )?;
    let to = clock_time(
        request.end_time.as_deref(),
        "Usage range end time must be a HH:MM clock time",
    )?;
    if start > end {
        return Err(range_error("Usage range start must not follow its end"));
    }
    if end > midnight(now) {
        return Err(range_error("Usage range cannot include future dates"));
    }
    let days = (local_fields(end).date() - local_fields(start).date()).num_days() + 1;
    let from_ms = clock_ms(start, from.as_ref(), true);
    let to_ms = now.min(clock_ms(end, to.as_ref(), false));
    if from_ms > now {
        return Err(range_error("Usage range cannot include future dates"));
    }
    if from_ms > to_ms {
        return Err(range_error("Usage range start must not follow its end"));
    }
    Ok(object(vec![
        ("view", text("custom".into())),
        ("anchor", Value::Null),
        ("fromMs", from_ms.into()),
        ("toMs", to_ms.into()),
        ("endMs", to_ms.into()),
        ("startDay", text(day_key(from_ms))),
        ("endDay", text(day_key(end))),
        ("startTime", optional(from.map(|t| t.text))),
        ("endTime", optional(to.map(|t| t.text))),
        ("days", days.into()),
        ("previousAnchor", Value::Null),
        ("nextAnchor", Value::Null),
        ("isCurrent", (end_day == today).into()),
    ]))
}

/// A calendar window ending on the anchor day (today at the latest), with the neighbouring
/// windows for paging.
fn calendar_period(view: &str, anchor: Option<&str>, now: i64) -> Result<Value> {
    let current = midnight(now);
    let requested = anchor_date(anchor, now)?;
    let end = requested.min(current);
    let days: i64 = match view {
        "7d" => 7,
        "day" => 30,
        "week" => 90,
        _ => 365,
    };
    let start = add_local_days(end, 1 - days);
    let previous = add_local_days(start, -1);
    let next = add_local_days(end, days);
    let to_ms = now.min(add_local_days(end, 1) - 1);
    Ok(object(vec![
        ("view", text(view.to_string())),
        ("anchor", text(day_key(end))),
        ("fromMs", start.into()),
        ("toMs", to_ms.into()),
        ("endMs", to_ms.into()),
        ("startDay", text(day_key(start))),
        ("endDay", text(day_key(end))),
        ("days", days.into()),
        (
            "previousAnchor",
            if local_fields(previous).date().year() >= 1970 {
                text(day_key(previous))
            } else {
                Value::Null
            },
        ),
        (
            "nextAnchor",
            if end < current {
                text(day_key(next.min(current)))
            } else {
                Value::Null
            },
        ),
        ("isCurrent", (end == current).into()),
    ]))
}
