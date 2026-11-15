//! `Issues-Excel`: what the review reads off a workbook, and `Inspect-ExcelFinancialRange`, the audit of a financial model
//! (hardcodes, sources, rows that mix formulas and inputs, the Checks sheet), by `auditProfile` as the script reads it.

use std::collections::HashSet;

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::issues::ISSUE_CAP;
use crate::issues::add_capped_office_issue;
use crate::issues::missing_font_issue;
use crate::issues::office_issue;
use crate::office::Env;
use crate::platform::FontSet;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text;

use super::cells::attempt;
use super::cells::blocks_fitting;
use super::cells::column_letters;
use super::cells::count_of;
use super::cells::dimension_count;
use super::cells::get_with;
use super::cells::int_of;
use super::cells::is_ps_null;
use super::cells::items_of;
use super::cells::matrix_value;
use super::cells::min_int;
use super::cells::ordered;
use super::cells::payload_flag;
use super::cells::payload_text;
use super::cells::ps_of;
use super::cells::range_cell_address;
use super::cells::relative_address;
use super::cells::string_of;

/// The cells a financial audit reads in one chunk, and the bounds of the other probes.
const CHUNK_CELLS: i32 = 20_000;
const MAX_ROWS_PER_BLOCK: i32 = 2000;
const VISUAL_PROBES: i32 = 32;
const SAMPLE_CELLS: i32 = 500;
const SAMPLE_COLUMNS: i32 = 100;
const INCONSISTENCY_CAP: i32 = 100;
const FORMULA_ERROR_CAP: i32 = 1000;

/// The first formula, the last, and what a row's hardcodes are, per row of a chunk.
struct RowState {
    formula_count: i32,
    first_formula: i32,
    last_formula: i32,
    values: Vec<Hardcode>,
}

struct Hardcode {
    address: String,
    path: String,
    column: i32,
    numeric: bool,
}

/// `$value -is [ValueType] -and $value -isnot [bool]`.
fn is_numeric(value: &Com) -> bool {
    matches!(
        value,
        Com::I1(_)
            | Com::I2(_)
            | Com::I4(_)
            | Com::I8(_)
            | Com::UI1(_)
            | Com::UI2(_)
            | Com::UI4(_)
            | Com::UI8(_)
            | Com::R4(_)
            | Com::R8(_)
            | Com::Currency(_)
            | Com::Date(_)
            | Com::Decimal(_)
            | Com::Error(_)
    )
}

/// `[string]$cell.Text -match '^#{3,}$'`: a number wider than its column shows as hashes.
fn is_clipped(text_shown: &str) -> bool {
    text::is_match(text_shown, "^#{3,}$", false).unwrap_or(false)
}

/// `Is-ChecksSheetName`: the tie-out sheet is named in the reader's language, and matching the English convention alone
/// left a Korean workbook's checks unread (the profile's central test never ran and the model passed as if it had none).
/// The names are built from their code points.
pub(super) fn is_checks_sheet_name(name: &Com) -> bool {
    let label = string_of(name);
    let label = label.trim();
    let korean = |codes: &[u32]| super::numfmt::excel_word(codes);
    let accepted = ["checks".to_owned(), "check".to_owned(), korean(&[0xAC80, 0xC99D]), korean(&[0xC810, 0xAC80])];
    accepted.iter().any(|candidate| payload::names_equal(label, candidate))
}

/// `Inspect-ExcelFinancialRange`: the issues of one sheet's range, capped at 500 with a note of how many were left out, and
/// what was scanned.
fn inspect_financial_range(sheet: &Com, used: &Com, fonts: &FontSet, comment_addresses: &HashSet<String>) -> Result<(Vec<Value>, Value)> {
    let mut issues: Vec<Value> = Vec::new();
    let mut omitted = 0;
    let row_count = dimension_count(used, "Rows")?;
    let column_count = dimension_count(used, "Columns")?;
    let total_cells = i64::from(row_count) * i64::from(column_count);
    let rows_per_block = min_int(MAX_ROWS_PER_BLOCK, blocks_fitting(CHUNK_CELLS, min_int(column_count, CHUNK_CELLS)?)?)?;
    let mut scanned_cells: i64 = 0;
    let mut chunks = 0;
    let mut visual_probes = 0;
    let checks_sheet = payload::names_equal(&string_of(&sheet.member("Name")?), "Checks");

    let mut row_start = 1;
    while row_start <= row_count {
        let rows_this_block = min_int(rows_per_block, row_count - row_start + 1)?;
        let mut states: Vec<RowState> = (0..rows_this_block)
            .map(|_| RowState { formula_count: 0, first_formula: i32::MAX, last_formula: 0, values: Vec::new() })
            .collect();
        let columns_per_block = blocks_fitting(CHUNK_CELLS, rows_this_block)?;
        let mut column_start = 1;
        while column_start <= column_count {
            let columns_this_block = min_int(columns_per_block, column_count - column_start + 1)?;
            let origin = get_with(&used.member("Cells")?, "Item", &[Com::I4(row_start), Com::I4(column_start)])?;
            let chunk = get_with(&origin, "Resize", &[Com::I4(rows_this_block), Com::I4(columns_this_block)])?;
            let values = chunk.member("Value2")?;
            let formulas = chunk.member("FormulaR1C1")?;
            chunks += 1;
            scanned_cells += i64::from(rows_this_block) * i64::from(columns_this_block);
            for local_row in 1..=rows_this_block {
                let state = &mut states[(local_row - 1) as usize];
                for local_column in 1..=columns_this_block {
                    let value = matrix_value(&values, local_row, local_column);
                    let formula = matrix_value(&formulas, local_row, local_column);
                    let has_formula = string_of(&formula).starts_with('=');
                    let absolute_row = int_of(&used.member("Row")?)? + row_start + local_row - 2;
                    let absolute_column = int_of(&used.member("Column")?)? + column_start + local_column - 2;
                    let address = format!("{}{absolute_row}", column_letters(absolute_column));
                    let path = format!("/sheet[{}]/cell[{address}]", string_of(&sheet.member("Name")?));
                    if has_formula {
                        state.formula_count += 1;
                        state.first_formula = state.first_formula.min(absolute_column);
                        state.last_formula = state.last_formula.max(absolute_column);
                    } else if !is_ps_null(&value) && !string_of(&value).trim().is_empty() {
                        state.values.push(Hardcode { address, path: path.clone(), column: absolute_column, numeric: is_numeric(&value) });
                    }
                    if checks_sheet && matches!(value, Com::Bool(false)) {
                        add_capped_office_issue(
                            &mut issues,
                            &mut omitted,
                            office_issue("error", "failed_check", &path, "A formula or explicit check on the Checks sheet evaluates to FALSE."),
                            ISSUE_CAP,
                        );
                    }
                    if (!is_ps_null(&value) || has_formula) && visual_probes < VISUAL_PROBES {
                        visual_probes += 1;
                        let cell = get_with(&chunk.member("Cells")?, "Item", &[Com::I4(local_row), Com::I4(local_column)])?;
                        if is_clipped(&string_of(&cell.member("Text")?)) {
                            add_capped_office_issue(
                                &mut issues,
                                &mut omitted,
                                office_issue("warning", "cell_overflow", &path, "Displayed value is clipped because the column is too narrow."),
                                ISSUE_CAP,
                            );
                        }
                        let font_issue = missing_font_issue(fonts, &string_of(&cell.member("Font")?.member("Name")?), &path);
                        if let Some(font_issue) = font_issue {
                            add_capped_office_issue(&mut issues, &mut omitted, font_issue, ISSUE_CAP);
                        }
                    }
                }
            }
            column_start += columns_per_block;
        }
        for state in &states {
            for entry in &state.values {
                if entry.numeric {
                    if !comment_addresses.contains(&entry.address.to_uppercase()) {
                        add_capped_office_issue(
                            &mut issues,
                            &mut omitted,
                            office_issue("warning", "hardcode_missing_source", &entry.path, "Hardcoded numeric input has no source comment."),
                            ISSUE_CAP,
                        );
                    }
                    if state.formula_count > 0 {
                        add_capped_office_issue(
                            &mut issues,
                            &mut omitted,
                            office_issue(
                                "warning",
                                "rogue_hardcode",
                                &entry.path,
                                "Numeric hardcode appears inside a row that otherwise contains formulas.",
                            ),
                            ISSUE_CAP,
                        );
                    }
                }
                if state.formula_count >= 3 && entry.column > state.first_formula && entry.column < state.last_formula {
                    add_capped_office_issue(
                        &mut issues,
                        &mut omitted,
                        office_issue(
                            "warning",
                            "formula_inconsistency",
                            &entry.path,
                            "A hardcoded value interrupts a row containing three or more formulas.",
                        ),
                        ISSUE_CAP,
                    );
                }
            }
        }
        row_start += rows_per_block;
    }
    if omitted > 0 {
        issues.push(office_issue(
            "warning",
            "audit_issues_truncated",
            &format!("/sheet[{}]", string_of(&sheet.member("Name")?)),
            &format!("{omitted} additional financial-model audit issue(s) were omitted after the 500-issue response cap."),
        ));
    }
    let coverage = ordered(vec![
        ("sheet", Value::String(string_of(&sheet.member("Name")?))),
        ("range", Value::String(string_of(&relative_address(used)?))),
        ("rows", Value::Int(row_count)),
        ("columns", Value::Int(column_count)),
        ("totalCells", Value::Long(total_cells)),
        ("scannedCells", Value::Long(scanned_cells)),
        ("chunks", Value::Int(chunks)),
        ("complete", Value::Bool(scanned_cells == total_cells)),
    ]);
    Ok((issues, coverage))
}

/// The issues of the non-financial profile: a sample of the used range (500 cells, 100 columns wide) for clipped cells and
/// missing fonts, and the rows where a hardcode interrupts three formulas.
fn sample_range(sheet: &Com, used: &Com, fonts: &FontSet, issues: &mut Vec<Value>) -> Result<Value> {
    let columns = min_int(dimension_count(used, "Columns")?, SAMPLE_COLUMNS)?;
    let sample_rows = min_int(dimension_count(used, "Rows")?, blocks_fitting(SAMPLE_CELLS, columns)?)?;
    let sample = get_with(used, "Resize", &[Com::I4(sample_rows), Com::I4(columns)])?;
    let sample_values = sample.member("Value2")?;
    let sample_formulas = sample.member("FormulaR1C1")?;
    let mut visual_probes = 0;
    for r in 1..=sample_rows {
        for c in 1..=columns {
            let value = matrix_value(&sample_values, r, c);
            let formula = matrix_value(&sample_formulas, r, c);
            if (!is_ps_null(&value) || string_of(&formula).starts_with('=')) && visual_probes < VISUAL_PROBES {
                visual_probes += 1;
                let cell = get_with(&sample.member("Cells")?, "Item", &[Com::I4(r), Com::I4(c)])?;
                let path = format!("/sheet[{}]/cell[{}]", string_of(&sheet.member("Name")?), range_cell_address(used, r, c)?);
                if is_clipped(&string_of(&cell.member("Text")?)) {
                    issues.push(office_issue("warning", "cell_overflow", &path, "Displayed value is clipped because the column is too narrow."));
                }
                if let Some(font_issue) = missing_font_issue(fonts, &string_of(&cell.member("Font")?.member("Name")?), &path) {
                    issues.push(font_issue);
                }
            }
        }
    }
    let name = string_of(&sheet.member("Name")?);
    let range = string_of(&relative_address(used)?);
    let rows = dimension_count(used, "Rows")?;
    let used_columns = dimension_count(used, "Columns")?;
    let total_cells = i64::from(dimension_count(used, "Rows")?) * i64::from(dimension_count(used, "Columns")?);
    let scanned_cells = i64::from(sample_rows) * i64::from(columns);
    let complete = scanned_cells == i64::from(dimension_count(used, "Rows")?) * i64::from(dimension_count(used, "Columns")?);
    Ok(ordered(vec![
        ("sheet", Value::String(name)),
        ("range", Value::String(range)),
        ("rows", Value::Int(rows)),
        ("columns", Value::Int(used_columns)),
        ("totalCells", Value::Long(total_cells)),
        ("scannedCells", Value::Long(scanned_cells)),
        ("complete", Value::Bool(complete)),
    ]))
}

/// A hardcode that interrupts a row of three or more formulas, over the whole used range (at most 100 of them).
fn formula_inconsistencies(sheet: &Com, used: &Com, issues: &mut Vec<Value>) -> Result<()> {
    let Com::Array(matrix) = used.member("FormulaR1C1")? else { return Ok(()) };
    if matrix.rank() != 2 {
        return Ok(());
    }
    let row_lower = matrix.lower_bound(0).unwrap_or(0);
    let row_upper = matrix.upper_bound(0).unwrap_or(-1);
    let column_lower = matrix.lower_bound(1).unwrap_or(0);
    let column_upper = matrix.upper_bound(1).unwrap_or(-1);
    let text_at = |row: i32, column: i32| matrix.get(&[row, column]).map(string_of).unwrap_or_default();
    let mut inconsistencies = 0;
    let mut matrix_row = row_lower;
    while matrix_row <= row_upper && inconsistencies < INCONSISTENCY_CAP {
        let formula_columns: Vec<i32> = (column_lower..=column_upper).filter(|column| text_at(matrix_row, *column).starts_with('=')).collect();
        if formula_columns.len() >= 3 {
            let first_formula = formula_columns.iter().copied().min().unwrap_or(column_lower);
            let last_formula = formula_columns.iter().copied().max().unwrap_or(column_upper);
            let mut matrix_column = first_formula;
            while matrix_column <= last_formula && inconsistencies < INCONSISTENCY_CAP {
                let entry = text_at(matrix_row, matrix_column);
                if !entry.trim().is_empty() && !entry.starts_with('=') {
                    // `Measure-Object` answers the first formula column as a Double, so the column goes out as one.
                    let cells = used.member("Cells")?;
                    let cell = get_with(&cells, "Item", &[Com::I4(matrix_row - row_lower + 1), Com::R8(f64::from(matrix_column - column_lower + 1))])?;
                    issues.push(office_issue(
                        "warning",
                        "formula_inconsistency",
                        &format!("/sheet[{}]/cell[{}]", string_of(&sheet.member("Name")?), string_of(&relative_address(&cell)?)),
                        "A hardcoded value interrupts a row containing three or more formulas.",
                    ));
                    inconsistencies += 1;
                }
                matrix_column += 1;
            }
        }
        matrix_row += 1;
    }
    Ok(())
}

fn formula_errors(sheet: &Com, used: &Com, issues: &mut Vec<Value>) -> Result<()> {
    let error_cells = used.call_member("SpecialCells", &[Com::I4(-4123), Com::I4(16)])?;
    let error_count = int_of(&error_cells.member("Cells")?.member("Count")?)?;
    let limit = min_int(error_count, FORMULA_ERROR_CAP)?;
    for index in 1..=limit {
        let cell = get_with(&error_cells.member("Cells")?, "Item", &[Com::I4(index)])?;
        let shown = string_of(&cell.member("Text")?);
        let path = format!("/sheet[{}]/cell[{}]", string_of(&sheet.member("Name")?), string_of(&relative_address(&cell)?));
        issues.push(office_issue("error", "formula_error", &path, &format!("Cell contains formula error {shown}")));
    }
    if error_count > limit {
        issues.push(office_issue(
            "error",
            "formula_error_truncated",
            &format!("/sheet[{}]", string_of(&sheet.member("Name")?)),
            &format!("{} additional formula error(s) were omitted from the report.", error_count - limit),
        ));
    }
    Ok(())
}

fn chart_issues(sheet: &Com, issues: &mut Vec<Value>) -> Result<()> {
    let mut index = 1;
    while i64::from(index) <= count_of(&sheet.call_member("ChartObjects", &[])?)? {
        let inspected = attempt(|| -> Result<bool> {
            let chart = get_with(&sheet.call_member("ChartObjects", &[])?, "Item", &[Com::I4(index)])?.member("Chart")?;
            let count = chart.call_member("SeriesCollection", &[])?.member("Count")?;
            Ok(convert::equals(&ps_of(&count), &Value::Int(0)))
        });
        match inspected {
            Some(true) => issues.push(office_issue(
                "error",
                "empty_chart",
                &format!("/sheet[{}]/chart[{index}]", string_of(&sheet.member("Name")?)),
                "Chart has no data series.",
            )),
            Some(false) => {}
            None => issues.push(office_issue(
                "error",
                "broken_chart",
                &format!("/sheet[{}]/chart[{index}]", string_of(&sheet.member("Name")?)),
                "Chart data could not be inspected.",
            )),
        }
        index += 1;
    }
    Ok(())
}

/// A picture on a sheet is described as on a slide or a page: the portable audit asked it of a workbook and this one did
/// not, so the same unlabelled logo passed on Excel alone.
fn picture_issues(sheet: &Com, issues: &mut Vec<Value>) -> Result<()> {
    let mut picture_index = 0;
    for shape in items_of(&sheet.member("Shapes")?)? {
        let _ = attempt(|| -> Result<()> {
            if int_of(&shape.member("Type")?)? != 13 {
                return Ok(());
            }
            picture_index += 1;
            let alternative = string_of(&shape.member("AlternativeText")?);
            let description = alternative.trim();
            if description.is_empty()
                || text::is_match(description, r"^[\w ().\-]+\.(?:png|jpe?g|gif|bmp|tiff?|svg|webp|emf|wmf)$", false).unwrap_or(false)
            {
                issues.push(office_issue(
                    "warning",
                    "missing_alt_text",
                    &format!("/sheet[{}]/image[{picture_index}]", string_of(&sheet.member("Name")?)),
                    "Picture has no alternative text; add_image takes altText.",
                ));
            }
            Ok(())
        });
    }
    Ok(())
}

fn external_links(book: &Com, issues: &mut Vec<Value>) {
    let _ = attempt(|| -> Result<()> {
        let sources = book.call_member("LinkSources", &[Com::I4(1)])?;
        let links = match &sources {
            Com::Array(array) => array.data().to_vec(),
            other => vec![other.clone()],
        };
        for link in links {
            if convert::to_bool(&ps_of(&link)) {
                issues.push(office_issue("warning", "external_link", "/", &format!("Workbook links to external source: {}", string_of(&link))));
            }
        }
        Ok(())
    });
}

/// The cells of the range that carry a note, by address.
fn commented_addresses(used: &Com) -> HashSet<String> {
    let mut addresses = HashSet::new();
    let _ = attempt(|| -> Result<()> {
        let comment_cells = used.call_member("SpecialCells", &[Com::I4(-4144)])?;
        for cell in items_of(&comment_cells.member("Cells")?)? {
            addresses.insert(string_of(&relative_address(&cell)?).to_uppercase());
        }
        Ok(())
    });
    addresses
}

/// `Issues-Excel`: `{ issues, auditCoverage }`.
pub(super) fn issues_excel(env: &Env<'_>, book: &Obj, payload: &Value) -> Result<Value> {
    let book = Com::Dispatch(book.clone());
    let mut issues: Vec<Value> = Vec::new();
    let mut coverage: Vec<Value> = Vec::new();
    let fonts = env.platform.installed_office_fonts();
    let financial_audit = convert::equals(&payload::property(payload, "auditProfile"), &Value::string("financial-model"));
    if financial_audit {
        let mut has_checks = false;
        for candidate in items_of(&book.member("Worksheets")?)? {
            if is_checks_sheet_name(&candidate.member("Name")?) {
                has_checks = true;
                break;
            }
        }
        if !has_checks {
            issues.push(office_issue(
                "warning",
                "missing_checks_sheet",
                "/",
                "Financial-model audit expects a Checks sheet with explicit tie-out formulas.",
            ));
        }
    }
    for sheet in items_of(&book.member("Worksheets")?)? {
        if payload_flag(payload, "sheet") && !payload::names_equal(&payload_text(payload, "sheet"), &string_of(&sheet.member("Name")?)) {
            continue;
        }
        picture_issues(&sheet, &mut issues)?;
        let mut used = sheet.member("UsedRange")?;
        if payload_flag(payload, "range") {
            used = get_with(&sheet, "Range", &[Com::Str(payload_text(payload, "range"))])?;
        }
        if financial_audit {
            let comment_addresses = commented_addresses(&used);
            let (found, entry) = inspect_financial_range(&sheet, &used, &fonts, &comment_addresses)?;
            issues.extend(found);
            coverage.push(entry);
        } else {
            let entry = sample_range(&sheet, &used, &fonts, &mut issues)?;
            coverage.push(entry);
            let _ = attempt(|| formula_inconsistencies(&sheet, &used, &mut issues));
        }
        let _ = attempt(|| formula_errors(&sheet, &used, &mut issues));
        chart_issues(&sheet, &mut issues)?;
    }
    external_links(&book, &mut issues);
    let mut total_cells: i64 = 0;
    let mut scanned_cells: i64 = 0;
    for entry in &coverage {
        total_cells += convert::to_int64(&payload::property(entry, "totalCells")).map_err(Error::host)?;
        scanned_cells += convert::to_int64(&payload::property(entry, "scannedCells")).map_err(Error::host)?;
    }
    let incomplete = coverage.iter().filter(|entry| !convert::to_bool(&payload::property(entry, "complete"))).count();
    let audit_coverage = ordered(vec![
        ("mode", Value::string(if financial_audit { "full" } else { "sampled" })),
        ("complete", Value::Bool(incomplete == 0)),
        ("totalCells", Value::Long(total_cells)),
        ("scannedCells", Value::Long(scanned_cells)),
        ("sheets", Value::Array(coverage)),
    ]);
    Ok(ordered(vec![("issues", Value::Array(issues)), ("auditCoverage", audit_coverage)]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checks_sheet_is_named_in_english_or_korean() {
        for name in ["Checks", " check ", "CHECKS", "\u{AC80}\u{C99D}", "\u{C810}\u{AC80}"] {
            assert!(is_checks_sheet_name(&Com::Str(name.to_owned())), "{name}");
        }
        assert!(!is_checks_sheet_name(&Com::Str("Checks2".to_owned())));
        assert!(!is_checks_sheet_name(&Com::Empty));
    }

    #[test]
    fn a_hardcode_is_a_number_that_is_not_a_boolean() {
        assert!(is_numeric(&Com::R8(1.0)) && is_numeric(&Com::Error(-2_146_826_246)) && is_numeric(&Com::Date(45000.0)));
        assert!(!is_numeric(&Com::Bool(true)) && !is_numeric(&Com::Str("1".to_owned())) && !is_numeric(&Com::Null));
    }

    #[test]
    fn hashes_are_a_clipped_cell_and_two_are_not() {
        assert!(is_clipped("###") && is_clipped("########"));
        assert!(!is_clipped("##") && !is_clipped("#N/A") && !is_clipped(""));
    }
}
