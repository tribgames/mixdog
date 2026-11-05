//! Cron expressions in the 5- or 6-field form schedules store (6 fields add a leading
//! seconds field). Every field must match for a time to fire, the day-of-month and
//! day-of-week fields included; weekday 7 is Sunday; month and weekday names are accepted.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronExpr {
    seconds: Field,
    minutes: Field,
    hours: Field,
    days: Field,
    months: Field,
    weekdays: Field,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Field {
    allowed: Vec<bool>,
    min: u32,
}

impl Field {
    fn matches(&self, value: u32) -> bool {
        value >= self.min && self.allowed.get((value - self.min) as usize).copied().unwrap_or(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError(pub String);

impl std::fmt::Display for CronError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for CronError {}

const MONTH_NAMES: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

fn value_of(token: &str, min: u32, names: Option<(&[&str], u32)>) -> Option<u32> {
    if let Ok(n) = token.parse::<u32>() {
        return Some(n);
    }
    let (names, first) = names?;
    let lower = token.to_ascii_lowercase();
    names.iter().position(|n| *n == lower).map(|i| i as u32 + first).filter(|v| *v >= min)
}

fn parse_field(text: &str, min: u32, max: u32, names: Option<(&[&str], u32)>) -> Option<Field> {
    let mut allowed = vec![false; (max - min + 1) as usize];
    for item in text.split(',') {
        let (range, step) = match item.split_once('/') {
            Some((range, step)) => (range, step.parse::<u32>().ok().filter(|s| *s > 0)?),
            None => (item, 1),
        };
        let (lo, hi) = if range == "*" {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            (value_of(a, min, names)?, value_of(b, min, names)?)
        } else {
            let v = value_of(range, min, names)?;
            // `n/step` runs from n to the end of the field.
            (v, if item.contains('/') { max } else { v })
        };
        if lo < min || hi > max || lo > hi {
            return None;
        }
        let mut v = lo;
        while v <= hi {
            allowed[(v - min) as usize] = true;
            v += step;
        }
    }
    Some(Field { allowed, min })
}

impl CronExpr {
    pub fn parse(expression: &str) -> Result<Self, CronError> {
        let fields: Vec<&str> = mixdog_js::js_words(expression).collect();
        if fields.len() != 5 && fields.len() != 6 {
            return Err(CronError(format!(
                "invalid cron expression \"{}\": expected 5 or 6 fields",
                mixdog_js::js_trim(expression)
            )));
        }
        let invalid = || CronError(format!("invalid cron expression \"{}\"", mixdog_js::js_trim(expression)));
        let (sec, rest) = if fields.len() == 6 { (fields[0], &fields[1..]) } else { ("0", &fields[..]) };
        let mut weekdays = parse_field(rest[4], 0, 7, Some((&WEEKDAY_NAMES, 0))).ok_or_else(invalid)?;
        // 7 is a second spelling of Sunday.
        if weekdays.allowed[7] {
            weekdays.allowed[0] = true;
        }
        Ok(Self {
            seconds: parse_field(sec, 0, 59, None).ok_or_else(invalid)?,
            minutes: parse_field(rest[0], 0, 59, None).ok_or_else(invalid)?,
            hours: parse_field(rest[1], 0, 23, None).ok_or_else(invalid)?,
            days: parse_field(rest[2], 1, 31, None).ok_or_else(invalid)?,
            months: parse_field(rest[3], 1, 12, Some((&MONTH_NAMES, 1))).ok_or_else(invalid)?,
            weekdays,
        })
    }

    fn day_matches(&self, date: NaiveDate) -> bool {
        self.days.matches(date.day()) && self.weekdays.matches(date.weekday().num_days_from_sunday())
    }

    /// The first matching local wall-clock time strictly after `after`.
    fn next_local(&self, after: NaiveDateTime) -> Option<NaiveDateTime> {
        let mut t = after.with_nanosecond(0)? + Duration::seconds(1);
        let limit_year = after.year() + 9; // covers a Feb 29 that falls on a given weekday
        while t.year() <= limit_year {
            if !self.months.matches(t.month()) {
                let (y, m) = if t.month() == 12 { (t.year() + 1, 1) } else { (t.year(), t.month() + 1) };
                t = NaiveDate::from_ymd_opt(y, m, 1)?.and_hms_opt(0, 0, 0)?;
            } else if !self.day_matches(t.date()) {
                t = t.date().succ_opt()?.and_hms_opt(0, 0, 0)?;
            } else if !self.hours.matches(t.hour()) {
                t = t.date().and_hms_opt(t.hour(), 0, 0)? + Duration::hours(1);
            } else if !self.minutes.matches(t.minute()) {
                t = t.date().and_hms_opt(t.hour(), t.minute(), 0)? + Duration::minutes(1);
            } else if !self.seconds.matches(t.second()) {
                t += Duration::seconds(1);
            } else {
                return Some(t);
            }
        }
        None
    }

    /// The first fire instant strictly after `after`, in `tz` wall-clock terms. A wall time
    /// that occurs twice fires at its first occurrence; one a clock change skips never fires.
    pub fn next_after(&self, after: DateTime<Utc>, tz: Tz) -> Option<DateTime<Utc>> {
        let mut local = after.with_timezone(&tz).naive_local();
        loop {
            local = self.next_local(local)?;
            let instant = match tz.from_local_datetime(&local) {
                LocalResult::Single(t) => t,
                LocalResult::Ambiguous(first, _) => first,
                LocalResult::None => continue,
            }
            .with_timezone(&Utc);
            if instant > after {
                return Some(instant);
            }
        }
    }
}

/// What one heartbeat of node-cron decides (`planBeat`, node-cron `_shared.cjs`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeatPlan {
    /// Slots that passed unrun: only logged, never run.
    pub missed: Vec<DateTime<Utc>>,
    /// The slot to run now: the one the beat is at most `tolerance_ms` late for.
    pub run: Option<DateTime<Utc>>,
    /// The slot the next beat waits for, computed from the present, never replayed.
    pub next: Option<DateTime<Utc>>,
}

/// Port of node-cron's `planBeat`: walks from the expected slot; a slot more than the
/// tolerance late (or at least a whole gap late) is missed, and the walk ends at the first
/// slot still ahead or runnable.
pub fn plan_beat(
    expected: DateTime<Utc>,
    now: DateTime<Utc>,
    tolerance_ms: i64,
    next_match: impl Fn(DateTime<Utc>) -> Option<DateTime<Utc>>,
) -> BeatPlan {
    let mut missed = Vec::new();
    let mut slot = expected;
    loop {
        if now < slot {
            return BeatPlan { missed, run: None, next: Some(slot) };
        }
        let next = match next_match(slot) {
            Some(next) if next > slot => next,
            _ => return BeatPlan { missed, run: None, next: next_match(now) },
        };
        let gap = (next - slot).num_milliseconds();
        let late_by = (now - slot).num_milliseconds();
        if late_by <= tolerance_ms && late_by < gap {
            return BeatPlan { missed, run: Some(slot), next: Some(next) };
        }
        missed.push(slot);
        slot = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    #[test]
    fn rejects_bad_field_counts_and_values() {
        assert!(CronExpr::parse("* * * *").is_err());
        assert!(CronExpr::parse("61 * * * *").is_err());
        assert!(CronExpr::parse("*/0 * * * *").is_err());
        assert!(CronExpr::parse("* * * * * * *").is_err());
        assert!(CronExpr::parse("0 9 * * mon-fri").is_ok());
    }

    #[test]
    fn daily_in_utc() {
        let c = CronExpr::parse("30 9 * * *").unwrap();
        assert_eq!(c.next_after(utc("2025-01-01T09:30:00Z"), Tz::UTC), Some(utc("2025-01-02T09:30:00Z")));
        assert_eq!(c.next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC), Some(utc("2025-01-01T09:30:00Z")));
    }

    #[test]
    fn weekdays_and_sunday_seven() {
        let c = CronExpr::parse("0 8 * * 1-5").unwrap();
        // 2025-01-04 is a Saturday.
        assert_eq!(c.next_after(utc("2025-01-04T00:00:00Z"), Tz::UTC), Some(utc("2025-01-06T08:00:00Z")));
        let sun = CronExpr::parse("0 8 * * 7").unwrap();
        assert_eq!(sun.next_after(utc("2025-01-04T00:00:00Z"), Tz::UTC), Some(utc("2025-01-05T08:00:00Z")));
    }

    #[test]
    fn six_fields_lead_with_seconds() {
        let c = CronExpr::parse("*/15 * * * * *").unwrap();
        assert_eq!(c.next_after(utc("2025-01-01T00:00:50Z"), Tz::UTC), Some(utc("2025-01-01T00:01:00Z")));
    }

    #[test]
    fn timezone_shifts_the_instant() {
        let c = CronExpr::parse("0 9 * * *").unwrap();
        let seoul = chrono_tz::Asia::Seoul;
        assert_eq!(c.next_after(utc("2025-01-01T00:00:00Z"), seoul), Some(utc("2025-01-01T00:00:00Z") + Duration::days(1)));
    }

    #[test]
    fn skipped_wall_time_does_not_fire_that_day() {
        // 2025-03-09 02:30 does not exist in New York.
        let c = CronExpr::parse("30 2 * * *").unwrap();
        let ny = chrono_tz::America::New_York;
        assert_eq!(c.next_after(utc("2025-03-09T00:00:00Z"), ny), Some(utc("2025-03-10T06:30:00Z")));
    }

    #[test]
    fn plan_beat_runs_an_on_time_slot_and_only_logs_the_missed_ones() {
        let c = CronExpr::parse("0 9 * * *").unwrap();
        let next = |d| c.next_after(d, Tz::UTC);
        let expected = utc("2025-01-01T09:00:00Z");
        // On time (within the 1 s tolerance): run it, wait for the next day.
        let plan = plan_beat(expected, utc("2025-01-01T09:00:01Z"), 1000, next);
        assert_eq!((plan.run, plan.next, plan.missed.len()), (Some(expected), Some(utc("2025-01-02T09:00:00Z")), 0));
        // Early (a capped wait): nothing runs, the same slot is awaited.
        let plan = plan_beat(expected, utc("2025-01-01T08:00:00Z"), 1000, next);
        assert_eq!((plan.run, plan.next), (None, Some(expected)));
        // A two-day jump: both elapsed slots are missed, none runs, the next is from now.
        let plan = plan_beat(expected, utc("2025-01-03T09:30:00Z"), 1000, next);
        assert_eq!(plan.run, None);
        assert_eq!(plan.missed, vec![expected, utc("2025-01-02T09:00:00Z"), utc("2025-01-03T09:00:00Z")]);
        assert_eq!(plan.next, Some(utc("2025-01-04T09:00:00Z")));
    }

    #[test]
    fn feb_29_is_found_across_years() {
        let c = CronExpr::parse("0 0 29 2 *").unwrap();
        assert_eq!(c.next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC), Some(utc("2028-02-29T00:00:00Z")));
    }
}
