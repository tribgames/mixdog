//! `normalizeXlsxValidation` of `portable/xlsx-contract.mjs`: the data-validation rule an `add_validation` operation
//! names, resolved once and checked before either backend can read an unknown word as a different rule. The contract
//! engine of the office crate and the xlsx writers both call it, so there is one implementation.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, value_to_string};
use serde_json::{Map, Value};

/// `XLSX_VALIDATION_TYPES`.
pub const XLSX_VALIDATION_TYPES: [&str; 7] = ["list", "whole", "decimal", "date", "time", "textLength", "custom"];

/// `XLSX_VALIDATION_OPERATORS`.
pub const XLSX_VALIDATION_OPERATORS: [&str; 8] = [
    "between",
    "notBetween",
    "equal",
    "notEqual",
    "greaterThan",
    "lessThan",
    "greaterThanOrEqual",
    "lessThanOrEqual",
];

/// `VALIDATION_CHOICE_RANGE`: a range of cells holding the choices, optionally sheet-qualified.
static CHOICE_RANGE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"^(?:'[^']+'!|[A-Za-z_][\w.]*!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$", "")
});
/// `/^"[^"]*"$/`: a literal list in quotes.
static QUOTED_LIST: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"^"[^"]*"$"#, ""));
/// `/[=<>+*/()"]/`: what an expression holds and a bare list of choices never does.
static EXPRESSION_CHARACTER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"[=<>+*/()"]"#, ""));

/// The rule `normalizeXlsxValidation` returns: its type and, for a bounded type, its operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ValidationRule {
    pub kind: &'static str,
    pub operator: Option<&'static str>,
}

/// `String(operation[key] ?? '')`.
fn field_text(operation: &Map<String, Value>, key: &str) -> String {
    match operation.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// A dropdown names its choices (`"서울,부산"`) or points at the cells holding them; anything that compares, calls or
/// tests is a rule the sheet evaluates. Bare comma-separated items are what a caller writes when the quotes are
/// forgotten; an expression never looks like that.
fn list_validation_formula(formula1: &str) -> bool {
    let trimmed = js_trim(formula1);
    let text = trimmed.strip_prefix('=').unwrap_or(trimmed);
    if text.is_empty() {
        return false;
    }
    if QUOTED_LIST.is_match(text) || CHOICE_RANGE.is_match(text) {
        return true;
    }
    text.contains(',') && !EXPRESSION_CHARACTER.is_match(text)
}

fn find_named(names: &[&'static str], requested: &str) -> Option<&'static str> {
    let wanted = js_to_lowercase(requested);
    names.iter().copied().find(|name| js_to_lowercase(name) == wanted)
}

/// `normalizeXlsxValidation(operation)`: the type (a formula that names choices is a dropdown, one that states a test
/// is a custom rule) and the operator (`between` when a bounded type names none), or the message Node throws.
pub fn normalize_xlsx_validation(operation: &Map<String, Value>) -> Result<ValidationRule, String> {
    let formula1 = field_text(operation, "formula1");
    if js_trim(&formula1).is_empty() {
        return Err("add_validation requires non-empty formula1".to_owned());
    }
    let declared = js_trim(&field_text(operation, "type")).to_owned();
    let requested_type = if !declared.is_empty() {
        declared
    } else if list_validation_formula(&formula1) {
        "list".to_owned()
    } else {
        "custom".to_owned()
    };
    let Some(kind) = find_named(&XLSX_VALIDATION_TYPES, &requested_type) else {
        return Err(format!("add_validation type must be one of {}", XLSX_VALIDATION_TYPES.join(", ")));
    };
    let requested_operator = js_trim(&field_text(operation, "operator")).to_owned();
    let bounded = !matches!(kind, "list" | "custom");
    let operator = if !requested_operator.is_empty() {
        find_named(&XLSX_VALIDATION_OPERATORS, &requested_operator)
    } else if bounded {
        Some("between")
    } else {
        None
    };
    if !requested_operator.is_empty() && operator.is_none() {
        return Err(format!("add_validation operator must be one of {}", XLSX_VALIDATION_OPERATORS.join(", ")));
    }
    if !bounded && !requested_operator.is_empty() {
        return Err(format!("add_validation operator is unsupported for type \"{kind}\"; omit operator"));
    }
    if let Some(name @ ("between" | "notBetween")) = operator
        && js_trim(&field_text(operation, "formula2")).is_empty()
    {
        return Err(format!(
            "add_validation operator \"{name}\" requires formula2; for one bound use a comparison operator"
        ));
    }
    Ok(ValidationRule { kind, operator })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(value: &Value) -> Result<ValidationRule, String> {
        normalize_xlsx_validation(value.as_object().expect("object"))
    }

    #[test]
    fn the_type_defaults_by_what_the_formula_reads_as() {
        assert_eq!(rule(&json!({ "formula1": "\"서울,부산\"" })), Ok(ValidationRule { kind: "list", operator: None }));
        assert_eq!(rule(&json!({ "formula1": "서울,부산" })).map(|r| r.kind), Ok("list"));
        assert_eq!(rule(&json!({ "formula1": "=Sheet1!$A$1:$A$5" })).map(|r| r.kind), Ok("list"));
        assert_eq!(rule(&json!({ "formula1": "A4>0" })).map(|r| r.kind), Ok("custom"));
        assert_eq!(rule(&json!({ "formula1": "a,b>1" })).map(|r| r.kind), Ok("custom"));
    }

    #[test]
    fn names_resolve_whatever_their_case() {
        let resolved = rule(&json!({ "type": "WHOLE", "operator": "GREATERTHANOREQUAL", "formula1": "0" }));
        assert_eq!(resolved, Ok(ValidationRule { kind: "whole", operator: Some("greaterThanOrEqual") }));
        assert_eq!(rule(&json!({ "type": "textlength", "formula1": 0, "formula2": 5 })).map(|r| r.kind), Ok("textLength"));
    }

    #[test]
    fn a_bounded_type_defaults_to_between_and_needs_the_second_formula() {
        let error = rule(&json!({ "type": "whole", "formula1": "0" })).expect_err("formula2");
        assert_eq!(error, "add_validation operator \"between\" requires formula2; for one bound use a comparison operator");
        assert_eq!(
            rule(&json!({ "type": "whole", "formula1": "0", "formula2": "50" })),
            Ok(ValidationRule { kind: "whole", operator: Some("between") })
        );
        assert!(rule(&json!({ "type": "whole", "operator": "notBetween", "formula1": "0" })).is_err());
    }

    #[test]
    fn faults_carry_node_texts() {
        assert_eq!(rule(&json!({ "formula1": "  " })), Err("add_validation requires non-empty formula1".to_owned()));
        assert_eq!(
            rule(&json!({ "type": "unknown", "formula1": "0" })),
            Err("add_validation type must be one of list, whole, decimal, date, time, textLength, custom".to_owned())
        );
        let operator = rule(&json!({ "type": "whole", "operator": "greaterOrEqual", "formula1": "0" })).expect_err("operator");
        assert!(operator.starts_with("add_validation operator must be one of between, notBetween"));
        assert_eq!(
            rule(&json!({ "type": "custom", "operator": "equal", "formula1": "A1>0" })),
            Err("add_validation operator is unsupported for type \"custom\"; omit operator".to_owned())
        );
    }
}
