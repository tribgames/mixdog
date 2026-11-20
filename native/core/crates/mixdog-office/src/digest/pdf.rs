//! The PDF digest. A PDF read lists every family it looks for (attachments, outline, scanned pages) and every flag, almost
//! all of them empty or off. What reads the same absent goes: an empty list, a zero count, an off flag, a blank metadata
//! entry, the pagination of a read that holds every page, a page's upright rotation, a field that is neither read-only,
//! required nor multiline. An encrypted file keeps `passwordRequired` either way; coordinates keep two places.

use mixdog_js::to_number_of;
use serde_json::Value;

use super::common::{Object, entries, filtered, is_bool, is_str, is_truthy, remove, round2};

/// Flags that say something when they are off.
fn kept_false(key: &str) -> bool {
    matches!(key, "passwordRequired" | "value")
}

fn without_pdf_defaults(entry: &Object) -> Object {
    filtered(entry, |key, field| {
        !field.is_null() && !(is_bool(Some(field), false) && !kept_false(key)) && !matches!(field, Value::Array(items) if items.is_empty())
    })
}

fn page_digest(page: &Value) -> Value {
    let empty = Object::new();
    let map = match page {
        Value::Object(map) => map,
        _ => &empty,
    };
    let mut digest = Object::new();
    for (key, value) in entries(map) {
        if !matches!(key.as_str(), "rotation" | "width" | "height") {
            digest.insert(key.clone(), value.clone());
        }
    }
    for key in ["width", "height"] {
        if let Some(value) = map.get(key) {
            digest.insert(key.to_owned(), round2(value));
        }
    }
    if let Some(rotation) = map.get("rotation").filter(|rotation| is_truthy(Some(rotation))) {
        digest.insert("rotation".to_owned(), rotation.clone());
    }
    Value::Object(digest)
}

fn field_digest(field: &Value) -> Value {
    let Value::Object(map) = field else { return field.clone() };
    let mut kept = without_pdf_defaults(map);
    if let Some(Value::Array(widgets)) = kept.get("widgets") {
        let widgets = widgets
            .iter()
            .map(|widget| {
                let rounded: Object = match widget {
                    Value::Object(widget) => entries(widget).into_iter().map(|(key, point)| (key.clone(), round2(point))).collect(),
                    _ => Object::new(),
                };
                Value::Object(rounded)
            })
            .collect();
        kept.insert("widgets".to_owned(), Value::Array(widgets));
    }
    Value::Object(kept)
}

/// The document a model reads.
pub fn pdf_document_digest(document: &Value) -> Value {
    let Value::Object(map) = document else { return document.clone() };
    if !is_str(map.get("format"), "pdf") {
        return document.clone();
    }
    let mut digest = without_pdf_defaults(map);
    let zero_counts: Vec<String> = digest
        .iter()
        .filter(|(key, value)| key.ends_with("Count") && key.as_str() != "pageCount" && value.as_f64() == Some(0.0))
        .map(|(key, _)| key.clone())
        .collect();
    for key in zero_counts {
        remove(&mut digest, &key);
    }
    if let Some(Value::Object(metadata)) = digest.get("metadata") {
        let metadata = filtered(metadata, |_, field| !is_str(Some(field), "") && !field.is_null());
        if metadata.is_empty() {
            remove(&mut digest, "metadata");
        } else {
            digest.insert("metadata".to_owned(), Value::Object(metadata));
        }
    }
    if let Some(pagination) = digest.get("pagination") {
        let holds_every_page = is_truthy(Some(pagination)) && !is_bool(pagination.get("hasMore"), true) && !(to_number_of(pagination.get("offset")) > 0.0);
        if holds_every_page {
            remove(&mut digest, "pagination");
        }
    }
    if let Some(Value::Array(pages)) = digest.get("pages") {
        let pages = pages.iter().map(page_digest).collect();
        digest.insert("pages".to_owned(), Value::Array(pages));
    }
    if let Some(Value::Array(fields)) = digest.get("fields") {
        let fields = fields.iter().map(field_digest).collect();
        digest.insert("fields".to_owned(), Value::Array(fields));
    }
    Value::Object(digest)
}
