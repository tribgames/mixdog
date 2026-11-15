//! The structure review of an office document snapshot: `reviewOfficeStructure` of
//! `src/runtime/office/quality/assurance-structure.mjs` and the three format reviews it picks from
//! (`assurance-structure-{docx,pptx,xlsx}.mjs`). The input is the portable snapshot as a JSON value; the answer is the
//! list of review records in the order Node writes them, with Node's wording and its float thresholds.

use mixdog_js::{js_to_lowercase, number_to_string, to_number_of};
use serde_json::{Map, Value};

use crate::{field, field_of, text_or};

pub mod docx;
pub mod pptx;
pub mod xlsx;

/// `reviewOfficeStructure({ format, document, auditProfile })`: the review of the format named by `format` (else by
/// `document.format`); a format with no review answers no issues.
pub fn review_office_structure(format: Option<&str>, document: &Value, audit_profile: &str) -> Vec<Value> {
    let named = match format {
        Some(name) if !name.is_empty() => name.to_owned(),
        _ => text_or(field(document, "format"), ""),
    };
    match js_to_lowercase(&named).as_str() {
        "docx" => docx::review_docx_structure(document),
        "xlsx" => xlsx::review_xlsx_structure(document, audit_profile),
        "pptx" => pptx::review_pptx_structure(document, audit_profile),
        _ => Vec::new(),
    }
}

/// `issue(code, path, message, source, severity)` with `path` possibly `undefined`, which JSON.stringify leaves out.
pub(crate) fn record(code: &str, path: Option<String>, message: String, source: &str, severity: &str) -> Value {
    let mut map = Map::new();
    map.insert("severity".into(), severity.into());
    map.insert("code".into(), code.into());
    if let Some(path) = path {
        map.insert("path".into(), path.into());
    }
    map.insert("message".into(), message.into());
    map.insert("source".into(), source.into());
    Value::Object(map)
}

/// `issue(code, path, message)`: a warning of the `format-review` source.
pub(crate) fn warn(code: &str, path: Option<String>, message: String) -> Value {
    record(code, path, message, "format-review", "warning")
}

/// `Number(value)`.
pub(crate) fn num(value: Option<&Value>) -> f64 {
    to_number_of(value)
}

/// `Number(value) || 0`.
pub(crate) fn num0(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() || number == 0.0 { 0.0 } else { number }
}

/// `String(value || '')`.
pub(crate) fn text(value: Option<&Value>) -> String {
    text_or(value, "")
}

/// `String(value || '').trim()`.
pub(crate) fn trimmed(value: Option<&Value>) -> String {
    mixdog_js::js_trim(&text(value)).to_owned()
}

/// `value ?? fallback`: an absent or null value takes the fallback.
pub(crate) fn coalesce<'a>(value: Option<&'a Value>, fallback: Option<&'a Value>) -> Option<&'a Value> {
    match value {
        None | Some(Value::Null) => fallback,
        some => some,
    }
}

/// `value?.[first]?.[second]`.
pub(crate) fn nested<'a>(value: &'a Value, first: &str, second: &str) -> Option<&'a Value> {
    field_of(field(value, first), second)
}

/// `value.length` of a JavaScript string.
pub(crate) fn length(text: &str) -> usize {
    mixdog_js::utf16_len(text)
}

/// `[...new Set(sizes)].sort((left, right) => left - right).join(' / ')`.
pub(crate) fn distinct_sorted(sizes: &[f64]) -> String {
    let mut seen: Vec<f64> = Vec::new();
    for size in sizes {
        if !seen.contains(size) {
            seen.push(*size);
        }
    }
    seen.sort_by(f64::total_cmp);
    seen.iter().map(|size| number_to_string(*size)).collect::<Vec<_>>().join(" / ")
}

/// `Array.isArray(value) ? value : []`.
pub(crate) fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `value.path || fallback`.
pub(crate) fn path_or(value: &Value, fallback: &str) -> String {
    text_or(field(value, "path"), fallback)
}

/// `a || b` where both may be absent: the first truthy text, else none.
pub(crate) fn first_text(candidates: &[Option<&Value>]) -> Option<String> {
    candidates.iter().find(|candidate| crate::is_truthy(**candidate)).map(|candidate| text(*candidate))
}
