//! `Number(value)` and `String(number)` as V8 computes them.

use serde_json::Value;

use crate::text::js_trim;

/// `Number(string)` (StringToNumber): the text is trimmed of JavaScript white space; empty is 0;
/// `0x`/`0o`/`0b` literals (unsigned); `±Infinity`; a decimal literal; anything else is NaN.
pub fn string_to_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some(16),
            b'o' | b'O' => Some(8),
            b'b' | b'B' => Some(2),
            _ => None,
        };
        if let Some(radix) = radix {
            return radix_literal(&text[2..], radix);
        }
    }
    let (negative, unsigned) = match bytes[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    let magnitude = if unsigned == "Infinity" {
        f64::INFINITY
    } else if is_decimal_literal(unsigned) {
        // Rust's parse is correctly rounded like V8's; the grammar above keeps out `inf`/`nan`.
        unsigned.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        return f64::NAN;
    };
    if negative { -magnitude } else { magnitude }
}

/// `StrDecimalLiteral` without sign: `digits [. digits?] | . digits`, then an optional exponent.
fn is_decimal_literal(text: &str) -> bool {
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], Some(&text[at + 1..])),
        None => (text, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((whole, fraction)) => {
            (whole.is_empty() || digits(whole))
                && (fraction.is_empty() || digits(fraction))
                && !(whole.is_empty() && fraction.is_empty())
        }
        None => digits(mantissa),
    };
    mantissa_ok && exponent.is_none_or(|e| digits(e.strip_prefix(['+', '-']).unwrap_or(e)))
}

/// A `0x`/`0o`/`0b` literal's value, rounded to nearest-even like V8 for any length.
fn radix_literal(digits: &str, radix: u32) -> f64 {
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return f64::NAN;
    }
    let bits_per_digit = radix.trailing_zeros();
    let mut bits: Vec<bool> = Vec::with_capacity(digits.len() * bits_per_digit as usize);
    for c in digits.chars() {
        let value = c.to_digit(radix).expect("checked above");
        for shift in (0..bits_per_digit).rev() {
            bits.push(value >> shift & 1 == 1);
        }
    }
    let Some(first) = bits.iter().position(|b| *b) else {
        return 0.0;
    };
    let significant = &bits[first..];
    let take = significant.len().min(53);
    let mut mantissa = significant[..take].iter().fold(0u64, |acc, b| acc << 1 | u64::from(*b));
    let mut exponent = (significant.len() - take) as i32;
    if significant.len() > 53 {
        let half = significant[53];
        let sticky = significant[54..].iter().any(|b| *b);
        if half && (sticky || mantissa & 1 == 1) {
            mantissa += 1;
        }
    }
    if mantissa == 1 << 53 {
        mantissa >>= 1;
        exponent += 1;
    }
    if exponent > 1023 {
        return f64::INFINITY;
    }
    mantissa as f64 * 2f64.powi(exponent)
}

/// `String(number)` (Number::toString, radix 10).
pub fn number_to_string(number: f64) -> String {
    if number.is_nan() {
        return "NaN".into();
    }
    if number == 0.0 {
        return "0".into();
    }
    if number.is_infinite() {
        return if number < 0.0 { "-Infinity" } else { "Infinity" }.into();
    }
    let sign = if number < 0.0 { "-" } else { "" };
    // Shortest round-trip digits `d.ddd` and exponent: value = 0.digits * 10^n.
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("scientific form");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let exp = format!("e{}{}", if e < 0 { '-' } else { '+' }, e.abs());
        if k == 1 { format!("{digits}{exp}") } else { format!("{}.{}{exp}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// `String(value)` for a parsed JSON value: arrays join their elements with commas (null as
/// empty), objects are `[object Object]`.
pub fn value_to_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { value_to_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number(value)` for a parsed JSON value: null is 0, booleans 1/0, a string its numeric value,
/// an array or object the number its string form gives.
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => string_to_number(text),
        Value::Array(_) | Value::Object(_) => string_to_number(&value_to_string(value)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `[input, expected]` rows written by Node: the expected `Number(input)` as its IEEE bits in
    /// hex (`-0` and NaN included).
    const NUMBER_ROWS: &str = include_str!("../testdata/number_coercion.json");
    /// `[bits, String(number)]` rows written by Node.
    const STRING_ROWS: &str = include_str!("../testdata/number_to_string.json");

    fn bits(number: f64) -> String {
        if number.is_nan() { "nan".into() } else { format!("{:016x}", number.to_bits()) }
    }

    #[test]
    fn number_of_a_string_matches_node() {
        let rows: Vec<(String, String)> = serde_json::from_str(NUMBER_ROWS).expect("fixture");
        assert_eq!(rows.len(), 227);
        for (input, expected) in rows {
            assert_eq!(bits(string_to_number(&input)), expected, "Number({input:?})");
        }
    }

    #[test]
    fn string_of_a_number_matches_node() {
        let rows: Vec<(String, String)> = serde_json::from_str(STRING_ROWS).expect("fixture");
        assert!(rows.len() > 200);
        for (hex, expected) in rows {
            let number = f64::from_bits(u64::from_str_radix(&hex, 16).expect("bits"));
            assert_eq!(number_to_string(number), expected, "{hex}");
        }
    }

    #[test]
    fn json_values_coerce_like_number_and_string() {
        let cases: &[(&str, Option<f64>, &str)] = &[
            ("null", Some(0.0), "null"),
            ("true", Some(1.0), "true"),
            ("[]", Some(0.0), ""),
            ("[null]", Some(0.0), ""),
            ("[true]", None, "true"),
            ("[[3]]", Some(3.0), "3"),
            ("[1,2]", None, "1,2"),
            ("[\" 7 \"]", Some(7.0), " 7 "),
            ("{}", None, "[object Object]"),
            ("[1,[2,null],{}]", None, "1,2,,[object Object]"),
        ];
        for (input, number, text) in cases {
            let value: Value = serde_json::from_str(input).expect("json");
            match number {
                Some(want) => assert_eq!(to_number(&value), *want, "{input}"),
                None => assert!(to_number(&value).is_nan(), "{input}"),
            }
            assert_eq!(value_to_string(&value), *text, "{input}");
        }
    }
}
