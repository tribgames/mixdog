//! The repairs QA may apply on its own: one fit operation per audited layout issue, deduplicated by target
//! (`core/office-qa/fix-operations.mjs`).

use mixdog_js::{json_number, json_stringify, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Value, json};

use crate::session::Backend;

/// The fit repairs (`fit_table`, `autofit_range`, `fit_text`) exist on both the Microsoft Office and the portable OOXML backends;
/// tabular and PDF sessions have no such operations.
fn fixable(backend: Backend) -> bool {
    matches!(backend, Backend::MicrosoftOfficeCom | Backend::MixdogOoxml)
}

/// `text` without `prefix` (ASCII letters compared without regard to case, as a regular expression with the `i` flag does).
fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let head = text.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &text[prefix.len()..])
}

/// The number at the start of `text`: its digits and what follows them.
fn leading_digits(text: &str) -> Option<(f64, &str)> {
    let end = text.bytes().take_while(u8::is_ascii_digit).count();
    (end > 0).then(|| (text[..end].parse::<f64>().unwrap_or(f64::NAN), &text[end..]))
}

/// `/^\/body\/(?:tbl|table)\[(\d+)]$/.exec(path)`: the table's number.
fn table_number(path: &str) -> Option<f64> {
    let rest = path.strip_prefix("/body/")?;
    let rest = rest.strip_prefix("tbl[").or_else(|| rest.strip_prefix("table["))?;
    let (number, rest) = leading_digits(rest)?;
    (rest == "]").then_some(number)
}

/// `/^\/sheet\[([^\]]+)]\/cell\[([A-Z]+)(\d+)]$/i.exec(path)`: the sheet and the column (upper case).
fn sheet_column(path: &str) -> Option<(String, String)> {
    let rest = strip_prefix_ci(path, "/sheet[")?;
    let close = rest.find(']').filter(|close| *close > 0)?;
    let (sheet, rest) = (&rest[..close], &rest[close + 1..]);
    let rest = strip_prefix_ci(rest, "/cell[")?;
    let letters = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
    if letters == 0 {
        return None;
    }
    let (_, tail) = leading_digits(&rest[letters..])?;
    (tail == "]").then(|| (sheet.to_owned(), rest[..letters].to_ascii_uppercase()))
}

/// `/^\/slide\[(\d+)]\/shape\[(\d+)]$/.exec(path)`: the slide and the shape.
fn slide_shape(path: &str) -> Option<(f64, f64)> {
    let rest = path.strip_prefix("/slide[")?;
    let (slide, rest) = leading_digits(rest)?;
    let rest = rest.strip_prefix("]/shape[")?;
    let (shape, rest) = leading_digits(rest)?;
    (rest == "]").then_some((slide, shape))
}

fn fix_operation_for(format: &str, issue: &Value) -> Option<Value> {
    let code = issue.get("code").and_then(Value::as_str).unwrap_or_default();
    let path = issue.get("path").filter(|path| truthy(path)).map(value_to_string).unwrap_or_default();
    if format == "docx" && ["table_width", "table_wider_than_page"].contains(&code) {
        // The audit names the table as /body/table[N] and asks for fit_table; the repair looked for a code and a path shape the
        // audit never emits, so a table running off the page was reported and then left alone.
        let table = table_number(&path).filter(|table| *table != 0.0 && !table.is_nan())?;
        return Some(json!({ "op": "fit_table", "table": json_number(table) }));
    }
    if format == "xlsx" && ["cell_overflow", "column_too_narrow", "label_truncated"].contains(&code) {
        // What the audit itself prescribes for a value shown as ### or a label cut at its column edge: widen that column. Keyed to
        // the column, so one sheet with fifty cut cells is repaired once.
        let (sheet, column) = sheet_column(&path)?;
        return Some(json!({ "op": "autofit_range", "sheet": sheet, "range": format!("{column}:{column}") }));
    }
    // fit_text draws the box back inside the slide and fits its text there, for either backend's name of the fault.
    if format == "pptx" && ["text_overflow", "text_outside_slide", "shape_out_of_bounds"].contains(&code) {
        let (slide, shape) = slide_shape(&path)?;
        return Some(json!({ "op": "fit_text", "slide": json_number(slide), "shape": json_number(shape), "minFontSize": 8 }));
    }
    None
}

/// `qaFixOperations(session, issueList)`.
pub fn qa_fix_operations(format: &str, backend: Backend, issues: &[Value]) -> Vec<Value> {
    if !fixable(backend) {
        return Vec::new();
    }
    let mut operations: Vec<Value> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for issue in issues {
        let Some(found) = fix_operation_for(format, issue) else { continue };
        // A repair that finds nothing to change is not a failed review: without it one no-op fit_text failed the batch and qa
        // returned an error in place of its findings.
        let mut operation = found;
        if let Some(fields) = operation.as_object_mut() {
            fields.insert("allowNoChange".to_owned(), Value::Bool(true));
        }
        let key = json_stringify(&operation);
        if !seen.contains(&key) {
            seen.push(key);
            operations.push(operation);
        }
    }
    operations
}

#[cfg(test)]
mod tests {
    use super::*;

    fn issue(code: &str, path: &str) -> Value {
        json!({ "code": code, "path": path })
    }

    #[test]
    fn a_table_running_off_the_page_is_fitted_by_its_number() {
        let found = qa_fix_operations("docx", Backend::MixdogOoxml, &[issue("table_width", "/body/table[2]"), issue("table_wider_than_page", "/body/tbl[2]"), issue("table_width", "/body/table[0]")]);
        assert_eq!(json_stringify(&Value::Array(found)), r#"[{"op":"fit_table","table":2,"allowNoChange":true}]"#);
    }

    #[test]
    fn one_column_is_widened_once_however_many_cells_are_cut() {
        let found = qa_fix_operations(
            "xlsx",
            Backend::MicrosoftOfficeCom,
            &[issue("cell_overflow", "/sheet[Data]/cell[b2]"), issue("label_truncated", "/sheet[Data]/cell[B40]"), issue("column_too_narrow", "/sheet[Data]/cell[C1]")],
        );
        assert_eq!(
            json_stringify(&Value::Array(found)),
            r#"[{"op":"autofit_range","sheet":"Data","range":"B:B","allowNoChange":true},{"op":"autofit_range","sheet":"Data","range":"C:C","allowNoChange":true}]"#
        );
    }

    #[test]
    fn a_box_outside_the_slide_is_fitted_and_a_backend_without_the_repair_has_none() {
        let found = qa_fix_operations("pptx", Backend::MixdogOoxml, &[issue("shape_out_of_bounds", "/slide[3]/shape[4]"), issue("text_overflow", "/slide[3]")]);
        assert_eq!(json_stringify(&Value::Array(found)), r#"[{"op":"fit_text","slide":3,"shape":4,"minFontSize":8,"allowNoChange":true}]"#);
        assert!(qa_fix_operations("pptx", Backend::MixdogPdf, &[issue("text_overflow", "/slide[3]/shape[4]")]).is_empty());
        assert!(qa_fix_operations("xlsx", Backend::MixdogTabular, &[issue("cell_overflow", "/sheet[A]/cell[A1]")]).is_empty());
    }
}
