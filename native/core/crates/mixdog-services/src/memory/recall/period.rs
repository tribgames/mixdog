//! Recall periods: the grammar callers write (`today`, `3d`, `2026-03-01~2026-03-12`,
//! `09:00~12:00`, `last`), the period a query's own words imply, and the local
//! clock used to turn them into time windows and render stamps.

use mixdog_js::{JsRegex, js_words};
use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use unicode_normalization::UnicodeNormalization;

/// The wall clock a recall runs against: the instant and the zone local
/// calendar words (`today`, `this_week`) and rendered stamps refer to.
#[derive(Debug, Clone, Copy)]
pub struct Clock {
    pub now_ms: i64,
    pub zone: Tz,
}

impl Clock {
    fn at(&self, ms: i64) -> DateTime<Tz> {
        Utc.timestamp_millis_opt(ms).single().unwrap_or_default().with_timezone(&self.zone)
    }

    fn local(&self, naive: NaiveDateTime) -> Option<i64> {
        self.zone.from_local_datetime(&naive).earliest().map(|t| t.timestamp_millis())
    }

    fn midnight(&self, date: NaiveDate) -> Option<i64> {
        self.local(date.and_time(NaiveTime::MIN))
    }

    /// `YYYY-MM-DD HH:mm` of an instant in the local zone.
    pub fn minute_label(&self, ms: i64) -> String {
        self.at(ms).format("%Y-%m-%d %H:%M").to_string()
    }

    /// `YYYY-MM-DD HH:mm +09:00`, the stamp a recall line carries.
    pub fn recall_stamp(&self, ms: i64) -> String {
        let time = self.at(ms);
        let offset = time.offset().fix().local_minus_utc();
        let sign = if offset < 0 { '-' } else { '+' };
        let minutes = offset.abs() / 60;
        format!("{} {sign}{:02}:{:02}", time.format("%Y-%m-%d %H:%M"), minutes / 60, minutes % 60)
    }
}

use chrono::Offset;

/// A resolved time window. A bound that could not be read is absent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Window {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub exact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Temporal {
    /// `last`: a session-grouped browse of the most recent sessions.
    Last,
    Window(Window),
}

static ROLLING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d+)(m|h|d)$", ""));
static DATE_RANGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$", ""));
static TIME_OF_DAY: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})$", "")
});
static SINGLE_DAY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d{4}-\d{2}-\d{2})$", ""));

fn parse_date(text: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()
}

fn day_window(clock: &Clock, period: &str) -> Option<Window> {
    let today = clock.at(clock.now_ms).date_naive();
    match period {
        "today" => Some(Window { start_ms: clock.midnight(today), end_ms: Some(clock.now_ms), exact: false }),
        "yesterday" => {
            let day = today - Duration::days(1);
            let start = clock.midnight(day);
            let end = clock.local(day.and_time(NaiveTime::from_hms_milli_opt(23, 59, 59, 999)?));
            Some(Window { start_ms: start, end_ms: end, exact: false })
        }
        _ => None,
    }
}

fn week_window(clock: &Clock, period: &str) -> Option<Window> {
    if period != "this_week" && period != "last_week" {
        return None;
    }
    let today = clock.at(clock.now_ms).date_naive();
    let monday = today - Duration::days(i64::from(today.weekday().num_days_from_monday()));
    let monday_ms = clock.midnight(monday);
    if period == "this_week" {
        return Some(Window { start_ms: monday_ms, end_ms: Some(clock.now_ms), exact: false });
    }
    let last_monday = clock.midnight(monday - Duration::days(7));
    Some(Window { start_ms: last_monday, end_ms: monday_ms.map(|ms| ms - 1), exact: false })
}

fn rolling_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = ROLLING.captures(period)?;
    let n: i64 = caps.get(1).unwrap_or_default().parse().ok()?;
    let now = clock.now_ms;
    let start = match caps.get(2).unwrap_or_default() {
        "m" => Some(now - n * 60_000),
        "h" => Some(now - n * 3_600_000),
        _ => {
            let local = clock.at(now).naive_local() - Duration::days(n);
            clock.local(local)
        }
    };
    Some(Window { start_ms: start, end_ms: Some(now), exact: false })
}

fn date_range_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = DATE_RANGE.captures(period)?;
    let start = parse_date(caps.get(1).unwrap_or_default()).and_then(|d| clock.midnight(d));
    let end = parse_date(caps.get(2).unwrap_or_default())
        .and_then(|d| NaiveTime::from_hms_milli_opt(23, 59, 59, 999).map(|t| d.and_time(t)))
        .and_then(|naive| clock.local(naive));
    Some(Window { start_ms: start, end_ms: end, exact: false })
}

fn time_of_day_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = TIME_OF_DAY.captures(period)?;
    let base = match caps.get(1) {
        Some(day) => parse_date(day)?,
        None => clock.at(clock.now_ms).date_naive(),
    };
    let number = |i: usize| caps.get(i).unwrap_or_default().parse::<u32>().ok();
    let (sh, sm, eh, em) = (number(2)?, number(3)?, number(4)?, number(5)?);
    if sh > 23 || eh > 23 || sm > 59 || em > 59 {
        return None;
    }
    let start = clock.local(base.and_time(NaiveTime::from_hms_opt(sh, sm, 0)?))?;
    let end = clock.local(base.and_time(NaiveTime::from_hms_milli_opt(eh, em, 59, 999)?))?;
    (end > start).then_some(Window { start_ms: Some(start), end_ms: Some(end), exact: true })
}

fn single_day_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = SINGLE_DAY.captures(period)?;
    let date = parse_date(caps.get(1).unwrap_or_default());
    Some(Window {
        start_ms: date.and_then(|d| clock.midnight(d)),
        end_ms: date
            .and_then(|d| NaiveTime::from_hms_milli_opt(23, 59, 59, 999).map(|t| d.and_time(t)))
            .and_then(|naive| clock.local(naive)),
        exact: true,
    })
}

/// The window a period names. An empty period with a query means the last 30
/// days; `all` and unreadable periods have no window.
pub fn parse_period(clock: &Clock, period: &str, has_query: bool) -> Option<Temporal> {
    let period = if period.is_empty() && has_query { "30d" } else { period };
    if period.is_empty() || period == "all" {
        return None;
    }
    if period == "last" {
        return Some(Temporal::Last);
    }
    let parsers: [fn(&Clock, &str) -> Option<Window>; 6] =
        [day_window, week_window, rolling_window, date_range_window, time_of_day_window, single_day_window];
    parsers.iter().find_map(|parse| parse(clock, period)).map(Temporal::Window)
}

fn relative_unit(word: &str) -> char {
    if word == "분" || word.starts_with("minute") {
        'm'
    } else if word == "시간" || word.starts_with("hour") {
        'h'
    } else {
        'd'
    }
}

static EXPLICIT_RANGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\b(\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})\b", ""));
static EXPLICIT_DATE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\b(\d{4}-\d{2}-\d{2})\b", ""));
static LAST_WEEK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:지난|저번)\s*주|last\s+week", ""));
static THIS_WEEK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"이번\s*주|this\s+week", ""));
static YESTERDAY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"어제|yesterday", ""));
static TODAY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"오늘|today", ""));
static JUST_NOW: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"방금(?:\s*전)?|just\s+now", ""));
static KO_RELATIVE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"(?:최근|지난)\s*(\d+)\s*(분|시간|일)(?:\s*(?:동안|이내|전))?", ""));
static EN_RELATIVE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"(?:last|past)\s*(\d+)\s*(minutes?|hours?|days?)", ""));

/// The period a query's own words imply, when it names one.
pub fn infer_recall_period(query: &str) -> Option<String> {
    let folded: String = query.nfkc().collect::<String>().to_lowercase();
    let text = js_words(&folded).collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    if let Some(m) = EXPLICIT_RANGE.captures(&text) {
        return Some(m.get(1).unwrap_or_default().to_owned());
    }
    if let Some(m) = EXPLICIT_DATE.captures(&text) {
        return Some(m.get(1).unwrap_or_default().to_owned());
    }
    if LAST_WEEK.is_match(&text) {
        return Some("last_week".into());
    }
    if THIS_WEEK.is_match(&text) {
        return Some("this_week".into());
    }
    if YESTERDAY.is_match(&text) {
        return Some("yesterday".into());
    }
    if TODAY.is_match(&text) {
        return Some("today".into());
    }
    if JUST_NOW.is_match(&text) {
        return Some("3h".into());
    }
    for pattern in [&*KO_RELATIVE, &*EN_RELATIVE] {
        if let Some(m) = pattern.captures(&text) {
            let n: u64 = m.get(1).unwrap_or_default().parse().ok()?;
            return Some(format!("{n}{}", relative_unit(m.get(2).unwrap_or_default())));
        }
    }
    None
}

/// `[<local minute> <offset>]` stamp body: a millisecond epoch renders as a
/// local stamp, anything else as its first 16 characters.
pub fn format_ts(clock: &Clock, ts: i64) -> String {
    if ts > 1_000_000_000_000 {
        clock.recall_stamp(ts)
    } else {
        ts.to_string().chars().take(16).collect()
    }
}

pub fn format_local_minute(clock: &Clock, ts: i64) -> String {
    clock.minute_label(ts)
}

/// Hour of the local day, for span headers.
pub fn local_hour(clock: &Clock, ts: i64) -> u32 {
    clock.at(ts).hour()
}
