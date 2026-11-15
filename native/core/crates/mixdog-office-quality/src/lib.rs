//! The office quality pipeline: the review issue record, the split of blocking integrity faults from advisory taste
//! observations, the polish plan and the submission gate, the release score, and the document and presentation
//! acceptance verdicts with the task checklist. Ported from `src/runtime/office/quality/{quality-pipeline,
//! quality-score,document-acceptance,presentation-acceptance,assurance-checklist,assurance-issue}.mjs`. Inputs and
//! outputs are JSON values with the key order Node writes, so the user-visible wording and the numbers are Node's.

use mixdog_js::value_to_string;
use mixdog_office_base::values::truthy;
use serde_json::Value;

pub mod checklist;
pub mod document_acceptance;
pub mod issue;
pub mod pipeline;
pub mod presentation_acceptance;
pub mod score;
pub mod document_brief;
pub mod document_design_review;
pub mod trust;
pub mod aesthetics;
mod aesthetics_metrics;
pub mod render_air;
pub mod rendered;
pub mod visual_diff;

/// `value[key]` of a plain object; `None` (JavaScript `undefined`) for anything else or an absent key.
pub(crate) fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|map| map.get(key))
}

/// `value?.[key]` where the value itself may be absent.
pub(crate) fn field_of<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|inner| field(inner, key))
}

/// A value inside a template literal: absent is `undefined`.
pub(crate) fn template_text(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(value || fallback)`.
pub(crate) fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(inner) if truthy(inner) => value_to_string(inner),
        _ => fallback.to_owned(),
    }
}

/// `Boolean(value)`.
pub(crate) fn is_truthy(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `value === true`.
pub(crate) fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

/// `left === right` for parsed JSON values: primitives by value, an absent value only equals an absent one, and an
/// object or array (a reference in JavaScript) never equals another.
pub(crate) fn strict_equals(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        _ => false,
    }
}
