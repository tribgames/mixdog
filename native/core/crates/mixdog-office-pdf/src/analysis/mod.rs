//! `pdf/pdf-analysis.mjs`: the layout of a PDF's text with the ruled lines, boxes and links it paints (`layout`), the
//! tables read from that layout (`tables`), the images a page paints (`images`) and the flattened outline
//! (`outline`). The text search over a layout lives in [`crate::search`] and stays reachable from here, so the adapter
//! and the tool surface keep one import.

use mixdog_js::{is_js_space, math::to_fixed, string_to_number};
use serde_json::{Map, Value};

pub mod images;
pub mod layout;
pub mod outline;
pub mod tables;

pub use crate::search::find_pdf_text;

/// `Number(Number(value).toFixed(2))` (`round2` of `pdf-draw.mjs`).
pub(crate) fn round2(value: f64) -> f64 {
    round_to(value, 2)
}

/// `Number(value.toFixed(digits))`.
pub(crate) fn round_to(value: f64, digits: usize) -> f64 {
    string_to_number(&to_fixed(value, digits))
}

/// `Math.min(a, b)`: a NaN anywhere is NaN.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `Math.max(a, b)`: a NaN anywhere is NaN.
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min(...values)`: `Infinity` for none.
pub(crate) fn min_of(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::INFINITY, js_min)
}

/// `Math.max(...values)`: `-Infinity` for none.
pub(crate) fn max_of(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::NEG_INFINITY, js_max)
}

/// `text.replace(/\s+/g, ' ')`.
pub(crate) fn collapse_spaces(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

/// A number as `JSON.stringify` writes it: a whole number without a fraction, `null` for NaN and the infinities.
pub(crate) fn json_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

/// An object with its keys in the given order.
pub(crate) fn object(pairs: Vec<(&str, Value)>) -> Value {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert(key.to_owned(), value);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_follows_to_fixed() {
        assert_eq!(round2(0.125), 0.13);
        assert_eq!(round2(1.005), 1.0);
        assert_eq!(round2(-0.001), 0.0);
        assert!(round2(f64::NAN).is_nan());
        assert_eq!(round_to(0.6666, 3), 0.667);
    }

    #[test]
    fn min_and_max_carry_a_nan_like_math() {
        assert!(min_of([1.0, f64::NAN, 2.0]).is_nan());
        assert!(max_of([f64::NAN]).is_nan());
        assert_eq!(min_of([3.0, 1.0, 2.0]), 1.0);
        assert_eq!(max_of([]), f64::NEG_INFINITY);
    }

    #[test]
    fn white_space_runs_become_one_space() {
        assert_eq!(collapse_spaces("a \t\u{a0} b\n\nc "), "a b c ");
        assert_eq!(collapse_spaces(""), "");
    }

    #[test]
    fn numbers_are_written_as_json_does() {
        assert_eq!(json_number(12.0), Value::from(12));
        assert_eq!(json_number(-0.0), Value::from(0));
        assert_eq!(json_number(1.5), serde_json::json!(1.5));
        assert_eq!(json_number(f64::NAN), Value::Null);
    }
}
