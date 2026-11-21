//! The operation contract engine: `assertOfficeOperationContracts` of `capabilities.mjs`. A batch of operations is
//! checked against the capability tables before any backend sees it. Operation names and field names a caller drifted
//! on are rewritten in place (the operation objects are mutated, and later stages read the rewritten form), and every
//! fault of the batch is reported together, with a "did you mean" only where the name reads as a typo.

mod aliases;
mod checks;
mod suggest;

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, json_stringify};
use mixdog_office_base::values::plain_object;
use serde_json::{Map, Value};

use self::aliases::{
    allowed_operation_fields, apply_field_aliases, author_initials, hoist_compose_sheet_table, hoist_freeze_pane_cell, hoist_geometry_properties,
    single_cell_range_fault, text_or_empty,
};
use self::checks::{
    Site, docx_style_definition_fault, docx_table_alignment_faults, required_input_fault, resolve_validation_rule, supplied_field, unknown_fields_fault,
    unknown_properties_fault,
};
pub(crate) use self::suggest::{did_you_mean, operation_suggestions};
use crate::capabilities::{Signature, capabilities};

/// `DESCRIBE_HINT`: the describe call each fault ends with. A batch that gets one operation wrong in six places needs
/// that call once, not six times.
static DESCRIBE_HINT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\s*Call office with \{"action":"describe"[^}]*\}\."#, "g"));

/// `describeHint(format, backend, operation)`.
fn describe_hint(format: &str, backend: &str, operation: &str) -> String {
    let mut call = Map::new();
    call.insert("action".to_owned(), Value::from("describe"));
    call.insert("format".to_owned(), Value::from(format));
    if !backend.is_empty() {
        call.insert("backend".to_owned(), Value::from(backend));
    }
    call.insert("operation".to_owned(), Value::from(operation));
    format!("Call office with {}.", json_stringify(&Value::Object(call)))
}

/// `operationProperties(catalog, signature, backend)`: for each property set the operation reads, the keys it takes on
/// the backend (all of them when no backend is named), in the order of the property sets.
pub(crate) fn operation_properties(format: &str, signature: &Signature, backend: &str) -> Vec<(String, Vec<String>)> {
    let Some(catalog) = capabilities().format(format) else { return Vec::new() };
    signature
        .property_sets
        .iter()
        .filter_map(|name| catalog.properties.get(name).map(|fields| (name, fields)))
        .map(|(name, fields)| {
            let kept = fields
                .iter()
                .filter(|field| backend.is_empty() || signature.property_backends.get(*field).is_none_or(|backends| backends.iter().any(|b| b == backend)))
                .cloned()
                .collect();
            (name.clone(), kept)
        })
        .collect()
}

/// `propertyKeySet`: the property keys an operation takes on the backend, each cut at its first dot (`borders.color` is
/// the key `borders`), without repeats.
fn property_key_set(format: &str, signature: &Signature, backend: &str) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for (_, fields) in operation_properties(format, signature, backend) {
        for field in fields {
            let key = field.split('.').next().unwrap_or_default().to_owned();
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys
}

/// What a batch is checked against: its format and backend, the operations the backend runs and every operation the
/// format knows.
struct Batch<'a> {
    format: &'a str,
    backend: &'a str,
    available: Vec<&'static str>,
    known: Vec<&'static str>,
}

/// The operation name the batch will run under (an alias is rewritten onto the operation), or the fault that stops it:
/// an unknown or unsupported name is answered with the list that does hold it.
fn resolve_contract_operation(batch: &Batch, operation: &mut Map<String, Value>, index: usize) -> Result<String, String> {
    let (format, backend) = (batch.format, batch.backend);
    let written = js_trim(&text_or_empty(operation.get("op"))).to_owned();
    if written.is_empty() {
        return Err(format!("Office operation {} requires op", index + 1));
    }
    let tables = capabilities();
    let name = tables.resolve_operation_alias(format, &written).to_owned();
    if name != written {
        operation.insert("op".to_owned(), Value::String(name.clone()));
    }
    if !batch.known.contains(&name.as_str()) {
        let suggestions = operation_suggestions(&name, batch.known.iter().copied());
        // Describing a name the catalogue does not hold only repeats this error: the caller is sent to the list that
        // does answer the question.
        let mut call = Map::new();
        call.insert("action".to_owned(), Value::from("describe"));
        call.insert("format".to_owned(), Value::from(format));
        if !backend.is_empty() {
            call.insert("backend".to_owned(), Value::from(backend));
        }
        return Err(format!(
            "Unknown {} operation \"{name}\" at operation {}.{} Call office with {} to list operations.",
            format.to_uppercase(),
            index + 1,
            did_you_mean(&suggestions),
            json_stringify(&Value::Object(call))
        ));
    }
    if !batch.available.contains(&name.as_str()) {
        let alternatives = tables.supported_backends(format, &name);
        let supported = if alternatives.is_empty() { String::new() } else { format!(" Supported backend(s): {}.", alternatives.join(", ")) };
        let backend_name = if backend.is_empty() { "this backend" } else { backend };
        return Err(format!(
            "{} operation \"{name}\" is unsupported by {backend_name}.{supported} {}",
            format.to_uppercase(),
            describe_hint(format, backend, &name)
        ));
    }
    Ok(name)
}

/// `operationContractFaults`: the contract faults one operation carries, after the rewrites the contract performs on the
/// caller's behalf (aliases, hoisted fields, single-cell ranges). A name the batch cannot run stops the checks for that
/// operation.
fn operation_contract_faults(batch: &Batch, operation: &mut Value, index: usize) -> Vec<String> {
    if !plain_object(operation) {
        return vec![format!("Office operation {} must be an object", index + 1)];
    }
    let Some(operation) = operation.as_object_mut() else { return Vec::new() };
    let name = match resolve_contract_operation(batch, operation, index) {
        Ok(name) => name,
        Err(fault) => return vec![fault],
    };
    let (format, backend) = (batch.format, batch.backend);
    apply_field_aliases(format, &name, operation);
    hoist_freeze_pane_cell(format, &name, operation);
    author_initials(&name, operation);
    let signature = capabilities().operation_signature(format, &name);
    let stable_targets = format == "pptx" && backend == "mixdog-ooxml";
    let allowed = allowed_operation_fields(&signature, stable_targets);
    if let Some(fault) = single_cell_range_fault(format, backend, &name, operation, index, &allowed) {
        return vec![fault];
    }
    hoist_compose_sheet_table(format, &name, operation);
    hoist_geometry_properties(&signature, operation, &allowed);
    let property_keys = property_key_set(format, &signature, backend);
    let missing: Vec<String> = signature.required.iter().filter(|field| !supplied_field(operation, field, stable_targets)).cloned().collect();
    let site = Site { format, backend, name: &name, index };
    let mut faults: Vec<String> = Vec::new();
    faults.extend(unknown_fields_fault(&site, operation, &allowed, &property_keys, &missing));
    faults.extend(unknown_properties_fault(&site, operation, &property_keys));
    faults.extend(docx_table_alignment_faults(&site, operation));
    faults.extend(docx_style_definition_fault(&site, operation));
    faults.extend(required_input_fault(&site, operation, &signature, stable_targets));
    if faults.is_empty() && format == "xlsx" && name == "add_validation" {
        faults.extend(resolve_validation_rule(&site, operation));
    }
    faults
}

/// `assertOfficeOperationContracts({ format, backend, operations })`: checks every operation of the batch and rewrites
/// the ones the contract accepts under another spelling (`operations` is mutated in place; later stages rely on it).
/// Every contract violation in the batch is reported together: the batch is refused as a whole either way, and a
/// caller who learns one wrong field per answer pays a round trip for each of them.
pub fn assert_office_operation_contracts(format: &str, backend: &str, operations: &mut [Value]) -> Result<(), String> {
    let tables = capabilities();
    if tables.format(format).is_none() {
        return Err(format!("Unsupported Office Use format: {format}"));
    }
    let backend_filter = (!backend.is_empty()).then_some(backend);
    let batch = Batch { format, backend, available: tables.operations_for_backend(format, backend_filter), known: tables.operations(format) };
    let mut faults: Vec<String> = Vec::new();
    for (index, operation) in operations.iter_mut().enumerate() {
        faults.extend(operation_contract_faults(&batch, operation, index));
    }
    if faults.len() == 1 {
        return Err(faults.remove(0));
    }
    if !faults.is_empty() {
        // Each fault names the describe call for its operation; a batch that gets one operation wrong in six places
        // needs that call once, not six times.
        let mut hints: Vec<String> = Vec::new();
        for fault in &faults {
            for range in DESCRIBE_HINT.find_iter(fault) {
                let hint = js_trim(&fault[range]).to_owned();
                if !hints.contains(&hint) {
                    hints.push(hint);
                }
            }
        }
        let bare: Vec<String> = faults.iter().map(|fault| DESCRIBE_HINT.replace_all_with(fault, |_| String::new())).collect();
        let tail = if hints.is_empty() { String::new() } else { format!(" {}", hints.join(" ")) };
        return Err(format!("This batch breaks {} input contracts; fix them together. {}{tail}", faults.len(), bare.join(" ")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use mixdog_js::json_stringify;
    use serde_json::json;

    use super::*;

    fn check(format: &str, backend: &str, operations: Value) -> (Result<(), String>, Vec<Value>) {
        let mut operations = operations.as_array().cloned().expect("array");
        let outcome = assert_office_operation_contracts(format, backend, &mut operations);
        (outcome, operations)
    }

    fn rejected(format: &str, backend: &str, operation: Value) -> String {
        check(format, backend, json!([operation])).0.expect_err("the batch is refused")
    }

    #[test]
    fn an_unsupported_format_is_refused_by_name() {
        assert_eq!(check("odt", "", json!([])).0, Err("Unsupported Office Use format: odt".to_owned()));
        assert_eq!(check("", "", json!([])).0, Err("Unsupported Office Use format: ".to_owned()));
    }

    #[test]
    fn a_near_miss_is_corrected_and_an_unrelated_field_gets_the_list() {
        assert!(rejected("xlsx", "mixdog-ooxml", json!({ "op": "add_chart", "range": "A1:B5", "chartTipe": "column" })).contains("chartTipe→chartType"));
        let unrelated = rejected("xlsx", "mixdog-ooxml", json!({ "op": "add_chart", "range": "A1:B5", "source": "A1:B5" }));
        assert!(!unrelated.contains("Did you mean"));
        assert!(unrelated.contains("add_chart takes: "), "{unrelated}");
        assert!(unrelated.contains("chartType"));
    }

    #[test]
    fn a_comment_carries_its_authors_initials() {
        let (outcome, comments) = check(
            "docx",
            "mixdog-ooxml",
            json!([
                { "op": "add_comment", "find": "인력", "text": "다시 봅시다.", "author": "검토자" },
                { "op": "add_comment", "find": "인력", "text": "Later.", "author": "Jane van Doe" },
                { "op": "add_comment", "find": "인력", "text": "Kept.", "author": "검토자", "initials": "QA" },
                { "op": "add_comment", "find": "인력", "text": "No author." }
            ]),
        );
        assert_eq!(outcome, Ok(()));
        let initials: Vec<Option<&str>> = comments.iter().map(|entry| entry["initials"].as_str()).collect();
        assert_eq!(initials, [Some("검"), Some("JVD"), Some("QA"), None]);
    }

    #[test]
    fn the_verb_of_a_missed_operation_name_resolves_by_subject() {
        let message = rejected("docx", "mixdog-ooxml", json!({ "op": "add_toc" }));
        assert!(message.starts_with("Unknown DOCX operation \"add_toc\" at operation 1. Did you mean: insert_toc?"), "{message}");
        assert!(message.ends_with(r#"Call office with {"action":"describe","format":"docx","backend":"mixdog-ooxml"} to list operations."#), "{message}");
    }

    #[test]
    fn a_text_box_needs_text_or_paragraphs() {
        let paragraphs = json!([{ "op": "add_textbox", "slide": 1, "paragraphs": [{ "text": "요점", "bullet": true }] }]);
        assert_eq!(check("pptx", "mixdog-ooxml", paragraphs).0, Ok(()));
        assert!(rejected("pptx", "mixdog-ooxml", json!({ "op": "add_textbox", "slide": 1 })).contains("requires one of: text or paragraphs"));
    }

    #[test]
    fn word_aliases_reach_the_operation_they_name() {
        let (outcome, aliased) = check(
            "docx",
            "mixdog-ooxml",
            json!([{ "op": "add_paragraph", "text": "허브 운영 요약" }, { "op": "add_link", "find": "허브 운영 요약", "address": "https://example.com/ops" }]),
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(aliased[0]["op"], "append_text");
        assert_eq!(aliased[1]["op"], "add_hyperlink");
    }

    #[test]
    fn a_worksheet_hyperlink_alias_reaches_set_hyperlink() {
        let (_, worksheet) = check("xlsx", "mixdog-ooxml", json!([{ "op": "add_hyperlink", "range": "A1", "url": "https://example.com/ops" }]));
        assert_eq!(worksheet[0]["op"], "set_hyperlink");
    }

    #[test]
    fn a_pdf_hyperlink_alias_reaches_add_link() {
        let (outcome, stamped) = check("pdf", "mixdog-pdf", json!([{ "op": "set_hyperlink", "page": 1, "find": "허브", "url": "https://example.com/ops" }]));
        assert_eq!(outcome, Ok(()));
        assert_eq!(stamped[0]["op"], "add_link");
    }

    #[test]
    fn a_style_key_written_beside_the_operation_moves_into_its_properties() {
        let (outcome, table) = check("docx", "mixdog-ooxml", json!([{ "op": "add_table", "values": [["a"]], "fontName": "Noto Sans KR" }]));
        assert_eq!(outcome, Ok(()));
        assert_eq!(table[0]["properties"], json!({ "fontName": "Noto Sans KR" }));
        assert!(table[0].get("fontName").is_none());
        let message = rejected(
            "docx",
            "mixdog-ooxml",
            json!({ "op": "add_table", "values": [["a"]], "fontName": "Noto Sans KR", "properties": { "fontName": "Malgun Gothic" } }),
        );
        assert!(message.contains("unknown field(s): fontName."), "{message}");
        assert!(message.contains("fontName is a properties key"), "{message}");
    }

    #[test]
    fn worksheet_spellings_are_rewritten() {
        let (outcome, sheet) = check(
            "xlsx",
            "mixdog-ooxml",
            json!([
                { "op": "set_formula", "cell": "B5", "value": "=SUM(B2:B4)" },
                { "op": "freeze_panes", "cell": "B2" },
                { "op": "freeze_panes", "row": 2, "column": "C" },
                { "op": "set_formula", "range": "B5", "formula": "=B2/B3" },
                { "op": "set_cell", "range": "'운영 자료'!D5", "value": 620 }
            ]),
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(json_stringify(&sheet[0]), r#"{"op":"set_formula","cell":"B5","formula":"=SUM(B2:B4)"}"#);
        assert_eq!(json_stringify(&sheet[1]), r#"{"op":"freeze_panes","column":2,"row":2}"#);
        assert_eq!(json_stringify(&sheet[2]), r#"{"op":"freeze_panes","row":2,"column":3}"#);
        assert_eq!(sheet[3]["cell"], "B5");
        assert!(sheet[3].get("range").is_none());
        assert_eq!(sheet[4]["cell"], "'운영 자료'!D5");
        assert!(rejected("xlsx", "mixdog-ooxml", json!({ "op": "set_cell", "range": "B2:E2", "value": 4 })).contains("writes one cell"));
    }

    #[test]
    fn a_table_in_compose_sheet_is_taken_at_its_word() {
        let (outcome, composed) = check(
            "xlsx",
            "mixdog-ooxml",
            json!([{ "op": "compose_sheet", "title": "야간 운영 지표", "table": { "headers": ["허브", "정시 출고율"], "rows": [["서울", 0.941]] } }]),
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(composed[0]["headers"], json!(["허브", "정시 출고율"]));
        assert_eq!(composed[0]["rows"], json!([["서울", 0.941]]));
        assert!(composed[0].get("table").is_none());
    }

    #[test]
    fn two_names_for_one_gesture_reach_the_same_field() {
        let (outcome, spaced) =
            check("pptx", "mixdog-ooxml", json!([{ "op": "distribute_shapes", "slide": 1, "shapes": [2, 3, 4], "distribute": "horizontal" }]));
        assert_eq!(outcome, Ok(()));
        assert_eq!(spaced[0]["direction"], "horizontal");
        assert!(spaced[0].get("distribute").is_none());
        let (outcome, cells) = check(
            "docx",
            "mixdog-ooxml",
            json!([{ "op": "set_table_cell", "table": 1, "row": 3, "column": 2, "text": "58" }, { "op": "merge_table_cells", "table": 1, "row": 1, "column": 1, "colSpan": 2 }]),
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(json_stringify(&cells[0]), r#"{"op":"set_table_cell","table":1,"row":3,"text":"58","col":2}"#);
        assert_eq!(cells[1]["col"], 1);
    }

    #[test]
    fn word_table_properties_are_checked_and_normalised() {
        let message = rejected(
            "docx",
            "mixdog-ooxml",
            json!({ "op": "add_table", "values": [["a"]], "properties": { "name": "Noto Sans KR", "size": 10, "repeatHeader": true } }),
        );
        assert!(message.contains("unknown properties: name, size."), "{message}");
        assert!(message.contains("name→fontName, size→fontSize"), "{message}");
        let (outcome, run) = check(
            "docx",
            "mixdog-ooxml",
            json!([{ "op": "append_text", "text": "정시 출고율", "properties": { "fontNameEastAsia": "Noto Sans KR", "fontSize": 11 } }]),
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(run[0]["properties"], json!({ "nameEastAsia": "Noto Sans KR", "size": 11 }));
        let (outcome, aligned) = check(
            "docx",
            "mixdog-ooxml",
            json!([{ "op": "set_table_style", "table": 1, "properties": { "alignment": "Center", "columnAlignments": ["Left", "RIGHT"] } }]),
        );
        assert_eq!(outcome, Ok(()));
        assert_eq!(aligned[0]["properties"], json!({ "alignment": "center", "columnAlignments": ["left", "right"] }));
    }

    #[test]
    fn properties_are_checked_against_the_backend() {
        for backend in ["microsoft-office-com", "mixdog-ooxml"] {
            let font =
                json!([{ "op": "set_document_font", "properties": { "name": "Malgun Gothic", "nameEastAsia": "맑은 고딕", "size": 11, "color": "112233" } }]);
            assert_eq!(check("docx", backend, font).0, Ok(()), "{backend}");
            for field in ["bold", "italic", "underline", "hidden"] {
                let mut properties = Map::new();
                properties.insert(field.to_owned(), Value::Bool(true));
                let message = rejected("docx", backend, json!({ "op": "set_document_font", "properties": properties }));
                assert!(message.contains("unknown properties"), "{backend} {field}: {message}");
            }
        }
        let widths = json!([{ "op": "set_table_style", "table": 1, "properties": { "columnWidths": [100, 200] } }]);
        assert_eq!(check("docx", "microsoft-office-com", widths.clone()).0, Ok(()));
        let message = rejected("docx", "mixdog-ooxml", widths[0].clone());
        assert!(message.contains("unknown properties: columnWidths"), "{message}");
    }

    #[test]
    fn validation_rules_are_resolved_before_dispatch() {
        for backend in ["microsoft-office-com", "mixdog-ooxml"] {
            for (fields, error) in [
                (json!({ "type": "whole", "operator": "greaterOrEqual" }), "operator must be one of"),
                (json!({ "type": "unknown" }), "type must be one of"),
                (json!({ "type": "whole", "operator": "between" }), "requires formula2"),
                (json!({ "type": "whole" }), "requires formula2"),
                (json!({ "type": "custom", "operator": "equal" }), "operator is unsupported for type \"custom\""),
            ] {
                let mut operation = json!({ "op": "add_validation", "range": "A1", "formula1": "0" });
                operation.as_object_mut().expect("object").extend(fields.as_object().expect("object").clone());
                let message = rejected("xlsx", backend, operation);
                assert!(message.contains(error), "{backend}: {message}");
            }
            let (outcome, rules) = check(
                "xlsx",
                backend,
                json!([
                    { "op": "add_validation", "range": "A1", "type": "WHOLE", "operator": "GREATERTHANOREQUAL", "formula1": "0" },
                    { "op": "add_validation", "range": "A3", "formula1": "\"서울,부산\"" },
                    { "op": "add_validation", "range": "A4", "formula1": "A4>0" }
                ]),
            );
            assert_eq!(outcome, Ok(()));
            assert_eq!((rules[0]["type"].as_str(), rules[0]["operator"].as_str()), (Some("whole"), Some("greaterThanOrEqual")));
            assert_eq!(rules[1]["type"], "list");
            assert_eq!(rules[2]["type"], "custom");
        }
    }

    #[test]
    fn a_frozen_row_alone_freezes_nothing_but_the_contract_leaves_that_to_the_writer() {
        let (outcome, frozen) = check("xlsx", "mixdog-ooxml", json!([{ "op": "freeze_panes", "row": 1 }]));
        assert_eq!(outcome, Ok(()));
        assert_eq!(frozen[0], json!({ "op": "freeze_panes", "row": 1 }));
    }

    #[test]
    fn every_fault_of_a_batch_is_reported_together_with_one_describe_hint_each() {
        let mut operations = vec![
            json!({ "op": "add_chart", "range": "A1:B5", "source": "x" }),
            json!({ "op": "add_chart", "range": "A1:B5", "source": "y" }),
            json!({ "op": "no_such_op" }),
            json!(7),
            json!({}),
        ];
        let message = assert_office_operation_contracts("xlsx", "mixdog-ooxml", &mut operations).expect_err("refused");
        assert!(message.starts_with("This batch breaks 5 input contracts; fix them together. "), "{message}");
        assert!(message.contains("Office operation 4 must be an object"), "{message}");
        assert!(message.contains("Office operation 5 requires op"), "{message}");
        assert_eq!(
            message.matches("Call office with {\"action\":\"describe\",\"format\":\"xlsx\",\"backend\":\"mixdog-ooxml\",\"operation\":\"add_chart\"}.").count(),
            1,
            "{message}"
        );
        // The unknown name's own call lists operations and carries no operation: it is part of the sentence, not a hint.
        assert!(message.contains("to list operations."), "{message}");
    }

    #[test]
    fn an_operation_a_backend_does_not_run_names_the_backends_that_do() {
        let message = rejected("pdf", "microsoft-office-com", json!({ "op": "add_text" }));
        assert_eq!(
            message,
            r#"PDF operation "add_text" is unsupported by microsoft-office-com. Supported backend(s): mixdog-pdf. Call office with {"action":"describe","format":"pdf","backend":"microsoft-office-com","operation":"add_text"}."#
        );
    }
}
