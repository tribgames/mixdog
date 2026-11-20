//! Cron expressions as node-cron 4.6.0 reads them (`validate`, `convertExpression`, `TimeMatcher`):
//! 5 or 6 fields (6 add a leading seconds field), names, `*`, ranges (a descending one wraps),
//! steps on ranges, `L`, `L-n`, `nW`, `LW`, `nL`, `d#n` and `?`. Every field must match for a
//! time to fire, the day-of-month and day-of-week fields included; weekday 7 is Sunday.

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, Offset, TimeZone, Timelike, Utc};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronExpr {
    seconds: Vec<u32>,
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: DayField,
    months: [bool; 13],
    weekdays: WeekdayField,
}

/// The day-of-month list: numbers plus `L`, `L-n`, `nW` (`None` is `LW`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DayField {
    numbers: Vec<u32>,
    last: bool,
    last_offsets: Vec<u32>,
    nearest_weekday: Vec<Option<u32>>,
}

/// The day-of-week list: numbers (0 is Sunday) plus `nL` and `d#n`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct WeekdayField {
    numbers: Vec<u32>,
    last: Vec<u32>,
    nth: Vec<(u32, u32)>,
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(y, m, 1).and_then(|d| d.pred_opt()).map_or(31, |d| d.day())
}

fn nearest_weekday(year: i32, month: u32, target: u32) -> Option<u32> {
    let last = last_day_of_month(year, month);
    if target < 1 || target > last {
        return None;
    }
    Some(match NaiveDate::from_ymd_opt(year, month, target)?.weekday().num_days_from_sunday() {
        6 if target == 1 => 3,
        6 => target - 1,
        0 if target == last => target - 2,
        0 => target + 1,
        _ => target,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError(pub String);

impl std::fmt::Display for CronError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

const MONTH_NAMES: [&str; 12] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_NAMES: [&str; 7] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const NICKNAMES: [(&str, &str); 7] = [
    ("@yearly", "0 0 1 1 *"),
    ("@annually", "0 0 1 1 *"),
    ("@monthly", "0 0 1 * *"),
    ("@weekly", "0 0 * * 0"),
    ("@daily", "0 0 * * *"),
    ("@midnight", "0 0 * * *"),
    ("@hourly", "0 * * * *"),
];
const MAX_DAYS_IN_MONTH: [u32; 13] = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/// node-cron's `MAX_DAYS`: the walker looks 366 * 100 days ahead of its base, once.
const SEARCH_DAYS: i64 = 366 * 100;
/// `{min, max}` of each field in node-cron's order (second, minute, hour, day, month, weekday): what a wrapping range
/// wraps through (a weekday wraps at 6) ...
const WRAP_BOUNDS: [(i64, i64); 6] = [(0, 59), (0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];
/// ... and the largest value validation accepts.
const VALID_MAX: [i64; 6] = [59, 59, 23, 31, 12, 7];
const VALID_MIN: [i64; 6] = [0, 0, 0, 1, 1, 0];

/// A member of a field's list after node-cron's normalization: a number, or text that only a special
/// form (`L`, `5W`, `1#2` ...) may be.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Tok {
    Num(i64),
    Text(String),
}

/// `replace(new RegExp(name, 'gi'), n)` over each name in turn.
fn replace_names(text: &str, names: &[&str], first: usize) -> String {
    let mut out = text.to_owned();
    for (i, name) in names.iter().enumerate() {
        let mut next = String::new();
        let lower = out.to_ascii_lowercase();
        let mut at = 0;
        while let Some(found) = lower[at..].find(name) {
            next.push_str(&out[at..at + found]);
            next.push_str(&(i + first).to_string());
            at += found + name.len();
        }
        next.push_str(&out[at..]);
        out = next;
    }
    out
}

fn parse_num(digits: &str) -> i64 {
    digits.bytes().fold(0i64, |n, b| n.saturating_mul(10).saturating_add(i64::from(b - b'0'))).min(1 << 50)
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// `^(\d+)-(\d+)(?:\/(\d+))?$`.
fn range_parts(token: &str) -> Option<(&str, &str, Option<&str>)> {
    let (first, rest) = token.split_once('-')?;
    let (last, step) = match rest.split_once('/') {
        Some((last, step)) => (last, Some(step)),
        None => (rest, None),
    };
    (all_digits(first) && all_digits(last) && step.is_none_or(all_digits)).then_some((first, last, step))
}

/// `expandRange`: the members of `first-last/step`, a descending range wrapping through the field's bounds. A member
/// past what validation accepts ends the expansion with a marker no number can be.
fn expand_range(first: &str, last: &str, step: Option<&str>, field: usize) -> Vec<String> {
    let step_text = step.unwrap_or("1");
    let step_value = parse_num(step_text);
    if step_value < 1 {
        return vec![format!("{first}-{last}/{step_text}")];
    }
    let (first_n, last_n) = (parse_num(first), parse_num(last));
    let mut out = Vec::new();
    if first_n <= last_n {
        let mut i = first_n;
        while i <= last_n {
            if i > VALID_MAX[field] {
                out.push("x".to_owned());
                break;
            }
            out.push(i.to_string());
            i += step_value;
        }
        return out;
    }
    let (min, max) = WRAP_BOUNDS[field];
    let size = max - min + 1;
    let span = ((last_n - first_n) % size + size) % size;
    let mut offset = 0;
    while offset <= span {
        let mut value = first_n + offset;
        if value > max {
            value -= size;
        }
        out.push(value.to_string());
        offset += step_value;
    }
    out
}

fn is_digit_then(text: &str, tail: &str) -> bool {
    text.len() == 1 + tail.len() && text.as_bytes()[0] <= b'7' && text.as_bytes()[0] >= b'0' && text[1..].eq_ignore_ascii_case(tail)
}

/// `normalizeIntegers` on one member.
fn normalize(token: &str) -> Tok {
    let token = mixdog_js::js_trim(token);
    let lower = token.to_ascii_lowercase();
    let l_offset = lower.strip_prefix("l-").is_some_and(|n| (1..=2).contains(&n.len()) && all_digits(n));
    if lower == "l" || l_offset || is_digit_then(token, "l") || lower.contains('w') {
        Tok::Text(token.to_ascii_uppercase())
    } else if token.contains('#') {
        Tok::Text(token.to_owned())
    } else if all_digits(token) {
        Tok::Num(parse_num(token))
    } else {
        Tok::Text(token.to_owned())
    }
}

/// `convertExpression` for a 6-field list: each field as its normalized members.
fn interpret(fields: &[String; 6]) -> [Vec<Tok>; 6] {
    const STARS: [&str; 6] = ["0-59", "0-59", "0-23", "1-31", "1-12", "0-6"];
    let mut fields = fields.clone();
    for i in [3, 5] {
        if fields[i] == "?" {
            fields[i] = "*".to_owned();
        }
    }
    fields[4] = replace_names(&replace_names(&fields[4], &MONTH_NAMES, 1), &MONTH_SHORT, 1);
    fields[5] = replace_names(&replace_names(&fields[5], &WEEKDAY_NAMES, 0), &WEEKDAY_SHORT, 0);
    let mut out: [Vec<Tok>; 6] = Default::default();
    for (i, field) in fields.iter().enumerate() {
        for item in field.split(',') {
            // `convertAsterisk`: the first `*` of a member becomes the field's range.
            let item = if item.contains('*') { item.replacen('*', STARS[i], 1) } else { item.to_owned() };
            match range_parts(mixdog_js::js_trim(&item)) {
                Some((first, last, step)) => out[i].extend(expand_range(first, last, step, i).iter().map(|m| normalize(m))),
                None => out[i].push(normalize(&item)),
            }
        }
    }
    // 7 is a second spelling of Sunday, also in `7L` and `7#n`.
    let mut weekdays: Vec<Tok> = Vec::new();
    for tok in std::mem::take(&mut out[5]) {
        let tok = match tok {
            Tok::Num(7) => Tok::Num(0),
            Tok::Text(text) if text.starts_with('7') => Tok::Text(format!("0{}", &text[1..])),
            other => other,
        };
        if !weekdays.contains(&tok) {
            weekdays.push(tok);
        }
    }
    out[5] = weekdays;
    out
}

/// A repeated member adds nothing to a field, and every candidate date is checked against each one kept.
fn push_unique<T: PartialEq>(list: &mut Vec<T>, item: T) {
    if !list.contains(&item) {
        list.push(item);
    }
}

fn nth_weekday(text: &str) -> Option<(u32, u32)> {
    let (d, n) = text.split_once('#')?;
    let ok = |s: &str, hi: u8| s.len() == 1 && (b'0'..=hi).contains(&s.as_bytes()[0]);
    (ok(d, b'7') && ok(n, b'5') && n != "0").then(|| (d.parse::<u32>().unwrap() % 7, n.parse().unwrap()))
}

fn last_weekday(text: &str) -> Option<u32> {
    is_digit_then(text, "L").then(|| u32::from(text.as_bytes()[0] - b'0') % 7)
}

/// `^(\d{1,2}|L)W$` (case-insensitive): the target, `None` for `LW`.
fn w_token(text: &str) -> Option<Option<i64>> {
    let body = text.strip_suffix(['W', 'w'])?;
    if body.eq_ignore_ascii_case("l") {
        return Some(None);
    }
    ((1..=2).contains(&body.len()) && all_digits(body)).then(|| Some(parse_num(body)))
}

fn l_offset(text: &str) -> Option<i64> {
    let n = text.get(..2).filter(|p| p.eq_ignore_ascii_case("l-")).and(text.get(2..))?;
    ((1..=2).contains(&n.len()) && all_digits(n)).then(|| parse_num(n))
}

impl CronExpr {
    /// A schedule's expression as Mixdog stores it: five or six fields, then node-cron's `validate`.
    pub fn parse(expression: &str) -> Result<Self, CronError> {
        let count = mixdog_js::js_words(expression).count();
        if count != 5 && count != 6 {
            return Err(CronError(format!("invalid cron expression \"{}\": expected 5 or 6 fields", mixdog_js::js_trim(expression))));
        }
        Self::parse_node_cron(expression)
    }

    /// What `cron.validate` accepts and `cron.schedule` arms, nicknames (`@daily`) included.
    pub fn parse_node_cron(expression: &str) -> Result<Self, CronError> {
        let invalid = || CronError(format!("invalid cron expression \"{}\"", mixdog_js::js_trim(expression)));
        let key = mixdog_js::js_trim(expression).to_lowercase();
        let resolved = NICKNAMES.iter().find(|(name, _)| *name == key).map_or(expression, |(_, expanded)| expanded);
        if resolved.is_empty() || !resolved.bytes().all(|b| b.is_ascii_alphanumeric() || b"-*/,#? ".contains(&b)) {
            return Err(invalid());
        }
        let words: Vec<&str> = resolved.split(' ').filter(|w| !w.is_empty()).collect();
        if words.len() != 5 && words.len() != 6 {
            return Err(invalid());
        }
        let mut raw: Vec<String> = words.iter().map(|w| (*w).to_owned()).collect();
        if raw.len() == 5 {
            raw.insert(0, "0".to_owned());
        }
        let raw_dom = raw[3].clone();
        let fields: [String; 6] = raw.try_into().map_err(|_| invalid())?;
        let [seconds, minutes, hours, days, months, weekdays] = interpret(&fields);
        let numbers = |list: &[Tok], field: usize| -> Option<Vec<u32>> {
            list.iter()
                .map(|tok| match tok {
                    Tok::Num(n) if (VALID_MIN[field]..=VALID_MAX[field]).contains(n) => Some(*n as u32),
                    _ => None,
                })
                .collect()
        };
        let sorted = |mut list: Vec<u32>| {
            list.sort_unstable();
            list.dedup();
            list
        };
        let seconds = sorted(numbers(&seconds, 0).ok_or_else(invalid)?);
        let minutes = sorted(numbers(&minutes, 1).ok_or_else(invalid)?);
        let hours = sorted(numbers(&hours, 2).ok_or_else(invalid)?);
        // Day of month: the special members leave the list, the rest are checked as numbers.
        if raw_dom.to_ascii_lowercase().contains('w')
            && raw_dom.split(',').any(|t| t.to_ascii_lowercase().contains('w') && w_token(mixdog_js::js_trim(t)).is_none())
        {
            return Err(invalid());
        }
        let mut day_field = DayField::default();
        let mut plain = Vec::new();
        for tok in days {
            match &tok {
                Tok::Text(text) if text == "L" => day_field.last = true,
                Tok::Text(text) if w_token(text).is_some() => match w_token(text).unwrap() {
                    None => push_unique(&mut day_field.nearest_weekday, None),
                    Some(target) if (1..=31).contains(&target) => push_unique(&mut day_field.nearest_weekday, Some(target as u32)),
                    Some(_) => return Err(invalid()),
                },
                Tok::Text(text) if l_offset(text).is_some() => match l_offset(text).unwrap() {
                    n if (1..=30).contains(&n) => push_unique(&mut day_field.last_offsets, n as u32),
                    _ => return Err(invalid()),
                },
                _ => plain.push(tok),
            }
        }
        day_field.numbers = sorted(numbers(&plain, 3).ok_or_else(invalid)?);
        let months_list = numbers(&months, 4).ok_or_else(invalid)?;
        let mut month_set = [false; 13];
        for m in &months_list {
            month_set[*m as usize] = true;
        }
        let mut weekday_field = WeekdayField::default();
        let mut plain = Vec::new();
        for tok in weekdays {
            match &tok {
                Tok::Text(text) if nth_weekday(text).is_some() => push_unique(&mut weekday_field.nth, nth_weekday(text).unwrap()),
                Tok::Text(text) if last_weekday(text).is_some() => push_unique(&mut weekday_field.last, last_weekday(text).unwrap()),
                _ => plain.push(tok),
            }
        }
        weekday_field.numbers = sorted(numbers(&plain, 5).ok_or_else(invalid)?);
        // `isImpossibleDayOfMonth`: only plain day numbers, none that exists in any listed month.
        let only_numbers = !day_field.last && day_field.last_offsets.is_empty() && day_field.nearest_weekday.is_empty();
        if only_numbers && !months_list.iter().any(|m| day_field.numbers.iter().any(|d| *d <= MAX_DAYS_IN_MONTH[*m as usize])) {
            return Err(invalid());
        }
        Ok(Self { seconds, minutes, hours, days: day_field, months: month_set, weekdays: weekday_field })
    }

    fn day_matches(&self, date: NaiveDate) -> bool {
        let (year, month, day) = (date.year(), date.month(), date.day());
        let weekday = date.weekday().num_days_from_sunday();
        let last = last_day_of_month(year, month);
        let days = &self.days;
        let day_ok = days.numbers.contains(&day)
            || (days.last && day == last)
            || days.last_offsets.iter().any(|n| last.checked_sub(*n).is_some_and(|d| d >= 1 && d == day))
            || days.nearest_weekday.iter().any(|t| nearest_weekday(year, month, t.unwrap_or(last)) == Some(day));
        let weekdays = &self.weekdays;
        let weekday_ok = weekdays.numbers.contains(&weekday)
            || (weekdays.last.contains(&weekday) && day + 7 > last)
            || weekdays.nth.iter().any(|(w, n)| *w == weekday && (day - 1) / 7 + 1 == *n);
        day_ok && weekday_ok
    }

    /// `TimeMatcher.match`: the whole expression against the wall clock of `local`.
    fn matches_local(&self, local: NaiveDateTime) -> bool {
        self.seconds.contains(&local.second())
            && self.minutes.contains(&local.minute())
            && self.hours.contains(&local.hour())
            && self.months[local.month() as usize]
            && self.day_matches(local.date())
    }

    /// `firstTimeOnDay`: the day's hours, minutes and seconds in ascending order; a wall time is turned into an
    /// instant and counts when that instant is after `base` and the whole expression matches its own wall clock
    /// (a time a clock change skipped resolves to the later instant and is judged there).
    fn first_time_on_day<Z: TimeZone>(&self, date: NaiveDate, lower: Option<NaiveDateTime>, base: i64, tz: &Z) -> Option<i64> {
        for &hour in &self.hours {
            if lower.is_some_and(|l| hour < l.hour()) {
                continue;
            }
            for &minute in &self.minutes {
                for &second in &self.seconds {
                    if lower.is_some_and(|l| hour * 3600 + minute * 60 + second <= l.hour() * 3600 + l.minute() * 60 + l.second()) {
                        continue;
                    }
                    let local = date.and_hms_opt(hour, minute, second)?;
                    let Some(ts) = resolve_local(tz, local) else { continue };
                    let Some(at) = DateTime::from_timestamp(ts, 0) else { continue };
                    if ts > base && self.matches_local(at.with_timezone(tz).naive_local()) {
                        return Some(ts);
                    }
                }
            }
        }
        None
    }

    /// `getNextMatch(after)` (`MatcherWalker.matchNext`): the first fire instant strictly after `after`, searching 36600
    /// days from `after`'s own day - one deadline, however many wall times fail on the way.
    pub fn next_after<Z: TimeZone>(&self, after: DateTime<Utc>, tz: Z) -> Option<DateTime<Utc>> {
        let base = after.timestamp();
        let base_local = DateTime::from_timestamp(base, 0)?.with_timezone(&tz).naive_local();
        let mut date = base_local.date();
        let limit = date + Duration::days(SEARCH_DAYS - 1);
        while date <= limit {
            if !self.months[date.month() as usize] {
                let (y, m) = if date.month() == 12 { (date.year() + 1, 1) } else { (date.year(), date.month() + 1) };
                date = NaiveDate::from_ymd_opt(y, m, 1)?;
                continue;
            }
            if self.day_matches(date) {
                let lower = (date == base_local.date()).then_some(base_local);
                if let Some(ts) = self.first_time_on_day(date, lower, base, &tz) {
                    return DateTime::from_timestamp(ts, 0);
                }
            }
            date = date.succ_opt()?;
        }
        None
    }
}

/// Port of node-cron's `localTimeToTimestamp` (seconds since the epoch): the wall time read as UTC, corrected by
/// the zone's offset there and again by the offset at the result. When the two offsets differ and neither result
/// reads back as the wall time (a skipped one), the later of the two stands.
fn resolve_local<Z: TimeZone>(tz: &Z, local: NaiveDateTime) -> Option<i64> {
    let offset = |ts: i64| -> Option<i64> {
        let at = DateTime::from_timestamp(ts, 0)?.naive_utc();
        Some(i64::from(tz.offset_from_utc_datetime(&at).fix().local_minus_utc()))
    };
    let reads_back = |ts: i64| DateTime::from_timestamp(ts, 0).is_some_and(|t| t.with_timezone(tz).naive_local() == local);
    let guess = local.and_utc().timestamp();
    let first = offset(guess)?;
    let candidate1 = guess - first;
    let second = offset(candidate1)?;
    if second == first {
        return Some(candidate1);
    }
    let candidate2 = guess - second;
    Some(if reads_back(candidate1) {
        candidate1
    } else if reads_back(candidate2) {
        candidate2
    } else {
        candidate1.max(candidate2)
    })
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
pub fn plan_beat(expected: DateTime<Utc>, now: DateTime<Utc>, tolerance_ms: i64, next_match: impl Fn(DateTime<Utc>) -> Option<DateTime<Utc>>) -> BeatPlan {
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
    use chrono_tz::Tz;

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
        assert!(CronExpr::parse("0 9 * Janu Monday").is_err());
        assert!(CronExpr::parse("0 9 * January Monsoon").is_err());
    }

    #[test]
    fn named_months_and_weekdays_match_local_time() {
        let seoul = chrono_tz::Asia::Seoul;
        // Start just before 09:00 on a Monday in December; the first January Monday is the 6th.
        let after = utc("2024-12-29T23:59:59Z");
        for expression in ["0 9 * January Monday", "0 9 * JaN mOn"] {
            let c = CronExpr::parse(expression).unwrap();
            assert_eq!(c.next_after(after, seoul), Some(utc("2025-01-06T00:00:00Z")));
        }

        let c = CronExpr::parse("0 9 * jAnUaRy,March Monday-Friday/2").unwrap();
        assert_eq!(c.next_after(utc("2025-01-06T00:00:00Z"), seoul), Some(utc("2025-01-08T00:00:00Z")));
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
    fn node_cron_special_forms_are_accepted_and_match() {
        let next = |e: &str, after: &str| CronExpr::parse(e).unwrap().next_after(utc(after), Tz::UTC);
        assert_eq!(next("0 9 L * *", "2025-01-01T00:00:00Z"), Some(utc("2025-01-31T09:00:00Z")));
        assert_eq!(next("0 9 L-2 * *", "2025-02-01T00:00:00Z"), Some(utc("2025-02-26T09:00:00Z")));
        assert_eq!(next("0 9 * * 1#1", "2025-01-02T00:00:00Z"), Some(utc("2025-01-06T09:00:00Z")));
        assert_eq!(next("0 9 * * 5L", "2025-01-01T00:00:00Z"), Some(utc("2025-01-31T09:00:00Z")));
        assert_eq!(next("0 9 15W * *", "2025-03-01T00:00:00Z"), Some(utc("2025-03-14T09:00:00Z")));
        // A wrapping range covers 22, 23, 0, 1, 2.
        assert_eq!(next("0 22-2 * * *", "2025-01-02T03:00:00Z"), Some(utc("2025-01-02T22:00:00Z")));
        assert_eq!(next("0 22-2 * * *", "2025-01-02T22:00:00Z"), Some(utc("2025-01-02T23:00:00Z")));
        assert_eq!(next("0 22-2 * * *", "2025-01-02T23:00:00Z"), Some(utc("2025-01-03T00:00:00Z")));
        assert_eq!(next("0 22-2 * * *", "2025-01-03T02:00:00Z"), Some(utc("2025-01-03T22:00:00Z")));
    }

    #[test]
    fn ambiguous_wall_time_resolves_like_node_cron() {
        let c = CronExpr::parse("30 2 * * *").unwrap();
        // Berlin 02:30 occurs twice on 2025-10-26; node-cron picks standard time (01:30Z).
        let berlin = chrono_tz::Europe::Berlin;
        assert_eq!(c.next_after(utc("2025-10-26T00:00:00Z"), berlin), Some(utc("2025-10-26T01:30:00Z")));
        // New York 01:30 on 2025-11-02: node-cron picks the first (daylight) occurrence.
        let c = CronExpr::parse("30 1 * * *").unwrap();
        let ny = chrono_tz::America::New_York;
        assert_eq!(c.next_after(utc("2025-11-02T00:00:00Z"), ny), Some(utc("2025-11-02T05:30:00Z")));
    }

    #[test]
    fn rare_schedules_are_found_up_to_a_century_ahead() {
        // Feb 29 on a Monday can be 28 years away.
        let c = CronExpr::parse("0 0 29 2 1").unwrap();
        assert_eq!(c.next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC), Some(utc("2044-02-29T00:00:00Z")));
    }

    /// Cases checked against node-cron 4.6.0's `validate` (valid = true).
    #[test]
    fn acceptance_follows_node_cron() {
        for ok in [
            "0 9 * * FriL",
            "0 9 * * Monday#2",
            "0 9 * * 7L",
            "0 9 * * 7#1",
            "0 24-2 * * *",
            "0 9 ? * ?",
            "0 9 15w * *",
            "0 9 LW * *",
            "0 9 L-30 * *",
            "*/5 * * * * *",
            "0 9 * * 5-1",
        ] {
            assert!(CronExpr::parse(ok).is_ok(), "{ok}");
        }
        for bad in [
            "0 9 L, * *",
            "0 9 * * 1#1,",
            "0 9 * * L",
            "0 9 * * 6#6",
            "0 9 * * 1#0",
            "0 9 L-31 * *",
            "0 9 0W * *",
            "0 9 5W/2 * *",
            "0 9 * * 5/2",
            "0 99-2 * * *",
            "0 0 5-1 13 *",
            "0 0 31 2 *",
            "0 9 1,,2 * *",
            "0 25 * * *",
            "0\t9 * * *",
            "0 9 * * 9-1",
        ] {
            assert!(CronExpr::parse(bad).is_err(), "{bad}");
        }
        // The nickname is what `cron.validate` takes, not what a stored schedule may hold.
        assert!(CronExpr::parse("@daily").is_err());
        assert!(CronExpr::parse_node_cron("@daily").is_ok());
    }

    #[test]
    fn weekday_names_with_suffixes_match() {
        let next = |e: &str| CronExpr::parse(e).unwrap().next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC);
        assert_eq!(next("0 9 * * FriL"), Some(utc("2025-01-31T09:00:00Z")));
        assert_eq!(next("0 9 * * Monday#2"), Some(utc("2025-01-13T09:00:00Z")));
    }

    #[test]
    fn a_skipped_wall_time_resolves_to_the_later_instant_and_is_judged_there() {
        // Lord Howe's 2025-10-05 02:00 -> 02:30 gap: 02:10 resolves to 02:40, which matches minute 40, and it comes before
        // 02:30 in node-cron's ascending walk of the day's wall times.
        let c = CronExpr::parse("10,30,40 2 * * *").unwrap();
        assert_eq!(c.next_after(utc("2025-10-04T15:29:59Z"), chrono_tz::Australia::Lord_Howe), Some(utc("2025-10-04T15:40:00Z")));
    }

    #[test]
    fn a_search_that_finds_nothing_ends_at_one_deadline() {
        // `L-30` is the 1st only of a 31-day month, so in February it never fires; a repeated list adds no work.
        let never = CronExpr::parse("0 9 L-30 FEB *").unwrap();
        assert_eq!(never.next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC), None);
        let repeated = CronExpr::parse(&format!("0 9 {} FEB *", ["31W"; 5000].join(","))).unwrap();
        assert_eq!(repeated.days.nearest_weekday.len(), 1);
        assert_eq!(repeated.next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC), None);
        // A fifth Monday is never the 1st; repeated plain numbers are kept once too.
        let numbers = CronExpr::parse(&format!("0 9 {} * Mon#5", ["1"; 5000].join(","))).unwrap();
        assert_eq!(numbers.days.numbers, [1]);
        assert_eq!(numbers.next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC), None);
        // Twenty-four years on is still inside the 36600 days (node-cron gives 2124-02-29 too).
        let c = CronExpr::parse("0 0 29 2 2#5").unwrap();
        assert_eq!(c.next_after(utc("2100-03-01T00:00:00Z"), Tz::UTC), Some(utc("2124-02-29T00:00:00Z")));
    }

    #[test]
    fn feb_29_is_found_across_years() {
        let c = CronExpr::parse("0 0 29 2 *").unwrap();
        assert_eq!(c.next_after(utc("2025-01-01T00:00:00Z"), Tz::UTC), Some(utc("2028-02-29T00:00:00Z")));
    }
}

impl std::error::Error for CronError {}
