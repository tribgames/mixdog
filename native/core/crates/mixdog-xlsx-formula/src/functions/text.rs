//! Text operations of formulajs 4.6.1, including its coercions and non-Excel quirks.
use crate::coerce::*;
use crate::registry::Table;
use crate::value::{ErrorValue as E, Failure, Value as V};
use mixdog_js::math;

pub(super) fn arg(a: &[V], i: usize) -> V {
    a.get(i).cloned().unwrap_or(V::Undefined)
}
pub(super) fn default(a: &[V], i: usize, value: V) -> V {
    match a.get(i) {
        None | Some(V::Undefined) => value,
        Some(v) => v.clone(),
    }
}
pub(super) fn number(v: &V) -> Result<f64, E> {
    match parse_number(v) {
        V::Number(n) => Ok(n),
        V::Error(e) => Err(e),
        _ => unreachable!(),
    }
}
fn string(v: &V) -> Result<Vec<u16>, E> {
    match v {
        V::Error(e) => Err(*e),
        V::Undefined | V::Null => Ok(Vec::new()),
        other => Ok(to_js_utf16(other)),
    }
}

fn join_value(v: &V) -> Vec<u16> {
    if matches!(v, V::Null | V::Undefined) {
        Vec::new()
    } else {
        to_js_utf16(v)
    }
}
fn substring(units: &[u16], begin: f64, end: f64) -> Vec<u16> {
    let clamp = |n: f64| {
        if n.is_nan() {
            0
        } else {
            n.trunc().max(0.0).min(units.len() as f64) as usize
        }
    };
    let (b, e) = (clamp(begin), clamp(end));
    units[b.min(e)..b.max(e)].to_vec()
}
fn substr(units: &[u16], begin: f64, len: f64) -> Vec<u16> {
    let n = units.len() as f64;
    let begin = if begin.is_nan() { 0.0 } else { begin };
    let len = if len.is_nan() { 0.0 } else { len };
    let b = if begin < 0.0 {
        (n + begin.trunc()).max(0.0)
    } else {
        begin.trunc().min(n)
    };
    substring(units, b, b + len.max(0.0))
}
fn index_of(h: &[u16], n: &[u16], start: f64) -> Option<usize> {
    let start = if start.is_nan() {
        0
    } else {
        start.trunc().max(0.0).min(h.len() as f64) as usize
    };
    if n.is_empty() {
        return Some(start);
    }
    h.get(start..)?
        .windows(n.len())
        .position(|w| w == n)
        .map(|i| i + start)
}
fn join_parts(parts: &[Vec<u16>], separator: &[u16]) -> Vec<u16> {
    let mut out = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(separator)
        }
        out.extend_from_slice(p)
    }
    out
}
fn replace_once(s: &[u16], old: &[u16], new: &[u16]) -> Vec<u16> {
    if let Some(at) = index_of(s, old, 0.0) {
        [&s[..at], new, &s[at + old.len()..]].concat()
    } else {
        s.to_vec()
    }
}
fn space(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(mixdog_js::is_js_space)
}
fn word(u: u16) -> bool {
    (u16::from(b'a')..=u16::from(b'z')).contains(&u)
        || (u16::from(b'A')..=u16::from(b'Z')).contains(&u)
        || (u16::from(b'0')..=u16::from(b'9')).contains(&u)
        || u == 95
}

fn run_units(name: &str, a: &[V]) -> Result<V, Failure> {
    let (x, y, z) = (arg(a, 0), arg(a, 1), arg(a, 2));
    let text = |s: Vec<u16>| Ok(V::from_utf16(s));
    let err = |e| Ok(V::Error(e));
    match name {
        "CHAR" | "UNICHAR" => match number(&x) {
            Err(e) => err(e),
            Ok(0.0) => err(E::Value),
            Ok(n) => text(vec![if n.is_finite() {
                n.trunc().rem_euclid(65536.0) as u16
            } else {
                0
            }]),
        },
        "CLEAN" | "CODE" | "UNICODE" => {
            if let V::Error(e) = x {
                return err(e);
            }
            let units = if !is_truthy(&x) {
                Vec::new()
            } else if let Some(u) = x.text_units() {
                u
            } else {
                return Err(Failure::thrown(if name == "CLEAN" {
                    "text.replace is not a function"
                } else {
                    "text.charCodeAt is not a function"
                }));
            };
            if name == "CLEAN" {
                text(units.into_iter().filter(|u| *u > 31).collect())
            } else {
                Ok(units
                    .first()
                    .map_or(V::Error(E::Value), |u| V::Number(f64::from(*u))))
            }
        }
        "CONCAT" | "CONCATENATE" => {
            let values = flatten(a);
            if let Some(e) = any_error(&values) {
                return err(e);
            }
            let mut out = Vec::new();
            for v in values {
                out.extend(match v {
                    V::Bool(b) => (if b { "TRUE" } else { "FALSE" }).encode_utf16().collect(),
                    _ => join_value(&v),
                })
            }
            text(out)
        }
        "EXACT" => {
            if a.len() != 2 {
                return err(E::Na);
            }
            if let Some(e) = any_error(a) {
                return err(e);
            }
            Ok(V::Bool(string(&x).unwrap() == string(&y).unwrap()))
        }
        "LEN" => {
            if a.is_empty() {
                return err(E::Error);
            }
            match x {
                V::Error(e) => err(e),
                V::Array(_) => err(E::Value),
                _ => Ok(V::Number(string(&x).unwrap().len() as f64)),
            }
        }
        "LEFT" | "RIGHT" | "MID" => {
            if let Some(e) = any_error(&[x.clone(), y, z.clone()]) {
                return err(e);
            }
            let units = string(&x).unwrap();
            let n = match number(&default(a, 1, V::Number(1.0))) {
                Ok(n) => n,
                Err(e) => return err(if name == "LEFT" { E::Value } else { e }),
            };
            let len = units.len() as f64;
            if name == "MID" {
                let count = match number(&z) {
                    Ok(n) if n > 0.0 => n,
                    _ => return err(E::Value),
                };
                if n <= 0.0 || n.is_nan() {
                    return err(E::Value);
                }
                text(substring(&units, n - 1.0, n - 1.0 + count))
            } else if name == "LEFT" {
                text(substring(&units, 0.0, n))
            } else {
                text(substring(&units, len - n, len))
            }
        }
        "LOWER" | "UPPER" | "TRIM" | "PROPER" => {
            if name == "LOWER" && a.len() != 1 {
                return err(E::Value);
            }
            if name == "PROPER" && matches!(x,V::Number(n)if n.is_nan()) {
                return err(E::Value);
            }
            let units = match string(&x) {
                Ok(s) => s,
                Err(e) => return err(e),
            };
            if name == "LOWER" || name == "UPPER" {
                return text(case_utf16(&units, name == "UPPER"));
            }
            let mut out = Vec::new();
            let mut i = 0;
            while i < units.len() {
                if name == "TRIM" && space(units[i]) {
                    while i < units.len() && space(units[i]) {
                        i += 1
                    }
                    if !out.is_empty() && i < units.len() {
                        out.push(32)
                    }
                } else if name == "PROPER" && word(units[i]) {
                    out.extend(case_utf16(&units[i..i + 1], true));
                    i += 1;
                    let start = i;
                    while i < units.len() && !space(units[i]) {
                        i += 1
                    }
                    out.extend(case_utf16(&units[start..i], false))
                } else {
                    out.push(units[i]);
                    i += 1
                }
            }
            text(out)
        }
        "FIND" | "SEARCH" => {
            if name == "FIND" && a.len() < 2 {
                return err(E::Na);
            }
            let (needle, hay) = if name == "SEARCH" {
                let (Some(x), Some(y)) = (x.text_units(), y.text_units()) else {
                    return err(E::Value);
                };
                (case_utf16(&x, false), case_utf16(&y, false))
            } else {
                let yy = parse_string(&y);
                if matches!(yy, V::Error(_)) {
                    return Err(Failure::thrown("within_text.indexOf is not a function"));
                }
                (to_js_utf16(&parse_string(&x)), to_js_utf16(&yy))
            };
            Ok(index_of(
                &hay,
                &needle,
                to_js_number(&default(a, 2, V::Number(0.0))) - 1.0,
            )
            .map_or(V::Error(E::Value), |i| V::Number((i + 1) as f64)))
        }
        "REPLACE" => {
            let (Some(s), Some(replacement)) = (x.text_units(), arg(a, 3).text_units()) else {
                return err(E::Value);
            };
            let (Ok(start), Ok(count)) = (number(&y), number(&z)) else {
                return err(E::Value);
            };
            text(
                [
                    substr(&s, 0.0, start - 1.0),
                    replacement,
                    substr(&s, start - 1.0 + count, f64::INFINITY),
                ]
                .concat(),
            )
        }
        "REPT" => {
            if let Some(e) = any_error(&[x.clone(), y.clone()]) {
                return err(e);
            }
            let n = match number(&y) {
                Ok(n) => n,
                Err(e) => return err(e),
            };
            let length = n + 1.0;
            if !length.is_finite()
                || length < 0.0
                || length.fract() != 0.0
                || length > u32::MAX as f64
            {
                return Err(Failure::thrown("Invalid array length"));
            }
            let source = string(&x).unwrap();
            let repeats = n.max(0.0) as usize;
            let units = source
                .len()
                .checked_mul(repeats)
                .ok_or_else(|| Failure::thrown("Invalid string length"))?;
            if units > (1usize << 29) - 24 {
                return Err(Failure::thrown("Invalid string length"));
            }
            if source.is_empty() || repeats == 0 {
                return text(Vec::new());
            }
            let mut out = Vec::new();
            out.try_reserve_exact(units)
                .map_err(|_| Failure::thrown("Invalid string length"))?;
            for _ in 0..repeats {
                out.extend_from_slice(&source)
            }
            text(out)
        }
        "NUMBERVALUE" => {
            let x = if is_defined(&x) { x } else { V::text("") };
            if matches!(x, V::Number(_)) {
                return Ok(x);
            }
            let Some(s) = x.text_units() else {
                return err(E::Na);
            };
            let decimal = to_js_utf16(&default(a, 1, V::text(".")));
            let group = to_js_utf16(&default(a, 2, V::text(",")));
            Ok(V::Number(utf16_number(&replace_once(
                &replace_once(&s, &decimal, &[46]),
                &group,
                &[],
            ))))
        }
        "SUBSTITUTE" => {
            if a.len() < 3 {
                return err(E::Na);
            }
            if !is_truthy(&x) || !is_truthy(&y) {
                return Ok(x);
            }
            let Some(s) = x.text_units() else {
                return Err(Failure::thrown(if matches!(arg(a, 3), V::Undefined) {
                    "text.split is not a function"
                } else {
                    "text.indexOf is not a function"
                }));
            };
            let old = to_js_utf16(&y);
            let new = join_value(&z);
            if matches!(arg(a, 3), V::Undefined) {
                let separator = if matches!(z, V::Undefined) {
                    vec![44]
                } else {
                    new
                };
                let mut parts = Vec::new();
                if old.is_empty() {
                    parts.extend(s.iter().map(|u| vec![*u]));
                } else {
                    let mut start = 0;
                    while let Some(at) = index_of(&s, &old, start as f64) {
                        parts.push(s[start..at].to_vec());
                        start = at + old.len();
                    }
                    parts.push(s[start..].to_vec());
                }
                return text(join_parts(&parts, &separator));
            }
            let instance = to_js_number(&arg(a, 3)).floor();
            if instance.is_nan() || instance <= 0.0 {
                return err(E::Value);
            }
            let mut at = 0;
            let mut count = 0.0;
            while index_of(&s, &old, at as f64).is_some() {
                let Some(next) = index_of(&s, &old, (at + 1) as f64) else {
                    break;
                };
                at = next;
                count += 1.0;
                if count == instance {
                    return text(
                        [
                            substring(&s, 0.0, at as f64),
                            new,
                            substring(&s, (at + old.len()) as f64, f64::INFINITY),
                        ]
                        .concat(),
                    );
                }
            }
            text(s)
        }
        "T" => Ok(if x.is_text() || matches!(x, V::Error(_)) {
            x
        } else {
            V::text("")
        }),
        "TEXTJOIN" => {
            if a.len() < 3 {
                return err(E::Na);
            }
            let ignore = parse_bool(&y);
            let values: Vec<_> = flatten(&a[2..])
                .into_iter()
                .filter(|v| !is_truthy(&ignore) || is_truthy(v))
                .collect();
            let delimiters = match x {
                V::Array(v) => flatten(&v),
                V::Null | V::Undefined => vec![V::text("")],
                v => vec![v],
            };
            let mut out = Vec::new();
            for (i, v) in values.iter().enumerate() {
                if i > 0 && !delimiters.is_empty() {
                    out.extend(join_value(&delimiters[(i - 1) % delimiters.len()]))
                }
                out.extend(join_value(v))
            }
            text(out)
        }
        "VALUE" => {
            if let V::Error(e) = x {
                return err(e);
            }
            if matches!(x, V::Number(_)) {
                return Ok(x);
            }
            let s = if !is_defined(&x) {
                Vec::new()
            } else if let Some(s) = x.text_units() {
                s
            } else {
                return err(E::Value);
            };
            let percent = s.first() == Some(&37) || s.last() == Some(&37);
            let digit = |u: &u16| (48..=57).contains(u);
            let front = s
                .iter()
                .take(3)
                .take_while(|u| !digit(u) && **u != 45)
                .count();
            let s = &s[front..];
            let back = s.iter().rev().take(3).take_while(|u| !digit(u)).count();
            let s: Vec<_> = s[..s.len() - back]
                .iter()
                .copied()
                .filter(|u| *u != 32 && *u != 44)
                .collect();
            let n = utf16_number(&s);
            if n.is_nan() {
                err(E::Value)
            } else {
                // Original: output = output || 0; then output *= 0.01.
                let n = if n == 0.0 { 0.0 } else { n };
                Ok(V::Number(if percent { n * 0.01 } else { n }))
            }
        }
        _ => unreachable!(),
    }
}

fn commas(s: &str) -> String {
    let (whole, tail) = s.split_once('.').map_or((s, None), |(w, t)| (w, Some(t)));
    let mut out = String::new();
    let digits = whole.trim_start_matches('-');
    if whole.starts_with('-') {
        out.push('-')
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 && digits.bytes().all(|b| b.is_ascii_digit()) {
            out.push(',')
        }
        out.push(c)
    }
    if let Some(t) = tail {
        out.push('.');
        out.push_str(t)
    }
    out
}

// Intl.NumberFormat rounds the shortest decimal representation, unlike toFixed,
// which rounds the exact binary value. Expand scientific notation before grouping.
fn currency_digits(n: f64, places: usize) -> String {
    if !n.is_finite() {
        return mixdog_js::number_to_string(n);
    }
    let source = mixdog_js::number_to_string(n.abs());
    let (mantissa, exponent) = source
        .split_once('e')
        .map_or((source.as_str(), 0_i32), |(m, e)| {
            (m, e.parse().unwrap_or(0))
        });
    let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent;
    let mut digits: Vec<u8> = mantissa.bytes().filter(|b| *b != b'.').collect();
    let point = if point < 0 {
        let mut padded = vec![b'0'; (-point) as usize];
        padded.extend(digits);
        digits = padded;
        0
    } else {
        point as usize
    };
    digits.resize(digits.len().max(point + places + 1), b'0');
    let round_up = digits[point + places] >= b'5';
    digits.truncate(point + places);
    if digits.is_empty() {
        digits.push(b'0')
    }
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, b'1');
                break;
            }
            i -= 1;
            if digits[i] == b'9' {
                digits[i] = b'0'
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    while digits.len() <= places {
        digits.insert(0, b'0')
    }
    let point = digits.len() - places;
    if places > 0 {
        digits.insert(point, b'.')
    }
    String::from_utf8(digits).expect("decimal digits")
}
fn fixed(n: &V, d: &V, no_commas: bool) -> Result<V, Failure> {
    let n = parse_number(n);
    let d = parse_number(d);
    if is_nan_of(&n) || is_nan_of(&d) {
        return Ok(V::Error(E::Value));
    }
    let (n, d) = (to_js_number(&n), to_js_number(&d));
    let s = if d < 0.0 {
        mixdog_js::number_to_string(math::round(n / math::pow(10.0, -d)) * math::pow(10.0, -d))
    } else {
        if !(0.0..=100.0).contains(&d.trunc()) && !d.is_nan() {
            return Err(Failure::thrown(
                "toFixed() digits argument must be between 0 and 100",
            ));
        }
        math::to_fixed(n, d as usize)
    };
    Ok(V::Text(if no_commas { s } else { commas(&s) }))
}
macro_rules! functions { ($($name:ident),* $(,)?) => { $(fn $name(a:&[V])->Result<V,Failure>{run(stringify!($name),a)})* pub const FUNCTIONS:Table=&[$((stringify!($name),$name)),*]; }; }
#[allow(non_snake_case)]
mod exports {
    use super::*;
    functions!(
        CHAR,
        UNICHAR,
        CLEAN,
        CODE,
        UNICODE,
        CONCAT,
        CONCATENATE,
        DOLLAR,
        EXACT,
        FIND,
        FIXED,
        LEFT,
        LEN,
        LOWER,
        MID,
        NUMBERVALUE,
        PROPER,
        REPLACE,
        REPT,
        RIGHT,
        SEARCH,
        SUBSTITUTE,
        T,
        TEXT,
        TEXTJOIN,
        TRIM,
        UPPER,
        VALUE
    );
}
pub use exports::FUNCTIONS;

fn run(name: &str, a: &[V]) -> Result<V, Failure> {
    let x = arg(a, 0);
    let y = arg(a, 1);
    let z = arg(a, 2);
    let text = |s: String| Ok(V::Text(s));
    let err = |e| Ok(V::Error(e));
    if !matches!(name, "FIXED" | "DOLLAR" | "TEXT") {
        return run_units(name, a);
    }
    match name {
        "FIXED" => fixed(&x, &default(a, 1, V::Number(2.0)), is_truthy(&z)),
        "DOLLAR" => {
            let n = parse_number(&x);
            if is_nan_of(&n) {
                return err(E::Value);
            }
            let decimals = default(a, 1, V::Number(2.0));
            let d = to_js_number(&decimals);
            let parsed = number(&decimals);
            if let Err(e) = parsed {
                return text(format!("Error: {}", e.message()));
            }
            if parsed.as_ref().is_ok_and(|d| d.is_nan()) {
                return text("Error: #VALUE!".into());
            }
            if d >= 101.0 || d == f64::INFINITY {
                return Err(Failure::thrown(
                    "minimumFractionDigits value is out of range.",
                ));
            }
            let n = to_js_number(&n);
            let d = parsed.unwrap();
            let shift = |n: f64, d: f64| {
                let s = format!(
                    "{}e{}",
                    mixdog_js::number_to_string(n),
                    mixdog_js::number_to_string(d)
                );
                let mut p = s.split('e');
                mixdog_js::string_to_number(&format!("{}e{}", p.next().unwrap(), p.next().unwrap()))
            };
            let n = shift(math::round(shift(n.abs(), d)), -d) * if n >= 0.0 { 1.0 } else { -1.0 };
            let digits = if d >= 0.0 { d as usize } else { 0 };
            let s = commas(&currency_digits(n.abs(), digits));
            text(if n < 0.0 {
                format!("$({s})")
            } else if n == 0.0 && n.is_sign_negative() {
                format!("-${s}")
            } else {
                format!("${s}")
            })
        }
        "TEXT" => {
            if matches!(x, V::Undefined | V::Error(_)) || matches!(y, V::Error(_)) {
                return err(E::Na);
            }
            if let V::Date(ms) = x {
                let f = mixdog_js::time::local_fields_in(mixdog_js::time::Tz::UTC, ms)
                    .ok_or_else(|| Failure::thrown("Invalid time value"))?;
                let year = if f.year < 0 {
                    format!("-{:06}", -f.year)
                } else if f.year > 9999 {
                    format!("+{:06}", f.year)
                } else {
                    format!("{:04}", f.year)
                };
                let s = format!("{year}-{:02}-{:02}", f.month, f.day);
                return text(s[..10].into());
            }
            let pattern = match y {
                V::Null | V::Undefined => return text(String::new()),
                V::Number(n) => return text(mixdog_js::number_to_string(n)),
                v if v.is_text() => v.text_units().unwrap(),
                _ => return err(E::Value),
            };
            let currency = if pattern.first() == Some(&36) {
                "$"
            } else {
                ""
            };
            let percent = pattern.last() == Some(&37);
            let p: Vec<_> = pattern
                .into_iter()
                .filter(|u| *u != 37 && *u != 36)
                .collect();
            let d = if let Some(dot) = p.iter().position(|u| *u == 46) {
                let part = p[dot + 1..].split(|u| *u == 46).next().unwrap();
                let n = part.iter().filter(|u| **u == 48).count();
                if n == 0 {
                    return Err(Failure::thrown(
                        "Cannot read properties of null (reading 'length')",
                    ));
                }
                n
            } else {
                0
            };
            let value = if percent {
                V::Number(to_js_number(&x) * 100.0)
            } else {
                x
            };
            let output = fixed(&value, &V::Number(d as f64), !p.contains(&44))?;
            let V::Text(s) = output else {
                return Err(Failure::thrown("value$1.startsWith is not a function"));
            };
            let formatted = if let Some(s) = s.strip_prefix('-') {
                format!("-{currency}{s}")
            } else {
                format!("{currency}{s}")
            };
            text(formatted + if percent { "%" } else { "" })
        }
        _ => unreachable!(),
    }
}
