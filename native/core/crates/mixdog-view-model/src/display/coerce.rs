//! The JavaScript coercions the display modules read a JSON value through.

use mixdog_js::to_number_of;
use serde_json::Value;

// JavaScript truthiness (absent is falsy) and `String(value ?? '')` are the crate's own, in `tool_primitives`.
pub(crate) use crate::tool_primitives::truthy;
pub(crate) use crate::tool_primitives::text_of as text_nullish;

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

/// `a || b`.
pub(crate) fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

/// `value || undefined`: the value when it is truthy.
pub(crate) fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| truthy(Some(*value)))
}
