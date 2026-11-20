//! Recall periods: the grammar callers write (`today`, `3d`, `2026-03-01~2026-03-12`,
//! `09:00~12:00`, `last`), the period a query's own words imply, and the local
//! clock used to turn them into time windows and render stamps.

use mixdog_js::time::{LocalFields, date_parse_in, local_fields_in, local_to_utc_ms_in};
use mixdog_js::{JsRegex, js_words};
use std::sync::LazyLock;

use chrono::{DateTime, TimeZone, Timelike, Utc};
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

    /// The local calendar fields of the clock's instant (`new Date()`'s getters).
    fn today(&self) -> Option<LocalFields> {
        local_fields_in(self.zone, self.now_ms as f64)
    }

    /// `new Date(y, m, d, h, mi, s, ms)` in the clock's zone, through the JavaScript local-time conversion; the day
    /// may leave its month (`d - 1` is the day before). `None` where the Date is invalid.
    fn wall(&self, (year, month, day): (i64, i64, i64), (hour, minute, second, ms): (i64, i64, i64, i64)) -> Option<i64> {
        finite(local_to_utc_ms_in(self.zone, year, month, day, hour, minute, second, ms))
    }

    /// Local midnight of the day `back` days before `day`'s date.
    fn midnight(&self, day: &LocalFields, back: i64) -> Option<i64> {
        self.wall((i64::from(day.year), i64::from(day.month), i64::from(day.day) - back), (0, 0, 0, 0))
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

/// A JavaScript number as a bound: NaN and the infinities are an absent bound, every finite value is kept (a value
/// beyond `i64` saturates).
fn finite(ms: f64) -> Option<i64> {
    ms.is_finite().then_some(ms as i64)
}

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
static DATE_RANGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$", ""));
static TIME_OF_DAY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})$", ""));
static SINGLE_DAY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d{4}-\d{2}-\d{2})$", ""));

/// `Date.parse` of a date and a time of day read as local time (`2026-02-31T00:00:00` is March 3).
fn parse_local(clock: &Clock, day: &str, time: &str) -> Option<i64> {
    finite(date_parse_in(clock.zone, &format!("{day}T{time}")))
}

fn day_window(clock: &Clock, period: &str) -> Option<Window> {
    if period != "today" && period != "yesterday" {
        return None;
    }
    let today = clock.today()?;
    if period == "today" {
        return Some(Window { start_ms: clock.midnight(&today, 0), end_ms: Some(clock.now_ms), exact: false });
    }
    let (year, month, day) = (i64::from(today.year), i64::from(today.month), i64::from(today.day) - 1);
    Some(Window { start_ms: clock.midnight(&today, 1), end_ms: clock.wall((year, month, day), (23, 59, 59, 999)), exact: false })
}

fn week_window(clock: &Clock, period: &str) -> Option<Window> {
    if period != "this_week" && period != "last_week" {
        return None;
    }
    let today = clock.today()?;
    let since_monday = i64::from((today.weekday + 6) % 7);
    let monday_ms = clock.midnight(&today, since_monday);
    if period == "this_week" {
        return Some(Window { start_ms: monday_ms, end_ms: Some(clock.now_ms), exact: false });
    }
    Some(Window { start_ms: clock.midnight(&today, since_monday + 7), end_ms: monday_ms.map(|ms| ms - 1), exact: false })
}

fn rolling_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = ROLLING.captures(period)?;
    // The count is a JavaScript number: minutes and hours are plain subtraction, whatever finite value results.
    let n: f64 = caps.get(1).unwrap_or_default().parse().ok()?;
    let now = clock.now_ms;
    let start = match caps.get(2).unwrap_or_default() {
        "m" => finite(now as f64 - n * 60_000.0),
        "h" => finite(now as f64 - n * 3_600_000.0),
        // `setDate(getDate() - n)`: valid across the Date range, invalid beyond it. Past 2e8 days (twice that range)
        // the answer is invalid anyway; the bound only keeps the day count inside the conversion's integer arithmetic.
        _ => clock.today().filter(|_| n <= 2e8).and_then(|t| {
            let day = (i64::from(t.year), i64::from(t.month), i64::from(t.day) - n as i64);
            clock.wall(day, (i64::from(t.hour), i64::from(t.minute), i64::from(t.second), i64::from(t.millisecond)))
        }),
    };
    Some(Window { start_ms: start, end_ms: Some(now), exact: false })
}

fn date_range_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = DATE_RANGE.captures(period)?;
    let start = parse_local(clock, caps.get(1).unwrap_or_default(), "00:00:00");
    let end = parse_local(clock, caps.get(2).unwrap_or_default(), "23:59:59.999");
    Some(Window { start_ms: start, end_ms: end, exact: false })
}

fn time_of_day_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = TIME_OF_DAY.captures(period)?;
    let base = match caps.get(1) {
        Some(day) => parse_local(clock, day, "00:00:00")?,
        None => clock.now_ms,
    };
    let day = local_fields_in(clock.zone, base as f64)?;
    let day = (i64::from(day.year), i64::from(day.month), i64::from(day.day));
    let number = |i: usize| caps.get(i).unwrap_or_default().parse::<i64>().ok();
    let (sh, sm, eh, em) = (number(2)?, number(3)?, number(4)?, number(5)?);
    if sh > 23 || eh > 23 || sm > 59 || em > 59 {
        return None;
    }
    let start = clock.wall(day, (sh, sm, 0, 0))?;
    let end = clock.wall(day, (eh, em, 59, 999))?;
    (end > start).then_some(Window { start_ms: Some(start), end_ms: Some(end), exact: true })
}

fn single_day_window(clock: &Clock, period: &str) -> Option<Window> {
    let caps = SINGLE_DAY.captures(period)?;
    let date = caps.get(1).unwrap_or_default();
    Some(Window { start_ms: parse_local(clock, date, "00:00:00"), end_ms: parse_local(clock, date, "23:59:59.999"), exact: true })
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
    let parsers: [fn(&Clock, &str) -> Option<Window>; 6] = [day_window, week_window, rolling_window, date_range_window, time_of_day_window, single_day_window];
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

static EXPLICIT_RANGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2})\b", ""));
static EXPLICIT_DATE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\b(\d{4}-\d{2}-\d{2})\b", ""));
static LAST_WEEK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:지난|저번)\s*주|last\s+week", ""));
static THIS_WEEK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"이번\s*주|this\s+week", ""));
static YESTERDAY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"어제|yesterday", ""));
static TODAY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"오늘|today", ""));
static JUST_NOW: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"방금(?:\s*전)?|just\s+now", ""));
static KO_RELATIVE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:최근|지난)\s*(\d+)\s*(분|시간|일)(?:\s*(?:동안|이내|전))?", ""));
static EN_RELATIVE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(?:last|past)\s*(\d+)\s*(minutes?|hours?|days?)", ""));

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
    if ts > 1_000_000_000_000 { clock.recall_stamp(ts) } else { ts.to_string().chars().take(16).collect() }
}

pub fn format_local_minute(clock: &Clock, ts: i64) -> String {
    clock.minute_label(ts)
}

/// Hour of the local day, for span headers.
pub fn local_hour(clock: &Clock, ts: i64) -> u32 {
    clock.at(ts).hour()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(zone: Tz) -> Clock {
        Clock { now_ms: 1_780_000_000_000, zone }
    }

    fn window(clock: &Clock, period: &str) -> Window {
        match parse_period(clock, period, false) {
            Some(Temporal::Window(window)) => window,
            other => panic!("{period}: {other:?}"),
        }
    }

    fn utc_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn a_relative_period_follows_javascript_across_the_date_range() {
        let clock = clock(chrono_tz::UTC);
        // Node, `setDate(getDate() - n)` at this instant in UTC: valid down to the Date limit, invalid beyond it.
        let days = [
            ("100000000d", Some(-8_638_220_000_000_000)),
            ("100020601d", Some(-8_639_999_926_400_000)),
            ("100020602d", None),
            ("99999999999999999d", None),
            ("2d", Some(clock.now_ms - 2 * 86_400_000)),
        ];
        // Node, `now - n * unit`: plain numbers, finite however large (beyond i64 they saturate).
        let numbers =
            [("3000000000h", Some(-10_798_220_000_000_000)), ("6000000000000m", Some(-359_998_220_000_000_000)), ("999999999999999999999m", Some(i64::MIN))];
        for (period, start) in days.into_iter().chain(numbers) {
            let found = window(&clock, period);
            assert_eq!((found.start_ms, found.end_ms), (start, Some(clock.now_ms)), "{period}");
        }
    }

    #[test]
    fn a_day_past_the_end_of_its_month_rolls_into_the_next_as_javascript_dates_do() {
        let clock = clock(chrono_tz::UTC);
        let rolled = window(&clock, "2026-02-31");
        let march = window(&clock, "2026-03-03");
        assert_eq!((rolled.start_ms, rolled.end_ms), (march.start_ms, march.end_ms));
        assert_eq!(rolled.start_ms, Some(utc_ms(2026, 3, 3, 0, 0)));
        let impossible = window(&clock, "2026-13-45");
        assert_eq!((impossible.start_ms, impossible.end_ms), (None, None));
    }

    #[test]
    fn a_wall_time_in_a_dst_gap_is_read_with_the_offset_before_the_gap() {
        let new_york = clock(chrono_tz::America::New_York);
        // 02:30 does not exist on 2026-03-08; it reads as 03:30 EDT.
        let found = window(&new_york, "2026-03-08 02:30~04:30");
        assert_eq!(found.start_ms, Some(utc_ms(2026, 3, 8, 7, 30)));
        // Midnight itself is skipped on 2018-11-04 in São Paulo: it reads as 01:00 -02:00.
        let sao_paulo = clock(chrono_tz::America::Sao_Paulo);
        assert_eq!(window(&sao_paulo, "2018-11-04").start_ms, Some(1_541_300_400_000));
    }
}
