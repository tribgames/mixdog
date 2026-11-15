//! `design/native-design.mjs`: native documents stay native. A profile or a composer is an explicit request for a
//! preset; otherwise the author's own design is carried through, with no automatic art direction.

use mixdog_office_base::values::{clone, plain_object, truthy};
use serde_json::{Map, Value, json};

use crate::content_model::{normalize_office_content_model, summarize_office_content_model};
use crate::creative_director::compose_operation;
use crate::{prop, text};

/// `usesNativeOfficeDesign(format, request, operations)`: whether a design request is the author's own. A request
/// naming a profile (or written as one) asks for a preset, and so does an operation list holding the format's composer.
pub fn uses_native_office_design(format: &str, request: &Value, operations: &[Value]) -> bool {
    if !["docx", "xlsx", "pdf"].contains(&format) {
        return false;
    }
    if request.is_string() || prop(request, "profile").is_some_and(truthy) {
        return false;
    }
    let composer = compose_operation(format);
    // `operation?.op === COMPOSE_OPERATION[format]`: a format with no composer matches an operation that names none.
    !operations.iter().any(|operation| match (prop(operation, "op"), composer) {
        (Some(Value::String(named)), Some(composer)) => named.as_str() == composer,
        (None, None) => true,
        _ => false,
    })
}

/// `nativeOfficeDesign(format, request)`: the design a native request carries.
pub fn native_office_design(format: &str, request: &Value) -> Result<Value, String> {
    let empty = Value::Object(Map::new());
    let input = if plain_object(request) { request } else { &empty };
    let mut design = Map::new();
    design.insert("authoring".into(), json!("native"));
    design.insert("source".into(), json!("author-specified"));
    design.insert("format".into(), json!(format));
    design.insert("intent".into(), Value::String(text(prop(input, "intent"))));
    design.insert("audience".into(), Value::String(text(prop(input, "audience"))));
    for key in ["palette", "typography"] {
        if let Some(written) = prop(input, key).filter(|written| truthy(written)) {
            design.insert(key.into(), clone(written));
        }
    }
    design.insert("content".into(), normalize_office_content_model(prop(input, "content"))?);
    design.insert("review".into(), json!({ "required": prop(input, "review") != Some(&Value::Bool(false)) }));
    Ok(Value::Object(design))
}

/// `nativeDesignReceipt(design)`: the design with its content model summarised.
pub fn native_design_receipt(design: &Value) -> Value {
    let mut receipt = design.clone();
    if let Some(map) = receipt.as_object_mut() {
        map.insert("content".into(), summarize_office_content_model(prop(design, "content")));
    }
    receipt
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_or_a_composer_asks_for_a_preset() {
        let none: [Value; 0] = [];
        assert!(uses_native_office_design("docx", &json!({}), &none));
        assert!(!uses_native_office_design("docx", &json!("editorial"), &none));
        assert!(!uses_native_office_design("xlsx", &json!({ "profile": "data" }), &none));
        assert!(!uses_native_office_design("pptx", &json!({}), &none));
        assert!(!uses_native_office_design("docx", &json!({}), &[json!({ "op": "compose_document" })]));
        assert!(uses_native_office_design("docx", &json!({}), &[json!({ "op": "compose_sheet" })]));
        assert!(!uses_native_office_design("pdf", &json!(null), &[json!({})]));
        assert!(uses_native_office_design("pdf", &json!(null), &[json!({ "op": "x" })]));
    }

    #[test]
    fn a_native_design_carries_the_authors_fields_and_a_summarised_content() {
        let design = native_office_design("docx", &json!({ "intent": "i", "palette": { "accent": "112233" }, "review": false })).expect("design");
        assert_eq!(
            design,
            json!({ "authoring": "native", "source": "author-specified", "format": "docx", "intent": "i", "audience": "", "palette": { "accent": "112233" }, "content": null, "review": { "required": false } })
        );
        assert_eq!(native_design_receipt(&design)["content"], Value::Null);
        assert_eq!(native_office_design("docx", &json!({ "content": 3 })), Err("Office design.content must be an object".to_owned()));
        assert_eq!(native_office_design("pdf", &json!("x")).expect("design")["review"], json!({ "required": true }));
    }
}
