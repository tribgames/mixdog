//! `portable/xlsx-assertions.mjs`: the assertions a workbook is held to (`cell-value`, `cell-formula`, `tie-out`, `no-errors`,
//! `formula-consistency`) read against a snapshot document `{ sheets: [{ name, cells, rowBlocks }] }`. Each failed assertion
//! is an issue `{ severity: 'error', code, path, assertion, message }`; a formula without a calculated result is never
//! compared, because an empty pair used to tie out.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, json_stringify, string_to_number, to_number_of};
use mixdog_office_base::a1::column_number;
use serde_json::{Map, Value, json};

use crate::xlsx_audit_support::{js_text, list, text_or_empty, text_or_empty_nullish, truthy};
use crate::xlsx_formula_audit::relative_formula_signature;

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static ERROR_VALUE: LazyLock<JsRegex> = regex!(r"^(?:#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A|#NUM!|#NULL!)$", "i");
static REFERENCE: LazyLock<JsRegex> = regex!(r"^(?:(?:'([^']+)'|([^!]+))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)$", "");
static CELL: LazyLock<JsRegex> = regex!(r"^([A-Z]{1,3})([1-9]\d*)$", "i");
static RANGE: LazyLock<JsRegex> = regex!(r"^(\$?[A-Z]{1,3}\$?[1-9]\d*):(\$?[A-Z]{1,3}\$?[1-9]\d*)$", "i");

const UNCALCULATED_ROUTE: &str = "the workbook is recalculated by finalize (or by opening it in Office), and the assertion belongs after that";

/// How many findings one assertion reports before the rest are only counted.
const REPORTED_PER_ASSERTION: usize = 100;

/// `cellsFromDocument(document)`: every cell of every sheet (`cells`, then the rows of each `rowBlocks` block), each carrying
/// the name of its sheet.
fn cells_from_document(document: &Value) -> Vec<Value> {
    let mut cells = Vec::new();
    let with_sheet = |cell: &Value, sheet: &Value| -> Value {
        let mut spread: Map<String, Value> = cell.as_object().cloned().unwrap_or_default();
        match sheet.get("name") {
            Some(name) => {
                spread.insert("sheet".to_owned(), name.clone());
            }
            None => {
                spread.remove("sheet");
            }
        }
        Value::Object(spread)
    };
    for sheet in list(document.get("sheets")) {
        for cell in list(sheet.get("cells")) {
            cells.push(with_sheet(cell, sheet));
        }
        for block in list(sheet.get("rowBlocks")) {
            for row in list(block.get("rows")) {
                for cell in list(row.get("cells")) {
                    cells.push(with_sheet(cell, sheet));
                }
            }
        }
    }
    cells
}

/// A cell the assertions read, or a literal number standing in for one.
type Found<'a> = Cow<'a, Value>;

/// What a reference names: a literal number, or a cell of a sheet.
enum Reference {
    Literal(Value),
    Cell { sheet: String, cell: String },
}

/// `reference(value, fallbackSheet)`.
fn reference(value: Option<&Value>, fallback_sheet: &str) -> Option<Reference> {
    if let Some(number @ Value::Number(_)) = value {
        return Some(Reference::Literal(number.clone()));
    }
    if let Some(object) = value.filter(|value| value.is_object() || value.is_array())
        && truthy(object.get("cell"))
    {
        let sheet = if truthy(object.get("sheet")) { js_text(object.get("sheet")) } else { fallback_sheet.to_owned() };
        return Some(Reference::Cell { sheet, cell: js_text(object.get("cell")).to_uppercase() });
    }
    let text = text_or_empty(value);
    let found = REFERENCE.captures(js_trim(&text))?;
    let sheet = match (found.get(1), found.get(2)) {
        (Some(quoted), _) if !quoted.is_empty() => quoted.to_owned(),
        (_, Some(plain)) if !plain.is_empty() => plain.to_owned(),
        _ => fallback_sheet.to_owned(),
    };
    Some(Reference::Cell { sheet, cell: found.get(3).unwrap_or("").replace('$', "").to_uppercase() })
}

/// `numeric(value)`: a finite number, or a string that reads as one. `Number('')` is 0, which made an empty cell equal to a
/// zero expectation: a model that had not been calculated yet answered "correct".
fn numeric(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        Some(Value::String(text)) if !js_trim(text).is_empty() => Some(string_to_number(text)).filter(|number| number.is_finite()),
        _ => None,
    }
}

/// `uncalculated(cell)`: a formula whose result has not been computed yet: nothing to compare against.
fn uncalculated(cell: Option<&Value>) -> bool {
    let Some(cell) = cell else { return false };
    truthy(cell.get("formula"))
        && match cell.get("value") {
            None | Some(Value::Null) => true,
            Some(Value::String(text)) => text.is_empty(),
            Some(_) => false,
        }
}

/// `formulaText(cell)`.
fn formula_text(cell: Option<&Value>) -> String {
    let formula = text_or_empty(cell.and_then(|cell| cell.get("formula")));
    if formula.starts_with('=') { formula } else { format!("={formula}") }
}

/// `sameValue(actual, expected, tolerance)`.
fn same_value(actual: Option<&Value>, expected: Option<&Value>, tolerance: Option<&Value>) -> bool {
    if let (Some(left), Some(right)) = (numeric(actual), numeric(expected)) {
        let allowed = to_number_of(tolerance);
        let allowed = if allowed.is_nan() || allowed == 0.0 { 0.0 } else { allowed };
        return (left - right).abs() <= mixdog_js::math::max(0.0, allowed);
    }
    text_or_empty_nullish(actual) == text_or_empty_nullish(expected)
}

/// A cell's column and row.
struct Spot {
    column: f64,
    row: f64,
}

/// `parsedCell(value)`.
fn parsed_cell(value: Option<&Value>) -> Option<Spot> {
    let text = text_or_empty(value).replace('$', "");
    let found = CELL.captures(&text)?;
    Some(Spot { column: column_number(found.get(1).unwrap_or("")), row: string_to_number(found.get(2).unwrap_or("")) })
}

/// A rectangle of cells.
struct Span {
    start_row: f64,
    end_row: f64,
    start_column: f64,
    end_column: f64,
}

/// `parsedRange(value)`.
fn parsed_range(value: Option<&Value>) -> Option<Span> {
    let text = text_or_empty(value);
    let found = RANGE.captures(js_trim(&text))?;
    let start = parsed_cell(Some(&json!(found.get(1).unwrap_or(""))))?;
    let end = parsed_cell(Some(&json!(found.get(2).unwrap_or(""))))?;
    Some(Span {
        start_row: start.row.min(end.row),
        end_row: start.row.max(end.row),
        start_column: start.column.min(end.column),
        end_column: start.column.max(end.column),
    })
}

/// `cellsForAssertion(document, assertion)`: the cells of the asserted sheet and range.
fn cells_for_assertion<'a>(cells: &'a [Value], assertion: &Value) -> Vec<&'a Value> {
    let range = parsed_range(assertion.get("range"));
    let sheet = truthy(assertion.get("sheet")).then(|| js_to_lowercase(&js_text(assertion.get("sheet"))));
    cells
        .iter()
        .filter(|cell| {
            if let Some(sheet) = &sheet
                && js_to_lowercase(&js_text(cell.get("sheet"))) != *sheet
            {
                return false;
            }
            let Some(range) = &range else { return true };
            parsed_cell(cell.get("ref")).is_some_and(|parsed| {
                parsed.row >= range.start_row && parsed.row <= range.end_row && parsed.column >= range.start_column && parsed.column <= range.end_column
            })
        })
        .collect()
}

/// `issue(index, code, message, path)`: a path that is absent reads `/`.
fn issue(index: usize, code: &str, message: String, path: Option<&Value>) -> Value {
    json!({
        "severity": "error",
        "code": code,
        "path": path.cloned().unwrap_or_else(|| json!("/")),
        "assertion": index + 1,
        "message": message,
    })
}

/// `JSON.stringify(value)`: `undefined` where the value is absent.
fn stringified(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), json_stringify)
}

/// The path a cell reports itself by when it has one (`cell?.path || fallback`).
fn path_of<'a>(cell: Option<&'a Value>) -> Option<&'a Value> {
    cell.and_then(|cell| cell.get("path")).filter(|path| truthy(Some(*path)))
}

/// The cells of the document, found by sheet and reference.
struct Book {
    cells: Vec<Value>,
    index: HashMap<String, usize>,
}

impl Book {
    fn new(document: &Value) -> Self {
        let cells = cells_from_document(document);
        // A later cell of the same reference replaces an earlier one, as a Map built from the list does.
        let index = cells
            .iter()
            .enumerate()
            .map(|(at, cell)| (format!("{}!{}", js_to_lowercase(&js_text(cell.get("sheet"))), js_text(cell.get("ref")).to_uppercase()), at))
            .collect();
        Self { cells, index }
    }

    fn cell(&self, sheet: &str, cell: &str) -> Option<&Value> {
        self.index.get(&format!("{}!{cell}", js_to_lowercase(sheet))).map(|at| &self.cells[*at])
    }

    /// `get(value, fallbackSheet)`: a literal number stands in for a cell holding it.
    fn find(&self, value: Option<&Value>, fallback_sheet: &str) -> Option<Found<'_>> {
        match reference(value, fallback_sheet)? {
            Reference::Literal(number) => Some(Cow::Owned(json!({ "value": number, "path": "" }))),
            Reference::Cell { sheet, cell } => self.cell(&sheet, &cell).map(Cow::Borrowed),
        }
    }
}

/// What one check reads.
#[derive(Clone, Copy)]
struct Check<'a> {
    book: &'a Book,
    assertion: &'a Value,
    index: usize,
    sheet: &'a str,
    target: Option<&'a Value>,
}

/// `cell?.value ?? null`.
fn value_or_null(cell: Option<&Value>) -> Value {
    cell.and_then(|cell| cell.get("value")).cloned().unwrap_or(Value::Null)
}

/// `checkCellValue`: a formula written without Excel carries no cached result until the workbook is recalculated. Compared
/// anyway it reads as a wrong model, and against a zero expectation it used to read as a right one.
fn check_cell_value(check: Check<'_>, issues: &mut Vec<Value>) -> bool {
    let Check { assertion, index, sheet, target, .. } = check;
    let cell_name = js_text(assertion.get("cell"));
    let fallback_path = json!(format!("/sheet[{sheet}]/cell[{cell_name}]"));
    if uncalculated(target) {
        issues.push(issue(
            index,
            "assertion_value_uncalculated",
            format!(
                "{sheet}!{cell_name} holds {} with no calculated result, so it cannot be compared with {}: {UNCALCULATED_ROUTE}.",
                json_stringify(&json!(formula_text(target))),
                stringified(assertion.get("equals"))
            ),
            Some(path_of(target).unwrap_or(&fallback_path)),
        ));
        return false;
    }
    let passed = target.is_some_and(|target| same_value(target.get("value"), assertion.get("equals"), assertion.get("tolerance")));
    if !passed {
        issues.push(issue(
            index,
            "assertion_value_mismatch",
            format!(
                "Expected {sheet}!{cell_name} to equal {}; actual value is {}.",
                stringified(assertion.get("equals")),
                json_stringify(&value_or_null(target))
            ),
            Some(path_of(target).unwrap_or(&fallback_path)),
        ));
    }
    passed
}

/// `checkCellFormula`.
fn check_cell_formula(check: Check<'_>, issues: &mut Vec<Value>) -> Result<bool, String> {
    let Check { assertion, index, sheet, target, .. } = check;
    let actual = text_or_empty(target.and_then(|target| target.get("formula")));
    let passed = match target {
        None => false,
        Some(_) if assertion.get("equals").is_some() => {
            let expected = text_or_empty_nullish(assertion.get("equals"));
            actual.strip_prefix('=').unwrap_or(&actual) == expected.strip_prefix('=').unwrap_or(&expected)
        }
        Some(_) => JsRegex::new(&text_or_empty(assertion.get("matches")), "")?.is_match(&actual),
    };
    if !passed {
        let fallback_path = json!(format!("/sheet[{sheet}]/cell[{}]", js_text(assertion.get("cell"))));
        issues.push(issue(
            index,
            "assertion_formula_mismatch",
            format!("Formula assertion failed for {sheet}!{}; actual formula is {}.", js_text(assertion.get("cell")), json_stringify(&json!(actual))),
            Some(path_of(target).unwrap_or(&fallback_path)),
        ));
    }
    Ok(passed)
}

/// `checkTieOut`.
fn check_tie_out(check: Check<'_>, issues: &mut Vec<Value>) -> bool {
    let Check { book, assertion, index, sheet, .. } = check;
    let (left_name, right_name) = (assertion.get("left"), assertion.get("right"));
    let left = book.find(left_name, sheet);
    let right = book.find(right_name, sheet);
    let (left, right) = (left.as_deref(), right.as_deref());
    // Two sides that have not been calculated are both empty, and an empty pair used to tie out: the strictest check in the
    // model answered "agreed" without a single number behind it.
    let pending: Vec<(Option<&Value>, &Value)> = [(left_name, left), (right_name, right)]
        .into_iter()
        .filter_map(|(name, cell)| cell.filter(|cell| uncalculated(Some(*cell))).map(|cell| (name, cell)))
        .collect();
    if !pending.is_empty() {
        let holds: Vec<String> = pending
            .iter()
            .map(|(name, cell)| format!("{} holds {} with no calculated result", stringified(*name), json_stringify(&json!(formula_text(Some(*cell))))))
            .collect();
        issues.push(issue(
            index,
            "assertion_value_uncalculated",
            format!("Tie-out cannot be read yet: {}; {UNCALCULATED_ROUTE}.", holds.join(" and ")),
            path_of(Some(pending[0].1)).or_else(|| path_of(left)).or_else(|| path_of(right)),
        ));
        return false;
    }
    let passed = match (left, right) {
        (Some(left), Some(right)) => same_value(left.get("value"), right.get("value"), assertion.get("tolerance")),
        _ => false,
    };
    if !passed {
        issues.push(issue(
            index,
            "assertion_tie_out_failed",
            format!(
                "Tie-out failed: {}={} and {}={}.",
                stringified(left_name),
                json_stringify(&value_or_null(left)),
                stringified(right_name),
                json_stringify(&value_or_null(right))
            ),
            path_of(left).or_else(|| path_of(right)),
        ));
    }
    passed
}

/// `checkNoErrors`.
fn check_no_errors(check: Check<'_>, issues: &mut Vec<Value>) -> bool {
    let failures: Vec<&Value> =
        cells_for_assertion(&check.book.cells, check.assertion).into_iter().filter(|cell| ERROR_VALUE.is_match(&text_or_empty(cell.get("value")))).collect();
    for cell in failures.iter().take(REPORTED_PER_ASSERTION) {
        issues.push(issue(
            check.index,
            "assertion_formula_error",
            format!("Formula error {} violates no-errors assertion.", js_text(cell.get("value"))),
            cell.get("path"),
        ));
    }
    failures.is_empty()
}

/// `checkFormulaConsistency`.
fn check_formula_consistency(check: Check<'_>, issues: &mut Vec<Value>) -> bool {
    let formulas: Vec<&Value> = cells_for_assertion(&check.book.cells, check.assertion).into_iter().filter(|cell| truthy(cell.get("formula"))).collect();
    let signatures: Vec<String> =
        formulas.iter().map(|cell| relative_formula_signature(&text_or_empty(cell.get("formula")), &text_or_empty(cell.get("ref")))).collect();
    let mut order: Vec<&str> = Vec::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for pattern in &signatures {
        let count = counts.entry(pattern.as_str()).or_insert(0);
        if *count == 0 {
            order.push(pattern.as_str());
        }
        *count += 1;
    }
    // The most common pattern, the first one seen among equals (a stable sort by count).
    let mut expected = "";
    let mut expected_count = 0;
    for pattern in order {
        if counts[pattern] > expected_count {
            expected = pattern;
            expected_count = counts[pattern];
        }
    }
    let inconsistent: Vec<&Value> = formulas.iter().zip(&signatures).filter(|(_, pattern)| pattern.as_str() != expected).map(|(cell, _)| *cell).collect();
    if formulas.is_empty() {
        let named = if truthy(check.assertion.get("sheet")) { js_text(check.assertion.get("sheet")) } else { check.sheet.to_owned() };
        issues.push(issue(
            check.index,
            "assertion_formula_missing",
            "Formula-consistency assertion found no formulas.".to_owned(),
            Some(&json!(format!("/sheet[{named}]"))),
        ));
    }
    for cell in inconsistent.iter().take(REPORTED_PER_ASSERTION) {
        issues.push(issue(
            check.index,
            "assertion_formula_inconsistent",
            "Formula differs from the dominant pattern in the asserted region.".to_owned(),
            cell.get("path"),
        ));
    }
    !formulas.is_empty() && inconsistent.is_empty()
}

/// `evaluateXlsxAssertions(document, assertions)`: every assertion read against the workbook. Fails only where an
/// assertion's `matches` is not a regular expression (the SyntaxError Node throws).
pub fn evaluate_xlsx_assertions(document: &Value, assertions: &[Value]) -> Result<Value, String> {
    let book = Book::new(document);
    let first_sheet = text_or_empty(list(document.get("sheets")).first().and_then(|sheet| sheet.get("name")));
    let mut issues: Vec<Value> = Vec::new();
    let mut results: Vec<Value> = Vec::new();
    for (index, assertion) in assertions.iter().enumerate() {
        let kind = js_to_lowercase(&text_or_empty(assertion.get("kind")));
        let sheet = if truthy(assertion.get("sheet")) { js_text(assertion.get("sheet")) } else { first_sheet.clone() };
        let target = if truthy(assertion.get("cell")) { book.cell(&sheet, &js_text(assertion.get("cell")).to_uppercase()) } else { None };
        let check = Check { book: &book, assertion, index, sheet: &sheet, target };
        let passed = match kind.as_str() {
            "cell-value" => check_cell_value(check, &mut issues),
            "cell-formula" => check_cell_formula(check, &mut issues)?,
            "tie-out" => check_tie_out(check, &mut issues),
            "no-errors" => check_no_errors(check, &mut issues),
            "formula-consistency" => check_formula_consistency(check, &mut issues),
            _ => {
                let named = if kind.is_empty() { "(missing)" } else { kind.as_str() };
                issues.push(issue(index, "assertion_kind_unknown", format!("Unknown XLSX assertion kind: {named}"), None));
                false
            }
        };
        results.push(json!({ "index": index + 1, "kind": kind, "passed": passed }));
    }
    let passed = results.iter().filter(|entry| entry.get("passed") == Some(&Value::Bool(true))).count();
    Ok(json!({
        "ok": issues.is_empty(),
        "checked": assertions.len(),
        "passed": passed,
        "results": results,
        "issues": issues,
    }))
}
