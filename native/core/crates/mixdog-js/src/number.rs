//! `Number(value)` and `String(number)` as V8 computes them.

mod radix;
pub use radix::{number_to_radix, parse_int_radix};

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

/// `Number(value)` of a value that may be absent (`undefined`, so NaN).
pub fn to_number_of(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// The JSON value a JavaScript number round-trips to through `JSON.stringify`/`JSON.parse`: an
/// integral value inside the safe range is an integer (`-0` is 0), a non-finite one is null, and
/// anything else is the number V8 prints, so serialising it gives V8's digits.
pub fn json_number(number: f64) -> Value {
    if !number.is_finite() {
        return Value::Null;
    }
    if number.fract() == 0.0 && number.abs() < 9_007_199_254_740_992.0 {
        return Value::from(number as i64);
    }
    serde_json::from_str(&number_to_string(number)).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

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


    #[test]
    fn a_string_converts_by_the_string_numeric_literal_grammar() {
        for (input, want) in [
            ("", 0.0),
            ("  \t\n ", 0.0),
            (" 12 ", 12.0),
            ("\u{feff}7\u{a0}", 7.0),
            ("+5", 5.0),
            ("-5", -5.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+.5e1", 5.0),
            ("1e3", 1000.0),
            ("1E-2", 0.01),
            ("0x1F", 31.0),
            ("0X1f", 31.0),
            ("0b101", 5.0),
            ("0o17", 15.0),
            ("007", 7.0),
            ("Infinity", f64::INFINITY),
            ("+Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
            ("1e999", f64::INFINITY),
            ("1e-999", 0.0),
            ("9007199254740993", 9007199254740992.0),
        ] {
            assert_eq!(string_to_number(input), want, "Number({input:?})");
        }
        assert!(string_to_number("-0").is_sign_negative() && string_to_number("-0") == 0.0);
    }

    #[test]
    fn a_string_outside_the_grammar_converts_to_nan() {
        for input in [
            "abc", "12px", "1 2", ".", "e5", "1e", "1e+", "0x", "0xg", "-0x10", "+0x10", "0b2", "0o8", "1_000", "infinity", "INFINITY", "Inf", "NaN",
            "--1", "1..2", "0x1.8", "\u{200b}1", "\u{85}1",
        ] {
            assert!(string_to_number(input).is_nan(), "Number({input:?})");
        }
    }

    #[test]
    fn a_number_is_written_by_number_tostring() {
        for (number, text) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (0.1 + 0.2, "0.30000000000000004"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (1.5e-10, "1.5e-10"),
            (123456789012345680000.0, "123456789012345680000"),
            (1e21, "1e+21"),
            (1.2345e25, "1.2345e+25"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (9007199254740992.0, "9007199254740992"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(number_to_string(number), text, "{number:e}");
        }
    }

    #[test]
    fn json_number_is_what_json_stringify_round_trips_to() {
        for number in [0.0, -0.0, 1.0, -1.5, 0.1, 1e21, 1e-7, 5e-324, f64::MAX, 9007199254740993.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let hex = format!("{:x}", number.to_bits());
            let value = json_number(number);
            if number.is_finite() {
                assert_eq!(value.as_f64(), Some(if number == 0.0 { 0.0 } else { number }), "{hex}");
            } else {
                assert!(value.is_null(), "{hex}");
            }
        }
        // `JSON.stringify` in Node: 1e15 -> 1000000000000000, 2**60 -> 1152921504606847000,
        // 0.1 + 0.2 -> 0.30000000000000004, -0 -> 0, NaN -> null.
        for (number, text) in [
            (1e15, "1000000000000000"),
            (9e15, "9000000000000000"),
            (1152921504606846976.0, "1152921504606847000"),
            (0.1 + 0.2, "0.30000000000000004"),
            (-0.0, "0"),
            (f64::NAN, "null"),
            (f64::INFINITY, "null"),
        ] {
            assert_eq!(json_number(number).to_string(), text, "{number}");
        }
        assert!(json_number(1.0).is_i64());
    }
}

