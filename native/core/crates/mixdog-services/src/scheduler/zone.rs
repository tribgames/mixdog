//! The time zone a schedule runs in, resolved the way `Intl.DateTimeFormat` resolves a `timeZone` (Node's
//! `resolveScheduleTimezone` validated through it, and kept the spelling the user typed). One resolver serves
//! validation and arming, so a spelling is armed exactly when it is valid.
//!
//! What `Intl` accepted there (Node v22.20.0, ICU 77.1, CLDR 47, tzdata 2025b), and what this resolves:
//! - IANA names and links, in any letter case (`chrono_tz`, tzdata 2025b);
//! - fixed offsets `±HH`, `±HHMM`, `±HH:MM` with the sign `+`, `-` or U+2212, hours 00-23, minutes 00-59
//!   (`+24:00`, `+9`, `+09:60`, `UTC+9` are refused);
//! - the aliases ICU resolves that tzdata does not carry: CLDR 47 `common/bcp47/timezone.xml` aliases
//!   (`Canada/East-Saskatchewan`, `US/Pacific-New`), ICU's legacy three-letter ids (`PST`, `CST`, `ACT`, ...)
//!   and ICU's `SystemV/*` ids. The target of each is the zone ICU resolves it to (`resolvedOptions().timeZone`),
//!   confirmed against `Intl` offsets across 1970-2037 for the named targets. The `SystemV/*` ids with a daylight
//!   half keep ICU's fixed rule (daylight time from the last Sunday of April 02:00 standard to the last Sunday of
//!   October 02:00 daylight, every year), which no tzdata zone carries; it is applied to every instant, where ICU
//!   used other rules before 1976.

use chrono::{Datelike, Duration, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, Offset, TimeZone, Weekday};
use chrono_tz::Tz;

/// ICU legacy ids and CLDR aliases that are not tzdata names, with the zone ICU resolves each to.
const ALIASES: &[(&str, &str)] = &[
    ("Canada/East-Saskatchewan", "America/Regina"),
    ("US/Pacific-New", "America/Los_Angeles"),
    ("ACT", "Australia/Darwin"),
    ("AET", "Australia/Sydney"),
    ("AGT", "America/Buenos_Aires"),
    ("ART", "Africa/Cairo"),
    ("AST", "America/Anchorage"),
    ("BET", "America/Sao_Paulo"),
    ("BST", "Asia/Dhaka"),
    ("CAT", "Africa/Maputo"),
    ("CNT", "America/St_Johns"),
    ("CST", "America/Chicago"),
    ("CTT", "Asia/Shanghai"),
    ("EAT", "Africa/Nairobi"),
    ("ECT", "Europe/Paris"),
    ("IET", "America/Indianapolis"),
    ("IST", "Asia/Calcutta"),
    ("JST", "Asia/Tokyo"),
    ("MIT", "Pacific/Apia"),
    ("NET", "Asia/Yerevan"),
    ("NST", "Pacific/Auckland"),
    ("PLT", "Asia/Karachi"),
    ("PNT", "America/Phoenix"),
    ("PRT", "America/Puerto_Rico"),
    ("PST", "America/Los_Angeles"),
    ("SST", "Pacific/Guadalcanal"),
    ("VST", "Asia/Saigon"),
];

/// ICU's `SystemV/*` ids: the standard offset in hours west of UTC, and whether it has the daylight half.
const SYSTEM_V: &[(&str, i32, bool)] = &[
    ("SystemV/AST4", 4, false),
    ("SystemV/AST4ADT", 4, true),
    ("SystemV/CST6", 6, false),
    ("SystemV/CST6CDT", 6, true),
    ("SystemV/EST5", 5, false),
    ("SystemV/EST5EDT", 5, true),
    ("SystemV/HST10", 10, false),
    ("SystemV/MST7", 7, false),
    ("SystemV/MST7MDT", 7, true),
    ("SystemV/PST8", 8, false),
    ("SystemV/PST8PDT", 8, true),
    ("SystemV/YST9", 9, false),
    ("SystemV/YST9YDT", 9, true),
];

/// A resolved schedule zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleZone {
    Named(Tz),
    Fixed(FixedOffset),
    /// A `SystemV/*` zone with a daylight half; the standard offset in seconds east of UTC.
    Rule(i32),
}

/// The zone `name` (already trimmed) names, or `None` when `Intl` would refuse it.
pub fn resolve(name: &str) -> Option<ScheduleZone> {
    if let Some(offset) = fixed_offset(name) {
        return Some(ScheduleZone::Fixed(offset));
    }
    let named = |text: &str| text.parse::<Tz>().ok().or_else(|| chrono_tz::TZ_VARIANTS.iter().copied().find(|z| z.name().eq_ignore_ascii_case(text)));
    if let Some(zone) = named(name) {
        return Some(ScheduleZone::Named(zone));
    }
    if let Some((_, target)) = ALIASES.iter().find(|(alias, _)| alias.eq_ignore_ascii_case(name)) {
        return named(target).map(ScheduleZone::Named);
    }
    let (_, west, daylight) = SYSTEM_V.iter().find(|(id, _, _)| id.eq_ignore_ascii_case(name))?;
    let standard = -west * 3600;
    Some(if *daylight { ScheduleZone::Rule(standard) } else { ScheduleZone::Fixed(FixedOffset::east_opt(standard)?) })
}

/// `±HH`, `±HHMM`, `±HH:MM`.
fn fixed_offset(text: &str) -> Option<FixedOffset> {
    let mut chars = text.chars();
    let sign = match chars.next()? {
        '+' => 1,
        '-' | '\u{2212}' => -1,
        _ => return None,
    };
    let digits = chars.as_str();
    if !digits.is_ascii() {
        return None;
    }
    let (hours, minutes) = match digits.len() {
        2 => (digits, "00"),
        4 => digits.split_at(2),
        5 if digits.as_bytes()[2] == b':' => (&digits[..2], &digits[3..]),
        _ => return None,
    };
    let number = |part: &str| (part.len() == 2 && part.bytes().all(|b| b.is_ascii_digit())).then(|| part.parse::<i32>().ok()).flatten();
    let (hours, minutes) = (number(hours)?, number(minutes)?);
    if hours > 23 || minutes > 59 {
        return None;
    }
    FixedOffset::east_opt(sign * (hours * 3600 + minutes * 60))
}

/// The offset a [`ScheduleZone`] has at an instant; it keeps the zone so `DateTime::timezone` gives it back.
#[derive(Debug, Clone, Copy)]
pub struct ZoneOffset {
    zone: ScheduleZone,
    fixed: FixedOffset,
}

impl Offset for ZoneOffset {
    fn fix(&self) -> FixedOffset {
        self.fixed
    }
}

impl std::fmt::Display for ZoneOffset {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.fixed.fmt(f)
    }
}

fn last_sunday(year: i32, month: u32) -> Option<NaiveDate> {
    let first_of_next = if month == 12 { NaiveDate::from_ymd_opt(year + 1, 1, 1)? } else { NaiveDate::from_ymd_opt(year, month + 1, 1)? };
    let mut day = first_of_next.pred_opt()?;
    while day.weekday() != Weekday::Sun {
        day = day.pred_opt()?;
    }
    Some(day)
}

/// Seconds east of UTC of a `Rule` zone at the UTC time `utc`.
fn rule_offset(standard: i32, utc: &NaiveDateTime) -> i32 {
    let at = |month, offset| last_sunday(utc.year(), month).and_then(|d| d.and_hms_opt(2, 0, 0)).map(|t| t - Duration::seconds(i64::from(offset)));
    match (at(4, standard), at(10, standard + 3600)) {
        (Some(start), Some(end)) if *utc >= start && *utc < end => standard + 3600,
        _ => standard,
    }
}

impl ScheduleZone {
    fn at(self, fixed: FixedOffset) -> ZoneOffset {
        ZoneOffset { zone: self, fixed }
    }

    fn east(self, utc: &NaiveDateTime) -> FixedOffset {
        match self {
            Self::Named(tz) => tz.offset_from_utc_datetime(utc).fix(),
            Self::Fixed(fixed) => fixed,
            Self::Rule(standard) => FixedOffset::east_opt(rule_offset(standard, utc)).expect("a whole-hour offset"),
        }
    }
}

impl TimeZone for ScheduleZone {
    type Offset = ZoneOffset;

    fn from_offset(offset: &ZoneOffset) -> Self {
        offset.zone
    }

    fn offset_from_local_date(&self, local: &NaiveDate) -> LocalResult<ZoneOffset> {
        self.offset_from_local_datetime(&local.and_hms_opt(0, 0, 0).expect("midnight exists"))
    }

    fn offset_from_local_datetime(&self, local: &NaiveDateTime) -> LocalResult<ZoneOffset> {
        match *self {
            Self::Named(tz) => tz.offset_from_local_datetime(local).map(|o| self.at(o.fix())),
            Self::Fixed(fixed) => LocalResult::Single(self.at(fixed)),
            Self::Rule(standard) => {
                // An offset is valid for the wall time when the instant it gives has that offset; the daylight one is the earlier instant.
                let valid = |seconds: i32| {
                    let fixed = FixedOffset::east_opt(seconds)?;
                    let utc = *local - Duration::seconds(i64::from(seconds));
                    (self.east(&utc) == fixed).then(|| self.at(fixed))
                };
                match (valid(standard + 3600), valid(standard)) {
                    (Some(dst), Some(std)) => LocalResult::Ambiguous(dst, std),
                    (Some(one), None) | (None, Some(one)) => LocalResult::Single(one),
                    (None, None) => LocalResult::None,
                }
            }
        }
    }

    fn offset_from_utc_date(&self, utc: &NaiveDate) -> ZoneOffset {
        self.offset_from_utc_datetime(&utc.and_hms_opt(12, 0, 0).expect("noon exists"))
    }

    fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> ZoneOffset {
        self.at(self.east(utc))
    }
}
