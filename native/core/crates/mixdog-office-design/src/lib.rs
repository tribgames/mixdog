//! The design layer of the office engine, ported from `src/runtime/office/design/`: the font allowlist, contrast repair
//! and hue limits (`discipline`), the profile packs and the resolved design (`tokens`), the subject-seeded art
//! directions (`art_direction`), the story brief of the composers (`creative_director`), the content model of facts
//! and claims (`content_model`) and the one reading of a preset table (`table_input`).
//!
//! Everything is pure. Values are `serde_json` values with `preserve_order`, built in the order Node's objects are
//! built, so `mixdog_js::json_stringify` of an output is the text `JSON.stringify` gives. JavaScript semantics
//! (`String(x || '')`, `trim`, `toLowerCase`, number text) come from `mixdog-js`.

pub mod art_direction;
pub mod content_model;
pub mod creative_director;
pub mod discipline;
pub mod table_input;
pub mod tokens;
pub mod docx;
pub mod library;
pub mod xlsx;
pub mod composition;
pub mod design_system;
pub mod native_design;
pub mod templates;

use mixdog_js::value_to_string;
use mixdog_office_base::values::truthy;
use serde_json::Value;

/// `value[key]` of an object; absent for any other kind of value (`undefined`).
pub(crate) fn prop<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

/// `value?.[key]` of a value that may itself be absent.
pub(crate) fn opt_prop<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|inner| prop(inner, key))
}

/// `String(value || '')`.
pub(crate) fn text(value: Option<&Value>) -> String {
    match value {
        Some(inner) if truthy(inner) => value_to_string(inner),
        _ => String::new(),
    }
}

/// [`text`] of a value that is present.
pub(crate) fn text_of(value: &Value) -> String {
    text(Some(value))
}

/// The first truthy candidate: `a || b || c`.
pub(crate) fn first_truthy<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a Value> {
    candidates.iter().flatten().copied().find(|value| truthy(value))
}

/// `String(a || b || … || '')`.
pub(crate) fn first_text(candidates: &[Option<&Value>]) -> String {
    text(first_truthy(candidates))
}

/// `Array.isArray(value) ? value : none`.
pub(crate) fn array_of(value: Option<&Value>) -> Option<&Vec<Value>> {
    value.and_then(Value::as_array)
}

/// `value !== false` for a property: only a present `false` makes it false.
pub(crate) fn is_not_false(value: Option<&Value>) -> bool {
    value != Some(&Value::Bool(false))
}
