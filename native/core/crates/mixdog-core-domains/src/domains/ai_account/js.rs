//! The JavaScript number and string operations the two services port from Node, written once.

use mixdog_js::js_trim;
use mixdog_js::number_to_string;
use mixdog_js::to_number;
use serde_json::Value;

/// `Math.round`: ties toward +∞.
pub fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Number.prototype.toFixed` for `0 <= digits <= 20`: the exact decimal expansion rounded
/// half-up (ties toward the larger magnitude, as the specification's "larger n" does).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_to_string(x);
    }
    let negative = x < 0.0;
    let exact = format!("{:.*}", digits + 80, x.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
    if fraction.as_bytes().get(digits).is_some_and(|d| *d >= b'5') {
        let mut at = kept.len();
        loop {
            if at == 0 {
                kept.insert(0, b'1');
                break;
            }
            at -= 1;
            if kept[at] == b'9' {
                kept[at] = b'0';
            } else {
                kept[at] += 1;
                break;
            }
        }
    }
    let split = kept.len() - digits;
    let (int_part, frac_part) = kept.split_at(split);
    let mut out = String::from_utf8_lossy(int_part).into_owned();
    if digits > 0 {
        out.push('.');
        out.push_str(&String::from_utf8_lossy(frac_part));
    }
    // `(-0.0001).toFixed(2)` keeps its sign; `(-0).toFixed(2)` does not.
    if negative && x != 0.0 { format!("-{out}") } else { out }
}

pub use mixdog_js::json_number as number;

/// The shared `num(value, fallback)` of the usage modules: null, absent and `''` are the
/// fallback, as is anything that is not a finite number.
pub fn num_or(value: Option<&Value>, fallback: Option<f64>) -> Option<f64> {
    match value {
        None | Some(Value::Null) => fallback,
        Some(Value::String(text)) if text.is_empty() => fallback,
        Some(other) => {
            let n = to_number(other);
            if n.is_finite() { Some(n) } else { fallback }
        }
    }
}

/// `usage-primitives.round(value, digits)`; `None` where JS returns `null` (not finite).
pub fn round_to(value: f64, digits: i32) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    let scale = 10f64.powi(digits);
    Some(math_round(value * scale) / scale)
}

/// `typeof value === 'string' ? value.trim() : ''`.
pub fn clean(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => String::new(),
    }
}

/// JS truthiness.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_the_engine() {
        // Values from `Number.prototype.toFixed` in V8.
        let cases: &[(f64, usize, &str)] = &[
            (0.5, 0, "1"),
            (2.5, 0, "3"),
            (1.005, 2, "1.00"),
            (1.45, 1, "1.4"),
            (0.0, 2, "0.00"),
            (-0.0001, 2, "-0.00"),
            (10.0, 0, "10"),
            (9.995, 2, "9.99"),
            (123.456, 3, "123.456"),
            (0.00005, 4, "0.0001"),
            (1e21, 2, "1e+21"),
            (99.5, 0, "100"),
            (0.045, 3, "0.045"),
        ];
        for (x, digits, want) in cases {
            assert_eq!(to_fixed(*x, *digits), *want, "{x}.toFixed({digits})");
        }
    }

    #[test]
    fn round_and_number() {
        assert_eq!(math_round(-0.5), 0.0);
        assert_eq!(math_round(2.5), 3.0);
        assert_eq!(round_to(1.23456, 4), Some(1.2346));
        assert_eq!(number(3.0), Value::from(3));
        assert_eq!(number(0.25).to_string(), "0.25");
    }
}
