//! V8 12.4 Date.toString with ICU 77.1 / CLDR 47 / tzdata 2025b display names.
//! The data is extracted from the official Node 22.20.0 ICU archive, not sampled
//! from a handful of locales. See date_string/data/PROVENANCE.json and the
//! extractor beside the oracle recorder. Unicode/ICU's license is retained in
//! fixtures/js-date-string/reference/LICENSE.icu.
//!
//! Naming follows ICU TimeZone::getDisplayName(LONG): the input date selects DST
//! (after V8 EquivalentTime), but the *current* clock selects the metazone and GMT
//! fallback offsets. Names are cached per zone/locale/standard-or-daylight state.
// Portions adapted from V8, copyright the V8 project authors, under its BSD
// license (reference/LICENSE.v8); ICU, copyright Unicode, Inc. and others,
// under the retained Unicode license (reference/LICENSE.icu).
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{LazyLock, Mutex};

const DAY: i64 = 86_400;
const MAX_MS: f64 = 8.64e15;
static DATA: LazyLock<Value> = LazyLock::new(|| {
    let mut json = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("date_string/data/icu77-date-names.json.gz")[..]).read_to_string(&mut json).expect("pinned ICU data");
    let data: Value = serde_json::from_str(&json).expect("generated ICU schema");
    assert_eq!(data["tz"], "2025b");
    data
});
type NameKey = (String, String, bool);
static NAMES: LazyLock<Mutex<HashMap<NameKey, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn int(v: &Value) -> i64 {
    v.as_i64().expect("generated integer")
}
fn string(v: &Value) -> &str {
    v.as_str().expect("generated string")
}
fn clock_seconds() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

// Gregorian arithmetic also covers the valid JS dates beyond chrono's calendar.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = year - i64::from(month <= 2);
    let era = y.div_euclid(400);
    let yo = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    era * 146097 + yo * 365 + yo / 4 - yo / 100 + (153 * mp + 2) / 5 + day - 1 - 719468
}
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}
fn leap(y: i64) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}
fn month_length(y: i64, m: i64) -> i64 {
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
fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

fn zone(name: &str) -> (&'static Value, &'static str) {
    let descriptor = DATA["zoneNames"].get(name).unwrap_or(&DATA["zoneNames"]["Etc/Unknown"]);
    let mut index = int(&descriptor[0]) as usize;
    loop {
        let z = &DATA["zones"][index];
        if let Some(alias) = z.as_u64() {
            index = alias as usize
        } else {
            return (z, string(&descriptor[1]));
        }
    }
}

/// ICU SimpleTimeZone rule (month, day, day-of-week, seconds, time-mode).
fn transition(year: i64, rule: &[Value], raw: i64, before_dst: i64) -> i64 {
    let month = int(&rule[0]) + 1;
    let day = int(&rule[1]);
    let dow = int(&rule[2]);
    let mut dom = day.abs().min(month_length(year, month));
    if dow > 0 {
        if day > 0 {
            dom = 1 + (dow - 1 - weekday(days_from_civil(year, month, 1))).rem_euclid(7) + (day - 1) * 7
        } else {
            let last = month_length(year, month);
            dom = last - (weekday(days_from_civil(year, month, last)) - (dow - 1)).rem_euclid(7) + (day + 1) * 7
        }
    } else if dow < 0 {
        let desired = -dow - 1;
        let wd = weekday(days_from_civil(year, month, dom));
        if day > 0 { dom += (desired - wd).rem_euclid(7) } else { dom -= (wd - desired).rem_euclid(7) }
    }
    let local = days_from_civil(year, month, dom) * DAY + int(&rule[3]);
    local
        - match int(&rule[4]) {
            0 => raw + before_dst,
            1 => raw,
            _ => 0,
        }
}

/// Raw and daylight seconds in the pinned ICU decomposition (not IANA's
/// negative-DST decomposition for Ireland/Morocco).
fn offsets(z: &Value, time: i64) -> (i64, i64) {
    if let Some(final_rule) = z.get("f") {
        let start_year = int(&final_rule[0]);
        let raw = int(&final_rule[1]);
        let rule = final_rule[2].as_array().expect("final rule");
        if time >= days_from_civil(start_year, 1, 1) * DAY {
            if int(&rule[1]) == 0 || int(&rule[6]) == 0 {
                return (raw, 0);
            }
            let year = civil((time + raw).div_euclid(DAY)).0;
            let savings = int(&rule[10]);
            let mut last = i64::MIN;
            let mut daylight = false;
            for y in year - 1..=year + 1 {
                for (at, on) in [(transition(y, &rule[..5], raw, 0), true), (transition(y, &rule[5..10], raw, savings), false)] {
                    if at <= time && at > last {
                        last = at;
                        daylight = on
                    }
                }
            }
            return (raw, if daylight { savings } else { 0 });
        }
    }
    let transitions = z["t"].as_array().expect("transitions");
    let at = transitions.partition_point(|row| int(&row[0]) <= time);
    if at == 0 { (int(&z["i"][0]), int(&z["i"][1])) } else { (int(&transitions[at - 1][1]), int(&transitions[at - 1][2])) }
}

fn equivalent_time(time: i64, outside_epoch: bool) -> i64 {
    if !outside_epoch {
        return time;
    }
    let days = time.div_euclid(DAY);
    let (y, m, d) = civil(days);
    let first = weekday(days_from_civil(y, 1, 1));
    let recent = (if leap(y) { 1956 } else { 1967 }) + (first * 12) % 28;
    let equivalent = 2008 + (recent + 3 * 28 - 2008) % 28;
    days_from_civil(equivalent, m, d) * DAY + time.rem_euclid(DAY)
}

fn daylight_in_current_year(z: &Value, now: i64) -> bool {
    if let Some(f) = z.get("f")
        && now >= days_from_civil(int(&f[0]), 1, 1) * DAY
    {
        return int(&f[2][1]) != 0 && int(&f[2][6]) != 0;
    }
    let year = civil(now.div_euclid(DAY)).0;
    let begin = days_from_civil(year, 1, 1) * DAY;
    let limit = days_from_civil(year + 1, 1, 1) * DAY;
    let mut previous = int(&z["i"][1]);
    for t in z["t"].as_array().expect("transitions") {
        let when = int(&t[0]);
        if when >= limit {
            break;
        }
        let dst = int(&t[2]);
        if (when >= begin && dst != 0) || (when > begin && previous != 0) {
            return true;
        }
        previous = dst;
    }
    false
}

fn normalize_locale(locale: &str) -> (String, Option<String>) {
    let mut numbers = None;
    let (base, keywords) = locale.split_once('@').unwrap_or((locale, ""));
    for keyword in keywords.split(';') {
        if let Some(n) = keyword.strip_prefix("numbers=") {
            numbers = Some(n.to_owned())
        }
    }
    let mut parts: Vec<String> = base.split('.').next().unwrap_or(base).split(['-', '_']).filter(|s| !s.is_empty()).map(str::to_owned).collect();
    if let Some(extension) = parts.iter().position(|p| p.len() == 1) {
        for pair in parts[extension + 1..].windows(2) {
            if pair[0] == "nu" {
                numbers = Some(pair[1].clone())
            }
        }
        parts.truncate(extension);
    }
    if parts.is_empty() {
        return ("root".into(), numbers);
    }
    if matches!(parts[0].as_str(), "C" | "POSIX") {
        return ("en_US_POSIX".into(), numbers);
    }
    parts[0] = parts[0].to_lowercase();
    for p in &mut parts[1..] {
        if p.len() == 4 {
            let mut chars = p.chars();
            *p = chars.next().unwrap().to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
        } else {
            *p = p.to_uppercase()
        }
    }
    let mut name = parts.join("_");
    if DATA["locales"].get(&name).is_none() {
        if let Some(alias) = DATA["localeAliases"].get(&name).and_then(Value::as_str) {
            name = alias.to_owned()
        } else if let Some(alias) = DATA["localeAliases"].get(&parts[0]).and_then(Value::as_str) {
            parts[0] = alias.to_owned();
            name = parts.join("_")
        }
    }
    (name, numbers)
}

fn locale_chain(section: &str, locale: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = locale.to_owned();
    loop {
        if out.contains(&current) {
            break;
        }
        out.push(current.clone());
        let entry = &DATA[section][&current];
        if let Some(alias) = entry.get("a").and_then(Value::as_str) {
            current = alias.into();
            continue;
        }
        if current == "root" {
            break;
        }
        current = entry
            .get("p")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| current.rsplit_once('_').map_or_else(|| "root".into(), |(parent, _)| parent.into()));
    }
    out
}
fn locale_property<'a>(section: &str, chain: &[String], property: &str) -> Option<&'a str> {
    chain.iter().find_map(|loc| DATA[section][loc].get(property).and_then(Value::as_str))
}
fn named(chain: &[String], key: &str, daylight: bool) -> Option<String> {
    for locale in chain {
        if let Some(name) = DATA["locales"][locale]["n"][key][usize::from(daylight)].as_str() {
            return if name.is_empty() || name == "∅∅∅" { None } else { Some(name.to_owned()) };
        }
    }
    None
}

fn digits(locale: &str, keyword: Option<&str>) -> Option<String> {
    let chain = locale_chain("numbers", locale);
    let mut wanted = keyword.unwrap_or("default").to_owned();
    for _ in 0..4 {
        if let Some(d) = DATA["digits"].get(&wanted).and_then(Value::as_str) {
            return Some(d.into());
        }
        if !["default", "native", "traditional", "finance"].contains(&wanted.as_str()) {
            // Valid algorithmic systems use Latin GMT digits. An unsupported
            // keyword leaves U_UNSUPPORTED_ERROR in ICU, clearing the name.
            return DATA["numberingSystems"].as_array().unwrap().iter().any(|v| v.as_str() == Some(wanted.as_str())).then(|| "0123456789".into());
        }
        if let Some(resolved) = locale_property("numbers", &chain, &wanted) {
            wanted = resolved.into()
        } else if wanted == "traditional" {
            wanted = "native".into()
        } else if wanted != "default" {
            wanted = "default".into()
        } else {
            break;
        }
    }
    Some("0123456789".into())
}
fn unquote(pattern: &str) -> String {
    let mut out = String::new();
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            if chars.peek() == Some(&'\'') {
                chars.next();
                out.push('\'')
            }
        } else {
            out.push(c)
        }
    }
    out
}
fn gmt(locale: &str, keyword: Option<&str>, chain: &[String], offset: i64) -> String {
    let Some(digits) = digits(locale, keyword) else {
        return String::new();
    };
    if offset <= -24 * 3600 || offset >= 24 * 3600 {
        return String::new();
    }
    if offset == 0 {
        return locale_property("locales", chain, "gmtZeroFormat").unwrap_or("GMT").into();
    }
    let pattern = locale_property("locales", chain, "gmtFormat").unwrap_or("GMT{0}");
    let formats = locale_property("locales", chain, "hourFormat").unwrap_or("+HH:mm;-HH:mm");
    let (positive, negative) = formats.split_once(';').unwrap_or(("+HH:mm", "-HH:mm"));
    let mut hour_pattern = if offset < 0 { negative } else { positive }.to_owned();
    let absolute = offset.abs();
    let h = absolute / 3600;
    let m = (absolute % 3600) / 60;
    let s = absolute % 60;
    if s != 0
        && let Some(minute) = hour_pattern.find("mm")
    {
        let separator = hour_pattern[..minute].rfind('H').map(|at| hour_pattern[at + 1..minute].to_owned()).unwrap_or_default();
        hour_pattern.insert_str(minute + 2, &(separator + "ss"));
    }
    let digit_chars: Vec<char> = digits.chars().collect();
    let render = |n: i64| format!("{n:02}").chars().map(|c| digit_chars[c.to_digit(10).unwrap() as usize]).collect::<String>();
    let mut out = String::new();
    let mut quoted = false;
    let mut chars = hour_pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\'' {
            if chars.peek() == Some(&'\'') {
                chars.next();
                out.push('\'')
            } else {
                quoted = !quoted
            }
            continue;
        }
        if !quoted && matches!(c, 'H' | 'm' | 's') {
            while chars.peek() == Some(&c) {
                chars.next();
            }
            out.push_str(&render(match c {
                'H' => h,
                'm' => m,
                _ => s,
            }));
        } else {
            out.push(c)
        }
    }
    unquote(pattern).replace("{0}", &out)
}

fn display_name(z: &Value, canonical: &str, locale: &str, daylight: bool, now: i64) -> String {
    let (locale, keyword) = normalize_locale(locale);
    let chain = locale_chain("locales", &locale);
    if let Some(name) = named(&chain, canonical, daylight) {
        return name;
    }
    if let Some(periods) = DATA["meta"].get(canonical).and_then(Value::as_array) {
        for period in periods {
            if int(&period[1]) <= now && now < int(&period[2]) {
                if let Some(name) = named(&chain, &format!("meta:{}", string(&period[0])), daylight) {
                    return name;
                }
                break;
            }
        }
    }
    let raw = offsets(z, now).0;
    let savings = if daylight && daylight_in_current_year(z, now) { z.get("f").map_or(3600, |f| int(&f[2][10])) } else { 0 };
    gmt(&locale, keyword.as_deref(), &chain, raw + savings)
}

fn format_date(time: f64, zone_name: &str, locale: &str, now: i64, cached: bool) -> String {
    if !time.is_finite() || time.abs() > MAX_MS {
        return "Invalid Date".into();
    }
    let millis = time.trunc() as i64;
    let seconds = millis.div_euclid(1000);
    let (z, canonical) = zone(zone_name);
    let (raw, dst) = offsets(z, seconds);
    let offset = raw + dst;
    let daylight = offsets(z, equivalent_time(seconds, millis < 0 || millis > i64::from(i32::MAX) * 1000)).1 != 0;
    let name = if cached {
        let key = (zone_name.to_owned(), locale.to_owned(), daylight);
        let mut names = NAMES.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        names.entry(key).or_insert_with(|| display_name(z, canonical, locale, daylight, now)).clone()
    } else {
        display_name(z, canonical, locale, daylight, now)
    };
    // The ICU data also supplies a consistent numeric fallback when chrono's
    // supported year range or final transition horizon cannot represent V8.
    let local = seconds + offset;
    let days = local.div_euclid(DAY);
    let (y, m, d) = civil(days);
    let clock = local.rem_euclid(DAY);
    let (mut year, mut month, mut day, mut wd, mut hour, mut minute, mut second) = (y, m, d, weekday(days), clock / 3600, clock % 3600 / 60, clock % 60);
    if cached
        && crate::time::local_offset_ms(millis as f64) == offset * 1000
        && let Some(fields) = crate::time::local_fields(millis as f64)
    {
        year = fields.year as i64;
        month = fields.month as i64;
        day = fields.day as i64;
        wd = fields.weekday as i64;
        hour = fields.hour as i64;
        minute = fields.minute as i64;
        second = fields.second as i64;
    }
    const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let year = if year < 0 { format!("-{:04}", -year) } else { format!("{year:04}") };
    let minutes = offset / 60;
    format!(
        "{} {} {day:02} {year} {hour:02}:{minute:02}:{second:02} GMT{}{:02}{:02} ({name})",
        DAYS[wd as usize],
        MONTHS[(month - 1) as usize],
        if minutes < 0 { '-' } else { '+' },
        minutes.abs() / 60,
        minutes.abs() % 60
    )
}

/// JavaScript Date.prototype.toString for the current process timezone and
/// ICU-equivalent OS default locale, independent of application UI language.
pub fn date_to_string(time: f64) -> String {
    if !time.is_finite() || time.abs() > MAX_MS {
        return "Invalid Date".into();
    }
    format_date(time, crate::time::local_zone().name(), crate::default_locale::default_locale_id(), clock_seconds(), true)
}

#[cfg(test)]
#[path = "date_string/tests.rs"]
mod tests;
