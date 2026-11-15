//! `describeOfficeCapabilities` of `capabilities.mjs`: what the `describe` action answers. With no format, a summary of
//! the formats and the design catalogue; with a format, the operations a backend runs, the ones it does not, and the
//! property groups; with an operation too, that one operation's compact input contract.

use mixdog_js::js_trim;
use mixdog_office_design::tokens::office_design_catalog;
use serde_json::{Map, Value, json};

use crate::capabilities::capabilities;
use crate::contracts::{did_you_mean, operation_properties, operation_suggestions};

/// The arguments of `describeOfficeCapabilities`; an empty string is the argument left out.
#[derive(Debug, Clone, Copy, Default)]
pub struct DescribeRequest<'a> {
    pub format: &'a str,
    pub backend: &'a str,
    pub target: &'a str,
    pub operation: &'a str,
}

fn strings<S: AsRef<str>>(values: &[S]) -> Value {
    Value::Array(values.iter().map(|value| Value::from(value.as_ref())).collect())
}

/// `COMMON`: the notes every format's description starts with, as a fresh object to spread the rest into.
fn common() -> Map<String, Value> {
    match &capabilities().common {
        Value::Object(common) => common.clone(),
        _ => Map::new(),
    }
}

/// `operationDescription(format, backend, catalog, requested)`: one operation's compact contract; an alias answers with
/// the entry it resolves to.
fn operation_description(format: &str, backend: &str, requested: &str) -> Result<Value, String> {
    let tables = capabilities();
    let known = tables.operations(format);
    let operation = tables.resolve_operation_alias(format, requested);
    if !known.contains(&operation) {
        let suggestions = operation_suggestions(operation, known.iter().copied());
        return Err(format!(
            "Unknown {} operation \"{operation}\".{} Call describe with format:\"{format}\" to list operations.",
            format.to_uppercase(),
            did_you_mean(&suggestions)
        ));
    }
    let backend_filter = (!backend.is_empty()).then_some(backend);
    let available = tables.operations_for_backend(format, backend_filter);
    let signature = tables.operation_signature(format, operation);
    let properties = operation_properties(format, &signature, backend);
    let mut description = Map::new();
    description.insert("name".to_owned(), Value::from(operation));
    if tables.is_virtual(format, operation) {
        description.insert("virtual".to_owned(), Value::Bool(true));
    }
    description.insert("supported".to_owned(), Value::Bool(backend.is_empty() || available.contains(&operation)));
    description.insert("supportedBackends".to_owned(), strings(&tables.supported_backends(format, operation)));
    let mut required = vec!["op".to_owned()];
    required.extend(signature.required.iter().cloned());
    let mut optional: Vec<String> = Vec::new();
    for field in signature.optional.iter().map(String::as_str).chain(["allowNoChange"]) {
        if !optional.iter().any(|entry| entry == field) && !signature.required.iter().any(|entry| entry == field) {
            optional.push(field.to_owned());
        }
    }
    let mut input = Map::new();
    input.insert("required".to_owned(), strings(&required));
    if !signature.one_of.is_empty() {
        input.insert("oneOf".to_owned(), Value::Array(signature.one_of.iter().map(|group| strings(group)).collect()));
    }
    input.insert("optional".to_owned(), strings(&optional));
    description.insert("input".to_owned(), Value::Object(input));
    if !properties.is_empty() {
        let mut sets = Map::new();
        for (name, fields) in &properties {
            sets.insert(name.clone(), strings(fields));
        }
        description.insert("properties".to_owned(), Value::Object(sets));
    }
    if !signature.notes.is_empty() {
        description.insert("notes".to_owned(), Value::from(signature.notes.as_str()));
    }
    Ok(Value::Object(description))
}

/// `describeOfficeCapabilities({ format, backend, target, operation })`, or the message Node throws.
pub fn describe_office_capabilities(request: &DescribeRequest) -> Result<Value, String> {
    let tables = capabilities();
    let DescribeRequest { format, backend, target, operation } = *request;
    if !backend.is_empty() && !tables.backends.iter().any(|name| name == backend) {
        return Err(format!("Unsupported Office backend: {backend}"));
    }
    if format.is_empty() {
        if !operation.is_empty() {
            return Err("describe with operation requires format, path, or session".to_owned());
        }
        let mut formats = Map::new();
        for (name, catalog) in &tables.catalog {
            formats.insert(
                name.clone(),
                json!({ "paths": strings(&catalog.paths), "operationCount": tables.operations(name).len() }),
            );
        }
        let mut summary = common();
        summary.insert("designs".to_owned(), office_design_catalog("", None)?);
        summary.insert("formats".to_owned(), Value::Object(formats));
        summary.insert(
            "nextAction".to_owned(),
            Value::from(
                "When discovery is needed, add format for its operation list or add operation for one compact input contract; otherwise call create/open/batch directly.",
            ),
        );
        return Ok(Value::Object(summary));
    }
    let Some(catalog) = tables.format(format) else {
        return Err(format!("Unsupported Office Use format: {format}"));
    };
    let requested = js_trim(operation);
    // One operation's contract is what a caller asks for when a field is unknown; the action list, batch notes and
    // design catalogue it already has ride the format-level describe instead of every lookup.
    if !requested.is_empty() {
        return Ok(json!({
            "format": format,
            "backend": backend,
            "paths": strings(&catalog.paths),
            "operation": operation_description(format, backend, requested)?,
        }));
    }
    let backend_filter = (!backend.is_empty()).then_some(backend);
    let operations = tables.operations_for_backend(format, backend_filter);
    let unsupported: Vec<&str> = if backend.is_empty() {
        Vec::new()
    } else {
        tables.operations(format).into_iter().filter(|name| !operations.contains(name)).collect()
    };
    let mut properties = Map::new();
    for (name, fields) in &catalog.properties {
        properties.insert(name.clone(), strings(fields));
    }
    let mut description = common();
    description.insert("format".to_owned(), Value::from(format));
    description.insert("backend".to_owned(), Value::from(backend));
    description.insert("target".to_owned(), Value::from(if target.is_empty() { "/" } else { target }));
    description.insert("paths".to_owned(), strings(&catalog.paths));
    description.insert("operations".to_owned(), strings(&operations));
    description.insert("unsupportedInBackend".to_owned(), strings(&unsupported));
    description.insert("properties".to_owned(), Value::Object(properties));
    description.insert("designs".to_owned(), office_design_catalog(format, None)?);
    description.insert(
        "nextAction".to_owned(),
        Value::from(
            "If exact fields are unknown, add operation for its compact contract; otherwise call create/open/batch directly.",
        ),
    );
    Ok(Value::Object(description))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn describe(format: &str, backend: &str, operation: &str) -> Result<Value, String> {
        describe_office_capabilities(&DescribeRequest { format, backend, target: "", operation })
    }

    fn texts(value: &Value) -> Vec<&str> {
        value.as_array().expect("array").iter().map(|entry| entry.as_str().expect("string")).collect()
    }

    #[test]
    fn the_summary_counts_operations_without_listing_them() {
        let summary = describe("", "", "").expect("summary");
        assert!(summary["formats"]["xlsx"].get("operations").is_none());
        assert!(summary["formats"]["xlsx"]["operationCount"].as_u64().expect("count") > 0);
        assert!(summary["nextAction"].as_str().expect("text").starts_with("When discovery is needed"));
        assert!(summary["designs"].is_array());
    }

    #[test]
    fn a_format_lists_its_operations_actions_and_properties() {
        let xlsx = describe("xlsx", "", "").expect("xlsx");
        assert!(xlsx["nextAction"].as_str().expect("text").starts_with("If exact fields are unknown"));
        for action in ["create", "attach", "secure"] {
            assert!(texts(&xlsx["actions"]).contains(&action), "{action}");
        }
        for operation in ["add_chart", "add_pivot_table", "insert_rows", "define_name", "add_provenance", "set_sheet_visibility"] {
            assert!(texts(&xlsx["operations"]).contains(&operation), "{operation}");
        }
        assert_eq!(
            texts(&xlsx["properties"]["cellStyle"]),
            [
                "fontName", "fontSize", "bold", "italic", "color", "fillColor", "numberFormat", "horizontalAlignment",
                "verticalAlignment", "wrapText", "indent", "locked", "borders"
            ]
        );
        assert_eq!(xlsx["target"], "/");
        let csv = describe("csv", "", "").expect("csv");
        assert!(texts(&csv["operations"]).contains(&"set_range"));
        assert!(!texts(&csv["operations"]).contains(&"set_style"));
    }

    #[test]
    fn every_ooxml_operation_runs_without_microsoft_office() {
        for format in ["docx", "xlsx", "pptx"] {
            let portable = describe(format, "mixdog-ooxml", "").expect("portable");
            assert!(portable["unsupportedInBackend"].as_array().expect("list").is_empty(), "{format}");
        }
    }

    #[test]
    fn one_operation_answers_with_its_compact_contract() {
        let chart = describe("xlsx", "microsoft-office-com", "add_chart").expect("chart");
        assert_eq!(texts(&chart["operation"]["input"]["required"]), ["op", "range"]);
        assert!(texts(&chart["operation"]["input"]["optional"]).contains(&"chartType"));
        assert_eq!(chart["operation"]["supported"], true);
        assert_eq!(texts(&chart["operation"]["supportedBackends"]), ["microsoft-office-com", "mixdog-ooxml"]);
        assert_eq!(chart["operation"]["properties"]["chart"][0], "chartType");
        let animation = describe("pptx", "mixdog-ooxml", "add_animation").expect("animation");
        assert_eq!(animation["operation"]["supported"], true);
    }

    #[test]
    fn an_alias_describes_the_operation_it_resolves_to() {
        let described = describe("docx", "mixdog-ooxml", "add_paragraph").expect("alias");
        assert_eq!(described["operation"]["name"], "append_text");
    }

    #[test]
    fn an_unknown_operation_is_answered_with_a_suggestion() {
        let message = describe("xlsx", "", "add_chrt").expect_err("unknown");
        assert!(message.starts_with("Unknown XLSX operation \"add_chrt\". Did you mean: add_chart?"), "{message}");
        assert!(message.ends_with("Call describe with format:\"xlsx\" to list operations."), "{message}");
    }

    #[test]
    fn validation_notes_name_the_operators() {
        for backend in ["microsoft-office-com", "mixdog-ooxml"] {
            let notes = describe("xlsx", backend, "add_validation").expect("validation")["operation"]["notes"]
                .as_str()
                .expect("notes")
                .to_owned();
            for operator in mixdog_office_base::xlsx_validation::XLSX_VALIDATION_OPERATORS {
                assert!(notes.contains(operator), "{operator}");
            }
            assert!(notes.contains("between/notBetween require formula2"));
        }
    }

    #[test]
    fn word_properties_follow_the_backend() {
        for backend in ["microsoft-office-com", "mixdog-ooxml"] {
            let font = describe("docx", backend, "set_document_font").expect("font");
            let fields: Vec<&str> =
                font["operation"]["properties"].as_object().expect("sets").values().flat_map(texts).collect();
            assert_eq!(fields, ["name", "nameEastAsia", "size", "color"], "{backend}");
            let table = describe("docx", backend, "set_table_style").expect("table");
            let fields: Vec<&str> =
                table["operation"]["properties"].as_object().expect("sets").values().flat_map(texts).collect();
            assert!(fields.contains(&"columnAlignments"));
            assert_eq!(fields.contains(&"columnWidths"), backend == "microsoft-office-com", "{backend}");
            assert!(!fields.contains(&"fontSize"));
            assert!(table["operation"]["notes"].as_str().expect("notes").contains("set_table_cell_style"));
        }
    }

    #[test]
    fn requests_that_cannot_be_answered_say_why() {
        assert_eq!(describe("", "", "add_chart"), Err("describe with operation requires format, path, or session".to_owned()));
        assert_eq!(describe("xlsx", "excel", ""), Err("Unsupported Office backend: excel".to_owned()));
        assert_eq!(describe("odt", "", ""), Err("Unsupported Office Use format: odt".to_owned()));
    }

    #[test]
    fn a_virtual_operation_says_so() {
        let compose = describe("xlsx", "", "compose_sheet").expect("compose");
        assert_eq!(compose["operation"]["virtual"], true);
    }
}
