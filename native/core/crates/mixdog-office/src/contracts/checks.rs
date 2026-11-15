//! The faults one operation can carry once the contract's rewrites are done: fields and properties it does not take,
//! the two alignments of a Word table, a style definition with a misspelt field, a missing required input and an
//! `add_validation` rule that cannot be read. Each returns the message Node's contract engine throws for it.

use mixdog_js::{js_object_keys, js_to_lowercase, js_trim, json_stringify, value_to_string};
use mixdog_office_base::docx_style_defs::docx_style_definitions;
use mixdog_office_base::xlsx_validation::normalize_xlsx_validation;
use serde_json::{Map, Value};

use super::describe_hint;
use super::suggest::{did_you_mean, field_corrections};
use crate::capabilities::{Signature, capabilities};

/// Where a fault is reported: the batch's format and backend, the operation's name and its place in the batch.
pub(super) struct Site<'a> {
    pub format: &'a str,
    pub backend: &'a str,
    pub name: &'a str,
    pub index: usize,
}

impl Site<'_> {
    /// `${FORMAT} operation "${name}" at operation ${n}`.
    fn at(&self) -> String {
        format!("{} operation \"{}\" at operation {}", self.format.to_uppercase(), self.name, self.index + 1)
    }

    fn hint(&self) -> String {
        describe_hint(self.format, self.backend, self.name)
    }
}

/// `suppliedField`: a field the caller gave, or the stable id (`slideId`, `shapeId`) that stands for it on a
/// stable-target backend.
pub(super) fn supplied_field(operation: &Map<String, Value>, field: &str, stable_targets: bool) -> bool {
    operation.contains_key(field)
        || (stable_targets && matches!(field, "slide" | "shape") && operation.contains_key(&format!("{field}Id")))
}

/// `unknownFieldsFault`: fields the operation does not take. A style key passed as a field is not a typo: it belongs in
/// `properties`, and a declared style key written one level up is unambiguous, so it is applied where it belongs. Only
/// a key the operation contradicts (the same name present in `properties` with another value) or a field nothing
/// declares is worth an answer.
pub(super) fn unknown_fields_fault(
    site: &Site,
    operation: &mut Map<String, Value>,
    allowed: &[String],
    property_keys: &[String],
    missing: &[String],
) -> Option<String> {
    let unknown: Vec<String> =
        js_object_keys(operation).into_iter().filter(|field| !allowed.contains(field)).cloned().collect();
    if unknown.is_empty() {
        return None;
    }
    let hoisted: Vec<String> = unknown
        .iter()
        .filter(|field| {
            property_keys.contains(field)
                && match operation.get("properties") {
                    None => true,
                    Some(Value::Object(properties)) => !properties.contains_key(*field),
                    Some(_) => false,
                }
        })
        .cloned()
        .collect();
    if !hoisted.is_empty() {
        let mut properties = match operation.get("properties") {
            Some(Value::Object(properties)) => properties.clone(),
            _ => Map::new(),
        };
        for field in &hoisted {
            if let Some(value) = operation.shift_remove(field) {
                properties.insert(field.clone(), value);
            }
        }
        operation.insert("properties".to_owned(), Value::Object(properties));
    }
    let remaining: Vec<String> = unknown.into_iter().filter(|field| !hoisted.contains(field)).collect();
    if remaining.is_empty() {
        return None;
    }
    let (misplaced, unexplained): (Vec<String>, Vec<String>) =
        remaining.iter().cloned().partition(|field| property_keys.contains(field));
    // One field the operation does not take beside one it requires and did not get is that field under another name
    // (set_chart_data's chart for shape); the nearest spelling (chart→chartType) sent the retry the wrong way.
    let corrections = if unexplained.len() == 1 && missing.len() == 1 {
        vec![format!("{}→{}", unexplained[0], missing[0])]
    } else {
        field_corrections(&unexplained, allowed)
    };
    let accepted = allowed.iter().filter(|field| *field != "allowNoChange").cloned().collect::<Vec<_>>().join(", ");
    let key_word = if misplaced.len() == 1 { "is a properties key" } else { "are properties keys" };
    let misplaced_note = if misplaced.is_empty() {
        String::new()
    } else {
        let fields = misplaced.iter().map(|field| format!("{field}: …")).collect::<Vec<_>>().join(", ");
        format!(" {} {key_word}: pass properties:{{ {fields} }}.", misplaced.join(", "))
    };
    let suggestion = if !corrections.is_empty() {
        did_you_mean(&corrections)
    } else if !misplaced.is_empty() {
        String::new()
    } else {
        format!(" {} takes: {accepted}.", site.name)
    };
    Some(format!(
        "{} has unknown field(s): {}.{misplaced_note}{suggestion} {}",
        site.at(),
        remaining.join(", "),
        site.hint()
    ))
}

/// `unknownPropertiesFault`: properties are where an unnoticed miss hurts most, an unknown key is dropped silently, so
/// the caller believes the table was styled and only the rendered page says otherwise.
pub(super) fn unknown_properties_fault(
    site: &Site,
    operation: &mut Map<String, Value>,
    allowed_properties: &[String],
) -> Option<String> {
    if allowed_properties.is_empty() {
        return None;
    }
    let Some(Value::Object(properties)) = operation.get_mut("properties") else { return None };
    // The same font key is spelled two ways inside one format (a run takes name/size, a table cell fontName/fontSize)
    // because each set grew on its own. Either spelling reaches the key the operation declares.
    for (written, canonical) in &capabilities().property_aliases {
        if !properties.contains_key(written) || allowed_properties.contains(written) {
            continue;
        }
        if !allowed_properties.contains(canonical) || properties.contains_key(canonical) {
            continue;
        }
        if let Some(value) = properties.shift_remove(written) {
            properties.insert(canonical.clone(), value);
        }
    }
    let unknown: Vec<String> =
        js_object_keys(properties).into_iter().filter(|field| !allowed_properties.contains(field)).cloned().collect();
    if unknown.is_empty() {
        return None;
    }
    let corrections = field_corrections(&unknown, allowed_properties);
    Some(format!(
        "{} has unknown properties: {}.{} {} properties: {}. {}",
        site.at(),
        unknown.join(", "),
        did_you_mean(&corrections),
        site.name,
        allowed_properties.join(", "),
        site.hint()
    ))
}

/// `docxStyleDefinitionFault`: `define_styles` carries its fields one level down, per style. Both backends read them
/// only after this check, so a misspelt field is refused here on either backend instead of being dropped by one.
pub(super) fn docx_style_definition_fault(site: &Site, operation: &Map<String, Value>) -> Option<String> {
    if site.format != "docx" || site.name != "define_styles" || !operation.contains_key("styles") {
        return None;
    }
    docx_style_definitions(operation)
        .err()
        .map(|message| format!("DOCX operation \"define_styles\" at operation {}: {message}", site.index + 1))
}

/// `docxTableAlignmentFaults`: a Word table has two alignments that read alike. `alignment` places the table on the page
/// and `columnAlignments` sets the text of each column; a list written into the first would be serialized verbatim
/// into the table's justification and refused by Word's schema at finalize. A valid value is rewritten to its lower
/// case.
pub(super) fn docx_table_alignment_faults(site: &Site, operation: &mut Map<String, Value>) -> Vec<String> {
    if site.format != "docx" || !matches!(site.name, "add_table" | "set_table_style") {
        return Vec::new();
    }
    let Some(Value::Object(properties)) = operation.get_mut("properties") else { return Vec::new() };
    let mut faults = Vec::new();
    let placements = ["left", "center", "right"];
    let text_alignments = ["left", "center", "right", "justify"];
    let normal = |value: &Value| js_to_lowercase(js_trim(&value_to_string(value)));
    let prefix = format!("DOCX operation \"{}\" at operation {}", site.name, site.index + 1);
    if let Some(alignment) = properties.get("alignment") {
        let placement = normal(alignment);
        if alignment.is_array() {
            faults.push(format!(
                "{prefix}: properties.alignment places the whole table ({}); the text alignment of each column is properties.columnAlignments: {}.",
                placements.join(", "),
                json_stringify(alignment)
            ));
        } else if !placements.contains(&placement.as_str()) {
            faults.push(format!(
                "{prefix}: properties.alignment places the whole table and must be {}, not {}; per-column text alignment is properties.columnAlignments.",
                placements.join(", "),
                json_stringify(alignment)
            ));
        } else {
            properties.insert("alignment".to_owned(), Value::String(placement));
        }
    }
    if let Some(declared) = properties.get("columnAlignments") {
        let columns = declared.as_array();
        let invalid: Vec<&Value> = columns
            .map(|columns| columns.iter().filter(|entry| !text_alignments.contains(&normal(entry).as_str())).collect())
            .unwrap_or_default();
        if columns.is_none() || !invalid.is_empty() {
            let detail = if columns.is_some() {
                format!(", not {}", invalid.iter().map(|entry| json_stringify(entry)).collect::<Vec<_>>().join(", "))
            } else {
                format!(" (an array), not {}", json_stringify(declared))
            };
            faults.push(format!(
                "{prefix}: properties.columnAlignments is one of {} per column{detail}.",
                text_alignments.join(", ")
            ));
        } else if let Some(columns) = columns {
            let lowered = columns.iter().map(|entry| Value::String(normal(entry))).collect();
            properties.insert("columnAlignments".to_owned(), Value::Array(lowered));
        }
    }
    faults
}

/// `requiredInputFault`: the fields the operation needs and did not get, and the alternative groups none of which was
/// given.
pub(super) fn required_input_fault(
    site: &Site,
    operation: &Map<String, Value>,
    signature: &Signature,
    stable_targets: bool,
) -> Option<String> {
    let supplied = |field: &String| supplied_field(operation, field, stable_targets);
    let missing: Vec<&String> = signature.required.iter().filter(|field| !supplied(*field)).collect();
    let matches_alternative =
        signature.one_of.is_empty() || signature.one_of.iter().any(|alternative| alternative.iter().all(supplied));
    if missing.is_empty() && matches_alternative {
        return None;
    }
    let mut requirements: Vec<String> = Vec::new();
    if !missing.is_empty() {
        requirements.push(format!("missing: {}", missing.iter().map(|field| field.as_str()).collect::<Vec<_>>().join(", ")));
    }
    if !matches_alternative {
        let groups = signature.one_of.iter().map(|entry| entry.join("+")).collect::<Vec<_>>().join(" or ");
        requirements.push(format!("requires one of: {groups}"));
    }
    Some(format!("{} has invalid input ({}). {}", site.at(), requirements.join("; "), site.hint()))
}

/// The `add_validation` rule is resolved once, here, so both backends write the kind named: its type and operator are
/// assigned onto the operation, and a rule that cannot be read is a fault.
pub(super) fn resolve_validation_rule(site: &Site, operation: &mut Map<String, Value>) -> Option<String> {
    match normalize_xlsx_validation(operation) {
        Ok(rule) => {
            operation.insert("type".to_owned(), Value::String(rule.kind.to_owned()));
            if let Some(operator) = rule.operator {
                operation.insert("operator".to_owned(), Value::String(operator.to_owned()));
            }
            None
        }
        Err(message) => Some(format!("XLSX operation \"{}\" at operation {}: {message}. {}", site.name, site.index + 1, site.hint())),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    fn strings(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    fn site<'a>(format: &'a str, name: &'a str) -> Site<'a> {
        Site { format, backend: "mixdog-ooxml", name, index: 0 }
    }

    #[test]
    fn a_style_key_written_one_level_up_moves_into_properties() {
        let mut operation = object(json!({ "op": "set_style", "range": "A1", "bold": true }));
        let allowed = strings(&["op", "allowNoChange", "range", "properties"]);
        let fault = unknown_fields_fault(&site("xlsx", "set_style"), &mut operation, &allowed, &strings(&["bold"]), &[]);
        assert_eq!(fault, None);
        assert_eq!(json_stringify(&Value::Object(operation)), r#"{"op":"set_style","range":"A1","properties":{"bold":true}}"#);
    }

    #[test]
    fn an_unrelated_field_gets_the_list_and_a_near_miss_gets_the_correction() {
        let allowed = strings(&["op", "allowNoChange", "range", "chartType"]);
        let mut unrelated = object(json!({ "op": "add_chart", "range": "A1:B5", "source": "A1:B5" }));
        let fault = unknown_fields_fault(&site("xlsx", "add_chart"), &mut unrelated, &allowed, &[], &[]).expect("fault");
        assert!(fault.starts_with("XLSX operation \"add_chart\" at operation 1 has unknown field(s): source. add_chart takes: op, range, chartType. Call office with"), "{fault}");
        let mut typo = object(json!({ "op": "add_chart", "range": "A1:B5", "chartTipe": "column" }));
        let fault = unknown_fields_fault(&site("xlsx", "add_chart"), &mut typo, &allowed, &[], &[]).expect("fault");
        assert!(fault.contains("Did you mean: chartTipe→chartType?"), "{fault}");
    }

    #[test]
    fn one_unknown_beside_one_missing_is_that_field() {
        let allowed = strings(&["op", "allowNoChange", "slide", "shape", "chartType"]);
        let mut operation = object(json!({ "op": "set_chart_data", "slide": 2, "chart": 1 }));
        let fault = unknown_fields_fault(&site("pptx", "set_chart_data"), &mut operation, &allowed, &[], &strings(&["shape"]))
            .expect("fault");
        assert!(fault.contains("Did you mean: chart→shape?"), "{fault}");
        assert!(!fault.contains("chartType"), "{fault}");
    }

    #[test]
    fn a_misplaced_property_key_is_named_with_the_shape_to_pass() {
        let allowed = strings(&["op", "allowNoChange", "range", "properties"]);
        let mut operation = object(json!({ "op": "set_style", "range": "A1", "bold": true, "properties": { "bold": false } }));
        let fault = unknown_fields_fault(&site("xlsx", "set_style"), &mut operation, &allowed, &strings(&["bold"]), &[]).expect("fault");
        assert!(fault.contains("has unknown field(s): bold. bold is a properties key: pass properties:{ bold: … }. Call office with"), "{fault}");
    }

    #[test]
    fn font_spellings_reach_the_key_the_operation_declares() {
        let mut operation = object(json!({ "op": "append_text", "properties": { "fontNameEastAsia": "Noto Sans KR", "fontSize": 11 } }));
        let allowed = strings(&["nameEastAsia", "size"]);
        assert_eq!(unknown_properties_fault(&site("docx", "append_text"), &mut operation, &allowed), None);
        assert_eq!(json_stringify(&operation["properties"]), r#"{"size":11,"nameEastAsia":"Noto Sans KR"}"#);
    }

    #[test]
    fn unknown_properties_are_listed_with_corrections_and_the_accepted_keys() {
        let mut operation = object(json!({ "op": "add_table", "properties": { "name": "Noto Sans KR", "size": 10, "repeatHeader": true } }));
        let allowed = strings(&["fontName", "fontSize", "repeatHeader"]);
        let fault = unknown_properties_fault(&site("docx", "add_table"), &mut operation, &allowed).expect("fault");
        assert!(fault.starts_with("DOCX operation \"add_table\" at operation 1 has unknown properties: name, size. Did you mean: name→fontName, size→fontSize? add_table properties: fontName, fontSize, repeatHeader. Call office with"), "{fault}");
    }

    #[test]
    fn table_alignment_values_are_checked_and_lowered() {
        let check = |properties: Value| {
            let mut operation = object(json!({ "op": "add_table", "properties": properties }));
            let faults = docx_table_alignment_faults(&site("docx", "add_table"), &mut operation);
            (faults, json_stringify(&operation["properties"]))
        };
        let (faults, properties) = check(json!({ "alignment": "Center", "columnAlignments": ["Left", "RIGHT"] }));
        assert!(faults.is_empty());
        assert_eq!(properties, r#"{"alignment":"center","columnAlignments":["left","right"]}"#);
        let (faults, _) = check(json!({ "alignment": ["left", "right"] }));
        assert!(faults[0].contains(r#"properties.columnAlignments: ["left","right"]."#), "{faults:?}");
        let (faults, _) = check(json!({ "alignment": "middle" }));
        assert!(faults[0].contains(r#"must be left, center, right, not "middle";"#), "{faults:?}");
        let (faults, _) = check(json!({ "columnAlignments": ["left", "top"] }));
        assert!(faults[0].ends_with(r#"is one of left, center, right, justify per column, not "top"."#), "{faults:?}");
        let (faults, _) = check(json!({ "columnAlignments": "right" }));
        assert!(faults[0].ends_with(r#"per column (an array), not "right"."#), "{faults:?}");
    }

    #[test]
    fn required_inputs_name_what_is_missing_and_the_alternatives() {
        let signature = Signature { required: strings(&["slide"]), one_of: vec![strings(&["text"]), strings(&["paragraphs"])], ..Signature::default() };
        let operation = object(json!({ "op": "add_textbox" }));
        let fault = required_input_fault(&site("pptx", "add_textbox"), &operation, &signature, false).expect("fault");
        assert!(fault.contains("has invalid input (missing: slide; requires one of: text or paragraphs)."), "{fault}");
        let stable = object(json!({ "op": "add_textbox", "slideId": 4, "paragraphs": [] }));
        assert_eq!(required_input_fault(&site("pptx", "add_textbox"), &stable, &signature, true), None);
        assert!(required_input_fault(&site("pptx", "add_textbox"), &stable, &signature, false).is_some());
    }

    #[test]
    fn a_validation_rule_is_assigned_onto_the_operation_or_refused() {
        let mut operation = object(json!({ "op": "add_validation", "range": "A1", "type": "WHOLE", "formula1": "0", "formula2": "5" }));
        assert_eq!(resolve_validation_rule(&site("xlsx", "add_validation"), &mut operation), None);
        assert_eq!(operation["type"], "whole");
        assert_eq!(operation["operator"], "between");
        let mut bad = object(json!({ "op": "add_validation", "range": "A1", "type": "unknown", "formula1": "0" }));
        let fault = resolve_validation_rule(&site("xlsx", "add_validation"), &mut bad).expect("fault");
        assert!(fault.starts_with("XLSX operation \"add_validation\" at operation 1: add_validation type must be one of list"), "{fault}");
    }

    #[test]
    fn a_style_definition_fault_names_the_operation() {
        let operation = object(json!({ "op": "define_styles", "styles": { "A": { "colour": "red" } } }));
        let fault = docx_style_definition_fault(&site("docx", "define_styles"), &operation).expect("fault");
        assert!(fault.starts_with("DOCX operation \"define_styles\" at operation 1: define_styles: A: unknown fields colour."), "{fault}");
        assert_eq!(docx_style_definition_fault(&site("docx", "define_styles"), &object(json!({ "op": "define_styles" }))), None);
    }
}
