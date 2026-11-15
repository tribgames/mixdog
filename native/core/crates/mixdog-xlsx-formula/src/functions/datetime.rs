//! Local-calendar Date operations of formulajs (the default returnSerial=false).
use super::text::{arg, default, number};
use crate::coerce::*;
use crate::registry::Table;
use crate::value::{ErrorValue as E, Failure, Value as V};
use mixdog_js::time::{LocalFields, local_fields, local_to_utc_ms};
const DAY: f64 = 86_400_000.0;
macro_rules! functions { ($($name:ident),*) => { $(fn $name(a:&[V])->Result<V,Failure>{run(stringify!($name),a)})* pub const FUNCTIONS:Table=&[$((stringify!($name),$name)),*,("NETWORKDAYS.INTL",NETWORKDAYSINTL),("WORKDAY.INTL",WORKDAYINTL)]; }; }
#[allow(non_snake_case)]
mod exports {
    use super::*;
    functions!(
        DATE,
        DATEDIF,
        DATEVALUE,
        DAY,
        DAYS,
        DAYS360,
        EDATE,
        EOMONTH,
        HOUR,
        ISOWEEKNUM,
        MINUTE,
        MONTH,
        NETWORKDAYS,
        NETWORKDAYSINTL,
        NOW,
        SECOND,
        TIME,
        TIMEVALUE,
        TODAY,
        WEEKDAY,
        WEEKNUM,
        WORKDAY,
        WORKDAYINTL,
        YEAR,
        YEARFRAC
    );
}
pub use exports::FUNCTIONS;
fn date(v: &V) -> Result<f64, E> {
    match parse_date(v) {
        V::Date(t) => Ok(t),
        V::Error(e) => Err(e),
        _ => unreachable!(),
    }
}
#[allow(clippy::too_many_arguments, reason = "mirrors JavaScript Date fields and constructor versus setter year behavior")]
fn make(y: f64, m: f64, d: f64, h: f64, min: f64, s: f64, ms: f64, constructor: bool) -> f64 {
    if [y, m, d, h, min, s, ms].iter().any(|x| !x.is_finite()) {
        return f64::NAN;
    }
    let y = if constructor && (0.0..=99.0).contains(&y.trunc()) {
        y.trunc() + 1900.0
    } else {
        y
    };
    // V8 MakeDay rejects these finite but unrepresentable calendar inputs
    // before normalizing months. Keep the original bounds, including large
    // cancelling year/month pairs which still produce valid dates inside them.
    if !(-1_000_000.0..=1_000_000.0).contains(&y) || !(-10_000_000.0..=10_000_000.0).contains(&m) {
        return f64::NAN;
    }
    let month = m.trunc() as i64;
    let year = y.trunc() as i64 + month.div_euclid(12);
    let month = month.rem_euclid(12) + 1;
    // Determine the wall time in i128 before the shared i64 calendar helpers
    // multiply days/hours. Values outside the time clip plus one possible local
    // UTC offset cannot yield a valid Date. No valid cancelling components are
    // rejected merely because an individual component is outside a usual range.
    let components = [d, h, min, s, ms];
    if components.iter().any(|v| v.trunc().abs() > i64::MAX as f64) {
        return f64::NAN;
    }
    let [day, hour, minute, second, milli] = components.map(|v| v.trunc() as i64);
    let adjusted_year = i128::from(year) - i128::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let march_month = i128::from((month + 9) % 12);
    let day_of_year = (153 * march_month + 2) / 5;
    let days = era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100
        + day_of_year
        - 719_468
        + i128::from(day)
        - 1;
    let wall = days * 86_400_000
        + ((i128::from(hour) * 60 + i128::from(minute)) * 60 + i128::from(second)) * 1000
        + i128::from(milli);
    if wall.abs() > 8_640_000_000_000_000_i128 + 86_400_000 {
        return f64::NAN;
    }
    local_to_utc_ms(year, month, day, hour, minute, second, milli)
}
fn midnight(t: f64) -> f64 {
    local_fields(t).map_or(f64::NAN, |f| {
        make(
            f.year as f64,
            (f.month - 1) as f64,
            f.day as f64,
            0.0,
            0.0,
            0.0,
            0.0,
            false,
        )
    })
}
fn change(t: f64, year: Option<f64>, month: Option<f64>, day: Option<f64>) -> f64 {
    local_fields(t).map_or(f64::NAN, |f| {
        make(
            year.unwrap_or(f.year as f64),
            month.unwrap_or((f.month - 1) as f64),
            day.unwrap_or(f.day as f64),
            f.hour as f64,
            f.minute as f64,
            f.second as f64,
            f.millisecond as f64,
            false,
        )
    })
}
fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}
fn leap(y: i32) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}
fn end_day(y: i32, m: u32) -> u32 {
    match m {
        2 => {
            if leap(y) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}
fn iso_week(t: f64) -> f64 {
    let Some(f) = local_fields(t) else {
        return f64::NAN;
    };
    let d = change(
        midnight(t),
        None,
        None,
        Some(
            f.day as f64 + 4.0
                - if f.weekday == 0 {
                    7.0
                } else {
                    f.weekday as f64
                },
        ),
    );
    let Some(f) = local_fields(d) else {
        return f64::NAN;
    };
    let jan = make(f.year as f64, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, true);
    (((d - jan) / DAY + 1.0) / 7.0).ceil()
}
fn yfrac(start: f64, end: f64, basis: &V) -> V {
    let Some(s) = local_fields(start) else {
        return V::Number(f64::NAN);
    };
    let Some(e) = local_fields(end) else {
        return V::Number(f64::NAN);
    };
    let (mut sd, mut ed) = (s.day as f64, e.day as f64);
    let days = ((end - start) / 1000.0 / 60.0 / 60.0 / 24.0).ceil();
    let basis = if is_truthy(basis) {
        basis.clone()
    } else {
        V::Number(0.0)
    };
    let n = match basis {
        V::Number(0.0) => {
            if sd == 31.0 {
                sd = 30.0;
                if ed == 31.0 {
                    ed = 30.0
                }
            } else if sd == 30.0 && ed == 31.0 {
                ed = 30.0
            }
            (ed + e.month as f64 * 30.0 + e.year as f64 * 360.0
                - (sd + s.month as f64 * 30.0 + s.year as f64 * 360.0))
                / 360.0
        }
        V::Number(1.0) => {
            if s.year == e.year
                || (s.year + 1 == e.year && (s.month > e.month || (s.month == e.month && sd >= ed)))
            {
                let march = |y| make(y as f64, 2.0, 1.0, 0.0, 0.0, 0.0, 0.0, true);
                let feb = (leap(s.year) && start < march(s.year) && end >= march(s.year))
                    || (leap(e.year) && end >= march(e.year) && start < march(e.year));
                // The original also uses getMonth()+1, then tests month==1:
                // its January-29 quirk is intentional parity, not February.
                days / if (s.year == e.year && leap(s.year)) || feb || (e.month == 1 && ed == 29.0)
                {
                    366.0
                } else {
                    365.0
                }
            } else {
                let first = make(s.year as f64, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, true);
                let last = make((e.year + 1) as f64, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, true);
                days / (((last - first) / 1000.0 / 60.0 / 60.0 / 24.0)
                    / (e.year - s.year + 1) as f64)
            }
        }
        V::Number(2.0) => days / 360.0,
        V::Number(3.0) => days / 365.0,
        V::Number(4.0) => {
            (ed + e.month as f64 * 30.0 + e.year as f64 * 360.0
                - (sd + s.month as f64 * 30.0 + s.year as f64 * 360.0))
                / 360.0
        }
        _ => return V::Undefined,
    };
    V::Number(n)
}
fn weekend(v: &V, mask: bool) -> Result<Vec<u32>, E> {
    if mask
        && let V::Text(s) = v
            && s.len() == 7 && s.bytes().all(|c| matches!(c, b'0' | b'1' | b'|')) {
                return Ok(s
                    .bytes()
                    .enumerate()
                    .filter_map(|(i, c)| (c == b'1').then_some(((i + 1) % 7) as u32))
                    .collect());
            }
    let Ok(key) = String::from_utf16(&to_js_utf16(v)) else {
        return Err(E::Value);
    };
    let n = if matches!(v, V::Undefined) {
        1
    } else {
        match key.parse::<usize>() {
            Ok(n) if n.to_string() == key => n,
            _ => return Err(E::Value),
        }
    };
    match n {
        0 => Ok(vec![]),
        1..=7 => Ok(vec![((n + 5) % 7) as u32, ((n + 6) % 7) as u32]),
        11..=17 => Ok(vec![(n - 11) as u32]),
        _ => Err(E::Value),
    }
}
fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    let (x, y, z) = (arg(a, 0), arg(a, 1), arg(a, 2));
    let err = |e| Ok(V::Error(e));
    if name == "DATE" {
        let (Ok(y), Ok(m), Ok(d)) = (number(&x), number(&y), number(&z)) else {
            return err(E::Value);
        };
        let t = make(y, m - 1.0, d, 0.0, 0.0, 0.0, 0.0, true);
        return if local_fields(t)
            .map(|f| f.year < 0)
            .unwrap_or(t.is_finite() && t < 0.0)
        {
            err(E::Num)
        } else {
            Ok(V::Date(t))
        };
    }
    if name == "DATEVALUE" {
        let Some(units) = x.text_units() else {
            return err(E::Value);
        };
        let t = mixdog_js::time::date_parse_utf16(&units);
        return if t.is_nan() {
            err(E::Value)
        } else {
            Ok(V::Date(t))
        };
    }
    if name == "NOW" || name == "TODAY" {
        return Ok(V::Date(if name == "NOW" {
            now()
        } else {
            midnight(now())
        }));
    }
    if name == "TIME" {
        let (Ok(h), Ok(m), Ok(s)) = (number(&x), number(&y), number(&z)) else {
            return err(E::Value);
        };
        return if h < 0.0 || m < 0.0 || s < 0.0 {
            err(E::Num)
        } else {
            Ok(V::Number((3600.0 * h + 60.0 * m + s) / 86400.0))
        };
    }
    // DATEDIF does not perform the other date functions' error checks.
    if name == "DATEDIF" {
        // A raw unit cannot equal an ASCII DATEDIF keyword, but date conversion
        // still happens before the source's unknown-unit switch returns undefined.
        let z = if matches!(z, V::Utf16(_)) { V::Text(String::new()) } else { z };
        let V::Text(unit) = z else {
            return Err(Failure::thrown(if matches!(z, V::Null) {
                "Cannot read properties of null (reading 'toUpperCase')"
            } else if matches!(z, V::Undefined) {
                "Cannot read properties of undefined (reading 'toUpperCase')"
            } else {
                "unit.toUpperCase is not a function"
            }));
        };
        let start =
            date(&x).map_err(|_| Failure::thrown("start_date.getFullYear is not a function"))?;
        let end =
            date(&y).map_err(|_| Failure::thrown("end_date.getFullYear is not a function"))?;
        if unit.is_empty() { return Ok(V::Undefined); }
        let (Some(s), Some(e)) = (local_fields(start), local_fields(end)) else {
            return Ok(V::Number(f64::NAN));
        };
        let months = (e.month as f64 - s.month as f64) + 12.0 * (e.year - s.year) as f64
            - if e.day < s.day { 1.0 } else { 0.0 };
        let value = match unit.to_uppercase().as_str() {
            "Y" => to_js_number(&yfrac(start, end, &V::Number(0.0))).floor(),
            "D" => date_to_serial(midnight(end)) - date_to_serial(midnight(start)),
            "M" => months,
            "YM" => months % 12.0,
            "MD" => {
                if s.day <= e.day {
                    (e.day - s.day) as f64
                } else {
                    let yr = if e.month == 1 { e.year - 1 } else { e.year };
                    let t = change(start, Some(yr as f64), None, None);
                    let t = change(
                        t,
                        None,
                        Some(if e.month == 1 {
                            12.0
                        } else {
                            (e.month - 2) as f64
                        }),
                        None,
                    );
                    date_to_serial(midnight(end)) - date_to_serial(midnight(t))
                }
            }
            "YD" => {
                let year = if e.month > s.month || (e.month == s.month && e.day < s.day) {
                    e.year
                } else {
                    e.year - 1
                };
                date_to_serial(midnight(end))
                    - date_to_serial(midnight(change(start, Some(year as f64), None, None)))
            }
            _ => return Ok(V::Undefined),
        };
        return Ok(V::Number(value));
    }
    let start = match date(&x) {
        Ok(t) => t,
        Err(e) => return err(e),
    };
    if matches!(
        name,
        "DAY" | "HOUR" | "MINUTE" | "MONTH" | "SECOND" | "YEAR" | "TIMEVALUE" | "ISOWEEKNUM"
    ) {
        let n = local_fields(start).map_or(f64::NAN, |f| match name {
            "DAY" => f.day as f64,
            "HOUR" => f.hour as f64,
            "MINUTE" => f.minute as f64,
            "MONTH" => f.month as f64,
            "SECOND" => f.second as f64,
            "YEAR" => f.year as f64,
            "TIMEVALUE" => {
                (3600.0 * f.hour as f64 + 60.0 * f.minute as f64 + f.second as f64) / 86400.0
            }
            _ => iso_week(start),
        });
        return Ok(V::Number(n));
    }
    if name == "EDATE" || name == "EOMONTH" {
        if is_nan_of(&y) {
            return err(E::Value);
        }
        let raw = to_js_string(&y);
        let raw = raw.trim_start();
        let digits: String = raw
            .chars()
            .enumerate()
            .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && matches!(c, '+' | '-')))
            .map(|(_, c)| c)
            .collect();
        let months = digits.parse::<f64>().unwrap_or(f64::NAN);
        let Some(f) = local_fields(start) else {
            return Ok(V::Date(f64::NAN));
        };
        let t = if name == "EOMONTH" {
            make(
                f.year as f64,
                (f.month - 1) as f64 + months + 1.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                true,
            )
        } else {
            let t = change(start, None, Some((f.month - 1) as f64 + months), Some(1.0));
            local_fields(t).map_or(f64::NAN, |target| {
                change(
                    t,
                    None,
                    None,
                    Some(f.day.min(end_day(target.year, target.month)) as f64),
                )
            })
        };
        return Ok(V::Date(t));
    }
    if name == "WEEKDAY" || name == "WEEKNUM" {
        let ret = default(a, 1, V::Number(1.0));
        let key = String::from_utf16(&to_js_utf16(&ret)).ok();
        let n = key
            .as_ref()
            .and_then(|key| key.parse::<u32>().ok().filter(|n| n.to_string() == *key));
        let Some(f) = local_fields(start) else {
            return Ok(if name == "WEEKDAY" {
                V::Undefined
            } else {
                V::Number(f64::NAN)
            });
        };
        if name == "WEEKDAY" {
            return match n {
                Some(1 | 17) => Ok(V::Number((f.weekday + 1) as f64)),
                Some(2 | 11) => Ok(V::Number(((f.weekday + 6) % 7 + 1) as f64)),
                Some(3) => Ok(V::Number(((f.weekday + 6) % 7) as f64)),
                Some(v @ 12..=16) => Ok(V::Number(((f.weekday + 7 - (v - 10)) % 7 + 1) as f64)),
                Some(0 | 4..=10) => Ok(V::Undefined),
                _ => Err(Failure::thrown(format!(
                    "Cannot read properties of undefined (reading '{}')",
                    f.weekday
                ))),
            };
        }
        if matches!(ret, V::Number(21.0)) {
            return Ok(V::Number(iso_week(start)));
        }
        // Preserve formulajs' WEEK_STARTS array, including its unused index 11.
        let ws = match n {
            Some(1 | 18) => 0.0,
            Some(2) => 1.0,
            Some(v @ 12..=17) => (v - 11) as f64,
            _ => f64::NAN,
        };
        let jan = make(f.year as f64, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, true);
        let jd = local_fields(jan).map_or(f64::NAN, |f| f.weekday as f64);
        let inc = if jd < ws { 1.0 } else { 0.0 };
        return Ok(V::Number(
            ((start - (jan - (jd - ws).abs() * DAY)) / DAY / 7.0 + 1.0).floor() + inc,
        ));
    }
    if name.starts_with("WORKDAY") || name.starts_with("NETWORKDAYS") {
        let work = name.starts_with("WORKDAY");
        let intl = name.ends_with("INTL");
        let weekend_arg = if intl { z.clone() } else { V::Number(1.0) };
        let end_or_days = if work {
            match number(&y) {
                Ok(n) => n,
                Err(e) => return err(e),
            }
        } else {
            match date(&y) {
                Ok(n) => n,
                Err(e) => return err(e),
            }
        };
        let weekend = match weekend(&weekend_arg, !work) {
            Ok(v) => v,
            Err(e) => return err(e),
        };
        let holidays = arg(a, if intl { 3 } else { 2 });
        let holidays = match holidays {
            V::Undefined => vec![],
            V::Array(v) => v,
            v => vec![v],
        };
        let mut hs = Vec::new();
        for h in holidays {
            match date(&h) {
                Ok(t) => hs.push(local_fields(t)),
                Err(e) => return err(e),
            }
        }
        let holiday = |f: LocalFields| {
            hs.iter()
                .flatten()
                .any(|h| h.year == f.year && h.month == f.month && h.day == f.day)
        };
        let mut day = start;
        if work {
            let sign = if end_or_days == 0.0 {
                0.0
            } else {
                end_or_days.signum()
            };
            let mut count = 0.0;
            while count < end_or_days * sign {
                let Some(f) = local_fields(day) else {
                    count += 1.0;
                    continue;
                };
                day = change(day, None, None, Some(f.day as f64 + sign));
                if let Some(f) = local_fields(day) {
                    if weekend.contains(&f.weekday) {
                        continue;
                    }
                    if holiday(f) {
                        count -= 1.0
                    }
                }
                count += 1.0
            }
            if local_fields(day).is_some_and(|f| f.year < 1900) {
                return err(E::Value);
            }
            return Ok(V::Date(day));
        }
        let days = mixdog_js::math::round((end_or_days - start) / DAY) + 1.0;
        let mut total = days;
        let utc = mixdog_js::time::local_offset_ms(now()) < 0;
        let mut i = 0.0;
        while i < days {
            if let Some(f) = local_fields(day) {
                let weekday = if utc {
                    mixdog_js::time::local_fields_in(mixdog_js::time::Tz::UTC, day)
                        .map_or(f.weekday, |f| f.weekday)
                } else {
                    f.weekday
                };
                if weekend.contains(&weekday) || holiday(f) {
                    total -= 1.0
                }
                day = change(day, None, None, Some(f.day as f64 + 1.0))
            }
            i += 1.0
        }
        return Ok(V::Number(total));
    }
    let end = match date(&y) {
        Ok(t) => t,
        Err(e) => return err(e),
    };
    if name == "DAYS" {
        return Ok(V::Number(
            date_to_serial(midnight(start)) - date_to_serial(midnight(end)),
        ));
    }
    if name == "YEARFRAC" {
        return Ok(yfrac(start, end, &z));
    }
    if name == "DAYS360" {
        let method = parse_bool(&if is_truthy(&z) { z } else { V::text("false") });
        if let V::Error(e) = method {
            return err(e);
        }
        let (Some(s), Some(e)) = (local_fields(start), local_fields(end)) else {
            return Ok(V::Number(f64::NAN));
        };
        let mut em = e.month as f64;
        let (sd, ed) = if is_truthy(&method) {
            (s.day.min(30) as f64, e.day.min(30) as f64)
        } else {
            let sd = if s.day == end_day(s.year, s.month) {
                30
            } else {
                s.day
            };
            let ed = if e.day == end_day(e.year, e.month) {
                if sd < 30 {
                    em += 1.0;
                    1
                } else {
                    30
                }
            } else {
                e.day
            };
            (sd as f64, ed as f64)
        };
        return Ok(V::Number(
            360.0 * (e.year - s.year) as f64 + 30.0 * (em - s.month as f64) + ed - sd,
        ));
    }
    unreachable!()
}
