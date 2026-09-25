//! Request field access with the host's truthiness rules, and the stdout
//! framing: responses carry the response marker, pointer progress its own.

use serde_json::{Map, Value};
use std::io::Write;
use std::sync::Mutex;

pub type Obj = Map<String, Value>;

pub const RESPONSE_MARKER: &str = "@@MIXCU@@";
pub const POINTER_MARKER: &str = "@@MIXDOG_POINTER@@";

static STDOUT: Mutex<()> = Mutex::new(());

pub fn write_line(prefix: &str, value: &Value) {
    let _guard = STDOUT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{prefix}{value}");
    let _ = out.flush();
}

/// A request object. Absent and `null` fields read the same; a string field
/// is present only when non-empty, matching how the host treats them.
#[derive(Clone)]
pub struct Req(pub Value);

impl Req {
    pub fn raw(&self, key: &str) -> Option<&Value> {
        match self.0.get(key) {
            None | Some(Value::Null) => None,
            Some(value) => Some(value),
        }
    }
    pub fn has(&self, key: &str) -> bool {
        self.raw(key).is_some()
    }
    pub fn str(&self, key: &str) -> Option<String> {
        match self.raw(key)? {
            Value::String(text) if !text.is_empty() => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        }
    }
    /// The field as text even when empty; `null` and absence give "".
    pub fn text(&self, key: &str) -> String {
        match self.raw(key) {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Number(number)) => number.to_string(),
            Some(Value::Bool(flag)) => flag.to_string(),
            _ => String::new(),
        }
    }
    pub fn f64(&self, key: &str) -> Option<f64> {
        match self.raw(key)? {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.trim().parse().ok(),
            Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
            _ => None,
        }
    }
    /// Integer conversion rounds half to even, as the host's casts do.
    pub fn int(&self, key: &str) -> Option<i64> {
        self.f64(key).map(round_half_even)
    }
    pub fn bool_true(&self, key: &str) -> bool {
        matches!(self.raw(key), Some(Value::Bool(true)))
    }
    pub fn bool_false(&self, key: &str) -> bool {
        matches!(self.raw(key), Some(Value::Bool(false)))
    }
    /// Loose truthiness for switches the host casts with `[bool]`.
    pub fn truthy(&self, key: &str) -> bool {
        match self.raw(key) {
            None => false,
            Some(Value::Bool(flag)) => *flag,
            Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
            Some(Value::String(text)) => !text.is_empty(),
            Some(_) => true,
        }
    }
    pub fn list(&self, key: &str) -> Vec<Value> {
        match self.raw(key) {
            Some(Value::Array(items)) => items.clone(),
            Some(other) => vec![other.clone()],
            None => Vec::new(),
        }
    }
    pub fn strings(&self, key: &str) -> Vec<String> {
        self.list(key)
            .into_iter()
            .filter_map(|value| match value {
                Value::String(text) => Some(text),
                Value::Number(number) => Some(number.to_string()),
                _ => None,
            })
            .collect()
    }
    pub fn child(&self, key: &str) -> Option<Req> {
        match self.raw(key)? {
            value @ Value::Object(_) => Some(Req(value.clone())),
            _ => None,
        }
    }
    pub fn action(&self) -> String {
        self.text("action")
    }
    pub fn delivery_foreground(&self) -> bool {
        self.text("delivery") == "foreground"
    }
}

pub fn round_half_even(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    let floor = value.floor();
    let diff = value - floor;
    let rounded = if diff > 0.5 {
        floor + 1.0
    } else if diff < 0.5 {
        floor
    } else if (floor as i64) % 2 == 0 {
        floor
    } else {
        floor + 1.0
    };
    rounded as i64
}

/// Builds a JSON object from `key => value` pairs.
#[macro_export]
macro_rules! obj {
    ($($key:expr => $value:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut map = serde_json::Map::new();
        $( map.insert(String::from($key), serde_json::json!($value)); )*
        map
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_strings_are_absent_like_the_host() {
        let req = Req(json!({ "window_id": "", "x": 0, "flag": false }));
        assert!(req.str("window_id").is_none());
        assert!(req.has("x"));
        assert_eq!(req.int("x"), Some(0));
        assert!(req.bool_false("flag"));
        assert!(!req.truthy("flag"));
    }

    #[test]
    fn rounding_matches_banker_casts() {
        assert_eq!(round_half_even(2.5), 2);
        assert_eq!(round_half_even(3.5), 4);
        assert_eq!(round_half_even(-1.5), -2);
        assert_eq!(round_half_even(10.4), 10);
    }
}
