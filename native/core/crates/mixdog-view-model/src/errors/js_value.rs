//! The JavaScript reading of a parsed value the error modules share: optional chaining, truthiness, `String(x)` and `Number(x)`.

use mixdog_js::number_to_string;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use serde_json::Value;

/// A JavaScript value: `None` is `undefined`, `Some(Value::Null)` is `null`.
pub type Js<'a> = Option<&'a Value>;

/// The member of an `Error` instance that marks it as one (`error instanceof Error`): a plain object lacks it.
pub const ERROR_INSTANCE_KEY: &str = "$isError";

/// `value?.key`: the member of an object, `undefined` for anything else.
pub fn get<'a>(value: Js<'a>, key: &str) -> Js<'a> {
    value?.as_object()?.get(key)
}

/// `value?.a?.b?...`.
pub fn path<'a>(value: Js<'a>, keys: &[&str]) -> Js<'a> {
    keys.iter().fold(value, |current, key| get(current, key))
}

/// JavaScript truthiness of a parsed value.
pub fn truthy(value: Js) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `a || b || ...`: the first truthy value, else the last one.
pub fn first_truthy<'a>(values: &[Js<'a>]) -> Js<'a> {
    values.iter().copied().find(|value| truthy(*value)).unwrap_or_else(|| values.last().copied().flatten())
}

/// `a ?? b ?? ...`: the first value that is neither `undefined` nor `null`.
pub fn first_defined<'a>(values: &[Js<'a>]) -> Js<'a> {
    values.iter().copied().find(|value| matches!(value, Some(v) if !v.is_null())).flatten()
}

/// `typeof value === 'string'`.
pub fn str_of(value: Js) -> Option<&str> {
    value?.as_str()
}

/// A non-empty string member, as `typeof x === 'string' && x`.
pub fn non_empty_str(value: Js) -> Option<&str> {
    str_of(value).filter(|text| !text.is_empty())
}

/// `typeof value === 'object'` with `value` not null (arrays included).
pub fn is_object(value: Js) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// `String(value)`.
pub fn js_string(value: Js) -> String {
    value.map_or_else(|| "undefined".into(), value_to_string)
}

/// `String(value || '')`.
pub fn string_or_empty(value: Js) -> String {
    if truthy(value) { js_string(value) } else { String::new() }
}

/// `Number(value)`; `undefined` is NaN.
pub fn number(value: Js) -> f64 {
    to_number_of(value)
}

/// `Number(value) || 0`.
pub fn number_or_zero(value: Js) -> f64 {
    let n = number(value);
    if n.is_nan() { 0.0 } else { n }
}

/// `Number.isInteger(n)`.
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// `${n}` of a number.
pub fn num_text(n: f64) -> String {
    number_to_string(n)
}

/// `error instanceof Error`.
pub fn is_error_instance(value: Js) -> bool {
    get(value, ERROR_INSTANCE_KEY).is_some_and(|mark| mark == &Value::Bool(true))
}

/// The wall clock as a JavaScript time value (`Date.now()`).
pub fn system_now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}
