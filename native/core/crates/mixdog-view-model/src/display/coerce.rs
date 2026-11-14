//! The JavaScript coercions the display modules read a JSON value through.

use mixdog_js::to_number_of;
use serde_json::Value;

/// `value?.key`.
pub(crate) fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|value| value.get(key))
}

/// `Number(value) || 0`: a number that is not a number, or zero, reads 0 (infinity stays).
pub(crate) fn number_or_zero(value: Option<&Value>) -> f64 {
    let n = to_number_of(value);
    if n.is_nan() { 0.0 } else { n }
}

/// `Number.isFinite(Number(value)) ? Number(value) : 0`.
pub(crate) fn finite_or_zero(value: Option<&Value>) -> f64 {
    let n = to_number_of(value);
    if n.is_finite() { n } else { 0.0 }
}

/// JavaScript truthiness of a value (absent is falsy).
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a || b`.
pub(crate) fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

/// `value || undefined`: the value when it is truthy.
pub(crate) fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| truthy(Some(*value)))
}

/// `String(value ?? '')`: null and absent are empty.
pub(crate) fn text_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => mixdog_js::value_to_string(value),
    }
}
