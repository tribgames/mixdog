//! The JavaScript value tests the desktop's readers apply to stored JSON.

use serde_json::Map;
use serde_json::Number;
use serde_json::Value;

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub(super) fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// A JSON number that is an integer in the safe range (`Number.isSafeInteger`).
pub(super) fn safe_integer(value: &Value) -> Option<i64> {
    let number = value.as_number()?;
    let integer = match number.as_i64() {
        Some(integer) => integer,
        None => {
            let float = number.as_f64()?;
            if float.fract() != 0.0 || float.abs() > MAX_SAFE_INTEGER as f64 {
                return None;
            }
            float as i64
        }
    };
    (integer.abs() <= MAX_SAFE_INTEGER).then_some(integer)
}

pub(super) use mixdog_js::to_number;

/// `Number.isInteger`.
pub(super) fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

/// `Number.isSafeInteger`.
pub(super) fn is_safe_integer(number: f64) -> bool {
    is_integer(number) && number.abs() <= MAX_SAFE_INTEGER as f64
}

/// A JavaScript number as the JSON number the desktop would write for it.
pub(super) fn json_number(number: f64) -> Option<Number> {
    match mixdog_js::json_number(number) {
        Value::Number(number) => Some(number),
        _ => None,
    }
}

/// A finite number above zero, as stored.
pub(super) fn positive(value: &Value) -> Option<&Number> {
    let number = value.as_number()?;
    (number.as_f64()? > 0.0).then_some(number)
}

/// `^[A-Za-z0-9_-]+$`, the desktop's `isSessionId`.
pub(super) fn is_session_id(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `Number(JSON.parse(input))`; `None` is NaN.
    #[test]
    fn to_number_matches_node() {
        let cases: &[(&str, Option<f64>)] = &[
            ("null", Some(0.0)), ("true", Some(1.0)), ("false", Some(0.0)), (r#""""#, Some(0.0)),
            (r#"" ""#, Some(0.0)), (r#""  12  ""#, Some(12.0)), (r#""0x10""#, Some(16.0)),
            (r#""0b11""#, Some(3.0)), (r#""0o7""#, Some(7.0)), (r#""-0x1""#, None), (r#""+5""#, Some(5.0)),
            (r#""-5""#, Some(-5.0)), (r#""1e3""#, Some(1000.0)), (r#""1.""#, Some(1.0)),
            (r#"".5""#, Some(0.5)), (r#"".""#, None), (r#""1_0""#, None),
            (r#""Infinity""#, Some(f64::INFINITY)), (r#""-Infinity""#, Some(f64::NEG_INFINITY)),
            (r#""infinity""#, None), (r#""NaN""#, None), (r#""4abc""#, None),
            (r#""\u00a05\ufeff""#, Some(5.0)), ("[]", Some(0.0)), ("[5]", Some(5.0)), (r#"["7"]"#, Some(7.0)),
            ("[null]", Some(0.0)), ("[true]", None), ("[1,2]", None), ("[[3]]", Some(3.0)), ("{}", None),
            (r#"{"a":1}"#, None), ("1.5", Some(1.5)), (r#""1e""#, None), (r#""0x""#, None),
            (r#""12.5e-1""#, Some(1.25)),
        ];
        for (input, expected) in cases {
            let got = to_number(&serde_json::from_str(input).unwrap());
            match expected {
                Some(want) => assert_eq!(got, *want, "{input}"),
                None => assert!(got.is_nan(), "{input} gave {got}"),
            }
        }
    }
}
